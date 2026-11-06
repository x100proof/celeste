// Remote debugging: everything the game logs to the console, uncaught errors,
// anomalies (non-finite ship state, slow frames) and a rolling buffer of game
// state snapshots are batched and POSTed to /api/log (stored server-side as
// JSON lines). A watchdog Web Worker reports freezes: if the page stops
// sending heartbeats while visible, the worker (its own thread) sends the last
// snapshots itself.
//
// In the browser console:  celesteDebug.report('what happened')  sends now.

const ENDPOINT = '/api/log';
const BUILD = '__BUILD__';
const SID = Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
const MAX_ENTRIES = 300;     // ring buffer
const MAX_SNAPS = 40;
const MAX_POSTS = 120;       // per session, so a bug loop cannot flood the server
const MAX_BODY = 48000;      // bytes per POST

const entries = [];          // { at, kind, msg, data }
const snaps = [];
let unsent = 0, posts = 0, flushTimer = 0, lastFlush = 0;
let watchdog = null;

function now() { return Math.round(performance.now()); }

function safe(v, depth = 0) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'number') return Number.isFinite(v) ? +v.toPrecision(7) : String(v);
  if (typeof v === 'string') return v.length > 600 ? v.slice(0, 600) + '…' : v;
  if (typeof v === 'boolean') return v;
  if (v instanceof Error) return { name: v.name, message: v.message, stack: (v.stack || '').slice(0, 1500) };
  if (depth > 3) return '…';
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return Array.from(v).slice(0, 20).map((x) => safe(x, depth + 1));
  if (typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).slice(0, 30)) o[k] = safe(v[k], depth + 1);
    return o;
  }
  return String(v);
}

/** Record an entry. kind: log | info | warn | error | event | anomaly | stall */
export function record(kind, msg, data) {
  const m = safe(String(msg));
  const last = entries[entries.length - 1];
  if (last && last.kind === kind && last.msg === m) { last.count = (last.count || 1) + 1; last.lastAt = now(); return; } // collapse repeats
  entries.push({ at: now(), kind, msg: m, data: data === undefined ? undefined : safe(data) });
  if (entries.length > MAX_ENTRIES) entries.shift();
  unsent++;
  if (kind === 'error' || kind === 'anomaly' || kind === 'stall') schedule(1000);
}

/** Store a state snapshot (call ~2x per second); also feeds the watchdog. */
export function snapshot(state) {
  const s = { at: now(), ...safe(state) };
  snaps.push(s);
  if (snaps.length > MAX_SNAPS) snaps.shift();
  if (watchdog) watchdog.postMessage({ type: 'snap', snap: s, recent: entries.slice(-15) });
}

/** Heartbeat for the freeze watchdog — call once per frame. */
let lastBeat = 0;
export function beat() {
  const t = performance.now();
  if (watchdog && t - lastBeat > 200) { lastBeat = t; watchdog.postMessage({ type: 'beat' }); }
}

function payload(reason) {
  const body = {
    sid: SID, build: BUILD, reason, ua: navigator.userAgent, url: location.href,
    screen: `${innerWidth}x${innerHeight}@${devicePixelRatio}`, uptimeMs: now(),
    entries: entries.slice(-unsent || -1).slice(-MAX_ENTRIES), snaps: snaps.slice(-12),
  };
  let json = JSON.stringify(body);
  while (json.length > MAX_BODY && body.entries.length > 5) {
    body.entries = body.entries.slice(Math.floor(body.entries.length / 2));
    json = JSON.stringify(body);
  }
  return json;
}

export function flush(reason = 'batch', { beacon = false } = {}) {
  clearTimeout(flushTimer); flushTimer = 0;
  if (!unsent && reason === 'batch') return;
  if (posts >= MAX_POSTS) return;
  posts++; lastFlush = performance.now();
  const json = payload(reason);
  unsent = 0;
  try {
    if (beacon && navigator.sendBeacon) navigator.sendBeacon(ENDPOINT, new Blob([json], { type: 'application/json' }));
    else fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json, keepalive: true }).catch(() => {});
  } catch (e) { /* never let logging break the game */ }
}

function schedule(ms) {
  if (flushTimer) return;
  const wait = Math.max(ms, 3000 - (performance.now() - lastFlush)); // at most one POST per ~3 s
  flushTimer = setTimeout(() => flush('auto'), wait);
}

export function init() {
  // mirror console output into the buffer
  for (const level of ['log', 'info', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      try { record(level, args.map((a) => (typeof a === 'string' ? a : JSON.stringify(safe(a)))).join(' ')); } catch (e) { /* ignore */ }
    };
  }
  addEventListener('error', (e) => record('error', e.message || 'error', { src: e.filename, line: e.lineno, col: e.colno, stack: e.error && e.error.stack }));
  addEventListener('unhandledrejection', (e) => record('error', 'unhandled rejection', { reason: safe(e.reason) }));
  addEventListener('pagehide', () => flush('pagehide', { beacon: true }));
  document.addEventListener('visibilitychange', () => {
    if (watchdog) watchdog.postMessage({ type: document.hidden ? 'hidden' : 'visible' });
    if (document.hidden) flush('hidden', { beacon: true });
  });
  setInterval(() => { if (unsent) flush('batch'); }, 20000);

  try {
    watchdog = new Worker(new URL('./watchdog-worker.js', import.meta.url), { type: 'module' });
    watchdog.postMessage({ type: 'init', sid: SID, build: BUILD, endpoint: new URL(ENDPOINT, location.href).href, ua: navigator.userAgent });
    if (document.hidden) watchdog.postMessage({ type: 'hidden' }); // opened in a background tab: not a freeze
  } catch (e) { record('warn', 'watchdog unavailable', e); }

  window.celesteDebug = {
    sid: SID,
    report(note = '') { record('event', 'manual report', { note }); flush('manual'); return `sent (session ${SID})`; },
    entries, snaps,
  };
  console.info(`[celeste] debug session ${SID} — logs go to ${ENDPOINT}; run celesteDebug.report('note') to send now`);
  record('event', 'session start', { build: BUILD });
}
