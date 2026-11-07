/**
 * A network scanner (eSCL / AirScan), end to end in the real app: no
 * stand-in scanner, the app's real network-scanner code (escl.cjs) against
 * a pretend one on this computer (tests/fake-escl.mjs), with real clicks:
 * Add by IP address, what it can do, Preview, a flatbed page, both sides
 * from its feeder, and the new document.
 *   node bench/check-scan-network.mjs
 */
import { startFakeEscl } from '../tests/fake-escl.mjs';
import { launch } from './harness.mjs';
import * as L from './scan-bench-lib.mjs';

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
check(!!(await page.$('.dlg-scan')), 'the scan dialog opens without the stand-in scanners');

await click(page, '.dlg-scan .sd-link', 'Add by IP address');
await until(page, () => document.querySelector('[aria-label="Add a network scanner"]'));
await page.type('[aria-label="IP address or host name"]', `127.0.0.1:${scanner.port}`);
await click(page, '[aria-label="Add a network scanner"] .accent-btn', 'Add');
const added = await until(page, () => !document.querySelector('[aria-label="Add a network scanner"]'), undefined, 20000);
check(!!added, 'Add by IP address: the pretend scanner answers');
await L.waitReady(page, 30000);
let d = await dialog(page);
check(
  / \(network\)$/.test(d?.scanner ?? '') && d.scanners.length === 2,
  'it is added and chosen (and no stand-in scanners)',
  JSON.stringify(d?.scanners)
);
check(JSON.stringify(d?.sources) === JSON.stringify(['Flatbed', 'Document feeder']), 'its flatbed and feeder, as it says', JSON.stringify(d?.sources));
await click(page, '.dlg-scan .sd-link', 'Options…');
await until(page, () => document.querySelector('[aria-label="Scanner options"]'));
const opts = await page.evaluate(() =>
  [...document.querySelectorAll('[aria-label="Scanner options"] [aria-label]')]
    .filter((x) => !x.closest('[hidden]'))
    .map((x) => x.getAttribute('aria-label'))
);
check(opts.includes('Seconds to wait'), 'Options: how long to wait for it', JSON.stringify(opts));
await click(page, '[aria-label="Scanner options"] .quiet-btn', 'Cancel');

check((await L.shows(page, ['Sharpness'])).Sharpness, 'its own sharpening: Image ▸ Sharpness');
await choose(page, 'Source', 'Flatbed');
await press(page, 'Preview');
await L.waitIdle(page, 120000);
d = await dialog(page);
check(!!d?.box, 'Preview through the network: the glass, with a box', d?.status);
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
check(d?.thumbs === 5, 'both sides of 2 sheets from its feeder: 5 pages in all', d?.status);
await press(page, 'Scan is complete');
await until(page, () => !document.querySelector('.dlg-scan'), undefined, 60000);
const doc = await until(
  page,
  () => window.__acro.viewer.pageInfo(window.__acro.viewer.current)?.total === 5,
  undefined,
  30000
);
const info = await L.docInfo(page);
check(!!doc && /^Scan /.test(info.name ?? ''), 'a new document with the 5 pages', JSON.stringify(info));

await app.close();
await scanner.close();
L.finish();
