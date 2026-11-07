/**
 * Scanning with a real scanner attached to this computer (no stand-in):
 * whatever scanner is found first. Skips when there is none. Run it by hand
 * on a machine with a scanner (or the TWAIN Working Group's sample driver):
 *   node bench/check-scan-real.mjs
 */
import { launch } from './harness.mjs';
import * as L from './scan-bench-lib.mjs';
const { until, sleep, click, press, waitReady, waitIdle, dialog, docInfo, check, finish } = L;
delete process.env.PAPERWING_SCAN_TEST;
const app = await launch({});
const { page } = app;
await sleep(2500);
await click(page, '#create-btn');
await until(page, () => document.querySelector('.menu .menu-item'));
await click(page, '.menu .menu-item', 'From scanner');
await waitReady(page, 30000);
let d = await dialog(page);
const real = (d?.scanners ?? []).filter((s) => !s.startsWith('Import from'));
if (!real.length) {
  console.log('skipped: no scanner attached');
  await app.close();
  process.exit(0);
}
check(true, 'a real scanner is listed', real[0]);
await press(page, 'Preview');
await waitIdle(page, 60000);
const glass = await page.evaluate(() => { const c = document.querySelector('.dlg-scan .sp-stage img'); return c ? `${c.tagName} ${c.width || c.naturalWidth}x${c.height || c.naturalHeight}` : null; });
check(!!glass, 'Preview shows the glass', glass);
await press(page, 'Scan');
await waitIdle(page, 60000);
d = await dialog(page);
check(d?.thumbs >= 1, 'Scan brings a page from the scanner', `${d?.thumbs} pages; status ${d?.status}`);
const done = (d?.buttons ?? []).find((b) => /complete|Done/i.test(b));
await press(page, done ?? 'Done');
await until(page, () => !document.querySelector('.dlg-scan'), undefined, 60000);
await sleep(2000);
const info = await docInfo(page);
check(info.pages >= 1 && /^Scan /.test(info.name ?? ''), 'a new document with the scanned page', JSON.stringify(info));
await app.close();
finish();
