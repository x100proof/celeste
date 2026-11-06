// Trajectory prediction for the n-body ship. The future path is the ship's own
// cached Trajectory (so the ship follows it exactly). Here it is extended as
// needed and split into segments by reference body (whose Hill sphere the
// ship is in) for display:
//   current body  -> drawn around the planet's current position (cyan)
//   Sun           -> heliocentric (magenta)
//   other planet  -> drawn around the planet where the ship meets it (amber)

import { elements, timeToNu, posAtNu, TAU } from './physics.js';
import { PLANETS, GM_SUN, bodyState } from './system.js';
import { refBody } from './nbody.js';

const TMAX = 4000;        // horizon around a planet (sim seconds)
const TMAX_SUN = 8000;    // horizon in solar orbit: look many laps ahead for encounters
const SUN_LAPS = 40;
const PLANET_LAPS = 3;    // an orbit counts as captured if it holds this many laps      // safety cap for tiny orbits (only the first lap is drawn)
const MAX_SEGMENTS = 12;   // searched; main.js draws only a few of them
const MAX_DRAW = 1100;     // points per drawn segment
const EXTEND_BUDGET = 80000;
const pb = new Float64Array(4);
const cur = new Float64Array(4);

function scan(sim, tmaxSun) {
  const tr = sim.traj;
  const segs = [];
  let seg = null;
  let reason = 'more';
  const visit = (t, x, y, vx, vy, crashHere) => {
    const b = refBody(x, y, t);
    if (!seg || b !== seg.body) {
      if (segs.length >= MAX_SEGMENTS) { reason = 'segments'; return false; }
      seg = { body: b, t0: t, t: [], rx: [], ry: [], x: [], y: [], vx: [], vy: [], sweep: 0, lastAng: null, crash: false, drawN: 0 };
      segs.push(seg);
    }
    bodyState(b, t, pb);
    const rx = x - pb[0], ry = y - pb[1];
    const ang = Math.atan2(ry, rx);
    if (seg.lastAng !== null) {
      let d = ang - seg.lastAng;
      if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU;
      seg.sweep += Math.abs(d);
    }
    seg.lastAng = ang;
    seg.t.push(t); seg.rx.push(rx); seg.ry.push(ry); seg.x.push(x); seg.y.push(y); seg.vx.push(vx); seg.vy.push(vy);
    if (crashHere) { seg.crash = true; reason = 'crash'; return false; }
    if (seg.body < 0) {
      // Keep following the solar orbit for several laps so encounters on later
      // laps are found now; remember where the first lap ends for drawing.
      if (!seg.drawN && seg.sweep >= TAU * 0.97) seg.drawN = seg.t.length;
      if (seg.sweep >= TAU * SUN_LAPS) { reason = 'closed'; return false; }
      if (t - sim.t >= tmaxSun) { reason = 'horizon'; return false; }
    } else {
      // Follow a planet orbit for a few laps: whether it HOLDS (no escape, no
      // impact) is what "captured" means. Only the first lap is drawn.
      if (!seg.drawN && seg.sweep >= TAU * 0.97) seg.drawN = seg.t.length;
      if (seg.sweep >= TAU * PLANET_LAPS) { seg.holds = true; reason = 'closed'; return false; }
      if (t - sim.t >= TMAX) { reason = 'horizon'; return false; }
    }
    return true;
  };
  sim.world(cur);
  if (!visit(sim.t, cur[0], cur[1], cur[2], cur[3], false)) return { segs, reason };
  const start = tr.find(sim.t) + 1;
  for (let i = start; i < tr.length; i++) {
    const crashHere = !!tr.crash && i === tr.crash.index;
    if (!visit(tr.t[i], tr.x[i], tr.y[i], tr.vx[i], tr.vy[i], crashHere)) return { segs, reason };
  }
  return { segs, reason: 'more' };
}

/** Make sure the cached path reaches a natural end, then scan it. */
function scanComplete(sim, tmaxSun) {
  let res = scan(sim, tmaxSun);
  let budget = EXTEND_BUDGET;
  while (res.reason === 'more' && budget > 0) {
    const n = Math.min(budget, 1500);
    for (let k = 0; k < n; k++) if (!sim.traj.extendStep()) break;
    budget -= n;
    res = scan(sim, tmaxSun);
    if (sim.traj.crash && res.reason === 'more') res = scan(sim, tmaxSun);
  }
  return res;
}

/** The segment's ACTUAL path in space (heliocentric), for the continuous path line. */
function downsampleAbs(seg, maxPts, full = false) {
  const n = full ? seg.t.length : seg.drawN || seg.t.length;
  const stride = Math.max(1, Math.ceil(n / maxPts));
  const pts = [], ts = [];
  for (let i = 0; i < n; i += stride) { pts.push(seg.x[i], seg.y[i]); ts.push(seg.t[i]); }
  if ((n - 1) % stride !== 0) { pts.push(seg.x[n - 1], seg.y[n - 1]); ts.push(seg.t[n - 1]); }
  return { pts, ts, stride, truncated: n < seg.t.length, nodes: seg.t.length };
}

function downsample(seg, ox, oy) {
  const n = seg.drawN || seg.t.length;
  const stride = Math.max(1, Math.ceil(n / MAX_DRAW));
  const pts = [];
  for (let i = 0; i < n; i += stride) pts.push(ox + seg.rx[i], oy + seg.ry[i]);
  if ((n - 1) % stride !== 0) pts.push(ox + seg.rx[n - 1], oy + seg.ry[n - 1]);
  return pts;
}

/**
 * Predict the ship's future path.
 * Returns { segments, encounter, apo, helio }.
 */
export function predict(sim, quick = false) {
  // While the engine fires the path is rebuilt every frame, so look less far ahead.
  const { segs } = scanComplete(sim, quick ? 2500 : TMAX_SUN);
  const segments = [];
  let encounter = null, apo = null, helio = null;
  const encounters = [];
  let here = null; // closest approach within the planet we are in now (if any)
  let prevSunSweep = 0; // laps completed around the Sun before each encounter

  segs.forEach((s, idx) => {
    const kind = idx === 0 ? 'current' : s.body < 0 ? 'transfer' : 'encounter';
    // anchor: where the frame body is drawn
    let ox = 0, oy = 0;
    if (s.body >= 0) {
      bodyState(s.body, idx === 0 ? sim.t : s.t0, pb);
      ox = pb[0]; oy = pb[1];
    }
    // drawn end: a first lap that closes is drawn closed even if the orbit decays later
    const end = s.drawN ? 'closed' : s.crash ? 'impact' : idx < segs.length - 1 ? 'leaves' : 'open';
    const seg = { body: s.body, kind, end, points: downsample(s, ox, oy), abs: downsampleAbs(s, 900), absFull: downsampleAbs(s, 1500, true), t0: s.t0, tEnd: s.t[s.t.length - 1], ox, oy };
    segments.push(seg);

    if (s.body < 0) prevSunSweep += s.sweep;
    if (s.body >= 0) {
      const P = PLANETS[s.body];
      let best = Infinity, bi = 0;
      for (let i = 0; i < s.t.length; i++) {
        const d = Math.hypot(s.rx[i], s.ry[i]);
        if (d < best) { best = d; bi = i; }
      }
      bodyState(s.body, s.t[bi], pb);
      const rvx = s.vx[bi] - pb[2], rvy = s.vy[bi] - pb[3];
      const energy = (rvx * rvx + rvy * rvy) / 2 - P.mu / best;
      const e = {
        seg: idx, planet: s.body, t: s.t0, px: ox, py: oy, lap: Math.floor(prevSunSweep / TAU) + 1,
        ca: { x: ox + s.rx[bi], y: oy + s.ry[bi], alt: Math.max(0, best - P.radius), pe: s.crash ? -1 : best - P.radius, impact: s.crash, dt: s.t[bi] - sim.t },
        bound: energy < 0 && !s.crash,
        impact: s.crash,
      };
      if (idx === 0) here = e;
      else {
        encounters.push(e);
        if (!encounter) encounter = e;
      }
    }

    if (s.body < 0 && !helio) {
      // Osculating solar elements are distorted right at a Hill-sphere edge (the
      // planet still pulls hard there), so sample where every planet is >= 3 Hill radii away.
      let k = 0;
      for (; k < s.t.length - 1; k++) {
        let clear = true;
        for (let j = 0; j < PLANETS.length && clear; j++) {
          bodyState(j, s.t[k], pb);
          if (Math.hypot(s.x[k] - pb[0], s.y[k] - pb[1]) < 3 * PLANETS[j].hill) clear = false;
        }
        if (clear) break;
      }
      const el = elements(s.x[k], s.y[k], s.vx[k], s.vy[k], GM_SUN);
      helio = { rp: el.rp, ra: el.bound ? el.ra : Infinity, bound: el.bound, impact: s.crash };
      if (el.bound) {
        const r0 = Math.hypot(s.x[k], s.y[k]);
        const inward = r0 - el.rp > el.ra - r0;
        const nu = inward ? 0 : Math.PI;
        const p = posAtNu(el, nu);
        apo = { t: s.t[k] + timeToNu(el, nu), x: p[0], y: p[1], kind: inward ? 'PE' : 'AP' };
      }
    }
  });

  // Fate of the orbit we are in now (planet frames): holds for PLANET_LAPS laps,
  // or escapes / hits the surface after `laps` laps.
  const s0 = segs[0];
  let fate = null;
  if (s0 && s0.body >= 0) {
    fate = { laps: s0.sweep / TAU, kind: s0.holds ? 'holds' : s0.crash ? 'impact' : segs.length > 1 ? 'leaves' : 'open' };
  }
  return { segments, encounter, encounters, here, apo, helio, fate, holds: !!(fate && fate.kind === 'holds') };
}
