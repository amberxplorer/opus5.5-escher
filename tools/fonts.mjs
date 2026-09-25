// Serve Google Fonts from a local copy (fonts.css + map.txt of "n url" → f<n>.woff2), or block them.
import fs from 'node:fs';
import path from 'node:path';
export async function routeFonts(page, fontDir) {
  if (fontDir && fs.existsSync(path.join(fontDir, 'map.txt'))) {
    const map = Object.fromEntries(fs.readFileSync(path.join(fontDir, 'map.txt'), 'utf8').trim().split('\n').map((l) => { const [i, u] = l.split(' '); return [u, `f${i}.woff2`]; }));
    const css = fs.readFileSync(path.join(fontDir, 'fonts.css'), 'utf8');
    await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: css, headers: { 'access-control-allow-origin': '*' } }));
    await page.route('https://fonts.gstatic.com/**', (r) => {
      const f = map[r.request().url()];
      return f ? r.fulfill({ status: 200, contentType: 'font/woff2', body: fs.readFileSync(path.join(fontDir, f)), headers: { 'access-control-allow-origin': '*' } }) : r.abort();
    });
  } else await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
}
