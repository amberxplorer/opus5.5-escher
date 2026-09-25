/* ─────────────────────────────────────────────────────────────────────────
   gfx.js — a monochrome print shop.

   Everything is drawn as ink density on paper. Three kinds of plate:
     · the 2D plate  — a Canvas2D sheet for vector work (tessellations,
                        lettering). Red = ink × coverage, green = coverage.
     · the 3D plate  — WebGL meshes, shaded as engraving: hatch lines whose
                        weight follows the light, and a ruled edge on every face.
     · shader plates — full-screen fragment programs (hyperbolic tilings,
                        conformal spirals) that print straight to ink.
   A final pass stacks the plates and pulls the print: paper and ink can
   swap (white on black), locally or everywhere.
   ───────────────────────────────────────────────────────────────────────── */
var GFX = (function () {
'use strict';

let gl = null, canvas = null, capture = false;
let W = 0, H = 0, cssW = 0, cssH = 0, scale = 1;

/* ───────── shader plumbing ───────── */
function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    const lines = src.split('\n').map((l, i) => (i + 1) + ': ' + l).join('\n');
    throw new Error('shader: ' + log + '\n' + lines.slice(0, 6000));
  }
  return s;
}
function program(vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    const name = info.name.replace(/\[0\]$/, '');
    u[name] = gl.getUniformLocation(p, info.name);
  }
  return { p, u };
}
function setU(P, name, v) {
  const loc = P.u[name];
  if (loc === undefined || loc === null) return;
  if (typeof v === 'number') gl.uniform1f(loc, v);
  else if (v.length === 2) gl.uniform2fv(loc, v);
  else if (v.length === 3) gl.uniform3fv(loc, v);
  else if (v.length === 4) gl.uniform4fv(loc, v);
  else if (v.length === 16) gl.uniformMatrix4fv(loc, false, v);
  else if (v.length === 9) gl.uniformMatrix3fv(loc, false, v);
  else gl.uniform4fv(loc, v); // arrays of vec4
}
const FSQ_VS = `#version 300 es
layout(location=0) in vec2 aP;
out vec2 vUV;
void main(){ vUV = aP * 0.5 + 0.5; gl_Position = vec4(aP, 0.0, 1.0); }`;

function texture(w, h, opts) {
  opts = opts || {};
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, opts.min || gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, opts.wrap || gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, opts.wrap || gl.CLAMP_TO_EDGE);
  if (w) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  return t;
}

/* ───────── state ───────── */
let quad = null;
let compP = null, meshP = null;
const scenes = {};             // name → program (full-screen ink shaders)
const tex2d = { cv: null, ctx: null, tex: null };
const three = { ms: null, msColor: null, msDepth: null, fbo: null, tex: null, samples: 4 };
const plate = { fbo: null, tex: null };
const extraTex = {};           // name → { tex, w, h }

const COMP_FS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 o;
uniform sampler2D uA, uB, uC;      // shader plate, 3D plate, 2D plate
uniform vec3 uUse;
uniform vec3 uPaper, uInk;
uniform float uInvert;
uniform vec4 uWipe;                // centre (px), radius (px), feather (px); radius<0 = none
uniform float uWipeMode;           // 0 invert inside, 1 invert outside
uniform vec2 uRes;
uniform float uGrain, uVignette, uFade, uFadeTo;
uniform float uT;
float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void main(){
  float ink = 0.0;
  if (uUse.x > 0.5) { vec4 a = texture(uA, vUV); ink = a.r + (1.0 - a.g) * ink; }
  if (uUse.y > 0.5) { vec4 b = texture(uB, vUV); ink = b.r + (1.0 - b.g) * ink; }
  if (uUse.z > 0.5) { vec4 c = texture(uC, vUV); ink = c.r + (1.0 - c.g) * ink; }
  ink = clamp(ink, 0.0, 1.0);
  float inv = uInvert;
  if (uWipe.z > 0.0) {
    float d = length(gl_FragCoord.xy - uWipe.xy) - uWipe.z;
    float m = 1.0 - smoothstep(-uWipe.w, uWipe.w, d);
    if (uWipeMode > 0.5) m = 1.0 - m;
    inv = abs(inv - m);
  }
  ink = mix(ink, 1.0 - ink, inv);
  // fade the whole print toward paper (0) or ink (1)
  ink = mix(ink, uFadeTo, uFade);
  vec3 col = mix(uPaper, uInk, ink);
  // a whisper of paper tooth and a soft vignette
  vec2 q = vUV - 0.5; q.x *= uRes.x / uRes.y;
  col *= 1.0 - uVignette * smoothstep(0.35, 1.25, length(q));
  col += (h12(floor(gl_FragCoord.xy)) - 0.5) * uGrain;
  o = vec4(col, 1.0);
}`;

/* The engraving: tone from a fixed light, rendered as hatch lines in each
   face's own coordinates (so the lines stay on the surface as it moves),
   cross-hatched in the shadows, with a ruled line along every face border. */
const MESH_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec2 aUV;
layout(location=3) in vec3 aTU;
layout(location=4) in vec3 aTV;
layout(location=5) in vec4 aM0;
layout(location=6) in vec4 aM1;
layout(location=7) in vec4 aM2;
layout(location=8) in vec4 aM3;
layout(location=9) in vec4 aPar;
layout(location=10) in vec4 aPar2;
uniform mat4 uVP;
out vec3 vW; out vec3 vN; out vec2 vUV; out vec2 vDim; out vec4 vPar; out vec4 vPar2;
void main(){
  mat4 M = mat4(aM0, aM1, aM2, aM3);
  vec4 w = M * vec4(aPos, 1.0);
  mat3 M3 = mat3(M);
  vN = M3 * aNrm;
  vec2 dim = vec2(length(M3 * aTU), length(M3 * aTV));
  vDim = dim;
  vUV = aUV * dim;
  vW = w.xyz; vPar = aPar; vPar2 = aPar2;
  gl_Position = uVP * w;
}`;
const MESH_FS = `#version 300 es
precision highp float;
in vec3 vW; in vec3 vN; in vec2 vUV; in vec2 vDim; in vec4 vPar; in vec4 vPar2;
out vec4 o;
uniform vec3 uLight;
uniform vec3 uEye;          // direction toward the camera (orthographic)
uniform float uSpacing;     // hatch spacing in world units
uniform float uLineW;       // border line half-width in pixels
uniform float uHatchW;      // hatch line weight multiplier
uniform vec3 uCarveDir;     // fixed direction (world) along which far pieces are seen
uniform vec4 uCarveMin[6];
uniform vec4 uCarveMax[6];
uniform float uCarveN;
uniform float uFlat;        // 1 = flat tones instead of hatching
uniform float uNight;       // 1 = white-line engraving: ink marks the light
bool hitBox(vec3 ro, vec3 rd, vec3 bmin, vec3 bmax) {
  vec3 inv = 1.0 / rd;
  vec3 t0 = (bmin - ro) * inv, t1 = (bmax - ro) * inv;
  vec3 tmin = min(t0, t1), tmax = max(t0, t1);
  float a = max(max(tmin.x, tmin.y), tmin.z), b = min(min(tmax.x, tmax.y), tmax.z);
  return b > max(a, 0.0);
}
float lines(float x, float cover) {
  // x in line units; ink where the distance to the nearest line centre < cover/2
  float f = abs(fract(x) - 0.5) * 2.0;     // 1 at a line centre ... 0 halfway between
  f = 1.0 - f;                              // 0 at centre
  float w = fwidth(x) * 1.2;
  return 1.0 - smoothstep(cover - w, cover + w, f);
}
void main(){
  // carving: a near piece gives way wherever a far piece lies behind it
  if (vPar.z > 0.5) {
    int n = int(uCarveN + 0.5);
    for (int i = 0; i < 6; i++) {
      if (i >= n) break;
      if (hitBox(vW, -uCarveDir, uCarveMin[i].xyz, uCarveMax[i].xyz)) discard;
    }
  }
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  float lum = 0.14 + 0.92 * max(dot(n, normalize(uLight)), 0.0);
  // ink wanted: shadow by day; by night (a white-line print) the ink is the light
  float I = clamp(mix(1.0 - lum, lum, uNight) + vPar.x, 0.0, 1.0);
  float ink;
  if (uFlat > 0.5) {
    ink = floor(I * 3.0 + 0.5) / 3.0;
  } else {
    float ang = vPar.w;
    vec2 d1 = vec2(cos(ang), sin(ang)), d2 = vec2(-d1.y, d1.x);
    // one set of lines up to half cover, then a crossing set; the total ink tracks I
    float c1 = min(I, 0.5) * uHatchW;
    float c2 = clamp((I - 0.5) * 2.0, 0.0, 1.0) * uHatchW;
    float h1 = lines(dot(vUV, d1) / uSpacing, c1);
    float h2 = lines(dot(vUV, d2) / uSpacing, c2);
    ink = 1.0 - (1.0 - h1) * (1.0 - h2);
  }
  // ruled borders (per face, flags in vPar.y: 1 = all four, 2 = only v-borders)
  if (vPar.y > 0.5) {
    vec2 b = min(vUV, vDim - vUV);
    float bd = vPar.y > 1.5 ? b.y : min(b.x, b.y);
    float px = bd / max(length(fwidth(vUV)) * 0.7071, 1e-6);
    ink = max(ink, 1.0 - smoothstep(uLineW - 0.6, uLineW + 0.6, px));
  }
  ink = mix(ink, vPar2.x, vPar2.y);         // optional solid override (silhouettes)
  o = vec4(ink, 1.0, 0.0, 1.0);
}`;

/* ───────── init / layout ───────── */
function init(opts) {
  canvas = opts.canvas; capture = !!opts.capture;
  gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: capture, powerPreference: 'high-performance' });
  if (!gl) throw new Error('WebGL2 unavailable');
  quad = gl.createVertexArray();
  gl.bindVertexArray(quad);
  const vb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  compP = program(FSQ_VS, COMP_FS);
  meshP = program(MESH_VS, MESH_FS);
  three.samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) || 0);
  tex2d.cv = document.createElement('canvas');
  tex2d.ctx = tex2d.cv.getContext('2d', { alpha: false });
  tex2d.tex = texture(0, 0);
  layout();
}

function layout() {
  const el = document.body;
  cssW = Math.max(1, el.clientWidth || window.innerWidth);
  cssH = Math.max(1, el.clientHeight || window.innerHeight);
  const dpr = window.devicePixelRatio || 1;
  // keep the pixel count sane on very large screens
  const budget = capture ? 1e9 : 4.2e6;
  scale = Math.min(dpr, Math.sqrt(budget / (cssW * cssH)));
  W = Math.max(2, Math.round(cssW * scale));
  H = Math.max(2, Math.round(cssH * scale));
  canvas.width = W; canvas.height = H;
  canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
  tex2d.cv.width = W; tex2d.cv.height = H;
  // 3D plate: multisampled colour + depth, resolved into a texture
  if (three.ms) { gl.deleteFramebuffer(three.ms); gl.deleteRenderbuffer(three.msColor); gl.deleteRenderbuffer(three.msDepth); gl.deleteFramebuffer(three.fbo); gl.deleteTexture(three.tex); }
  three.ms = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, three.ms);
  three.msColor = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, three.msColor);
  if (three.samples > 1) gl.renderbufferStorageMultisample(gl.RENDERBUFFER, three.samples, gl.RGBA8, W, H);
  else gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, W, H);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, three.msColor);
  three.msDepth = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, three.msDepth);
  if (three.samples > 1) gl.renderbufferStorageMultisample(gl.RENDERBUFFER, three.samples, gl.DEPTH_COMPONENT24, W, H);
  else gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, W, H);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, three.msDepth);
  three.tex = texture(W, H);
  three.fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, three.fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, three.tex, 0);
  // shader plate
  if (plate.fbo) { gl.deleteFramebuffer(plate.fbo); gl.deleteTexture(plate.tex); }
  plate.tex = texture(W, H);
  plate.fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, plate.fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, plate.tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

/* ───────── the 2D plate ───────── */
function begin2D() {
  const c = tex2d.ctx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = 1;
  c.globalCompositeOperation = 'source-over';
  c.fillStyle = '#000';
  c.fillRect(0, 0, W, H);
  return c;
}
function upload2D() {
  gl.bindTexture(gl.TEXTURE_2D, tex2d.tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, tex2d.cv);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
}
// a small canvas uploaded as a named texture (tile motifs for the shader plates)
function uploadCanvas(name, cv, opts) {
  let e = extraTex[name];
  if (!e) { e = extraTex[name] = { tex: texture(0, 0, { wrap: (opts && opts.wrap) ? gl.REPEAT : gl.CLAMP_TO_EDGE, min: gl.LINEAR_MIPMAP_LINEAR }), w: 0, h: 0 }; }
  gl.bindTexture(gl.TEXTURE_2D, e.tex);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, cv);
  gl.generateMipmap(gl.TEXTURE_2D);
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
  e.w = cv.width; e.h = cv.height;
}

/* ───────── meshes ───────── */
const meshes = {};
// data: { pos, nrm, uv, tu, tv } flat arrays (triangles), optional idx
function mesh(name, d) {
  let m = meshes[name];
  if (!m) {
    m = meshes[name] = { vao: gl.createVertexArray(), bufs: [], inst: gl.createBuffer(), instCap: 0, count: 0, idx: null };
    gl.bindVertexArray(m.vao);
    const specs = [[0, 3], [1, 3], [2, 2], [3, 3], [4, 3]];
    for (const [loc, size] of specs) {
      const b = gl.createBuffer();
      m.bufs.push(b);
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, m.inst);
    const stride = 24 * 4;
    for (let i = 0; i < 4; i++) { gl.enableVertexAttribArray(5 + i); gl.vertexAttribPointer(5 + i, 4, gl.FLOAT, false, stride, i * 16); gl.vertexAttribDivisor(5 + i, 1); }
    gl.enableVertexAttribArray(9); gl.vertexAttribPointer(9, 4, gl.FLOAT, false, stride, 64); gl.vertexAttribDivisor(9, 1);
    gl.enableVertexAttribArray(10); gl.vertexAttribPointer(10, 4, gl.FLOAT, false, stride, 80); gl.vertexAttribDivisor(10, 1);
    gl.bindVertexArray(null);
  }
  const arrs = [d.pos, d.nrm, d.uv, d.tu, d.tv];
  gl.bindVertexArray(m.vao);
  arrs.forEach((a, i) => { gl.bindBuffer(gl.ARRAY_BUFFER, m.bufs[i]); gl.bufferData(gl.ARRAY_BUFFER, a instanceof Float32Array ? a : new Float32Array(a), d.dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW); });
  if (d.idx) {
    if (!m.idx) m.idx = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.idx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, d.idx instanceof Uint32Array ? d.idx : new Uint32Array(d.idx), d.dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
    m.count = d.idx.length; m.indexed = true;
  } else { m.count = d.pos.length / 3; m.indexed = false; }
  gl.bindVertexArray(null);
  return m;
}
let threeOpen = false;
function begin3D() {
  gl.bindFramebuffer(gl.FRAMEBUFFER, three.ms);
  gl.viewport(0, 0, W, H);
  gl.clearColor(0, 0, 0, 0);
  gl.clearDepth(1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  threeOpen = true;
}
// instances: Float32Array of 24 floats each (mat4 column-major, par, par2)
function draw(name, inst, count, U) {
  const m = meshes[name];
  if (!m || !count) return;
  gl.useProgram(meshP.p);
  for (const k in U) setU(meshP, k, U[k]);
  gl.bindVertexArray(m.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, m.inst);
  if (m.instCap < inst.length) { gl.bufferData(gl.ARRAY_BUFFER, inst.byteLength, gl.DYNAMIC_DRAW); m.instCap = inst.length; }
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, inst, 0, count * 24);
  if (U.cull) { gl.enable(gl.CULL_FACE); gl.cullFace(U.cull === 'front' ? gl.FRONT : gl.BACK); } else gl.disable(gl.CULL_FACE);
  if (m.indexed) gl.drawElementsInstanced(gl.TRIANGLES, m.count, gl.UNSIGNED_INT, 0, count);
  else gl.drawArraysInstanced(gl.TRIANGLES, 0, m.count, count);
  gl.bindVertexArray(null);
  gl.disable(gl.CULL_FACE);
}
function end3D() {
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, three.ms);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, three.fbo);
  gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.disable(gl.DEPTH_TEST);
  threeOpen = false;
}

/* ───────── shader plates ───────── */
const SC_HEAD = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 o;
uniform vec2 uRes;
uniform float uT;
uniform vec4 uP0, uP1, uP2, uP3, uP4, uP5;
uniform sampler2D uTex0, uTex1;
#define PI 3.14159265359
`;
function addScene(name, body) { scenes[name] = program(FSQ_VS, SC_HEAD + body); }
function runScene(name, U, texs) {
  const P = scenes[name];
  gl.bindFramebuffer(gl.FRAMEBUFFER, plate.fbo);
  gl.viewport(0, 0, W, H);
  gl.useProgram(P.p);
  setU(P, 'uRes', [W, H]);
  for (const k in U) setU(P, k, U[k]);
  let unit = 0;
  for (const k in (texs || {})) {
    const e = extraTex[texs[k]];
    if (!e) continue;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, e.tex);
    gl.uniform1i(P.u[k], unit);
    unit++;
  }
  gl.bindVertexArray(quad);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

/* ───────── the print ───────── */
// F: { use: [shader, 3d, 2d], paper, ink, invert, wipe:[x,y,r,feather], wipeMode, grain, vignette, fade, fadeTo }
function composite(F) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, W, H);
  gl.useProgram(compP.p);
  const tx = [plate.tex, three.tex, tex2d.tex];
  ['uA', 'uB', 'uC'].forEach((n, i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, tx[i]); gl.uniform1i(compP.u[n], i); });
  const use = F.use || [0, 0, 0];
  setU(compP, 'uUse', use);
  setU(compP, 'uPaper', F.paper || [0.945, 0.945, 0.937]);
  setU(compP, 'uInk', F.ink || [0.07, 0.07, 0.07]);
  setU(compP, 'uInvert', F.invert || 0);
  setU(compP, 'uWipe', F.wipe || [0, 0, -1, 1]);
  setU(compP, 'uWipeMode', F.wipeMode || 0);
  setU(compP, 'uRes', [W, H]);
  setU(compP, 'uGrain', F.grain === undefined ? 0.012 : F.grain);
  setU(compP, 'uVignette', F.vignette === undefined ? 0.06 : F.vignette);
  setU(compP, 'uFade', F.fade || 0);
  setU(compP, 'uFadeTo', F.fadeTo || 0);
  setU(compP, 'uT', F.T || 0);
  gl.bindVertexArray(quad);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
}

return {
  init, layout, begin2D, upload2D, uploadCanvas, mesh, begin3D, draw, end3D, addScene, runScene, composite,
  get gl() { return gl; }, get W() { return W; }, get H() { return H; }, get cssW() { return cssW; }, get cssH() { return cssH; }, get scale() { return scale; },
};
})();
