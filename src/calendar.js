// The calendar: game time mapped onto real dates. One game year (600 s at 1x)
// is one real (Julian) year, so a game second is about 14.6 real hours. The
// exact date is kept to the millisecond; the display rounds it to whole hours
// because at any useful warp it moves far too fast to read anything finer.

export const REAL_PER_GAME = (365.25 * 86400) / 600; // real seconds per game second

// game time 0 = the moment the page was opened
export const EPOCH_MS = Date.now();

/** The exact real date at game time t (seconds). */
export function realDate(t) {
  return new Date(EPOCH_MS + t * REAL_PER_GAME * 1000);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2 Oct 2026 11am": the date at game time t, to the whole hour (local time). */
export function fmtDate(t) {
  const d = realDate(t);
  const h = d.getHours();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${h12}${h < 12 ? 'am' : 'pm'}`;
}

/** A game-time span as real days/hours/minutes: "150d03h04m" (or "03h04m"). */
export function fmtSpan(dt) {
  const mins = Math.max(0, Math.round((dt * REAL_PER_GAME) / 60));
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  const hm = `${String(h).padStart(2, '0')}h${String(m).padStart(2, '0')}m`;
  return d > 0 ? `${d}d${hm}` : hm; // days only when there are any: "03h04m"
}
