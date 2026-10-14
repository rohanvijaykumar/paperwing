/**
 * Builds a "scanned document" test PDF: every page is a unique 200 dpi JPEG
 * (text, rules and paper noise), the worst case for page rendering.
 *   node bench/make-scan-fixture.mjs <out.pdf> [pages]
 * Uses a local Chrome to encode the JPEGs (set CHROME_PATH if needed).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const require = createRequire(new URL('../../package.json', import.meta.url));
const { PDFDocument } = require('pdf-lib');

const [out, pagesArg] = process.argv.slice(2);
const PAGES = Number(pagesArg || 120);
const chrome =
  process.env.CHROME_PATH ||
  'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = mkdtempSync(
  join(process.env.BENCH_TMP || tmpdir(), 'pw-chrome-')
);

const browser = await puppeteer.launch({
  executablePath: chrome,
  userDataDir: profile,
});
const page = await browser.newPage();
const doc = await PDFDocument.create();

for (let p = 0; p < PAGES; p++) {
  const b64 = await page.evaluate((p) => {
    const W = 1700;
    const H = 2200;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#f4f1ea';
    g.fillRect(0, 0, W, H);
    let seed = p * 7919 + 1;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    g.fillStyle = '#222';
    g.font = 'bold 54px Georgia';
    g.fillText(`Scanned record ${p + 1}`, 140, 220);
    g.font = '30px Georgia';
    for (let line = 0; line < 52; line++) {
      const words = Array.from({ length: 11 }, () =>
        Math.random()
          .toString(36)
          .slice(2, 2 + 3 + Math.floor(rand() * 6))
      ).join(' ');
      g.fillText(words, 140 + rand() * 6, 320 + line * 36);
    }
    g.strokeStyle = '#555';
    for (let k = 0; k < 6; k++) {
      g.beginPath();
      g.moveTo(140, 300 + k * 330);
      g.lineTo(W - 140, 300 + k * 330 + rand() * 4);
      g.stroke();
    }
    // Paper grain and speckles
    const img = g.getImageData(0, 0, W, H);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (rand() - 0.5) * 26;
      img.data[i] += n;
      img.data[i + 1] += n;
      img.data[i + 2] += n;
    }
    g.putImageData(img, 0, 0);
    return c.toDataURL('image/jpeg', 0.72).split(',')[1];
  }, p);
  const jpg = await doc.embedJpg(Buffer.from(b64, 'base64'));
  doc
    .addPage([612, 792])
    .drawImage(jpg, { x: 0, y: 0, width: 612, height: 792 });
}
await browser.close();
rmSync(profile, { recursive: true, force: true });
writeFileSync(out, await doc.save());
console.log(`wrote ${out} (${PAGES} scanned pages)`);
