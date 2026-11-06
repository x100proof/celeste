// Shader-driven visuals: starfield, nebula, sun, planets, ship, engine flame,
// exhaust/explosion particles and shockwaves. All colours are written directly
// in display space (colour management is disabled in main.js).

import * as THREE from 'three';
import { Ribbon } from './ribbon.js';

const NOISE = /* glsl */`
  float hash3(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.11, 0.17, 0.13));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float vnoise(vec3 x) {
    vec3 i = floor(x); vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash3(i), hash3(i + vec3(1,0,0)), f.x),
                   mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x),
                   mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) {
    float a = 0.5, s = 0.0;
    for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; }
    return s;
  }
`;

const QUAD_VERT = /* glsl */`
  varying vec2 vQ;
  uniform float uExtent;
  void main() {
    vQ = position.xy * uExtent;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const premult = {
  side: THREE.DoubleSide,
  transparent: true, depthWrite: false, depthTest: false,
  blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
};

// ---------------------------------------------------------------- background

export function createBackground() {
  const scene = new THREE.Scene();
  const cam = new THREE.Camera();

  // Nebula: very faint fbm clouds in screen space with slight parallax.
  const nebula = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      uniforms: { uRes: { value: new THREE.Vector2() }, uCam: { value: new THREE.Vector2() }, uTime: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: NOISE + /* glsl */`
        uniform vec2 uRes; uniform vec2 uCam; uniform float uTime;
        varying vec2 vUv;
        void main() {
          vec2 p = (vUv - 0.5) * uRes / 900.0 + uCam * 0.00012;
          float n1 = fbm(vec3(p * 1.6, uTime * 0.004));
          float n2 = fbm(vec3(p * 3.1 + 7.3, 2.0 + uTime * 0.003));
          float clouds = smoothstep(0.42, 0.9, n1) ;
          vec3 c = vec3(0.020, 0.012, 0.045) * 0.6;
          c += vec3(0.05, 0.02, 0.11) * clouds;
          c += vec3(0.00, 0.06, 0.08) * smoothstep(0.5, 0.95, n2) * 0.8;
          float vig = smoothstep(1.25, 0.25, length(vUv - 0.5) * 1.6);
          gl_FragColor = vec4(c * (0.55 + 0.45 * vig), 1.0);
        }`,
      depthWrite: false, depthTest: false,
    })
  );
  nebula.frustumCulled = false;
  scene.add(nebula);

  // Stars: point sprites wrapped over a screen-sized tile with depth parallax.
  const N = 2600;
  const pos = new Float32Array(N * 3), mag = new Float32Array(N), tint = new Float32Array(N), seed = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = Math.random(); pos[i * 3 + 1] = Math.random(); pos[i * 3 + 2] = Math.random();
    const m = Math.pow(Math.random(), 7.0);
    mag[i] = m;
    tint[i] = Math.random();
    seed[i] = Math.random() * 100;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
  g.setAttribute('aTint', new THREE.BufferAttribute(tint, 1));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  const stars = new THREE.Points(g, new THREE.ShaderMaterial({
    uniforms: { uRes: { value: new THREE.Vector2() }, uCam: { value: new THREE.Vector2() }, uTime: { value: 0 }, uDpr: { value: 1 } },
    vertexShader: /* glsl */`
      attribute float aMag; attribute float aTint; attribute float aSeed;
      uniform vec2 uRes; uniform vec2 uCam; uniform float uTime; uniform float uDpr;
      varying vec3 vCol; varying float vMag; varying float vSize;
      void main() {
        vec2 tile = uRes + 64.0;
        float par = mix(0.02, 0.22, position.z);
        vec2 p = mod(position.xy * tile - uCam * par, tile) - 32.0;
        vec2 ndc = p / uRes * 2.0 - 1.0;
        gl_Position = vec4(ndc, 0.0, 1.0);
        float tw = 0.75 + 0.25 * sin(uTime * (1.3 + fract(aSeed) * 2.7) + aSeed);
        vMag = (0.12 + 0.35 * position.z + aMag * 2.2) * tw;
        vec3 cool = vec3(0.65, 0.8, 1.0), warm = vec3(1.0, 0.85, 0.7), white = vec3(1.0);
        vCol = aTint < 0.5 ? mix(cool, white, aTint * 2.0) : mix(white, warm, (aTint - 0.5) * 2.0);
        vSize = (1.4 + aMag * 9.0 + position.z * 0.6);
        gl_PointSize = vSize * uDpr * 2.0;
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vCol; varying float vMag; varying float vSize;
      void main() {
        vec2 q = (gl_PointCoord - 0.5) * 2.0 * vSize; // in px from centre
        float r2 = dot(q, q);
        float core = exp(-r2 * 1.1);
        float halo = exp(-sqrt(r2) * 0.9) * 0.18;
        float spike = (exp(-abs(q.x) * 3.0) + exp(-abs(q.y) * 3.0)) * exp(-sqrt(r2) * 0.35) * smoothstep(3.5, 9.0, vSize) * 0.35;
        float a = (core + halo + spike) * vMag;
        gl_FragColor = vec4(vCol * a * 0.55, 0.0);
      }`,
    transparent: true, depthWrite: false, depthTest: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  }));
  stars.frustumCulled = false;
  scene.add(stars);

  return {
    scene, cam,
    update(w, h, dpr, camX, camY, time) {
      for (const m of [nebula.material, stars.material]) {
        m.uniforms.uRes.value.set(w, h);
        m.uniforms.uCam.value.set(camX, camY);
        m.uniforms.uTime.value = time;
      }
      stars.material.uniforms.uDpr.value = dpr;
    },
  };
}

// ---------------------------------------------------------------- sun

export function createSun(radius) {
  const EXT = 5.0;
  const mat = new THREE.ShaderMaterial({
    uniforms: { uExtent: { value: EXT }, uTime: { value: 0 } },
    vertexShader: QUAD_VERT,
    fragmentShader: NOISE + /* glsl */`
      uniform float uTime; varying vec2 vQ;
      void main() {
        float r = length(vQ);
        float aa = fwidth(r) * 1.2;
        vec3 col = vec3(0.0); float alpha = 0.0;
        // corona with slowly churning rays
        float ang = atan(vQ.y, vQ.x);
        vec2 dir = vec2(cos(ang), sin(ang));
        float rays = fbm(vec3(dir * 2.2, uTime * 0.05 - r * 0.25));
        rays = pow(rays, 1.6) * 2.0;
        float fall = exp(-(r - 1.0) * 1.35);
        vec3 corona = mix(vec3(1.0, 0.45, 0.12), vec3(0.9, 0.25, 0.55), smoothstep(1.0, 4.0, r));
        vec3 glow = corona * fall * (0.35 + 0.65 * rays) * 0.75 * smoothstep(5.0, 3.0, r);
        glow += vec3(1.0, 0.75, 0.4) * exp(-(r - 1.0) * 6.0) * 0.9;
        if (r < 1.0 + aa) {
          vec3 n = vec3(vQ, sqrt(max(0.0, 1.0 - r * r)));
          float gran = fbm(n * 7.0 + vec3(0.0, 0.0, uTime * 0.08));
          float spots = smoothstep(0.62, 0.75, fbm(n * 2.5 + vec3(uTime * 0.01)));
          vec3 surf = mix(vec3(1.0, 0.55, 0.15), vec3(1.0, 0.95, 0.75), gran);
          surf *= 1.0 - spots * 0.35;
          float limb = pow(n.z, 0.45);
          col = surf * (0.55 + 0.75 * limb) * 1.35;
          alpha = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r);
        }
        gl_FragColor = vec4(col * alpha + glow * (1.0 - alpha), alpha);
      }`,
    ...premult,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  mesh.scale.setScalar(radius * EXT);
  mesh.renderOrder = 5;
  return { mesh, update(t) { mat.uniforms.uTime.value = t; } };
}

// ---------------------------------------------------------------- planets

export function createPlanet(p) {
  const EXT = 1.45;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uExtent: { value: EXT }, uTime: { value: 0 }, uSpin: { value: 0 },
      uSunDir: { value: new THREE.Vector2(1, 0) },
      uKind: { value: p.kind },
      uColA: { value: new THREE.Vector3(...p.colA) },
      uColB: { value: new THREE.Vector3(...p.colB) },
      uAtmo: { value: new THREE.Vector3(...p.atmo) },
      uGhost: { value: 0 },
      uMarker: { value: 0 },
    },
    vertexShader: QUAD_VERT,
    fragmentShader: NOISE + /* glsl */`
      uniform float uTime, uSpin, uGhost, uMarker; uniform vec2 uSunDir; uniform int uKind;
      uniform vec3 uColA, uColB, uAtmo;
      varying vec2 vQ;
      vec3 surface(vec3 s) {
        if (uKind == 0) { // Mercury: cratered grey
          float n = fbm(s * 3.5);
          float c = smoothstep(0.55, 0.62, fbm(s * 7.0 + 3.0));
          return mix(uColA, uColB, n) * (1.0 - c * 0.35);
        } else if (uKind == 1) { // Venus: banded cloud deck
          float w = fbm(s * 2.0 + vec3(0.0, 0.0, uTime * 0.02));
          float b = sin(s.z * 9.0 + w * 5.0) * 0.5 + 0.5;
          return mix(uColA, uColB, b * 0.7 + w * 0.3);
        } else if (uKind == 2) { // Earth: oceans, continents, ice, clouds
          float land = fbm(s * 2.3 + 5.0);
          vec3 c = mix(uColA, uColA * 1.6, fbm(s * 6.0));
          float l = smoothstep(0.50, 0.53, land);
          vec3 ground = mix(uColB, vec3(0.45, 0.38, 0.22), smoothstep(0.55, 0.7, land));
          c = mix(c, ground, l);
          float cl = smoothstep(0.5, 0.75, fbm(s * 3.2 + vec3(uTime * 0.03, 0.0, 1.0)));
          return mix(c, vec3(1.0), cl * 0.8);
        } else if (uKind == 4) { // Jupiter: drawn side-on (stripes across the disk), handled in main()
          return uColA;
        } else if (uKind == 5) { // Saturn: soft pale bands
          float w = fbm(s * 3.0);
          float b = sin(s.z * 18.0 + w * 2.0) * 0.5 + 0.5;
          return mix(uColA, uColB, 0.35 + 0.65 * b) * (0.9 + 0.15 * w);
        } else { // Mars: rust, dark maria, polar cap
          float n = fbm(s * 3.0 + 11.0);
          vec3 c = mix(uColA, uColB, smoothstep(0.35, 0.65, n));
          c *= 0.8 + 0.4 * fbm(s * 9.0);
          return c;
        }
      }
      void main() {
        float r = length(vQ);
        float aa = fwidth(r) * 1.2;
        vec3 L = normalize(vec3(uSunDir, 0.28));
        vec3 col = vec3(0.0); float alpha = 0.0;
        if (uGhost > 0.5) {
          // ghost: a soft hologram ring
          float ring = 1.0 - smoothstep(0.0, aa * 1.5 + 0.03, abs(r - 1.0));
          float fill = (1.0 - smoothstep(1.0 - aa, 1.0 + aa, r)) * 0.10;
          vec3 g = uAtmo * (ring * 0.9 + fill);
          gl_FragColor = vec4(g * 0.8, 0.0);
          return;
        }
        if (r < 1.0 + aa) {
          vec3 n = vec3(vQ, sqrt(max(0.0, 1.0 - r * r)));
          float c = cos(uSpin), s = sin(uSpin);
          vec3 sp = vec3(c * n.x - s * n.y, s * n.x + c * n.y, n.z);
          vec3 surf = surface(sp);
          if (uKind == 4) {
            // Jupiter is drawn as if seen from its equator, so it reads as Jupiter:
            // horizontal belts and zones, turbulent edges, the Great Red Spot,
            // all rotating about the screen's vertical axis.
            float ca = cos(uSpin), sa = sin(uSpin);
            vec3 q = vec3(ca * n.x + sa * n.z, n.y, -sa * n.x + ca * n.z); // rotate about screen-up
            float w = fbm(vec3(q.x * 3.0, q.y * 14.0, q.z * 3.0) + vec3(0.0, 0.0, uTime * 0.01));
            float lat = n.y + (w - 0.5) * 0.06;
            float belts = sin(lat * 20.0) * 0.5 + 0.5;
            vec3 zone = vec3(0.92, 0.84, 0.70), belt = vec3(0.62, 0.42, 0.28);
            vec3 c = mix(belt, zone, smoothstep(0.3, 0.7, belts));
            c = mix(c, vec3(0.75, 0.62, 0.48), smoothstep(0.72, 0.95, abs(n.y)));   // duller polar regions
            c *= 0.88 + 0.24 * fbm(vec3(q.x * 8.0, q.y * 30.0, q.z * 8.0));
            vec3 spotC = normalize(vec3(0.0, -0.33, 1.0));                          // southern hemisphere
            vec2 dsp = vec2(atan(q.x, q.z) - atan(spotC.x, spotC.z), (q.y - spotC.y) * 2.2);
            float spot = (1.0 - smoothstep(0.12, 0.2, length(dsp * vec2(1.0, 1.6)))) * step(0.0, q.z);
            surf = mix(c, vec3(0.78, 0.36, 0.22), spot * 0.85) * 0.8;
          }
          float diff = max(dot(n, L), 0.0);
          float soft = smoothstep(-0.15, 0.35, dot(n, L));
          col = surf * (0.05 + soft * diff * 1.25 + soft * 0.08);
          if (uKind >= 4) col *= 0.6; // gas giants: big bright disks would otherwise bloom to white
          float fres = pow(1.0 - n.z, 2.5);
          col += uAtmo * fres * (0.08 + 0.9 * soft) * 0.8;
          alpha = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r);
        }
        float lit = clamp(dot(normalize(vQ + 1e-5), uSunDir) * 0.55 + 0.5, 0.08, 1.0);
        float halo = exp(-max(r - 1.0, 0.0) * 11.0) * smoothstep(EXTENT_R, 1.0, r) * lit;
        vec3 glow = uAtmo * halo * 0.7;
        // a thin neon marker ring keeps far-zoomed planets visible
        glow += uAtmo * uMarker * (1.0 - smoothstep(0.0, 0.12, abs(r - 1.25))) * 0.9;
        gl_FragColor = vec4(col * alpha + glow * (1.0 - alpha), alpha);
      }`.replace('EXTENT_R', EXT.toFixed(2)),
    ...premult,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  mesh.renderOrder = 6;

  // Rings (Saturn), seen face-on from above: banded annulus, shadowed by the planet.
  let ring = null, ringMat = null;
  if (p.rings) {
    const [r0, r1] = p.rings;
    ringMat = new THREE.ShaderMaterial({
      uniforms: { uExtent: { value: r1 }, uSunDir: { value: new THREE.Vector2(1, 0) }, uCol: { value: new THREE.Vector3(...p.colB) } },
      vertexShader: QUAD_VERT,
      fragmentShader: NOISE + /* glsl */`
        uniform vec2 uSunDir; uniform vec3 uCol; varying vec2 vQ;
        void main() {
          float r = length(vQ);
          float aa = fwidth(r) * 1.5;
          float inside = smoothstep(${r0.toFixed(2)} - aa, ${r0.toFixed(2)} + aa, r) * (1.0 - smoothstep(${r1.toFixed(2)} - aa, ${r1.toFixed(2)} + aa, r));
          float u = (r - ${r0.toFixed(2)}) / ${(r1 - r0).toFixed(2)};
          float bands = 0.55 + 0.45 * sin(u * 70.0 + vnoise(vec3(u * 40.0, 0.0, 0.0)) * 3.0);
          float gap = 1.0 - 0.85 * (1.0 - smoothstep(0.0, 0.025, abs(u - 0.62)));   // a Cassini-like gap
          float dens = inside * bands * gap * mix(0.55, 0.9, smoothstep(0.0, 0.5, u));
          // planet shadow: behind the planet (away from the Sun), within one planet radius of the shadow axis
          float along = dot(vQ, uSunDir);
          float side = length(vQ - along * uSunDir);
          float shadow = along < 0.0 ? smoothstep(0.92, 1.08, side) : 1.0;
          vec3 c = uCol * (0.25 + 0.75 * shadow) * 0.9;
          float a = dens * 0.75;
          gl_FragColor = vec4(c * a, a);
        }`,
      ...premult,
    });
    ring = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), ringMat);
    ring.renderOrder = 5;
  }

  return {
    mesh, mat, ring,
    update(x, y, scale, sunDirX, sunDirY, t, marker) {
      mesh.position.set(x, y, 0);
      mesh.scale.setScalar(scale * EXT);
      if (ring) {
        ring.position.set(x, y, 0);
        ring.scale.setScalar(scale * p.rings[1]);
        ringMat.uniforms.uSunDir.value.set(sunDirX, sunDirY);
        ring.visible = marker < 0.5; // rings vanish when the planet is only a far-zoom marker
      }
      mat.uniforms.uSunDir.value.set(sunDirX, sunDirY);
      mat.uniforms.uTime.value = t;
      mat.uniforms.uSpin.value = t * p.spin;
      mat.uniforms.uMarker.value = marker;
    },
  };
}

export function createGhostPlanet(p) {
  const pl = createPlanet(p);
  pl.mat.uniforms.uGhost.value = 1;
  pl.mesh.renderOrder = 4;
  return pl;
}

// ---------------------------------------------------------------- ship

// Rocket outline in local units, nose along +x, length ~2.
const HULL = [
  [1.05, 0], [0.82, 0.13], [0.5, 0.215], [-0.45, 0.225], [-0.58, 0.2],
  [-0.62, 0.42], [-0.86, 0.5], [-0.82, 0.2], [-0.9, 0.13], [-0.9, -0.13],
  [-0.82, -0.2], [-0.86, -0.5], [-0.62, -0.42], [-0.58, -0.2], [-0.45, -0.225],
  [0.5, -0.215], [0.82, -0.13],
];

export function createShip() {
  const group = new THREE.Group();
  group.renderOrder = 20;

  const shape = new THREE.Shape();
  HULL.forEach(([x, y], i) => (i ? shape.lineTo(x, y) : shape.moveTo(x, y)));
  const fill = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.ShaderMaterial({
    vertexShader: `varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `varying vec2 vP; void main(){
      float sh = 0.5 + 0.5 * (vP.y / 0.25);
      vec3 c = mix(vec3(0.02,0.05,0.10), vec3(0.06,0.13,0.22), sh);
      gl_FragColor = vec4(c, 1.0); }`,
    ...premult,
  }));
  fill.renderOrder = 20;
  group.add(fill);

  // hull outline + details as glowing ribbons (in local units)
  const outline = new Ribbon(HULL.length + 2, { color: [0.55, 0.95, 1.0], halfPx: 4, corePx: 1.0, glow: 0.45 });
  outline.set(HULL.flat(), true);
  outline.mesh.renderOrder = 21;
  group.add(outline.mesh);

  const stripe = new Ribbon(8, { color: [1.0, 0.35, 0.75], halfPx: 3, corePx: 0.7, glow: 0.4 });
  stripe.set([0.2, 0.2, 0.2, -0.2], false);
  stripe.mesh.renderOrder = 21;
  group.add(stripe.mesh);

  const win = new Ribbon(40, { color: [0.75, 1.0, 1.0], halfPx: 3, corePx: 0.7, glow: 0.4 });
  const wp = [];
  for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; wp.push(0.5 + 0.085 * Math.cos(a), 0.085 * Math.sin(a)); }
  win.set(wp, true);
  win.mesh.renderOrder = 21;
  group.add(win.mesh);

  // engine flame: noisy additive plume behind the nozzle
  const flameMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPower: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: NOISE + /* glsl */`
      uniform float uTime, uPower; varying vec2 vUv;
      void main() {
        // u: 0 at nozzle -> 1 at tail; v: across
        float u = 1.0 - vUv.x; float v = (vUv.y - 0.5) * 2.0;
        float len = 0.35 + 0.65 * uPower;
        float n = fbm(vec3(u * 6.0 - uTime * 14.0, v * 2.5, uTime * 2.0));
        float width = mix(0.55, 0.05, pow(clamp(u / len, 0.0, 1.0), 0.8)) * (0.8 + 0.4 * n);
        float body = smoothstep(width, width * 0.25, abs(v)) * smoothstep(len, len * 0.35, u + (n - 0.5) * 0.25);
        float core = smoothstep(width * 0.45, 0.0, abs(v)) * smoothstep(len * 0.6, 0.0, u);
        vec3 c = mix(vec3(1.0, 0.25, 0.55), vec3(1.0, 0.62, 0.2), smoothstep(0.0, 0.7, body));
        c = mix(c, vec3(0.85, 0.95, 1.0), core);
        float a = (body * 0.9 + core * 1.2) * uPower;
        gl_FragColor = vec4(c * a * 1.4, 0.0);
      }`,
    transparent: true, depthWrite: false, depthTest: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  });
  const flame = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 0.9), flameMat);
  flame.position.set(-0.88 - 1.4, 0, 0);
  flame.renderOrder = 19;
  group.add(flame);

  return {
    group,
    ribbons: [outline, stripe, win],
    update(time, power, pxPerLocal) {
      flameMat.uniforms.uTime.value = time;
      flameMat.uniforms.uPower.value = power;
      flame.visible = power > 0.002;
      for (const r of this.ribbons) r.uniforms.uWorldPerPx.value = 1 / pxPerLocal;
    },
  };
}

// ---------------------------------------------------------------- particles

export class Particles {
  constructor(max = 3000) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 2);
    this.life = new Float32Array(max);   // remaining
    this.span = new Float32Array(max);   // total
    this.size = new Float32Array(max);
    this.kind = new Float32Array(max);
    this.age = new Float32Array(max);    // 0..1 for shader
    this.drag = new Float32Array(max);
    this.cursor = 0;
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aAge = new THREE.BufferAttribute(this.age, 1).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    this.aKind = new THREE.BufferAttribute(this.kind, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('aAge', this.aAge);
    g.setAttribute('aSize', this.aSize);
    g.setAttribute('aKind', this.aKind);
    this.age.fill(2);
    this.points = new THREE.Points(g, new THREE.ShaderMaterial({
      uniforms: { uDpr: { value: 1 } },
      vertexShader: /* glsl */`
        attribute float aAge; attribute float aSize; attribute float aKind;
        uniform float uDpr; varying float vAge; varying float vKind;
        void main() {
          vAge = aAge; vKind = aKind;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aAge >= 1.0 ? 0.0 : aSize * uDpr * (1.0 + aAge * 1.2);
        }`,
      fragmentShader: /* glsl */`
        varying float vAge; varying float vKind;
        void main() {
          vec2 q = gl_PointCoord - 0.5;
          float r2 = dot(q, q) * 4.0;
          float a = exp(-r2 * 3.0) * (1.0 - vAge) * (1.0 - vAge);
          vec3 hot = vKind > 0.5 ? vec3(1.0, 0.95, 0.85) : vec3(0.85, 0.95, 1.0);
          // white-hot -> amber -> dim orange (no magenta: aged sparks must not read as purple)
          vec3 c = mix(hot, vec3(1.0, 0.55, 0.15), smoothstep(0.0, 0.35, vAge));
          c = mix(c, vec3(0.55, 0.22, 0.06), smoothstep(0.35, 0.95, vAge));
          gl_FragColor = vec4(c * a * 1.3, 0.0);
        }`,
      transparent: true, depthWrite: false, depthTest: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    }));
    this.points.frustumCulled = false;
    this.points.renderOrder = 18;
  }

  emit(x, y, vx, vy, life, size, kind = 0, drag = 0) {
    const i = this.cursor; this.cursor = (this.cursor + 1) % this.max;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = 0;
    this.vel[i * 2] = vx; this.vel[i * 2 + 1] = vy;
    this.life[i] = life; this.span[i] = life; this.size[i] = size; this.kind[i] = kind; this.drag[i] = drag;
    this.age[i] = 0;
  }

  clearExhaust() {
    for (let i = 0; i < this.max; i++) if (this.kind[i] === 0 && this.age[i] < 1) this.age[i] = 2;
  }

  /** exhaustFade > 1 burns down exhaust (kind 0) faster, e.g. once the engine has cut. */
  update(dt, dpr, exhaustFade = 1) {
    for (let i = 0; i < this.max; i++) {
      if (this.age[i] >= 1) continue;
      this.life[i] -= this.kind[i] === 0 ? dt * exhaustFade : dt;
      if (this.life[i] <= 0) { this.age[i] = 2; continue; }
      const k = Math.exp(-this.drag[i] * dt);
      this.vel[i * 2] *= k; this.vel[i * 2 + 1] *= k;
      this.pos[i * 3] += this.vel[i * 2] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 2 + 1] * dt;
      this.age[i] = 1 - this.life[i] / this.span[i];
    }
    this.aPos.needsUpdate = true; this.aAge.needsUpdate = true;
    this.aSize.needsUpdate = true; this.aKind.needsUpdate = true;
    this.points.material.uniforms.uDpr.value = dpr;
  }
}

// ---------------------------------------------------------------- shockwave

export function createShockwave() {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uExtent: { value: 1 }, uAge: { value: 1 } },
    vertexShader: QUAD_VERT,
    fragmentShader: /* glsl */`
      uniform float uAge; varying vec2 vQ;
      void main() {
        float r = length(vQ);
        float R = 0.15 + uAge * 0.85;
        float ring = exp(-pow((r - R) * 18.0, 2.0)) * (1.0 - uAge);
        float flash = exp(-r * r * 30.0) * pow(1.0 - uAge, 4.0) * 2.0;
        vec3 c = vec3(1.0, 0.6, 0.3) * ring + vec3(1.0, 0.95, 0.9) * flash + vec3(0.9, 0.3, 0.8) * ring * 0.5;
        gl_FragColor = vec4(c, 0.0);
      }`,
    transparent: true, depthWrite: false, depthTest: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  mesh.renderOrder = 22;
  mesh.visible = false;
  return { mesh, mat };
}
