// Render frames of the piece headlessly (no audio playback) for visual checks.
// usage: node tools/shoot.mjs <outDir> <WxH[@dpr]> <t1,t2,...|sheet:t1,t2,...|idle:t1,...> [fontDir]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
import { routeFonts } from './fonts.mjs';
const { chromium } = pw;
const here = path.dirname(fileURLToPath(import.meta.url));
const [outDir, size = '1280x720', spec = '0', fontDir] = process.argv.slice(2);
const [wh, dprS] = size.split('@');
const [W, H] = wh.split('x').map(Number);
const dpr = parseFloat(dprS || '1');
const sheet = spec.startsWith('sheet:');
const idle = spec.startsWith('idle:');
const times = spec.replace(/^(sheet|idle):/, '').split(',').map(Number);
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: dpr });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.type(), m.text().slice(0, 3000)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await routeFonts(page, fontDir);
const t0 = Date.now();
await page.goto('file://' + path.join(here, '../index.html') + '?capture' + (process.env.Q ? '&' + process.env.Q : ''));
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
console.log('ready in', ((Date.now() - t0) / 1000).toFixed(1), 's');
if (sheet) {
  const cols = Number(process.env.COLS || 4);
  const url = await page.evaluate(({ times, cols }) => {
    const src = document.getElementById('screen');
    const tw = src.width >= src.height ? 480 : 270, th = Math.round(tw * src.height / src.width);
    const rows = Math.ceil(times.length / cols);
    const c = document.createElement('canvas'); c.width = cols * tw; c.height = rows * th;
    const g = c.getContext('2d'); g.fillStyle = '#c33'; g.fillRect(0, 0, c.width, c.height);
    times.forEach((t, i) => { window.__frame(t); g.drawImage(src, (i % cols) * tw + 1, Math.floor(i / cols) * th + 1, tw - 2, th - 2); });
    return c.toDataURL('image/png');
  }, { times, cols });
  fs.writeFileSync(path.join(outDir, 'sheet.png'), Buffer.from(url.split(',')[1], 'base64'));
  console.log('wrote sheet');
} else {
  for (const t of times) {
    const t1 = Date.now();
    if (idle) await page.evaluate((t) => window.__idle(t, t < 2 ? t / 2 : 1, t >= 2), t);
    else await page.evaluate((t) => window.__frame(t), t);
    const f = path.join(outDir, `${idle ? 'idle' : 'f'}_${t.toFixed(2)}.png`);
    await page.screenshot({ path: f });
    console.log('wrote', path.basename(f), Date.now() - t1, 'ms');
  }
}
await browser.close();
