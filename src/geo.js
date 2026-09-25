/* ─────────────────────────────────────────────────────────────────────────
   geo.js — small linear algebra and mesh builders for the 3D plate.
   Matrices are column-major Float32Array(16), as WebGL wants them.
   ───────────────────────────────────────────────────────────────────────── */
var GEO = (function () {
'use strict';

const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
};

function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
function ident() { const o = new Float32Array(16); o[0] = o[5] = o[10] = o[15] = 1; return o; }
function lookAt(eye, target, up) {
  const f = v3.norm(v3.sub(target, eye));
  const s = v3.norm(v3.cross(f, up));
  const u = v3.cross(s, f);
  const o = ident();
  o[0] = s[0]; o[4] = s[1]; o[8] = s[2];
  o[1] = u[0]; o[5] = u[1]; o[9] = u[2];
  o[2] = -f[0]; o[6] = -f[1]; o[10] = -f[2];
  o[12] = -v3.dot(s, eye); o[13] = -v3.dot(u, eye); o[14] = v3.dot(f, eye);
  return o;
}
function ortho(halfW, halfH, near, far) {
  const o = ident();
  o[0] = 1 / halfW; o[5] = 1 / halfH; o[10] = -2 / (far - near); o[14] = -(far + near) / (far - near);
  return o;
}
function persp(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), o = new Float32Array(16);
  o[0] = f / aspect; o[5] = f; o[10] = (far + near) / (near - far); o[11] = -1; o[14] = 2 * far * near / (near - far);
  return o;
}
// model matrix from basis vectors (columns) + translation
function basis(x, y, z, t) {
  const o = new Float32Array(16);
  o[0] = x[0]; o[1] = x[1]; o[2] = x[2];
  o[4] = y[0]; o[5] = y[1]; o[6] = y[2];
  o[8] = z[0]; o[9] = z[1]; o[10] = z[2];
  o[12] = t[0]; o[13] = t[1]; o[14] = t[2]; o[15] = 1;
  return o;
}
// rotation about an axis (unit), as 3 columns
function rotAxis(axis, a) {
  const [x, y, z] = v3.norm(axis), c = Math.cos(a), s = Math.sin(a), C = 1 - c;
  return [[c + x * x * C, y * x * C + z * s, z * x * C - y * s], [x * y * C - z * s, c + y * y * C, z * y * C + x * s], [x * z * C + y * s, y * z * C - x * s, c + z * z * C]];
}
const rotVec = (R, v) => [R[0][0] * v[0] + R[1][0] * v[1] + R[2][0] * v[2], R[0][1] * v[0] + R[1][1] * v[1] + R[2][1] * v[2], R[0][2] * v[0] + R[1][2] * v[1] + R[2][2] * v[2]];

/* ───────── instance packing: 24 floats each ───────── */
function Batch(cap) { this.a = new Float32Array(cap * 24); this.n = 0; this.cap = cap; }
Batch.prototype.reset = function () { this.n = 0; return this; };
// a box: centre c, half-sizes h (in its own frame), rotation columns R (3 unit vectors) or null
Batch.prototype.box = function (c, h, R, par, par2) {
  const x = R ? R[0] : [1, 0, 0], y = R ? R[1] : [0, 1, 0], z = R ? R[2] : [0, 0, 1];
  return this.push(basis(v3.mul(x, h[0] * 2), v3.mul(y, h[1] * 2), v3.mul(z, h[2] * 2), c), par, par2);
};
Batch.prototype.push = function (M, par, par2) {
  if (this.n >= this.cap) return this;
  const o = this.n * 24;
  this.a.set(M, o);
  const p = par || [0, 1, 0, 0.785];
  this.a[o + 16] = p[0]; this.a[o + 17] = p[1]; this.a[o + 18] = p[2]; this.a[o + 19] = p[3];
  const q = par2 || [0, 0, 0, 0];
  this.a[o + 20] = q[0]; this.a[o + 21] = q[1]; this.a[o + 22] = q[2]; this.a[o + 23] = q[3];
  this.n++;
  return this;
};

/* ───────── mesh builders (plain arrays; triangles) ───────── */
function Builder() { this.pos = []; this.nrm = []; this.uv = []; this.tu = []; this.tv = []; }
// a quad with corners p0 (uv 0,0), p1 (1,0), p2 (1,1), p3 (0,1)
Builder.prototype.quad = function (p0, p1, p2, p3, n, tu, tv) {
  const P = [p0, p1, p2, p0, p2, p3], UV = [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]];
  for (let i = 0; i < 6; i++) { this.pos.push(...P[i]); this.nrm.push(...n); this.uv.push(...UV[i]); this.tu.push(...tu); this.tv.push(...tv); }
  return this;
};
Builder.prototype.tri = function (a, b, c, na, nb, nc, uva, uvb, uvc, tu, tv) {
  this.pos.push(...a, ...b, ...c); this.nrm.push(...na, ...nb, ...nc); this.uv.push(...uva, ...uvb, ...uvc);
  this.tu.push(...tu, ...tu, ...tu); this.tv.push(...tv, ...tv, ...tv);
  return this;
};
Builder.prototype.data = function () { return { pos: this.pos, nrm: this.nrm, uv: this.uv, tu: this.tu, tv: this.tv }; };

// unit cube centred on the origin (−0.5‥0.5), each face with its own uv frame
function cube() {
  const b = new Builder();
  const F = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  ];
  for (const [n, u, v] of F) {
    const c = v3.mul(n, 0.5);
    const p = (a, bb) => v3.add(c, v3.add(v3.mul(u, a - 0.5), v3.mul(v, bb - 0.5)));
    b.quad(p(0, 0), p(1, 0), p(1, 1), p(0, 1), n, u, v);
  }
  return b.data();
}
// UV sphere of radius 0.5 (for small figures); uv spans the surface
function sphere(nu, nv) {
  const b = new Builder();
  const P = (i, j) => { const th = (i / nu) * Math.PI * 2, ph = (j / nv) * Math.PI; return [Math.cos(th) * Math.sin(ph) * 0.5, Math.sin(th) * Math.sin(ph) * 0.5, Math.cos(ph) * 0.5]; };
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const a = P(i, j), bb = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
    const na = v3.norm(a), nb = v3.norm(bb), nc = v3.norm(c), nd = v3.norm(d);
    const uva = [i / nu, j / nv], uvb = [(i + 1) / nu, j / nv], uvc = [(i + 1) / nu, (j + 1) / nv], uvd = [i / nu, (j + 1) / nv];
    const tu = [0.3, 0, 0], tv = [0, 0, 0.3];
    b.tri(a, bb, c, na, nb, nc, uva, uvb, uvc, tu, tv);
    b.tri(a, c, d, na, nc, nd, uva, uvc, uvd, tu, tv);
  }
  return b.data();
}
// a cone/frustum along +z from z=0 (radius r0) to z=1 (radius r1)
function frustum(n, r0, r1) {
  const b = new Builder();
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
    const p00 = [Math.cos(a0) * r0, Math.sin(a0) * r0, 0], p10 = [Math.cos(a1) * r0, Math.sin(a1) * r0, 0];
    const p01 = [Math.cos(a0) * r1, Math.sin(a0) * r1, 1], p11 = [Math.cos(a1) * r1, Math.sin(a1) * r1, 1];
    const slope = (r0 - r1);
    const n0 = v3.norm([Math.cos(a0), Math.sin(a0), slope]), n1 = v3.norm([Math.cos(a1), Math.sin(a1), slope]);
    const tu = [0.2, 0, 0], tv = [0, 0, 1];
    b.tri(p00, p10, p11, n0, n1, n1, [i / n, 0], [(i + 1) / n, 0], [(i + 1) / n, 1], tu, tv);
    b.tri(p00, p11, p01, n0, n1, n0, [i / n, 0], [(i + 1) / n, 1], [i / n, 1], tu, tv);
    // caps
    b.tri([0, 0, 0], p10, p00, [0, 0, -1], [0, 0, -1], [0, 0, -1], [0.5, 0.5], [0.5, 0.5], [0.5, 0.5], tu, tv);
    b.tri([0, 0, 1], p01, p11, [0, 0, 1], [0, 0, 1], [0, 0, 1], [0.5, 0.5], [0.5, 0.5], [0.5, 0.5], tu, tv);
  }
  return b.data();
}

// bake several mesh parts into one, each moved by a model matrix (uniform-ish scales)
function merge(parts) {
  const out = { pos: [], nrm: [], uv: [], tu: [], tv: [] };
  for (const { data, M } of parts) {
    const n = data.pos.length / 3;
    for (let i = 0; i < n; i++) {
      const x = data.pos[i * 3], y = data.pos[i * 3 + 1], z = data.pos[i * 3 + 2];
      out.pos.push(M[0] * x + M[4] * y + M[8] * z + M[12], M[1] * x + M[5] * y + M[9] * z + M[13], M[2] * x + M[6] * y + M[10] * z + M[14]);
      const tr = (a) => [M[0] * a[0] + M[4] * a[1] + M[8] * a[2], M[1] * a[0] + M[5] * a[1] + M[9] * a[2], M[2] * a[0] + M[6] * a[1] + M[10] * a[2]];
      const nn = v3.norm(tr([data.nrm[i * 3], data.nrm[i * 3 + 1], data.nrm[i * 3 + 2]]));
      out.nrm.push(...nn);
      out.uv.push(data.uv[i * 2], data.uv[i * 2 + 1]);
      out.tu.push(...tr([data.tu[i * 3], data.tu[i * 3 + 1], data.tu[i * 3 + 2]]));
      out.tv.push(...tr([data.tv[i * 3], data.tv[i * 3 + 1], data.tv[i * 3 + 2]]));
    }
  }
  return out;
}
const scaleM = (sx, sy, sz, t) => basis([sx, 0, 0], [0, sy, 0], [0, 0, sz], t || [0, 0, 0]);

return { v3, mul, ident, lookAt, ortho, persp, basis, rotAxis, rotVec, Batch, Builder, cube, sphere, frustum, merge, scaleM };
})();
