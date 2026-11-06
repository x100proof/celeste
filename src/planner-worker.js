// Background departure planning: rebuilds the ship's coast from a trajectory
// node (deterministically identical to the game's) and runs the shooting
// refinement off the main thread, in slices so a newer request can cancel it.

import { Sim } from './nbody.js';
import { initialPlan, refine, initialCorrection, refineCorrection } from './planner.js';

let job = null;

self.onmessage = (e) => {
  const { id, kind, lead, simT, target, body, version, node } = e.data;
  const sim = new Sim();
  sim.t = node.t; sim.x = node.x; sim.y = node.y; sim.vx = node.vx; sim.vy = node.vy;
  sim.body = body; sim.captured = true;
  sim.traj.reset(node.t, node.x, node.y, node.vx, node.vy);
  sim.version = version;
  let plan, gen;
  if (kind === 'correct') {
    // schedule the correction relative to the game's clock, not the (earlier) node
    plan = initialCorrection(sim, target, simT - node.t + lead);
    gen = refineCorrection(sim, plan);
  } else {
    plan = initialPlan(sim, target);
    gen = plan && refine(sim, plan);
  }
  if (!plan) { self.postMessage({ id, plan: null }); job = null; return; }
  job = { id, plan, gen };
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
