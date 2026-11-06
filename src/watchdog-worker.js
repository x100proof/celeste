// Freeze watchdog. Runs on its own thread, so it keeps working when the page's
// main thread is stuck (an infinite loop or a very long frame). The page sends
// a heartbeat a few times a second plus periodic state snapshots; if the
// heartbeats stop while the page is visible, report the freeze with the last
// known state, and report again when (if) the page recovers.

let cfg = null;
let lastBeat = performance.now();
let hidden = false;
let frozenSince = 0;
let lastSnap = null;
let recent = [];
let reports = 0;

function send(reason, extra) {
  if (!cfg || reports >= 20) return;
  reports++;
  const body = JSON.stringify({
    sid: cfg.sid, build: cfg.build, ua: cfg.ua, reason, from: 'watchdog',
    lastSnap, recent, ...extra,
  });
  fetch(cfg.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') { cfg = m; lastBeat = performance.now(); return; }
  if (!cfg) return;
  if (m.type === 'hidden') { hidden = true; return; }
  if (m.type === 'visible') { hidden = false; lastBeat = performance.now(); return; }
  if (m.type === 'snap') { lastSnap = m.snap; recent = m.recent; }
  // any message counts as a heartbeat
  const t = performance.now();
  if (frozenSince) {
    send('recovered', { stalledMs: Math.round(t - frozenSince) });
    frozenSince = 0;
  }
  lastBeat = t;
};

setInterval(() => {
  const t = performance.now();
  if (!hidden && !frozenSince && t - lastBeat > 3000) {
    frozenSince = lastBeat;
    send('freeze', { silentMs: Math.round(t - lastBeat) });
  }
}, 1000);
