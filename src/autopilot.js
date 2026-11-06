// The autopilot: flies a whole trip to a target planet in one of several
// transfer modes. Shared by the live game (main.js) and the headless dry runs
// that measure each mode's fuel (planner-worker.js), so estimates and flights
// run exactly the same code.
//
// Fuel is the total thrust delivered (the integral of |acceleration| dt, i.e.
// delta-v), scaled by FUEL_SCALE and shown as a plain number.

import { PLANETS, THRUST, GM_SUN, planetState, bodyState } from './system.js';
import { Sim, gravity } from './nbody.js';
import { Planner, pickFlyby, arrivalRadius } from './planner.js';
import { predict } from './predict.js';

export const MODES = ['hohmann', 'gonow', 'bielliptic', 'assist', 'torch'];
export const MODE_NAMES = { hohmann: 'Hohmann', gonow: 'Go now', bielliptic: 'Bi-elliptic', assist: 'Slingshot', torch: 'Torch' };
export const FUEL_SCALE = 100;

const ps = new Float64Array(4);
const G = new Float64Array(4);
const BURN_SLICE = 1 / 60;   // heading is re-aimed at least this often during a burn (game s)
const TORCH_SLICE = 0.25;    // torch guidance update interval (game s)
const TORCH_ACC = 0.4;       // planned peak acceleration as a fraction of THRUST (headroom for corrections)

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
      stage: mode === 'torch' ? 'torch' : 'depart',
      flyby: mode === 'assist' ? (flyby ?? pickFlyby(sim.body, target)) : null,
      flybyDone: false, inFlyby: false, torch: null,
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
      if (!pred.quick) this.planner.update(sim, engineOn || !!this.burn || trip.stage === 'torch', budgetMs, pred, lead);
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
    if (trip && trip.stage === 'torch' && sim.alive) {
      const r = this.torchStep(left, events);
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

  // ---------------------------------------------------------------- torch
  //
  // Continuous closed-loop guidance (the classic "zero-effort miss / velocity"
  // law): a = 6 ZEM / tgo^2 - 2 ZEV / tgo, aimed at a point in a low orbit
  // around the target planet, with matching orbital velocity. Burn time is
  // chosen so the planned peak acceleration stays well inside the engine's.

  torchAim(tf) {
    const tr = this.trip, T = PLANETS[tr.target];
    const w = tr.torch.waypoint;
    if (w) { // first leg: a point partway round, moving on a circular solar orbit
      const th = w.th0 + w.w * (tf - w.t0);
      const vc = Math.sqrt(GM_SUN / w.r);
      return [w.r * Math.cos(th), w.r * Math.sin(th), -vc * Math.sin(th), vc * Math.cos(th)];
    }
    planetState(tr.target, tf, ps);
    // aim for a slow orbit near the edge of the gravity well; the final
    // approach then spirals down to the low arrival orbit
    const rA = 0.8 * T.hill, vc = Math.sqrt(T.mu / rA);
    // arrive just AHEAD of the planet along its orbit: it never sweeps through
    // the arrival point before we get there, then drifts up to us gently
    const pv = Math.hypot(ps[2], ps[3]);
    const u = [ps[2] / pv, ps[3] / pv];
    return [ps[0] + u[0] * rA, ps[1] + u[1] * rA, ps[2] - u[1] * vc, ps[3] + u[0] * vc];
  }

  torchCommand(t, tf) {
    const sim = this.sim;
    const tgo = Math.max(tf - t, 1e-3);
    const [tx, ty, tvx, tvy] = this.torchAim(tf);
    // model only the Sun's pull: a planet's pull near the ship (e.g. the origin
    // planet while still in its orbit) mostly bends the orbit and must not be
    // extrapolated as a constant; the feedback loop absorbs it
    const r3 = Math.hypot(sim.x, sim.y) ** 3;
    const gx = (-GM_SUN * sim.x) / r3, gy = (-GM_SUN * sim.y) / r3;
    const zemx = tx - (sim.x + sim.vx * tgo + 0.5 * gx * tgo * tgo);
    const zemy = ty - (sim.y + sim.vy * tgo + 0.5 * gy * tgo * tgo);
    const zevx = tvx - (sim.vx + gx * tgo), zevy = tvy - (sim.vy + gy * tgo);
    return [(6 * zemx) / (tgo * tgo) - (2 * zevx) / tgo, (6 * zemy) / (tgo * tgo) - (2 * zevy) / tgo];
  }

  /** Shortest burn time whose planned peak acceleration is affordable. */
  torchSolveTf() {
    const sim = this.sim, tr = this.trip;
    let tgo = 10;
    for (let i = 0; i < 80 && tgo < 4000; i++) {
      tr.torch.tf = sim.t + tgo;
      const [ax, ay] = this.torchCommand(sim.t, tr.torch.tf);
      if (Math.hypot(ax, ay) <= TORCH_ACC * THRUST) break;
      tgo *= 1.08;
    }
  }

  torchInit() {
    const sim = this.sim, tr = this.trip;
    // approach side: arrive on the side of the target facing the ship now
    planetState(tr.target, sim.t, ps);
    let ux = sim.x - ps[0], uy = sim.y - ps[1];
    const ul = Math.hypot(ux, uy) || 1;
    tr.torch = { u: [ux / ul, uy / ul], t0: sim.t, tf: 0, waypoint: null };
    this.torchSolveTf();
    // Never cut close past the Sun (its pull changes too fast for this
    // guidance): if the straight run passes near it, go round via a waypoint.
    const [axp, ayp] = this.torchAim(tr.torch.tf);
    const rS = Math.hypot(sim.x, sim.y), rT = Math.hypot(axp, ayp);
    const dx = axp - sim.x, dy = ayp - sim.y;
    const u = Math.max(0, Math.min(1, -(sim.x * dx + sim.y * dy) / (dx * dx + dy * dy)));
    const near = Math.hypot(sim.x + u * dx, sim.y + u * dy);
    if (near < 0.6 * Math.min(rS, rT)) {
      const a0 = Math.atan2(sim.y, sim.x);
      let da = Math.atan2(ayp, axp) - a0;
      da = ((da % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); // go round the way we orbit (counter-clockwise)
      const r = Math.max(rS, rT) * 0.9;
      tr.torch.waypoint = { r, th0: a0 + da / 2, w: Math.sqrt(GM_SUN / r ** 3), t0: 0 };
      tr.torch.waypoint.t0 = sim.t; // its angle is given at "now"; it then moves on its circle
      this.torchSolveTf();
    }
  }

  torchStep(simDt, events) {
    const sim = this.sim, tr = this.trip;
    let left = simDt, engineOn = false, accel = 0;
    // Launch: thrust prograde until free of the starting planet, so the
    // guidance never steers through it, then start the guided burn.
    while (!tr.torch && left > 1e-12 && sim.alive) {
      const O = PLANETS[tr.origin];
      bodyState(tr.origin, sim.t, ps);
      const rx = sim.x - ps[0], ry = sim.y - ps[1], vx = sim.vx - ps[2], vy = sim.vy - ps[3];
      const energy = (vx * vx + vy * vy) / 2 - O.mu / Math.hypot(rx, ry);
      // free = unbound AND well away from the planet (weak planets become
      // unbound while still close; guidance from there could turn back in)
      if (sim.body !== tr.origin || (energy > 0.15 * O.mu / O.hill && Math.hypot(rx, ry) > 0.5 * O.hill)) { this.torchInit(); break; }
      const h = Math.min(left, BURN_SLICE * 4);
      sim.heading = Math.atan2(vy, vx);
      events.push(...sim.step(h, THRUST));
      this.fuel += THRUST * h;
      left -= h; engineOn = true; accel = THRUST;
    }
    while (left > 1e-12 && sim.alive) {
      const tgo = tr.torch.tf - sim.t;
      const T = PLANETS[tr.target];
      planetState(tr.target, sim.t, ps);
      const dist = Math.hypot(sim.x - ps[0], sim.y - ps[1]);
      if (tr.torch.waypoint && tgo < 3) { tr.torch.waypoint = null; this.torchSolveTf(); continue; } // on to the target
      if (dist < 0.95 * T.hill) tr.torch.final = true;
      let ax, ay, h;
      if (tr.torch.final) {
        // Final approach in the planet's frame (its pull changes too fast for
        // the far-field guidance): steer the velocity toward a gentle inward
        // spiral that settles into a circular orbit at the arrival radius.
        const rx = sim.x - ps[0], ry = sim.y - ps[1], vx = sim.vx - ps[2], vy = sim.vy - ps[3];
        const r = Math.hypot(rx, ry), rA = arrivalRadius(T);
        const nx = rx / r, ny = ry / r;
        const sgn = rx * vy - ry * vx >= 0 ? 1 : -1;
        const tx = -ny * sgn, ty = nx * sgn;
        const vc = Math.sqrt(T.mu / r);
        // descend no faster than the engine can still brake from (stopping distance)
        const dr = r - rA;
        const vr = dr > 0 ? -Math.min(dr / 6, Math.sqrt(2 * 0.25 * THRUST * dr)) : Math.min(-dr / 6, 1);
        const dvx = vr * nx + vc * tx - vx, dvy = vr * ny + vc * ty - vy;
        if (Math.abs(r - rA) < 0.12 * rA && Math.hypot(dvx, dvy) < 0.04 * vc) {
          tr.stage = 'cruise'; // in orbit: the normal logic confirms the capture
          events.push({ type: 'cut', plan: { kind: 'torch' } });
          if (left > 1e-9) events.push(...sim.step(left, 0));
          break;
        }
        ax = dvx / 1.5; ay = dvy / 1.5;
        h = Math.min(left, TORCH_SLICE / 2);
      } else {
        h = Math.min(left, TORCH_SLICE, Math.max(0.05, tgo - 0.5));
        [ax, ay] = this.torchCommand(sim.t, tr.torch.tf);
      }
      const a = Math.min(THRUST, Math.hypot(ax, ay));
      if (a > 1e-6) sim.heading = Math.atan2(ay, ax);
      events.push(...sim.step(h, a));
      this.fuel += a * h;
      left -= h;
      engineOn = a > 1e-6; accel = a;
    }
    return { engineOn, accel };
  }

  /** Torch: game seconds left in the guided burn (for the time director). */
  get torchLeft() {
    const t = this.trip && this.trip.stage === 'torch' && this.trip.torch;
    return t ? Math.max(0, t.tf - this.sim.t) : 0;
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
    if (ap.trip.stage === 'torch') h = 2;
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
