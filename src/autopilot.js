// The autopilot: flies a whole trip to a target planet in one of several
// transfer modes. Shared by the live game (main.js) and the headless dry runs
// that measure each mode's fuel (planner-worker.js), so estimates and flights
// run exactly the same code.
//
// Fuel is the total thrust delivered (the integral of |acceleration| dt, i.e.
// delta-v), scaled by FUEL_SCALE and shown as a plain number.

import { PLANETS, THRUST, GM_SUN, PERI_MIN_K, planetState, bodyState } from './system.js';
import { Sim, gravity, sunAccel, setSunLift } from './nbody.js';
import { elements } from './physics.js';
import { Planner, pickFlyby, arrivalRadius } from './planner.js';
import { predict } from './predict.js';

// Every transfer type the code knows how to fly...
export const ALL_MODES = ['hohmann', 'gonow', 'bielliptic', 'assist', 'brachistochrone'];
export const MODE_NAMES = { hohmann: 'Hohmann', gonow: 'Go now', bielliptic: 'Bi-elliptic', assist: 'Slingshot', brachistochrone: 'Brachistochrone' };
// ...and the ones currently ENABLED: only these get buttons and fuel
// estimates. Go now, Bi-elliptic and Slingshot are disabled until their
// flight problems are sorted out; add them back here to re-enable.
export const ENABLED_MODES = new Set(['hohmann', 'brachistochrone']);
export const MODES = ALL_MODES.filter((m) => ENABLED_MODES.has(m));
export const FUEL_SCALE = 100;

const ps = new Float64Array(4);
const G = new Float64Array(4);
const BURN_SLICE = 1 / 60;   // heading is re-aimed at least this often during a burn (game s)
const TAU = 2 * Math.PI;
/** Unsigned angle between two headings. */
function angleTo(from, to) { return Math.abs(((to - from) % TAU + 3 * Math.PI) % TAU - Math.PI); }
// Brachistochrone ("torch") engine: one rule for every planet, strong enough
// to beat even Mercury's pull at the parking orbit (2.8) by a wide margin
export const BRACH_THRUST = 5;
const BRACH_PLAN = 0.85;     // the plan uses this fraction of it (margin for the gravity it ignores)
const BRAKE_END = 0.15;      // the braking burn must have reached orbit by this time to go (game s)
const AIM = new Float64Array(4), BA = new Float64Array(2), PP = new Float64Array(4);
const GUIDE_DT = 0.1;        // re-solve interval (game s)
const FLIP_RATE = 2.4;       // turn rate (rad per game s): the flip takes about 1.3 game s
const ALIGN = 0.2;           // the engine lights only within this angle (rad) of the wanted heading
const FLIP_LOCK = 1.5;        // plan frozen this long (game s) before the flip
const STEER_ON = 0.8;        // braking burn: the engine stays lit while turning less than this (rad)

/** Heading offset from (frame-relative) prograde for a plan's burn direction. */
export function dirOffset(pl) { return pl.dir === 'retro' ? Math.PI : pl.dir === 'plan' ? pl.angle : 0; }

export class Autopilot {
  constructor(sim, worker = null) {
    this.sim = sim;
    this.planner = new Planner(worker);
    this.trip = null;
    this.burn = null;     // { plan, elapsed } while a planned burn fires
    this.fuel = 0;        // delta-v spent on this trip (unscaled)
    this.done = false;
  }

  get target() { return this.trip ? this.trip.target : null; }

  setTarget(target, mode = 'hohmann', flyby = null) {
    const sim = this.sim;
    this.burn = null; this.fuel = 0; this.done = false;
    if (target == null) { this.trip = null; this.planner.setTarget(null); return; }
    this.trip = {
      target, mode, origin: sim.body,
      stage: mode === 'brachistochrone' ? 'brach' : 'depart',
      flyby: mode === 'assist' ? (flyby ?? pickFlyby(sim.body, target)) : null,
      flybyDone: false, inFlyby: false, brach: null,
    };
    this.planner.setTarget(target, this.trip);
  }

  /** The plan that can be flown from where we are now, if any. */
  get plan() {
    const p = this.planner.ready;
    if (!p) return null;
    if (p.kind === 'depart' && this.sim.body !== p.from) return null;
    return p;
  }

  /** Seconds (game) until the next planned ignition, or Infinity. */
  get timeToBurn() {
    const p = this.plan;
    return p ? p.tMid - p.dur / 2 - this.sim.t : Infinity;
  }

  /**
   * After physics and prediction: update "captured", flyby bookkeeping and
   * planning. Returns 'captured' / 'arrived' events for the UI.
   */
  think(pred, budgetMs, lead, engineOn) {
    const sim = this.sim, ev = [];
    const f = pred && pred.fate;
    const was = sim.captured;
    sim.captured = !!(sim.alive && f && (f.kind === 'holds' || (was && f.laps >= 0.97 && !engineOn) || (was && engineOn)));
    if (sim.captured && !was && !engineOn) ev.push({ type: 'captured', body: sim.body });
    const trip = this.trip;
    if (trip) {
      if (trip.flyby != null && sim.body === trip.flyby) trip.inFlyby = true;
      if (trip.inFlyby && sim.body !== trip.flyby) { trip.inFlyby = false; trip.flybyDone = true; }
      // plan only from full-length predictions (the quick one used while
      // thrusting does not look far enough ahead to see distant arrivals)
      if (!pred.quick) this.planner.update(sim, engineOn || !!this.burn || trip.stage === 'brach', budgetMs, pred, lead);
      if (this.planner.status === 'captured' && !this.done) { this.done = true; ev.push({ type: 'arrived', body: trip.target }); }
    }
    return ev;
  }

  /** Advance the simulation by simDt game seconds, flying any due burn. */
  advance(simDt) {
    const sim = this.sim, events = [];
    let engineOn = false, accel = 0;
    const trip = this.trip;
    let left = simDt;
    if (trip && trip.stage === 'brach' && sim.alive) {
      const r = this.brachStep(left, events);
      return { events, engineOn: r.engineOn, accel: r.accel };
    }
    while (left > 1e-12 && sim.alive) {
      if (this.burn) {
        const pl = this.burn.plan;
        const h = Math.min(left, BURN_SLICE, pl.dur - this.burn.elapsed);
        bodyState(pl.frame, sim.t, ps);
        sim.heading = Math.atan2(sim.vy - ps[3], sim.vx - ps[2]) + dirOffset(pl);
        const acc = pl.thrust || THRUST;
        events.push(...sim.step(h, acc));
        this.fuel += acc * h;
        this.burn.elapsed += h; left -= h;
        engineOn = true; accel = acc;
        if (this.burn.elapsed >= pl.dur - 1e-9) {
          events.push({ type: 'cut', plan: pl });
          this.burn = null;
          this.planner.burnDone(pl);
        }
        continue;
      }
      const p = this.plan;
      if (p && trip) {
        const tS = p.tMid - p.dur / 2 - sim.t;
        if (tS <= left && tS > -p.dur) {
          // ignite exactly on the mark (or now, if the plan arrived late)
          if (tS > 0) { events.push(...sim.step(tS, 0)); left -= tS; }
          this.burn = { plan: p, elapsed: 0 };
          events.push({ type: 'ignition', plan: p });
          continue;
        }
      }
      events.push(...sim.step(left, 0));
      left = 0;
    }
    return { events, engineOn, accel };
  }

  // ------------------------------------------------------- brachistochrone
  //
  // The torch-ship transfer: full constant thrust the whole way, accelerating
  // toward the target, a FLIP partway, then braking so the ship arrives
  // matched to the planet. Two burn directions, u1 for t1 seconds then u2 for
  // the rest, satisfy the four arrival conditions (position and velocity) with
  // four unknowns (two directions, flip time, arrival time). It is solved
  // again every GUIDE_DT from the actual state, so gravity the model ignores
  // (the planets, the Sun's pull changing along the way) is corrected as it
  // happens. When the straight line crosses the Sun, the ship is assumed to
  // arc over the top of it (see setSunLift in nbody.js).
  //
  // Stages: 'wait' (coast in the parking orbit until its prograde lines up
  // with the first burn direction) → 'burn' → flip → 'final' (spiral into a
  // low orbit around the target) → the normal capture logic ('cruise').

  /** Arrival point at absolute time t: the final low orbit itself (the
   * capture radius), on the side the ship comes from, moving with the planet
   * plus the circular orbital velocity there, so the braking burn ends in orbit. */
  brachAim(t, out) {
    const tr = this.trip, T = PLANETS[tr.target], b = tr.brach;
    planetState(tr.target, t, ps);
    // the arrival side is fixed relative to the planet's own direction from the Sun
    const th = Math.atan2(ps[1], ps[0]) + b.side;
    const rA = arrivalRadius(T), vc = Math.sqrt(T.mu / rA);
    const c = Math.cos(th), s = Math.sin(th);
    out[0] = ps[0] + rA * c; out[1] = ps[1] + rA * s;
    out[2] = ps[2] - vc * s; out[3] = ps[3] + vc * c; // counter-clockwise around the planet
    return out;
  }

  /**
   * Solve the two-burn problem from the ship's current state (see above).
   * Engine-off coasts while the ship turns are part of the plan: `pre` seconds
   * before the first burn (still turning onto it) and `cf` for the flip.
   * Burn 1 delivers A = a u1 t1, burn 2 B = a u2 t2, with T = t1 + cf + t2:
   *   A + B = dv,   A (T + cf) / 2 = dr - dv t2 / 2   (dr, dv: what is missing
   * at arrival if the engine stayed off, under a constant Sun pull g)
   * so A is linear in t1, and the burns must satisfy |A| = a t1, |B| = a t2.
   */
  brachSolve(preferLate = false, tGuess = 0, pre = 0, cf = 0) {
    const sim = this.sim;
    const a = BRACH_PLAN * BRACH_THRUST;
    sunAccel(sim.x, sim.y, G);
    // coast through the turn first (local pull)
    const x0 = sim.x + sim.vx * pre + 0.5 * G[0] * pre * pre, y0 = sim.y + sim.vy * pre + 0.5 * G[1] * pre * pre;
    const vx0 = sim.vx + G[0] * pre, vy0 = sim.vy + G[1] * pre, t0 = sim.t + pre;
    // the Sun's pull: averaged along the last planned path when there is one
    // (it changes a lot when the run passes near the Sun), else the local pull
    const ge = this.trip.brach.geff;
    const gvx = ge ? ge[0] : G[0], gvy = ge ? ge[1] : G[1], grx = ge ? ge[2] : G[0], gry = ge ? ge[3] : G[1];
    const aim = new Float64Array(4);
    const at = (T) => {
      if (T <= cf) return null;
      this.brachAim(t0 + T, aim);
      const drx = aim[0] - x0 - vx0 * T - 0.5 * grx * T * T, dry = aim[1] - y0 - vy0 * T - 0.5 * gry * T * T;
      const dvx = aim[2] - vx0 - gvx * T, dvy = aim[3] - vy0 - gvy * T;
      // A(t1) = k0 + k1 t1 (from the second equation with t2 = T - cf - t1)
      const Tc = T + cf, Tb = T - cf;
      const c0x = (2 * drx - dvx * Tb) / Tc, c0y = (2 * dry - dvy * Tb) / Tc, c1x = dvx / Tc, c1y = dvy / Tc;
      const f = (t1) => Math.hypot(c0x + c1x * t1, c0y + c1y * t1) - a * t1;
      const bisect = (lo, hi) => {
        const sLo = f(lo) >= 0;
        for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if ((f(m) >= 0) === sLo) lo = m; else hi = m; }
        return (lo + hi) / 2;
      };
      let t1;
      if (f(Tb) < 0) t1 = bisect(0, Tb);
      else {
        // f is convex: find its minimum; no root means T is too short
        let lo = 0, hi = Tb;
        for (let i = 0; i < 40; i++) {
          const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
          if (f(m1) < f(m2)) hi = m2; else lo = m1;
        }
        const tm = (lo + hi) / 2;
        if (f(tm) > 0) return null;
        t1 = preferLate ? bisect(tm, Tb) : bisect(0, tm);
      }
      const Ax = c0x + c1x * t1, Ay = c0y + c1y * t1;
      const Bx = dvx - Ax, By = dvy - Ay;
      return { T: T + pre, t1: t1 + pre, pre, cf, h: Math.hypot(Bx, By) - a * (Tb - t1), A: [Ax, Ay], B: [Bx, By] };
    };
    // after the flip, the braking burn must be the long one: a plan with a
    // leftover sliver of the first burn would swing the ship back and forth
    const ok = (r) => r && r.h <= 0 && (!preferLate || r.t1 - pre >= 0.5 * (r.T - pre - cf));
    // bracket the shortest feasible arrival time, starting near the last answer
    let lo = cf + 0.05, hi = Math.max(cf + 0.3, tGuess - pre || 2);
    let r = at(hi);
    if (ok(r)) {
      for (let i = 0; i < 60; i++) {
        const t = hi * 0.85;
        if (t < cf + 0.05) break;
        const q = at(t);
        if (!ok(q)) { lo = t; break; }
        hi = t; r = q;
      }
    } else {
      for (let i = 0; i < 120 && !ok(r); i++) { lo = hi; hi *= 1.12; if (hi > 6000) return null; r = at(hi); }
      if (!ok(r)) return null;
    }
    for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; const q = at(m); if (ok(q)) { hi = m; r = q; } else lo = m; }
    return r;
  }

  brachInit() {
    const sim = this.sim, tr = this.trip;
    // arrive on the side of the target facing the ship's start, measured from
    // the target's Sun line so it stays put relative to the planet
    planetState(tr.target, sim.t, ps);
    const side = Math.atan2(sim.y - ps[1], sim.x - ps[0]) - Math.atan2(ps[1], ps[0]);
    tr.brach = { stage: 'wait', side, sol: null, tSolve: -Infinity, flipped: false, flipAt: 0, tArrive: 0, ignite: Infinity, dir: sim.heading };
    this.brachUpdate(true);
  }

  /** Re-solve (at most every GUIDE_DT) and refresh the plan's timing. */
  brachUpdate(force = false) {
    const sim = this.sim, b = this.trip.brach;
    if (!force && sim.t - b.tSolve < GUIDE_DT) return;
    // arrive on the side the ship is coming from (so the path never crosses
    // the planet), measured from the planet's Sun line so it moves with it
    this.brachSide();
    const prevT = b.sol ? b.sol.T - (sim.t - b.tSolve) : 0;
    // turning time still needed onto the current burn direction, and for the
    // flip (from the last solution's angle between the two burns; 180° at first)
    const pre = b.stage === 'wait' ? 0 : angleTo(sim.heading, b.dir) / FLIP_RATE;
    let cf = 0;
    if (!b.flipped) {
      const s0 = b.sol;
      const ang = s0 ? Math.acos(Math.max(-1, Math.min(1, (s0.A[0] * s0.B[0] + s0.A[1] * s0.B[1]) / ((Math.hypot(...s0.A) * Math.hypot(...s0.B)) || 1)))) : Math.PI;
      cf = ang / FLIP_RATE;
    }
    const sol = this.brachSolve(b.flipped, prevT, pre, cf);
    b.tSolve = sim.t;
    if (!sol) return; // keep the last answer
    b.sol = sol;
    b.flipAt = sim.t + sol.t1;
    b.tArrive = sim.t + sol.T;
    b.geff = this.brachFly(sol, 200).geff;
    const u = sol.t1 > 1e-6 ? sol.A : sol.B;
    b.dir = Math.atan2(u[1], u[0]);
  }

  /** Where on the final orbit to arrive: a quarter turn round from the side
   * the ship comes from, so the path runs PAST the planet at orbit height and
   * the ship arrives moving along the (counter-clockwise) orbit, not falling
   * straight at the planet. Measured from the planet's Sun line so it moves
   * with the planet; frozen once close, where the ship is lined up on it. */
  brachSide() {
    const sim = this.sim, b = this.trip.brach, T = PLANETS[this.trip.target];
    planetState(this.trip.target, sim.t, ps);
    const d = Math.hypot(sim.x - ps[0], sim.y - ps[1]);
    if (b.side != null && d < 4 * arrivalRadius(T)) return;
    b.side = Math.atan2(sim.y - ps[1], sim.x - ps[0]) + Math.PI / 2 - Math.atan2(ps[1], ps[0]);
  }

  /**
   * The braking burn's steering (after the flip): the "zero-effort miss /
   * velocity" law, a = 6 ZEM / tgo^2 - 2 ZEV / tgo, aimed at the final orbit.
   * On the planned path it is exactly constant braking, so it looks like one
   * steady burn; off it, it bends the burn smoothly back on course instead of
   * flipping again. The pull modelled here is the (lifted) Sun's plus the
   * target planet's, both taken at the ship.
   */
  brakeAccel(x, y, vx, vy, t, tgo, out) {
    const tr = this.trip, T = PLANETS[tr.target];
    const aim = this.brachAim(t + tgo, AIM);
    this.pullAt(x, y, t, G);
    const gx = G[0], gy = G[1];
    const zx = aim[0] - (x + vx * tgo + 0.5 * gx * tgo * tgo), zy = aim[1] - (y + vy * tgo + 0.5 * gy * tgo * tgo);
    const wx = aim[2] - (vx + gx * tgo), wy = aim[3] - (vy + gy * tgo);
    out[0] = (6 * zx) / (tgo * tgo) - (2 * wx) / tgo;
    out[1] = (6 * zy) / (tgo * tgo) - (2 * wy) / tgo;
    return out;
  }

  /** Time to go for the braking law: stretched (a little at a time) when the
   * law asks for more than the engine has; never without limit. Close to a
   * strong planet no stretch helps, and the engine just runs flat out. */
  brakeTgo(x, y, vx, vy, t, tgo) {
    const t0 = tgo;
    for (let i = 0; i < 10; i++) {
      this.brakeAccel(x, y, vx, vy, t, tgo, BA);
      if (Math.hypot(BA[0], BA[1]) <= BRACH_THRUST) return tgo;
      tgo *= 1.04;
    }
    return t0;
  }

  /** Pull on the ship from the (lifted) Sun and the target planet. out = [ax, ay]. */
  pullAt(x, y, t, out) {
    const T = PLANETS[this.trip.target];
    sunAccel(x, y, out);
    planetState(this.trip.target, t, PP);
    const dx = x - PP[0], dy = y - PP[1];
    // softened inside the final orbit so a planned path that grazes the planet stays finite
    const d = Math.max(Math.hypot(dx, dy), 0.8 * arrivalRadius(T));
    out[0] -= (T.mu * dx) / d ** 3; out[1] -= (T.mu * dy) / d ** 3;
    return out;
  }

  /** Turn toward `want` at the flip rate for h game seconds; returns the angle still to go. */
  turnToward(want, h) {
    const sim = this.sim;
    const d = ((want - sim.heading) % TAU + 3 * Math.PI) % TAU - Math.PI;
    const step = FLIP_RATE * h;
    sim.heading = Math.abs(d) <= step ? want : sim.heading + Math.sign(d) * step;
    return Math.max(0, Math.abs(d) - step);
  }

  brachStep(simDt, events) {
    const sim = this.sim, tr = this.trip;
    if (!tr.brach) this.brachInit();
    const b = tr.brach, T = PLANETS[tr.target];
    let left = simDt, engineOn = false, accel = 0;
    while (left > 1e-12 && sim.alive) {
      if (b.stage === 'wait') {
        // coast in the parking orbit until its prograde lines up with the first burn
        this.brachUpdate();
        bodyState(tr.origin, sim.t, ps);
        const rx = sim.x - ps[0], ry = sim.y - ps[1], vx = sim.vx - ps[2], vy = sim.vy - ps[3];
        const w = (rx * vy - ry * vx) / (rx * rx + ry * ry); // angular rate (signed)
        let d = Math.sign(w) * (b.dir - Math.atan2(vy, vx));
        d = ((d % TAU) + TAU) % TAU; // angle the velocity still has to turn
        if (d > TAU - ALIGN) d = 0; // just past: go now
        const wait = d / Math.abs(w);
        b.ignite = sim.t + wait;
        if (wait <= 0.02 || sim.body !== tr.origin) {
          b.stage = 'burn';
          this.brachUpdate(true);
          events.push({ type: 'ignition', plan: { kind: 'brach', dur: b.sol ? b.sol.T : 0 } });
          continue;
        }
        const h = Math.min(left, Math.max(0.02, wait * 0.5), 0.5);
        if (wait < 3) this.turnToward(b.dir, h); // turn ahead so the engine lights on the mark
        events.push(...sim.step(h, 0));
        left -= h;
        continue;
      }
      planetState(tr.target, sim.t, ps);
      const dist = Math.hypot(sim.x - ps[0], sim.y - ps[1]);
      if (b.stage === 'burn') {
        // the flip: swing round onto the second burn. The plan already budgets
        // the turn as an engine-off coast, so it is kept (not re-solved) until
        // the ship points the new way.
        if (!b.flipped && b.flipAt - sim.t < GUIDE_DT && b.sol) {
          b.flipped = true; b.turning = true;
          b.dir = Math.atan2(b.sol.B[1], b.sol.B[0]);
          events.push({ type: 'flip' });
        }
        if (b.turning && angleTo(sim.heading, b.dir) < ALIGN) {
          // pointing the new way: the braking burn takes over from the plan
          b.turning = false; b.braking = true;
          b.tArrive = sim.t + this.brakeTgo(sim.x, sim.y, sim.vx, sim.vy, sim.t, Math.max(0.5, b.tArrive - sim.t));
        }
        if (b.braking) {
          this.brachSide();
          let tgo = b.tArrive - sim.t;
          // in orbit already? cut the engine: the capture is done
          if (sim.body === tr.target) {
            bodyState(tr.target, sim.t, ps);
            const el = elements(sim.x - ps[0], sim.y - ps[1], sim.vx - ps[2], sim.vy - ps[3], T.mu);
            const good = el.bound && el.rp >= PERI_MIN_K * T.radius && el.ra <= 0.45 * T.hill;
            if (good && (el.e < 0.04 || tgo < BRAKE_END)) {
              tr.stage = 'cruise'; // the normal logic confirms the capture
              events.push({ type: 'cut', plan: { kind: 'brach' } });
              if (left > 1e-9) events.push(...sim.step(left, 0));
              break;
            }
          }
          if (tgo < BRAKE_END) { b.stage = 'final'; this.finalUsed = true; continue; } // safety net
          // At orbit height the ship skims round the planet for the last
          // moments of braking: there it brakes against the circular orbit
          // speed directly (same direction, no turn) until the orbit is round.
          if (dist < 1.3 * arrivalRadius(T)) { b.stage = 'final'; continue; }
          tgo = this.brakeTgo(sim.x, sim.y, sim.vx, sim.vy, sim.t, tgo);
          b.tArrive = sim.t + tgo;
          this.brakeAccel(sim.x, sim.y, sim.vx, sim.vy, sim.t, tgo, BA);
          const want = Math.hypot(BA[0], BA[1]);
          b.dir = Math.atan2(BA[1], BA[0]);
          const h = Math.min(left, tgo < 3 ? 0.01 : 0.03);
          const togo = this.turnToward(b.dir, h);
          // small steering changes are flown with the engine lit (only big
          // turns, like the flip, coast)
          const a = togo < STEER_ON ? Math.min(BRACH_THRUST, want) * Math.cos(togo) : 0;
          setSunLift(true, tr.target);
          try { events.push(...sim.step(h, a)); } finally { setSunLift(false); }
          this.fuel += a * h;
          left -= h;
          engineOn = a > 1e-6; accel = a;
          continue;
        }
        // the last moments before the flip fly the plan as it stands: re-solving
        // this close to the flip can hop between answers and twitch the ship
        if (!b.turning && b.flipAt - sim.t > FLIP_LOCK) this.brachUpdate();
        const tgo = b.tArrive - sim.t;
        if (tgo < 0.4) { b.stage = 'final'; this.finalUsed = true; continue; }
        const h = Math.min(left, GUIDE_DT / 2);
        const togo = this.turnToward(b.dir, h);
        // the engine waits while the ship swings round (the flip); small
        // steering changes are flown with it lit
        const a = b.turning ? (togo < ALIGN ? BRACH_PLAN * BRACH_THRUST : 0) : togo < STEER_ON ? BRACH_PLAN * BRACH_THRUST * Math.cos(togo) : 0;
        setSunLift(true, tr.target);
        try { events.push(...sim.step(h, a)); } finally { setSunLift(false); }
        this.fuel += a * h;
        left -= h;
        engineOn = a > 0; accel = a;
        continue;
      }
      // The end of the braking burn, at orbit height: brake toward the circular
      // orbit speed (and height). Also the safety net if braking ran out of time.
      const rx = sim.x - ps[0], ry = sim.y - ps[1], vx = sim.vx - ps[2], vy = sim.vy - ps[3];
      const r = Math.hypot(rx, ry), rA = arrivalRadius(T);
      const nx = rx / r, ny = ry / r;
      const sgn = rx * vy - ry * vx >= 0 ? 1 : -1;
      const tx = -ny * sgn, ty = nx * sgn;
      const vc = Math.sqrt(T.mu / r);
      const dr = r - rA;
      // descend no faster than the engine can still brake from
      const vr = dr > 0 ? -Math.min(dr / 4, Math.sqrt(2 * 0.25 * BRACH_THRUST * dr)) : Math.min(-dr / 4, 1);
      const dvx = vr * nx + vc * tx - vx, dvy = vr * ny + vc * ty - vy;
      if (Math.abs(dr) < 0.12 * rA && Math.hypot(dvx, dvy) < 0.04 * vc) {
        tr.stage = 'cruise'; // in orbit: the normal logic confirms the capture
        events.push({ type: 'cut', plan: { kind: 'brach' } });
        if (left > 1e-9) events.push(...sim.step(left, 0));
        break;
      }
      const h = Math.min(left, 0.02);
      const want = Math.min(BRACH_THRUST, Math.hypot(dvx, dvy) / 0.3);
      const togo = this.turnToward(Math.atan2(dvy, dvx), h);
      const a = togo < STEER_ON ? want * Math.cos(togo) : 0;
      events.push(...sim.step(h, a));
      this.fuel += a * h;
      left -= h;
      engineOn = a > 1e-6; accel = a;
    }
    return { engineOn, accel };
  }

  /** Brachistochrone timing for the HUD and the time director (game s from now). */
  get brach() {
    const b = this.trip && this.trip.stage === 'brach' && this.trip.brach;
    if (!b) return null;
    const t = this.sim.t;
    return {
      stage: b.stage, flipped: b.flipped,
      ignite: Math.max(0, b.ignite - t), flip: Math.max(0, b.flipAt - t), arrive: Math.max(0, b.tArrive - t),
    };
  }

  /**
   * Fly a solution forward (engine as planned, the lifted Sun's real pull)
   * from the state it was solved at. Returns the points, the index where the
   * flip starts, and the Sun's pull averaged the way the solver uses it
   * (for velocity: mean pull; for position: time-weighted so that a constant
   * pull g gives back g).
   */
  brachFly(sol, n) {
    const sim = this.sim, a = BRACH_PLAN * BRACH_THRUST;
    const l1 = Math.hypot(sol.A[0], sol.A[1]) || 1, l2 = Math.hypot(sol.B[0], sol.B[1]) || 1;
    const tA = sol.pre, tB = sol.t1, tC = sol.t1 + sol.cf; // burn 1 from tA to tB, coast to tC, then burn 2
    let x = sim.x, y = sim.y, vx = sim.vx, vy = sim.vy, t = 0;
    const T = sol.T, h = T / n, pts = [x, y];
    let flipIdx = -1, ivx = 0, ivy = 0, irx = 0, iry = 0;
    for (let i = 0; i < n; i++) {
      const tm = t + h / 2;
      let ux = 0, uy = 0;
      if (tm >= tA && tm < tB) { ux = sol.A[0] / l1; uy = sol.A[1] / l1; }
      else if (tm >= tC) { ux = sol.B[0] / l2; uy = sol.B[1] / l2; }
      if (tm >= tB && flipIdx < 0) flipIdx = i;
      // midpoint step (the target planet's pull included: near a strong
      // planet the infall at the end changes when to flip)
      this.pullAt(x, y, sim.t + t, G);
      const mx = x + vx * h / 2, my = y + vy * h / 2;
      const mvx = vx + (G[0] + a * ux) * h / 2, mvy = vy + (G[1] + a * uy) * h / 2;
      this.pullAt(mx, my, sim.t + tm, G);
      if (tm >= tA) { // the solver models the pull after the turn-in coast
        const w = T - tm;
        ivx += G[0] * h; ivy += G[1] * h; irx += G[0] * h * w; iry += G[1] * h * w;
      }
      vx += (G[0] + a * ux) * h; vy += (G[1] + a * uy) * h;
      x += mvx * h; y += mvy * h; t += h;
      pts.push(x, y);
    }
    const Tm = T - tA;
    const geff = Tm > 1e-6 ? [ivx / Tm, ivy / Tm, (2 * irx) / (Tm * Tm), (2 * iry) / (Tm * Tm)] : null;
    return { pts, flipIdx, geff };
  }

  /** The braking burn ahead, flown forward with its own steering law (for drawing). */
  brakeFly(n) {
    const sim = this.sim, b = this.trip.brach, T = PLANETS[this.trip.target];
    let x = sim.x, y = sim.y, vx = sim.vx, vy = sim.vy, t = sim.t;
    const tEnd = b.tArrive, pts = [x, y];
    const h = Math.max(1e-3, (tEnd - t) / n);
    for (let i = 0; i < n && tEnd - t > BRAKE_END; i++) {
      this.brakeAccel(x, y, vx, vy, t, tEnd - t, BA);
      const k = Math.min(1, BRACH_THRUST / (Math.hypot(BA[0], BA[1]) || 1));
      this.pullAt(x, y, t, G);
      vx += (BA[0] * k + G[0]) * h; vy += (BA[1] * k + G[1]) * h;
      x += vx * h; y += vy * h; t += h;
      pts.push(x, y);
    }
    return pts;
  }

  /** The planned path from the ship's current state: world points and the flip's index. */
  brachPath(n = 160) {
    const b = this.trip && this.trip.stage === 'brach' && this.trip.brach;
    if (!b || !b.sol || b.stage === 'final' || b.tArrive <= this.sim.t) return null;
    if (b.braking) return { pts: this.brakeFly(n), flipIdx: -1 };
    // the plan was solved at b.tSolve (at most GUIDE_DT ago): close enough to draw from the ship
    const { pts, flipIdx } = this.brachFly(b.sol, n);
    return { pts, flipIdx: b.flipped ? -1 : flipIdx };
  }
}

/**
 * Fly a whole trip headlessly and report its fuel. `node` is the ship's state
 * (t, x, y, vx, vy) in the parking orbit around `body`.
 */
export function dryRun(node, body, target, mode, { simT = node.t, maxGameT = 250000, maxWallMs = 45000, flyby = null, log = null } = {}) {
  const wall0 = Date.now();
  const sim = new Sim();
  sim.t = node.t; sim.x = node.x; sim.y = node.y; sim.vx = node.vx; sim.vy = node.vy;
  sim.body = body; sim.captured = true; sim.restart();
  if (simT > sim.t) sim.step(simT - sim.t, 0);
  const ap = new Autopilot(sim, null);
  ap.setTarget(target, mode, flyby);
  const t0 = sim.t;
  let pred = predict(sim);
  ap.think(pred, 1e9, 30, false);
  let burns = 0;
  while (!ap.done && sim.alive && sim.t - t0 < maxGameT && Date.now() - wall0 < maxWallMs) {
    let h;
    if (ap.trip.stage === 'brach') h = 2;
    else if (ap.burn) h = 0.5;
    else {
      const tS = ap.timeToBurn;
      h = Number.isFinite(tS) ? Math.min(Math.max(tS + 0.05, 0.05), 200) : 60;
    }
    const r = ap.advance(h);
    for (const e of r.events) {
      if (e.type === 'ignition') burns++;
      if (log && ['ignition', 'cut', 'enter', 'escape', 'crash'].includes(e.type)) log(`t=${sim.t.toFixed(1)} ${e.type} ${e.plan ? e.plan.kind + ' dur=' + (e.plan.dur ?? 0).toFixed(2) : 'body=' + e.body} stage=${ap.trip.stage}`);
    }
    pred = predict(sim, r.engineOn);
    ap.think(pred, 1e9, 30, r.engineOn);
  }
  return {
    ok: ap.done && sim.alive,
    fuel: Math.round(ap.fuel * FUEL_SCALE),
    time: sim.t - t0,
    burns,
    flyby: ap.trip.flyby,
    flybyDone: ap.trip.flybyDone,
    reason: ap.done ? 'arrived' : !sim.alive ? 'crashed' : Date.now() - wall0 >= maxWallMs ? 'too slow to plan' : 'no capture',
  };
}
