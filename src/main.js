import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

import { PLANETS, SUN, HOME, planetState, bodyState, bodyOf, THRUST, FINE, TURN_RATE } from './system.js';
import { Sim } from './nbody.js';
import { predict } from './predict.js';
import { fmtDate, fmtSpan, realDate } from './calendar.js';
import { burnArc, bracketAngle } from './planner.js';
import { Autopilot, MODES, MODE_NAMES, FUEL_SCALE, dirOffset, BRACH_THRUST, BRACH_THRUST_DEFAULT, setBrachThrust } from './autopilot.js';
import { Ribbon, circlePoints, FEATHER } from './ribbon.js';
import { createBackground, createSun, createPlanet, createGhostPlanet, createShip, Particles, createShockwave } from './visuals.js';

import * as dbg from './debug.js';

dbg.init();
THREE.ColorManagement.enabled = false;

// ------------------------------------------------------------------ renderer

const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.setClearColor(0x000000, 1);
renderer.autoClear = false;

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -100, 100);
const bg = createBackground();

// Render at the screen's full pixel density (up to 3x) so high-DPI phones are
// sharp; an adaptive cap (dprCap) steps the resolution down if the frame rate
// suffers and back up when there is headroom.
const DPR_MAX = Math.min(devicePixelRatio || 1, 3);
let dprCap = DPR_MAX;
let W = innerWidth, H = innerHeight, DPR = DPR_MAX;
const rt = new THREE.WebGLRenderTarget(W * DPR, H * DPR, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, rt);
const bgPass = new RenderPass(bg.scene, bg.cam);
const mainPass = new RenderPass(scene, camera);
mainPass.clear = false;
const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.85, 0.55, 0.18);
composer.addPass(bgPass);
composer.addPass(mainPass);
composer.addPass(bloom);

function resize() {
  W = innerWidth; H = innerHeight; DPR = Math.min(devicePixelRatio || 1, 3, dprCap);
  FEATHER.value = 1 / DPR;
  renderer.setPixelRatio(DPR);
  renderer.setSize(W, H, false);
  composer.setPixelRatio(DPR);
  composer.setSize(W, H);
}
addEventListener('resize', resize);
resize();

// ------------------------------------------------------------------ world objects

const sim = new Sim();

const LIME = [0.45, 1.0, 0.6];
const sun = createSun(SUN.radius, SUN.pole);
scene.add(sun.mesh);
scene.add(sun.group);

const planets = PLANETS.map((p) => {
  const vis = createPlanet(p);
  scene.add(vis.mesh);
  if (vis.ring) scene.add(vis.ring);
  const orbit = new Ribbon(361, { color: p.atmo, opacity: 0.32, halfPx: 3, corePx: 0.55, glow: 0.25 });
  orbit.set(circlePoints(0, 0, p.a, 360), true);
  orbit.mesh.renderOrder = 1;
  scene.add(orbit.mesh);
  const soi = new Ribbon(161, { color: p.atmo, opacity: 0.22, halfPx: 2.5, corePx: 0.5, glow: 0.1, dash: 7, duty: 0.45 });
  soi.set(circlePoints(0, 0, p.hill, 160), true);
  soi.mesh.renderOrder = 1;
  scene.add(soi.mesh);
  const ghost = createGhostPlanet(p);
  ghost.mesh.visible = false;
  scene.add(ghost.mesh);
  const encGhost = createGhostPlanet(p);
  encGhost.mesh.visible = false;
  scene.add(encGhost.mesh);
  const encSoi = new Ribbon(161, { color: [1.0, 0.76, 0.35], opacity: 0.3, halfPx: 2.5, corePx: 0.5, glow: 0.1, dash: 7, duty: 0.45 });
  encSoi.set(circlePoints(0, 0, p.hill, 160), true);
  encSoi.visible = false;
  scene.add(encSoi.mesh);
  const ring = new Ribbon(97, { color: LIME, opacity: 0.9, halfPx: 3.5, corePx: 0.9, glow: 0.45, dash: 9, duty: 0.55 });
  ring.set(circlePoints(0, 0, 1, 96), true);
  ring.visible = false;
  ring.mesh.renderOrder = 7;
  scene.add(ring.mesh);
  return { p, vis, orbit, soi, ghost, encGhost, encSoi, ring };
});

// Orbits (relative to the body being orbited) are all solid neon purple; the
// ship's ACTUAL path through space is one continuous blue line (pathRibbon).
const ORBIT_STYLE = { color: [0.82, 0.36, 1.0], opacity: 0.75, halfPx: 4, corePx: 1.0, glow: 0.45, dash: 0 }; // neon purple, like the blue path
const SEG_STYLE = { current: ORBIT_STYLE, transfer: ORBIT_STYLE, encounter: ORBIT_STYLE };
const segRibbons = [0, 1, 2, 3].map(() => {
  const r = new Ribbon(1200, SEG_STYLE.current);
  r.mesh.renderOrder = 3;
  scene.add(r.mesh);
  return r;
});

const pathRibbon = new Ribbon(4000, { color: [0.35, 0.95, 1.0], opacity: 0.85, halfPx: 4, corePx: 1.0, glow: 0.45 });
pathRibbon.mesh.renderOrder = 4;
scene.add(pathRibbon.mesh);

function makeMarker(color) {
  const r = new Ribbon(6, { color, opacity: 0.95, halfPx: 3.5, corePx: 0.9, glow: 0.4 });
  r.set([1, 0, 0, 1, -1, 0, 0, -1], true);
  r.mesh.renderOrder = 7;
  r.visible = false;
  scene.add(r.mesh);
  return r;
}
const caMarker = makeMarker([1.0, 0.76, 0.32]);
const apMarker = makeMarker([1.0, 0.38, 0.86]);
const burnMarker = makeMarker(LIME);

// easy-mode guides: burn arc on the parking orbit, window bracket on the target's orbit
const burnRibbon = new Ribbon(48, { color: LIME, opacity: 1, halfPx: 7, corePx: 2.6, glow: 0.6 });
burnRibbon.mesh.renderOrder = 8;
scene.add(burnRibbon.mesh);
const bracketArc = new Ribbon(40, { color: LIME, opacity: 0.95, halfPx: 6, corePx: 2.2, glow: 0.55 });
const bracketTickA = new Ribbon(2, { color: LIME, opacity: 0.95, halfPx: 4, corePx: 1.4, glow: 0.4 });
const bracketTickB = new Ribbon(2, { color: LIME, opacity: 0.95, halfPx: 4, corePx: 1.4, glow: 0.4 });
for (const r of [bracketArc, bracketTickA, bracketTickB]) { r.mesh.renderOrder = 8; scene.add(r.mesh); }
let plannerWorker = null;
try { plannerWorker = new Worker(new URL('./planner-worker.js', import.meta.url), { type: 'module' }); } catch (e) { plannerWorker = null; }
const ap = new Autopilot(sim, plannerWorker);
const planner = ap.planner; // the HUD, guides and camera read plan state from here
if (plannerWorker) plannerWorker.addEventListener('error', (e) => dbg.record('error', 'planner worker: ' + (e.message || 'error'), { file: e.filename, line: e.lineno }));
// prograde chevron shown next to the ship while a planned burn is near
const chevron = new Ribbon(3, { color: LIME, opacity: 1, halfPx: 4.5, corePx: 1.6, glow: 0.5 });
chevron.set([-0.6, 0.7, 0.3, 0, -0.6, -0.7], false);
chevron.mesh.renderOrder = 21;
chevron.visible = false;
scene.add(chevron.mesh);

const ship = createShip();
scene.add(ship.group);
const particles = new Particles(3200);
scene.add(particles.points);
const shock = createShockwave();
scene.add(shock.mesh);

// ------------------------------------------------------------------ labels

const labelLayer = document.getElementById('labels');
const labels = new Map();
function label(key, cls) {
  let el = labels.get(key);
  if (!el) {
    el = document.createElement('div');
    el.className = 'lbl ' + (cls || '');
    labelLayer.appendChild(el);
    labels.set(key, el);
  }
  el._used = true;
  return el;
}
function placeLabel(key, cls, text, wx, wy, dyPx) {
  const el = label(key, cls);
  if (el._text !== text) { el.textContent = text; el._text = text; }
  if (el._cls !== cls) { el.className = 'lbl ' + cls; el._cls = cls; }
  const [sx, sy] = worldToScreen(wx, wy);
  el.style.transform = `translate(${(sx).toFixed(1)}px, ${(sy + dyPx).toFixed(1)}px) translate(-50%, 0)`;
  el.style.display = sx < -200 || sx > W + 200 || sy < -200 || sy > H + 200 ? 'none' : '';
}
function sweepLabels() {
  for (const el of labels.values()) { if (!el._used) el.style.display = 'none'; el._used = false; }
}

// ------------------------------------------------------------------ camera

// mode 'cine': the cinematic director frames each phase; 'manual': the player panned/zoomed
const cam = { x: 0, y: 0, halfH: 70, target: 70, follow: true, mode: 'cine', track: null };
const camOff = { x: 0, y: 0 }; // cinematic framing centre, relative to the ship
// phase changes blend from the previous shot to the new one; within a phase the shot is tracked exactly
const camBlend = { phase: '', t: 1, fromX: 0, fromY: 0 };
const camSpring = { x: 0, vx: 0, y: 0, vy: 0, lh: Math.log(70), vlh: 0 };
const ZMIN = 6, ZMAX = 14000; // out to Saturn
const worldPerPx = () => (2 * cam.halfH) / H;
function worldToScreen(x, y) {
  const k = 1 / worldPerPx();
  return [W / 2 + (x - cam.x) * k, H / 2 - (y - cam.y) * k];
}
function screenToWorld(sx, sy) {
  const k = worldPerPx();
  return [cam.x + (sx - W / 2) * k, cam.y - (sy - H / 2) * k];
}
function zoomBy(f, sx, sy) {
  toManual();
  const nh = Math.min(ZMAX, Math.max(ZMIN, cam.halfH * f));
  if (!cam.follow && !cam.track && sx !== undefined) {
    const [wx, wy] = screenToWorld(sx, sy);
    const r = nh / cam.halfH;
    cam.x = wx + (cam.x - wx) * r;
    cam.y = wy + (cam.y - wy) * r;
  }
  cam.halfH = cam.target = nh;
}
function toManual() {
  if (cam.mode === 'cine') { cam.mode = 'manual'; cam.target = cam.halfH; }
  document.getElementById('b-center').classList.toggle('on', false);
}
function zoomStep(f) { toManual(); cam.target = Math.min(ZMAX, Math.max(ZMIN, cam.target * f)); }

// ------------------------------------------------------------------ input

const keys = new Set();
const held = { left: false, right: false, thrust: false };
let ghostsOn = false; // ghost planets are opt-in (G / button)
// Time rate is chosen by the autopilot's director (see directWarp). The player
// may nudge the cruise rate by up to two x2 steps either way, never during a
// burn or its approach.
let warp = 1;
let warpNudge = 0;
const warpEl = document.getElementById('warp');
function nudgeWarp(d) {
  warpNudge = Math.max(-2, Math.min(2, warpNudge + d));
  const f = Math.pow(2, warpNudge);
  toast(warpNudge === 0 ? 'Time: auto' : `Time: auto ${f >= 1 ? '×' + f : '÷' + 1 / f}`, 'burns always play at viewing speed', 'go');
}
function fmtWarp(w) { return w >= 10 ? Math.round(w) : w >= 1 ? w.toFixed(1).replace(/\.0$/, '') : w.toFixed(2).replace(/0$/, ''); }
// ---- pause: freezes game time (ship, planets, burns, autopilot); camera still works
let paused = false;
function setPaused(v) {
  paused = v;
  const b = document.getElementById('b-pause');
  b.classList.toggle('on', v);
  b.innerHTML = v
    ? '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M8.5 5.5v13M15.5 5.5v13" stroke-width="3"/></svg>';
  b.title = v ? 'Play (Space)' : 'Pause (Space)';
  b.setAttribute('aria-label', v ? 'Play' : 'Pause');
  dbg.record('event', v ? 'paused' : 'resumed', { t: sim.t });
  updateWarpLabel();
}
function updateWarpLabel() {
  if (paused) { warpEl.innerHTML = 'II<small>paused</small>'; warpEl.classList.remove('fast', 'slow'); return; }
  const f = Math.pow(2, warpNudge);
  warpEl.innerHTML = `${fmtWarp(warp)}×<small>${warpNudge === 0 ? 'auto' : f >= 1 ? 'auto ×' + f : 'auto ÷' + 1 / f}</small>`;
  warpEl.classList.toggle('fast', warp > 1.5);
  warpEl.classList.toggle('slow', warp < 0.99);
}
function setWarp() { /* legacy no-op: the director owns the time rate */ }
function setGhosts(v) {
  ghostsOn = v;
  document.getElementById('b-ghost').classList.toggle('on', v);
}
// Click-to-focus: the camera glides to a body (or the ship) and keeps it centred.
// cam.track = { kind: 'ship' } | { kind: 'body', i } (i = -1 for the Sun).
const trackOff = { x: 0, y: 0 };
function trackPos(tr) {
  if (tr.kind === 'ship') { sim.world(wst); return sim.alive ? [wst[0], wst[1]] : [deadAnchor.x, deadAnchor.y]; }
  bodyState(tr.i, sim.t, ps);
  return [ps[0], ps[1]];
}
function focusOn(tr) {
  toManual();
  cam.track = tr; cam.follow = false;
  const [x, y] = trackPos(tr);
  trackOff.x = cam.x - x; trackOff.y = cam.y - y; // glide in from the current view
  dbg.record('event', 'focus', tr);
}
function recenter() {
  cam.track = null;
  cam.follow = true; cam.mode = 'cine';
  sim.world(wst); camOff.x = cam.x - wst[0]; camOff.y = cam.y - wst[1]; // glide from where we are
  Object.assign(camSpring, { x: camOff.x, y: camOff.y, vx: 0, vy: 0, lh: Math.log(cam.halfH), vlh: 0 });
  camBlend.phase = '';
  document.getElementById('b-center').classList.add('on');
}
let selMode = 'hohmann';
function setTarget(t, quiet = false) {
  dbg.record('event', 'target', { target: t, mode: selMode, t: sim.t, body: sim.body });
  ap.setTarget(t, selMode);
  easyBurn = null;
  tripStartT = tripEndT = null;
  if (t != null && cam.mode !== 'cine') recenter(); // a new trip gets the cinematic camera back
  updateTargetButtons();
  requestEstimates(t);
  if (quiet) return;
  if (t != null) toast(`Autopilot: ${PLANETS[t].name}`, `${MODE_NAMES[selMode]} transfer · burns play in slow motion`, 'go');
  else toast('Autopilot off', 'pick a planet to fly there');
}
/** Change transfer mode: allowed until the trip's first burn. */
function setMode(m) {
  const trip = ap.trip;
  if (trip && trip.stage !== 'depart' && !(trip.stage === 'brach' && (!trip.brach || trip.brach.stage === 'wait'))) {
    toast('Already under way', 'pick the mode before departure', 'warn');
    return;
  }
  selMode = m;
  if (trip) {
    const est = estimates.get(m);
    ap.setTarget(trip.target, m, est && est.flyby);
    easyBurn = null;
    toast(MODE_NAMES[m], est && est.ok ? `estimated fuel ${est.fuel}` : 'planning…', 'go');
  }
  updateModeButtons();
}

// ---- fuel estimates: every mode is flown headlessly in a second worker
const estimates = new Map(); // mode -> { ok, fuel, time, flyby } | 'pending'
let estWorker = null, estId = 0;
function requestEstimates(t) {
  estimates.clear();
  if (estWorker) { estWorker.terminate(); estWorker = null; }
  if (t != null && sim.alive && sim.body >= 0) {
    try {
      estWorker = new Worker(new URL('./planner-worker.js', import.meta.url), { type: 'module' });
      const id = ++estId;
      estWorker.onmessage = (e) => {
        const d = e.data;
        if (d.type !== 'estimate' || d.id !== estId) return;
        estimates.set(d.mode, d);
        dbg.record('event', 'estimate', { mode: d.mode, ok: d.ok, fuel: d.fuel, time: d.time, reason: d.reason });
        updateModeButtons();
      };
      const tr = sim.traj, i = tr.head;
      // the selected mode first, so its number arrives soonest
      const modes = [selMode, ...MODES.filter((m) => m !== selMode)];
      for (const m of modes) estimates.set(m, 'pending');
      estWorker.postMessage({ kind: 'estimate', id, body: sim.body, target: t, modes, simT: sim.t, brachThrust: BRACH_THRUST,
        node: { t: tr.t[i], x: tr.x[i], y: tr.y[i], vx: tr.vx[i], vy: tr.vy[i] } });
    } catch (e) { dbg.record('warn', 'estimate worker unavailable', e); }
  }
  updateModeButtons();
}
function cycleTarget() {
  const order = [null, ...PLANETS.keys()].filter((i) => i === null || i !== sim.body);
  const k = order.indexOf(ap.target);
  setTarget(order[(k + 1) % order.length]);
}

// ---- hidden tuning panel (D): live sliders for camera framing, saved per browser
const TUNING_KEY = 'celeste.tuning';
const tuning = { transferZoom: 1.3, torchThrust: BRACH_THRUST_DEFAULT }; // zoom >1 = transfer shots further out; torch in u/s^2
try { Object.assign(tuning, JSON.parse(localStorage.getItem(TUNING_KEY) || '{}')); } catch (e) { /* no storage: defaults */ }
if (!(tuning.transferZoom >= 0.5 && tuning.transferZoom <= 4)) tuning.transferZoom = 1.3;
if (!(tuning.torchThrust >= 1 && tuning.torchThrust <= 40)) tuning.torchThrust = BRACH_THRUST_DEFAULT;
const tunePanel = document.getElementById('tune');
const tuneZoom = document.getElementById('tune-zoom');
const tuneZoomVal = document.getElementById('tune-zoom-val');
// the slider is logarithmic: 0 = 0.5x, 1000 = 4x
const zoomToSlider = (z) => Math.round((1000 * Math.log(z / 0.5)) / Math.log(8));
const sliderToZoom = (v) => 0.5 * Math.pow(8, v / 1000);
// torch slider, also logarithmic: 0 = 1 u/s^2, 1000 = 40 u/s^2
const tuneTorch = document.getElementById('tune-torch');
const tuneTorchVal = document.getElementById('tune-torch-val');
const tuneTorchNote = document.getElementById('tune-torch-note');
const torchToSlider = (a) => Math.round((1000 * Math.log(a)) / Math.log(40));
const sliderToTorch = (v) => Math.pow(40, v / 1000);
/** The torch is lit (or flipping) on a trip: thrust changes wait until it is done. */
function torchUnderWay() {
  const tr = ap.trip;
  return !!(tr && tr.stage === 'brach' && tr.brach && tr.brach.stage !== 'wait');
}
function showTuning() {
  tuneZoom.value = zoomToSlider(tuning.transferZoom);
  tuneZoomVal.textContent = tuning.transferZoom.toFixed(2) + '×';
  tuneTorch.value = torchToSlider(tuning.torchThrust);
  tuneTorchVal.textContent = `${tuning.torchThrust.toFixed(1)} u/s²` + (tuning.torchThrust === BRACH_THRUST_DEFAULT ? ' (default)' : '');
  tuneTorchNote.classList.toggle('hidden', tuning.torchThrust === BRACH_THRUST);
}
/** Put the slider's torch thrust into effect, unless a torch burn is under way
 * (then the frame loop applies it once the trip ends). A trip still waiting
 * to depart is replanned, and the fuel estimates are flown again. */
function applyTorch() {
  if (tuning.torchThrust === BRACH_THRUST || torchUnderWay()) { showTuning(); return; }
  setBrachThrust(tuning.torchThrust);
  dbg.record('event', 'torch thrust', { a: tuning.torchThrust });
  const tr = ap.trip;
  if (tr) {
    if (selMode === 'brachistochrone') { ap.setTarget(tr.target, selMode); easyBurn = null; }
    requestEstimates(tr.target);
  }
  showTuning();
}
function saveTuning() { try { localStorage.setItem(TUNING_KEY, JSON.stringify(tuning)); } catch (e) { /* ignore */ } }
tuneZoom.addEventListener('input', () => {
  tuning.transferZoom = +sliderToZoom(+tuneZoom.value).toFixed(2);
  showTuning(); saveTuning();
});
tuneTorch.addEventListener('input', () => {
  tuning.torchThrust = +sliderToTorch(+tuneTorch.value).toFixed(1);
  showTuning(); saveTuning();
});
tuneTorch.addEventListener('change', applyTorch); // replan once, on release
document.getElementById('tune-reset').addEventListener('click', () => {
  tuning.transferZoom = 1.3; tuning.torchThrust = BRACH_THRUST_DEFAULT;
  saveTuning(); applyTorch(); showTuning();
});
applyTorch(); // a saved torch setting takes effect at load
showTuning();

const hint = document.getElementById('hint');
let hintTimer = setTimeout(() => hint.classList.add('fade'), 14000);

addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  keys.add(k.toLowerCase());
  if (k === ',' || k === '<') nudgeWarp(-1);
  else if (k === '.' || k === '>') nudgeWarp(1);
  else if (k === 'g' || k === 'G') setGhosts(!ghostsOn);
  else if (k === 'c' || k === 'C') recenter();
  else if (k === 't' || k === 'T') cycleTarget();
  else if (k === ' ' && !e.repeat) setPaused(!paused);
  else if ((k === 'd' || k === 'D') && !e.repeat) tunePanel.classList.toggle('hidden');

  else if (k === '+' || k === '=') zoomStep(1 / 1.6);
  else if (k === '-' || k === '_') zoomStep(1.6);
  if (k.startsWith('Arrow') || k === ' ') e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => { keys.clear(); held.left = held.right = held.thrust = false; });

const btn = (id, fn) => document.getElementById(id).addEventListener('click', fn);
btn('b-zin', () => zoomStep(1 / 1.6));
btn('b-zout', () => zoomStep(1.6));
btn('b-center', recenter);
btn('b-ghost', () => setGhosts(!ghostsOn));
// planet buttons: click to fly there, click again to cancel
const targetBar = document.getElementById('targets');
const targetBtns = PLANETS.map((p, i) => {
  const b = document.createElement('button');
  b.className = 'tgt';
  b.title = `Fly to ${p.name}`;
  const c = (k, a) => `rgba(${p[k].map((v) => Math.round(v * 255)).join(',')},${a})`;
  b.innerHTML = `${planetIcon(p, i)}<span class="nm">${p.name}</span>`;
  b.addEventListener('click', () => {
    if (b.disabled) return;
    setTarget(ap.target === i ? null : i);
  });
  targetBar.appendChild(b);
  return b;
});
/** Small vector icon for a planet button (gas giants get stripes / rings). */
function planetIcon(p, i) {
  const rgb = (k, a) => `rgba(${p[k].map((v) => Math.round(v * 255)).join(',')},${a})`;
  const grad = `<radialGradient id="pg${i}" cx="38%" cy="32%" r="72%"><stop offset="0" stop-color="${rgb('colB', 1)}"/><stop offset="0.8" stop-color="${rgb('colA', 1)}"/></radialGradient>`;
  // shared: a clip to the disk and a soft terminator (day/night) shading overlay
  const disk = (r = 14) => `<clipPath id="pc${i}"><circle cx="20" cy="20" r="${r}"/></clipPath>
      <radialGradient id="ps${i}" cx="38%" cy="34%" r="72%"><stop offset="0.5" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.55"/></radialGradient>`;
  const shade = (r = 14) => `<circle cx="20" cy="20" r="${r}" fill="url(#ps${i})"/>`;
  if (p.name === 'Mercury') {
    const craters = [[14, 14, 3.2], [24, 12, 2.2], [26, 21, 3.6], [16, 25, 2.6], [21, 29, 1.8], [11, 20, 1.6], [29, 27, 1.5], [20, 18, 1.3]]
      .map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#5f5a55" stroke="#b5aea5" stroke-width="0.7" opacity="0.85"/>`).join('');
    return `<svg class="orb svg" viewBox="0 0 40 40"><defs>${disk()}</defs>
      <circle cx="20" cy="20" r="14" fill="#8d867e"/><g clip-path="url(#pc${i})">
      <circle cx="14" cy="18" r="9" fill="#a39b91" opacity="0.5"/>${craters}</g>${shade()}</svg>`;
  }
  if (p.name === 'Venus') {
    const bands = [[13, 0.5], [17.5, 0.35], [22, 0.45], [26.5, 0.3]]
      .map(([y, o]) => `<path d="M2 ${y} C 10 ${y - 3}, 16 ${y + 3}, 24 ${y} S 34 ${y - 2}, 40 ${y}" fill="none" stroke="#c9a76b" stroke-width="2.6" opacity="${o}"/>`).join('');
    return `<svg class="orb svg" viewBox="0 0 40 40"><defs>${disk()}
      <radialGradient id="pv${i}" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#fbf1d6"/><stop offset="1" stop-color="#d9be86"/></radialGradient></defs>
      <circle cx="20" cy="20" r="15" fill="#f3dca0" opacity="0.25"/>
      <circle cx="20" cy="20" r="14" fill="url(#pv${i})"/><g clip-path="url(#pc${i})">${bands}</g>${shade()}</svg>`;
  }
  if (p.name === 'Earth') {
    return `<svg class="orb svg" viewBox="0 0 40 40"><defs>${disk()}
      <radialGradient id="pe${i}" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#3b7fd6"/><stop offset="1" stop-color="#0c2f73"/></radialGradient></defs>
      <circle cx="20" cy="20" r="15.4" fill="#6fb6ff" opacity="0.28"/>
      <circle cx="20" cy="20" r="14" fill="url(#pe${i})"/><g clip-path="url(#pc${i})">
        <path d="M9 13 q4 -2 6 1 q2 3 -1 5 q-1 2 1 4 q1 3 -1 6 q-2 1 -3 -2 q-1 -3 -3 -4 q-2 -3 1 -10z" fill="#4f8a3c"/>
        <path d="M21 10 q5 -1 7 2 q1 2 -1 3 q2 2 1 5 q0 4 -3 7 q-2 1 -2 -2 q0 -3 -2 -4 q-2 -1 -1 -4 q-2 -3 1 -7z" fill="#5b8f41"/>
        <path d="M24 18 q2 0 2 2 q-1 1 -2 0z" fill="#b39a62"/>
        <path d="M22 13 q2 -1 4 0 q-1 2 -3 2z" fill="#b39a62" opacity="0.9"/>
        <ellipse cx="20" cy="6.5" rx="9" ry="2.6" fill="#f2f6fb"/><ellipse cx="20" cy="33.8" rx="8" ry="2.4" fill="#f2f6fb"/>
        <path d="M5 16 q6 -3 11 0 M18 23 q6 -3 13 1 M8 28 q5 -2 9 0 M24 12 q4 -2 9 1" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" opacity="0.75"/>
      </g>${shade()}</svg>`;
  }
  if (p.name === 'Mars') {
    return `<svg class="orb svg" viewBox="0 0 40 40"><defs>${disk()}
      <radialGradient id="pm${i}" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#e0824f"/><stop offset="1" stop-color="#9a3d1f"/></radialGradient></defs>
      <circle cx="20" cy="20" r="15" fill="#f0a070" opacity="0.18"/>
      <circle cx="20" cy="20" r="14" fill="url(#pm${i})"/><g clip-path="url(#pc${i})">
        <path d="M8 19 q4 -3 8 -1 q3 2 6 0 q3 -2 6 1 q-2 3 -6 3 q-4 -1 -7 1 q-4 1 -7 -4z" fill="#6e2a14" opacity="0.55"/>
        <path d="M14 26 q4 -1 7 1 q-2 3 -6 2z" fill="#6e2a14" opacity="0.45"/>
        <path d="M11 16.5 q7 1 15 -1" fill="none" stroke="#5a2210" stroke-width="1.1" opacity="0.6"/>
        <ellipse cx="20" cy="6.8" rx="6" ry="2" fill="#f6efe8" opacity="0.95"/>
        <ellipse cx="20" cy="33.6" rx="4.5" ry="1.5" fill="#f6efe8" opacity="0.7"/>
      </g>${shade()}</svg>`;
  }
  if (p.name === 'Jupiter') {
    const bands = [[9, 2.2, '#b07a52'], [14, 3.2, '#9c6844'], [19.5, 1.6, '#c99a70'], [23, 3.4, '#a06a45'], [28, 2.2, '#b9875f']]
      .map(([y, h, col]) => `<rect x="0" y="${y}" width="40" height="${h}" fill="${col}" opacity="0.75"/>`).join('');
    return `<svg class="orb svg" viewBox="0 0 40 40"><defs>${grad}<clipPath id="pc${i}"><circle cx="20" cy="20" r="14"/></clipPath>
      <radialGradient id="ps${i}" cx="40%" cy="35%" r="70%"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.5"/></radialGradient></defs>
      <circle cx="20" cy="20" r="14" fill="#e9d6b8"/><g clip-path="url(#pc${i})">${bands}<ellipse cx="25" cy="25" rx="3.6" ry="2.2" fill="#c0573a"/></g>
      <circle cx="20" cy="20" r="14" fill="url(#ps${i})"/></svg>`;
  }
  if (p.name === 'Saturn') {
    const ring = (part) => `<ellipse cx="20" cy="20" rx="19" ry="6" fill="none" stroke="#e8d9b0" stroke-width="2.4" opacity="0.9" transform="rotate(-18 20 20)" clip-path="url(#${part}${i})"/>`;
    return `<svg class="orb svg" viewBox="0 0 40 40"><defs>${grad}
      <clipPath id="rb${i}"><rect x="0" y="0" width="40" height="20"/></clipPath>
      <clipPath id="rf${i}"><rect x="0" y="20" width="40" height="20"/></clipPath></defs>
      ${ring('rb')}<circle cx="20" cy="20" r="10.5" fill="url(#pg${i})"/>
      ${ring('rf')}</svg>`;
  }
  return `<span class="orb" style="background: radial-gradient(circle at 35% 30%, ${rgb('colB', 0.85)}, ${rgb('colA', 0.6)} 70%); box-shadow: 0 0 14px ${rgb('atmo', 0.35)}"></span>`;
}

const FUEL_SVG = '<svg class="fuel" viewBox="0 0 24 24"><path d="M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M3.5 21h13M8 7h4v4H8z"/><path d="M15 10h1.5a1.5 1.5 0 0 1 1.5 1.5V17a1.5 1.5 0 0 0 3 0V8.5L18 6"/></svg>';
const modeBar = document.getElementById('modes');
const modeBtns = new Map(MODES.map((m) => {
  const b = document.createElement('button');
  b.className = 'mode';
  b.innerHTML = `<span class="mn">${MODE_NAMES[m]}</span><span class="mf">${FUEL_SVG}<b>–</b></span>`;
  b.addEventListener('click', () => setMode(m));
  modeBar.appendChild(b);
  return [m, b];
}));
function updateModeButtons() {
  const trip = ap.trip;
  const locked = !!trip && trip.stage !== 'depart' && !(trip.stage === 'brach' && (!trip.brach || trip.brach.stage === 'wait'));
  for (const [m, b] of modeBtns) {
    const est = estimates.get(m);
    b.classList.toggle('on', (trip ? trip.mode : selMode) === m); // always shown; selected mode lit
    b.classList.toggle('locked', locked && trip.mode !== m);
    const v = b.querySelector('b');
    if (est === undefined) { v.textContent = '–'; b.title = `${MODE_NAMES[m]}: pick a planet to see the fuel`; }
    else if (est === 'pending') { v.textContent = '…'; b.title = `${MODE_NAMES[m]}: estimating fuel…`; }
    else if (est.ok) { v.textContent = est.fuel; b.title = `${MODE_NAMES[m]}: fuel ${est.fuel}${est.flyby != null && m === 'assist' ? ` · via ${PLANETS[est.flyby].name}` : ''}`; }
    else { v.textContent = '✕'; b.title = `${MODE_NAMES[m]}: no route found (${est.reason})`; }
  }
}

function updateTargetButtons() {
  targetBtns.forEach((b, i) => {
    const here = sim.alive && sim.body === i && sim.captured;
    b.disabled = here;
    b.classList.toggle('here', here);
    b.classList.toggle('on', ap.target === i);
  });
}
btn('b-pro', () => setHold(hold === 'pro' ? null : 'pro'));
btn('b-retro', () => setHold(hold === 'retro' ? null : 'retro'));
btn('b-pause', () => setPaused(!paused));
btn('b-wdown', () => nudgeWarp(-1));
btn('b-wup', () => nudgeWarp(1));

function holdButton(id, prop) {
  const el = document.getElementById(id);
  const on = (e) => { e.preventDefault(); held[prop] = true; el.classList.add('held'); el.setPointerCapture?.(e.pointerId); };
  const off = () => { held[prop] = false; el.classList.remove('held'); };
  el.addEventListener('pointerdown', on);
  el.addEventListener('pointerup', off);
  el.addEventListener('pointercancel', off);
  el.addEventListener('lostpointercapture', off);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}
holdButton('t-left', 'left');
holdButton('t-right', 'right');
holdButton('t-thrust', 'thrust');
let fineToggle = false;
document.getElementById('t-fine').addEventListener('click', (e) => {
  fineToggle = !fineToggle;
  e.currentTarget.classList.toggle('on', fineToggle);
});

// pan / pinch on the canvas
const pointers = new Map();
let gesture = null;
let tapStart = null;
/** What was clicked: the ship, a planet or the Sun (nearest within reach), else null. */
function pickFocus(sx, sy) {
  if (sim.alive) {
    sim.world(wst);
    const [x, y] = worldToScreen(wst[0], wst[1]);
    if (Math.hypot(x - sx, y - sy) < 28) return { kind: 'ship' };
  }
  const p = pickPlanet(sx, sy);
  if (p != null) return { kind: 'body', i: p };
  const [x, y] = worldToScreen(0, 0);
  if (Math.hypot(x - sx, y - sy) < Math.max(30, SUN.radius / worldPerPx() + 10)) return { kind: 'body', i: -1 };
  return null;
}
function pickPlanet(sx, sy) {
  let best = null, bestD = Infinity;
  const k = 1 / worldPerPx();
  PLANETS.forEach((p, i) => {
    planetState(i, sim.t, ps);
    const [px, py] = worldToScreen(ps[0], ps[1]);
    const d = Math.hypot(px - sx, py - sy);
    if (d < Math.max(26, p.radius * k + 12) && d < bestD) { bestD = d; best = i; }
  });
  return best;
}
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  gesture = null;
  tapStart = pointers.size === 1 ? { x: e.clientX, y: e.clientY, t: performance.now() } : null;
  canvas.classList.add('dragging');
});
canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const pts = [...pointers.values()];
  if (pts.length === 1) {
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (!gesture) gesture = { moved: 0 };
    gesture.moved += Math.abs(dx) + Math.abs(dy);
    if (gesture.moved > 4) {
      if (cam.follow) cam.follow = false;
      cam.track = null;
      toManual();
      const k = worldPerPx();
      cam.x -= dx * k; cam.y += dy * k;
    }
  } else if (pts.length >= 2) {
    tapStart = null;
    const other = pts.find((q) => q !== p);
    const mx0 = (p.x + other.x) / 2, my0 = (p.y + other.y) / 2;
    const d0 = Math.hypot(p.x - other.x, p.y - other.y);
    const mx1 = (e.clientX + other.x) / 2, my1 = (e.clientY + other.y) / 2;
    const d1 = Math.hypot(e.clientX - other.x, e.clientY - other.y);
    const k = worldPerPx();
    if (!cam.follow) { cam.x -= (mx1 - mx0) * k; cam.y += (my1 - my0) * k; }
    if (d0 > 10 && d1 > 10) zoomBy(d0 / d1, mx1, my1);
  }
  p.x = e.clientX; p.y = e.clientY;
});
const endPointer = (e) => {
  if (e.type === 'pointerup' && tapStart && pointers.size === 1 && (!gesture || gesture.moved <= 6) && performance.now() - tapStart.t < 450) {
    const hit = pickFocus(e.clientX, e.clientY);
    if (hit) focusOn(hit);
  }
  tapStart = null;
  pointers.delete(e.pointerId);
  if (!pointers.size) canvas.classList.remove('dragging');
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  zoomBy(Math.exp(dy * 0.0016), e.clientX, e.clientY);
}, { passive: false });
addEventListener('gesturestart', (e) => e.preventDefault());

// ------------------------------------------------------------------ HUD

const $ = (id) => document.getElementById(id);
const hud = { frame: $('r-frame'), status: $('r-status'), tgt: $('r-target'), clock: $('clock'), trip: $('r-trip') };
const toastEl = $('toast');
let toastTimer = 0;
function toast(big, small = '', cls = '') {
  toastEl.className = 'show ' + cls;
  toastEl.innerHTML = `<div class="big">${big}</div>${small ? `<div class="small">${small}</div>` : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3200);
}

// Every countdown and duration is shown in real time (days, hours, minutes)
// on the calendar's scale, never in raw game seconds.
function fmtTime(s) {
  return isFinite(s) ? fmtSpan(s) : '∞';
}
const fmtCount = fmtTime;
const fmtD = (d) => (!isFinite(d) ? '—' : Math.abs(d) >= 1000 ? d.toFixed(0) + ' u' : d.toFixed(1) + ' u');

let hudTick = 0;
function updateHud(pred) {
  hud.clock.textContent = fmtDate(sim.t);
  // trip length: running from the first ignition, then the last trip's total
  const tripT = tripStartT != null ? (ap.trip ? sim.t : tripEndT) - tripStartT : null;
  const tt = tripT != null ? fmtSpan(tripT) : '–';
  if (hud.trip._v !== tt) { hud.trip.textContent = tt; hud.trip._v = tt; }
  updateTargetHud();
  if (!sim.alive) { hud.status.textContent = 'Lost'; hud.status.className = ''; return; }
  const body = bodyOf(sim.body);
  const el = sim.elements();
  const rel = sim.rel(ps);
  hud.frame.textContent = body.name;
  const cur = pred.segments[0];
  const leaves = cur.end === 'leaves';
  let status, cls = '';
  if (sim.body >= 0) {
    const f = pred.fate;
    if (f && f.kind === 'impact' && f.laps < 0.97) { status = 'Impact course'; cls = 'escape'; }
    else if (sim.captured && f && f.kind === 'holds') { status = 'Captured'; cls = 'captured'; }
    else if (f && f.laps >= 0.97 && f.kind !== 'holds' && f.kind !== 'open') {
      status = `Unstable · ${f.kind === 'impact' ? 'hits surface' : 'escapes'} in ${Math.ceil(f.laps)} laps`; cls = 'escape';
    }
    else if (sim.captured) { status = 'Captured'; cls = 'captured'; }
    else if (leaves && rel[0] * rel[2] + rel[1] * rel[3] < 0) { status = `Approaching ${body.name}`; cls = 'escape'; }
    else if (leaves) { status = `Departing ${body.name}`; cls = 'escape'; }
    else status = 'Flyby';
  } else {
    status = cur.end === 'impact' ? 'Falling into Sun' : el.bound ? 'Solar orbit' : 'Solar escape';
    if (cur.end === 'impact') cls = 'escape';
  }
  hud.status.textContent = status;
  hud.status.className = cls;

}

// ---- debugging: find "funny angles" in the blue path and report them
let lastPathReport = -1e9;
const pathReportSeen = new Set();
/**
 * Look for sharp turns (and straight jumps) in the drawn path polyline that a
 * viewer would notice, and send the worst with full context to /api/log.
 */
function checkPath(pts, ts, segIdx, extraStride, wpp) {
  const now = performance.now();
  if (now - lastPathReport < 2000) return; // check at most every 2 s
  lastPathReport = now;
  const n = pts.length / 2;
  const lens = [];
  for (let i = 1; i < n; i++) lens.push(Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]));
  const med = lens.slice().sort((a, b) => a - b)[lens.length >> 1] || 0;
  const issues = [];
  for (let i = 1; i < n - 1; i++) {
    const ax = pts[2 * i] - pts[2 * i - 2], ay = pts[2 * i + 1] - pts[2 * i - 1];
    const bx = pts[2 * i + 2] - pts[2 * i], by = pts[2 * i + 3] - pts[2 * i + 1];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la < 1e-9 || lb < 1e-9) continue;
    const ang = Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)))) * 180 / Math.PI;
    const pxA = la / wpp, pxB = lb / wpp;
    const sharp = ang > 45 && Math.min(pxA, pxB) > 3;
    const jump = lb > 8 * med && pxB > 25;
    if (sharp || jump) issues.push({ i, ang, pxA, pxB, jump, lb });
  }
  if (!issues.length) return;
  issues.sort((a, b) => (b.jump - a.jump) || (b.ang - a.ang));
  const describe = (k) => {
    const g = pred.segments[segIdx[k]];
    return { seg: segIdx[k], kind: g && g.kind, body: g && g.body, end: g && g.end, truncated: g && g.abs.truncated, segStride: g && g.abs.stride, segNodes: g && g.abs.nodes };
  };
  const report = issues.slice(0, 4).map(({ i, ang, pxA, pxB, jump, lb }) => ({
    point: i, of: n, angleDeg: +ang.toFixed(1), lenPxBefore: +pxA.toFixed(1), lenPxAfter: +pxB.toFixed(1), jump, jumpLen: +lb.toFixed(1), medianLen: +med.toFixed(2),
    dtBefore: +(ts[i] - ts[i - 1]).toFixed(3), dtAfter: +(ts[i + 1] - ts[i]).toFixed(3), tAhead: +(ts[i] - sim.t).toFixed(1),
    prev: describe(i - 1), at: describe(i), next: describe(i + 1),
    crossesSegments: segIdx[i - 1] !== segIdx[i] || segIdx[i] !== segIdx[i + 1],
    xy: [+pts[2 * i].toFixed(1), +pts[2 * i + 1].toFixed(1)],
  }));
  const key = report.map((r) => `${r.jump}:${r.prev.seg}-${r.next.seg}:${r.at.kind}:${r.at.truncated}`).join('|');
  if (pathReportSeen.has(key)) return; // one report per distinct situation
  pathReportSeen.add(key);
  dbg.record('anomaly', `path: ${issues.length} sharp angle(s)/jump(s)`, {
    issues: report, count: issues.length, extraStride, wpp: +wpp.toFixed(3), warp: +warp.toFixed(2),
    segments: pred.segments.map((g, k) => `${k}:${g.kind}/${g.body}/${g.end}${g.abs.truncated ? '/truncated' : ''}`),
    ship: { body: sim.body, captured: sim.captured, t: +sim.t.toFixed(1) }, target: planner.target, planner: planner.status, burning: !!easyBurn,
  });
}

/** The encounter to show: the target's if there is one, else the first. */
function pickEncounter(pr) {
  if (!pr) return null;
  const t = planner.target;
  if (t != null && sim.body === t) return null; // at the target: the target box guides the capture
  return (t != null && pr.encounters.find((e) => e.planet === t)) || pr.encounter;
}

function updateTargetHud() {
  const t = planner.target;
  if (t == null) { hud.tgt.classList.add('hidden'); return; }
  const name = PLANETS[t].name;
  const p = planner.plan;
  let line;
  switch (planner.status) {
    case 'planning': line = 'computing transfer…'; break;
    case 'aiming': line = ap.trip && ap.trip.mode === 'bielliptic' ? 'planning the far-point burn…' : 'aiming the flyby…'; break;
    case 'oncourse': {
      const enc = pred && pred.encounters.find((e) => e.planet === t);
      line = `on course via ${PLANETS[ap.trip.flyby].name}<br>arrive T-${enc ? fmtTime(enc.t - sim.t) : '?'}`;
      break;
    }
    case 'flyby': line = `swinging past ${PLANETS[ap.trip.flyby].name}…`; break;
    case 'brach': {
      const b = ap.brach;
      line = !b ? '' : b.stage === 'wait' ? `lining up the torch burn<br>ignition in <span class="t">${fmtCount(b.ignite)}</span>`
        : b.stage === 'final' ? 'braking into orbit…'
        : !b.flipped ? `<span class="t">FULL THRUST</span> · flip in <span class="t">${fmtCount(b.flip)}</span><br>arrive T-${fmtTime(b.arrive)}`
        : `<span class="t">BRAKING</span> · arrive T-${fmtTime(b.arrive)}`;
      break;
    }
    case 'correcting': line = 'off course · computing<br>a mid-course correction…'; break;
    case 'ready': {
      const tS = p.tMid - p.dur / 2 - sim.t;
      const cap = p.kind === 'capture';
      line = easyBurn ? `<span class="t">BURNING</span> ${fmtCount(p.dur - easyBurn.elapsed)} left`
        : tS > 0 && p.kind === 'aim'
          ? `${ap.trip && ap.trip.mode === 'bielliptic' ? 'far-point burn' : 'flyby aim'} <span class="t">${fmtSpan(p.dur)}</span><br>in <span class="t">${fmtCount(tS)}</span>`
        : tS > 0 && p.kind === 'correct'
          ? `correction <span class="t">${fmtSpan(p.dur)}${p.thrust < THRUST ? ' fine' : ''}</span> (${p.dv.toFixed(2)} u/s)<br>in <span class="t">${fmtCount(tS)}</span> · then pass ${fmtD(p.ca)} up`
        : tS > 0 ? (cap
          ? `capture burn <span class="t">${fmtSpan(p.dur)}</span> retrograde<br>in <span class="t">${fmtCount(tS)}</span> · at ${fmtD(p.ca)} up`
          : `burn <span class="t">${fmtSpan(p.dur)}</span> in <span class="t">${fmtCount(tS)}</span><br>arrive ${fmtD(p.ca)} up · window every ${fmtTime(p.synodic)}`)
        : `<span class="t">BURN NOW</span>`;
      break;
    }
    case 'nogood': line = p && p.kind === 'capture' ? 'pass is too close or too fast<br>for a clean capture'
      : p && (p.kind === 'correct' || p.kind === 'aim') ? 'no good burn found yet<br>trying again shortly'
      : 'no clean transfer this window<br>waiting for the next one'; break;
    case 'departing': // leaving the gravity well after the departure burn
    case 'orbit': {
      const enc = pred && pred.encounters.find((e) => e.planet === t);
      line = enc ? `on course · arrive T-${fmtTime(enc.t - sim.t)}${enc.lap > 1 ? ` (lap ${enc.lap})` : ''}<br>closest ${fmtD(enc.ca.alt)}${enc.impact ? ' — IMPACT' : ''}`
        : pred && pred.segments[0].end === 'leaves' ? 'departing · course check after<br>leaving the gravity well'
        : pred && pred.fate && pred.fate.laps >= 0.97 ? 'this orbit won\'t hold — tighten it<br>(burn retrograde at periapsis)'
        : 'get into a closed orbit<br>to plan a transfer';
      break;
    }
    case 'helio': {
      const enc = pred && pred.encounters.find((e) => e.planet === t);
      line = enc ? `on course · arrive T-${fmtTime(enc.t - sim.t)}${enc.lap > 1 ? ` (lap ${enc.lap})` : ''}<br>closest ${fmtD(enc.ca.alt)}${enc.impact ? ' — IMPACT' : ''}`
        : 'in transit · checking the course';
      break;
    }
    case 'captured': line = `arrived · in orbit around ${name} ✓<br>pick the next planet`; break;
    case 'impact': line = `<span class="t">IMPACT COURSE</span><br>no safe capture from here`; break;
    case 'nocapture': line = 'approaching · working out<br>the capture burn'; break;
    default: line = '';
  }
  hud.tgt.classList.remove('hidden');
  hud.tgt.innerHTML = `AUTOPILOT → ${name.toUpperCase()} · ${MODE_NAMES[ap.trip ? ap.trip.mode : selMode].toUpperCase()}<br>${line}`;
}

// ------------------------------------------------------------------ game loop

let last = performance.now();
let realTime = 0;
let flamePower = 0;
let emitAcc = 0;
let deadTimer = 0;
const deadAnchor = { x: 0, y: 0, vx: 0, vy: 0 };
let shockAge = 1;
let lastTripFuel = 0;
// the trip clock: from the trip's first ignition to arrival (game seconds)
let tripStartT = null, tripEndT = null;
const fuelEl = document.getElementById('r-fuel');
function updateFuel() {
  const f = ap.trip ? Math.round(ap.fuel * FUEL_SCALE) : lastTripFuel;
  if (fuelEl._v !== f) { fuelEl.querySelector('b').textContent = f; fuelEl._v = f; }
  fuelEl.classList.toggle('burning', !!easyBurn || !!(ap.brach && ap.brach.stage !== 'wait'));
}
let hold = null;        // 'pro' | 'retro' | null — attitude hold

/**
 * Cinematic camera: decide what the shot should contain for the current phase,
 * then glide there. The framing centre is kept as an offset from the ship, so
 * the ship never drifts out of a close shot even when it moves fast.
 */
function cinematic(dt, shipX, shipY) {
  const aspect = W / H;
  let cx = shipX, cy = shipY, half = 40;
  const fit = (pts, minHalf, margin = 1.35) => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    cx = (x0 + x1) / 2; cy = (y0 + y1) / 2;
    half = Math.max(minHalf, Math.max((y1 - y0) / 2, (x1 - x0) / 2 / aspect) * margin);
  };
  const rp = planner.ready;
  const flyable = rp && (rp.kind !== 'depart' || sim.body === rp.from) ? rp : null;
  const burnPlan = easyBurn ? easyBurn.plan : flyable;
  const tS = burnPlan ? burnPlan.tMid - burnPlan.dur / 2 - sim.t : Infinity;
  const burnSoon = !!easyBurn || (burnPlan && tS > -0.5 && tS / Math.max(warp, 0.25) < 6);
  let phase;
  if (!sim.alive) { half = 45; phase = 'dead'; }
  else if (burnSoon) {
    phase = 'burn';
    // close-up for the burn: around the planet if it is a planet-frame burn, else on the ship
    if (burnPlan.frame >= 0) { // departure/capture: the ship and the planet, even before arrival
      planetState(burnPlan.frame, sim.t, ps);
      const r = Math.hypot(shipX - ps[0], shipY - ps[1]);
      const pts = [[ps[0], ps[1]], [shipX, shipY]];
      if (sim.body !== burnPlan.frame) { // still on the way in: include where we will meet the planet
        const e = pred && pred.encounters.find((x) => x.planet === burnPlan.frame);
        if (e) pts.push([e.px, e.py]);
      }
      fit(pts, Math.max(Math.min(r * 1.25, 400), PLANETS[burnPlan.frame].radius * 2.6), 1.6);
    } else half = 26;
  } else if (sim.body >= 0 && sim.captured) {
    phase = 'parked' + sim.body;
    // parked: the planet and the whole orbit
    const P = PLANETS[sim.body];
    planetState(sim.body, sim.t, ps);
    const el = sim.elements();
    cx = ps[0]; cy = ps[1];
    half = Math.max((el.bound ? el.ra : 30) * 1.5, P.radius * 3);
  } else if (sim.body >= 0) {
    phase = 'well' + sim.body;
    // leaving or arriving at a planet: keep both in shot
    planetState(sim.body, sim.t, ps);
    fit([[ps[0], ps[1]], [shipX, shipY]], PLANETS[sim.body].radius * 4, 1.5);
  } else {
    phase = 'cruise';
    // cruising: the ship and where it is going (or the Sun, without a target)
    const pts = [[shipX, shipY]];
    if (planner.target != null) {
      planetState(planner.target, sim.t, ps);
      pts.push([ps[0], ps[1]]);
      const e = pred && pred.encounters.find((x) => x.planet === planner.target);
      if (e) pts.push([e.px, e.py]);
    } else pts.push([0, 0]);
    fit(pts, 90, 1.3);
  }
  // Spring camera. Composition (the framing centre, as an offset from the
  // ship, so ship speed never causes lag) and zoom (log scale) both follow
  // critically damped springs: every change - a new shot, an object entering
  // the frame - becomes a smooth, eased pan or zoom. The ship is always kept
  // inside the central 80% of the view.
  const spring = (o, key, target, tau) => {
    const w = 2 / tau;
    const steps = Math.max(1, Math.ceil(dt / 0.02)), h = dt / steps;
    for (let i = 0; i < steps; i++) {
      o['v' + key] += (w * w * (target - o[key]) - 2 * w * o['v' + key]) * h;
      o[key] += o['v' + key] * h;
    }
  };
  if (phase !== camBlend.phase) camBlend.phase = phase;
  // transfer shots (burns, leaving/arriving, cruise) are widened by the tunable zoom
  if (phase === 'burn' || phase === 'cruise' || phase.startsWith('well')) half *= tuning.transferZoom;
  half = Math.min(ZMAX, Math.max(ZMIN, half));
  spring(camSpring, 'x', cx - shipX, 1.4);
  spring(camSpring, 'y', cy - shipY, 1.4);
  spring(camSpring, 'lh', Math.log(half), 1.8);
  cam.halfH = Math.exp(camSpring.lh);
  const maxX = 0.8 * cam.halfH * aspect, maxY = 0.8 * cam.halfH;
  camSpring.x = Math.max(-maxX, Math.min(maxX, camSpring.x));
  camSpring.y = Math.max(-maxY, Math.min(maxY, camSpring.y));
  camOff.x = camSpring.x; camOff.y = camSpring.y;
  cam.x = shipX + camOff.x; cam.y = shipY + camOff.y;
  cam.target = cam.halfH;
}

/** Time rate for watching a burn: even short burns last a few real seconds. */
function burnRate(p) { return Math.min(3, Math.max(0.25, p.dur / 3)); }

/**
 * The autopilot's time director. For the next event (a burn, or arrival at the
 * target), with tau game-seconds to go and a viewing rate r for the event:
 *     warp = r + nudge * tau / A
 * Game time then runs down so the event arrives after A*ln(1 + tau/(A*r)) real
 * seconds (about 25-30 s for anything up to ~2000 game-s), slowing smoothly and
 * reaching exactly the viewing rate at the event, so no burn is ever skipped.
 * Burns themselves play at their viewing rate. The nudge (,/.) scales only the
 * cruise term, between 1/4x and 4x.
 */
const DIRECTOR_A = 4;
function directWarp(dt, plan, tS) {
  const nudge = Math.pow(2, warpNudge);
  const profile = (tau, r) => r + (nudge * Math.max(0, tau)) / DIRECTOR_A;
  let target, cap = Infinity;
  const enc = planner.target != null && pred ? pred.encounters.find((e) => e.planet === planner.target) : null;
  const tr0 = ap.trip;
  const flybyEnc = tr0 && tr0.flyby != null && !tr0.flybyDone && sim.body !== tr0.flyby && pred
    ? pred.encounters.find((e) => e.planet === tr0.flyby && e.t > sim.t) : null;
  if (!sim.alive) target = 1;
  else if (easyBurn) target = cap = burnRate(easyBurn.plan);
  else if (ap.brach) {
    // brachistochrone: run down to ignition, to the flip, then to arrival,
    // each watched in real time
    const b = ap.brach;
    const tau = b.stage === 'wait' ? b.ignite : b.stage === 'final' ? 4 : !b.flipped ? b.flip : b.arrive;
    target = cap = profile(tau, 1);
  }
  else if (plan && tS > 0) target = cap = profile(tS, burnRate(plan));
  else if (planner.status === 'planning' || planner.status === 'correcting' || planner.status === 'aiming') target = Math.min(warp, 5);
  else if (flybyEnc) target = cap = profile(flybyEnc.t - sim.t, 2); // slingshot: watch the flyby
  else if (enc && enc.t > sim.t) target = cap = profile(enc.t - sim.t, 2);
  else if (planner.plan && planner.plan.tMid > sim.t) target = cap = profile(planner.plan.tMid - sim.t, 1); // waiting for a window
  else target = nudge; // idle (parked): real time, 1x unless nudged
  target = Math.min(3000, Math.max(0.25, target));
  // ease up gently after an event; the profile itself handles slowing down
  warp = target > warp ? Math.exp(THREE.MathUtils.lerp(Math.log(warp), Math.log(target), 1 - Math.exp(-dt * 2.5))) : target;
  if (warp > cap) warp = cap;
}

function setHold(m) {
  hold = m;
  document.getElementById('b-pro').classList.toggle('on', m === 'pro');
  document.getElementById('b-retro').classList.toggle('on', m === 'retro');
}   // engine held off after an automatic cut until thrust is released
let easyBurn = null;    // { plan, elapsed } while flying a planned burn
const wst = new Float64Array(4);
const ps = new Float64Array(4);
let pred = predict(sim);

function handleEvents(events) {
  for (const ev of events) {
    if (ev.type === 'ignition') {
      if (tripStartT == null && ap.trip) tripStartT = sim.t;
      dbg.record('event', 'ignition', { kind: ev.plan.kind, dur: ev.plan.dur, thrust: ev.plan.thrust, t: sim.t });
      toast('Ignition', ev.plan.kind === 'brach' ? 'full thrust · flip halfway' : `<span class="span">${fmtSpan(ev.plan.dur)}</span> planned burn`, 'go');
      updateModeButtons();
      continue;
    }
    if (ev.type === 'cut') {
      setHold(null);
      dbg.record('event', 'engine cut', { kind: ev.plan.kind, t: sim.t });
      toast('Engine cut', ev.plan.kind === 'brach' ? 'in orbit' : 'burn complete', 'go');
      continue;
    }
    if (ev.type === 'flip') {
      dbg.record('event', 'flip', { t: sim.t });
      toast('Flip', 'turning round to brake', 'go');
      continue;
    }
    dbg.record('event', ev.type, { body: ev.body, t: sim.t });
    const name = ev.body >= 0 ? PLANETS[ev.body].name : 'Sun';
    if (ev.type === 'enter') {
      toast(`${name} approach`, `inside ${name}'s gravity well`, 'enc');
    } else if (ev.type === 'escape') {
      toast(`Left ${name}`, 'now orbiting the Sun');
    } else if (ev.type === 'captured') {
      toast(`Captured`, `stable orbit around ${name}`);
    } else if (ev.type === 'crash') {
      explode(ev.body);
      toast(ev.body < 0 ? 'Burned up' : `Crashed`, ev.body < 0 ? 'fell into the Sun' : `impact on ${name}`, 'bad');
    }
  }
}

function explode(bodyIdx) {
  warp = 1;
  sim.world(wst);
  bodyState(bodyIdx, sim.t, ps);
  const bvx = ps[2], bvy = ps[3];
  Object.assign(deadAnchor, { x: wst[0], y: wst[1], vx: bvx, vy: bvy });
  const k = worldPerPx();
  for (let i = 0; i < 420; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = (20 + Math.pow(Math.random(), 0.6) * 170) * k;
    particles.emit(wst[0], wst[1], bvx + Math.cos(a) * s, bvy + Math.sin(a) * s, 0.8 + Math.random() * 1.6, 5 + Math.random() * 9, 1, 1.4);
  }
  shockAge = 0;
  shock.mesh.position.set(wst[0], wst[1], 0);
  shock.mesh.scale.setScalar(90 * k);
  deadTimer = 3.0;
}

const fin = (...v) => v.every(Number.isFinite);
let lastStatus = '', lastAnomalyAt = -1e9, lastSnapAt = 0, frameCount = 0, fpsFrames = 0, fpsAt = 0, fps = 0;
const timing = { physics: 0, predict: 0, planner: 0, scene: 0, render: 0 };
let prevTiming = null;

function debugTick(rawDtMs, workMs) {
  dbg.beat();
  frameCount++; fpsFrames++;
  const t = performance.now();
  if (t - fpsAt > 1000) {
    fps = Math.round((fpsFrames * 1000) / (t - fpsAt)); fpsFrames = 0; fpsAt = t;
    adaptResolution(fps);
  }
  if (rawDtMs > 1000 && frameCount > 5 && !document.hidden) dbg.record('stall', `frame gap ${Math.round(rawDtMs)} ms`, { prevFrameTiming: prevTiming });
  if (workMs > 200) dbg.record('anomaly', `slow frame ${Math.round(workMs)} ms`, { timing: { ...timing } });
  prevTiming = { ...timing, workMs: Math.round(workMs) };
  // ship / camera state must stay finite — a NaN makes the ship vanish
  const bad = !fin(sim.x, sim.y, sim.vx, sim.vy, sim.heading, sim.t) || !fin(cam.x, cam.y, cam.halfH);
  if (bad && t - lastAnomalyAt > 5000) { lastAnomalyAt = t; dbg.record('anomaly', 'non-finite state', debugState()); }
  if (planner.status !== lastStatus) {
    dbg.record('event', 'planner ' + (planner.status || 'idle'), { kind: planner.plan && planner.plan.kind, target: planner.target, t: sim.t });
    lastStatus = planner.status;
  }
  if (t - lastSnapAt > 500) { lastSnapAt = t; dbg.snapshot(debugState()); }
}

// Adaptive resolution: after a few slow seconds drop the pixel ratio a step;
// after sustained headroom raise it again (never above the screen's own).
let slowSecs = 0, fastSecs = 0;
function adaptResolution(f) {
  if (document.hidden || performance.now() < 4000) return; // let loading settle first
  if (f < 45) { slowSecs++; fastSecs = 0; } else if (f >= 58) { fastSecs++; slowSecs = 0; } else { slowSecs = fastSecs = 0; }
  if (slowSecs >= 3 && dprCap > 1) {
    dprCap = Math.max(1, +(Math.min(dprCap, DPR) - 0.5).toFixed(2)); slowSecs = 0;
    dbg.record('event', 'resolution down', { dprCap, fps: f }); resize();
  } else if (fastSecs >= 8 && dprCap < DPR_MAX) {
    dprCap = Math.min(DPR_MAX, dprCap + 0.5); fastSecs = 0;
    dbg.record('event', 'resolution up', { dprCap, fps: f }); resize();
  }
}

function debugState() {
  const [sx, sy] = worldToScreen(sim.x, sim.y);
  const p = planner.plan;
  return {
    t: sim.t, warp, fps, dpr: DPR, alive: sim.alive, body: sim.body, captured: sim.captured, version: sim.version,
    ship: { x: sim.x, y: sim.y, vx: sim.vx, vy: sim.vy, heading: sim.heading, visible: ship.group.visible, screen: [Math.round(sx), Math.round(sy)], onScreen: sx > -50 && sx < W + 50 && sy > -50 && sy < H + 50 },
    cam: { x: cam.x, y: cam.y, halfH: cam.halfH, follow: cam.follow },
    planner: { status: planner.status, target: planner.target, kind: p && p.kind, tStart: p && p.tMid - p.dur / 2, dur: p && p.dur, pending: !!planner.pending },
    burn: easyBurn ? { kind: easyBurn.plan.kind, elapsed: easyBurn.elapsed } : null, hold,
    trip: ap.trip && { mode: ap.trip.mode, stage: ap.trip.stage, flyby: ap.trip.flyby, flybyDone: ap.trip.flybyDone }, fuel: Math.round(ap.fuel * FUEL_SCALE),
    traj: { n: sim.traj.length, head: sim.traj.head, endT: sim.traj.endT, crash: sim.traj.crash },
    pred: pred && { segs: pred.segments.map((g) => g.kind[0] + g.body + ':' + g.end), enc: pred.encounter && pred.encounter.planet, fate: pred.fate && pred.fate.kind },
    timing: prevTiming,
  };
}

function frame(now) {
  requestAnimationFrame(frame);
  const rawDt = now - last;
  const workStart = performance.now();
  try { frameBody(now); } catch (e) { dbg.record('error', 'frame: ' + e.message, { stack: e.stack, state: debugState() }); }
  debugTick(rawDt, performance.now() - workStart);
}

function frameBody(now) {
  let tk = performance.now();
  const lap = (k) => { const n = performance.now(); timing[k] = Math.round((n - tk) * 10) / 10; tk = n; };
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  realTime += dt;

  // --- autopilot: the player only picks targets; the ship flies itself
  const plan = ap.plan;
  const tS = ap.timeToBurn;
  const torching = !!ap.brach; // the brachistochrone steers itself
  const armed = !!plan && sim.alive && !easyBurn && tS > 0 && tS < plan.armWindow;
  // Minimal rotation: coast with a fixed attitude; start turning only when the
  // turn will just finish ~1 real second before ignition; track during the burn.
  const planDir = (easyBurn ? easyBurn.plan : plan)?.dir || 'pro';
  let turnNow = !!easyBurn && !torching;
  if (!turnNow && armed) {
    bodyState(plan.frame, sim.t, ps);
    const want = Math.atan2(sim.vy - ps[3], sim.vx - ps[2]) + dirOffset(plan);
    const off = Math.abs(((want - sim.heading) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
    turnNow = tS / Math.max(warp, 0.05) < off / TURN_RATE + 1.0;
  }
  if (turnNow && !torching && hold !== planDir) setHold(planDir);
  if ((!turnNow || torching) && hold) setHold(null);

  // turn toward the planned burn direction (the brachistochrone steers itself)
  const holdPlan = easyBurn ? easyBurn.plan : plan;
  if (hold && sim.alive && holdPlan) {
    bodyState(holdPlan.frame, sim.t, ps);
    const want = Math.atan2(sim.vy - ps[3], sim.vx - ps[2]) + dirOffset(holdPlan);
    let d = ((want - sim.heading) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
    const stepA = TURN_RATE * dt;
    if (Number.isFinite(want)) sim.heading = Math.abs(d) <= stepA ? want : sim.heading + Math.sign(d) * stepA;
  }
  // Safety net: never let a bad heading poison the ship (it would vanish and
  // any thrust would turn the state into NaN).
  if (!Number.isFinite(sim.heading)) {
    dbg.record('anomaly', 'heading was non-finite — reset to prograde', { hold, kind: holdPlan && holdPlan.kind });
    const r = sim.rel(ps);
    sim.heading = Number.isFinite(r[2]) ? Math.atan2(r[3], r[2]) : 0;
  }
  if (!paused) directWarp(dt, plan, tS);
  if (tuning.torchThrust !== BRACH_THRUST && !torchUnderWay()) applyTorch(); // a change held during a torch burn
  updateWarpLabel();

  // --- physics (the autopilot ignites and cuts burns exactly on schedule)
  const simDt = paused ? 0 : dt * warp; // paused: game time stands still
  const step = paused ? { events: [], engineOn: false, accel: 0 } : ap.advance(simDt);
  handleEvents(step.events);
  easyBurn = ap.burn;
  const engineOn = step.engineOn;
  const thrust = engineOn;
  if (!sim.alive) {
    deadAnchor.x += deadAnchor.vx * simDt; deadAnchor.y += deadAnchor.vy * simDt;
    deadTimer -= dt;
    if (deadTimer <= 0) {
      sim.reset();
      dbg.record('event', 'respawn', { t: sim.t });
      cam.follow = true;
      toast('Respawned', `low ${PLANETS[HOME].name} orbit`);
    }
  }
  lap('physics');
  pred = predict(sim, engineOn);
  lap('predict');
  // Captured = the orbit holds for the next few laps; plan the next burn.
  for (const ev of ap.think(pred, 5, 30 + 3 * warp, engineOn)) {
    if (ev.type === 'captured') toast('Captured', `stable orbit around ${PLANETS[ev.body].name}`);
    if (ev.type === 'arrived') {
      const name = PLANETS[ev.body].name;
      lastTripFuel = Math.round(ap.fuel * FUEL_SCALE);
      tripEndT = sim.t;
      const took = tripStartT != null ? fmtSpan(tripEndT - tripStartT) : null;
      dbg.record('event', 'arrived', { target: ev.body, mode: ap.trip.mode, fuel: lastTripFuel, t: sim.t, took, date: realDate(sim.t).toISOString() });
      ap.setTarget(null);
      requestEstimates(null);
      updateTargetButtons();
      toast(`Arrived at ${name}`, `${took ? `trip took <span class="span">${took}</span> · ` : ''}fuel used ${lastTripFuel} · pick the next planet`, 'go');
    }
  }
  lap('planner');

  // --- camera
  sim.world(wst);
  const shipX = sim.alive ? wst[0] : deadAnchor.x, shipY = sim.alive ? wst[1] : deadAnchor.y;
  if (cam.mode === 'cine') { if (!paused) cinematic(dt, shipX, shipY); } // paused: the shot holds still
  else {
    cam.halfH = Math.exp(THREE.MathUtils.lerp(Math.log(cam.halfH), Math.log(cam.target), 1 - Math.exp(-dt * 10)));
    if (cam.track) {
      const [tx, ty] = trackPos(cam.track);
      const k = Math.exp(-dt * 4);
      trackOff.x *= k; trackOff.y *= k;
      cam.x = tx + trackOff.x; cam.y = ty + trackOff.y;
    } else if (cam.follow) { cam.x = shipX; cam.y = shipY; }
  }
  const aspect = W / H;
  camera.left = -cam.halfH * aspect; camera.right = cam.halfH * aspect;
  camera.top = cam.halfH; camera.bottom = -cam.halfH;
  camera.position.set(cam.x, cam.y, 10);
  camera.updateProjectionMatrix();
  const wpp = worldPerPx();

  // --- bodies
  sun.update(realTime, sim.t, Math.max(SUN.radius, 6 * wpp), wpp);
  placeLabel('sun', '', 'Sun', 0, 0, Math.max(SUN.radius / wpp, 6) + 10);

  planets.forEach((pl, i) => {
    planetState(i, sim.t, ps);
    const r = pl.p.radius;
    const minPx = 4.5;
    const scale = Math.max(r, minPx * wpp);
    const marker = THREE.MathUtils.smoothstep((minPx * wpp) / r, 0.5, 1.0);
    const len = Math.hypot(ps[0], ps[1]);
    pl.vis.update(ps[0], ps[1], scale, -ps[0] / len, -ps[1] / len, sim.t, marker);
    pl.orbit.uniforms.uWorldPerPx.value = wpp;
    pl.soi.mesh.position.set(ps[0], ps[1], 0);
    pl.soi.uniforms.uWorldPerPx.value = wpp;
    pl.soi.visible = pl.p.hill / wpp > 14;
    pl.ring.visible = planner.target === i;
    if (pl.ring.visible) {
      const rr = Math.max(pl.p.radius * 1.9, 14 * wpp) * (1 + 0.06 * Math.sin(realTime * 3));
      pl.ring.mesh.position.set(ps[0], ps[1], 0);
      pl.ring.mesh.scale.setScalar(rr);
      pl.ring.uniforms.uWorldPerPx.value = wpp / rr;
      pl.ring.uniforms.uDashOffset.value = realTime * 10;
    }
    placeLabel('p' + i, '', cam.halfH > 400 ? `${pl.p.name} · ${pl.p.a.toFixed(0)}` : pl.p.name, ps[0], ps[1], scale / wpp * 1.3 + 8);
  });

  // --- trajectory prediction
  // Draw the first few segments, plus the encounter that matters (the target's,
  // if one is set) even when it is several laps / segments ahead.
  const focusEnc = pickEncounter(pred);
  // the brachistochrone's own planned path replaces the coasting prediction
  // from just before ignition until the final approach
  const brachDrawn = !!ap.brach && sim.alive && ap.brach.stage !== 'final' && (ap.brach.stage !== 'wait' || ap.brach.ignite < 3);
  const drawSegs = pred.segments.slice(0, segRibbons.length);
  if (focusEnc && focusEnc.seg >= drawSegs.length) drawSegs[drawSegs.length - 1] = pred.segments[focusEnc.seg];
  // the continuous path: every segment in order up to the encounter that matters
  {
    const upTo = focusEnc ? focusEnc.seg : Math.min(pred.segments.length, segRibbons.length) - 1;
    // Segments before the meeting are drawn in FULL (every lap) so the line
    // never bridges skipped laps with a straight jump. Without a near meeting,
    // stop at the end of the first drawn lap instead of jumping ahead.
    // (a meeting many laps away would make an unreadable spiral: then draw just
    // the first lap, and let the ghost planet / markers show the meeting.)
    const fullRoute = focusEnc && focusEnc.lap <= 2;
    const path = [], pathT = [], pathSeg = [];
    for (let i = 0; i <= upTo && i < pred.segments.length; i++) {
      const g = pred.segments[i];
      const a = fullRoute && i < upTo ? g.absFull : g.abs;
      for (let k = 0; k < a.ts.length; k++) { path.push(a.pts[2 * k], a.pts[2 * k + 1]); pathT.push(a.ts[k]); pathSeg.push(i); }
      if (!fullRoute && a.truncated) break;
    }
    // brachistochrone under way: the future path is the planned torch run
    const bp = brachDrawn ? ap.brachPath() : null;
    if (bp) {
      pathRibbon.set(bp.pts, false);
      pathRibbon.uniforms.uWorldPerPx.value = wpp;
      pathRibbon.uniforms.uFade.value = 0.12;
      pathRibbon.visible = true;
      if (bp.flipIdx > 0 && !ap.brach.flipped) placeLabel('flip', 'burn', 'FLIP', bp.pts[2 * bp.flipIdx], bp.pts[2 * bp.flipIdx + 1], 12);
    } else if (sim.alive && path.length >= 4) {
      const stride = Math.max(1, Math.ceil(path.length / 2 / 3900)) * 2;
      const pts = stride === 2 ? path : path.filter((_, k) => (k % stride) < 2);
      checkPath(pts, pathT.filter((_, k) => k % (stride / 2) === 0), pathSeg.filter((_, k) => k % (stride / 2) === 0), stride / 2, wpp);
      pathRibbon.set(pts, false);
      pathRibbon.uniforms.uWorldPerPx.value = wpp;
      pathRibbon.uniforms.uFade.value = focusEnc ? 0.12 : 0.3;
      pathRibbon.visible = true;
    } else pathRibbon.visible = false;
  }
  // Option A: purple = only the orbit you are in NOW (around the planet whose
  // gravity well you are in, else around the Sun). The blue line is the future.
  segRibbons.forEach((rb, i) => {
    // (no orbit to show while the torch is burning)
    const seg = i === 0 && !(brachDrawn && ap.brach.stage !== 'wait') ? pred.segments[0] : null;
    if (!seg || !sim.alive) { rb.clear(); return; }
    const st = SEG_STYLE[seg.kind];
    rb.uniforms.uColor.value.setRGB(...st.color);
    rb.uniforms.uOpacity.value = st.opacity;
    rb.uniforms.uDash.value = st.dash || 0;
    rb.uniforms.uDuty.value = st.duty || 0.5;
    rb.uniforms.uDashOffset.value = realTime * 14;
    rb.uniforms.uWorldPerPx.value = wpp;
    rb.set(seg.points, false); // n-body paths never close exactly; never join the ends
    const lastSeg = i === drawSegs.length - 1;
    rb.uniforms.uFade.value = seg.end === 'closed' ? 0.3 : lastSeg && seg.end !== 'impact' ? 0.35 : 0;
  });

  planets.forEach((pl) => { pl.encGhost.mesh.visible = false; pl.encSoi.visible = false; pl.ghost.mesh.visible = false; });
  caMarker.visible = false; apMarker.visible = false;
  const enc = sim.alive && !brachDrawn ? focusEnc : null;
  if (enc) {
    const pl = planets[enc.planet];
    pl.encGhost.update(enc.px, enc.py, Math.max(pl.p.radius, 4.5 * wpp), 0, 0, sim.t, 0);
    pl.encGhost.mesh.visible = true;
    pl.encSoi.mesh.position.set(enc.px, enc.py, 0);
    pl.encSoi.uniforms.uWorldPerPx.value = wpp;
    pl.encSoi.visible = true;
    caMarker.mesh.position.set(enc.ca.x, enc.ca.y, 0);
    caMarker.mesh.scale.setScalar(5 * wpp);
    caMarker.uniforms.uWorldPerPx.value = 1 / 5;
    caMarker.uniforms.uColor.value.setRGB(...(enc.impact ? [1.0, 0.35, 0.42] : [1.0, 0.76, 0.32]));
    caMarker.visible = true;
    placeLabel('ca', enc.impact ? 'enc bad' : 'enc', enc.impact ? 'impact' : `closest ${fmtD(enc.ca.alt)}`, enc.ca.x, enc.ca.y, 10);
    placeLabel('encname', 'ghost', `${pl.p.name} · T-${fmtTime(enc.t - sim.t)}${enc.lap > 1 ? ` · lap ${enc.lap}` : ''}`, enc.px, enc.py, -(pl.p.hill / wpp) - 20);
  }
  if (ghostsOn && pred.apo && sim.alive) {
    const ap = pred.apo;
    apMarker.mesh.position.set(ap.x, ap.y, 0);
    apMarker.mesh.scale.setScalar(5 * wpp);
    apMarker.uniforms.uWorldPerPx.value = 1 / 5;
    apMarker.visible = true;
    placeLabel('ap', 'ap', `T-${fmtTime(ap.t - sim.t)}`, ap.x, ap.y, 10);
    planets.forEach((pl, i) => {
      planetState(i, ap.t, ps);
      pl.ghost.update(ps[0], ps[1], Math.max(pl.p.radius, 4.5 * wpp), 0, 0, sim.t, 0);
      pl.ghost.mesh.visible = true;
      placeLabel('g' + i, 'ghost', `${pl.p.name} then`, ps[0], ps[1], Math.max(pl.p.radius / wpp, 4.5) + 6);
    });
  }

  // --- easy-mode guides
  drawGuides(wpp);
  {
    const p = planner.ready;
    const near = p && sim.alive && (p.kind !== 'depart' || sim.body === p.from) && (easyBurn || (p.tMid - p.dur / 2 - sim.t) < 25);
    chevron.visible = !!near;
    if (near) {
      bodyState(p.frame, sim.t, ps);
      const ang = Math.atan2(sim.vy - ps[3], sim.vx - ps[2]) + dirOffset(p);
      const off = 34 * wpp;
      chevron.mesh.position.set(wst[0] + Math.cos(ang) * off, wst[1] + Math.sin(ang) * off, 2);
      chevron.mesh.rotation.z = ang;
      chevron.mesh.scale.setScalar(8 * wpp);
      chevron.uniforms.uWorldPerPx.value = 1 / 8;
      // brighter when the ship is pointing the right way
      let err = Math.abs(((sim.heading - ang) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
      chevron.uniforms.uOpacity.value = err < 0.1 ? 1 : 0.45 + 0.25 * Math.sin(realTime * 8);
    }
  }

  // --- ship + exhaust
  ship.group.visible = sim.alive;
  const pxPerLocal = matchMedia('(pointer: coarse)').matches ? 13 : 15;
  const shipScale = pxPerLocal * wpp;
  ship.group.position.set(wst[0], wst[1], 1);
  ship.group.rotation.z = sim.heading;
  ship.group.scale.setScalar(shipScale);
  const firingFine = engineOn && step.accel < 0.3 * THRUST;
  flamePower += ((engineOn ? (firingFine ? 0.35 : 1) : 0) - flamePower) * (1 - Math.exp(-dt * (thrust ? 14 : 9)));
  ship.update(realTime, flamePower, pxPerLocal);

  // No exhaust particles at all: burns show only the flame attached to the
  // ship, so nothing can ever be left behind in space. (Particles remain for
  // crash debris only.)
  emitAcc = 0;
  particles.clearExhaust();
  // particles slow down in slow-mo; once the engine is off, leftover exhaust
  // fades within ~0.2 s instead of hanging in space as the ship speeds away
  particles.update(dt * Math.min(1, warp), DPR, engineOn ? 1 : 5 / Math.min(1, Math.max(warp, 0.25)));
  if (!engineOn && warp > 2) particles.clearExhaust(); // cruising: no leftover sparks, ever

  if (shockAge < 1) {
    shockAge = Math.min(1, shockAge + dt / 1.3);
    shock.mesh.position.x += deadAnchor.vx * simDt; shock.mesh.position.y += deadAnchor.vy * simDt;
    shock.mat.uniforms.uAge.value = shockAge;
    shock.mesh.visible = true;
  } else shock.mesh.visible = false;

  // --- HUD
  if (++hudTick % 4 === 0) { updateHud(pred); updateTargetButtons(); updateFuel(); }
  sweepLabels();

  lap('scene');
  // --- render
  bg.update(W, H, DPR, cam.x, cam.y, realTime);
  renderer.clear();
  composer.render();
  lap('render');
}

const GREY = [0.55, 0.6, 0.66];
function tint(key, css, k) {
  const el = labels.get(key);
  if (!el) return;
  el.style.color = css;
  el.style.textShadow = k > 0.5 ? `0 0 ${(8 * k).toFixed(1)}px rgba(115,255,154,${(0.5 * k).toFixed(2)})` : 'none';
}
function drawGuides(wpp) {
  const p = planner.plan;
  const show = p && sim.alive && (planner.status === 'ready' || planner.status === 'planning') && (p.kind !== 'depart' || sim.body === p.from);
  burnRibbon.visible = burnMarker.visible = bracketArc.visible = bracketTickA.visible = bracketTickB.visible = false;
  if (!show) return;
  const tS = p.tMid - p.dur / 2 - sim.t;
  const ready = planner.status === 'ready';
  const pulse = ready && tS < 5 ? 0.75 + 0.25 * Math.sin(realTime * 10) : 1;
  // Urgency: grey when the burn is far off, ramping to full green as it nears
  // (log scale: 0 at >= 2 min, 1 at <= 5 s; always 1 while burning).
  const k = !ready ? 0 : easyBurn || tS <= 5 ? 1
    : Math.min(1, Math.max(0, (Math.log(120) - Math.log(tS)) / (Math.log(120) - Math.log(5))));
  const col = GREY.map((g, i) => g + (LIME[i] - g) * k);
  const alpha = (0.4 + 0.6 * k) * pulse;
  const css = `rgb(${col.map((c) => Math.round(c * 255)).join(',')})`;
  for (const r of [burnRibbon, burnMarker, bracketArc, bracketTickA, bracketTickB]) {
    r.uniforms.uColor.value.setRGB(...col);
    r.uniforms.uOpacity.value = alpha;
  }

  // burn arc, drawn around its frame body where the predicted path is drawn:
  // the body now, or (capture before arrival) the target's ghost at the encounter
  bodyState(p.frame, sim.t, ps);
  let px = ps[0], py = ps[1];
  if (p.kind === 'capture' && sim.body !== p.target) {
    const e = pred.encounters.find((x) => x.planet === p.target);
    if (e) { px = e.px; py = e.py; }
  }
  const pts = burnArc(sim, p); // world coordinates, on the drawn path
  burnRibbon.set(pts, false);
  burnRibbon.uniforms.uWorldPerPx.value = wpp;
  burnRibbon.visible = true;
  burnMarker.mesh.position.set(pts[0], pts[1], 0);
  burnMarker.mesh.scale.setScalar(7 * wpp);
  burnMarker.uniforms.uWorldPerPx.value = 1 / 7;
  burnMarker.visible = ready;
  if (ready) {
    const armedNow = !easyBurn && tS > 0 && tS < p.armWindow;
    const txt = easyBurn ? `BURNING · ${fmtCount(p.dur - easyBurn.elapsed)} left`
      : armedNow ? `${p.kind === 'capture' ? 'CAPTURE' : p.kind === 'correct' ? 'CORRECTION' : 'DEPARTURE'} · ignition in ${fmtCount(tS)}`
      : tS > 0 ? `${p.kind === 'capture' ? 'CAPTURE' : p.kind === 'correct' ? 'CORRECTION' : p.kind === 'aim' ? (ap.trip && ap.trip.mode === 'bielliptic' ? 'FAR-POINT BURN' : 'FLYBY AIM') : 'BURN'} ${fmtSpan(p.dur)}${(p.thrust || THRUST) < THRUST ? ' fine' : ''} · T-${fmtCount(tS)}` : 'BURN NOW';
    placeLabel('burn', 'burn', txt, pts[0], pts[1], 12);
    tint('burn', css, k);
  }

  if (p.kind !== 'depart') return; // the window bracket is for departures only

  // window bracket on the target's orbit: the target sits inside it when it is time
  const T = PLANETS[p.target];
  const a = bracketAngle(p, sim.t);
  const half = Math.max(T.hill / T.a, 0.03);
  const arc = [];
  for (let i = 0; i <= 32; i++) { const th = a - half + (2 * half * i) / 32; arc.push(T.a * Math.cos(th), T.a * Math.sin(th)); }
  bracketArc.set(arc, false);
  const tick = 16 * wpp;
  for (const [rb, th] of [[bracketTickA, a - half], [bracketTickB, a + half]]) {
    const c = Math.cos(th), s = Math.sin(th);
    rb.set([(T.a - tick) * c, (T.a - tick) * s, (T.a + tick) * c, (T.a + tick) * s], false);
    rb.uniforms.uWorldPerPx.value = wpp;
    rb.visible = true;
  }
  bracketArc.uniforms.uWorldPerPx.value = wpp;
  bracketArc.visible = true;
  if (ready) {
    placeLabel('bracket', 'burn', `${T.name} window · T-${fmtCount(Math.max(0, tS))}`, T.a * 1.04 * Math.cos(a), T.a * 1.04 * Math.sin(a), -26);
    tint('bracket', css, k);
  }
}

updateWarpLabel();
updateHud(pred);
updateTargetButtons();
updateModeButtons();
document.getElementById('b-center').classList.add('on');
requestAnimationFrame(frame);

// debug/test hook
window.__celeste = { sun, sim, cam, ap, date: () => realDate(sim.t), predict: () => pred, keys, held, planner, setTarget, setMode, estimates, setHold, getWarp: () => warp, nudgeWarp, realTime: () => realTime, particles };
