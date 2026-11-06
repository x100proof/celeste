// Antialiased, glowing polyline ("ribbon") with constant on-screen width.
// Centre points + miter normals are built on the CPU; the vertex shader extrudes
// them by a pixel width, and the fragment shader feathers the edges and adds a
// soft glow, so lines stay smooth at every zoom level. Optional animated dashes.

import * as THREE from 'three';

/** Edge softening width in CSS px, shared by all ribbons: 1 device pixel (= 1 / devicePixelRatio). */
export const FEATHER = { value: 1 };

const vert = /* glsl */`
  attribute vec2 aNormal;
  attribute float aSide;
  attribute float aAlong;
  uniform float uHalfPx;
  uniform float uWorldPerPx;
  varying float vSide;
  varying float vAlongPx;
  varying float vAlongW;
  void main() {
    vAlongW = aAlong;
    vec2 p = position.xy + aNormal * aSide * uHalfPx * uWorldPerPx;
    vSide = aSide;
    vAlongPx = aAlong / uWorldPerPx;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, position.z, 1.0);
  }
`;

const frag = /* glsl */`
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uHalfPx;
  uniform float uCorePx;
  uniform float uGlow;
  uniform float uDash;     // dash period in px (0 = solid)
  uniform float uDuty;
  uniform float uDashOffset;
  uniform float uFeather;
  uniform float uLen;      // total length (world); with uFade > 0 the last uFade of it fades out
  uniform float uFade;
  varying float vSide;
  varying float vAlongPx;
  varying float vAlongW;
  void main() {
    float d = abs(vSide) * uHalfPx;
    float core = 1.0 - smoothstep(uCorePx - 0.6 * uFeather, uCorePx + 0.6 * uFeather, d);
    float g = exp(-3.0 * (d * d) / (uHalfPx * uHalfPx)) * uGlow;
    float edge = 1.0 - smoothstep(uHalfPx - uFeather, uHalfPx, d);
    float a = (core + g) * edge;
    if (uDash > 0.0) {
      float ph = fract((vAlongPx - uDashOffset) / uDash);
      float w = 1.0 / uDash; // ~1px soft dash ends
      a *= smoothstep(0.0, w * 1.5, ph) * (1.0 - smoothstep(uDuty - w * 1.5, uDuty, ph));
    }
    if (uFade > 0.0) a *= 1.0 - smoothstep(uLen * (1.0 - uFade), uLen, vAlongW);
    gl_FragColor = vec4(uColor * a * uOpacity, 0.0);
  }
`;

export class Ribbon {
  constructor(maxPoints, { color = [0.3, 0.9, 1.0], opacity = 1, halfPx = 3, corePx = 0.9, glow = 0.35, dash = 0, duty = 0.5, z = 0 } = {}) {
    this.max = maxPoints;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(maxPoints * 2 * 3);
    this.nrm = new Float32Array(maxPoints * 2 * 2);
    this.side = new Float32Array(maxPoints * 2);
    this.along = new Float32Array(maxPoints * 2);
    for (let i = 0; i < maxPoints; i++) { this.side[i * 2] = -1; this.side[i * 2 + 1] = 1; }
    const idx = new Uint32Array((maxPoints - 1) * 6);
    for (let i = 0; i < maxPoints - 1; i++) {
      const a = i * 2;
      idx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6);
    }
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aNrm = new THREE.BufferAttribute(this.nrm, 2).setUsage(THREE.DynamicDrawUsage);
    this.aAlong = new THREE.BufferAttribute(this.along, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('aNormal', this.aNrm);
    g.setAttribute('aSide', new THREE.BufferAttribute(this.side, 1));
    g.setAttribute('aAlong', this.aAlong);
    g.setDrawRange(0, 0);
    this.z = z;
    this.uniforms = {
      uColor: { value: new THREE.Color(...color) },
      uOpacity: { value: opacity },
      uHalfPx: { value: halfPx },
      uCorePx: { value: corePx },
      uGlow: { value: glow },
      uDash: { value: dash },
      uDuty: { value: duty },
      uDashOffset: { value: 0 },
      uWorldPerPx: { value: 1 },
      uFeather: FEATHER,
      uLen: { value: 1 },
      uFade: { value: 0 },
    };
    const m = new THREE.ShaderMaterial({
      vertexShader: vert, fragmentShader: frag, uniforms: this.uniforms,
      transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.geometry = g;
  }

  /** pts: flat [x0,y0,x1,y1,...]; closed joins the ends. */
  set(pts, closed = false) {
    let n = Math.min(pts.length >> 1, this.max);
    if (closed && n > 2) {
      // drop a duplicated end point; we wrap explicitly
      const dx = pts[0] - pts[(n - 1) * 2], dy = pts[1] - pts[(n - 1) * 2 + 1];
      if (dx * dx + dy * dy < 1e-12) n--;
    }
    const total = closed ? Math.min(n + 1, this.max) : n;
    if (n < 2) { this.geometry.setDrawRange(0, 0); return; }
    let along = 0, px = 0, py = 0;
    for (let i = 0; i < total; i++) {
      const j = i % n;
      const x = pts[j * 2], y = pts[j * 2 + 1];
      // neighbours
      let pi = j - 1, ni = j + 1;
      if (closed) { pi = (j - 1 + n) % n; ni = (j + 1) % n; }
      else { if (pi < 0) pi = j; if (ni >= n) ni = j; }
      let tx1 = x - pts[pi * 2], ty1 = y - pts[pi * 2 + 1];
      let tx2 = pts[ni * 2] - x, ty2 = pts[ni * 2 + 1] - y;
      let l1 = Math.hypot(tx1, ty1), l2 = Math.hypot(tx2, ty2);
      if (l1 < 1e-12) { tx1 = tx2; ty1 = ty2; l1 = l2; }
      if (l2 < 1e-12) { tx2 = tx1; ty2 = ty1; l2 = l1; }
      if (l1 < 1e-12) { l1 = l2 = 1; tx1 = tx2 = 1; ty1 = ty2 = 0; }
      tx1 /= l1; ty1 /= l1; tx2 /= l2; ty2 /= l2;
      let tx = tx1 + tx2, ty = ty1 + ty2;
      let tl = Math.hypot(tx, ty);
      if (tl < 1e-6) { tx = tx2; ty = ty2; tl = 1; }
      tx /= tl; ty /= tl;
      const nx = -ty, ny = tx;
      const dot = Math.max(0.35, nx * -ty2 + ny * tx2);
      const k = 1 / dot;
      if (i > 0) along += Math.hypot(x - px, y - py);
      px = x; py = y;
      const o = i * 2;
      this.pos[o * 3] = x; this.pos[o * 3 + 1] = y; this.pos[o * 3 + 2] = this.z;
      this.pos[o * 3 + 3] = x; this.pos[o * 3 + 4] = y; this.pos[o * 3 + 5] = this.z;
      this.nrm[o * 2] = nx * k; this.nrm[o * 2 + 1] = ny * k;
      this.nrm[o * 2 + 2] = nx * k; this.nrm[o * 2 + 3] = ny * k;
      this.along[o] = along; this.along[o + 1] = along;
    }
    this.length = along;
    this.uniforms.uLen.value = Math.max(along, 1e-6);
    this.aPos.needsUpdate = true; this.aNrm.needsUpdate = true; this.aAlong.needsUpdate = true;
    this.geometry.setDrawRange(0, (total - 1) * 6);
  }

  clear() { this.geometry.setDrawRange(0, 0); }
  set visible(v) { this.mesh.visible = v; }
  get visible() { return this.mesh.visible; }
}

export function circlePoints(cx, cy, r, n = 128, out = []) {
  out.length = 0;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return out;
}
