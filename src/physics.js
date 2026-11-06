// Two-body orbital mechanics in 2D: universal-variable Kepler propagation and
// conic-section elements. Everything here is pure math; no rendering.

export const TAU = Math.PI * 2;

// Stumpff functions. Near z = 0 the closed forms cancel catastrophically, so a
// Taylor series is used there (|z| < 0.1 gives full double precision).
function stumpC(z) {
  if (z > 0.1) { const s = Math.sqrt(z); return (1 - Math.cos(s)) / z; }
  if (z < -0.1) { const s = Math.sqrt(-z); return (Math.cosh(s) - 1) / -z; }
  let term = 0.5, sum = 0.5;
  for (let k = 1; k < 8; k++) { term *= -z / ((2 * k + 1) * (2 * k + 2)); sum += term; }
  return sum;
}
function stumpS(z) {
  if (z > 0.1) { const s = Math.sqrt(z); return (s - Math.sin(s)) / (s * s * s); }
  if (z < -0.1) { const s = Math.sqrt(-z); return (Math.sinh(s) - s) / (s * s * s); }
  let term = 1 / 6, sum = 1 / 6;
  for (let k = 1; k < 8; k++) { term *= -z / ((2 * k + 2) * (2 * k + 3)); sum += term; }
  return sum;
}

/**
 * Propagate a state (r, v) around a point mass `mu` by `dt` seconds.
 * Exact for ellipses, parabolas and hyperbolas. Writes [rx, ry, vx, vy] to `out`.
 */
export function kepler(rx, ry, vx, vy, mu, dt, out = new Float64Array(4)) {
  const r0 = Math.hypot(rx, ry);
  const rv = rx * vx + ry * vy;
  const v2 = vx * vx + vy * vy;
  const alpha = 2 / r0 - v2 / mu; // 1/a
  const smu = Math.sqrt(mu);

  if (alpha > 1e-12) {
    const period = TAU / Math.sqrt(mu * alpha * alpha * alpha);
    dt = dt % period;
  }
  if (dt === 0) { out[0] = rx; out[1] = ry; out[2] = vx; out[3] = vy; return out; }

  let chi;
  if (alpha > 1e-9) {
    chi = smu * dt * alpha;
  } else if (alpha < -1e-9) {
    const a = 1 / alpha;
    const s = Math.sign(dt);
    const arg = (-2 * mu * alpha * dt) / (rv + s * Math.sqrt(-mu * a) * (1 - r0 * alpha));
    chi = arg > 0 ? s * Math.sqrt(-a) * Math.log(arg) : (smu * dt) / r0;
  } else {
    chi = (smu * dt) / r0;
  }

  const k1 = rv / smu;
  const k2 = 1 - alpha * r0;
  let z = 0, C = 0.5, S = 1 / 6;
  for (let i = 0; i < 80; i++) {
    z = alpha * chi * chi;
    C = stumpC(z); S = stumpS(z);
    const chi2 = chi * chi;
    const F = k1 * chi2 * C + k2 * chi2 * chi * S + r0 * chi - smu * dt;
    const dF = k1 * chi * (1 - z * S) + k2 * chi2 * C + r0; // == r > 0
    const step = F / dF;
    chi -= step;
    if (Math.abs(step) < 1e-10 * (1 + Math.abs(chi))) break;
  }
  z = alpha * chi * chi; C = stumpC(z); S = stumpS(z);
  const chi2 = chi * chi;
  const f = 1 - (chi2 / r0) * C;
  const g = dt - (chi2 * chi / smu) * S;
  const nx = f * rx + g * vx;
  const ny = f * ry + g * vy;
  const r = Math.hypot(nx, ny);
  const fd = (smu / (r * r0)) * (alpha * chi2 * chi * S - chi);
  const gd = 1 - (chi2 / r) * C;
  out[0] = nx; out[1] = ny;
  out[2] = fd * rx + gd * vx;
  out[3] = fd * ry + gd * vy;
  return out;
}

function wrapPi(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Orbital elements of a 2D state around mu. */
export function elements(rx, ry, vx, vy, mu) {
  const r = Math.hypot(rx, ry);
  const v2 = vx * vx + vy * vy;
  const h = rx * vy - ry * vx;
  const rv = rx * vx + ry * vy;
  const ex = ((v2 - mu / r) * rx - rv * vx) / mu;
  const ey = ((v2 - mu / r) * ry - rv * vy) / mu;
  let e = Math.hypot(ex, ey);
  const energy = v2 / 2 - mu / r;
  const p = (h * h) / mu;
  const s = h >= 0 ? 1 : -1;
  let omega;
  if (e < 1e-7) { e = 0; omega = Math.atan2(ry, rx) - s * 0; }
  else omega = Math.atan2(ey, ex);
  // a parabola is vanishingly unlikely; nudge it to a hyperbola
  if (Math.abs(e - 1) < 1e-7) e = 1 + 1e-7;
  const a = e < 1 ? p / (1 - e * e) : -p / (e * e - 1); // negative for hyperbola
  const nu0 = e === 0 ? 0 : wrapPi(s * (Math.atan2(ry, rx) - omega));
  const n = Math.sqrt(mu / Math.abs(a * a * a));
  return {
    mu, e, p, a, s, omega, nu0, n, energy, h, r,
    rp: p / (1 + e),
    ra: e < 1 ? p / (1 - e) : Infinity,
    period: e < 1 ? TAU / n : Infinity,
    bound: e < 1,
  };
}

/** Time since periapsis at true anomaly nu (signed). */
export function timeFromPeri(el, nu) {
  const e = el.e;
  if (e < 1) {
    const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
    return (E - e * Math.sin(E)) / el.n;
  }
  const t = Math.sqrt((e - 1) / (e + 1)) * Math.tan(nu / 2);
  const F = 2 * Math.atanh(Math.max(-0.999999999, Math.min(0.999999999, t)));
  return (e * Math.sinh(F) - F) / el.n;
}

/** Forward time from the element's current anomaly until it reaches nu. */
export function timeToNu(el, nu) {
  let dt = timeFromPeri(el, nu) - timeFromPeri(el, el.nu0);
  if (el.e < 1) { dt %= el.period; if (dt < 0) dt += el.period; }
  return dt;
}

/** True anomaly (>= 0, outbound branch) at radius R, or NaN if never reached. */
export function nuAtRadius(el, R) {
  if (el.e === 0) return NaN;
  const c = (el.p / R - 1) / el.e;
  if (c > 1 || c < -1) return NaN;
  return Math.acos(c);
}

/** Position on the conic at true anomaly nu (in the body's frame). */
export function posAtNu(el, nu, out = [0, 0]) {
  const r = el.p / (1 + el.e * Math.cos(nu));
  const ang = el.omega + el.s * nu;
  out[0] = r * Math.cos(ang); out[1] = r * Math.sin(ang);
  return out;
}

/** True anomaly of a position given in the body frame. */
export function nuOfPos(el, x, y) {
  if (el.e === 0) return wrapPi(el.s * (Math.atan2(y, x) - el.omega));
  return wrapPi(el.s * (Math.atan2(y, x) - el.omega));
}

/**
 * Sample the conic from nu0 to nu1 (forward in time) into a flat [x,y,...] array.
 * Ellipses are sampled uniformly in eccentric anomaly, hyperbolas in hyperbolic
 * anomaly, so the spacing stays even along the curve.
 */
export function sampleConic(el, nu0, nu1, count, ox = 0, oy = 0, out = []) {
  out.length = 0;
  const e = el.e;
  const cw = Math.cos(el.omega), sw = Math.sin(el.omega), s = el.s;
  const push = (px, py) => {
    const qy = s * py;
    out.push(ox + cw * px - sw * qy, oy + sw * px + cw * qy);
  };
  if (e < 1) {
    const a = el.a, b = a * Math.sqrt(1 - e * e);
    const E = (nu) => 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
    const E0 = E(nu0);
    let E1 = E(nu1);
    while (E1 <= E0 + 1e-9) E1 += TAU;
    if (nu1 - nu0 >= TAU - 1e-9) E1 = E0 + TAU;
    for (let i = 0; i <= count; i++) {
      const Ei = E0 + ((E1 - E0) * i) / count;
      push(a * (Math.cos(Ei) - e), b * Math.sin(Ei));
    }
  } else {
    const A = -el.a, B = A * Math.sqrt(e * e - 1);
    const F = (nu) => {
      const t = Math.sqrt((e - 1) / (e + 1)) * Math.tan(nu / 2);
      return 2 * Math.atanh(Math.max(-0.999999999, Math.min(0.999999999, t)));
    };
    const F0 = F(nu0), F1 = F(nu1);
    for (let i = 0; i <= count; i++) {
      const Fi = F0 + ((F1 - F0) * i) / count;
      push(A * (e - Math.cosh(Fi)), B * Math.sinh(Fi));
    }
  }
  return out;
}
