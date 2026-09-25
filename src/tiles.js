/* ─────────────────────────────────────────────────────────────────────────
   tiles.js — regular division of the plane, the way Escher did it.

   Start from a checkerboard. Every edge between a black and a white square
   is replaced by a curve; the black square on one side loses exactly what
   the white square on the other side gains, so the pieces still tile. With
   the checkerboard's own symmetry there are four kinds of edge:
     Hb  horizontal, black square below     Hw  horizontal, white below
     Vb  vertical,   black square on the left  Vw  vertical, white on the left
   A curve runs from (0,0) to (1,0) in the edge's own frame; +y is the side
   that is "above" (horizontal edges) or "left" (vertical edges).
   Each edge morphs from straight to designed by a weight that depends on
   where the edge sits in the plane — that is the whole of Metamorphosis.
   ───────────────────────────────────────────────────────────────────────── */
var TILES = (function () {
'use strict';

const NS = 56;   // samples per edge

// centripetal Catmull–Rom through the points, n samples (ends included)
function spline(P, n) {
  const pts = [P[0]].concat(P, [P[P.length - 1]]);
  const seg = [];
  for (let i = 1; i < pts.length - 2; i++) seg.push([pts[i - 1], pts[i], pts[i + 1], pts[i + 2]]);
  // arc-length-ish parameterization: allot samples per segment by chord length
  const L = seg.map(([, a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1]) + 1e-6);
  const tot = L.reduce((a, b) => a + b, 0);
  const out = [];
  for (let k = 0; k < n; k++) {
    let u = (k / (n - 1)) * tot, i = 0;
    while (i < seg.length - 1 && u > L[i]) { u -= L[i]; i++; }
    const t = Math.min(1, u / L[i]);
    out.push(crPoint(seg[i], t));
  }
  return out;
}
function crPoint([p0, p1, p2, p3], t) {
  const al = 0.5;
  const tj = (ti, a, b) => ti + Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]) + 1e-9, al);
  const t0 = 0, t1 = tj(t0, p0, p1), t2 = tj(t1, p1, p2), t3 = tj(t2, p2, p3);
  const tt = t1 + (t2 - t1) * t;
  const L = (a, b, ta, tb) => { const w = (tt - ta) / (tb - ta || 1e-9); return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w]; };
  const A1 = L(p0, p1, t0, t1), A2 = L(p1, p2, t1, t2), A3 = L(p2, p3, t2, t3);
  const B1 = L(A1, A2, t0, t2), B2 = L(A2, A3, t1, t3);
  return L(B1, B2, t1, t2);
}

/* ───────── designs ─────────
   A design: four edge curves (control points, from [0,0] to [1,0]) plus
   details in black-cell coordinates (the cell is [0,1]², the white cell to
   its right is [1,2]×[0,1]). */
const DESIGNS = {};
function design(name, d) {
  const e = {};
  for (const k of ['Hb', 'Hw', 'Vb', 'Vw']) e[k] = spline(d[k], NS);
  DESIGNS[name] = { name, edges: e, black: d.black || [], white: d.white || [], raw: d };
  return DESIGNS[name];
}
const STRAIGHT = [];
for (let k = 0; k < NS; k++) STRAIGHT.push([k / (NS - 1), 0]);

// the curve of an edge of kind `k`, blending straight → design A → design B
function edgeCurve(k, m, A, B, u) {
  const a = A ? A.edges[k] : STRAIGHT, b = B ? B.edges[k] : null;
  const out = new Array(NS);
  for (let i = 0; i < NS; i++) {
    let x = a[i][0], y = a[i][1];
    if (b && u > 0) { x += (b[i][0] - x) * u; y += (b[i][1] - y) * u; }
    const s = STRAIGHT[i];
    out[i] = [s[0] + (x - s[0]) * m, s[1] + (y - s[1]) * m];
  }
  return out;
}

/* ───────── drawing a checkerboard division ─────────
   view: canvas transform [a,b,c,d,e,f] (world → pixels)
   opts.at(x, y) → { m, A, B, u } for an edge whose midpoint is (x, y)
   opts.cells(i, j) → false to skip a black cell (e.g. it has flown away)
*/
function visibleCells(view, W, H, pad) {
  const [a, b, c, d, e, f] = view;
  const det = a * d - b * c;
  const inv = (x, y) => { x -= e; y -= f; return [(d * x - c * y) / det, (-b * x + a * y) / det]; };
  const P = [inv(0, 0), inv(W, 0), inv(0, H), inv(W, H)];
  const xs = P.map((p) => p[0]), ys = P.map((p) => p[1]);
  return [Math.floor(Math.min(...xs)) - pad, Math.ceil(Math.max(...xs)) + pad, Math.floor(Math.min(...ys)) - pad, Math.ceil(Math.max(...ys)) + pad];
}
function tracePoly(path, pts, first) {
  for (let i = first ? 0 : 1; i < pts.length; i++) {
    if (i === 0) path.moveTo(pts[i][0], pts[i][1]);
    else path.lineTo(pts[i][0], pts[i][1]);
  }
}
// the four edges of black cell (i,j), in counter-clockwise order, world coordinates
function blackCellOutline(i, j, at) {
  const out = [];
  const E = (kind, x0, y0, vertical, reverse, mx, my) => {
    const s = at(mx, my);
    const cv = edgeCurve(kind, s.m, s.A, s.B, s.u);
    let pts = cv.map(([px, py]) => vertical ? [x0 - py, y0 + px] : [x0 + px, y0 + py]);
    if (reverse) pts = pts.reverse();
    return pts;
  };
  out.push(E('Hw', i, j, false, false, i + 0.5, j));            // bottom, left→right
  out.push(E('Vb', i + 1, j, true, false, i + 1, j + 0.5));      // right, bottom→top
  out.push(E('Hb', i, j + 1, false, true, i + 0.5, j + 1));      // top, right→left
  out.push(E('Vw', i, j, true, true, i, j + 0.5));               // left, top→bottom
  return out;
}
function drawChecker(ctx, view, W, H, opts) {
  const [x0, x1, y0, y1] = visibleCells(view, W, H, 2);
  const at = opts.at;
  ctx.save();
  ctx.setTransform(view[0], view[1], view[2], view[3], view[4], view[5]);
  const path = new Path2D();
  const blacks = [];
  for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
    if (((i + j) & 1) !== 0) continue;
    if (opts.cells && opts.cells(i, j) === false) continue;
    const ol = blackCellOutline(i, j, at);
    tracePoly(path, ol[0], true);
    for (let k = 1; k < 4; k++) tracePoly(path, ol[k], false);
    path.closePath();
    blacks.push([i, j]);
  }
  ctx.fillStyle = opts.ink || '#ff0';
  ctx.fill(path);
  // details: eyes, fins, feathers — on both kinds of tile
  if (opts.details !== false) {
    const dp = new Path2D(), wp = new Path2D(), lp = new Path2D(), wl = new Path2D();
    let any = false;
    for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
      const black = ((i + j) & 1) === 0;
      const s = at(i + 0.5, j + 0.5);
      const vis = Math.max(0, Math.min(1, (s.m - 0.72) / 0.22));
      if (vis <= 0.01) continue;
      const Des = s.u > 0.5 && s.B ? s.B : s.A;
      if (!Des) continue;
      const list = black ? Des.black : Des.white;
      for (const d of list) {
        any = true;
        const tgt = d.line ? (black ? wl : lp) : (black ? wp : dp);
        if (d.dot) { const [cx, cy, r] = d.dot; tgt.moveTo(i + cx + r * vis, j + cy); tgt.arc(i + cx, j + cy, r * vis, 0, Math.PI * 2); }
        if (d.line) { const P = d.line; tgt.moveTo(i + P[0][0], j + P[0][1]); for (let k = 1; k < P.length; k++) tgt.lineTo(i + P[k][0], j + P[k][1]); }
      }
    }
    if (any) {
      ctx.fillStyle = opts.paper || '#0f0'; ctx.fill(wp);
      ctx.fillStyle = opts.ink || '#ff0'; ctx.fill(dp);
      const lw = opts.lineW || 0.022;
      ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = opts.paper || '#0f0'; ctx.stroke(wl);
      ctx.strokeStyle = opts.ink || '#ff0'; ctx.stroke(lp);
    }
  }
  ctx.restore();
  return blacks;
}

/* ───────── the creatures ─────────
   Translation tiles: black and white pieces are the same animal, shifted.
   V is both vertical edges (bottom→top, +y pushes left: the head out of its
   own square and, one square over, a notch in the tail); H is both horizontal
   edges (left→right, +y pushes up: a wing into the square above and a notch
   in the belly below). Details are in the tile's own square. */
function p1(name, V, H, det) { return design(name, { Hw: H, Hb: H, Vw: V, Vb: V, black: det, white: det }); }
p1('bird',
  [[0, 0], [0.08, -0.05], [0.16, -0.16], [0.24, -0.07], [0.32, -0.17], [0.42, -0.06], [0.5, 0.05], [0.57, 0.13], [0.63, 0.33], [0.68, 0.16], [0.76, 0.13], [0.86, 0.06], [1, 0]],
  [[0, 0], [0.14, -0.07], [0.28, -0.06], [0.38, 0.06], [0.48, 0.28], [0.58, 0.47], [0.66, 0.36], [0.72, 0.16], [0.8, 0.04], [0.9, 0.0], [1, 0]],
  [{ dot: [-0.07, 0.67, 0.035] }, { line: [[0.36, 0.72], [0.47, 0.9], [0.56, 1.2]] }, { line: [[0.48, 0.7], [0.57, 0.86], [0.63, 1.1]] }]);
p1('fish',
  [[0, 0], [0.12, -0.04], [0.23, -0.15], [0.32, -0.06], [0.4, 0.12], [0.46, 0.3], [0.5, 0.36], [0.54, 0.3], [0.6, 0.12], [0.68, -0.06], [0.77, -0.15], [0.88, -0.04], [1, 0]],
  [[0, 0], [0.15, -0.03], [0.3, 0.0], [0.42, 0.1], [0.52, 0.2], [0.6, 0.24], [0.64, 0.13], [0.71, 0.0], [0.82, -0.07], [0.92, -0.03], [1, 0]],
  [{ dot: [-0.1, 0.56, 0.04] }, { line: [[0.1, 0.32], [0.14, 0.5], [0.1, 0.68]] }, { line: [[0.62, 0.5], [0.9, 0.5]] }]);

// a division's mirror image (the same animals, facing the other way)
function mirror(name, src) {
  const D = DESIGNS[src].raw;
  const mV = (P) => P.map(([x, y]) => [x, -y]);
  const mH = (P) => P.slice().reverse().map(([x, y]) => [1 - x, y]);
  const mD = (list) => list.map((d) => (d.dot ? { dot: [1 - d.dot[0], d.dot[1], d.dot[2]] } : { line: d.line.map(([x, y]) => [1 - x, y]) }));
  return design(name, { Hw: mH(D.Hw), Hb: mH(D.Hb), Vw: mV(D.Vw), Vb: mV(D.Vb), black: mD(D.black || []), white: mD(D.white || []) });
}
mirror('birdR', 'bird');
mirror('fishR', 'fish');

/* ───────── lettering on the grid ─────────
   Each letter is 3×5 cells: '#' full, '.' empty, and half-cells cut on a
   diagonal: a = top-left half, b = top-right, c = bottom-right, d = bottom-left.
   A cell is drawn as a quad (BL, BR, TR, TL); a half-cell pinches one corner
   into the centre, an empty cell pinches all four — so every state can morph
   into every other, which is how the title melts into the checkerboard. */
const LETTERS = {
  S: ['c##', '#..', 'b#d', '..#', '##a'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  R: ['##d', '#.#', '##a', '#.#', '#.#'],
  A: ['c#d', '#.#', '###', '#.#', '#.#'],
  N: ['#.#', '#d#', '#b#', '#.#', '#.#'],
  G: ['c##', '#..', '#.#', '#.#', 'b##'],
  E: ['###', '#..', '##.', '#..', '###'],
  L: ['#..', '#..', '#..', '#..', '###'],
  O: ['c#d', '#.#', '#.#', '#.#', 'b#a'],
  P: ['##d', '#.#', '##a', '#..', '#..'],
  ' ': ['...', '...', '...', '...', '...'],
};
const QUADS = {
  '#': [[0, 0], [1, 0], [1, 1], [0, 1]],
  '.': [[0.5, 0.5], [0.5, 0.5], [0.5, 0.5], [0.5, 0.5]],
  a: [[0, 0], [0.5, 0.5], [1, 1], [0, 1]],
  b: [[0.5, 0.5], [1, 0], [1, 1], [0, 1]],
  c: [[0, 0], [1, 0], [1, 1], [0.5, 0.5]],
  d: [[0, 0], [1, 0], [0.5, 0.5], [0, 1]],
};
// lay out lines of text; returns cells {i, j, code} with (0,0) near the middle
function lettering(lines, gap) {
  gap = gap || 1;
  const cells = [];
  const widths = lines.map((l) => l.length * 3 + (l.length - 1) * gap);
  const wmax = Math.max(...widths);
  const lineH = 5, lineGap = 2;
  const totalH = lines.length * lineH + (lines.length - 1) * lineGap;
  lines.forEach((line, li) => {
    const x0 = Math.floor(-widths[li] / 2);
    const yTop = Math.floor(totalH / 2) - li * (lineH + lineGap);
    [...line].forEach((ch, k) => {
      const g = LETTERS[ch] || LETTERS[' '];
      for (let r = 0; r < 5; r++) for (let q = 0; q < 3; q++) {
        const code = g[r][q];
        if (code === '.') continue;
        cells.push({ i: x0 + k * (3 + gap) + q, j: yTop - r - 1, code });
      }
    });
  });
  return { cells, width: wmax, height: totalH };
}

return { spline, design, DESIGNS, edgeCurve, blackCellOutline, drawChecker, visibleCells, NS, LETTERS, QUADS, lettering };
})();
