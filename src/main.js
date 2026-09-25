/* ─────────────────────────────────────────────────────────────────────────
   main.js — boot, sound, clock, input, loop.
   ───────────────────────────────────────────────────────────────────────── */
(function () {
'use strict';
const params = new URLSearchParams(location.search);
const CAPTURE = params.has('capture');
const DURATION = SYNTH.DURATION;
const START_AT = Math.max(0, Math.min(DURATION - 1, parseFloat(params.get('t') || '0') || 0));
const canvas = document.getElementById('screen');
// viewers who ask for less motion get the piece without flashes and shakes
const calm = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } };

let music = null, progress = 0, ready = false, pendingStart = false;
let actx = null, buffer = null, source = null;
let playing = false, paused = false, pausedAt = 0, startCtx = 0, offset = 0;
let hover = false, idleSince = 0, lastMove = 0, ended = false;
const boot = performance.now();
const wall = () => (performance.now() - boot) / 1000;

/* ───────── fonts ───────── */
async function loadFonts() {
  if (!document.fonts || !document.fonts.load) return;
  await Promise.race([
    Promise.allSettled([document.fonts.load('italic 500 40px "Cormorant Garamond"'), document.fonts.load('500 40px "Cormorant Garamond"')]),
    new Promise((r) => setTimeout(r, 2500)),
  ]);
}

/* ───────── the soundtrack ───────── */
function onMusic(out) {
  music = out;
  SCENES.setMusic(out);
  progress = 1;
  ready = true;
  if (CAPTURE) window.__ready = true;
  if (pendingStart) start(START_AT);
}
function synthOnMain(src, sampleRate) {
  window.__synthPath = 'main';
  const SY = new Function(src + '\nreturn SYNTH;')();
  const g = SY.renderGen({ sampleRate });
  const step = () => {
    const t0 = performance.now();
    for (;;) {
      const r = g.next();
      if (r.done) { onMusic(r.value); return; }
      progress = r.value;
      if (performance.now() - t0 > 24) break;
    }
    setTimeout(step, 0);
  };
  step();
}
function startSynth(sampleRate) {
  const src = document.getElementById('synth-src').textContent;
  const bootSrc = `
self.onmessage = function (e) {
  try {
    var g = SYNTH.renderGen(e.data), r, last = 0;
    while (!(r = g.next()).done) { var now = Date.now(); if (now - last > 50) { self.postMessage({ progress: r.value }); last = now; } }
    var o = r.value;
    self.postMessage({ done: true, out: o }, [o.L.buffer, o.R.buffer, o.env.buffer, o.master.buffer]);
  } catch (err) { self.postMessage({ error: String((err && err.stack) || err) }); }
};`;
  let worker = null, settled = false;
  const fallback = () => { if (settled) return; settled = true; try { worker && worker.terminate(); } catch (e) { /* */ } synthOnMain(src, sampleRate); };
  try {
    const url = URL.createObjectURL(new Blob([src, bootSrc], { type: 'text/javascript' }));
    worker = new Worker(url);
    window.__synthPath = 'worker';
  } catch (e) { fallback(); return; }
  worker.onmessage = (e) => {
    const d = e.data;
    if (d.progress !== undefined) progress = d.progress;
    else if (d.done) { settled = true; worker.terminate(); onMusic(d.out); }
    else if (d.error) { console.warn(d.error); fallback(); }
  };
  worker.onerror = (e) => { e.preventDefault && e.preventDefault(); fallback(); };
  worker.postMessage({ sampleRate });
}

/* ───────── playback & clock ───────── */
function ensureAudio() {
  if (actx) return actx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try { actx = new AC({ latencyHint: 'playback' }); } catch (e) { actx = new AC(); }
  return actx;
}
function stopSource() {
  if (!source) return;
  try { source.onended = null; source.stop(); } catch (e) { /* already stopped */ }
  try { source.disconnect(); } catch (e) { /* */ }
  source = null;
}
function playFrom(t) {
  stopSource();
  offset = Math.max(0, Math.min(DURATION - 0.05, t));
  source = actx.createBufferSource();
  source.buffer = buffer;
  source.connect(actx.destination);
  startCtx = actx.currentTime + 0.1;
  source.start(startCtx, offset);
  playing = true; paused = false; ended = false;
}
function musicTime() {
  if (!playing) return 0;
  if (paused) return pausedAt;
  let ct;
  if (actx.getOutputTimestamp) {
    const ts = actx.getOutputTimestamp();
    if (ts && ts.contextTime > 0 && ts.performanceTime > 0) ct = ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
  }
  if (ct === undefined) ct = actx.currentTime - (actx.outputLatency || 0) - (actx.baseLatency || 0);
  return Math.max(0, ct - startCtx) + offset;
}
async function start(at) {
  if (!ready) { pendingStart = true; return; }
  pendingStart = false;
  const ctx = ensureAudio();
  if (!ctx) return;
  try { await ctx.resume(); } catch (e) { /* */ }
  if (!buffer || buffer.sampleRate !== music.sampleRate) {
    buffer = ctx.createBuffer(2, music.L.length, music.sampleRate);
    buffer.copyToChannel(music.L, 0);
    buffer.copyToChannel(music.R, 1);
  }
  playFrom(at || 0);
  document.body.classList.remove('play');
  goFullscreen();
}
function togglePause() {
  if (!playing || !actx) return;
  if (!paused) { pausedAt = musicTime(); paused = true; actx.suspend(); }
  else { actx.resume().then(() => { playFrom(pausedAt); }); }
}
function goFullscreen() {
  const el = document.documentElement;
  const fn = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!fn || document.fullscreenElement || document.webkitFullscreenElement) return;
  try { const p = fn.call(el); if (p && p.catch) p.catch(() => {}); } catch (e) { /* not allowed here */ }
}
function toggleFullscreen() {
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    const x = document.exitFullscreen || document.webkitExitFullscreen;
    if (x) try { const p = x.call(document); if (p && p.catch) p.catch(() => {}); } catch (e) { /* */ }
  } else goFullscreen();
}

/* ───────── input ───────── */
function activate() {
  if (playing) return;
  if (!ready) { pendingStart = true; ensureAudio(); if (actx) actx.resume().catch(() => {}); return; }
  start(START_AT);
}
window.addEventListener('pointerup', (e) => { if (e.button === 0 || e.pointerType !== 'mouse') activate(); });
window.addEventListener('keydown', (e) => {
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (playing) togglePause(); else activate(); }
  else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
  else if (playing && e.key === 'ArrowRight') playFrom(musicTime() + 5);
  else if (playing && e.key === 'ArrowLeft') playFrom(musicTime() - 5);
  else if (playing && (e.key === 'r' || e.key === 'R')) playFrom(0);
});
window.addEventListener('pointermove', (e) => {
  lastMove = wall();
  document.body.classList.remove('hide');
  if (!playing) {
    const r = canvas.getBoundingClientRect();
    const b = SCENES.button();
    hover = !!b && Math.hypot(e.clientX - r.left - b[0], e.clientY - r.top - b[1]) < b[2] * 1.6;
  }
});
window.addEventListener('resize', () => { if (GFX.gl) GFX.layout(); });

/* ───────── loop ───────── */
function frame() {
  requestAnimationFrame(frame);
  const tw = wall();
  if (playing) {
    const T = musicTime();
    if (T >= DURATION) {
      playing = false; stopSource(); idleSince = tw; ended = true;
    } else {
      SCENES.frame(T, { calm: calm() });
      document.body.classList.toggle('hide', tw - lastMove > 1.5);
      return;
    }
  }
  document.body.classList.toggle('play', ready);
  SCENES.idle(tw - idleSince, { progress, ready, hover, ended, calm: calm() });
}

/* ───────── boot ───────── */
(async function main() {
  await loadFonts();
  try {
    GFX.init({ canvas, capture: CAPTURE });
    SCENES.init();
  } catch (err) {
    console.error(err);
    document.body.classList.add('nogl');
    return;
  }
  let rate = 44100;
  if (!CAPTURE) { const ctx = ensureAudio(); if (ctx) rate = Math.min(48000, ctx.sampleRate || 44100); }
  startSynth(rate);
  if (CAPTURE) {
    window.__frame = (T) => SCENES.frame(T, { calm: false });
    window.__idle = (tw, p, r) => SCENES.idle(tw, { progress: p, ready: r, hover: false, ended: false, calm: false });
    window.__layout = () => GFX.layout();
    return;
  }
  window.__state = () => ({ ready, playing, paused, T: playing ? musicTime() : 0, synth: window.__synthPath, W: GFX.W, H: GFX.H });
  requestAnimationFrame(frame);
})();
})();
