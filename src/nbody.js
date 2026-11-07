// Restricted n-body ship dynamics: the ship feels the Sun and all planets
// (planets move on fixed orbits and are not affected by the ship).
//
// Integration is classic RK4 with a step proportional to the shortest local
// dynamical time sqrt(r^3/GM), so it is fine near planets and coarse in deep
// space. While coasting, the ship follows a cached Trajectory: the same nodes
// are used to draw the prediction, so the ship moves exactly along the line.

import { PLANETS, GM_SUN, SUN, HOME, planetState, bodyState, bodyOf } from './system.js';
import { elements } from './physics.js';

const ETA = 0.01;      // step = ETA * dynamical time
const H_MIN = 1e-3;
const H_MAX = 4;
export const BURN_H = 1 / 240; // max step while the engine fires

const pb = new Float64Array(4);
const A = new Float64Array(4);

/**
 * Gravitational acceleration at (x, y, t). out = [ax, ay, tdyn, hit], where
 * tdyn is the shortest dynamical time and hit is the index of a body whose
 * surface contains the point (-1 Sun, 0.. planets, -2 none).
 */
const PX = new Float64Array(PLANETS.length), PY = new Float64Array(PLANETS.length);

// "Over the top of the Sun": a brachistochrone that would cut straight across
// the Sun is taken to arc high above it instead. While the lift is on, the
// ship near the Sun is treated as LIFT_H above the plane: it cannot hit the
// Sun, and only the in-plane part of the Sun's (much weaker) pull acts on it.
// Beyond LIFT_R1 (just outside Mercury's orbit) nothing changes, and the lift
// is only ever on during a brachistochrone's main burn.
const LIFT_H = 400, LIFT_R0 = 250, LIFT_R1 = 450; // keeps the Sun's in-plane pull under ~0.6
let sunLift = false, liftKeep = -2;
/** Lift on/off. While on, planets other than `keep` (the target) are flown
 * over too: no collision with them and no pull from them. */
export function setSunLift(on, keep = -2) { sunLift = on; liftKeep = keep; }
function liftHeight(r, on = sunLift) {
  if (!on || r >= LIFT_R1) return 0;
  if (r <= LIFT_R0) return LIFT_H;
  const u = (LIFT_R1 - r) / (LIFT_R1 - LIFT_R0);
  return LIFT_H * u * u * (3 - 2 * u);
}
/** The Sun's pull alone, as felt during a brachistochrone burn (lifted). out = [ax, ay]. */
export function sunAccel(x, y, out, lift = true) {
  const r2 = x * x + y * y, hh = liftHeight(Math.sqrt(r2), lift);
  const d2 = r2 + hh * hh, k = -GM_SUN / (d2 * Math.sqrt(d2));
  out[0] = k * x; out[1] = k * y;
  return out;
}

export function gravity(x, y, t, out = A) {
  const r2 = x * x + y * y, r = Math.sqrt(r2);
  const hh = liftHeight(r), d2s = r2 + hh * hh, ds = Math.sqrt(d2s);
  let k = -GM_SUN / (d2s * ds);
  let ax = k * x, ay = k * y;
  let td = ds * Math.sqrt(ds / GM_SUN);
  let hit = r < SUN.radius && hh === 0 ? -1 : -2;
  for (let i = 0; i < PLANETS.length; i++) {
    const P = PLANETS[i];
    planetState(i, t, pb);
    PX[i] = pb[0]; PY[i] = pb[1];
    if (sunLift && i !== liftKeep) { W[i] = 0; continue; } // flown high over (see setSunLift)
    const dx = x - pb[0], dy = y - pb[1];
    const d2 = dx * dx + dy * dy, d = Math.sqrt(d2);
    k = -P.mu / (d2 * d);
    ax += k * dx; ay += k * dy;
    const tdi = d * Math.sqrt(d / P.mu);
    if (tdi < td) td = tdi;
    if (d < P.radius) hit = i;
    // Indirect term. Planets ride fixed orbits and ignore each other, but a real
    // planet and a ship near it fall toward the other planets together. Near
    // planet i, give the ship planet i's acceleration from the other planets
    // (with opposite sign) so only the physical tidal difference remains.
    const f = d / P.hill;
    if (f < 1.2) {
      const w = f < 0.8 ? 1 : 1 - (f - 0.8) / 0.4;
      W[i] = w * w * (3 - 2 * w);
    } else W[i] = 0;
  }
  for (let i = 0; i < PLANETS.length; i++) {
    if (!W[i]) continue;
    for (let j = 0; j < PLANETS.length; j++) {
      if (j === i) continue;
      const dx = PX[i] - PX[j], dy = PY[i] - PY[j];
      const d2 = dx * dx + dy * dy, d = Math.sqrt(d2);
      const kk = (W[i] * PLANETS[j].mu) / (d2 * d);
      ax += kk * dx; ay += kk * dy;
    }
  }
  out[0] = ax; out[1] = ay; out[2] = td; out[3] = hit;
  return out;
}
const W = new Float64Array(PLANETS.length);

export function stepSize(tdyn, cap = H_MAX) {
  return Math.min(cap, Math.max(H_MIN, ETA * tdyn));
}

const k1 = new Float64Array(4), k2 = new Float64Array(4), k3 = new Float64Array(4), k4 = new Float64Array(4);
/** One RK4 step of (x,y,vx,vy) by h with constant extra acceleration (tx,ty). */
export function rk4(s, t, h, tx, ty, out) {
  const [x, y, vx, vy] = s;
  gravity(x, y, t, k1);
  const a1x = k1[0] + tx, a1y = k1[1] + ty;
  gravity(x + vx * h / 2, y + vy * h / 2, t + h / 2, k2);
  const v2x = vx + a1x * h / 2, v2y = vy + a1y * h / 2;
  const a2x = k2[0] + tx, a2y = k2[1] + ty;
  gravity(x + v2x * h / 2, y + v2y * h / 2, t + h / 2, k3);
  const v3x = vx + a2x * h / 2, v3y = vy + a2y * h / 2;
  const a3x = k3[0] + tx, a3y = k3[1] + ty;
  gravity(x + v3x * h, y + v3y * h, t + h, k4);
  const v4x = vx + a3x * h, v4y = vy + a3y * h;
  const a4x = k4[0] + tx, a4y = k4[1] + ty;
  out[0] = x + (h / 6) * (vx + 2 * v2x + 2 * v3x + v4x);
  out[1] = y + (h / 6) * (vy + 2 * v2y + 2 * v3y + v4y);
  out[2] = vx + (h / 6) * (a1x + 2 * a2x + 2 * a3x + a4x);
  out[3] = vy + (h / 6) * (a1y + 2 * a2y + 2 * a3y + a4y);
  return out;
}

/** The body whose Hill sphere contains the point (planet index), else -1 (Sun). */
export function refBody(x, y, t) {
  let best = -1, bestF = 1;
  for (let i = 0; i < PLANETS.length; i++) {
    planetState(i, t, pb);
    const f = Math.hypot(x - pb[0], y - pb[1]) / PLANETS[i].hill;
    if (f < bestF) { bestF = f; best = i; }
  }
  return best;
}

// ---------------------------------------------------------------- trajectory

/** A coasting trajectory: integrator nodes from a start state, extended on demand. */
export class Trajectory {
  constructor() { this.t = []; this.x = []; this.y = []; this.vx = []; this.vy = []; this.head = 0; this.crash = null; }

  reset(t, x, y, vx, vy) {
    this.t = [t]; this.x = [x]; this.y = [y]; this.vx = [vx]; this.vy = [vy];
    this.head = 0; this.crash = null;
  }

  get length() { return this.t.length; }
  get endT() { return this.t[this.t.length - 1]; }

  /** Integrate one more step. Returns false once the path has hit a body. */
  extendStep() {
    if (this.crash) return false;
    const n = this.t.length - 1;
    const s = [this.x[n], this.y[n], this.vx[n], this.vy[n]];
    const t = this.t[n];
    gravity(s[0], s[1], t, A);
    const h = stepSize(A[2]);
    const o = rk4(s, t, h, 0, 0, new Float64Array(4));
    this.t.push(t + h); this.x.push(o[0]); this.y.push(o[1]); this.vx.push(o[2]); this.vy.push(o[3]);
    gravity(o[0], o[1], t + h, A);
    if (A[3] !== -2) { this.crash = { t: t + h, body: A[3], index: n + 1 }; return false; }
    return true;
  }

  extendTo(tEnd, maxSteps = 200000) {
    let n = 0;
    while (this.endT < tEnd && !this.crash && n++ < maxSteps) this.extendStep();
  }

  /** Index i with t[i] <= t < t[i+1] (searching from head). */
  find(t) {
    let lo = this.head, hi = this.t.length - 1;
    if (t <= this.t[lo]) return lo;
    if (t >= this.t[hi]) return hi;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.t[m] <= t) lo = m; else hi = m; }
    return lo;
  }

  /** Cubic-Hermite interpolated state at time t. */
  stateAt(t, out = new Float64Array(4)) {
    const i = this.find(t);
    const j = Math.min(i + 1, this.t.length - 1);
    if (i === j) { out[0] = this.x[i]; out[1] = this.y[i]; out[2] = this.vx[i]; out[3] = this.vy[i]; return out; }
    const h = this.t[j] - this.t[i];
    const s = (t - this.t[i]) / h, s2 = s * s, s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
    const d00 = (6 * s2 - 6 * s) / h, d10 = 3 * s2 - 4 * s + 1, d01 = (-6 * s2 + 6 * s) / h, d11 = 3 * s2 - 2 * s;
    out[0] = h00 * this.x[i] + h10 * h * this.vx[i] + h01 * this.x[j] + h11 * h * this.vx[j];
    out[1] = h00 * this.y[i] + h10 * h * this.vy[i] + h01 * this.y[j] + h11 * h * this.vy[j];
    out[2] = d00 * this.x[i] + d10 * this.vx[i] + d01 * this.x[j] + d11 * this.vx[j];
    out[3] = d00 * this.y[i] + d10 * this.vy[i] + d01 * this.y[j] + d11 * this.vy[j];
    return out;
  }

  /** Forget nodes before time t (keeps the one bracketing t). */
  trim(t) {
    this.head = this.find(t);
    if (this.head > 20000) {
      const h = this.head;
      for (const k of ['t', 'x', 'y', 'vx', 'vy']) this[k] = this[k].slice(h);
      if (this.crash) this.crash.index -= h;
      this.head = 0;
    }
  }

  /** A fresh trajectory continuing deterministically from node i. */
  forkAt(i) {
    const tr = new Trajectory();
    tr.reset(this.t[i], this.x[i], this.y[i], this.vx[i], this.vy[i]);
    return tr;
  }
}

/**
 * The one definition of "in a closed orbit around planet P", shared by the
 * Captured status and the transfer planner: bound, clear of the surface, and
 * staying inside the planet's Hill sphere (with a small margin).
 */
export function closedOrbit(el, P) {
  return el.bound && el.rp > P.radius && el.ra < 0.9 * P.hill;
}

// ---------------------------------------------------------------- ship

const tmp = new Float64Array(4);

export class Sim {
  constructor() { this.t = 0; this.version = 0; this.traj = new Trajectory(); this.reset(); }

  /** Circular, prograde low orbit around the home planet. */
  reset() {
    const P = PLANETS[HOME];
    const r = 22, v = Math.sqrt(P.mu / r), ang = Math.PI * 0.5;
    planetState(HOME, this.t, pb);
    this.x = pb[0] + r * Math.cos(ang); this.y = pb[1] + r * Math.sin(ang);
    this.vx = pb[2] - v * Math.sin(ang); this.vy = pb[3] + v * Math.cos(ang);
    this.heading = ang + Math.PI / 2;
    this.body = HOME;
    this.alive = true;
    this.captured = true;
    this.restart();
  }

  /** Start a new coasting trajectory from the current state. */
  restart() {
    this.traj.reset(this.t, this.x, this.y, this.vx, this.vy);
    this.version++;
  }

  world(out = new Float64Array(4)) { out[0] = this.x; out[1] = this.y; out[2] = this.vx; out[3] = this.vy; return out; }

  /** State relative to the current reference body. */
  rel(out = new Float64Array(4)) {
    bodyState(this.body, this.t, pb);
    out[0] = this.x - pb[0]; out[1] = this.y - pb[1]; out[2] = this.vx - pb[2]; out[3] = this.vy - pb[3];
    return out;
  }

  /** Osculating two-body elements relative to the reference body. */
  elements() {
    const r = this.rel(tmp);
    return elements(r[0], r[1], r[2], r[3], bodyOf(this.body).mu);
  }

  /** Advance by dt seconds of sim time with thrust `accel` along the heading. */
  step(dt, accel) {
    const events = [];
    if (!this.alive) { this.t += dt; return events; }

    if (accel > 0) {
      // Live integration with thrust; the coasting trajectory restarts afterwards.
      const tx = accel * Math.cos(this.heading), ty = accel * Math.sin(this.heading);
      let left = dt;
      const s = new Float64Array(4);
      while (left > 1e-12) {
        gravity(this.x, this.y, this.t, A);
        const h = Math.min(left, stepSize(A[2], BURN_H));
        rk4([this.x, this.y, this.vx, this.vy], this.t, h, tx, ty, s);
        this.x = s[0]; this.y = s[1]; this.vx = s[2]; this.vy = s[3];
        this.t += h; left -= h;
        gravity(this.x, this.y, this.t, A);
        if (A[3] !== -2) return this.crashed(A[3], events);
      }
      this.restart();
    } else {
      const tNew = this.t + dt;
      this.traj.extendTo(tNew);
      if (this.traj.crash && this.traj.crash.t <= tNew) {
        const c = this.traj.crash;
        this.t = c.t; this.x = this.traj.x[c.index]; this.y = this.traj.y[c.index];
        return this.crashed(c.body, events);
      }
      this.traj.stateAt(tNew, tmp);
      this.x = tmp[0]; this.y = tmp[1]; this.vx = tmp[2]; this.vy = tmp[3];
      this.t = tNew;
      this.traj.trim(tNew);
    }

    const nb = refBody(this.x, this.y, this.t);
    if (nb !== this.body) {
      if (this.body >= 0) events.push({ type: 'escape', body: this.body });
      if (nb >= 0) events.push({ type: 'enter', body: nb });
      this.body = nb;
      this.captured = false;
    }
    // `captured` is decided from the prediction (does the orbit hold?) in main.js
    return events;
  }

  crashed(body, events) {
    this.alive = false;
    this.body = body;
    events.push({ type: 'crash', body });
    return events;
  }
}
