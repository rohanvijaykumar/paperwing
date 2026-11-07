/**
 * Scanning with a real scanner attached to this computer (no stand-in):
 * whatever scanner is found first. Skips when there is none. Run it by hand
 * on a machine with a scanner, or with the TWAIN Working Group's sample
 * driver (its "glass" is a fixed picture, so what comes out can be checked
 * against the preview):
 *   node bench/check-scan-real.mjs
 * (PAPERWING_TWAIN_SAMPLE=1: no scanner found is a failure, not a skip)
 * Checked on what it makes: the preview covers the glass; a box drawn on
 * it comes out as that part of the preview (also from a driver that
 * ignores where an area starts, as the sample does); color modes; pixel
 * counts at each resolution; paper sizes; the feeder; Scan more pages.
 */
import { launch } from './harness.mjs';
import * as L from './scan-bench-lib.mjs';
import * as P from './scan-pdf-check.mjs';

const { until, sleep, click, press, choose, dialog, check, finish } = L;
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const fmt = (o) => JSON.stringify(o, (k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v));
delete process.env.PAPERWING_SCAN_TEST;
const app = await launch({});
const { page } = app;
await sleep(2500);

async function open() {
  await until(page, () => !document.querySelector('.dlg-backdrop'), undefined, 10000);
  await click(page, '#create-btn');
  await until(page, () => document.querySelector('.menu .menu-item'));
  await click(page, '.menu .menu-item', 'From scanner');
  return L.waitReady(page, 60000);
}
const pass = async (button = 'Scan') => {
  await press(page, button);
  await sleep(300);
  return L.waitIdle(page, 180000);
};
const deskewOff = async () => {
  await L.openGroup(page, 'Clean-up');
  await L.tick(page, 'Deskew (straighten crooked pages)', false);
};

await open();
let d = await dialog(page);
const real = (d?.scanners ?? []).filter((s) => !s.startsWith('Import from'));
if (!real.length) {
  // (on CI, where the TWAIN sample was installed, not finding it fails)
  if (process.env.PAPERWING_TWAIN_SAMPLE) check(false, 'the TWAIN sample scanner is listed', d?.status);
  else console.log('skipped: no scanner attached');
  await app.close();
  finish();
}
check(true, 'a real scanner is listed', real.join(', '));
const sources = d.sources ?? ['Flatbed'];
if (sources.includes('Flatbed')) await choose(page, 'Source', 'Flatbed');
await choose(page, 'Color mode', 'Color');
await deskewOff();

/* Preview, and a box drawn on it ------------------------------------------- */
await click(page, '.dlg-scan .sd-tabs .pd-seg-btn', 'Preview');
await press(page, 'Preview');
await L.waitIdle(page, 120000);
await L.lookShows(page, { color: 'color' });
const glass = await page.evaluate(() => {
  const [w, h] = (document.querySelector('.dlg-scan .sp-stage')?.dataset.glass ?? '').split('x').map(Number);
  return w && h ? { width: w, height: h } : null;
});
const preview = await L.previewPixels(page, glass);
check(
  !!preview && near(preview.width / preview.dpi, glass.width, 0.1) && near(preview.height / preview.dpi, glass.height, 0.15),
  'Preview shows the whole glass',
  `${preview?.width}×${preview?.height} px at ${preview?.dpi?.toFixed(0)} dpi for a ${fmt(glass)} in glass`
);
const fit = await page.evaluate(() => {
  const st = document.querySelector('.dlg-scan .sp-stage').getBoundingClientRect();
  const pane = document.querySelector('.dlg-scan .sp-glass').getBoundingClientRect();
  return st.bottom <= pane.bottom + 1 && st.right <= pane.right + 1 && st.top >= pane.top - 1;
});
check(fit, 'all of the glass fits in the preview pane');
// A box in the middle of the glass (on the sample: around its logo)
const want = { x: glass.width * 0.3, y: glass.height * 0.22, w: glass.width * 0.33, h: glass.height * 0.18 };
await L.dragCorner(page, 'nw', want.x, want.y, glass);
await L.dragCorner(page, 'se', want.x + want.w, want.y + want.h, glass);
const box = await L.boxNow(page, glass);
await choose(page, 'Resolution', (d.dpi ?? []).includes('100 dpi') ? '100 dpi' : d.dpi[0]);
await pass();
let bytes = await L.complete(page, 1, 120000);
let [facts] = await P.pdfFacts(bytes);
check(near(facts.width, box.width * 72, 3) && near(facts.height, box.height * 72, 3), 'the page is the size of the box drawn', `${facts.width}×${facts.height} pt for ${fmt(box)}`);
const img = await P.renderPage(bytes, 0, 50);
const pw = Math.round(box.width * 20);
const ph = Math.round(box.height * 20);
const like = P.likeness(
  P.resize(img, pw, ph),
  P.resize(P.crop(preview, box.x * preview.dpi, box.y * preview.dpi, box.width * preview.dpi, box.height * preview.dpi), pw, ph)
);
// (and not the glass's top-left corner, which a driver ignoring the
// area's start sends)
const corner = P.likeness(
  P.resize(img, pw, ph),
  P.resize(P.crop(preview, 0, 0, box.width * preview.dpi, box.height * preview.dpi), pw, ph)
);
check(like > 0.85 && like > corner + 0.2, 'the scan is what the preview showed in the box', `likeness ${like.toFixed(3)} (the glass corner: ${corner.toFixed(3)})`);

/* Color modes, resolutions, paper sizes -------------------------------------- */
await open();
if (sources.includes('Flatbed')) await choose(page, 'Source', 'Flatbed');
await deskewOff();
const papers = (await dialog(page)).papers;
await choose(page, 'Paper size', papers.includes('Letter') ? 'Letter' : papers.find((p) => p !== 'Auto-detect'));
await choose(page, 'Resolution', (await dialog(page)).dpi.includes('100 dpi') ? '100 dpi' : (await dialog(page)).dpi[0]);
const modes = (await dialog(page)).colors;
for (const [k, mode] of modes.entries()) {
  await choose(page, 'Color mode', mode);
  await pass(k ? 'Scan more pages' : 'Scan');
}
bytes = await L.complete(page, modes.length, 180000);
const mf = await P.pdfFacts(bytes);
const kinds = mf.map((f) => f.images[0]);
const byMode = Object.fromEntries(modes.map((m, k) => [m, kinds[k]]));
check(!byMode.Color || byMode.Color.colorSpace === 'DeviceRGB', 'Color: an RGB image', fmt(byMode.Color));
check(!byMode.Grayscale || (byMode.Grayscale.colorSpace === 'DeviceGray' && byMode.Grayscale.bpc === 8), 'Grayscale: an 8-bit gray image', fmt(byMode.Grayscale));
check(
  !byMode['Black and white'] || (byMode['Black and white'].bpc === 1 && byMode['Black and white'].filter === 'CCITTFaxDecode'),
  'Black and white: 1-bit CCITT G4',
  fmt(byMode['Black and white'])
);
check(!byMode.Autodetect || !!byMode.Autodetect.colorSpace, 'Autodetect: decided per page', fmt(byMode.Autodetect));
check(mf.every((f) => f.width === 612 && f.height === 792), 'every page Letter size (612 × 792 pt)', mf.map((f) => `${f.width}×${f.height}`).join());

await open();
if (sources.includes('Flatbed')) await choose(page, 'Source', 'Flatbed');
await deskewOff();
await choose(page, 'Color mode', 'Grayscale');
await choose(page, 'Paper size', 'Letter');
const offered = (await dialog(page)).dpi.filter((x) => /^\d+ dpi$/.test(x)).map((x) => parseInt(x, 10));
const dpis = [50, 100, 200, 75, 150, 300].filter((x) => offered.includes(x)).slice(0, 3);
for (const [k, dpi] of dpis.entries()) {
  await choose(page, 'Resolution', `${dpi} dpi`);
  await pass(k ? 'Scan more pages' : 'Scan');
}
const rf = await P.pdfFacts(await L.complete(page, dpis.length, 180000));
const dims = rf.map((f) => `${f.images[0].width}×${f.images[0].height}`);
check(dims.join() === dpis.map((x) => `${Math.round(8.5 * x)}×${Math.round(11 * x)}`).join(), `resolution: 8.5 × 11 in × ${dpis.join(', ')} dpi pixels`, dims.join());

await open();
if (sources.includes('Flatbed')) await choose(page, 'Source', 'Flatbed');
await deskewOff();
await choose(page, 'Color mode', 'Grayscale');
await choose(page, 'Resolution', `${dpis[0]} dpi`);
const sizes = [
  ['Letter', 612, 792],
  ['Legal', 612, 1008],
  ['A4', 595.4, 841.7],
].filter(([p]) => (d.papers ?? papers).includes(p) || papers.includes(p));
for (const [k, [p]] of sizes.entries()) {
  await choose(page, 'Paper size', p);
  await pass(k ? 'Scan more pages' : 'Scan');
}
const sf = await P.pdfFacts(await L.complete(page, sizes.length, 180000));
check(
  sf.every((f, k) => near(f.width, sizes[k][1], 2) && near(f.height, sizes[k][2], 2)),
  `paper sizes: ${sizes.map((s) => s[0]).join(', ')}`,
  sf.map((f) => `${f.width}×${f.height}`).join()
);

/* The feeder, and Scan more pages --------------------------------------------- */
if (sources.includes('Document feeder')) {
  await open();
  await choose(page, 'Source', 'Document feeder');
  await choose(page, 'Pages', 'Front sides');
  await choose(page, 'Color mode', 'Grayscale');
  await choose(page, 'Resolution', `${dpis[0]} dpi`);
  await pass();
  d = await dialog(page);
  const first = d.thumbs;
  check(first >= 1 && d.buttons.includes('Scan reverse sides') && d.buttons.includes('Scan more pages'), 'the feeder: pages come, then Scan reverse sides / Scan more pages', `${first} pages; ${fmt(d.buttons)}; ${d.status}`);
  await pass('Scan more pages');
  d = await dialog(page);
  check(d.thumbs > first, 'Scan more pages adds more', `${first} -> ${d.thumbs}`);
  const n = (await dialog(page)).thumbs;
  const fb = await P.pdfFacts(await L.complete(page, n, 180000));
  check(fb.length === n && fb.every((f) => f.images[0]?.colorSpace === 'DeviceGray'), 'a new document with every page', `${fb.length} pages`);
}
await app.close();
finish();
