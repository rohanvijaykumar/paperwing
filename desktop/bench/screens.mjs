/**
 * Screenshots of the main screens for visual review:
 *   node bench/screens.mjs <out-dir> <a.pdf> [b.pdf ...]
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, sleep } from './harness.mjs';

const [outDir, ...files] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const app = await launch();
const { page } = app;
const shot = (name) => page.screenshot({ path: join(outDir, `${name}.png`) });
const click = (sel) =>
  page.evaluate((s) => document.querySelector(s)?.click(), sel);

for (const f of files) {
  await app.openFile(f);
  await sleep(2500);
}
await sleep(2500); // previews are captured shortly after opening

await click('#home-btn');
await sleep(800);
await shot('home-list');
await click('[data-layout="grid"]');
await sleep(800);
await shot('home-grid');

await page.evaluate(() => document.querySelector('#tabs .tab')?.click());
await sleep(1200);
await click('#right-rail [data-panel="sidebar-panel:thumbnails"]');
await sleep(1200);
await shot('doc-panel-open');
await click('#right-rail .rr-collapse');
await sleep(800);
await shot('doc-panel-closed');
await click('#right-rail .rr-zoom');
await sleep(500);
await shot('doc-zoom-menu');
await page.keyboard.type('80');
await page.keyboard.press('Enter');
await sleep(1000);
await shot('doc-zoom-80');
await click('#help-btn');
await sleep(400);
await page.evaluate(() =>
  [...document.querySelectorAll('.menu-item')]
    .find((b) => /About/.test(b.textContent))
    ?.click()
);
await sleep(600);
await shot('about');
await page.keyboard.press('Escape');
await click('#home-btn');
await sleep(500);
await click('#clear-recent');
await sleep(500);
await shot('clear-recent-confirm');
await app.close();
console.log('screens in', outDir);
