// Transfer planner ("easy mode") for the n-body ship.
//
// 1. A textbook Hohmann estimate gives a first guess: when the window opens,
//    roughly where on the parking orbit to burn, and for how long.
// 2. That guess is refined by shooting: simulate the actual burn (prograde,
//    as a pilot would fly it) with the same integrator the game uses, coast,
//    measure the encounter, adjust timing and duration. It runs as a generator
//    a few milliseconds per frame, so it never stalls rendering.
//
// The physics is deterministic (planets on fixed orbits), so a refined plan
// stays valid until the ship next fires its engine.

import { timeFromPeri, timeToNu, nuOfPos, kepler, elements, TAU } from './physics.js';
import { PLANETS, GM_SUN, THRUST, FINE, planetState, bodyState, bodyOf } from './system.js';
import { Trajectory, gravity, rk4, stepSize, BURN_H, closedOrbit } from './nbody.js';

const ps = new Float64Array(4);
const tmp = new Float64Array(4);
const G = new Float64Array(4);
const mod = (x, m) => ((x % m) + m) % m;

/**
 * Distance from the target's centre to aim the arrival pass at: 2.5 radii,
 * but for planets with a small gravity well (Mercury) lower, so a capture
 * orbit that stays well inside the Hill sphere is reachable with one burn.
 */
/** Score units (u of miss distance) per u/s of arrival speed at the target. */
const ARRIVAL_SPEED_WEIGHT = 5;

export function arrivalRadius(T) {
  return Math.min(2.5 * T.radius, Math.max(1.5 * T.radius, 0.3 * T.hill));
}

function hohmann(from, to, parkR) {
  const P = PLANETS[from], T = PLANETS[to];
  const r1 = P.a, r2 = T.a, aT = (r1 + r2) / 2;
  const tH = Math.PI * Math.sqrt(aT ** 3 / GM_SUN);
  const vinf = Math.abs(Math.sqrt(GM_SUN * (2 / r1 - 1 / aT)) - Math.sqrt(GM_SUN / r1));
  const e = 1 + (parkR * vinf * vinf) / P.mu;
  const aH = -P.mu / (vinf * vinf);
  const pH = aH * (1 - e * e);
  const nuInf = Math.acos(-1 / e);
  const nuR = Math.acos(Math.max(-1, Math.min(1, (pH / P.hill - 1) / e)));
  const tFlight = timeFromPeri({ e, n: Math.sqrt(P.mu / (-aH) ** 3) }, nuR);
  const dv = Math.sqrt(vinf * vinf + (2 * P.mu) / parkR) - Math.sqrt(P.mu / parkR);
  const dw = T.w - P.w;
  const needBurn = Math.PI - T.w * tH - dw * tFlight; // target-minus-planet phase at burn
  return { tH, vinf, nuInf, tFlight, dv, dw, needBurn, outward: r2 > r1 };
}

/** Prograde departure burn duration (from a circular parking orbit of radius parkR
 * around planet `from`) that leaves on a solar ellipse reaching radius rFar. */
function departDurFor(from, parkR, rFar) {
  const P = PLANETS[from], r1 = P.a, a = (r1 + rFar) / 2;
  const vinf = Math.abs(Math.sqrt(GM_SUN * (2 / r1 - 1 / a)) - Math.sqrt(GM_SUN / r1));
  return (Math.sqrt(vinf * vinf + (2 * P.mu) / parkR) - Math.sqrt(P.mu / parkR)) / THRUST;
}

/** Planet to swing past for a gravity assist from `from` to `to`. */
export function pickFlyby(from, to, skip = []) {
  const mid = (PLANETS[from].a + PLANETS[to].a) / 2;
  const c = PLANETS.map((p, i) => i).filter((i) => i !== from && i !== to && !skip.includes(i));
  c.sort((i, j) => Math.abs(PLANETS[i].a - mid) - Math.abs(PLANETS[j].a - mid));
  return c.length ? c[0] : null;
}

/**
 * Departure plan for a trip mode:
 *  hohmann    - textbook window, cheapest two-burn transfer
 *  gonow      - leave within the next parking orbit, any phase, shooting
 *  bielliptic - leave now onto an ellipse past both orbits; the far-point burn
 *               (planned later) drops/raises the other apsis to the target
 *  assist     - leave now toward the flyby planet
 */
export function initialDeparture(sim, trip) {
  const aimAt = trip.mode === 'assist' ? trip.flyby : trip.target;
  const base = initialPlan(sim, aimAt);
  if (!base) return null;
  base.target = trip.target; base.mode = trip.mode;
  if (trip.mode === 'hohmann') return base;
  const el = sim.elements();
  // search the next lap (and the one after) of the parking orbit, starting now
  base.tIdeal = sim.t + 2 + 0.6 * base.period;
  base.synodic = base.period;
  base.fuelW = 5; base.timeW = 0.004;
  const r1 = PLANETS[sim.body].a, r2 = PLANETS[trip.target].a;
  if (trip.mode === 'gonow') {
    base.durs = [0.8, 1, 1.3, 1.7, 2.2, 3, 4].map((k) => base.dur * k);
    base.horizon = base.H.tH * 2.5 + base.H.tFlight * 3;
  } else if (trip.mode === 'assist') {
    base.aimBody = trip.flyby;
    base.durs = [0.8, 1, 1.3, 1.7, 2.2, 3].map((k) => base.dur * k);
    base.horizon = base.H.tH * 2.5 + base.H.tFlight * 3;
  } else if (trip.mode === 'bielliptic') {
    const rMax = Math.max(r1, r2);
    base.bi = { r2, rMin: 1.3 * rMax };
    base.durs = [1.5, 1.75, 2.0, 2.4, 2.9].map((k) => departDurFor(sim.body, el.a, k * rMax));
    const rb = 2.9 * rMax;
    const half = (a) => Math.PI * Math.sqrt(a ** 3 / GM_SUN);
    base.horizon = (half((r1 + rb) / 2) + half((r2 + rb) / 2)) * 1.3 + base.H.tFlight * 3;
  }
  return base;
}

/** First guess, or null if the ship is not in a closed orbit around a planet. */
export function initialPlan(sim, target) {
  const P = PLANETS[sim.body], T = PLANETS[target];
  const el = sim.elements();
  if (!el.bound) return null;
  const H = hohmann(sim.body, target, el.a);
  const dur = H.dv / THRUST;
  const rel = mod(T.phase0 - P.phase0 + H.dw * sim.t + Math.PI, TAU) - Math.PI;
  let x = H.needBurn - rel;
  x = H.dw > 0 ? mod(x, TAU) : -mod(-x, TAU);
  let tIdeal = sim.t + x / H.dw;
  const synodic = TAU / Math.abs(H.dw);
  if (tIdeal - dur - 2 < sim.t) tIdeal += synodic;
  // burn centre: where the escape asymptote ends up (anti)parallel to the planet's motion
  planetState(sim.body, tIdeal + H.tFlight, ps);
  const phi = Math.atan2(ps[3], ps[2]) + (H.outward ? 0 : Math.PI) - el.s * H.nuInf;
  const nuMid = nuOfPos(el, Math.cos(phi), Math.sin(phi));
  const tTo = timeToNu(el, nuMid);
  let tMid = sim.t + tTo + Math.round((tIdeal - sim.t - tTo) / el.period) * el.period;
  while (tMid - dur / 2 < sim.t + 1) tMid += el.period;
  return { kind: 'depart', frame: sim.body, dir: 'pro', armWindow: el.period, target, from: sim.body, version: sim.version, H, period: el.period, dur, tMid, tIdeal, synodic, refined: false, score: Infinity };
}

/**
 * Score a candidate burn: simulate it and the coast that follows.
 * Lower is better; 0 = closest approach exactly at the desired altitude.
 */
function evaluate(base, plan, tMid, dur) {
  const T = PLANETS[plan.target];
  const t0 = tMid - dur / 2;
  base.extendTo(t0 + 1);
  base.stateAt(t0, tmp);
  let x = tmp[0], y = tmp[1], vx = tmp[2], vy = tmp[3];
  let t = t0;
  const s = new Float64Array(4);
  // the burn: thrust prograde relative to the departure planet
  let left = dur;
  while (left > 1e-9) {
    gravity(x, y, t, G);
    if (G[3] !== -2) return { score: 1e7 };
    const h = Math.min(left, stepSize(G[2], BURN_H));
    planetState(plan.from, t, ps);
    const hd = Math.atan2(vy - ps[3], vx - ps[2]);
    rk4([x, y, vx, vy], t, h, THRUST * Math.cos(hd), THRUST * Math.sin(hd), s);
    x = s[0]; y = s[1]; vx = s[2]; vy = s[3]; t += h; left -= h;
  }
  // the coast
  let tr = new Trajectory();
  tr.reset(t, x, y, vx, vy);
  const tBurnEnd = t;
  const tEnd = t + (plan.horizon || plan.H.tFlight * 2.5 + plan.H.tH * 1.5 + 200);
  const P = PLANETS[plan.from];
  const aim = plan.aimBody ?? plan.target;
  const A = PLANETS[aim];
  const leaveBy = t + plan.H.tFlight * 3 + plan.period * 1.5; // must have left the planet by then
  let best = Infinity, bestT = 0, bestV = 0, steps = 0, departed = false;
  let biDone = !plan.bi, lastRv = 0, dvAim = 0, nearMiss = false;
  while (tr.endT < tEnd && steps++ < 120000) {
    if (!tr.extendStep()) break;
    const n = tr.length - 1;
    if (!departed) {
      planetState(plan.from, tr.t[n], ps);
      if (Math.hypot(tr.x[n] - ps[0], tr.y[n] - ps[1]) > P.hill) {
        departed = true;
        // bi-elliptic leaves outward, toward its far point
        if (plan.bi && tr.x[n] * tr.vx[n] + tr.y[n] * tr.vy[n] < 0) return { score: 1e6 };
      } else if (tr.t[n] > leaveBy) return { score: 1e6 }; // still bound: not a transfer
      continue;
    }
    // stay clear of planets that are not part of the plan: a near miss in the
    // planner can become a crash in flight
    if ((steps & 3) === 0) {
      for (let k = 0; k < PLANETS.length; k++) {
        if (k === plan.from || k === aim || k === plan.target) continue;
        planetState(k, tr.t[n], ps);
        if (Math.hypot(tr.x[n] - ps[0], tr.y[n] - ps[1]) < 0.7 * PLANETS[k].hill) nearMiss = true;
      }
    }
    if (!biDone) {
      // bi-elliptic: at the far point, set the speed for an ellipse whose
      // other apsis is the target's orbit (an impulse here; planned properly later)
      const rx = tr.x[n], ry = tr.y[n], rvx = tr.vx[n], rvy = tr.vy[n];
      const rv = rx * rvx + ry * rvy;
      // the far point: turning around well beyond both orbits (not a wobble near the origin)
      if (lastRv > 0 && rv <= 0 && Math.hypot(rx, ry) > plan.bi.rMin) {
        const r = Math.hypot(rx, ry), r2 = plan.bi.r2;
        const vNeed = Math.sqrt((GM_SUN * 2 * r2) / (r * (r + r2)));
        const sgn = rx * rvy - ry * rvx >= 0 ? 1 : -1;
        const tx = (-ry / r) * sgn, ty = (rx / r) * sgn;
        dvAim = Math.hypot(tx * vNeed - rvx, ty * vNeed - rvy);
        const t2 = tr.t[n];
        tr = new Trajectory();
        tr.reset(t2, rx, ry, tx * vNeed, ty * vNeed);
        biDone = true;
        continue;
      }
      lastRv = rv;
      continue;
    }
    planetState(aim, tr.t[n], ps);
    const d = Math.hypot(tr.x[n] - ps[0], tr.y[n] - ps[1]);
    if (d < best) { best = d; bestT = tr.t[n]; bestV = Math.hypot(tr.vx[n] - ps[2], tr.vy[n] - ps[3]); }
    else if (best < A.hill && d > A.hill) break; // passed the target
  }
  if (!biDone) return { score: 1e6 }; // never turned around
  if (tr.crash) {
    if (tr.crash.body === aim) return { score: 1e3 + T.radius, ca: 0, t: tr.crash.t, impact: true };
    return { score: 1e7 };
  }
  let score;
  if (plan.aimBody != null) {
    // heading for a flyby: pass at a moderate distance; speed is welcome
    const want = Math.max(2.5 * A.radius, 0.25 * A.hill);
    score = best < A.hill ? Math.abs(best - want) : 1e4 + best;
  } else {
    const desired = arrivalRadius(T);
    // prefer gentle arrivals: a fast flyby cannot be captured with one burn
    score = best < T.hill ? Math.abs(best - desired) + ARRIVAL_SPEED_WEIGHT * bestV : 1e4 + best;
  }
  score += (plan.fuelW || 0) * (dur * THRUST + dvAim) + (plan.timeW || 0) * (bestT - tBurnEnd) + (nearMiss ? 400 : 0);
  return { score, ca: best - A.radius, t: bestT, impact: false };
}

export function* refine(sim, plan) {
  // A deterministic copy of the ship's coast, started from a node of its own
  // trajectory, so the planner sees exactly the future the game will play.
  const base = sim.traj.forkAt(sim.traj.head);
  const span = plan.period * 0.15;
  let best = { score: Infinity }, bestMid = plan.tMid, bestDur = plan.dur;
  const tryIt = (mid, dur) => {
    if (mid - dur / 2 < sim.t + 0.5) return Infinity;
    const r = evaluate(base, plan, mid, dur);
    if (r.score < best.score) { best = r; bestMid = mid; bestDur = dur; }
    return r.score;
  };
  function* golden(f, a, b, iters) {
    const g = 0.381966;
    let x1 = a + g * (b - a), x2 = b - g * (b - a);
    let f1 = f(x1); yield; let f2 = f(x2); yield;
    for (let i = 0; i < iters; i++) {
      if (f1 < f2) { b = x2; x2 = x1; f2 = f1; x1 = a + g * (b - a); f1 = f(x1); }
      else { a = x1; x1 = x2; f1 = f2; x2 = b - g * (b - a); f2 = f(x2); }
      yield;
    }
  }
  // Coarse scan: every point of the parking orbit around the window (large or
  // eccentric orbits can be slow, so the textbook burn point is only a hint),
  // over a range of durations. If this window has nothing, try the next one.
  const half = Math.max(plan.period * 0.6, 8);
  // sample departure times finely enough not to step over the arrival window:
  // the target crosses its own gravity well in hill / orbital speed seconds
  const Tp = PLANETS[plan.aimBody ?? plan.target];
  const stepMax = (0.5 * Tp.hill) / (Tp.a * Tp.w);
  const N = Math.min(160, Math.max(24, Math.ceil((2 * half) / stepMax))), stepT = (2 * half) / N;
  for (const center of [plan.tIdeal, plan.tIdeal + plan.synodic]) {
    for (let i = 0; i <= N; i++) {
      for (const d of plan.durs || [0.6, 0.8, 1, 1.25, 1.6].map((k) => plan.dur * k)) { tryIt(center - half + i * stepT, d); yield; }
    }
    if (best.score < 1e3) break;
  }
  // alternate golden-section refinements around the best so far
  for (let round = 0; round < 3; round++) {
    const m0 = bestMid, d0 = bestDur, w = (stepT * 1.5) / (round + 1);
    yield* golden((m) => tryIt(m, d0), m0 - w, m0 + w, 10);
    const m1 = bestMid;
    yield* golden((d) => tryIt(m1, d), bestDur * 0.85, bestDur * 1.15, 8);
  }
  plan.tMid = bestMid; plan.dur = bestDur; plan.score = best.score;
  plan.ca = best.ca; plan.tArrive = best.t; plan.impact = best.impact;
  plan.ok = best.score < 1e3 + (plan.fuelW || 0) * 200 + (plan.timeW || 0) * 1e5;
  plan.refined = true;
}

// ---------------------------------------------------------------- capture

/**
 * Capture at the target: a retrograde burn (relative to the target) centred on
 * the closest approach, sized so the ship ends up in a near-circular orbit.
 * The duration is refined by simulating the burn. `visit` is the predicted
 * pass through the target (from predict()).
 */
export function planCapture(sim, target, visit) {
  const T = PLANETS[target];
  if (!visit || visit.impact || visit.ca.pe < 0.3 * T.radius) return null;
  const tPe = sim.t + visit.ca.dt;
  const tr = sim.traj;
  if (tPe > tr.endT || tPe < sim.t) return null;
  tr.stateAt(tPe, tmp);
  planetState(target, tPe, ps);
  const r = Math.hypot(tmp[0] - ps[0], tmp[1] - ps[1]);
  const v = Math.hypot(tmp[2] - ps[2], tmp[3] - ps[3]);
  const dv = v - Math.sqrt(T.mu / r);
  if (dv <= 0.02) return null;
  const dur0 = dv / THRUST;

  // Simulate a retrograde burn of duration d whose centre is `off` seconds from
  // periapsis (fast arrivals need to start braking early). Score: eccentricity
  // of the resulting orbit, with large penalties for not ending up bound
  // inside the Hill sphere or for skimming the surface.
  const s = new Float64Array(4);
  const trial = (off, d) => {
    const t0 = Math.max(sim.t, tPe + off - d / 2);
    tr.stateAt(t0, tmp);
    let x = tmp[0], y = tmp[1], vx = tmp[2], vy = tmp[3], t = t0, left = d;
    while (left > 1e-9) {
      gravity(x, y, t, G);
      if (G[3] !== -2) return 1e6;
      const h = Math.min(left, stepSize(G[2], BURN_H));
      planetState(target, t, ps);
      const hd = Math.atan2(vy - ps[3], vx - ps[2]) + Math.PI;
      rk4([x, y, vx, vy], t, h, THRUST * Math.cos(hd), THRUST * Math.sin(hd), s);
      x = s[0]; y = s[1]; vx = s[2]; vy = s[3]; t += h; left -= h;
    }
    planetState(target, t, ps);
    const el = elements(x - ps[0], y - ps[1], vx - ps[2], vy - ps[3], T.mu);
    let score = el.e;
    if (!el.bound) score += 100;
    else if (el.ra > 0.9 * T.hill) score += 50;
    else if (el.ra > 0.5 * T.hill) score += 2 * (el.ra / T.hill); // prefer tight, stable orbits
    if (el.rp < 1.5 * T.radius) score += 100; // a low periapsis decays into the surface under solar tides
    return score;
  };
  let bestOff = 0, bestDur = dur0, bestScore = Infinity;
  const test = (o, d) => { const f = trial(o, d); if (f < bestScore) { bestScore = f; bestOff = o; bestDur = d; } return f; };
  for (const k of [0.6, 0.8, 1, 1.25, 1.6, 2.1, 2.8]) for (const fo of [-0.9, -0.6, -0.35, -0.15, 0, 0.2]) test(fo * dur0 * k, dur0 * k);
  const g = 0.381966;
  const golden = (f, a, b, iters) => {
    let x1 = a + g * (b - a), x2 = b - g * (b - a), f1 = f(x1), f2 = f(x2);
    for (let i = 0; i < iters; i++) {
      if (f1 < f2) { b = x2; x2 = x1; f2 = f1; x1 = a + g * (b - a); f1 = f(x1); }
      else { a = x1; x1 = x2; f1 = f2; x2 = b - g * (b - a); f2 = f(x2); }
    }
  };
  for (let round = 0; round < 2; round++) {
    const w = dur0 * 0.3 / (round + 1);
    const d0 = bestDur; golden((o) => test(o, d0), bestOff - w, bestOff + w, 10);
    const o0 = bestOff; golden((d) => test(o0, d), bestDur * 0.8, bestDur * 1.25, 10);
  }
  const dur = bestDur, score = bestScore;
  const tMid = Math.max(sim.t + dur / 2, tPe + bestOff);
  return {
    kind: 'capture', frame: target, dir: 'retro', armWindow: 60, target, from: target,
    // ok if it ends bound and clear of the surface; a wide first orbit is
    // tightened by another capture burn at the next periapsis
    version: sim.version, tMid, dur, ca: r - T.radius, ok: score < 100, refined: true, score,
  };
}

/**
 * Rescue inside the target's gravity well: the orbit will hit the surface or
 * not hold (e.g. solar tides near Mercury). Search a burn a few seconds ahead
 * (any direction relative to planet-frame prograde, any size) for a safe,
 * tight orbit.
 */
export function planRescue(sim, target) {
  const T = PLANETS[target];
  const tr = sim.traj;
  const t0 = sim.t + 3;
  tr.extendTo(t0 + 1);
  const s = new Float64Array(4);
  const trial = (ang, d) => {
    tr.stateAt(t0, tmp);
    let x = tmp[0], y = tmp[1], vx = tmp[2], vy = tmp[3], t = t0, left = d;
    while (left > 1e-9) {
      gravity(x, y, t, G);
      if (G[3] !== -2) return 1e6;
      const h = Math.min(left, stepSize(G[2], BURN_H));
      planetState(target, t, ps);
      const hd = Math.atan2(vy - ps[3], vx - ps[2]) + ang;
      rk4([x, y, vx, vy], t, h, THRUST * Math.cos(hd), THRUST * Math.sin(hd), s);
      x = s[0]; y = s[1]; vx = s[2]; vy = s[3]; t += h; left -= h;
    }
    planetState(target, t, ps);
    const el = elements(x - ps[0], y - ps[1], vx - ps[2], vy - ps[3], T.mu);
    let score = el.e + 0.05 * d;
    if (!el.bound) score += 100;
    else if (el.ra > 0.5 * T.hill) score += 10 * (el.ra / T.hill);
    if (el.rp < 1.5 * T.radius) score += 100;
    return score;
  };
  let bestA = 0, bestD = 0.5, best = Infinity;
  for (let i = 0; i < 16; i++) for (const d of [0.1, 0.25, 0.5, 1, 2, 4, 7]) {
    const a = (i / 16) * TAU, f = trial(a, d);
    if (f < best) { best = f; bestA = a; bestD = d; }
  }
  const g = 0.381966;
  const golden = (f, a, b, iters) => {
    let x1 = a + g * (b - a), x2 = b - g * (b - a), f1 = f(x1), f2 = f(x2);
    for (let i = 0; i < iters; i++) {
      if (f1 < f2) { b = x2; x2 = x1; f2 = f1; x1 = a + g * (b - a); f1 = f(x1); }
      else { a = x1; x1 = x2; f1 = f2; x2 = b - g * (b - a); f2 = f(x2); }
    }
  };
  for (let round = 0; round < 3; round++) {
    const w = (TAU / 16) / (round + 1);
    golden((a) => { const f = trial(a, bestD); if (f < best) { best = f; bestA = a; } return f; }, bestA - w, bestA + w, 10);
    golden((d) => { const f = trial(bestA, d); if (f < best) { best = f; bestD = d; } return f; }, bestD * 0.5, bestD * 1.6, 10);
  }
  return {
    kind: 'capture', frame: target, dir: 'plan', angle: bestA, thrust: THRUST, armWindow: 60, target, from: target,
    version: sim.version, tStart: t0, tMid: t0 + bestD / 2, dur: bestD, ca: 0, ok: best < 100, refined: true, score: best, rescue: true,
  };
}

// ---------------------------------------------------------------- mid-course correction

const DV_WEIGHT = 25;      // score units (u of miss) per u/s of correction: prefer small burns

/** A correction burn `lead` seconds ahead, in solar orbit; refined by refineCorrection(). */
export function initialCorrection(sim, trip, lead) {
  const tStart = sim.t + lead;
  const el = elements(sim.x, sim.y, sim.vx, sim.vy, GM_SUN);
  const horizon = el.bound ? Math.min(60000, Math.max(4000, 1.5 * el.period)) : 8000;
  return {
    kind: 'correct', frame: -1, dir: 'plan', angle: 0, thrust: THRUST * FINE, armWindow: 60,
    target: trip.target, from: -1, version: sim.version, tStart, tMid: tStart + 1, dur: 2, dv: 0,
    horizon, passBody: trip.mode === 'assist' && !trip.flybyDone ? trip.flyby : null,
    refined: false, ok: false, score: Infinity,
  };
}

/**
 * The mode-specific heliocentric burn after departure:
 *  bielliptic - at the far point: set the speed so the other apsis is the target's orbit
 *  assist     - soon after departure: steer the flyby so it throws us to the target
 */
export function initialAim(sim, trip, lead) {
  const plan = initialCorrection(sim, trip, lead);
  plan.kind = 'aim';
  plan.thrust = THRUST;
  if (trip.mode === 'bielliptic') {
    const el = elements(sim.x, sim.y, sim.vx, sim.vy, GM_SUN);
    if (!el.bound) return null;
    const tAp = sim.t + timeToNu(el, Math.PI);
    const r = el.ra, r2 = PLANETS[trip.target].a;
    const vNow = Math.sqrt(GM_SUN * (2 / r - 1 / el.a));
    const vNeed = Math.sqrt((GM_SUN * 2 * r2) / (r * (r + r2)));
    const dv0 = Math.abs(vNeed - vNow), a0 = vNeed > vNow ? 0 : Math.PI;
    plan.tStart = Math.max(sim.t + 2, tAp - dv0 / THRUST / 2);
    plan.tMid = plan.tStart + 1;
    plan.angles = [-0.25, -0.12, -0.05, 0, 0.05, 0.12, 0.25].map((d) => a0 + d);
    plan.dvs = [0.7, 0.85, 1, 1.15, 1.3].map((k) => Math.max(0.02, dv0 * k));
    plan.horizon = Math.min(80000, Math.PI * Math.sqrt(((r + r2) / 2) ** 3 / GM_SUN) * 1.6 + 500);
    plan.fuelW = 5;
  } else {
    plan.passBody = trip.flyby;
    plan.dvs = [0.02, 0.05, 0.1, 0.2, 0.4, 0.8, 1.4];
    const rT = PLANETS[trip.target].a, rF = PLANETS[trip.flyby].a;
    plan.horizon = Math.min(80000, Math.PI * Math.sqrt(((rF + rT) / 2) ** 3 / GM_SUN) * 2.5 + 4000);
    plan.timeW = 0.002;
  }
  return plan;
}

/**
 * Score a correction: from tStart, thrust at `angle` to the solar prograde
 * direction until `dv` is delivered (fine thrust for small corrections, full
 * thrust for big ones), then coast and measure the pass by the target.
 */
function evalCorrection(base, plan, angle, dv) {
  const T = PLANETS[plan.target];
  const acc = dv <= 0.4 ? THRUST * FINE : THRUST;
  const dur = dv / acc;
  base.extendTo(plan.tStart + 1);
  base.stateAt(plan.tStart, tmp);
  let x = tmp[0], y = tmp[1], vx = tmp[2], vy = tmp[3], t = plan.tStart, left = dur;
  const s = new Float64Array(4);
  while (left > 1e-9) {
    gravity(x, y, t, G);
    if (G[3] !== -2) return { score: 1e7 };
    const h = Math.min(left, stepSize(G[2], BURN_H));
    const hd = Math.atan2(vy, vx) + angle;
    rk4([x, y, vx, vy], t, h, acc * Math.cos(hd), acc * Math.sin(hd), s);
    x = s[0]; y = s[1]; vx = s[2]; vy = s[3]; t += h; left -= h;
  }
  const tr = new Trajectory();
  tr.reset(t, x, y, vx, vy);
  const tEnd = t + (plan.horizon || 4000);
  const PB = plan.passBody != null ? PLANETS[plan.passBody] : null;
  let best = Infinity, bestT = 0, bestV = 0, steps = 0, passed = !PB;
  while (tr.endT < tEnd && steps++ < 150000) {
    if (!tr.extendStep()) break;
    const n = tr.length - 1;
    if (!passed) {
      planetState(plan.passBody, tr.t[n], ps);
      if (Math.hypot(tr.x[n] - ps[0], tr.y[n] - ps[1]) < 0.8 * PB.hill) passed = true;
      continue; // the target only counts after the flyby
    }
    planetState(plan.target, tr.t[n], ps);
    const d = Math.hypot(tr.x[n] - ps[0], tr.y[n] - ps[1]);
    if (d < best) { best = d; bestT = tr.t[n]; bestV = Math.hypot(tr.vx[n] - ps[2], tr.vy[n] - ps[3]); }
    else if (best < T.hill && d > T.hill) break; // passed the target
  }
  const cost = (plan.fuelW || DV_WEIGHT) * dv;
  if (!passed) return { score: 2e4 + cost, acc, dur };
  if (tr.crash) {
    if (tr.crash.body === plan.target) return { score: 1e3 + cost, ca: 0, impact: true, acc, dur };
    return { score: 1e7 };
  }
  const want = arrivalRadius(T);
  const score = (best < T.hill ? Math.abs(best - want) + ARRIVAL_SPEED_WEIGHT * bestV : 1e4 + best) + cost
    + (plan.timeW || 0) * (bestT - plan.tStart);
  return { score, ca: best - T.radius, tArrive: bestT, acc, dur };
}

/** Search direction x size of the correction (coarse grid, then golden refinement). */
export function* refineCorrection(sim, plan) {
  const base = sim.traj.forkAt(sim.traj.head);
  let best = { score: Infinity }, bestA = 0, bestDv = 0.05;
  const tryIt = (a, dv) => {
    if (!(dv > 0)) return Infinity;
    const r = evalCorrection(base, plan, a, dv);
    if (r.score < best.score) { best = r; bestA = a; bestDv = dv; }
    return r.score;
  };
  function* golden(f, a, b, iters) {
    const g = 0.381966;
    let x1 = a + g * (b - a), x2 = b - g * (b - a);
    let f1 = f(x1); yield; let f2 = f(x2); yield;
    for (let i = 0; i < iters; i++) {
      if (f1 < f2) { b = x2; x2 = x1; f2 = f1; x1 = a + g * (b - a); f1 = f(x1); }
      else { a = x1; x1 = x2; f1 = f2; x2 = b - g * (b - a); f2 = f(x2); }
      yield;
    }
  }
  const angles = plan.angles || Array.from({ length: 16 }, (_, i) => (i / 16) * TAU);
  for (const a of angles) {
    for (const dv of plan.dvs || [0.01, 0.025, 0.05, 0.1, 0.2, 0.4, 0.8, 1.5]) { tryIt(a, dv); yield; }
  }
  const aw = plan.angles ? 0.06 : TAU / 16;
  for (let round = 0; round < 3; round++) {
    const w = aw / (round + 1);
    const a0 = bestA;
    yield* golden((a) => tryIt(a, bestDv), a0 - w, a0 + w, 9);
    const lv = Math.log(bestDv), a1 = bestA;
    yield* golden((l) => tryIt(a1, Math.exp(l)), lv - 0.7 / (round + 1), lv + 0.7 / (round + 1), 9);
  }
  plan.angle = ((bestA % TAU) + TAU) % TAU;
  plan.dv = bestDv;
  plan.thrust = best.acc || THRUST * FINE;
  plan.dur = best.dur || bestDv / plan.thrust;
  plan.tMid = plan.tStart + plan.dur / 2;
  plan.score = best.score; plan.ca = best.ca; plan.tArrive = best.tArrive; plan.impact = !!best.impact;
  plan.ok = best.score < 1e3 + (plan.timeW || 0) * 1e5;
  plan.refined = true;
}

export class Planner {
  /** worker: a Worker running planner-worker.js (browser); without one, plans are refined in-thread. */
  constructor(worker = null) {
    this.target = null; this.trip = null; this.plan = null; this.gen = null; this.status = '';
    this.worker = worker; this.jobId = 0; this.pending = null;
    if (worker) worker.addEventListener('message', (e) => this.onResult(e.data));
  }

  setTarget(t, trip = null) {
    this.target = t; this.trip = trip; this.plan = null; this.gen = null; this.pending = null; this.status = '';
  }

  /** The plan, only if it is complete and usable. */
  get ready() { return this.status === 'ready' && this.plan ? this.plan : null; }

  onResult(d) {
    if (d.type) return; // estimate results are handled elsewhere
    const { id, plan } = d;
    if (!this.pending || id !== this.pending.id) return; // superseded
    const kind = this.pending.kind;
    this.pending = null;
    this.plan = plan;
    this.status = plan ? (plan.ok ? 'ready' : 'nogood') : kind === 'depart' ? 'orbit' : 'nogood';
  }

  /** Ask the worker for a plan from the ship's current coast. */
  request(sim, kind, lead) {
    const tr = sim.traj, i = tr.head;
    const id = ++this.jobId;
    this.pending = { id, kind, version: sim.version, target: this.target };
    this.worker.postMessage({
      id, kind, lead, trip: { ...this.trip }, body: sim.body, version: sim.version, simT: sim.t,
      node: { t: tr.t[i], x: tr.x[i], y: tr.y[i], vx: tr.vx[i], vy: tr.vy[i] },
    });
  }

  /** Keep a plan of this kind current: request (worker) or refine (in-thread). */
  job(sim, kind, budgetMs, lead) {
    const p = this.plan;
    const stale = !p || p.kind !== kind || p.version !== sim.version || sim.t > p.tMid + p.dur / 2
      || (kind === 'depart' && p.from !== sim.body) || (kind !== 'depart' && sim.t > p.tStart - 0.5 && !p.refined);
    const busy = kind === 'depart' ? 'planning' : kind === 'aim' ? 'aiming' : 'correcting';
    if (this.worker) {
      const pend = this.pending;
      const pendStale = pend && (pend.version !== sim.version || pend.target !== this.target || pend.kind !== kind);
      if ((stale && !pend) || pendStale) { this.plan = null; this.status = busy; this.request(sim, kind, lead); }
      return;
    }
    if (stale) {
      this.plan = makePlan(sim, kind, this.trip, lead);
      this.gen = this.plan ? refinePlan(sim, this.plan) : null;
      this.status = this.plan ? busy : kind === 'depart' ? 'orbit' : 'nogood';
    }
    if (this.gen) {
      const t0 = performance.now();
      while (performance.now() - t0 < budgetMs) {
        if (this.gen.next().done) { this.gen = null; this.status = this.plan.ok ? 'ready' : 'nogood'; break; }
      }
    }
  }

  /** A planned burn has been flown: move the trip to its next stage. */
  burnDone(plan) {
    const trip = this.trip;
    if (!trip) return;
    if (plan.kind === 'depart') trip.stage = trip.mode === 'bielliptic' || trip.mode === 'assist' ? 'aim' : 'cruise';
    else if (plan.kind === 'aim') trip.stage = 'cruise';
    this.plan = null; this.status = '';
  }

  /** Recompute/refine as needed; spends at most budgetMs per call. */
  update(sim, thrusting, budgetMs = 5, pred = null, lead = 30) {
    const T = this.target, trip = this.trip;
    if (T == null || !sim.alive || !trip) { this.plan = null; this.gen = null; this.status = ''; return; }
    if (thrusting && this.plan) return; // keep showing the plan while flying it
    if (sim.body === T && sim.captured) { this.plan = null; this.gen = null; this.status = 'captured'; return; }
    if (trip.stage === 'torch') { this.plan = null; this.gen = null; this.status = 'torch'; return; }

    // Arriving at the target (inside it, or a predicted encounter): plan the capture burn.
    if (trip.stage !== 'depart') {
      const visit = sim.body === T ? pred && pred.here : pred && pred.encounters.find((e) => e.planet === T);
      const P = PLANETS[T];
      const goodVisit = visit && !visit.impact && visit.ca.pe >= 0.4 * P.radius && visit.ca.pe <= 0.6 * P.hill;
      // a slingshot must swing past its flyby planet before arriving: if the
      // predicted path does that and then reaches the target well, just coast
      if (trip.mode === 'assist' && !trip.flybyDone && sim.body !== T) {
        const viaFlyby = goodVisit && pred.encounters.some((e) => e.planet === trip.flyby && e.seg < visit.seg);
        if (viaFlyby) { this.plan = null; this.gen = null; this.status = 'oncourse'; return; }
      } else if (sim.body === T || goodVisit) {
        const p = this.plan;
        const stale = !p || p.kind !== 'capture' || p.version !== sim.version || sim.t > p.tMid + p.dur / 2;
        if (stale) {
          this.gen = null;
          this.plan = planCapture(sim, T, visit);
          // inside the well on a doomed or loose orbit: rescue burn now
          if (sim.body === T && (!this.plan || !this.plan.ok) && (!visit || visit.impact || (pred.fate && pred.fate.kind !== 'holds'))) {
            const r = planRescue(sim, T);
            if (r.ok) this.plan = r;
          }
          this.status = this.plan ? (this.plan.ok ? 'ready' : 'nogood') : visit && visit.impact ? 'impact' : 'nocapture';
        }
        return;
      }
    }
    if (trip.stage === 'depart') {
      if (sim.body !== trip.origin || !sim.captured) { this.plan = null; this.gen = null; this.status = 'orbit'; return; }
      this.job(sim, 'depart', budgetMs, lead);
      return;
    }
    if (sim.body >= 0) { // still leaving the origin, or swinging past the flyby planet
      this.plan = null; this.gen = null;
      this.status = sim.body === trip.flyby ? 'flyby' : 'departing';
      return;
    }
    if (trip.stage === 'aim' && trip.mode === 'assist') {
      if (trip.flybyDone) trip.stage = 'cruise'; // flyby already happened: just correct from here
      else {
        // the aiming burn must happen well before reaching the flyby planet
        const fe = pred && pred.encounters.find((e) => e.planet === trip.flyby);
        if (fe) lead = Math.min(lead, Math.max(5, 0.25 * (fe.t - sim.t)));
      }
    }
    this.job(sim, trip.stage === 'aim' ? 'aim' : 'correct', budgetMs, lead);
  }
}

/** Build the first guess for a plan of this kind (shared by the worker). */
export function makePlan(sim, kind, trip, lead) {
  if (kind === 'depart') return initialDeparture(sim, trip);
  if (kind === 'aim') return initialAim(sim, trip, lead);
  return initialCorrection(sim, trip, lead);
}
export function refinePlan(sim, plan) {
  return plan.kind === 'depart' ? refine(sim, plan) : refineCorrection(sim, plan);
}

/**
 * Burn arc in WORLD coordinates, on the ship's actual predicted path (so it
 * sits on the drawn path line). For burns beyond the cached path (departures
 * many orbits ahead) the osculating ellipse around the frame body is placed at
 * the body's current position instead.
 */
export function burnArc(sim, plan, count = 40) {
  const P = bodyOf(plan.frame);
  const t0 = plan.tMid - plan.dur / 2, t1 = plan.tMid + plan.dur / 2;
  const tr = sim.traj;
  const pts = [];
  const inCache = t1 <= tr.endT;
  const r = new Float64Array(4);
  sim.world(r);
  bodyState(plan.frame, sim.t, ps);
  const ox = ps[0], oy = ps[1];
  for (let k = 0; k < 4; k++) r[k] -= ps[k];
  for (let i = 0; i <= count; i++) {
    const t = Math.max(sim.t, t0 + ((t1 - t0) * i) / count);
    if (inCache) {
      tr.stateAt(t, tmp);
      pts.push(tmp[0], tmp[1]);
    } else {
      kepler(r[0], r[1], r[2], r[3], P.mu, t - sim.t, tmp);
      pts.push(ox + tmp[0], oy + tmp[1]);
    }
  }
  return pts;
}

/** Heliocentric angle where the target must be at the burn, shifted to time t. */
export function bracketAngle(plan, t) {
  planetState(plan.target, plan.tMid, ps);
  const aT = Math.atan2(ps[1], ps[0]);
  planetState(plan.from, plan.tMid, ps);
  const aP = Math.atan2(ps[1], ps[0]);
  planetState(plan.from, t, ps);
  return Math.atan2(ps[1], ps[0]) + (aT - aP);
}
