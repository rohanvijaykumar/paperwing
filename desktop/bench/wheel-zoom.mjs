/**
 * Ctrl+mouse-wheel zoom: each notch should change the zoom by a small,
 * even step in both directions (it used to jump to the minimum on the first
 * notch out).
 *   node bench/wheel-zoom.mjs <a.pdf>
 */
import { launch, sleep } from './harness.mjs';

const app = await launch();
const { page } = app;
await sleep(2000);
await app.openFile(process.argv[2]);
await sleep(3000);

const zoom = () =>
  page.evaluate(() => {
    const v = window.__acro.viewer;
    const id = [...v.docIds.keys()][0];
    return Math.round(v.zoom(id) * 1000) / 10;
  });
const box = await page.evaluate(() => {
  const r = document.querySelector('#viewer-host').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
await page.mouse.move(box.x, box.y);

async function notches(n, deltaY) {
  await page.keyboard.down('Control');
  for (let i = 0; i < n; i++) {
    await page.mouse.wheel({ deltaY });
    await sleep(40);
  }
  await page.keyboard.up('Control');
  await sleep(600); // the zoom is committed shortly after the last notch
  return zoom();
}

const start = await zoom();
const out1 = await notches(1, 100);
const in1 = await notches(1, -100);
const out5 = await notches(5, 100);
const in5 = await notches(5, -100);
console.log(
  `start ${start}%  1 out -> ${out1}%  1 in -> ${in1}%  5 out -> ${out5}%  5 in -> ${in5}%`
);
const ok =
  out1 < start &&
  out1 > start * 0.75 && // a small step, not the minimum
  Math.abs(in1 - start) / start < 0.05 && // back where it started
  out5 > 20 &&
  Math.abs(in5 - in1) / in1 < 0.08;
console.log(ok ? 'PASS' : 'FAIL');
await app.close();
process.exit(ok ? 0 : 1);
