/* ─────────────────────────────────────────────────────────────────────────
   synth.js — the soundtrack, composed and synthesized sample by sample.

   6/8 · a dotted quarter = 64 · 48 bars · 90 seconds, plus a ringing tail.

   The form is a passacaglia "per tonos": one eight-bar ground whose bass
   walks down the scale, bar by bar, until it lands a whole tone *above*
   where it started. Six sections, six keys (D E F♯ G♯ A♯ C), and the
   seventh is D again. The organ, the bass and the harpsichord are voiced
   as octave stacks under a fixed spectral window (Shepard tones), so the
   music keeps descending in its bass and ascending in its keys and still
   arrives, after ninety seconds, exactly where it began.

   Runs inside a Web Worker (or on the main thread / in Node for testing).
   Exposes SYNTH.renderGen(opts): yields progress (0‥1), returns the stereo
   mix, per-stem envelopes for the visuals, and the score itself.
   ───────────────────────────────────────────────────────────────────────── */
var SYNTH = (function () {
'use strict';

const EIGHTH = 0.3125;
const STEP = EIGHTH / 2;        // a sixteenth, 0.15625 s
const BEAT = EIGHTH * 3;        // dotted quarter, 0.9375 s
const BAR = EIGHTH * 6;         // 1.875 s
const BARS = 48;
const PIECE = BARS * BAR;       // 90 s
const TAIL = 3;                 // the first chord again, ringing out
const DURATION = PIECE + TAIL;
const T = (bar, step) => (bar * 12 + (step || 0)) * STEP;
const TAU = Math.PI * 2;
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

const STEMS = ['kick', 'snare', 'hat', 'tick', 'bass', 'organ', 'lead', 'harp', 'bell', 'strings', 'fx', 'timp'];
const ST = {}; STEMS.forEach((s, i) => (ST[s] = i));

function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ═════════════════════════════ HARMONY ═════════════════════════════ */

// The ground, relative to the section's tonic. `bass` walks down; `sc` is the
// scale heard over that bar, indexed by degree from the tonic.
const MINOR = [0, 2, 3, 5, 7, 8, 10], HARM = [0, 2, 3, 5, 7, 8, 11], MAJOR = [0, 2, 4, 5, 7, 9, 11];
const PIVOT = [0, 2, 4, 5, 7, 9, 10];                    // the next key, heard from here
const PROG = {
  m: [
    { bass: 0, root: 0, deg: 0, tones: [0, 3, 7], sc: MINOR },          // i
    { bass: -2, root: 7, deg: 4, tones: [7, 10, 2], sc: MINOR },        // v6
    { bass: -4, root: 5, deg: 3, tones: [5, 8, 0], sc: MINOR },         // iv6
    { bass: -5, root: 7, deg: 4, tones: [7, 11, 2], sc: HARM },         // V
    { bass: -7, root: 5, deg: 3, tones: [5, 8, 0, 3], sc: MINOR },      // iv7
    { bass: -9, root: 3, deg: 2, tones: [3, 7, 10], sc: MINOR },        // III
    { bass: -10, root: 10, deg: 6, tones: [10, 2, 5], sc: PIVOT },      // VII6 = VI of the next key
    { bass: -15, root: 9, deg: 5, tones: [9, 1, 4, 7], sc: null },      // V7 of the next key
  ],
  M: [
    { bass: 0, root: 0, deg: 0, tones: [0, 4, 7], sc: MAJOR },          // I
    { bass: -1, root: 7, deg: 4, tones: [7, 11, 2], sc: MAJOR },        // V6
    { bass: -3, root: 9, deg: 5, tones: [9, 0, 4], sc: MAJOR },         // vi
    { bass: -5, root: 7, deg: 4, tones: [7, 11, 2], sc: MAJOR },        // V
    { bass: -7, root: 5, deg: 3, tones: [5, 9, 0, 4], sc: MAJOR },      // IVmaj7
    { bass: -8, root: 0, deg: 0, tones: [0, 4, 7], sc: MAJOR },         // I6
    { bass: -10, root: 10, deg: 6, tones: [10, 2, 5], sc: PIVOT },      // ♭VII6
    { bass: -15, root: 9, deg: 5, tones: [9, 1, 4, 7], sc: null },      // V7 of the next key
  ],
};
const SEC_MODE = ['m', 'M', 'm', 'M', 'm', 'm'];
// section 2 is Day and Night: major until the picture inverts at bar 12
const modeAt = (bar) => { const s = Math.floor(bar / 8) % 6; return s === 1 && bar % 8 >= 4 ? 'm' : SEC_MODE[s]; };

function chordAt(bar) {
  const s = Math.floor(bar / 8), i = bar % 8;
  const mode = bar >= BARS ? 'm' : modeAt(bar);
  const P = PROG[mode][bar >= BARS ? 0 : i];
  let sc = P.sc;
  if (!sc) sc = SEC_MODE[(s + 1) % 6] === 'm' ? [1, 2, 4, 5, 7, 9, 10] : [1, 2, 4, 6, 7, 9, 11];
  const tonic = 62 + 2 * s;
  return { bar, s, i, mode, tonic, sc, deg: P.deg, root: tonic + P.root, bass: tonic + P.bass, tones: P.tones.map((x) => tonic + x) };
}
const pc = (m) => ((m % 12) + 12) % 12;

// key-degree index of a pitch in a chord's scale (+7 per octave)
function degreeOf(ch, midi) {
  const rel = midi - ch.tonic;
  const oct = Math.floor(rel / 12), r = rel - oct * 12;
  let best = 0, bd = 99;
  for (let i = 0; i < 7; i++) { const d = Math.abs(ch.sc[i] - r); if (d < bd) { bd = d; best = i; } }
  return best + 7 * oct;
}
// realize a chord-relative degree over a chord
function realize(ch, d) {
  const k = ch.deg + d, oct = Math.floor(k / 7), i = k - oct * 7;
  return ch.tonic + ch.sc[i] + 12 * oct;
}

/* ═════════════════════════════ THE SUBJECT ═════════════════════════════ */

// written in D minor over section 1: [bar, sixteenth, length, midi]
const SUBJECT = [
  [0, 0, 4, 69], [0, 4, 2, 74], [0, 6, 4, 77], [0, 10, 2, 76],
  [1, 0, 4, 76], [1, 4, 2, 72], [1, 6, 6, 69],
  [2, 0, 4, 70], [2, 4, 2, 74], [2, 6, 4, 79], [2, 10, 2, 77],
  [3, 0, 6, 76], [3, 6, 2, 73], [3, 8, 2, 74], [3, 10, 2, 76],
  [4, 0, 4, 77], [4, 4, 2, 74], [4, 6, 4, 82], [4, 10, 2, 81],
  [5, 0, 4, 81], [5, 4, 2, 77], [5, 6, 4, 84], [5, 10, 2, 82],
  [6, 0, 4, 81], [6, 4, 2, 79], [6, 6, 2, 76], [6, 8, 2, 78], [6, 10, 2, 79],
  [7, 0, 6, 81], [7, 6, 2, 78], [7, 8, 2, 75], [7, 10, 2, 78],
];
// as chord-relative degrees, so it can be heard over any bar of any key
const SUBJ = SUBJECT.map(([b, s, l, m]) => { const ch = chordAt(b); return { b, s, l, d: degreeOf(ch, m) - ch.deg }; });

/* ═════════════════════════════ THE SCORE ═════════════════════════════ */

function buildScore() {
  const R = rng(1898);
  const S = {
    kick: [], kickM: [], clap: [], snare: [], hatC: [], hatO: [], tick: [], ant: [], step: [], tom: [], timp: [],
    crash: [], impact: [], revCym: [], whoosh: [], down: [], gliss: [], organ: [], bass: [], lead: [], canon: [],
    harp: [], bell: [], strings: [], chords: [], shep: [], risset: [], marks: [],
  };
  const hum = (a) => (R() - 0.5) * a;
  for (let b = 0; b <= BARS; b++) {
    const c = chordAt(b);
    S.chords.push({ t: T(b), dur: BAR, bar: b, tones: c.tones, bass: c.bass, root: c.root, s: c.s, mode: c.mode });
  }
  const CH = (b) => chordAt(Math.min(b, BARS));

  /* ── organ: the ground as Shepard chords ── */
  const organ = (b, o) => {
    const c = CH(b);
    const notes = c.tones.slice();
    if (!notes.some((n) => pc(n) === pc(c.bass))) notes.push(c.bass);
    S.organ.push({ t: T(b), dur: o.dur || BAR, notes, att: o.att || 0.09, rel: o.rel || 0.45, vel: o.vel, center: o.center || 300, sigma: o.sigma || 0.95, bar: b });
  };
  organ(0, { vel: 0.8, att: 2.6, center: 240, dur: BAR });
  for (let b = 1; b < 8; b++) organ(b, { vel: 0.8 + b * 0.02, center: 250 + b * 8 });
  for (let b = 8; b < 16; b++) organ(b, { vel: b < 12 ? 0.62 : 0.7, center: b < 12 ? 380 : 300 });
  for (let b = 16; b < 24; b++) organ(b, { vel: b === 18 || b === 19 ? 0.85 : 0.5, center: 360 });
  for (let b = 24; b < 32; b++) organ(b, { vel: 0.9, att: 0.35, rel: 0.7, center: 320 });
  for (let b = 32; b < 40; b++) organ(b, { vel: 0.55, center: 420 });
  for (let b = 40; b < 44; b++) organ(b, { vel: 0.85, att: 0.25, rel: 0.6, center: 360 });
  for (let b = 44; b < 48; b++) organ(b, { vel: 0.8 - (b - 44) * 0.03, center: 300 - (b - 44) * 10 });
  organ(48, { vel: 0.75, att: 0.06, dur: TAIL - 0.4, rel: 1.6, center: 240 });

  /* ── bass: the descending ground, Shepard-stacked ── */
  const bassNote = (b, s, len, vel, pl) => S.bass.push({ t: T(b, s), dur: len * STEP, note: CH(b).bass, vel, pluck: pl || 0, bar: b });
  for (let b = 4; b < 8; b++) bassNote(b, 0, 11.6, 0.55 + (b - 4) * 0.08, 0);
  for (let b = 8; b < 16; b++) {
    if (b === 15) { for (const s of [0, 3, 6, 8, 10]) bassNote(b, s, 1.7, 0.85, 0.6); continue; }
    bassNote(b, 0, 5.6, 0.95, 0.35); bassNote(b, 6, 5.6, 0.75, 0.35);
  }
  const drive = (b0, b1, skip) => {
    for (let b = b0; b < b1; b++) {
      if (skip && skip(b)) continue;
      for (const s of [0, 2, 4, 6, 8, 10]) bassNote(b, s, 1.6, s === 0 ? 1 : s === 6 ? 0.9 : 0.72, 0.8);
    }
  };
  drive(16, 24, (b) => b === 18 || b === 19);
  bassNote(18, 0, 11.7, 0.8, 0); bassNote(19, 0, 11.7, 0.8, 0); // the reveal: held notes
  for (let b = 24; b < 28; b++) bassNote(b, 0, 11.6, 0.6, 0);
  for (let b = 28; b < 32; b++) { bassNote(b, 0, 5.6, 0.75, 0.3); bassNote(b, 6, 5.6, 0.62, 0.3); }
  drive(32, 40);
  for (let b = 40; b < 44; b++) bassNote(b, 0, 11.7, 0.75, 0);
  for (let b = 44; b < 48; b++) bassNote(b, 0, 11.6, 0.55 - (b - 44) * 0.05, 0);
  S.bass.push({ t: T(48), dur: TAIL - 0.6, note: CH(48).bass, vel: 0.42, pluck: 0, bar: 48 });

  /* ── the subject and its transformations ── */
  // Realize template bars [from,to) starting at bar `at`, optionally inverted,
  // reversed or re-timed. Pitch classes come from the chord-relative degree over
  // whatever chord is sounding; octaves follow the template's own intervals so
  // the contour survives; transformed voices snap strong beats to chord tones.
  const phrase = (arr, at, from, to, o) => {
    o = o || {};
    const sp = o.speed || 1;
    const src = SUBJ.map((n, i) => ({ ...n, m: SUBJECT[i][3] })).filter((n) => n.b >= from && n.b < to);
    const evs = src.map((n) => {
      let pos = ((n.b - from) * 12 + n.s) / sp, len = n.l / sp;
      if (o.retro) pos = (to - from) * 12 / sp - pos - len;
      return { n, pos, len };
    }).sort((a, b) => a.pos - b.pos);
    let prevT = null, prevOut = null;
    for (const { n, pos, len } of evs) {
      const tb = at + Math.floor(pos / 12 + 1e-9), ts = pos - (tb - at) * 12;
      if (o.until !== undefined && tb >= o.until) continue;
      const ch = CH(tb);
      const d = o.invert ? 4 - n.d : n.d;
      let note = realize(ch, d);
      const strong = Math.abs(ts) < 1e-6 || Math.abs(ts - 6) < 1e-6;
      if ((o.invert || o.retro || sp !== 1 || o.snap) && strong && !ch.tones.some((x) => pc(x) === pc(note))) {
        let best = note, bd = 99;
        for (const x of ch.tones) for (let k = -2; k <= 2; k++) { const c = x + 12 * k; const dd = Math.abs(c - note); if (dd < bd && dd > 0) { bd = dd; best = c; } }
        note = best;
      }
      let expect;
      if (prevT === null) expect = o.near !== undefined ? o.near : n.m + 2 * Math.floor(at / 8) + (o.oct || 0) * 12;
      else expect = prevOut + (o.invert ? -1 : 1) * (n.m - prevT);
      while (note - expect > 6) note -= 12;
      while (expect - note > 6) note += 12;
      if (o.near !== undefined) { while (note > o.near + 10) note -= 12; while (note < o.near - 10) note += 12; }
      prevT = n.m; prevOut = note;
      arr.push({ t: T(tb, ts), dur: len * STEP * (o.legato || 0.94), note, vel: o.vel || 1, bar: tb, s: ts, voice: o.voice || 0, pan: o.pan || 0 });
    }
  };
  // lead (organ-flute stack)
  phrase(S.lead, 4, 4, 8, { vel: 0.7 });
  phrase(S.lead, 8, 0, 4, { vel: 0.85 });
  phrase(S.lead, 12, 4, 8, { vel: 0.9, invert: true, near: 78 });
  phrase(S.lead, 16, 0, 8, { vel: 1, voice: 1 });
  phrase(S.lead, 24, 0, 8, { vel: 0.75 });
  phrase(S.lead, 32, 0, 8, { vel: 1, voice: 1 });
  phrase(S.lead, 40, 0, 2, { vel: 0.8, speed: 0.5 });
  phrase(S.lead, 44, 4, 8, { vel: 0.72 });
  // canon voices (celesta), a bar behind, an octave up
  phrase(S.canon, 9, 0, 3, { vel: 0.55, near: 83, pan: 0.35, snap: 1 });
  phrase(S.canon, 13, 4, 7, { vel: 0.6, invert: true, near: 86, pan: 0.35 });
  phrase(S.canon, 17, 0, 7, { vel: 0.6, near: 85, pan: 0.4, snap: 1 });
  // the crab: the subject backwards, against itself
  phrase(S.canon, 24, 0, 8, { vel: 0.72, retro: true, near: 82, pan: -0.3 });
  // augmentation (tenor organ, half speed) and diminution (celesta, double speed)
  phrase(S.canon, 32, 0, 4, { vel: 0.8, speed: 0.5, near: 58, voice: 2, legato: 0.98 });
  phrase(S.canon, 32, 0, 8, { vel: 0.42, speed: 2, near: 84, pan: 0.45 });
  phrase(S.canon, 36, 0, 8, { vel: 0.42, speed: 2, near: 84, pan: -0.45 });

  /* ── harpsichord ── */
  const PAT = {
    A: [0, 1, 2, 1, 2, 3, 2, 3, 4, 3, 4, 5],        // stairs: up two, back one
    B: [0, 2, 4, 1, 3, 5, 2, 4, 6, 3, 5, 7],
    C: [0, -1, 2, -1, 4, -1, 3, -1, 5, -1, 4, -1],   // eighths
    D: [0, 1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1],
  };
  const harpBar = (b, pat, vel, o) => {
    o = o || {};
    const c = CH(b);
    const pcs = c.tones.map(pc);
    let lo = 50 + pc(c.bass - 50);
    const tones = [];
    for (let m = lo; tones.length < 10; m++) if (pcs.includes(pc(m))) tones.push(m);
    PAT[pat].forEach((ix, s) => {
      if (ix < 0) return;
      if (o.from !== undefined && s < o.from) return;
      if (o.to !== undefined && s >= o.to) return;
      const acc = s === 0 ? 1 : s === 6 ? 0.85 : s % 2 === 0 ? 0.7 : 0.55;
      const len = pat === 'C' ? 2 : 1;
      S.harp.push({ t: T(b, s) + hum(0.003), dur: len * STEP * 0.92, note: tones[ix] + (o.oct || 0) * 12, vel: vel * acc, bar: b, s, pan: (ix - 3) * 0.12 });
    });
  };
  for (let b = 2; b < 4; b++) harpBar(b, 'A', 0.5 + (b - 2) * 0.15);
  for (let b = 4; b < 8; b++) harpBar(b, 'A', 0.72);
  for (let b = 8; b < 16; b++) harpBar(b, 'A', b >= 14 ? 0.82 : 0.75);
  for (let b = 16; b < 24; b++) { if (b === 18 || b === 19) harpBar(b, 'C', 0.55); else harpBar(b, 'B', 0.8); }
  for (let b = 24; b < 28; b++) harpBar(b, 'C', 0.5);
  for (let b = 28; b < 32; b++) harpBar(b, 'A', 0.55 + (b - 28) * 0.07);
  for (let b = 32; b < 40; b++) harpBar(b, 'D', 0.82);
  for (let b = 44; b < 48; b++) harpBar(b, 'A', 0.62 - (b - 44) * 0.06);

  /* ── strings (a real, voice-led section) ── */
  let prev = [57, 62, 65, 69];
  const strings = (b, vel, o) => {
    o = o || {};
    const c = CH(b);
    const pcs = c.tones.map(pc);
    const cand = []; for (let m = 52; m <= 81; m++) if (pcs.includes(pc(m))) cand.push(m);
    const next = prev.map((p) => cand.reduce((a, x) => (Math.abs(x - p) < Math.abs(a - p) ? x : a), cand[0]));
    // make sure every chord tone is present at least once
    for (const q of pcs) if (!next.some((n) => pc(n) === q)) {
      let bi = 0, bd = 99; next.forEach((n, i) => { const cands = cand.filter((x) => pc(x) === q); const x = cands.reduce((a, y) => (Math.abs(y - n) < Math.abs(a - n) ? y : a), cands[0]); if (Math.abs(x - n) < bd && next.filter((m) => pc(m) === pc(n)).length > 1) { bd = Math.abs(x - n); bi = i; } });
      const cands = cand.filter((x) => pc(x) === q); next[bi] = cands.reduce((a, y) => (Math.abs(y - next[bi]) < Math.abs(a - next[bi]) ? y : a), cands[0]);
    }
    next.sort((a, b2) => a - b2);
    prev = next;
    S.strings.push({ t: T(b), dur: o.dur || BAR, notes: next.slice(), vel, att: o.att || 0.25, rel: o.rel || 0.5, bright: o.bright || 1, bar: b });
  };
  for (let b = 8; b < 16; b++) strings(b, b < 12 ? 0.55 : 0.62, { att: 0.4, bright: b < 12 ? 1 : 0.7 });
  for (let b = 16; b < 24; b++) strings(b, b === 18 || b === 19 ? 0.7 : 0.85, { att: b === 16 || b === 20 ? 0.02 : 0.2, bright: 1.1 });
  for (let b = 32; b < 40; b++) strings(b, 0.95, { att: b === 32 ? 0.02 : 0.15, bright: 1.25 });
  for (let b = 40; b < 44; b++) strings(b, 0.6, { att: 0.6, rel: 0.8, bright: 0.85 });

  /* ── drums & clockwork ── */
  const HATV = [1, 0.38, 0.62, 0.38, 0.62, 0.38, 0.9, 0.38, 0.62, 0.38, 0.62, 0.45];
  const ticks = (b0, b1, vel) => { for (let b = b0; b < b1; b++) for (let s = 0; s < 12; s += 2) S.tick.push({ t: T(b, s) + hum(0.002), vel: vel * (s === 0 ? 1 : 0.8), tock: (s / 2) & 1 }); };
  ticks(2, 4, 0.35); ticks(4, 8, 0.5); ticks(8, 16, 0.55); ticks(16, 18, 0.5); ticks(20, 24, 0.5); ticks(32, 40, 0.45); ticks(44, 47, 0.4);
  // §1: a soft pulse under the metamorphosis
  for (let b = 4; b < 8; b++) S.kickM.push({ t: T(b), vel: 0.45 + (b - 4) * 0.1 });
  // §2: the sway
  for (let b = 8; b < 16; b++) {
    if (b === 15) break;
    S.kick.push({ t: T(b), vel: 0.9 });
    if (b % 2 === 1) S.kick.push({ t: T(b, 10), vel: 0.45 });
    S.clap.push({ t: T(b, 6), vel: 0.75 });
    for (let s = 0; s < 12; s++) S.hatC.push({ t: T(b, s) + hum(0.004), vel: HATV[s] * 0.55 });
  }
  S.kick.push({ t: T(15), vel: 0.9 });
  // bar 15: roll in sixteenths then 32nds
  for (let s = 0; s < 12; s++) S.snare.push({ t: T(15, s), vel: 0.3 + s * 0.035, rate: 1 + s * 0.006 });
  for (let i = 0; i < 12; i++) S.snare.push({ t: T(15, 6) + i * STEP * 0.5, vel: 0.55 + i * 0.03, rate: 1.08 + i * 0.012 });
  // §3: the drive
  const driveDrums = (b0, b1, skip, big) => {
    for (let b = b0; b < b1; b++) {
      if (skip && skip(b)) continue;
      S.kick.push({ t: T(b), vel: 1 }, { t: T(b, 6), vel: 0.95 });
      if (b % 2 === 1) S.kick.push({ t: T(b, 10), vel: 0.6 });
      if (big && b % 4 === 3) S.kick.push({ t: T(b, 4), vel: 0.55 });
      S.clap.push({ t: T(b, 6), vel: 1 });
      S.snare.push({ t: T(b, 3), vel: 0.16, rate: 1 }, { t: T(b, 9), vel: 0.2, rate: 1 });
      for (let s = 0; s < 12; s++) {
        if (s === 6 || s === 0) S.hatO.push({ t: T(b, s + 2) + hum(0.003), vel: 0.45 });
        else S.hatC.push({ t: T(b, s) + hum(0.004), vel: HATV[s] * 0.7 });
      }
    }
  };
  driveDrums(16, 24, (b) => b === 18 || b === 19);
  // the tribar reveal: a held breath, then a fill
  for (let s = 0; s < 12; s += 3) S.snare.push({ t: T(19, s), vel: 0.22 + s * 0.03, rate: 1 });
  for (let s = 6; s < 12; s++) S.tom.push({ t: T(19, s), note: 52 - s, vel: 0.5 + s * 0.04 });
  // the stairs: footsteps and an endless ascending arpeggio
  let shepIx = 0;
  for (let b = 20; b < 24; b++) for (const s of [0, 6]) {
    S.step.push({ t: T(b, s), vel: 0.9, alt: s ? 1 : 0 });
    const pcs = CH(b).tones.map(pc);
    const arp = []; for (let q = 48; arp.length < 40; q++) if (pcs.includes(pc(q))) arp.push(q);
    S.shep.push({ t: T(b, s) + 0.01, note: arp[shepIx++ % arp.length], vel: 0.5 });
  }
  // §4: ant steps
  for (let b = 24; b < 32; b++) for (let s = 0; s < 12; s++) {
    if (R() < 0.18) continue;
    S.ant.push({ t: T(b, s) + hum(0.01), vel: 0.25 + R() * 0.3, pan: (R() - 0.5) * 1.4 });
  }
  for (let b = 28; b < 32; b++) { S.kickM.push({ t: T(b), vel: 0.5 + (b - 28) * 0.12 }, { t: T(b, 6), vel: 0.4 + (b - 28) * 0.1 }); }
  for (let b = 30; b < 32; b++) for (let s = 0; s < 12; s++) S.hatC.push({ t: T(b, s) + hum(0.004), vel: HATV[s] * (0.3 + (b - 30) * 0.2) });
  for (let s = 0; s < 12; s++) S.snare.push({ t: T(31, s), vel: 0.35 + s * 0.035, rate: 1 + s * 0.008 });
  for (let i = 0; i < 12; i++) S.snare.push({ t: T(31, 6) + i * STEP * 0.5, vel: 0.6 + i * 0.028, rate: 1.1 + i * 0.012 });
  // §5: the climax
  driveDrums(32, 40, null, true);
  for (const b of [32, 34, 36, 38]) S.timp.push({ t: T(b), note: CH(b).tonic - 24, vel: 1 }, { t: T(b, 6), note: CH(b).tonic - 29, vel: 0.7 });
  for (const b of [35, 39]) for (let s = 6; s < 12; s++) S.tom.push({ t: T(b, s), note: 55 - (s - 6) * 2, vel: 0.55 + (s - 6) * 0.07 });
  // §6: the Risset rhythm — a beat that speeds up forever and never gets faster
  {
    const t0 = T(40), P = T(44) - t0, r0 = 1 / BEAT;
    const L = [];
    for (let j = 0; j < 5; j++) {
      const rj = r0 * Math.pow(2, j - 1);
      for (let n = 0; ; n++) {
        const t = P * Math.log2(1 + (n * Math.LN2) / (rj * P));
        if (t >= P - 0.02) break;
        const x = j - 1 + t / P;           // log2 of tempo relative to the beat
        const w = Math.exp(-0.5 * Math.pow((x - 1.1) / 0.85, 2));
        L.push({ t: t0 + t, layer: j, w });
      }
    }
    L.sort((a, b) => a.t - b.t);
    for (const e of L) {
      if (e.w < 0.03) continue;
      if (e.layer <= 2) S.kick.push({ t: e.t, vel: 0.95 * e.w, risset: 1 });
      if (e.layer >= 2) S.hatC.push({ t: e.t, vel: 0.75 * e.w, risset: 1 });
      S.risset.push([e.t, e.layer, e.w]);
    }
  }
  S.kick.push({ t: T(44), vel: 1 });
  S.kickM.push({ t: T(45), vel: 0.4 }, { t: T(46), vel: 0.3 });

  /* ── cymbals, impacts, sweeps ── */
  for (const b of [8, 16, 20, 32, 36]) S.crash.push({ t: T(b), vel: b === 8 ? 0.7 : 1 });
  for (const b of [12, 16, 20, 32, 44]) S.impact.push({ t: T(b), vel: b === 44 ? 0.9 : b === 12 ? 0.85 : 1 });
  S.impact.push({ t: T(8), vel: 0.5 });
  for (const b of [12, 16, 20, 32]) S.revCym.push({ t: T(b) - 2 * BEAT, vel: 1 });
  S.whoosh.push({ t: T(11, 6), dur: BEAT, vel: 0.7 });
  S.whoosh.push({ t: T(18), dur: 2 * BAR, vel: 0.6, slow: 1 });
  S.whoosh.push({ t: T(33, 6), dur: BEAT, vel: 0.55 }, { t: T(35, 6), dur: BEAT, vel: 0.55 }, { t: T(37, 6), dur: BEAT, vel: 0.55 });
  S.whoosh.push({ t: T(47), dur: BAR, vel: 0.6 });
  S.down.push({ t: T(24), dur: 3.2, vel: 0.8 }, { t: T(44), dur: 4, vel: 0.75 });
  // Shepard–Risset glissandi: risers that never arrive
  S.gliss.push({ t: T(6, 6), dur: T(8) - T(6, 6), vel: 0.7, rate: 5, shape: 'rise' });
  S.gliss.push({ t: T(14), dur: T(16) - T(14), vel: 0.85, rate: 6, shape: 'rise' });
  S.gliss.push({ t: T(28), dur: T(32) - T(28), vel: 0.9, rate: 4, shape: 'rise' });
  S.gliss.push({ t: T(40), dur: T(44) - T(40), vel: 0.62, rate: 3.2, shape: 'hold' });

  /* ── bells ── */
  S.bell.push({ t: 0.35, note: 81, vel: 0.35, decay: 3.2, pan: -0.2 });
  S.bell.push({ t: T(1, 6), note: 86, vel: 0.28, decay: 3, pan: 0.25 });
  for (const b of [8, 16, 32]) { const c = CH(b); S.bell.push({ t: T(b), note: c.tonic + 24, vel: 0.4, decay: 3, pan: 0 }); }
  S.bell.push({ t: T(12), note: CH(12).tonic + 19, vel: 0.45, decay: 3.4, pan: 0 });
  S.bell.push({ t: T(20), note: CH(20).tonic + 24, vel: 0.5, decay: 3, pan: 0 }, { t: T(20, 3), note: CH(20).tonic + 31, vel: 0.35, decay: 2.5, pan: 0.3 });
  S.bell.push({ t: T(48), note: 86, vel: 0.42, decay: 3.4, pan: 0 }, { t: T(48) + 0.02, note: 81, vel: 0.3, decay: 3.4, pan: -0.25 });

  /* ── marks for the picture ── */
  S.marks = { inversion: [T(12), T(34), T(36), T(38)], cubes: [], close: T(20) };
  return S;
}

/* ═════════════════════════════ THE ENGINE ═════════════════════════════ */

function* renderGen(opts) {
  opts = opts || {};
  const SR = Math.min(48000, opts.sampleRate || 44100);
  const N = Math.round(DURATION * SR);
  const S = buildScore();
  const RND = rng(1972);

  /* ---------- building blocks ---------- */
  const SIN_N = 4096;
  const SIN = new Float32Array(SIN_N + 1);
  for (let i = 0; i <= SIN_N; i++) SIN[i] = Math.sin((i / SIN_N) * TAU);
  const fsin = (ph) => {
    ph -= Math.floor(ph);
    const x = ph * SIN_N, i = x | 0;
    return SIN[i] + (SIN[i + 1] - SIN[i]) * (x - i);
  };
  // band-limited-enough wavetables for the organ stacks
  const WT_N = 2048;
  const makeWT = (harm) => {
    const t = new Float32Array(WT_N + 1);
    let mx = 0;
    for (let i = 0; i < WT_N; i++) {
      let s = 0;
      for (let h = 0; h < harm.length; h++) s += harm[h] * Math.sin(TAU * (h + 1) * i / WT_N);
      t[i] = s; mx = Math.max(mx, Math.abs(s));
    }
    for (let i = 0; i < WT_N; i++) t[i] /= mx;
    t[WT_N] = t[0];
    return { t, top: harm.length };
  };
  const WT = {
    sine: makeWT([1]),
    flute: makeWT([1, 0.16, 0.06, 0.02]),
    organ: makeWT([1, 0.5, 0.3, 0.14, 0.08, 0.05, 0.03]),
    reed: makeWT([1, 0.75, 0.55, 0.42, 0.3, 0.22, 0.15, 0.1, 0.07]),
    bass: makeWT([1, 0.55, 0.3, 0.18, 0.1, 0.06]),
  };
  const pickWT = (name, f) => {
    let w = WT[name];
    if (f * w.top > SR * 0.42) w = f * 3 < SR * 0.42 ? WT.flute : WT.sine;
    return w.t;
  };
  let noiseSeed = 0x9E3779B9;
  const noise = () => {
    noiseSeed ^= noiseSeed << 13; noiseSeed ^= noiseSeed >>> 17; noiseSeed ^= noiseSeed << 5;
    return (noiseSeed >>> 0) / 2147483648 - 1;
  };
  const svfCoef = (fc, q) => {
    const g = Math.tan(Math.PI * Math.max(20, Math.min(fc, SR * 0.45)) / SR);
    const k = 1 / q;
    const a1 = 1 / (1 + g * (g + k));
    return [a1, g * a1, g * g * a1, k];
  };
  const svfArray = (x, fc, q, mode) => {
    const [a1, a2, a3, k] = svfCoef(fc, q);
    let ic1 = 0, ic2 = 0;
    const y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
      const v0 = x[i], v3 = v0 - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
      ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
      y[i] = mode === 0 ? v2 : mode === 1 ? v1 : v0 - k * v1 - v2;
    }
    return y;
  };
  const panGains = (p) => { const a = (Math.max(-1, Math.min(1, p)) + 1) * Math.PI / 4; return [Math.cos(a), Math.sin(a)]; };
  const gauss = (x) => Math.exp(-0.5 * x * x);

  /* ---------- one-shot samples ---------- */
  const mk = (sec) => new Float32Array(Math.round(sec * SR));
  const tail = (x, ms) => { const n = Math.min(x.length, Math.round((ms || 12) * SR / 1000)); for (let i = 0; i < n; i++) x[x.length - 1 - i] *= i / n; return x; };

  function makeKick(click, body) {
    const x = mk(0.5);
    let ph = 0, clk = 0;
    for (let i = 0; i < x.length; i++) {
      const t = i / SR;
      const f = 43 + 105 * Math.exp(-t / 0.03) + 55 * Math.exp(-t / 0.004);
      ph += f / SR;
      const amp = Math.min(1, t / 0.0015) * Math.exp(-t / (0.22 * body)) * Math.min(1, (0.5 - t) / 0.05);
      let s = Math.sin(TAU * ph) * amp;
      clk += (noise() - clk) * 0.3;
      s += clk * Math.min(1, t / 0.0004) * Math.exp(-t / 0.002) * 0.45 * click;
      x[i] = Math.tanh(s * 1.7) / Math.tanh(1.7);
    }
    return x;
  }
  const kickFull = tail(makeKick(1, 1));
  const kickMuf = tail(svfArray(svfArray(makeKick(0, 1.2), 240, 0.7, 0), 240, 0.7, 0));

  function makeClap() {
    const n = Math.round(0.45 * SR);
    const out = [new Float32Array(n), new Float32Array(n)];
    for (let ch = 0; ch < 2; ch++) {
      const raw = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        let e = 0;
        for (const tk of [0, 0.011, 0.023]) if (t >= tk) e += Math.exp(-(t - tk) / 0.004);
        if (t >= 0.033) e += 0.85 * Math.exp(-(t - 0.033) / (0.14 + ch * 0.012));
        raw[i] = noise() * e;
      }
      const bp = svfArray(raw, 1100 + ch * 80, 1.1, 1);
      const hp = svfArray(raw, 2600, 0.7, 2);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        out[ch][i] = (bp[i] * 1.5 + hp[i] * 0.3 + Math.sin(TAU * 180 * t) * Math.exp(-t / 0.03) * 0.3) * 0.6;
      }
    }
    return out;
  }
  const clapS = makeClap().map((x) => tail(x, 30));

  function makeSnare() {
    const n = Math.round(0.3 * SR);
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) raw[i] = noise();
    const nz = svfArray(raw, 3400, 0.6, 1);
    const x = new Float32Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      ph += (180 + 60 * Math.exp(-t / 0.02)) / SR;
      x[i] = Math.sin(TAU * ph) * Math.exp(-t / 0.045) * 0.7 + nz[i] * Math.exp(-t / 0.07) * 1.2;
    }
    return x;
  }
  const snareS = tail(makeSnare(), 30);

  function makeMetal(len, decay, hpf) {
    const n = Math.round(len * SR);
    const fr = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0].map((f) => f * 1.75);
    const ph = fr.map(() => RND());
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j < 6; j++) { ph[j] += fr[j] / SR; s += (ph[j] % 1) < 0.5 ? 1 : -1; }
      raw[i] = s / 6 * 0.6 + noise() * 0.5;
    }
    const bp = svfArray(raw, 9000, 0.8, 1);
    const hp = svfArray(bp, hpf, 0.7, 2);
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      x[i] = hp[i] * Math.exp(-t / decay) * Math.min(1, t / 0.0006) * Math.min(1, (len - t) / 0.01) * 1.6;
    }
    return x;
  }
  const hatC = makeMetal(0.08, 0.018, 7200);
  const hatO = makeMetal(0.36, 0.1, 6800);

  // clockwork: two little escapement clicks, a tick and a tock
  function makeTick(f, len) {
    const x = mk(len);
    const parts = [[f, 0.012, 1], [f * 2.63, 0.006, 0.5], [f * 0.51, 0.02, 0.35], [f * 4.1, 0.003, 0.3]];
    for (let i = 0; i < x.length; i++) {
      const t = i / SR;
      let s = 0;
      for (const [fr, d, a] of parts) s += Math.sin(TAU * fr * t) * Math.exp(-t / d) * a;
      s += noise() * Math.exp(-t / 0.0012) * 0.8;
      x[i] = s * Math.min(1, t / 0.0002);
    }
    return tail(svfArray(x, 900, 0.7, 2), 8);
  }
  const tickS = makeTick(2750, 0.07), tockS = makeTick(2050, 0.08), antS = makeTick(4200, 0.03);

  // a footstep on stone
  function makeStep(f) {
    const x = mk(0.3);
    let ph = 0;
    for (let i = 0; i < x.length; i++) {
      const t = i / SR;
      ph += (f + f * 0.8 * Math.exp(-t / 0.012)) / SR;
      x[i] = Math.sin(TAU * ph) * Math.exp(-t / 0.06) * 0.8 + noise() * Math.exp(-t / 0.008) * 0.35;
    }
    return tail(svfArray(x, 1400, 0.6, 0), 20);
  }
  const stepS = [makeStep(105), makeStep(92)];

  function makeCrash() {
    const n = Math.round(3.4 * SR);
    const out = [];
    for (let ch = 0; ch < 2; ch++) {
      const raw = new Float32Array(n);
      const fr = [311, 437, 587, 733, 881, 1133, 1437, 1789].map((f) => f * (1 + ch * 0.013));
      const ph = fr.map(() => RND());
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let j = 0; j < fr.length; j++) { ph[j] += fr[j] / SR; s += (ph[j] % 1) < 0.5 ? 1 : -1; }
        raw[i] = noise() * 0.8 + s * 0.05;
      }
      const hp = svfArray(svfArray(raw, 3800, 0.7, 2), 12500, 0.7, 0);
      const x = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        x[i] = hp[i] * (Math.exp(-t / 1.0) * 0.8 + Math.exp(-t / 0.08) * 0.6) * Math.min(1, t / 0.002) * Math.min(1, (3.4 - t) / 0.3);
      }
      out.push(x);
    }
    return out;
  }
  const crashS = makeCrash();
  const revS = (() => {
    const len = Math.round(2 * BEAT * SR);
    const out = [];
    for (let ch = 0; ch < 2; ch++) {
      const x = new Float32Array(len);
      for (let i = 0; i < len; i++) { const t = i / len; x[i] = crashS[ch][len - 1 - i] * t * t * 1.2; }
      out.push(tail(x, 6));
    }
    return out;
  })();

  function makeImpact() {
    const n = Math.round(3.2 * SR);
    const x = new Float32Array(n);
    let ph = 0, lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      ph += (26 + 55 * Math.exp(-t / 0.35)) / SR;
      const sub = Math.sin(TAU * ph) * Math.exp(-t / 1.1) * Math.min(1, t / 0.004);
      const c = 1 - Math.exp(-TAU * (90 + 2400 * Math.exp(-t / 0.12)) / SR);
      lp += (noise() - lp) * c;
      x[i] = Math.tanh((sub * 0.9 + lp * Math.exp(-t / 0.35) * 0.9) * 1.3) * Math.min(1, (3.2 - t) / 0.3);
    }
    return x;
  }
  const impactS = makeImpact();

  /* ---------- automation ---------- */
  function duckDepth(t) {
    const b = t / BAR;
    if ((b >= 16 && b < 24) || (b >= 32 && b < 40)) return 0.55;
    if (b >= 40 && b < 44) return 0.35;
    if (b >= 8 && b < 16) return 0.38;
    if (b >= 28 && b < 32) return 0.25;
    return 0;
  }

  /* ---------- voices ---------- */
  const voices = [];
  const V = (v, o) => { Object.assign(v, o); voices.push(v); return v; };

  function SampleVoice(t, L, R, rate, pan) {
    this.start = Math.round(t * SR);
    this.L = L; this.R = R || L;
    this.rate = rate || 1;
    this.end = this.start + Math.floor((this.L.length - 2) / this.rate);
    const [gl, gr] = panGains(pan || 0);
    this.gl = gl * Math.SQRT2; this.gr = gr * Math.SQRT2;
  }
  SampleVoice.prototype.process = function (L, R, off, len, abs) {
    const dL = this.L, dR = this.R, rate = this.rate, gl = this.gl, gr = this.gr;
    let l = abs - this.start;
    if (rate === 1) {
      for (let k = 0; k < len; k++, l++) { L[off + k] = dL[l] * gl; R[off + k] = dR[l] * gr; }
    } else {
      for (let k = 0; k < len; k++, l++) {
        const x = l * rate, i = x | 0, f = x - i;
        L[off + k] = (dL[i] + (dL[i + 1] - dL[i]) * f) * gl;
        R[off + k] = (dR[i] + (dR[i + 1] - dR[i]) * f) * gr;
      }
    }
  };

  // Shepard stack: every note sounds in all octaves at once, weighted by a
  // fixed bell curve over log-frequency, so octave is ambiguous and a scale
  // can climb (or fall) for ever.
  function ShepVoice(p, table) {
    this.start = Math.round(p.t * SR);
    this.noteLen = Math.max(1, Math.round(p.dur * SR));
    this.att = Math.max(1, Math.round((p.att || 0.02) * SR));
    this.rel = Math.max(1, Math.round((p.rel || 0.2) * SR));
    this.end = Math.min(N, this.start + this.noteLen + this.rel);
    const ph = [], dt = [], wl = [], wr = [], tb = [];
    const sigma = p.sigma || 1, center = p.center || 300;
    let norm = 0;
    const notes = p.notes || [p.note];
    notes.forEach((m, ni) => {
      for (let k = -7; k <= 7; k++) {
        const f = mtof(m + 12 * k);
        if (f < 24 || f > 9500) continue;
        const w = gauss(Math.log2(f / center) / sigma);
        if (w < 0.015) continue;
        const det = (RND() - 0.5) * (p.det === undefined ? 0.003 : p.det);
        dt.push(f * (1 + det) / SR); ph.push(RND());
        const pan = (p.pan || 0) + (p.spread || 0) * (((ni + k) & 1) ? 1 : -1) * (0.4 + 0.6 * RND());
        const [gl, gr] = panGains(pan);
        wl.push(w * gl); wr.push(w * gr); tb.push(pickWT(table, f));
        norm += w * w;
      }
    });
    const g = 1 / Math.sqrt(Math.max(1e-6, norm / notes.length)) / Math.sqrt(notes.length);
    for (let i = 0; i < wl.length; i++) { wl[i] *= g; wr[i] *= g; }
    this.n = dt.length; this.ph = ph; this.dt = dt; this.wl = wl; this.wr = wr; this.tb = tb;
    this.shape = p.shape || 'pad'; this.pluck = p.pluck || 0;
    this.trem = p.trem || 0; this.tp = RND();
    this.lpL = 0; this.lpR = 0;
    this.cut = p.cut || 0;
  }
  ShepVoice.prototype.process = function (L, R, off, len, abs) {
    const n = this.n, ph = this.ph, dt = this.dt, wl = this.wl, wr = this.wr, tb = this.tb;
    const att = this.att, noteLen = this.noteLen, rel = this.rel, pluck = this.pluck, trem = this.trem;
    let local = abs - this.start, tp = this.tp, lpL = this.lpL, lpR = this.lpR;
    const cut = this.cut;
    let c = 1;
    for (let k = 0; k < len; k++, local++) {
      let sl = 0, sr = 0;
      for (let j = 0; j < n; j++) {
        let p = ph[j] + dt[j]; if (p >= 1) p -= 1; ph[j] = p;
        const tab = tb[j], x = p * WT_N, i = x | 0;
        const v = tab[i] + (tab[i + 1] - tab[i]) * (x - i);
        sl += v * wl[j]; sr += v * wr[j];
      }
      let e = local < att ? local / att : 1;
      e = e * e * (3 - 2 * e);
      if (pluck) e *= (1 - pluck) + pluck * Math.exp(-local / (0.12 * SR));
      if (local >= noteLen) { const x = 1 - (local - noteLen) / rel; e *= x > 0 ? x * x : 0; }
      if (trem) { tp += 5.2 / SR; if (tp >= 1) tp -= 1; e *= 1 - trem * (0.5 + 0.5 * fsin(tp)); }
      if (cut) {
        if ((local & 31) === 0 || k === 0) { const fc = cut * (1 + 3 * pluck * Math.exp(-local / (0.07 * SR))); c = 1 - Math.exp(-TAU * Math.min(fc, 16000) / SR); }
        lpL += (sl - lpL) * c; lpR += (sr - lpR) * c; sl = lpL; sr = lpR;
      }
      L[off + k] = sl * e; R[off + k] = sr * e;
    }
    this.tp = tp; this.lpL = lpL; this.lpR = lpR;
  };

  // A harpsichord note: plucked strings (Karplus–Strong with allpass tuning),
  // one per register (16′ 8′ 4′), weighted by the same Shepard window.
  function HarpVoice(p) {
    this.start = Math.round(p.t * SR);
    this.noteLen = Math.round(p.dur * SR);
    const center = p.center || 420, sigma = p.sigma || 1.05;
    this.strings = [];
    let norm = 0;
    for (const o of [-12, 0, 12]) {
      const f = mtof(p.note + o);
      if (f > 4200 || f < 35) continue;
      const w = gauss(Math.log2(f / center) / sigma) * (o === 0 ? 1.15 : 1);
      if (w < 0.06) continue;
      norm += w * w;
      let D = SR / f - 0.35;
      let Ni = Math.floor(D), fr = D - Ni;
      if (fr < 0.2) { Ni -= 1; fr += 1; }
      const buf = new Float32Array(Ni);
      let lp = 0;
      const tmp = new Float32Array(Ni);
      for (let i = 0; i < Ni; i++) { lp += (noise() - lp) * 0.86; tmp[i] = lp; }
      const pick = Math.max(1, Math.round(Ni * 0.09));
      let mean = 0;
      for (let i = 0; i < Ni; i++) { buf[i] = tmp[i] - 0.8 * tmp[(i + pick) % Ni]; mean += buf[i]; }
      mean /= Ni;
      let mx = 1e-9;
      for (let i = 0; i < Ni; i++) { buf[i] -= mean; mx = Math.max(mx, Math.abs(buf[i])); }
      for (let i = 0; i < Ni; i++) buf[i] /= mx;
      const dec = Math.max(0.7, Math.min(4.5, 3.2 * Math.sqrt(220 / f)));
      this.strings.push({ buf, n: Ni, p: 0, C: (1 - fr) / (1 + fr), x1: 0, y1: 0, prev: 0, hp: 0, w,
        rho: Math.pow(10, -3 / (f * dec)), rhoD: Math.pow(10, -3 / (f * 0.09)) });
    }
    const g = 1 / Math.sqrt(Math.max(1e-6, norm));
    for (const s of this.strings) s.w *= g;
    this.end = Math.min(N, this.start + this.noteLen + Math.round(0.25 * SR));
    const [gl, gr] = panGains(p.pan || 0);
    this.gl = gl; this.gr = gr;
    this.total = this.end - this.start;
  }
  HarpVoice.prototype.process = function (L, R, off, len, abs) {
    const gl = this.gl, gr = this.gr, noteLen = this.noteLen, total = this.total;
    let local0 = abs - this.start;
    for (let k = 0; k < len; k++) { L[off + k] = 0; }
    for (const s of this.strings) {
      const buf = s.buf, n = s.n, C = s.C, w = s.w;
      let p = s.p, x1 = s.x1, y1 = s.y1, prev = s.prev, hp = s.hp;
      let local = local0;
      for (let k = 0; k < len; k++, local++) {
        const rho = local < noteLen ? s.rho : s.rhoD;
        const out = buf[p];
        const avg = (0.62 * out + 0.38 * prev) * rho;
        prev = out;
        const y = C * avg + x1 - C * y1;
        x1 = avg; y1 = y;
        buf[p] = y;
        p++; if (p >= n) p = 0;
        hp += (out - hp) * 0.006;
        L[off + k] += (out - hp) * w;
      }
      s.p = p; s.x1 = x1; s.y1 = y1; s.prev = prev; s.hp = hp;
    }
    let local = local0;
    for (let k = 0; k < len; k++, local++) {
      let e = Math.min(1, local / 20);
      if (local > total - 400) e *= Math.max(0, (total - local) / 400);
      const v = L[off + k] * e;
      L[off + k] = v * gl; R[off + k] = v * gr;
    }
  };

  function PadVoice(p) {
    this.start = Math.round(p.t * SR);
    this.noteLen = Math.round(p.dur * SR);
    this.att = Math.max(1, Math.round(p.att * SR));
    this.rel = Math.max(1, Math.round(p.rel * SR));
    this.end = Math.min(N, this.start + this.noteLen + this.rel);
    const det = [-0.14, -0.05, 0.05, 0.14];
    const n = p.notes.length * det.length;
    this.n = n;
    this.ph = new Float64Array(n); this.dt = new Float64Array(n);
    this.gl = new Float32Array(n); this.gr = new Float32Array(n);
    let j = 0;
    p.notes.forEach((m, ni) => {
      det.forEach((d, di) => {
        this.ph[j] = RND();
        this.dt[j] = mtof(m + d) / SR;
        const sp = ((di / (det.length - 1)) * 2 - 1) * (ni & 1 ? -0.8 : 0.8);
        const [gl, gr] = panGains(sp);
        const w = 1 / Math.sqrt(n);
        this.gl[j] = gl * w; this.gr[j] = gr * w;
        j++;
      });
    });
    this.bright = p.bright || 1;
    this.l1 = this.l2 = this.r1 = this.r2 = 0;
    this.c = [0, 0, 0];
    this.vib = RND();
  }
  PadVoice.prototype.process = function (L, R, off, len, abs) {
    const n = this.n, ph = this.ph, dt = this.dt, GL = this.gl, GR = this.gr;
    let l1 = this.l1, l2 = this.l2, r1 = this.r1, r2 = this.r2;
    let a1 = this.c[0], a2 = this.c[1], a3 = this.c[2];
    const att = this.att, noteLen = this.noteLen, rel = this.rel;
    let local = abs - this.start, vib = this.vib;
    let vm = 1;
    for (let k = 0; k < len; k++, local++) {
      if ((local & 31) === 0 || k === 0) {
        const fc = Math.min(12000, 2600 * this.bright * (0.8 + 0.2 * Math.min(1, local / (0.6 * SR))));
        const g = Math.tan(Math.PI * fc / SR);
        a1 = 1 / (1 + g * (g + 1.3)); a2 = g * a1; a3 = g * a2;
        vib += 32 * 5.1 / SR; if (vib > 1) vib -= 1;
        vm = 1 + 0.0025 * Math.min(1, local / (0.5 * SR)) * fsin(vib);
      }
      let sl = 0, sr = 0;
      for (let j = 0; j < n; j++) {
        let p = ph[j]; const d = dt[j] * vm;
        let v = 2 * p - 1;
        if (p < d) { const x = p / d; v -= x + x - x * x - 1; }
        else if (p > 1 - d) { const x = (p - 1) / d; v -= x * x + x + x + 1; }
        p += d; if (p >= 1) p -= 1; ph[j] = p;
        sl += v * GL[j]; sr += v * GR[j];
      }
      let e = local < att ? local / att : 1;
      e = e * e * (3 - 2 * e);
      if (local >= noteLen) { const x = 1 - (local - noteLen) / rel; e *= x > 0 ? x * x : 0; }
      let v3 = sl - l2, v1 = a1 * l1 + a2 * v3, v2 = l2 + a2 * l1 + a3 * v3;
      l1 = 2 * v1 - l1; l2 = 2 * v2 - l2;
      L[off + k] = v2 * e;
      v3 = sr - r2; v1 = a1 * r1 + a2 * v3; v2 = r2 + a2 * r1 + a3 * v3;
      r1 = 2 * v1 - r1; r2 = 2 * v2 - r2;
      R[off + k] = v2 * e;
    }
    this.l1 = l1; this.l2 = l2; this.r1 = r1; this.r2 = r2;
    this.c[0] = a1; this.c[1] = a2; this.c[2] = a3; this.vib = vib;
  };

  function BellVoice(p) {
    this.start = Math.round(p.t * SR);
    this.decay = p.decay || 2;
    this.end = Math.min(N, this.start + Math.round(this.decay * 3.2 * SR));
    this.f = mtof(p.note);
    this.ratio = p.ratio || 3.5; this.idx = p.idx === undefined ? 3 : p.idx;
    this.pc = 0; this.pm = 0; this.pc2 = 0; this.pm2 = 0;
    const [gl, gr] = panGains(p.pan || 0);
    this.gl = gl; this.gr = gr;
  }
  BellVoice.prototype.process = function (L, R, off, len, abs) {
    const f = this.f, gl = this.gl, gr = this.gr;
    let pc = this.pc, pm = this.pm, pc2 = this.pc2, pm2 = this.pm2;
    const dc = f / SR, dm = f * this.ratio / SR, dc2 = f * 2.001 / SR, dm2 = f * 1.001 / SR;
    const tauA = this.decay * SR, total = this.end - this.start, I = this.idx;
    let local = abs - this.start;
    let eI = Math.exp(-local / (0.11 * SR)), eM = Math.exp(-local / (0.2 * SR));
    let eA = Math.exp(-local / tauA), eP = Math.exp(-local / (tauA * 0.4));
    const kI = Math.exp(-1 / (0.11 * SR)), kM = Math.exp(-1 / (0.2 * SR)), kA = Math.exp(-1 / tauA), kP = Math.exp(-1 / (tauA * 0.4));
    const att = 0.0015 * SR;
    for (let k = 0; k < len; k++, local++) {
      const s1 = fsin(pc + (I * eI + 0.55) * fsin(pm) * 0.15915494);
      const s2 = fsin(pc2 + 0.15 * eM * fsin(pm2));
      pc += dc; pm += dm; pc2 += dc2; pm2 += dm2;
      let e = (local < att ? local / att : 1) * eA;
      if (local > total - 2000) e *= Math.max(0, (total - local) / 2000);
      const s = (s1 * 0.8 + s2 * 0.3 * eP) * e;
      eI *= kI; eM *= kM; eA *= kA; eP *= kP;
      L[off + k] = s * gl; R[off + k] = s * gr;
    }
    if (pc > 1e4) { pc -= Math.floor(pc); pm -= Math.floor(pm); pc2 -= Math.floor(pc2); pm2 -= Math.floor(pm2); }
    this.pc = pc; this.pm = pm; this.pc2 = pc2; this.pm2 = pm2;
  };

  function TimpVoice(p) {
    this.start = Math.round(p.t * SR);
    this.end = Math.min(N, this.start + Math.round(2.2 * SR));
    const f = mtof(p.note);
    this.parts = [[1, 1.3, 1], [1.504, 0.9, 0.55], [1.742, 0.7, 0.35], [2.0, 0.6, 0.25], [2.245, 0.45, 0.15]].map(([r, d, a]) => ({ dt: f * r / SR, ph: RND(), k: Math.exp(-1 / (d * SR)), a }));
    this.e = this.parts.map(() => 1);
    this.local = 0;
  }
  TimpVoice.prototype.process = function (L, R, off, len, abs) {
    let local = abs - this.start;
    const total = this.end - this.start;
    for (let k = 0; k < len; k++, local++) {
      const t = local / SR;
      const bend = 1 + 0.035 * Math.exp(-t / 0.05);
      let s = 0;
      for (let i = 0; i < this.parts.length; i++) {
        const q = this.parts[i];
        q.ph += q.dt * bend; if (q.ph >= 1) q.ph -= 1;
        s += fsin(q.ph) * this.e[i] * q.a;
        this.e[i] *= q.k;
      }
      s += noise() * Math.exp(-t / 0.012) * 0.5;
      let e = Math.min(1, local / 30);
      if (local > total - 1500) e *= Math.max(0, (total - local) / 1500);
      L[off + k] = s * e; R[off + k] = s * e;
    }
  };

  function TomVoice(p) {
    this.start = Math.round(p.t * SR);
    this.end = Math.min(N, this.start + Math.round(0.5 * SR));
    this.f = mtof(p.note); this.ph = 0;
  }
  TomVoice.prototype.process = function (L, R, off, len, abs) {
    let local = abs - this.start, ph = this.ph;
    const total = this.end - this.start;
    for (let k = 0; k < len; k++, local++) {
      const t = local / SR;
      ph += this.f * (1 + 0.6 * Math.exp(-t / 0.03)) / SR;
      let s = Math.sin(TAU * ph) * Math.exp(-t / 0.18) + noise() * Math.exp(-t / 0.01) * 0.3;
      let e = Math.min(1, local / 20);
      if (local > total - 800) e *= Math.max(0, (total - local) / 800);
      s = Math.tanh(s * 1.4) * e;
      L[off + k] = s; R[off + k] = s;
    }
    this.ph = ph;
  };

  // Shepard–Risset glissando: a tone that rises for ever
  function GlissVoice(p) {
    this.start = Math.round(p.t * SR);
    this.end = Math.min(N, this.start + Math.round(p.dur * SR));
    this.total = this.end - this.start;
    this.rate = p.rate; this.shape = p.shape;
    this.slots = [];
    for (let j = 0; j < 9; j++) this.slots.push({ p: 24 + 12 * j + RND() * 0.01, ph: RND(), ph2: RND() });
    this.center = 62; this.sigma = 16;
    this.lfo = RND();
  }
  GlissVoice.prototype.process = function (L, R, off, len, abs) {
    let local = abs - this.start;
    const total = this.total, rate = this.rate / SR;
    for (let k = 0; k < len; k++, local++) {
      const x = local / total;
      let g;
      if (this.shape === 'rise') g = x * x * Math.min(1, (1 - x) * 30);
      else g = Math.min(1, x * 6, (1 - x) * 5);
      let sl = 0, sr = 0;
      for (const s of this.slots) {
        s.p += rate;
        if (s.p > 24 + 12 * 9) s.p -= 12 * 9;
        const f = 440 * Math.pow(2, (s.p - 69) / 12);
        const w = gauss((s.p - this.center) / this.sigma);
        s.ph += f / SR; if (s.ph >= 1) s.ph -= 1;
        s.ph2 += f * 1.003 / SR; if (s.ph2 >= 1) s.ph2 -= 1;
        sl += fsin(s.ph) * w; sr += fsin(s.ph2) * w;
      }
      L[off + k] = sl * g * 0.5; R[off + k] = sr * g * 0.5;
    }
  };

  // noise effects: 'down' | 'whoosh'
  function NoiseVoice(p, mode) {
    this.start = Math.round(p.t * SR);
    this.end = Math.min(N, this.start + Math.round(p.dur * SR));
    this.total = this.end - this.start;
    this.mode = mode; this.slow = p.slow || 0;
    this.s = [0, 0, 0, 0];
    this.seedL = 0x1234567 + this.start; this.seedR = 0x7654321 + this.start * 3;
  }
  NoiseVoice.prototype.process = function (L, R, off, len, abs) {
    const s = this.s, total = this.total, mode = this.mode;
    let sL = this.seedL | 0, sR = this.seedR | 0;
    let a1 = 0, a2 = 0, a3 = 0, gain = 0;
    let local = abs - this.start;
    for (let k = 0; k < len; k++, local++) {
      const x = local / total;
      if ((local & 31) === 0 || k === 0) {
        let fc, q;
        if (mode === 'down') { fc = 5000 * Math.pow(0.03, Math.sqrt(x)); q = 1.6; gain = Math.pow(1 - x, 2) * 0.7; }
        else if (this.slow) { fc = 400 * Math.pow(12, Math.sin(Math.PI * x)); q = 0.8; gain = Math.sin(Math.PI * x) * 0.6; }
        else { fc = 300 * Math.pow(22, x); q = 0.9; gain = Math.pow(x, 2.5) * Math.min(1, (1 - x) * 25); }
        const g = Math.tan(Math.PI * Math.max(40, Math.min(fc, 16000)) / SR);
        const kq = 1 / q; a1 = 1 / (1 + g * (g + kq)); a2 = g * a1; a3 = g * a2;
      }
      sL ^= sL << 13; sL ^= sL >>> 17; sL ^= sL << 5;
      sR ^= sR << 13; sR ^= sR >>> 17; sR ^= sR << 5;
      const nL = (sL >>> 0) / 2147483648 - 1, nR = (sR >>> 0) / 2147483648 - 1;
      let v3 = nL - s[1], v1 = a1 * s[0] + a2 * v3, v2 = s[1] + a2 * s[0] + a3 * v3;
      s[0] = 2 * v1 - s[0]; s[1] = 2 * v2 - s[1];
      const oL = v1;
      v3 = nR - s[3]; v1 = a1 * s[2] + a2 * v3; v2 = s[3] + a2 * s[2] + a3 * v3;
      s[2] = 2 * v1 - s[2]; s[3] = 2 * v2 - s[3];
      L[off + k] = oL * gain; R[off + k] = v1 * gain;
    }
    this.seedL = sL; this.seedR = sR;
  };

  /* ---------- instantiate the score ---------- */
  for (const e of S.kick) V(new SampleVoice(e.t, kickFull, null, 1, 0), { stem: ST.kick, bus: 0, gain: 0.78 * e.vel, rev: 0, dly: 0 });
  for (const e of S.kickM) V(new SampleVoice(e.t, kickMuf, null, 1, 0), { stem: ST.kick, bus: 0, gain: 0.85 * e.vel, rev: 0.05, dly: 0 });
  for (const e of S.clap) V(new SampleVoice(e.t, clapS[0], clapS[1], 1, 0), { stem: ST.snare, bus: 0, gain: 1.25 * e.vel, rev: 0.25, dly: 0 });
  for (const e of S.snare) V(new SampleVoice(e.t, snareS, null, e.rate, 0), { stem: ST.snare, bus: 0, gain: 0.55 * e.vel, rev: 0.25, dly: 0 });
  for (const e of S.hatC) V(new SampleVoice(e.t, hatC, null, 1, 0.25), { stem: ST.hat, bus: 0, gain: 0.52 * e.vel, rev: 0.03, dly: 0 });
  for (const e of S.hatO) V(new SampleVoice(e.t, hatO, null, 1, -0.2), { stem: ST.hat, bus: 0, gain: 0.36 * e.vel, rev: 0.06, dly: 0 });
  for (const e of S.tick) V(new SampleVoice(e.t, e.tock ? tockS : tickS, null, 1, e.tock ? 0.45 : -0.45), { stem: ST.tick, bus: 0, gain: 0.3 * e.vel, rev: 0.12, dly: 0.08 });
  for (const e of S.ant) V(new SampleVoice(e.t, antS, null, 1, e.pan), { stem: ST.tick, bus: 0, gain: 0.16 * e.vel, rev: 0.2, dly: 0.1 });
  for (const e of S.step) V(new SampleVoice(e.t, stepS[e.alt], null, 1, e.alt ? 0.15 : -0.15), { stem: ST.timp, bus: 0, gain: 0.55 * e.vel, rev: 0.3, dly: 0 });
  for (const e of S.crash) V(new SampleVoice(e.t, crashS[0], crashS[1], 1, 0), { stem: ST.hat, bus: 0, gain: 0.28 * e.vel, rev: 0.2, dly: 0 });
  for (const e of S.revCym) V(new SampleVoice(e.t, revS[0], revS[1], 1, 0), { stem: ST.fx, bus: 0, gain: 0.28 * e.vel, rev: 0.25, dly: 0 });
  for (const e of S.impact) V(new SampleVoice(e.t, impactS, null, 1, 0), { stem: ST.fx, bus: 0, gain: 0.5 * e.vel, rev: 0.35, dly: 0 });
  for (const e of S.timp) V(new TimpVoice(e), { stem: ST.timp, bus: 0, gain: 0.26 * e.vel, rev: 0.3, dly: 0 });
  for (const e of S.tom) V(new TomVoice(e), { stem: ST.timp, bus: 0, gain: 0.42 * e.vel, rev: 0.22, dly: 0 });
  for (const e of S.organ) V(new ShepVoice({ ...e, spread: 0.55, trem: 0.05 }, 'organ'), { stem: ST.organ, bus: 1, gain: 0.3 * e.vel, rev: 0.4, dly: 0 });
  for (const e of S.bass) V(new ShepVoice({ t: e.t, dur: e.dur, note: e.note, att: e.pluck ? 0.004 : 0.05, rel: e.pluck ? 0.05 : 0.25, center: 72, sigma: 0.62, pluck: e.pluck * 0.6, cut: e.pluck ? 700 : 900, det: 0 }, 'bass'), { stem: ST.bass, bus: 1, gain: 0.62 * e.vel, rev: 0, dly: 0 });
  for (const e of S.lead) {
    const loud = e.voice === 1;
    V(new ShepVoice({ t: e.t, dur: e.dur, note: e.note, att: 0.018, rel: 0.12, center: 620, sigma: 0.85, trem: 0.07, spread: 0.2 }, loud ? 'reed' : 'flute'), { stem: ST.lead, bus: 0, gain: (loud ? 0.3 : 0.34) * e.vel, rev: 0.3, dly: 0.2 });
  }
  for (const e of S.canon) {
    if (e.voice === 2) V(new ShepVoice({ t: e.t, dur: e.dur, note: e.note, att: 0.05, rel: 0.2, center: 190, sigma: 0.7, trem: 0.04 }, 'organ'), { stem: ST.organ, bus: 1, gain: 0.3 * e.vel, rev: 0.3, dly: 0 });
    else V(new BellVoice({ t: e.t, note: e.note, decay: 0.9 + e.dur * 0.8, pan: e.pan, ratio: 4, idx: 1.6 }), { stem: ST.bell, bus: 0, gain: 0.17 * e.vel, rev: 0.35, dly: 0.25 });
  }
  for (const e of S.harp) V(new HarpVoice(e), { stem: ST.harp, bus: 0, gain: 1.45 * e.vel, rev: 0.22, dly: 0.06 });
  for (const e of S.strings) V(new PadVoice(e), { stem: ST.strings, bus: 1, gain: 0.26 * e.vel, rev: 0.35, dly: 0 });
  for (const e of S.bell) V(new BellVoice(e), { stem: ST.bell, bus: 0, gain: 0.3 * e.vel, rev: 0.45, dly: 0.28 });
  for (const e of S.shep) V(new ShepVoice({ t: e.t, dur: 0.5, note: e.note, att: 0.003, rel: 0.4, center: 700, sigma: 0.75, pluck: 0.85, det: 0 }, 'flute'), { stem: ST.bell, bus: 0, gain: 0.28 * e.vel, rev: 0.4, dly: 0.2 });
  for (const e of S.gliss) V(new GlissVoice(e), { stem: ST.fx, bus: 0, gain: 0.2 * e.vel, rev: 0.4, dly: 0 });
  for (const e of S.whoosh) V(new NoiseVoice(e, 'whoosh'), { stem: ST.fx, bus: 0, gain: 0.3 * e.vel, rev: 0.45, dly: 0 });
  for (const e of S.down) V(new NoiseVoice(e, 'down'), { stem: ST.fx, bus: 0, gain: 0.26 * e.vel, rev: 0.4, dly: 0 });
  voices.sort((a, b) => a.start - b.start);

  /* ---------- sends: plate reverb + ping-pong delay ---------- */
  function makePlate(p) {
    const sc = SR / 29761;
    const Lx = (x) => Math.max(2, Math.round(x * sc));
    const ring = (n) => ({ b: new Float32Array(n), n, w: 0 });
    const pre = ring(Math.max(2, Math.round(p.predelay * SR)));
    const ins = [Lx(142), Lx(107), Lx(379), Lx(277)].map(ring);
    const inG = [p.inDiff1, p.inDiff1, p.inDiff2, p.inDiff2];
    const exc = p.excursion * sc;
    const mAn = Lx(672), mBn = Lx(908);
    const mA = ring(mAn + Math.ceil(exc) + 3), mB = ring(mBn + Math.ceil(exc) + 3);
    const dA1 = ring(Lx(4453)), aA2 = ring(Lx(1800)), dA2 = ring(Lx(3720));
    const dB1 = ring(Lx(4217)), aB2 = ring(Lx(2656)), dB2 = ring(Lx(3163));
    const tap = (r, d) => { let i = r.w - d; if (i < 0) i += r.n; return r.b[i]; };
    const tL = [[dB1, Lx(266), 1], [dB1, Lx(2974), 1], [aB2, Lx(1913), -1], [dB2, Lx(1996), 1], [dA1, Lx(1990), -1], [aA2, Lx(187), -1], [dA2, Lx(1066), -1]];
    const tR = [[dA1, Lx(353), 1], [dA1, Lx(3627), 1], [aA2, Lx(1228), -1], [dA2, Lx(2673), 1], [dB1, Lx(2111), -1], [aB2, Lx(335), -1], [dB2, Lx(121), -1]];
    let bw = 0, dampA = 0, dampB = 0, lfo = 0;
    const decay = p.decay, damp = p.damping, band = p.bandwidth, dd1 = p.decDiff1, dd2 = p.decDiff2;
    const push = (r, v) => { r.b[r.w] = v; r.w = r.w + 1 === r.n ? 0 : r.w + 1; };
    const ap = (r, x, g) => { const d = r.b[r.w]; const v = x + g * d; push(r, v); return d - g * v; };
    const modAp = (r, x, g, len, off) => {
      let fp = r.w - len - off; if (fp < 0) fp += r.n;
      const i0 = Math.floor(fp), fr = fp - i0;
      const i1 = i0 + 1 >= r.n ? 0 : i0 + 1;
      const d = r.b[i0] + (r.b[i1] - r.b[i0]) * fr;
      const v = x + g * d;
      push(r, v);
      return d - g * v;
    };
    return function (inp, outL, outR, n) {
      for (let i = 0; i < n; i++) {
        const x0 = pre.b[pre.w]; push(pre, inp[i]);
        bw += (x0 - bw) * band;
        let x = bw;
        for (let j = 0; j < 4; j++) x = ap(ins[j], x, -inG[j]);
        lfo += 0.9 / SR; if (lfo > 1) lfo -= 1;
        const m = Math.sin(lfo * TAU) * exc;
        const lastA = tap(dA2, dA2.n), lastB = tap(dB2, dB2.n);
        const a = modAp(mA, x + decay * lastB, dd1, mAn, m);
        const a1o = tap(dA1, dA1.n); push(dA1, a);
        dampA += (a1o - dampA) * (1 - damp);
        push(dA2, ap(aA2, dampA * decay, -dd2));
        const b = modAp(mB, x + decay * lastA, dd1, mBn, -m);
        const b1o = tap(dB1, dB1.n); push(dB1, b);
        dampB += (b1o - dampB) * (1 - damp);
        push(dB2, ap(aB2, dampB * decay, -dd2));
        let yl = 0, yr = 0;
        for (let j = 0; j < 7; j++) { yl += tap(tL[j][0], tL[j][1]) * tL[j][2]; yr += tap(tR[j][0], tR[j][1]) * tR[j][2]; }
        outL[i] += yl * 0.6; outR[i] += yr * 0.6;
      }
    };
  }
  const plate = makePlate({ predelay: 0.025, bandwidth: 0.6, inDiff1: 0.75, inDiff2: 0.625, decay: 0.78, damping: 0.45, decDiff1: 0.7, decDiff2: 0.5, excursion: 12 });

  function makeDelay(time, fb) {
    const n = Math.round(time * SR);
    const bl = new Float32Array(n), br = new Float32Array(n);
    let w = 0, lpL = 0, lpR = 0, hpL = 0, hpR = 0;
    const cl = 1 - Math.exp(-TAU * 3000 / SR), ch = 1 - Math.exp(-TAU * 300 / SR);
    return function (inp, outL, outR, len) {
      for (let i = 0; i < len; i++) {
        const l = bl[w], r = br[w];
        lpL += (l - lpL) * cl; hpL += (lpL - hpL) * ch;
        lpR += (r - lpR) * cl; hpR += (lpR - hpR) * ch;
        const fl = lpL - hpL, fr = lpR - hpR;
        bl[w] = inp[i] + fr * fb;
        br[w] = fl;
        w++; if (w >= n) w = 0;
        outL[i] += fl; outR[i] += fr;
      }
    };
  }
  const delay = makeDelay(3 * STEP, 0.4);

  const duckTimes = S.kick.concat(S.kickM).filter((k) => k.vel > 0.3).map((k) => k.t).sort((a, b) => a - b);

  /* ---------- the render loop ---------- */
  const BLOCK = 1024;
  const outL = new Float32Array(N), outR = new Float32Array(N);
  const dL = new Float32Array(BLOCK), dR = new Float32Array(BLOCK);
  const uL = new Float32Array(BLOCK), uR = new Float32Array(BLOCK);
  const rv = new Float32Array(BLOCK), dy = new Float32Array(BLOCK);
  const wL = new Float32Array(BLOCK), wR = new Float32Array(BLOCK);
  const sL = new Float32Array(BLOCK), sR = new Float32Array(BLOCK);
  const ENV_RATE = 100;
  const frames = Math.ceil(DURATION * ENV_RATE);
  const frameLen = SR / ENV_RATE;
  const energy = new Float32Array(STEMS.length * frames);
  let active = [];
  let vi = 0, di = 0;
  const invFrame = 1 / frameLen;

  for (let pos = 0; pos < N; pos += BLOCK) {
    const len = Math.min(BLOCK, N - pos);
    dL.fill(0); dR.fill(0); uL.fill(0); uR.fill(0); rv.fill(0); dy.fill(0); wL.fill(0); wR.fill(0);
    while (vi < voices.length && voices[vi].start < pos + len) active.push(voices[vi++]);
    const still = [];
    for (const v of active) {
      const from = Math.max(pos, v.start), to = Math.min(pos + len, v.end);
      if (to > from) {
        const off = from - pos, n = to - from;
        v.process(sL, sR, off, n, from);
        const g = v.gain, rs = v.rev * 0.5, ds = v.dly * 0.5;
        const oL = v.bus ? uL : dL, oR = v.bus ? uR : dR;
        const eb = v.stem * frames;
        const end = off + n;
        for (let k = off; k < end; k++) { oL[k] += sL[k] * g; oR[k] += sR[k] * g; }
        if (rs) { const q = rs * g; for (let k = off; k < end; k++) rv[k] += (sL[k] + sR[k]) * q; }
        if (ds) { const q = ds * g; for (let k = off; k < end; k++) dy[k] += (sL[k] + sR[k]) * q; }
        const g2 = g * g * 4;
        for (let k = off + ((4 - ((pos + off) & 3)) & 3); k < end; k += 4) {
          energy[eb + (((pos + k) * invFrame) | 0)] += (sL[k] * sL[k] + sR[k] * sR[k]) * g2;
        }
      }
      if (v.end > pos + len) still.push(v);
    }
    active = still;
    for (let k = 0; k < len; k++) {
      const t = (pos + k) / SR;
      while (di + 1 < duckTimes.length && duckTimes[di + 1] <= t) di++;
      let g = 1;
      if (duckTimes.length && duckTimes[di] <= t) {
        const d = duckDepth(duckTimes[di]);
        if (d > 0) {
          const dt = t - duckTimes[di];
          const env = dt < 0.006 ? dt / 0.006 : Math.exp(-(dt - 0.006) / 0.12);
          g = 1 - d * env;
        }
      }
      dL[k] += uL[k] * g; dR[k] += uR[k] * g;
    }
    plate(rv, wL, wR, len);
    delay(dy, wL, wR, len);
    for (let k = 0; k < len; k++) {
      outL[pos + k] = dL[k] + wL[k] * 0.85;
      outR[pos + k] = dR[k] + wR[k] * 0.85;
    }
    if (((pos / BLOCK) & 63) === 0) yield 0.9 * pos / N;
  }

  if (opts.debug) {
    opts.debug.energy = energy.slice(); opts.debug.frames = frames; opts.debug.frameLen = frameLen;
    let pk = 0, at = 0;
    for (let i = 0; i < N; i++) { const a = Math.max(Math.abs(outL[i]), Math.abs(outR[i])); if (a > pk) { pk = a; at = i; } }
    opts.debug.prePeak = pk; opts.debug.prePeakAt = at / SR;
  }

  /* ---------- master: high-pass, air, glue compression, look-ahead limiter ---------- */
  (function master() {
    let pk = 1e-9;
    for (let i = 0; i < N; i++) pk = Math.max(pk, Math.abs(outL[i]), Math.abs(outR[i]));
    const ng = 0.9 / pk;
    for (let i = 0; i < N; i++) { outL[i] *= ng; outR[i] *= ng; }
    const w0 = TAU * 28 / SR, cs = Math.cos(w0), al = Math.sin(w0) / (2 * 0.707);
    const b0 = (1 + cs) / 2, b1 = -(1 + cs), b2 = (1 + cs) / 2, a0 = 1 + al, a1 = -2 * cs, a2 = 1 - al;
    for (const x of [outL, outR]) {
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < N; i++) {
        const y = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
        x2 = x1; x1 = x[i]; y2 = y1; y1 = y; x[i] = y;
      }
    }
    {
      const A = Math.pow(10, 2 / 40), w = TAU * 5500 / SR, c = Math.cos(w), al2 = Math.sin(w) / 2 * Math.SQRT2, sq = 2 * Math.sqrt(A) * al2;
      const b0 = A * ((A + 1) + (A - 1) * c + sq), b1 = -2 * A * ((A - 1) + (A + 1) * c), b2 = A * ((A + 1) + (A - 1) * c - sq);
      const a0 = (A + 1) - (A - 1) * c + sq, a1 = 2 * ((A - 1) - (A + 1) * c), a2 = (A + 1) - (A - 1) * c - sq;
      for (const x of [outL, outR]) {
        let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
        for (let i = 0; i < N; i++) {
          const y = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
          x2 = x1; x1 = x[i]; y2 = y1; y1 = y; x[i] = y;
        }
      }
    }
    const aA = Math.exp(-1 / (0.008 * SR)), aR = Math.exp(-1 / (0.16 * SR));
    const thr = -16, ratio = 2.2, makeup = Math.pow(10, 3 / 20);
    let env = 0, gPrev = makeup;
    const gainOf = (e) => {
      const over = 20 * Math.log10(e + 1e-9) - thr;
      return over > 0 ? Math.pow(10, -over * (1 - 1 / ratio) / 20) * makeup : makeup;
    };
    for (let i0 = 0; i0 < N; i0 += 16) {
      const i1 = Math.min(N, i0 + 16);
      for (let i = i0; i < i1; i++) {
        const x = Math.max(Math.abs(outL[i]), Math.abs(outR[i]));
        env = x > env ? x + (env - x) * aA : x + (env - x) * aR;
      }
      const gNext = gainOf(env);
      const step = (gNext - gPrev) / (i1 - i0);
      let g = gPrev;
      for (let i = i0; i < i1; i++) { g += step; outL[i] *= g; outR[i] *= g; }
      gPrev = gNext;
    }
  })();
  yield 0.94;
  (function limiter() {
    const ceil = 0.93;
    let peak = 0;
    for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(outL[i]), Math.abs(outR[i]));
    const pre = Math.min(4, (ceil / peak) * 1.35);
    const la = Math.round(0.004 * SR);
    const tgt = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const p = Math.max(Math.abs(outL[i]), Math.abs(outR[i])) * pre;
      tgt[i] = p > ceil ? ceil / p : 1;
    }
    const mn = new Float32Array(N);
    const dq = new Int32Array(N); let h = 0, tl = 0;
    for (let j = 0; j < N + la; j++) {
      if (j < N) { while (tl > h && tgt[dq[tl - 1]] >= tgt[j]) tl--; dq[tl++] = j; }
      const i = j - la;
      if (i >= 0) { while (dq[h] < i - la) h++; mn[i] = tgt[dq[h]]; }
    }
    const half = la >> 1, w = 2 * half + 1;
    let sum = 0;
    for (let j = 0; j < Math.min(N, half + 1); j++) sum += mn[j];
    sum += half * 1;
    const aRel = Math.exp(-1 / (0.08 * SR));
    let g = 1;
    for (let i = 0; i < N; i++) {
      const avg = sum / w;
      g = avg < g ? avg : avg + (g - avg) * aRel;
      outL[i] *= g * pre; outR[i] *= g * pre;
      const add = i + half + 1 < N ? mn[i + half + 1] : 1;
      const rem = i - half >= 0 ? mn[i - half] : 1;
      sum += add - rem;
    }
    const fin = Math.round(0.008 * SR), fout = Math.round(2.2 * SR);
    for (let i = 0; i < N; i++) {
      let e = 1;
      if (i < fin) e = i / fin;
      if (i > N - fout) { const x = (N - i) / fout; e = x * x; }
      let l = outL[i] * e, r = outR[i] * e;
      if (l > ceil) l = ceil; else if (l < -ceil) l = -ceil;
      if (r > ceil) r = ceil; else if (r < -ceil) r = -ceil;
      outL[i] = l; outR[i] = r;
    }
  })();
  yield 0.98;

  /* ---------- envelopes for the visuals ---------- */
  const env = new Float32Array(STEMS.length * frames);
  for (let s = 0; s < STEMS.length; s++) {
    let mx = 1e-9;
    for (let f = 0; f < frames; f++) {
      const v = Math.sqrt(energy[s * frames + f] / frameLen);
      env[s * frames + f] = v; if (v > mx) mx = v;
    }
    let sm = 0;
    for (let f = 0; f < frames; f++) {
      const v = env[s * frames + f] / mx;
      sm = v > sm ? v : sm * 0.86 + v * 0.14;
      env[s * frames + f] = sm;
    }
  }
  const master = new Float32Array(frames);
  {
    let mx = 1e-9;
    for (let f = 0; f < frames; f++) {
      let e = 0; const a = Math.floor(f * frameLen), b = Math.min(N, Math.floor((f + 1) * frameLen));
      for (let i = a; i < b; i++) e += outL[i] * outL[i] + outR[i] * outR[i];
      master[f] = Math.sqrt(e / Math.max(1, b - a)); if (master[f] > mx) mx = master[f];
    }
    for (let f = 0; f < frames; f++) master[f] /= mx;
  }

  const pick = (arr, f) => arr.map(f);
  const score = {
    kick: pick(S.kick, (e) => [e.t, e.vel]), kickM: pick(S.kickM, (e) => [e.t, e.vel]), clap: pick(S.clap, (e) => e.t),
    snare: pick(S.snare, (e) => [e.t, e.vel]), tick: pick(S.tick, (e) => [e.t, e.tock]), ant: pick(S.ant, (e) => [e.t, e.pan]),
    step: pick(S.step, (e) => e.t), timp: pick(S.timp, (e) => e.t), tom: pick(S.tom, (e) => e.t),
    crash: pick(S.crash, (e) => e.t), impact: pick(S.impact, (e) => e.t),
    harp: pick(S.harp, (e) => [e.t, e.note, e.dur, e.s]), lead: pick(S.lead, (e) => [e.t, e.note, e.dur]),
    canon: pick(S.canon, (e) => [e.t, e.note, e.dur]), bass: pick(S.bass, (e) => [e.t, e.note, e.dur]),
    bell: pick(S.bell, (e) => [e.t, e.note]), shep: pick(S.shep, (e) => [e.t, e.note]), risset: S.risset,
    chords: S.chords.map((c) => [c.t, c.dur, c.bass, c.tones, c.mode]), marks: S.marks,
  };
  yield 1;
  return { sampleRate: SR, L: outL, R: outR, env, master, envRate: ENV_RATE, frames, stems: STEMS, score };
}

function render(opts) {
  const g = renderGen(opts);
  let r;
  while (!(r = g.next()).done) { /* spin */ }
  return r.value;
}

return { EIGHTH, STEP, BEAT, BAR, BARS, PIECE, DURATION, STEMS, T, chordAt, buildScore, renderGen, render };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = SYNTH;
