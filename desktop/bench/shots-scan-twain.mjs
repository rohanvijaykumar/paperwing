/**
 * Screenshots of the scan dialog with the real scanner attached to this
 * computer (the TWAIN Working Group's sample driver on a test PC), for the
 * test report: Preview, a color mode, a paper size, a box drawn around the
 * sample's logo and what the scan of it brings, and the document feeder.
 *   SHOTS=<folder> PREFIX=<name> node bench/shots-scan-twain.mjs
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch } from './harness.mjs';
import * as L from './scan-bench-lib.mjs';

const { until, sleep, click, press, choose, dialog } = L;
const out = process.env.SHOTS;
const prefix = process.env.PREFIX ?? 'twain';
mkdirSync(out, { recursive: true });
delete process.env.PAPERWING_SCAN_TEST;
const app = await launch({});
const { page } = app;
await sleep(2500);
const shot = (name) => page.screenshot({ path: join(out, `${prefix}-${name}.png`) });

await click(page, '#create-btn');
await until(page, () => document.querySelector('.menu .menu-item'));
await click(page, '.menu .menu-item', 'From scanner');
await L.waitReady(page, 60000);
await choose(page, 'Source', 'Flatbed');
await sleep(500);
await shot('1-opened');
await press(page, 'Preview');
await L.waitIdle(page, 90000);
await sleep(800);
await shot('2-preview');
await choose(page, 'Color mode', 'Grayscale');
await sleep(1500);
await shot('3-grayscale');
await choose(page, 'Color mode', 'Black and white');
await sleep(1500);
await shot('3b-black-and-white');
await choose(page, 'Color mode', 'Color');
await choose(page, 'Paper size', 'Letter');
await sleep(1000);
await shot('4-letter');

/** Moves a corner handle to (x, y) inches on the glass, with the mouse */
async function dragCorner(corner, x, y) {
  const at = await page.evaluate(
    ({ corner, x, y }) => {
      const st = document.querySelector('.dlg-scan .sp-stage');
      const h = document.querySelector(`.dlg-scan .sp-${corner}`);
      if (!st || !h || h.hidden) return null;
      h.scrollIntoView({ block: 'nearest' });
      const r = st.getBoundingClientRect();
      const hr = h.getBoundingClientRect();
      // the glass's size: from the stage's aspect (8.5 in wide)
      const gw = 8.5;
      const gh = (r.height / r.width) * gw;
      return {
        from: { x: hr.x + hr.width / 2, y: hr.y + hr.height / 2 },
        to: { x: r.left + (x / gw) * r.width, y: r.top + (y / gh) * r.height },
        vis: window.innerHeight,
      };
    },
    { corner, x, y }
  );
  if (!at) return false;
  await page.mouse.move(at.from.x, at.from.y);
  await page.mouse.down();
  await page.mouse.move((at.from.x + at.to.x) / 2, (at.from.y + at.to.y) / 2, { steps: 5 });
  await page.mouse.move(at.to.x, Math.min(at.to.y, at.vis - 2), { steps: 5 });
  await page.mouse.up();
  return true;
}
// A box around the TWAIN logo (about 2.5-5.3 in across, 3-5.5 in down)
const box1 = await dragCorner('nw', 2.5, 3.0);
const box2 = await dragCorner('se', 5.3, 5.5);
console.log('dragged', box1, box2, (await dialog(page))?.box);
await sleep(500);
await shot('5-box-around-logo');
await choose(page, 'Resolution', '100 dpi');
await press(page, 'Scan');
await L.waitIdle(page, 120000);
await sleep(1500);
await shot('6-scanned');
const thumb = await page.evaluate(() => {
  const img = document.querySelector('.dlg-scan .sr-page img');
  return img ? { w: img.naturalWidth, h: img.naturalHeight } : null;
});
console.log('page thumbnail', JSON.stringify(thumb));
const d = await dialog(page);
console.log('buttons after the pass', JSON.stringify(d?.buttons));
await choose(page, 'Source', 'Document feeder');
await sleep(800);
await shot('7-feeder');
console.log('feeder buttons', JSON.stringify((await dialog(page))?.buttons));
await app.close();
