// Background planning. Rebuilds the ship's coast from a trajectory node
// (deterministically identical to the game's) and runs the shooting
// refinement off the main thread, in slices so a newer request can cancel it.
// A separate instance flies whole trips headlessly ("estimate") to measure
// each transfer mode's fuel.

import { Sim } from './nbody.js';
import { makePlan, refinePlan } from './planner.js';
import { dryRun } from './autopilot.js';
import { pickFlyby } from './planner.js';

/** Slingshot: try flyby planets in order of promise until one works. */
function estimateAssist(m) {
  const skip = [];
  let last = null;
  for (let k = 0; k < 3; k++) {
    const flyby = pickFlyby(m.body, m.target, skip);
    if (flyby == null) break;
    const r = dryRun(m.node, m.body, m.target, 'assist', { simT: m.simT, flyby, maxWallMs: 30000 });
    if (r.ok) return r;
    last = r; skip.push(flyby);
  }
  return last || { ok: false, reason: 'no flyby planet' };
}

let job = null;

self.onmessage = (e) => {
  const m = e.data;
  if (m.kind === 'estimate') {
    // fly every requested mode in turn, reporting each as it finishes
    for (const mode of m.modes) {
      let r;
      try { r = mode === 'assist' ? estimateAssist(m) : dryRun(m.node, m.body, m.target, mode, { simT: m.simT }); }
      catch (err) { r = { ok: false, reason: 'error: ' + err.message }; }
      self.postMessage({ type: 'estimate', id: m.id, mode, ...r });
    }
    return;
  }
  const { id, kind, lead, simT, trip, body, version, node } = m;
  const sim = new Sim();
  sim.t = node.t; sim.x = node.x; sim.y = node.y; sim.vx = node.vx; sim.vy = node.vy;
  sim.body = body; sim.captured = true;
  sim.traj.reset(node.t, node.x, node.y, node.vx, node.vy);
  // schedule relative to the game's clock, not the (slightly earlier) node
  if (simT > node.t) sim.step(simT - node.t, 0);
  sim.version = version;
  const plan = makePlan(sim, kind, trip, lead);
  if (!plan) { self.postMessage({ id, plan: null }); job = null; return; }
  plan.version = version;
  job = { id, plan, gen: refinePlan(sim, plan) };
  setTimeout(run, 0);
};

function run() {
  if (!job) return;
  const cur = job;
  const t0 = performance.now();
  while (performance.now() - t0 < 25) {
    if (cur.gen.next().done) {
      if (job === cur) { self.postMessage({ id: cur.id, plan: cur.plan }); job = null; }
      return;
    }
  }
  if (job === cur) setTimeout(run, 0); // yield so a newer request can replace this one
}
