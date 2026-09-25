/* ─────────────────────────────────────────────────────────────────────────
   scenes.js — the timeline. Every frame is a pure function of the music
   clock, so picture and sound stay locked and seeking just works.

   §1  0:00  title → checkerboard → birds          D minor
   §2  0:15  sky and water; day turns to night      E major → E minor
   §3  0:30  cubes, the impossible triangle, the endless stairs   F♯ minor
   §4  0:45  the Möbius strip                      A♭ major
   §5  1:00  circle limit                          B♭ minor
   §6  1:15  the print gallery, back to the title  C minor → D
   ───────────────────────────────────────────────────────────────────────── */
var SCENES = (function () {
'use strict';

const BAR = SYNTH.BAR, STEP = SYNTH.STEP, BEAT = SYNTH.BEAT, T = SYNTH.T;
const PIECE = SYNTH.PIECE;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const sat = (x) => clamp(x, 0, 1);
const ss = (a, b, x) => { const t = sat((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const easeIO = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const back = (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };

const INK = '#ff0', PAPER = '#0f0';     // 2D plate colours: R = ink × cover, G = cover

let music = null, score = null;
const ENV = {};
let calm = false;

/* ───────── music helpers ───────── */
function setMusic(out) {
  music = out; score = out.score;
}
function env(name, t) {
  if (!music) return 0;
  const s = music.stems.indexOf(name);
  if (s < 0) return 0;
  const f = t * music.envRate, i = clamp(Math.floor(f), 0, music.frames - 2), fr = sat(f - i);
  const b = s * music.frames;
  return music.env[b + i] + (music.env[b + i + 1] - music.env[b + i]) * fr;
}
// time since the latest event at or before t (Infinity if none); list of numbers or [t, ...]
function since(list, t) {
  if (!list || !list.length) return Infinity;
  let lo = 0, hi = list.length - 1, best = -1;
  const at = (k) => (typeof list[k] === 'number' ? list[k] : list[k][0]);
  while (lo <= hi) { const m = (lo + hi) >> 1; if (at(m) <= t) { best = m; lo = m + 1; } else hi = m - 1; }
  return best < 0 ? Infinity : t - at(best);
}
function lastIndex(list, t) {
  let lo = 0, hi = list.length - 1, best = -1;
  const at = (k) => (typeof list[k] === 'number' ? list[k] : list[k][0]);
  while (lo <= hi) { const m = (lo + hi) >> 1; if (at(m) <= t) { best = m; lo = m + 1; } else hi = m - 1; }
  return best;
}
const hit = (list, t, decay) => { const d = since(list, t); return d === Infinity ? 0 : Math.exp(-d / decay); };

/* ───────── 2D helpers ───────── */
function view2D(cx, cy, s, rot) {
  const W = GFX.W, H = GFX.H, c = Math.cos(rot || 0), sn = Math.sin(rot || 0);
  const a = s * c, b = -s * sn, cc = -s * sn, d = -s * c;
  return [a, b, cc, d, W / 2 - (a * cx + cc * cy), H / 2 - (b * cx + d * cy)];
}
function toScreen(v, x, y) { return [v[0] * x + v[2] * y + v[4], v[1] * x + v[3] * y + v[5]]; }
function toWorld(v, px, py) {
  const [a, b, c, d, e, f] = v, det = a * d - b * c;
  px -= e; py -= f;
  return [(d * px - c * py) / det, (-b * px + a * py) / det];
}

/* ───────── the title ───────── */
let TL = null;          // title layout cache
function titleLayout() {
  const W = GFX.W, H = GFX.H;
  const key = W + 'x' + H;
  if (TL && TL.key === key) return TL;
  const one = W / H > 1.15;
  const L = TILES.lettering(one ? ['STRANGE LOOP'] : ['STRANGE', 'LOOP']);
  const s = Math.min(W * (one ? 0.8 : 0.84) / L.width, H * (one ? 0.3 : 0.36) / L.height);
  const set = new Map();
  let i0 = 1e9, i1 = -1e9, j0 = 1e9, j1 = -1e9;
  for (const c of L.cells) { set.set(c.i + ',' + c.j, c.code); i0 = Math.min(i0, c.i); i1 = Math.max(i1, c.i + 1); j0 = Math.min(j0, c.j); j1 = Math.max(j1, c.j + 1); }
  // title, subtitle and play button form one block, centred on the screen
  const sub = Math.max(12, Math.min(W * 0.045, s * 2.2, H * 0.05));      // subtitle size, px
  const gapSub = 2.2 * s + sub * 0.5, gapBtn = sub * 2.6, btnR = sub * 0.9;
  const total = (j1 - j0) * s + gapSub + gapBtn + btnR;
  const cx = (i0 + i1) / 2;
  const cy = j1 - total / (2 * s);
  TL = { key, one, L, s, set, cx, cy, top: j1, bottom: j0, sub, gapSub, gapBtn, btnR };
  return TL;
}
function quadOf(code) { return TILES.QUADS[code] || TILES.QUADS['.']; }

// draw the grid of cells, each morphing from its title state to its checkerboard state
function drawLetterGrid(ctx, v, t, o) {
  const L = titleLayout();
  const [x0, x1, y0, y1] = TILES.visibleCells(v, GFX.W, GFX.H, 1);
  const path = new Path2D();
  const P = (i, j, q) => { const a = toScreen(v, i + q[0], j + q[1]); return a; };
  // only the lettering itself unless the whole board is turning over
  let list;
  if (o.flip) {
    list = [];
    if ((x1 - x0) * (y1 - y0) < 60000) for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) list.push([i, j]);
  } else list = L.L.cells.map((c) => [c.i, c.j]);
  for (const [i, j] of list) {
    const code = L.set.get(i + ',' + j) || '.';
    const black = ((i + j) & 1) === 0;
    const endCode = black ? '#' : '.';
    let p = 0;
    if (o.flip) {
      const d = Math.hypot((i + 0.5 - L.cx) * 0.55, (j + 0.5 - (L.top + L.bottom) / 2) * 1.0);
      let tf = o.flipAt + 0.05 + d * o.flipRate;
      tf = o.flipAt + Math.round((tf - o.flipAt) / (STEP / 2)) * (STEP / 2);
      p = sat((t - tf) / 0.3);
      p = p < 1 ? back(p) : 1;
    }
    let appear = 1;
    if (o.appear !== undefined && code !== '.') {
      const k = (i + L.L.width / 2) / L.L.width;
      appear = back(sat((t - (o.appear + k * 0.9)) / 0.35));
    }
    if (code === '.' && p <= 0) continue;
    if (code === endCode && code === '#' && p > 0 && appear >= 1) { /* unchanged solid cell */ }
    const qa = quadOf(code), qb = quadOf(endCode);
    const q = [0, 1, 2, 3].map((k) => {
      let x = lerp(qa[k][0], qb[k][0], p), y = lerp(qa[k][1], qb[k][1], p);
      if (appear < 1) { x = 0.5 + (x - 0.5) * appear; y = 0.5 + (y - 0.5) * appear; }
      return [x, y];
    });
    const area = Math.abs((q[2][0] - q[0][0]) * (q[3][1] - q[1][1]) - (q[3][0] - q[1][0]) * (q[2][1] - q[0][1]));
    if (area < 1e-4) continue;
    const a = P(i, j, q[0]); path.moveTo(a[0], a[1]);
    for (let k = 1; k < 4; k++) { const b = P(i, j, q[k]); path.lineTo(b[0], b[1]); }
    path.closePath();
  }
  ctx.fillStyle = INK;
  ctx.fill(path);
}
function drawSubtitle(ctx, v, alpha, yShift) {
  const L = titleLayout();
  const W = GFX.W;
  const k = Math.abs(v[0]) / L.s;                       // current zoom relative to the title card
  const base = toScreen(v, L.cx, L.bottom);
  const size = L.sub * k;
  const y = base[1] + L.gapSub * k + (yShift || 0);
  if (alpha > 0.002 && size > 0.5) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = INK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `italic 500 ${size.toFixed(2)}px "Cormorant Garamond", "EB Garamond", Garamond, Georgia, serif`;
    ctx.fillText('a homage to M. C. Escher', base[0], y);
    ctx.restore();
  }
  return [base[0], y + L.gapBtn * k, L.btnR * k];
}
let BUTTON = null;
function drawButton(ctx, at, st, tw) {
  const [x, y, r] = at;
  const W = GFX.W;
  ctx.save();
  // the progress ring while the music is being synthesized
  ctx.lineWidth = Math.max(1.5, r * 0.09);
  ctx.strokeStyle = INK;
  if (!st.ready) {
    ctx.globalAlpha = 0.25;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp(st.progress, 0, 1)); ctx.stroke();
  } else {
    const pulse = 1 + 0.04 * Math.sin(tw * 2.4);
    ctx.beginPath(); ctx.arc(x, y, r * pulse, 0, Math.PI * 2);
    if (st.hover) { ctx.fillStyle = INK; ctx.fill(); } else ctx.stroke();
    // play triangle
    ctx.fillStyle = st.hover ? PAPER : INK;
    const k = r * 0.42;
    ctx.beginPath(); ctx.moveTo(x - k * 0.55, y - k); ctx.lineTo(x + k * 0.95, y); ctx.lineTo(x - k * 0.55, y + k); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
  BUTTON = [x / GFX.scale, y / GFX.scale, r / GFX.scale];
  void W;
}

/* ───────── §1–§2: the plane divided ───────── */
const S1 = { s1: 1 };
function planeCamera(t) {
  const L = titleLayout();
  const W = GFX.W, H = GFX.H;
  const s0 = L.s, s1 = Math.min(W, H) / (W > H ? 4.3 : 4.1);
  // zoom from the lettering to creature size across bars 3–5
  const z = easeIO(sat((t - T(3)) / (T(4, 10) - T(3))));
  let s = Math.exp(lerp(Math.log(s0), Math.log(s1), z));
  let cx = L.cx, cy = L.cy;
  // then the flight: pan right (the birds fly left), easing to a stop as the plane turns solid
  const vx = 0.42;
  // velocity: +vx from bar 6, turning to −vx across the inversion at bar 12, easing to rest by bar 15
  const velAt = (tt) => {
    let v0 = vx * (1 - Math.exp(-Math.max(0, tt - T(6)) / 0.9)) * (tt > T(6) ? 1 : 0);
    v0 *= lerp(1, -0.85, ss(T(12) - 0.1, T(12) + 0.6, tt));
    v0 *= 1 - ss(T(14), T(15), tt);
    return v0;
  };
  // integrate (fixed small steps; cheap and exact enough)
  let xx = 0;
  const t1 = Math.min(t, T(15));
  if (t1 > T(6)) { const n = Math.ceil((t1 - T(6)) / 0.02); const dt = (t1 - T(6)) / n; for (let k = 0; k < n; k++) xx += velAt(T(6) + (k + 0.5) * dt) * dt; }
  cx += xx;
  const down = ss(T(8), T(12), t);
  cy -= down * 7.5 + ss(T(12), T(14), t) * 1.5;
  // a breath on the kicks, and a slow roll — both gone before the handoff
  const settle = 1 - ss(T(13), T(14, 6), t);
  const kick = hit(score && score.kick, t, 0.12) * (t > T(8) ? 1 : 0) * settle;
  s *= 1 + 0.012 * kick;
  const rot = (t > T(8) ? 0.035 * Math.sin((t - T(8)) * 0.35) : 0) * settle;
  return { cx, cy, s, rot };
}
// morph state of the division at a world point
function divisionAt(t, cam, mirrored) {
  const W = GFX.W, H = GFX.H;
  const yBand = cam0y() - 3.2;         // birds above this line, fish below
  const A = mirrored ? TILES.DESIGNS.birdR : TILES.DESIGNS.bird, B = mirrored ? TILES.DESIGNS.fishR : TILES.DESIGNS.fish;
  return (x, y) => {
    // metamorphosis wave out of the checkerboard (bars 4–6½): sweeps across the screen
    const sx = (x - cam.cx) * cam.s / W, sy = (y - cam.cy) * cam.s / H;
    let m;
    if (t < T(14)) {
      const p = (t - T(4)) / (T(6, 6) - T(4));
      m = ss(0, 1, p * 1.35 - 0.35 * (0.5 + 0.5 * clamp(sx * 1.2 - sy * 0.8, -1, 1)));
    } else {
      // back into squares at the end of §2
      const p = (t - T(14)) / (T(15) - T(14));
      m = 1 - ss(0, 1, p * 1.3 - 0.3 * (0.5 + 0.5 * clamp(-sx * 1.2 + sy * 0.8, -1, 1)));
    }
    const u = ss(yBand + 1.2, yBand - 2.2, y);
    return { m, A, B, u };
  };
}
function cam0y() { return titleLayout().cy; }

function drawPlane(t, F) {
  const ctx = GFX.begin2D();
  const cam = planeCamera(t);
  const v = view2D(cam.cx, cam.cy, cam.s, cam.rot);
  if (t < T(4, 2)) {
    // the piece opens on the very card it ends on
    drawLetterGrid(ctx, v, t, { flip: t >= T(2) - 0.1, flipAt: T(2), flipRate: 0.085 });
    const subA = t < T(2) ? 1 : 1 - ss(T(2), T(2, 8), t);
    drawSubtitle(ctx, v, subA);
  } else {
    const w0 = T(12) - 0.02;
    const R = Math.hypot(GFX.W, GFX.H) * 0.55;
    const r = t >= w0 ? easeOut(sat((t - w0) / 0.55)) * R : 0;
    const opts = (mir) => ({ at: divisionAt(t, cam, mir), ink: INK, paper: PAPER, lineW: 0.024 });
    if (r <= 0) TILES.drawChecker(ctx, v, GFX.W, GFX.H, opts(false));
    else if (r >= R * 0.999) TILES.drawChecker(ctx, v, GFX.W, GFX.H, opts(true));
    else {
      // outside the growing circle, day; inside it, night — and every animal turned round
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, GFX.W, GFX.H); ctx.arc(GFX.W / 2, GFX.H / 2, r, 0, Math.PI * 2, true); ctx.clip('evenodd');
      TILES.drawChecker(ctx, v, GFX.W, GFX.H, opts(false));
      ctx.restore();
      ctx.save(); ctx.beginPath(); ctx.arc(GFX.W / 2, GFX.H / 2, r, 0, Math.PI * 2); ctx.clip();
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, GFX.W, GFX.H);
      TILES.drawChecker(ctx, v, GFX.W, GFX.H, opts(true));
      ctx.restore();
    }
  }
  GFX.upload2D();
  F.use[2] = 1;
  // day → night: the picture inverts outward from the centre on the downbeat of bar 12
  const w0 = T(12) - 0.02;
  if (t >= w0) {
    const R = Math.hypot(GFX.W, GFX.H) * 0.55;
    const r = easeOut(sat((t - w0) / 0.55)) * R;
    if (r < R * 0.999) { F.wipe = [GFX.W / 2, GFX.H / 2, Math.max(0.5, r), 2.5 * GFX.scale]; }
    else F.invert = 1;
  }
}

/* ───────── §2½–§4: the solid world ─────────
   Orthographic cameras only: an impossible figure here is a real object whose
   gap points straight at the viewer. Walk the camera away and the trick shows. */
const V3 = GEO.v3;
const PHI_ISO = Math.atan(1 / Math.SQRT2);           // the isometric elevation, 35.26°
const PHI_ST = Math.atan(7.2 / (4 * Math.SQRT2));    // the stairs' magic elevation, 51.8°
const DEG = Math.PI / 180;
const LIGHT = [0.3, 0.55, 1.0];
const batch = new GEO.Batch(2400), batch2 = new GEO.Batch(400), batch3 = new GEO.Batch(600);

function camera3D(tgt, phi, theta, halfH) {
  const v = [Math.cos(phi) * Math.cos(theta), Math.cos(phi) * Math.sin(theta), Math.sin(phi)];
  const up = [-Math.sin(phi) * Math.cos(theta), -Math.sin(phi) * Math.sin(theta), Math.cos(phi)];
  const eye = V3.add(tgt, V3.mul(v, 80));
  const view = GEO.lookAt(eye, tgt, up);
  const aspect = GFX.W / GFX.H;
  const proj = GEO.ortho(halfH * aspect, halfH, 1, 220);
  return { VP: GEO.mul(proj, view), v, up, ppu: GFX.H / (2 * halfH), halfH, tgt };
}
function uniforms3D(cam, o) {
  o = o || {};
  const spacingPx = Math.max(4.4, 5.6 * GFX.scale) * (o.hatch || 1);
  const U = {
    uVP: cam.VP, uLight: o.light || LIGHT, uEye: cam.v, uSpacing: spacingPx / cam.ppu,
    uLineW: Math.max(0.7, 0.85 * GFX.scale) * (o.line || 1), uHatchW: 1, uFlat: 0, uNight: o.night || 0,
    uCarveDir: o.carveDir || cam.v, uCarveN: 0, uCarveMin: new Float32Array(24), uCarveMax: new Float32Array(24),
  };
  (o.carve || []).forEach((b, i) => { U.uCarveMin.set([b[0][0], b[0][1], b[0][2], 0], i * 4); U.uCarveMax.set([b[1][0], b[1][1], b[1][2], 0], i * 4); });
  U.uCarveN = (o.carve || []).length;
  return U;
}
// the 2D camera, frozen at the moment the plane becomes solid
let HAND = null;
function handoff() {
  const key = GFX.W + 'x' + GFX.H;
  if (HAND && HAND.key === key) return HAND;
  const c = planeCamera(T(15));
  const v = view2D(c.cx, c.cy, c.s, 0);
  const [x0, x1, y0, y1] = TILES.visibleCells(v, GFX.W, GFX.H, 1);
  const cells = [];
  for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) if (((i + j) & 1) === 0) cells.push([i, j]);
  const ctr = [c.cx, c.cy];
  cells.forEach((q) => { q.d = Math.hypot(q[0] + 0.5 - ctr[0], q[1] + 0.5 - ctr[1]); });
  // the nine cubes of Reutersvärd's triangle (1934), and the three bars of Penrose's (1958)
  const slots = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0], [3, 1, 0], [3, 2, 0], [3, 3, 0], [3, 3, 1], [3, 3, 2]];
  const mean = slots.reduce((a, b) => V3.add(a, b), [0, 0, 0]).map((x) => x / slots.length + 0.5);
  const origin = [Math.round(ctr[0] - mean[0]), Math.round(ctr[1] - mean[1]), 0];
  const R = slots.map((q) => V3.add(origin, q));
  // pick the risen cube nearest each slot (by its footprint)
  const used = new Set(), pickIx = [];
  R.forEach((q) => {
    let best = -1, bd = 1e9;
    cells.forEach((c, k) => { if (used.has(k)) return; const d = Math.hypot(c[0] - q[0], c[1] - q[1]) + (q[2] > 0 ? 0.01 : 0); if (d < bd) { bd = d; best = k; } });
    used.add(best); pickIx.push(best);
  });
  const triCentre = V3.add(origin, [2, 1.5, 1]);
  HAND = { key, cam: c, cells, slots: R, pickIx, origin, triCentre };
  return HAND;
}

// frame a set of points as the camera at (phi, theta) would see them: centre and half-height
function frameFor(points, phi, theta, margin) {
  const v = [Math.cos(phi) * Math.cos(theta), Math.cos(phi) * Math.sin(theta), Math.sin(phi)];
  const up = [-Math.sin(phi) * Math.cos(theta), -Math.sin(phi) * Math.sin(theta), Math.cos(phi)];
  const right = V3.norm(V3.cross(V3.mul(v, -1), up));
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, d = 0;
  for (const p of points) {
    const x = V3.dot(p, right), y = V3.dot(p, up);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); d += V3.dot(p, v);
  }
  d /= points.length;
  const tgt = V3.add(V3.add(V3.mul(right, (x0 + x1) / 2), V3.mul(up, (y0 + y1) / 2)), V3.mul(v, d));
  const aspect = GFX.W / GFX.H;
  const half = Math.max((y1 - y0) / 2, (x1 - x0) / 2 / aspect) * (margin || 1.15);
  return { tgt, half };
}
const corners = (min, max) => { const o = []; for (let k = 0; k < 8; k++) o.push([(k & 1) ? max[0] : min[0], (k & 2) ? max[1] : min[1], (k & 4) ? max[2] : min[2]]); return o; };
// box helpers
const bx = (min, max) => [V3.mul(V3.add(min, max), 0.5), V3.mul(V3.sub(max, min), 0.5)];
function pushAABB(b, min, max, par, par2) { const [c, h] = bx(min, max); b.box(c, h, null, par, par2); }

// the stair loop: twenty square treads rising 0.15 each; the loop's gap is (2,2,3), along the magic view
const STAIRS = (() => {
  const P = [];
  for (let k = 0; k < 8; k++) P.push([k, 0]);
  for (let k = 0; k < 8; k++) P.push([8, k]);
  for (let k = 0; k < 4; k++) P.push([8 - k, 8]);
  for (let k = 0; k < 4; k++) P.push([4, 8 - k]);
  const N = P.length, dz = 0.3, H = N * dz;
  const slabs = P.map((q, k) => ({ c: [q[0], q[1], k * dz], k }));
  const drift = [4, 4, H];
  const centre = slabs.reduce((a, b) => V3.add(a, b.c), [0, 0, 0]).map((x) => x / N);
  return { N, H, dz, slabs, drift, centre };
})();
// a point along the stair loop at continuous index p (wraps with the drift, invisibly)
function stairPoint(p) {
  const N = STAIRS.N;
  const w = Math.floor(p / N);
  const q = p - w * N;
  const i = Math.floor(q), f = q - i;
  const a = STAIRS.slabs[i].c;
  let b = i + 1 < N ? STAIRS.slabs[i + 1].c : V3.add(STAIRS.slabs[0].c, STAIRS.drift);
  const pos = V3.lerp(a, b, f);
  const dir = V3.norm(V3.sub(b, a));
  return { pos: V3.add(pos, V3.mul(STAIRS.drift, w)), dir, i, f };
}
const TRI_TO_STAIR = (() => {
  // places along the tribar's centre line (9 units, closing on itself in the picture)
  const pts = [];
  for (let k = 0; k < STAIRS.N; k++) {
    const u = (k + 0.5) / STAIRS.N * 9;
    let c;
    if (u < 3.5) c = [0.5 + u, 0.5, 0.5];
    else if (u < 6.5) c = [3.5, 0.5 + (u - 3.5), 0.5];
    else c = [3.5, 3.5, 0.5 + (u - 6.5)];
    pts.push(c);
  }
  return pts;
})();


// the Möbius strip: the same twenty-four treads, on a circle, turned half a turn over one lap
const MOB = {
  R: 4.1, len: 1.0, thick: 0.16,
  width: (t) => lerp(2.1, 1.3, ss(T(29, 6), T(31, 6), t)),
  spin: (t) => { const a = Math.max(0, t - T(24)); return 0.07 * a + 0.05 * a * a * ss(T(28), T(31), t) / 8; },
  centre: () => handoff().triCentre,
  stairFrame(k) {
    const N = STAIRS.N;
    const a = STAIRS.slabs[k].c, b = k + 1 < N ? STAIRS.slabs[k + 1].c : V3.add(STAIRS.slabs[0].c, STAIRS.drift);
    const x = V3.norm([b[0] - a[0], b[1] - a[1], 0]);
    return { x, z: [0, 0, 1] };
  },
  // frame on the strip's centre line at loop parameter u ∈ [0,1)
  surface(u, twist, spin) {
    const al = MOB.a0() + u * Math.PI * 2 + spin;
    const rad = [Math.cos(al), Math.sin(al), 0], tan = [-Math.sin(al), Math.cos(al), 0];
    const tau = Math.PI * u * twist;
    const y = V3.add(V3.mul(rad, Math.cos(tau)), V3.mul([0, 0, 1], Math.sin(tau)));
    const z = V3.add(V3.mul(rad, -Math.sin(tau)), V3.mul([0, 0, 1], Math.cos(tau)));
    return { c: V3.add(MOB.centre(), V3.mul(rad, MOB.R)), x: tan, y, z };
  },
  ringFrame(k, twist, spin) { return MOB.surface((k + 0.5) / STAIRS.N, twist, spin); },
  a0() {
    // start the circle where slab 0 already is, so the ring forms with little travel
    if (MOB._a0 === undefined) {
      const H0 = handoff(), so = V3.sub(H0.triCentre, STAIRS.centre);
      const c = V3.sub(V3.add(so, STAIRS.slabs[0].c), H0.triCentre);
      MOB._a0 = Math.atan2(c[1], c[0]) - 0.5 / STAIRS.N * Math.PI * 2;
    }
    return MOB._a0;
  },
  // looking straight down at the end, the ring's outer edge sits on the circle limit
  topHalf() { return (MOB.R + 0.65) * GFX.H / (2 * DISK_FRAC * Math.min(GFX.W, GFX.H)); },
};
const DISK_FRAC = 0.46;   // the Poincaré disk's radius, as a fraction of the shorter screen side

function monkMesh() {
  return GEO.merge([
    { data: GEO.frustum(12, 0.3, 0.16), M: GEO.scaleM(1, 0.9, 0.58, [0, 0, 0]) },
    { data: GEO.sphere(12, 8), M: GEO.scaleM(0.36, 0.32, 0.4, [0.05, 0, 0.66]) },
    { data: GEO.frustum(10, 0.1, 0.02), M: GEO.basis([0, 0, -0.2], [0, 0.9, 0], [-0.2, 0, 0], [-0.1, 0, 0.84]) },
  ]);
}
function antMesh() {
  const parts = [
    { data: GEO.sphere(8, 5), M: GEO.scaleM(0.34, 0.2, 0.2, [-0.3, 0, 0.14]) },
    { data: GEO.sphere(8, 5), M: GEO.scaleM(0.18, 0.13, 0.13, [0, 0, 0.14]) },
    { data: GEO.sphere(8, 5), M: GEO.scaleM(0.17, 0.15, 0.14, [0.2, 0, 0.16]) },
  ];
  return GEO.merge(parts);
}

function drawSolid(t, F, fadeOut) {
  const H0 = handoff();
  const night = t < T(24) ? 1 : 0;
  GFX.begin3D();
  batch.reset(); batch2.reset(); batch3.reset();
  let cam, carve = [], carveDir = V3.norm([1, 1, 1]);
  const aspect = GFX.W / GFX.H;
  const fitH = (hw, hh) => Math.max(hh, hw / aspect);
  const topHalf = GFX.H / (2 * H0.cam.s);
  H0.triPts = H0.triPts || [].concat(...[[[0, 0, 0], [4, 1, 1]], [[3, 1, 0], [4, 4, 1]], [[3, 3, 1], [4, 4, 3]]].map(([a, b]) => corners(V3.add(H0.origin, a), V3.add(H0.origin, b))));
  const TRI = H0.triFrame || (H0.triFrame = frameFor(H0.triPts, PHI_ISO, Math.PI / 4, aspect < 1 ? 1.12 : 1.22));
  const triHalf = TRI.half;
  const stairOriginF = V3.sub(H0.triCentre, STAIRS.centre);
  const STF = H0.stairFrame || (H0.stairFrame = frameFor([].concat(...STAIRS.slabs.map((sl) => corners(V3.add(stairOriginF, V3.add(sl.c, [-0.5, -0.5, -1])), V3.add(stairOriginF, V3.add(sl.c, [0.5, 0.5, 0]))))), PHI_ST, Math.PI / 4, aspect < 1 ? 1.08 : 1.16));
  const stairHalf = STF.half;
  // ── camera ──
  if (t < T(16)) {
    const p = easeIO(sat((t - T(15)) / (T(16) - T(15))));
    const phi = lerp(Math.PI / 2 - 1e-4, PHI_ISO, p), theta = lerp(-Math.PI / 2, Math.PI / 4, p);
    const tgt = V3.lerp([H0.cam.cx, H0.cam.cy, 0], [H0.cam.cx, H0.cam.cy, 0.5], p);
    cam = camera3D(tgt, phi, theta, lerp(topHalf, topHalf * 0.8, p));
  } else if (t < T(20)) {
    const z = easeIO(sat((t - T(16)) / (T(17, 6) - T(16))));
    let theta = Math.PI / 4, phi = PHI_ISO;
    const r = (t - T(18)) / (T(20) - T(18));
    if (r > 0) { const e = Math.sin(Math.PI * Math.pow(sat(r), 0.85)); theta += 44 * DEG * e; phi += 16 * DEG * e * (1 - r); }
    // while circling, keep the real shape framed (its silhouette wanders as the view turns)
    const fr = r > 0 ? frameFor(H0.triPts, phi, theta, aspect < 1 ? 1.12 : 1.22) : TRI;
    const tgt = V3.lerp([H0.cam.cx, H0.cam.cy, 0.5], fr.tgt, z);
    cam = camera3D(tgt, phi, theta, lerp(topHalf * 0.8, Math.max(triHalf, fr.half), z) * (1 + 0.1 * Math.sin(Math.PI * sat(r))));
  } else if (t < T(24)) {
    const z = easeIO(sat((t - T(20, 2)) / (T(21, 4) - T(20, 2))));
    cam = camera3D(V3.lerp(TRI.tgt, STF.tgt, z), lerp(PHI_ISO, PHI_ST, z), Math.PI / 4, lerp(triHalf, stairHalf, z));
  } else {
    // §4: leave the magic view; circle the strip; at the end look straight down into the ring
    const a = t - T(24);
    const orbit = 45 * DEG + 0.23 * a * a / (a + 2.5);
    const up = ss(T(29, 6), T(31, 6), t);
    const phi = lerp(lerp(PHI_ST, 30 * DEG, ss(T(24), T(26), t)), Math.PI / 2 - 1e-4, easeIO(up));
    const theta = orbit;
    const ringHalf = fitH(6.4, 6.0);
    const topHalf2 = MOB.topHalf();
    cam = camera3D(V3.lerp(STF.tgt, H0.triCentre, ss(T(24), T(26), t)), phi, theta, lerp(lerp(stairHalf, ringHalf, ss(T(24), T(26), t)), topHalf2, easeIO(up)));
  }
  // ── §2½: the checkerboard rises ──
  if (t < T(18)) {
    const rise = (q) => { const t0 = T(15) + 0.04 + q.d * 0.075; return back(sat((t - t0) / 0.42)); };
    const picked = new Map(H0.pickIx.map((ix, k) => [ix, k]));
    H0.cells.forEach((q, k) => {
      const [i, j] = q;
      let h = Math.max(0.02, rise(q));
      const solid = 1 - ss(0.25, 0.9, h);
      if (picked.has(k) && t >= T(16)) {
        // fly to its slot in the triangle, one cube on every eighth note
        const s = picked.get(k);
        const t0 = T(16) + s * STEP, u = easeIO(sat((t - t0) / 0.5));
        const from = [i + 0.5, j + 0.5, 0.5], to = V3.add(H0.slots[s], [0.5, 0.5, 0.5]);
        const c = V3.lerp(from, to, u);
        c[2] += Math.sin(Math.PI * u) * 1.6;
        const settled = u >= 1 && t < T(17, 6);
        batch.box(c, [0.5, 0.5, 0.5], null, [0, 1, (s === 8 && settled) ? 1 : 0, 0.785]);
        return;
      }
      let dz = 0;
      if (t >= T(16)) {
        const t0 = T(16) + 0.02 + q.d * 0.03;
        const g = Math.max(0, t - t0);
        dz = -g * g * 9;
        if (dz < -40) return;
      }
      if (t >= T(17, 6)) return;
      pushAABB(batch, [i, j, dz], [i + 1, j + 1, dz + h], [0, 1, 0, 0.785], [1, solid, 0, 0]);
    });
    if (t >= T(17, 3)) carve = [[H0.slots[0], V3.add(H0.slots[0], [1, 1, 1])]];
  }
  // ── the tribar: the nine cubes fuse into three bars ──
  if (t >= T(17, 6) && t < T(20, 8)) {
    const o = H0.origin;
    const A = [V3.add(o, [0, 0, 0]), V3.add(o, [4, 1, 1])];
    const Bb = [V3.add(o, [3, 1, 0]), V3.add(o, [4, 4, 1])];
    const C = [V3.add(o, [3, 3, 1]), V3.add(o, [4, 4, 3])];
    if (t < T(20, 2)) {
      pushAABB(batch, A[0], A[1], [0, 1, 0, 0.785]);
      pushAABB(batch, Bb[0], Bb[1], [0, 1, 0, 0.785]);
      pushAABB(batch, C[0], C[1], [0, 1, 1, 0.785]);
      carve = [A];
    }
  }
  // ── the tribar comes apart into the twenty treads of the endless stairs ──
  const stairOrigin = V3.sub(H0.triCentre, STAIRS.centre);
  if (t >= T(20, 2) && t < T(24) + BEAT) {
    const u0 = T(20, 2);
    if (t < T(24)) {
    STAIRS.slabs.forEach((sl, k) => {
      const tt = easeIO(sat((t - u0 - k * 0.022) / (T(21, 4) - u0)));
      const from = V3.add(H0.origin, TRI_TO_STAIR[k]);
      const to = V3.add(stairOrigin, V3.add(sl.c, [0, 0, -0.5]));
      const c = V3.lerp(from, to, tt);
      c[2] += Math.sin(Math.PI * tt) * 0.8 * ((k & 1) ? 1 : -0.6);
      const h = [lerp(0.19, 0.5, tt), 0.5, 0.5];
      batch.box(c, h, null, [0, 1, 0, 0.785]);
    });
    }
    // the walkers: up one step on every beat; the ones in front go the other way
    if (t >= T(21) && t < T(24) + BEAT) {
      const appear = ss(T(21), T(21, 6), t) * (1 - ss(T(24) - 0.05, T(24) + BEAT, t));
      const beats = (t - T(21)) / BEAT;
      const walkers = [0, 3, 6, 9, 12, 15, 18, 21].map((p0) => ({ p0, dir: 1 })).concat([4.5, 16.5].map((p0) => ({ p0, dir: -1 })));
      walkers.forEach((w, n) => {
        const fb = Math.floor(beats), fr = beats - fb;
        const stepE = fr < 0.55 ? easeIO(fr / 0.55) : 1;
        const p = w.p0 + w.dir * (fb + stepE);
        const sp = stairPoint(((p % STAIRS.N) + STAIRS.N) % STAIRS.N + (p < 0 ? 0 : 0));
        const base = V3.add(stairOrigin, sp.pos);
        const topZ = base[2] + (sp.f > 0.5 ? STAIRS.dz * w.dir : 0) * 0 + 0.0;
        const hop = Math.sin(Math.PI * (fr < 0.55 ? fr / 0.55 : 0)) * 0.12;
        const pos = [base[0], base[1], topZ + hop];
        let d = w.dir > 0 ? sp.dir : V3.mul(sp.dir, -1);
        const fwd = V3.norm([d[0], d[1], 0]);
        const side = [-fwd[1], fwd[0], 0];
        const sc = 0.82 * appear;
        batch2.push(GEO.basis(V3.mul(fwd, sc), V3.mul(side, sc), [0, 0, sc], pos), [0.1, 0, 0, 0.785], [0, 1, 0, 0]);
        void n;
      });
    }
  }

  // ── §4: the stairs let go of their steps, close into a ring, and give it half a twist ──
  if (t >= T(24)) {
    const N = STAIRS.N;
    const flat = easeIO(sat((t - T(24)) / (T(25, 6) - T(24))));
    const twist = easeIO(sat((t - T(25)) / (T(27) - T(25)))) * (1 - easeIO(sat((t - T(30)) / (T(31, 6) - T(30)))));
    const spin = MOB.spin(t);
    STAIRS.slabs.forEach((sl, k) => {
      const f0 = MOB.stairFrame(k), f1 = MOB.ringFrame(k, twist, spin);
      const c = V3.lerp(V3.add(stairOrigin, V3.add(sl.c, [0, 0, -0.5])), f1.c, flat);
      const X = V3.norm(V3.lerp(f0.x, f1.x, flat));
      let Z = V3.lerp(f0.z, f1.z, flat); Z = V3.norm(V3.sub(Z, V3.mul(X, V3.dot(Z, X))));
      const Y = V3.cross(Z, X);
      const fo = fadeOut === undefined ? 1 : fadeOut;
      const h = [lerp(0.5, MOB.len / 2, flat) * fo, lerp(0.5, MOB.width(t) / 2, flat), lerp(0.5, MOB.thick / 2, flat) * fo];
      batch.box(c, h, [X, Y, Z], [0, 1, 0, lerp(0.785, 0, flat)]);
    });
    // the walkers shrink away; ants take their place and march over both sides of the one side
    const antsOn = ss(T(25, 6), T(26, 6), t) * (1 - ss(T(30, 6), T(31, 6), t));
    if (antsOn > 0.001) {
      const speed = 0.055 + 0.06 * ss(T(28), T(31), t);
      for (let a = 0; a < 9; a++) {
        const u = ((a / 9 + (t - T(25)) * speed) % 1 + 1) % 1;
        const fr = MOB.surface(u, twist, spin);
        const sc = 0.62 * antsOn;
        const pos = V3.add(fr.c, V3.mul(fr.z, MOB.thick / 2));
        batch2.push(GEO.basis(V3.mul(fr.x, sc), V3.mul(fr.y, sc), V3.mul(fr.z, sc), pos), [0, 0, 0, 0], [1, 1, 0, 0]);
        // six legs, rowing in two tripods on the sixteenth notes
        const ph = (t / STEP) * Math.PI;
        for (let l = 0; l < 6; l++) {
          const side = l < 3 ? 1 : -1, row = (l % 3) - 1;
          const swing = Math.sin(ph + (((l + (l < 3 ? 0 : 1)) & 1) ? Math.PI : 0)) * 0.12;
          const base = V3.add(pos, V3.add(V3.mul(fr.x, sc * (row * 0.12 + swing * 0.5)), V3.mul(fr.z, sc * 0.1)));
          const tip = V3.add(base, V3.add(V3.mul(fr.y, side * sc * 0.36), V3.add(V3.mul(fr.x, sc * (row * 0.14 + swing)), V3.mul(fr.z, -sc * 0.1))));
          const mid = V3.mul(V3.add(base, tip), 0.5), dir = V3.sub(tip, base), L = V3.len(dir);
          const lx = V3.norm(dir), lz = V3.norm(V3.cross(lx, fr.x)), ly = V3.cross(lz, lx);
          batch3.box(mid, [L / 2, 0.02, 0.02], [lx, ly, lz], [0, 0, 0, 0], [1, 1, 0, 0]);
        }
      }
    }
  }
  const U = uniforms3D(cam, { night, carve, carveDir });
  // the press: ink swells a little on every kick
  U.uHatchW = 1 + 0.14 * env('kick', t) * (t < T(24) || t > T(28) ? 1 : 0.3);
  GFX.draw('cube', batch.a, batch.n, U);
  if (batch2.n) GFX.draw(t >= T(24) ? 'ant' : 'monk', batch2.a, batch2.n, Object.assign({}, U, { uCarveN: 0 }));
  if (batch3.n) GFX.draw('cube', batch3.a, batch3.n, Object.assign({}, U, { uCarveN: 0 }));
  GFX.end3D();
  F.use[1] = 1;
  if (night) F.invert = 1;
  const w0 = T(24) - 0.02;
  if (t >= w0 && t < w0 + 0.6) {
    const R = Math.hypot(GFX.W, GFX.H) * 0.55, r = easeOut(sat((t - w0) / 0.6)) * R;
    F.invert = 1; F.wipe = [GFX.W / 2, GFX.H / 2, Math.max(0.5, r), 2.5 * GFX.scale];
  }
}
const EIGHTH_S = SYNTH.EIGHTH;

/* ───────── §5: circle limit ─────────
   The {6,4} tiling of the Poincaré disk: hexagons, four at every corner,
   black and white by turns. Each pixel is folded into one triangle of the
   (6,4,2) reflection group, counting mirrors on the way; hexagon edges are
   bent into S-curves (point-symmetric about their midpoints, so a black
   hexagon loses exactly what its white neighbour gains) — Escher's recipe,
   in the geometry Coxeter showed him in 1957. */
const HYP_FS = `
uniform vec4 uMob;        // Möbius motion: a (the point sent to the centre), rotation (cos, sin)
uniform vec4 uShape;      // S-curve amplitudes (a1, a2, a3), detail visibility
uniform vec4 uDisk;       // centre (px), radius (px), edge line width (px)
uniform vec4 uLook;       // invert (before the current flip), tile→grey fade, flip radius, bloom radius
vec2 cmul(vec2 a, vec2 b){ return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }
vec2 cdiv(vec2 a, vec2 b){ float d = dot(b,b); return vec2(a.x*b.x + a.y*b.y, a.y*b.x - a.x*b.y) / d; }
vec2 cconj(vec2 a){ return vec2(a.x, -a.y); }
// f(u) on the half edge from its midpoint (u=0) to its corner (u=1)
float edgeF(float u){ return uShape.x*sin(PI*u) + uShape.y*sin(2.0*PI*u) + uShape.z*sin(3.0*PI*u); }
float tileInk(vec2 z, out float gray) {
  const float P = 6.0, Q = 4.0;
  float a = PI / P;
  vec2 n2 = vec2(-sin(a), cos(a));
  // the third mirror: circle orthogonal to the boundary, crossing the x-axis at R
  float cR = cos(PI/Q) / sin(PI/P);
  float dR = log(cR + sqrt(cR*cR - 1.0));       // acosh
  float rR = tanh(dR * 0.5);
  float cc = 0.5 * (rR + 1.0/rR), rho = 0.5 * (1.0/rR - rR);
  int nAll = 0, nC = 0;
  for (int i = 0; i < 64; i++) {
    bool done = true;
    if (z.y < 0.0) { z.y = -z.y; nAll++; done = false; }
    float d2 = dot(z, n2);
    if (d2 > 0.0) { z -= 2.0 * d2 * n2; nAll++; done = false; }
    vec2 w = z - vec2(cc, 0.0); float r2 = dot(w, w);
    if (r2 < rho*rho) { z = vec2(cc, 0.0) + w * (rho*rho / r2); nAll++; nC++; done = false; }
    if (done) break;
  }
  // local frame at the edge midpoint R: send R to 0, the edge becomes the imaginary axis
  vec2 w = cdiv(z - vec2(rR, 0.0), vec2(1.0, 0.0) - rR * z);
  // the corner Q, in the same frame
  vec2 q = vec2(cos(a), sin(a)); // direction of PQ; find Q on that ray inside the circle
  float t0; { // |t q - C|^2 = rho^2, smaller root
    float b = dot(q, vec2(cc,0.0)), c = cc*cc - rho*rho; t0 = b - sqrt(max(b*b - c, 0.0)); }
  vec2 zQ = t0 * q;
  vec2 wQ = cdiv(zQ - vec2(rR, 0.0), vec2(1.0, 0.0) - rR * zQ);
  float L = wQ.y;
  float u = clamp(w.y / L, 0.0, 1.0);
  float d = -w.x / L;                                   // toward the hexagon centre is positive
  bool odd = (nAll & 1) == 1;
  float f = edgeF(u);
  float s = odd ? d + f : d - f;                        // > 0 inside this hexagon
  float h = float(nC & 1);
  // an eye in every lobe: lobes only bite into even triangles, so the eye sits there, clear of the mirrors
  float eye = 0.0;
  if (uShape.w > 0.0 && !odd) {
    float fe = edgeF(0.5);
    vec2 pe = vec2((u - 0.5) * 1.1, d - fe * 0.52);
    eye = 1.0 - smoothstep(0.052 * uShape.w - fwidth(d), 0.052 * uShape.w + fwidth(d), length(pe));
  }
  float aa = fwidth(d) * 1.1;
  float inside = smoothstep(-aa, aa, s);
  float ink = mix(1.0 - h, h, inside);
  ink = mix(ink, 1.0 - ink, eye);
  gray = 0.0;
  return ink;
}
void main(){
  vec2 px = gl_FragCoord.xy;
  vec2 z = (px - uDisk.xy) / uDisk.z;
  float r = length(z);
  float ink = 0.0, cover = 0.0;
  if (r < 1.0) {
    // Möbius motion: z -> e^{iθ} (z - a) / (1 - conj(a) z)
    vec2 A = uMob.xy;
    vec2 m = cmul(uMob.zw, cdiv(z - A, vec2(1.0, 0.0) - cmul(cconj(A), z)));
    float g;
    ink = tileInk(m, g);
    // where hexagons shrink below a couple of pixels, let them settle to grey
    float pxH = 2.0 / (uDisk.z * (1.0 - r*r));            // one pixel in hyperbolic units (approx)
    float fade = smoothstep(0.035, 0.11, pxH);
    ink = mix(ink, 0.5, fade * uLook.y);
    cover = 1.0;
  }
  // the rim
  float edge = abs(r - 1.0) * uDisk.z;
  float rim = 1.0 - smoothstep(uDisk.w - 0.7, uDisk.w + 0.7, edge);
  float inv = uLook.x;
  if (r < uLook.z) inv = 1.0 - inv;
  ink = mix(ink, 1.0 - ink, inv);
  // the tiling blooms out from the centre inside the ring
  float bloom = 1.0 - smoothstep(uLook.w - 0.02, uLook.w, r);
  ink *= bloom; cover *= bloom;
  ink = max(ink * cover, rim);
  cover = max(cover, rim);
  ink *= cover;
  o = vec4(ink, cover, 0.0, 1.0);
}
`;
function hypMotion(t) {
  // a slow drift along one geodesic, a turn on every bar, a lunge on the big beats
  const x = t - T(32);
  const drift = 0.32 * x + 0.9 * ss(T(38), T(40), t) * (t - T(38));
  const a = Math.tanh(drift * 0.5) ;
  const dir = 0.6 + 0.25 * Math.sin(x * 0.4);
  let A = [a * Math.cos(dir), a * Math.sin(dir)];
  // hyperbolic translation composes; approximate by moving the pre-image point
  const bars = x / BAR;
  const turn = (Math.floor(bars) + easeIO(sat((bars % 1) / 0.25))) * (Math.PI / 6) * 0.5;
  return { A, rot: [Math.cos(turn), Math.sin(turn)] };
}
function drawCircleLimit(t, F) {
  const W = GFX.W, H = GFX.H;
  const R = DISK_FRAC * Math.min(W, H);
  const grow = easeOut(sat((t - T(32)) / 0.9));
  const mv = hypMotion(t);
  // S-curve: lobes swell in on the drop
  const amp = lerp(0.0, 1, grow);
  // figure and ground change places on bars 34, 36 and 38, in a ring that runs outward
  const flips = [T(34), T(36), T(38)];
  let base = 0, fr = 0;
  for (const tf of flips) {
    if (t >= tf + 0.4) base ^= 1;
    else if (t >= tf) fr = easeOut((t - tf) / 0.4) * 1.05;
  }
  const bloom = easeOut(sat((t - T(32)) / 0.55)) * 1.06;
  GFX.runScene('hyp', {
    uMob: [mv.A[0], mv.A[1], mv.rot[0], mv.rot[1]],
    uShape: [0.34 * amp, 0.1 * amp, -0.05 * amp, ss(0.6, 0.95, amp)],
    uDisk: [W / 2, H / 2, R * lerp(0.985, 1, grow), Math.max(1.2, 1.6 * GFX.scale) * (1 + 0.9 * env('kick', t))],
    uLook: [base, 1, fr, bloom],
  });
  F.use[0] = 1;
}

/* ───────── §6: the print gallery ─────────
   The bird division, carried through the complex logarithm: w = log z turns
   circles into lines, so a periodic pattern becomes a spiral that shrinks
   into the centre for ever. The twist is chosen so that once round the
   centre is exactly one period of the pattern (2 cells across, 8 along —
   and the colouring agrees), so there is no seam. Zooming is a slide along
   w; the centre stays blank, as it does in Escher's Print Gallery, and what
   is written in the blank is where the piece began. */
const DROSTE_FS = `
uniform vec4 uSp;     // centre (px), unit (px), unused
uniform vec4 uMap;    // k, beta, zoom (natural log), unused
uniform vec4 uClip;   // outer radius (px), feather, invert, grey-out
void main(){
  vec2 p = gl_FragCoord.xy - uSp.xy;
  float r = max(length(p), 1e-3);
  vec2 w = vec2(log(r / uSp.z) - uMap.z, atan(p.y, p.x));
  float c = cos(uMap.y), s = sin(uMap.y);
  mat2 M = uMap.x * mat2(c, s, -s, c);               // columns: rotation × k
  vec2 tc = M * w; tc.x = -tc.x;
  // derivatives of w taken analytically, so the branch cut of atan leaves no seam
  vec2 dwdx = vec2(p.x, -p.y) / (r * r), dwdy = vec2(p.y, p.x) / (r * r);
  vec2 gx = M * dwdx; gx.x = -gx.x;
  vec2 gy = M * dwdy; gy.x = -gy.x;
  float ink = textureGrad(uTex0, tc * 0.5, gx * 0.5, gy * 0.5).r;
  float cover = 1.0 - smoothstep(uClip.x - uClip.y, uClip.x + uClip.y, r);
  ink = mix(ink, 1.0 - ink, uClip.z);
  o = vec4(ink * cover, cover, 0.0, 1.0);
}
`;
const tileCv = (() => { const c = document.createElement('canvas'); c.width = 1024; c.height = 1024; return c; })();
let tileKey = '';
function tileTexture(m, u) {
  const key = m.toFixed(3) + ':' + u.toFixed(3);
  if (key === tileKey) return;
  tileKey = key;
  const g = tileCv.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#000'; g.fillRect(0, 0, 1024, 1024);
  TILES.drawChecker(g, [512, 0, 0, 512, 0, 0], 1024, 1024, { at: () => ({ m, A: TILES.DESIGNS.bird, B: TILES.DESIGNS.fish, u }), ink: '#fff', paper: '#000', lineW: 0.026 });
  GFX.uploadCanvas('tile', tileCv, { wrap: true });
}
// twist: once round = (2, 8) cells
const DK = Math.hypot(2, 8) / (2 * Math.PI), DB = Math.atan2(-2, 8);
const ZOOM_RATE = 0.62;   // e-folds per second
function drawGallery(t, F) {
  const W = GFX.W, H = GFX.H;
  const unit = Math.min(W, H) * 0.5;
  const full = Math.hypot(W, H) * 0.5;
  const m = 1 - ss(T(44), T(46, 6), t);
  tileTexture(m, 0);
  const zoom = ZOOM_RATE * (t - PIECE);            // 0 when the title fills the screen
  const outer = lerp(DISK_FRAC * Math.min(W, H), full * 1.05, easeOut(sat((t - T(40)) / 0.7)));
  GFX.runScene('droste', {
    uSp: [W / 2, H / 2, unit, 0],
    uMap: [DK, DB, zoom, 0],
    uClip: [outer, 1.2, 0, 0],
  }, { uTex0: 'tile' });
  F.use[0] = 1;
  // the blank at the centre, and the title written in it
  const sigma = Math.exp(Math.min(0, zoom));
  const rHole = sigma * full * 1.02;
  const ctx = GFX.begin2D();
  if (rHole > 0.3) {
    ctx.save();
    ctx.beginPath(); ctx.arc(W / 2, H / 2, rHole, 0, Math.PI * 2);
    ctx.fillStyle = PAPER; ctx.fill();
    ctx.clip();
    const L = titleLayout();
    const v = view2D(L.cx, L.cy, L.s * sigma, 0);
    // centre the title card on the screen centre while it is small, as it is at full size
    drawLetterGrid(ctx, v, 10, {});
    drawSubtitle(ctx, v, 1);
    ctx.restore();
    if (rHole < full) {
      ctx.beginPath(); ctx.arc(W / 2, H / 2, rHole, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1, 1.4 * GFX.scale); ctx.strokeStyle = INK; ctx.stroke();
    }
  }
  GFX.upload2D();
  F.use[2] = 1;
}

/* ───────── frame / idle ───────── */
function init() {
  GFX.addScene('hyp', HYP_FS);
  GFX.addScene('droste', DROSTE_FS);
  GFX.mesh('cube', GEO.cube());
  GFX.mesh('monk', monkMesh());
  GFX.mesh('ant', antMesh());
}
function frame(t, o) {
  calm = !!(o && o.calm);
  const F = { use: [0, 0, 0], T: t, invert: 0 };
  if (t < T(15)) drawPlane(t, F);
  else if (t < T(32)) drawSolid(t, F);
  else if (t < T(40)) { drawCircleLimit(t, F); if (t < T(32) + 0.5) drawSolid(T(32) - 0.001, F, 1 - sat((t - T(32)) / 0.5)); }
  else drawGallery(Math.min(t, PIECE), F);
  // the last seconds: the music rings out over the title
  GFX.composite(F);
}
function idle(tw, st) {
  calm = !!st.calm;
  const L = titleLayout();
  const ctx = GFX.begin2D();
  const v = view2D(L.cx, L.cy, L.s, 0);
  drawLetterGrid(ctx, v, 10, {});
  const at = drawSubtitle(ctx, v, 1);
  drawButton(ctx, at, st, tw);
  GFX.upload2D();
  GFX.composite({ use: [0, 0, 1], T: 0 });
}
function button() { return BUTTON; }

return { init, frame, idle, setMusic, button };
})();
