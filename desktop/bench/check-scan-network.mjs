/**
 * A network scanner (eSCL / AirScan), end to end in the real app: no
 * stand-in scanner, the app's real network-scanner code (escl.cjs) against
 * a pretend one on this computer (tests/fake-escl.mjs), with real clicks:
 * Add by IP address, what it can do, Preview, a flatbed page, both sides
 * from its feeder, and the new document. Then a feeder like HP's (#55),
 * whose JPEGs give their height at the end (a DNL marker): the pages show
 * at their size and the PDF is made from them, checked on its pixels.
 *   node bench/check-scan-network.mjs
 */
import { drawPage, startFakeEscl } from '../tests/fake-escl.mjs';
import { launch } from './harness.mjs';
import * as L from './scan-bench-lib.mjs';
import { likeness, pdfFacts, renderPage, resize } from './scan-pdf-check.mjs';

const { check, until, sleep, click, press, choose, dialog } = L;

const scanner = await startFakeEscl({
  name: 'Pretend Office Scanner',
  adf: { sheets: 2, duplex: true },
  sharpen: true,
});
// (the real thing: no stand-in scanners)
delete process.env.PAPERWING_SCAN_TEST;
const app = await launch({});
const { page } = app;
await sleep(2500);

await click(page, '#create-btn');
await until(page, () => document.querySelector('.menu .menu-item'));
await click(page, '.menu .menu-item', 'From scanner');
await until(
  page,
  () => {
    const s = document.querySelector('.dlg-scan .sd-status');
    return s && !/Looking for scanners/.test(s.textContent);
  },
  undefined,
  30000
);
check(
  !!(await page.$('.dlg-scan')),
  'the scan dialog opens without the stand-in scanners'
);

await click(page, '.dlg-scan .sd-link', 'Add by IP address');
await until(page, () =>
  document.querySelector('[aria-label="Add a network scanner"]')
);
await page.type(
  '[aria-label="IP address or host name"]',
  `127.0.0.1:${scanner.port}`
);
await click(page, '[aria-label="Add a network scanner"] .accent-btn', 'Add');
const added = await until(
  page,
  () => !document.querySelector('[aria-label="Add a network scanner"]'),
  undefined,
  20000
);
check(!!added, 'Add by IP address: the pretend scanner answers');
await L.waitReady(page, 30000);
let d = await dialog(page);
// (a computer with a real scanner, or the TWAIN sample, lists that too)
const standIns = [
  'Paperwing Test Scanner',
  'Paperwing Test Feeder',
  'Paperwing Network Scanner',
];
check(
  / \(network\)$/.test(d?.scanner ?? '') &&
    !d.scanners.some((s) => standIns.includes(s)),
  'it is added and chosen (and no stand-in scanners)',
  JSON.stringify(d?.scanners)
);
check(
  JSON.stringify(d?.sources) === JSON.stringify(['Flatbed', 'Document feeder']),
  'its flatbed and feeder, as it says',
  JSON.stringify(d?.sources)
);
await click(page, '.dlg-scan .sd-link', 'Options…');
await until(page, () =>
  document.querySelector('[aria-label="Scanner options"]')
);
const opts = await page.evaluate(() =>
  [...document.querySelectorAll('[aria-label="Scanner options"] [aria-label]')]
    .filter((x) => !x.closest('[hidden]'))
    .map((x) => x.getAttribute('aria-label'))
);
check(
  opts.includes('Seconds to wait'),
  'Options: how long to wait for it',
  JSON.stringify(opts)
);
await click(page, '[aria-label="Scanner options"] .quiet-btn', 'Cancel');

check(
  (await L.shows(page, ['Sharpness'])).Sharpness,
  'its own sharpening: Image ▸ Sharpness'
);
await choose(page, 'Source', 'Flatbed');
await press(page, 'Preview');
await L.waitIdle(page, 120000);
d = await dialog(page);
check(
  !!d?.box,
  'Preview through the network: the glass, with a box',
  d?.status
);
await choose(page, 'Paper size', 'Letter');
await choose(page, 'Color mode', 'Grayscale');
// (150 dpi: big pages through the network take a while on a busy machine)
await choose(page, 'Resolution', '150 dpi');
await press(page, 'Scan');
await L.waitIdle(page, 120000);
d = await dialog(page);
check(d?.thumbs === 1, 'a flatbed page', d?.status);
await choose(page, 'Source', 'Document feeder');
await choose(page, 'Pages', 'Both sides');
await press(page, 'Scan more pages');
await L.waitIdle(page, 240000);
d = await dialog(page);
check(
  d?.thumbs === 5,
  'both sides of 2 sheets from its feeder: 5 pages in all',
  d?.status
);
await press(page, 'Scan is complete');
await until(page, () => !document.querySelector('.dlg-scan'), undefined, 60000);
const doc = await until(
  page,
  () =>
    window.__acro.viewer.pageInfo(window.__acro.viewer.current)?.total === 5,
  undefined,
  30000
);
const info = await L.docInfo(page);
check(
  !!doc && /^Scan /.test(info.name ?? ''),
  'a new document with the 5 pages',
  JSON.stringify(info)
);

// A feeder like the HP Smart Tank 610's (#55): each JPEG says height 0 and
// gives its height in a DNL marker at its end
const hp = await startFakeEscl({
  name: 'Pretend Smart Tank',
  makeAndModel: 'Pretend Smart Tank 610 series',
  adf: { sheets: 2 },
  quirks: { heightAtEnd: true },
});
check(await L.openDialog(page), 'the scan dialog opens again');
await click(page, '.dlg-scan .sd-link', 'Add by IP address');
await until(page, () =>
  document.querySelector('[aria-label="Add a network scanner"]')
);
await page.type(
  '[aria-label="IP address or host name"]',
  `127.0.0.1:${hp.port}`
);
await click(page, '[aria-label="Add a network scanner"] .accent-btn', 'Add');
await until(
  page,
  () => !document.querySelector('[aria-label="Add a network scanner"]'),
  undefined,
  20000
);
await L.waitReady(page, 30000);
d = await dialog(page);
check(
  /Pretend Smart Tank/.test(d?.scanner ?? ''),
  'the HP-like scanner is added and chosen',
  d?.scanner
);
await choose(page, 'Source', 'Document feeder');
await choose(page, 'Color mode', 'Autodetect');
await choose(page, 'Resolution', '75 dpi');
await choose(page, 'Paper size', 'A4');
await press(page, 'Scan');
await L.waitIdle(page, 120000);
d = await dialog(page);
check(
  d?.thumbs === 2 && !/couldn.t be read/.test(d.status),
  'its feeder: 2 pages, all readable',
  `${d?.thumbs}: ${d?.status}`
);
// The thumbnails are pictures of the A4 pages, not a dot (#55)
const tiles = await page.evaluate(() =>
  [...document.querySelectorAll('.dlg-scan .sr-page')].map((p) => {
    const img = p.querySelector('img');
    return {
      unreadable: p.classList.contains('is-unreadable'),
      w: img?.naturalWidth ?? 0,
      h: img?.naturalHeight ?? 0,
      shown: img ? Math.round(img.getBoundingClientRect().height) : 0,
    };
  })
);
check(
  tiles.length === 2 &&
    tiles.every(
      (t) =>
        !t.unreadable &&
        t.w > 0 &&
        Math.abs(t.h / t.w - 877 / 620) < 0.02 &&
        t.shown > 100
    ),
  'the page thumbnails show at A4 proportions',
  JSON.stringify(tiles)
);
const hpPdf = await L.complete(page, 2);
const facts = await pdfFacts(hpPdf);
check(
  facts.length === 2 &&
    facts.every(
      (f) =>
        Math.abs(f.width - 595.2) < 1 &&
        Math.abs(f.height - 841.9) < 1 &&
        f.images.length === 1 &&
        f.images[0].width === 620 &&
        f.images[0].height === 877
    ),
  'the PDF: 2 A4 pages, each the 620 × 877 image the scanner sent',
  JSON.stringify(
    facts.map((f) => [
      f.width,
      f.height,
      f.images.map((i) => [i.width, i.height]),
    ])
  )
);
// Each page looks like the page the scanner drew (its number in blocks)
for (const n of facts.length === 2 ? [1, 2] : []) {
  const got = await renderPage(hpPdf, n - 1, 75);
  const want = drawPage(620, 877, { n, color: 'color' });
  const rgba = new Uint8ClampedArray(620 * 877 * 4);
  for (let i = 0; i < 620 * 877; i++) {
    rgba.set(want.data.subarray(i * 3, i * 3 + 3), i * 4);
    rgba[i * 4 + 3] = 255;
  }
  const a = resize(got, 155, 219);
  const b = resize({ width: 620, height: 877, data: rgba }, 155, 219);
  const like = likeness(a, b);
  check(
    like > 0.95,
    `page ${n} of the PDF is page ${n} as scanned`,
    like.toFixed(3)
  );
}

await app.close();
await scanner.close();
await hp.close();
L.finish();
