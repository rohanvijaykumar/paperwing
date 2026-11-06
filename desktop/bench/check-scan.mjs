/**
 * Create PDF from scanner (#35), in the real app with the stand-in scanner
 * (PAPERWING_SCAN_TEST, development builds only), with real clicks:
 *  - Create ▸ From scanner opens the dialog; the scanner and what it can do
 *  - flatbed: scan, Scan more pages, Done: a new unsaved document of Letter
 *    pages
 *  - a one-sided feeder stack, then Scan reverse sides: every page, woven
 *  - both sides at once; Add to the open document (and undo)
 *  - a jam says so; scanned pages aren't discarded on one click
 *   node bench/check-scan.mjs
 */
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './harness.mjs';

let failures = 0;
const check = (ok, what, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
};
const until = async (page, fn, arg, timeout = 20000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await page.evaluate(fn, arg).catch(() => null);
    if (v) return v;
    await sleep(150);
  }
  return null;
};

const sample = fileURLToPath(
  new URL('../../docs/screenshots/samples/Invoice INV-2048.pdf', import.meta.url)
);

async function start(env = {}, args = []) {
  const app = await launch({ env: { PAPERWING_SCAN_TEST: '1', ...env }, args });
  await sleep(2500);
  return app;
}

/** Create ▸ From scanner, with the mouse */
async function openDialog(page) {
  await page.click('#create-btn');
  const item = await until(page, () =>
    [...document.querySelectorAll('.menu .menu-item')].some(
      (m) => m.textContent.trim().startsWith('From scanner')
    )
  );
  if (!item) return false;
  await page.evaluate(() =>
    [...document.querySelectorAll('.menu .menu-item')]
      .find((m) => m.textContent.trim().startsWith('From scanner'))
      .click()
  );
  return !!(await until(
    page,
    () =>
      document.querySelector('.dlg-scan select[aria-label="Scanner"] option') &&
      !document.querySelector('.dlg-scan .accent-btn')?.disabled
  ));
}

const dialog = (page) =>
  page.evaluate(() => {
    const d = document.querySelector('.dlg-scan');
    if (!d) return null;
    const opts = (label) =>
      [...d.querySelectorAll(`select[aria-label="${label}"] option`)].map(
        (o) => o.textContent
      );
    return {
      scanners: opts('Scanner'),
      sources: opts('Source'),
      colors: opts('Color mode'),
      dpi: opts('Resolution'),
      papers: opts('Paper size'),
      outputs: opts('Output'),
      sidesShown: !d.querySelector('select[aria-label="Sides"]').closest('label')
        .hidden,
      status: d.querySelector('.sd-status').textContent,
      thumbs: d.querySelectorAll('.sd-thumb').length,
      buttons: [...d.querySelectorAll('.dlg-actions button')]
        .filter((b) => !b.hidden)
        .map((b) => b.textContent),
    };
  });
const choose = (page, label, text) =>
  page.evaluate(
    ({ label, text }) => {
      const s = document.querySelector(`.dlg-scan select[aria-label="${label}"]`);
      const o = [...s.options].find((x) => x.textContent === text);
      if (!o) return false;
      s.value = o.value;
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    { label, text }
  );
const press = (page, text) =>
  page.evaluate((text) => {
    const b = [...document.querySelectorAll('.dlg-scan .dlg-actions button')].find(
      (x) => x.textContent === text && !x.hidden
    );
    b?.click();
    return !!b;
  }, text);
const scannedCount = (page) =>
  page.evaluate(() => document.querySelectorAll('.dlg-scan .sd-thumb').length);
const waitIdle = (page) =>
  until(page, () => {
    const d = document.querySelector('.dlg-scan');
    return (
      d &&
      [...d.querySelectorAll('.dlg-actions button')].some(
        (b) => b.textContent === 'Done' || b.textContent === 'Scan'
      ) &&
      ![...d.querySelectorAll('.dlg-actions button')].some((b) => b.textContent === 'Stop')
    );
  });
const docInfo = (page) =>
  page.evaluate(async () => {
    const v = window.__acro.viewer;
    const tab = document.querySelector('#tabs .tab.is-active');
    const id = v.docIds.get(v.current);
    const doc = id && v.cap('document-manager').getDocument(id);
    return {
      name: tab?.textContent.trim(),
      dirty: !!tab?.classList.contains('is-dirty'),
      pages: v.pageInfo(v.current)?.total ?? 0,
      size: doc?.pages?.[0]?.size,
    };
  });

/* Flatbed, more pages, Done -------------------------------------------- */
let app = await start();
let { page } = app;
check(await openDialog(page), 'Create ▸ From scanner opens the scan dialog');
let d = await dialog(page);
check(d?.scanners.includes('Paperwing test scanner'), 'it lists the scanner', JSON.stringify(d?.scanners));
check(
  JSON.stringify(d?.sources) === JSON.stringify(['Flatbed', 'Document feeder']),
  'flatbed and document feeder',
  JSON.stringify(d?.sources)
);
check(
  d?.colors.includes('Autodetect') && d.colors.includes('Black and white'),
  'color modes, Autodetect first',
  JSON.stringify(d?.colors)
);
check(
  JSON.stringify(d?.dpi) === JSON.stringify(['150 dpi', '200 dpi', '300 dpi', '600 dpi']),
  'the usual resolutions it has',
  JSON.stringify(d?.dpi)
);
check(d && !d.sidesShown, 'no Sides for the flatbed');
await choose(page, 'Source', 'Flatbed');
await choose(page, 'Paper size', 'Letter');
await choose(page, 'Color mode', 'Color');
await press(page, 'Scan');
await waitIdle(page);
d = await dialog(page);
check(d?.thumbs === 1, 'a flatbed pass scans one page', `${d?.thumbs}`);
check(
  d?.buttons.includes('Scan more pages') &&
    d.buttons.includes('Done') &&
    !d.buttons.includes('Scan reverse sides'),
  'then: Scan more pages or Done (no reverse sides for a flatbed)',
  JSON.stringify(d?.buttons)
);
await press(page, 'Scan more pages');
await waitIdle(page);
check((await scannedCount(page)) === 2, 'Scan more pages adds one');
await press(page, 'Done');
await until(page, () => !document.querySelector('.dlg-scan'), undefined, 30000);
let doc = await until(
  page,
  () => /^Scan .*\.pdf$/.test(document.querySelector('#tabs .tab.is-active')?.textContent.trim() ?? '')
);
await sleep(1500);
let info = await docInfo(page);
check(!!doc && info.pages === 2, 'Done: a new document with both pages', JSON.stringify(info));
check(info.dirty, "it isn't saved yet (closing asks)");
check(
  Math.round(info.size?.width) === 612 && Math.round(info.size?.height) === 792,
  'its pages are Letter, at their real size',
  JSON.stringify(info.size)
);
check(
  /Scanned 2 pages into Scan .*\.pdf/.test(
    await page.evaluate(() => document.querySelector('#toasts')?.textContent ?? '')
  ),
  'and the notice offers to save it'
);

/* A one-sided feeder stack, then the reverse sides ------------------- */
check(await openDialog(page), 'the dialog opens again');
await choose(page, 'Source', 'Document feeder');
d = await dialog(page);
check(d?.sidesShown, 'Sides, for a feeder that scans both');
await choose(page, 'Sides', 'One side');
await press(page, 'Scan');
await waitIdle(page);
d = await dialog(page);
check(d?.thumbs === 3, 'the feeder scans the whole stack (3 sheets)', `${d?.thumbs}`);
check(d?.buttons.includes('Scan reverse sides'), 'and offers Scan reverse sides', JSON.stringify(d?.buttons));
await press(page, 'Scan reverse sides');
await waitIdle(page);
check((await scannedCount(page)) === 6, 'the backs are added: 6 pages');
d = await dialog(page);
check(!d?.buttons.includes('Scan reverse sides'), 'reverse sides only once per stack');

// Pages aren't thrown away on one click
await press(page, 'Cancel');
d = await dialog(page);
check(
  !!d && d.buttons.includes('Discard 6 pages'),
  'Cancel asks again before discarding scanned pages',
  JSON.stringify(d?.buttons)
);
await press(page, 'Discard 6 pages');
check(
  !!(await until(page, () => !document.querySelector('.dlg-scan'))),
  'and discards them on the second click'
);

/* Both sides at once, added to the open document --------------------- */
await app.openFile(sample);
await until(page, () => window.__acro.viewer.pageInfo(window.__acro.viewer.current)?.total > 0);
await sleep(1000);
const before = (await docInfo(page)).pages;
check(await openDialog(page), 'with a document open');
d = await dialog(page);
check(d?.outputs.some((o) => o.startsWith('Add to Invoice')), 'Output offers adding to it', JSON.stringify(d?.outputs));
await choose(page, 'Source', 'Document feeder');
await choose(page, 'Sides', 'Both sides');
await choose(page, 'Output', (d?.outputs ?? []).find((o) => o.startsWith('Add to')) ?? '');
await press(page, 'Scan');
await waitIdle(page);
check((await scannedCount(page)) === 6, 'both sides at once: 6 pages from 3 sheets');
await press(page, 'Done');
const after = await until(
  page,
  (n) => {
    const t = window.__acro.viewer.pageInfo(window.__acro.viewer.current)?.total;
    return t === n ? t : null;
  },
  before + 6,
  30000
);
check(after === before + 6, 'Add to: they go at the end of the open document', `${before} -> ${after}`);
const cdp = await page.target().createCDPSession();
const MOD = process.platform === 'darwin' ? 4 : 2;
for (const type of ['rawKeyDown', 'keyUp'])
  await cdp.send('Input.dispatchKeyEvent', { type, key: 'z', code: 'KeyZ', modifiers: MOD });
check(
  !!(await until(
    page,
    (n) => window.__acro.viewer.pageInfo(window.__acro.viewer.current)?.total === n,
    before
  )),
  'and Ctrl+Z takes them back out'
);
await app.close();

/* A jam ---------------------------------------------------------------- */
app = await start({ PAPERWING_SCAN_TEST_ERROR: 'paper-jam' });
page = app.page;
await openDialog(page);
await press(page, 'Scan');
await waitIdle(page);
d = await dialog(page);
check(/paper is jammed/.test(d?.status ?? ''), 'a jam says what to do', d?.status);
check(d?.thumbs === 0 && d.buttons.includes('Scan'), 'and nothing was scanned');
await app.close();

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
