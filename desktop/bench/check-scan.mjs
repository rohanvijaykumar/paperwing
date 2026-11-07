/**
 * Create PDF from scanner (#35), in the real app with the stand-in scanners
 * (PAPERWING_SCAN_TEST, development builds only), with real clicks:
 *  - Create ▸ From scanner: one entry per scanner (the test scanner reached
 *    three ways is listed once), what it can do, Options ▸ Driver
 *  - flatbed: Preview, the box around the document, dragging a corner, the
 *    scan covering just the box; Scan more pages; Scan is complete: a new
 *    unsaved document named "Scan <date> <time>.pdf"
 *  - the feeder one-sided, then Scan reverse sides; the last choice offered
 *    first; the review strip: rotate, delete, drag, rescan; Cancel asks
 *    before discarding
 *  - both sides at once with a blank page left out (and kept); appended to
 *    the open document; Ctrl+Z
 *  - errors: a jam, two sheets fed together after two pages, Stop mid-scan
 *    (the scanner free again), no scanners, a blocked helper
 *   node bench/check-scan.mjs
 */
import { fileURLToPath } from 'node:url';
import * as L from './scan-bench-lib.mjs';

const { check, until, sleep, click, press, choose, dialog } = L;
const sample = fileURLToPath(
  new URL('../../docs/screenshots/samples/Invoice INV-2048.pdf', import.meta.url)
);

/* The dialog and the scanners ----------------------------------------- */
let app = await L.start();
let { page } = app;
check(await L.openDialog(page), 'Create ▸ From scanner opens the scan dialog');
let d = await dialog(page);
check(
  JSON.stringify(d?.scanners) ===
    JSON.stringify([
      'Paperwing Network Scanner',
      'Paperwing Test Feeder',
      'Paperwing Test Scanner',
      'Import from a scanner app…',
    ]),
  'one entry per scanner (the one reached by three drivers once), and Import from a scanner app',
  JSON.stringify(d?.scanners)
);
check(d?.scanner === 'Paperwing Test Feeder', 'a scanner on this computer is chosen first', d?.scanner);
await choose(page, 'Scanner', 'Paperwing Test Scanner');
await L.waitReady(page);
d = await dialog(page);
check(
  JSON.stringify(d?.sources) === JSON.stringify(['Flatbed', 'Document feeder']),
  'flatbed and document feeder',
  JSON.stringify(d?.sources)
);
check(
  JSON.stringify(d?.colors) === JSON.stringify(['Autodetect', 'Color', 'Grayscale', 'Black and white']),
  'color modes, Autodetect first',
  JSON.stringify(d?.colors)
);
check(
  d?.dpi?.includes('300 dpi') && d.dpi.includes('1200 dpi') && d.dpi.includes('75 dpi'),
  'its resolutions',
  JSON.stringify(d?.dpi)
);
check(d?.papers?.[0] === 'Auto-detect' && d.papers.includes('Whole glass') && d.papers.includes('Custom size') && !d.papers.includes('Legal'),
  'paper: auto-detect (it can), sizes that fit the glass, whole glass, custom',
  JSON.stringify(d?.papers));
check(d?.previewTab && d.buttons.includes('Preview'), 'a flatbed that can preview: Preview');
check(d && d.sides === null, 'no Pages (sides) for the flatbed');

// Options…: the drivers that reach it
await click(page, '.dlg-scan .sd-link', 'Options…');
await until(page, () => document.querySelector('[aria-label="Scanner options"]'));
let opts = await page.evaluate(() => {
  const o = document.querySelector('[aria-label="Scanner options"]');
  return {
    drivers: [...o.querySelectorAll('select[aria-label="Driver"] option')].map((x) => x.textContent),
    labels: [...o.querySelectorAll('[aria-label]')].map((x) => x.getAttribute('aria-label')),
  };
});
const win = process.platform === 'win32';
check(
  JSON.stringify(opts.drivers) ===
    JSON.stringify(
      win
        ? ['Automatic (TWAIN)', 'TWAIN', 'WIA', 'Network (eSCL)']
        : ['Automatic (Network (eSCL))', 'Network (eSCL)', 'Image Capture']
    ),
  'Options ▸ Driver: automatic (the best) and each driver',
  JSON.stringify(opts.drivers)
);
if (win)
  check(
    opts.labels.includes('Show the scanner’s own window') && opts.labels.includes('Transfer method'),
    "TWAIN: the scanner's own window and the transfer method",
    JSON.stringify(opts.labels)
  );
await choose(page, 'Driver', 'Network (eSCL)', '[aria-label="Scanner options"]');
await click(page, '[aria-label="Scanner options"] .accent-btn', 'OK');
await L.waitReady(page);
await click(page, '.dlg-scan .sd-link', 'Options…');
await until(page, () => document.querySelector('[aria-label="Scanner options"]'));
opts = await page.evaluate(() =>
  [...document.querySelectorAll('[aria-label="Scanner options"] [aria-label]')]
    .filter((x) => !x.closest('[hidden]'))
    .map((x) => x.getAttribute('aria-label'))
);
check(
  opts.includes('Seconds to wait') && !opts.includes('Transfer method'),
  'through the network: how long to wait, no TWAIN settings',
  JSON.stringify(opts)
);
await choose(page, 'Driver', win ? 'Automatic (TWAIN)' : 'Automatic (Network (eSCL))', '[aria-label="Scanner options"]');
await click(page, '[aria-label="Scanner options"] .accent-btn', 'OK');
await L.waitReady(page);

/* Flatbed: preview, the box, scan, more, complete --------------------- */
await choose(page, 'Source', 'Flatbed');
await choose(page, 'Color mode', 'Color');
await press(page, 'Preview');
await L.waitIdle(page);
d = await dialog(page);
check(!!d?.box, 'Preview: the glass, with a box around the document', d?.status);
check(d?.paper === 'Custom (from preview)', 'and the paper size follows it', d?.paper);
// The box sits where the stand-in's document lies: 1 in from the left of 8.5
const left = Number(/left: ([\d.]+)%/.exec(d?.box ?? '')?.[1]);
check(left > 8 && left < 16, 'the box found the document', d?.box);
// Drag the bottom-right corner up and left, with the mouse
const se = await page.evaluate(() => {
  const r = document.querySelector('.dlg-scan .sp-se').getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.move(se.x, se.y);
await page.mouse.down();
await page.mouse.move(se.x - 30, se.y - 40, { steps: 6 });
await page.mouse.up();
const dragged = (await dialog(page))?.box;
check(dragged && dragged !== d.box, 'dragging a corner changes the box', dragged);
await press(page, 'Scan');
await L.waitIdle(page);
d = await dialog(page);
check(d?.thumbs === 1, 'a flatbed pass scans one page', `${d?.thumbs}`);
check(
  d?.buttons.includes('Scan more pages') && d.buttons.includes('Scan is complete') && !d.buttons.includes('Scan reverse sides'),
  'then: Scan more pages or Scan is complete (no reverse sides for a flatbed)',
  JSON.stringify(d?.buttons)
);
check(d?.first === 'Scan more pages', 'the first time, Scan more pages is offered first (not "complete")', d?.first);
await press(page, 'Scan more pages');
await L.waitIdle(page);
check((await dialog(page))?.thumbs === 2, 'Scan more pages adds one');
await press(page, 'Scan is complete');
await until(page, () => !document.querySelector('.dlg-scan'), undefined, 30000);
let doc = await until(page, () =>
  /^Scan \d{4}-\d\d-\d\d \d\d\.\d\d\.pdf$/.test(document.querySelector('#tabs .tab.is-active')?.textContent.trim() ?? '')
);
await sleep(1500);
let info = await L.docInfo(page);
check(!!doc && info.pages === 2, 'Scan is complete: a new document "Scan <date> <time>.pdf" with both pages', JSON.stringify(info));
check(info.dirty, "it isn't saved yet (closing asks)");
// The box was about 5.9 × 7.8 in after the drag: the page is that size
check(
  info.size && info.size.width > 360 && info.size.width < 470 && info.size.height > 470 && info.size.height < 600,
  'its pages are the size of the box, not the whole glass',
  JSON.stringify(info.size)
);
check(/Scanned 2 pages into Scan .*\.pdf/.test(await L.toasts(page)), 'and the notice offers to save it');

/* A one-sided feeder stack, then the reverse sides; the review strip -- */
check(await L.openDialog(page), 'the dialog opens again');
d = await dialog(page);
check(d?.scanner === 'Paperwing Test Scanner', 'with the scanner used last', d?.scanner);
await choose(page, 'Source', 'Document feeder');
d = await dialog(page);
check(d?.sides?.join() === 'Front sides,Both sides', 'Pages: front sides or both, for the feeder', JSON.stringify(d?.sides));
check(!d?.previewTab, 'no preview for a feeder');
await choose(page, 'Pages', 'Front sides');
await press(page, 'Scan');
await L.waitIdle(page);
d = await dialog(page);
check(d?.thumbs === 3, 'the feeder scans the whole stack (3 sheets)', `${d?.thumbs}`);
check(d?.buttons.includes('Scan reverse sides'), 'and offers Scan reverse sides', JSON.stringify(d?.buttons));
check(d?.first === 'Scan is complete', 'the last choice made (Scan is complete) is offered first', d?.first);
await press(page, 'Scan reverse sides');
await L.waitIdle(page);
d = await dialog(page);
check(d?.thumbs === 6, 'the backs are woven in: 6 pages', `${d?.thumbs}`);
check(!d?.buttons.includes('Scan reverse sides'), 'reverse sides only once per stack');

const ids = () => page.evaluate(() => [...document.querySelectorAll('.dlg-scan .sr-page')].map((p) => p.dataset.id));
const before = await ids();
await page.hover('.dlg-scan .sr-page');
await click(page, '.dlg-scan .sr-tool', 'Rotate page 1 clockwise');
check((await dialog(page))?.pages[0] === 'Page 1, turned 90°', 'rotate a page', (await dialog(page))?.pages[0]);
await page.hover('.dlg-scan .sr-page:nth-child(2)');
await click(page, '.dlg-scan .sr-tool', 'Delete page 2');
let now = await ids();
check(now.length === 5 && !now.includes(before[1]), 'delete a page', JSON.stringify(now));
// Drag page 1 after page 3, with the mouse
const pos = await page.evaluate(() =>
  [...document.querySelectorAll('.dlg-scan .sr-page')].map((p) => {
    const r = p.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, right: r.right };
  })
);
await page.mouse.move(pos[0].x, pos[0].y);
await page.mouse.down();
await page.mouse.move(pos[2].x + 30, pos[2].y, { steps: 10 });
await page.mouse.up();
const moved = await ids();
check(moved[2] === now[0] && moved[0] === now[1], 'drag a page to another place', `${JSON.stringify(now)} -> ${JSON.stringify(moved)}`);
// Ctrl+Left moves it back one
await page.focus(`.dlg-scan .sr-page[data-id="${now[0]}"]`);
await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
await page.keyboard.press('ArrowLeft');
await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
check((await ids())[1] === now[0], 'Ctrl+arrow keys move a page too');
const beforeRescan = await ids();
await page.hover('.dlg-scan .sr-page');
await click(page, '.dlg-scan .sr-tool', 'Rescan page 1');
await L.waitIdle(page);
const rescanned = await ids();
check(
  rescanned.length === 5 &&
    rescanned[0] !== beforeRescan[0] &&
    rescanned.slice(1).join() === beforeRescan.slice(1).join(),
  'rescan replaces just that page',
  `${JSON.stringify(beforeRescan)} -> ${JSON.stringify(rescanned)}`
);

// Pages aren't thrown away on one click
await press(page, 'Cancel');
d = await dialog(page);
check(!!d && d.buttons.includes('Discard 5 pages'), 'Cancel asks again before discarding scanned pages', JSON.stringify(d?.buttons));
await press(page, 'Discard 5 pages');
check(!!(await until(page, () => !document.querySelector('.dlg-scan'))), 'and discards them on the second click');

/* Both sides at once, a blank page, added to the open document -------- */
await app.openFile(sample);
await until(page, () => window.__acro.viewer.pageInfo(window.__acro.viewer.current)?.total > 0);
await sleep(1000);
const pagesBefore = await L.pageCount(page);
check(await L.openDialog(page), 'with a document open');
await choose(page, 'Source', 'Document feeder');
await choose(page, 'Pages', 'Both sides');
await L.openGroup(page, 'Clean-up');
await L.tick(page, 'Remove blank pages', true);
check((await L.shows(page, ['Blank page sensitivity']))['Blank page sensitivity'], 'Remove blank pages shows its sensitivity');
await click(page, '.dlg-scan .pd-radio', 'Append to file');
const target = await page.evaluate(() => {
  const s = document.querySelector('.dlg-scan select[aria-label="File to append to"]');
  return s.options[s.selectedIndex]?.textContent;
});
check(/^Invoice/.test(target ?? ''), 'Append to file offers the open document first', target);
await press(page, 'Scan');
await L.waitIdle(page);
d = await dialog(page);
check(d?.thumbs === 6 && d.leftOut === 1, 'both sides at once: 6 pages, the blank one left out', `${d?.thumbs} / ${d?.leftOut}`);
check(/1 blank left out/.test(d?.status ?? ''), 'and it says so', d?.status);
await click(page, '.dlg-scan .sr-keep');
check((await dialog(page))?.leftOut === 0, 'Keep keeps the blank page');
await page.hover('.dlg-scan .sr-page:nth-child(4)');
await click(page, '.dlg-scan .sr-tool', 'Delete page 4');
await press(page, 'Scan is complete');
const after = await until(
  page,
  (n) => window.__acro.viewer.pageInfo(window.__acro.viewer.current)?.total === n,
  pagesBefore + 5,
  30000
);
check(!!after, 'Append: they go at the end of the open document', `${pagesBefore} -> ${await L.pageCount(page)}`);
await L.undo(page);
check(
  !!(await until(page, (n) => window.__acro.viewer.pageInfo(window.__acro.viewer.current)?.total === n, pagesBefore)),
  'and Ctrl+Z takes them back out'
);
await app.close();

/* Errors ------------------------------------------------------------------ */
async function errorRun(env, setup, expect, what) {
  app = await L.start(env);
  page = app.page;
  await L.openDialog(page);
  await choose(page, 'Scanner', 'Paperwing Test Scanner');
  await L.waitReady(page);
  await setup?.();
  await press(page, 'Scan');
  await L.waitIdle(page);
  const r = await dialog(page);
  check(expect.test(r?.status ?? ''), what, r?.status);
  return r;
}
d = await errorRun({ PAPERWING_SCAN_TEST_ERROR: 'paper-jam' }, null, /paper is jammed/, 'a jam says what to do');
check(d?.thumbs === 0 && d.buttons.includes('Scan'), 'and nothing was scanned');
await app.close();

d = await errorRun(
  { PAPERWING_SCAN_TEST_ERROR: 'double-feed@2' },
  () => choose(page, 'Source', 'Document feeder'),
  /Two sheets went through together/,
  'two sheets fed together: stopped, and why'
);
check(d?.thumbs === 2 && /2 pages scanned/.test(d.status), 'the pages before it are kept', `${d?.thumbs}`);
await app.close();

// Stop in the middle: the scanner is free again at once
app = await L.start({ PAPERWING_SCAN_TEST_PAGES: '12' });
page = app.page;
await L.openDialog(page);
await choose(page, 'Scanner', 'Paperwing Test Scanner');
await L.waitReady(page);
await choose(page, 'Source', 'Document feeder');
await press(page, 'Scan');
await until(page, () => document.querySelectorAll('.dlg-scan .sr-page').length >= 2);
check(await press(page, 'Stop'), 'Stop while scanning');
await L.waitIdle(page);
d = await dialog(page);
check(/Scanning stopped/.test(d?.status ?? '') && d.thumbs < 12, 'it stops after the page being scanned', `${d?.thumbs}: ${d?.status}`);
await press(page, 'Scan more pages');
await until(page, () => document.querySelectorAll('.dlg-scan .sr-page').length >= 5);
await press(page, 'Stop');
await L.waitIdle(page);
check(!/busy/i.test((await dialog(page))?.status ?? ''), 'and the scanner was let go (the next scan works)');
await press(page, 'Cancel');
await press(page, (await dialog(page))?.buttons.find((b) => b.startsWith('Discard')));
await app.close();

for (const [code, expect, what] of [
  ['no-scanner', /No scanners found/, 'no scanners: what to check'],
  ['blocked', /blocked|stopped Paperwing/, 'a blocked helper: what to do'],
]) {
  app = await L.start({ PAPERWING_SCAN_TEST_ERROR: code });
  page = app.page;
  await click(page, '#create-btn');
  await until(page, () => document.querySelector('.menu .menu-item'));
  await click(page, '.menu .menu-item', 'From scanner');
  const text = await until(page, () => {
    const n = document.querySelector('.dlg-scan .sd-none');
    return n && !n.hidden && n.textContent;
  });
  check(expect.test(text ?? ''), what, text);
  await app.close();
}

L.finish();
