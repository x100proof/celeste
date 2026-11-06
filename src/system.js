// The (compressed) inner solar system: bodies, masses and their fixed orbits.
//
// Units: distance "u", time seconds. Earth orbits at 1000 u with a 600 s year at 1x.
// Orbit radii keep their real ratios; planets are enlarged and made heavier so
// they are playable. Planets move on fixed circular orbits ("on rails"); the
// ship feels the gravity of the Sun and every planet at once (see nbody.js).

import { TAU } from './physics.js';

const YEAR = 600;
const AU = 1000;
export const GM_SUN = (4 * Math.PI * Math.PI * AU ** 3) / (YEAR * YEAR);

// `reach` sets the planet's mass: GM = GM_sun (reach / a)^2.5 (it is the
// classic sphere-of-influence radius for that mass).
// Spin axes: IAU WGCCRE north poles (J2000 right ascension / declination,
// degrees), converted to ecliptic coordinates. The game plane is the ecliptic
// seen from its north side (+z toward the viewer), x along ecliptic longitude 0.
const OBLIQUITY = (23.4392911 * Math.PI) / 180;
function iauPole(raDeg, decDeg) {
  const a = (raDeg * Math.PI) / 180, d = (decDeg * Math.PI) / 180;
  const lat = Math.asin(Math.sin(d) * Math.cos(OBLIQUITY) - Math.cos(d) * Math.sin(OBLIQUITY) * Math.sin(a));
  const lon = Math.atan2(Math.sin(a) * Math.cos(OBLIQUITY) + Math.tan(d) * Math.sin(OBLIQUITY), Math.cos(a));
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
}

function planet(name, aAU, radius, reach, phaseDeg, look) {
  const a = aAU * AU;
  const period = YEAR * Math.pow(aAU, 1.5);
  const mu = GM_SUN * Math.pow(reach / a, 2.5);
  return {
    name, a, radius, period, mu,
    hill: a * Math.cbrt(mu / (3 * GM_SUN)), // region where the planet dominates
    phase0: (phaseDeg * Math.PI) / 180,
    w: TAU / period,
    ...look,
  };
}

export const SUN = { name: 'Sun', mu: GM_SUN, radius: 40, hill: Infinity, pole: null };

export const PLANETS = [
  planet('Mercury', 0.387, 6, 45, 150, { kind: 0, spin: 0.05, texture: 'textures/mercury.jpg', pole: iauPole(281.0103, 61.4155), colA: [0.32, 0.30, 0.29], colB: [0.70, 0.66, 0.62], atmo: [0.55, 0.55, 0.6] }),
  planet('Venus', 0.723, 9.5, 65, -60, { kind: 1, spin: 0.02, pole: iauPole(272.76, 67.16), retro: true, colA: [0.78, 0.58, 0.30], colB: [0.98, 0.90, 0.68], atmo: [1.0, 0.78, 0.45] }),
  planet('Earth', 1.0, 10, 95, 0, { kind: 2, spin: 0.25, pole: iauPole(0, 90), texture: 'textures/earth.jpg', colA: [0.03, 0.12, 0.35], colB: [0.20, 0.45, 0.18], atmo: [0.35, 0.65, 1.0] }),
  planet('Mars', 1.524, 7, 70, 80, { kind: 3, spin: 0.24, texture: 'textures/mars.jpg', pole: iauPole(317.269202, 54.432516), colA: [0.45, 0.16, 0.07], colB: [0.85, 0.42, 0.20], atmo: [1.0, 0.5, 0.35] }),
  // gas giants: reach chosen for GM ~1200 (Jupiter) and ~700 (Saturn) — the heaviest planets
  planet('Jupiter', 5.203, 24, 855, 210, { kind: 4, spin: 0.6, texture: 'textures/jupiter.jpg', pole: iauPole(268.056595, 64.495303), colA: [0.55, 0.36, 0.22], colB: [0.95, 0.86, 0.72], atmo: [1.0, 0.78, 0.55] }),
  planet('Saturn', 9.537, 20, 1263, 320, { kind: 5, spin: 0.55, texture: 'textures/saturn.jpg', pole: iauPole(40.589, 83.537), colA: [0.72, 0.6, 0.4], colB: [0.97, 0.91, 0.74], atmo: [1.0, 0.9, 0.65], rings: [1.3, 2.35] }),
];

export const HOME = 2; // Earth

/** Heliocentric position/velocity of planet i at time t. */
export function planetState(i, t, out = new Float64Array(4)) {
  const p = PLANETS[i];
  const th = p.phase0 + p.w * t;
  const c = Math.cos(th), s = Math.sin(th);
  out[0] = p.a * c; out[1] = p.a * s;
  out[2] = -p.a * p.w * s; out[3] = p.a * p.w * c;
  return out;
}

/** Position/velocity of body i (-1 = Sun) at time t. */
export function bodyState(i, t, out = new Float64Array(4)) {
  if (i < 0) { out[0] = out[1] = out[2] = out[3] = 0; return out; }
  return planetState(i, t, out);
}

export function bodyOf(index) { return index < 0 ? SUN : PLANETS[index]; }

export const THRUST = 1.0; // u/s^2
export const FINE = 0.1;   // fine-thrust fraction (Shift)
export const TURN_RATE = 3.2; // rad/s

// The Sun's spin axis (IAU: RA 286.13, Dec 63.87 -> 7.25 deg from the ecliptic pole).
SUN.pole = iauPole(286.13, 63.87);
