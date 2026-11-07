/**
 * The rest of scanning, in the real app with the stand-in scanners and real
 * clicks:
 *  - settings shown per scanner (hidden, not greyed out): a one-sided gray
 *    feeder with a resolution range, a network flatbed; every settings
 *    group; Black and white (threshold), custom size (in and mm)
 *  - presets: choosing one, Save as preset…, remembered next time; the main
 *    menu's Create PDF from scanner ▸ a preset scans at once
 *  - Insert pages from scanner (page thumbnails' menu) at page N and
 *    before the first page
 *  - Append to a PDF that isn't open (Browse…, through PAPERWING_TEST_OPEN):
 *    it opens with the pages added, unsaved; the file on disk is untouched
 *  - Save multiple files (PAPERWING_TEST_FOLDER): pages per file, prefix
 *  - Recognize text right after scanning: the text is in the PDF
 *  - All tools: Create a PDF ▸ Scanner, Convert ▸ Create PDF from, tool
 *    search; Scan & OCR's start page; Enhance scanned pages (and Ctrl+Z)
 *  - Import from a scanner app: files appear as they're written
 *  - Add by IP address; a scan recovered after a crash
 *   node bench/check-scan-more.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as L from './scan-bench-lib.mjs';
import { launch } from './harness.mjs';

const require = createRequire(import.meta.url);
const { encodePng, render, pageContent } = require('../scan-test.cjs');
const { check, until, sleep, click, press, choose, dialog } = L;
const TMP = process.env.BENCH_TMP || tmpdir();
const work = mkdtempSync(join(TMP, 'pw-scan-more-'));

/** A 4-page A4 document (pages say their number) */
async function fixture(name) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 4; n++)
    doc.addPage([595, 842]).drawText(`Fixture page ${n}`, { x: 72, y: 760, size: 28, font });
  const file = join(work, name);
  writeFileSync(file, await doc.save());
  return file;
}
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** The open document's bytes, from the viewer */
async function docBytes(page) {
  const b64 = await page.evaluate(async () => {
    const v = window.__acro.viewer;
    const bytes = new Uint8Array(await v.exportBytes(v.current));
    let s = '';
    for (let k = 0; k < bytes.length; k += 0x8000)
      s += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
    return btoa(s);
  });
  return Buffer.from(b64, 'base64');
}
async function pdfText(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
  let text = '';
  for (let n = 1; n <= doc.numPages; n++)
    text += (await (await doc.getPage(n)).getTextContent()).items.map((i) => i.str).join(' ') + '\n';
  await doc.destroy();
  return text;
}

/** The page thumbnail n (the viewer's sidebar), for a right-click */
async function thumb(page, n) {
  return page.evaluate((n) => {
    const out = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll('div'))
        if (el.style.position === 'absolute' && el.textContent.trim() === String(n) && el.querySelector('img')) {
          const r = el.querySelector('img').getBoundingClientRect();
          out.push({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        }
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(document);
    return out[0] ?? null;
  }, n);
}

/** Right-click on a thumbnail, then Insert pages from scanner… (asked
 *  again if the menu didn't open: the viewer may still be settling) */
let lastMenu = [];
async function fromPageMenu(at) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.mouse.click(at.x, at.y, { button: 'right' });
    await until(page, () => document.querySelector('.popover .menu-item'), undefined, 5000);
    lastMenu = await page.evaluate(() =>
      [...document.querySelectorAll('.popover .menu-item')].map((b) => b.textContent.trim())
    );
    if (await click(page, '.popover .menu-item', 'Insert pages from scanner')) return true;
    await page.keyboard.press('Escape');
    await sleep(1000);
  }
  return false;
}

const pageSizes = async (page) => PDFDocument.load(await docBytes(page)).then((d) => d.getPages().map((p) => Math.round(p.getWidth())));

const doc1 = await fixture('Four pages.pdf');
const watchDir = join(work, 'scanner app');
const outDir = join(work, 'out');
mkdirSync(watchDir);
mkdirSync(outDir);

/* Settings per scanner, and every group -------------------------------- */
let app = await L.start({ PAPERWING_TEST_FOLDER: outDir });
let { page } = app;
check(await L.openDialog(page), 'the scan dialog opens');
await choose(page, 'Scanner', 'Paperwing Test Feeder');
await L.waitReady(page);
let d = await dialog(page);
check(d.sources === null, 'a feeder-only scanner: no Source');
check(JSON.stringify(d.sides) === JSON.stringify(['Front sides', 'Both sides']), 'Pages: both sides (through Scan reverse sides)', JSON.stringify(d.sides));
check(JSON.stringify(d.colors) === JSON.stringify(['Grayscale', 'Black and white']), 'only its color modes (no Autodetect without color)', JSON.stringify(d.colors));
check(d.dpi.at(-1) === 'Custom…', 'a resolution range: Custom…', JSON.stringify(d.dpi));
check(!d.previewTab && !d.buttons.includes('Preview'), 'no preview (hidden, not greyed out)');
await choose(page, 'Resolution', 'Custom…');
check((await L.shows(page, ['Custom resolution (dpi)']))['Custom resolution (dpi)'], 'Custom… asks for the resolution');
await L.setValue(page, 'Custom resolution (dpi)', 350);
check(/350 dpi/.test((await dialog(page)).summary), 'and uses it', (await dialog(page)).summary);

await choose(page, 'Scanner', 'Paperwing Network Scanner');
await L.waitReady(page);
d = await dialog(page);
check(d.sides === null && d.sources === null, 'a network flatbed: no Pages group at all');
check(d.colors.includes('Black and white'), 'black and white anyway (made so after the scan)');
check(d.previewTab, 'it can preview');

await choose(page, 'Scanner', 'Paperwing Test Scanner');
await L.waitReady(page);
await choose(page, 'Source', 'Flatbed');
await choose(page, 'Color mode', 'Black and white');
check((await L.shows(page, ['Threshold']))['Threshold'], 'Black and white shows the threshold');
await choose(page, 'Color mode', 'Grayscale');
check(!(await L.shows(page, ['Threshold']))['Threshold'], 'other modes hide it');
await choose(page, 'Paper size', 'Custom size');
let shown = await L.shows(page, ['Width', 'Height', 'Units', 'Orientation']);
check(shown.Width && shown.Height && shown.Units && !shown.Orientation, 'Custom size: width × height and units', JSON.stringify(shown));
await L.setValue(page, 'Width', 5);
await L.setValue(page, 'Height', 7);
await choose(page, 'Units', 'mm');
const mm = await page.evaluate(() => [
  document.querySelector('.dlg-scan input[aria-label="Width"]').value,
  document.querySelector('.dlg-scan input[aria-label="Height"]').value,
]);
check(mm.join() === '127,178', 'switching to mm converts the size', mm.join());
await choose(page, 'Paper size', 'A5');
check((await L.shows(page, ['Orientation']))['Orientation'], 'a paper size shows its orientation');
for (const title of ['Clean-up', 'File size']) {
  const closed = await page.evaluate(
    (t) => [...document.querySelectorAll('.dlg-scan .sd-toggle')].find((b) => b.textContent.trim() === t)?.getAttribute('aria-expanded'),
    title
  );
  check(closed === 'false', `${title} starts closed`);
  await L.openGroup(page, title);
}
shown = await L.shows(page, [
  'Deskew (straighten crooked pages)',
  'Auto-crop to the page edges',
  'Background removal',
  'Descreen (printed photos, magazines)',
  'Text sharpening',
  'Despeckle (remove stray dots)',
  'Remove blank pages',
  'Remove edge shadows',
  'Auto-rotate pages (finds upside-down text)',
  'Rotate all pages',
  'File size and quality',
  'Color and grayscale compression',
  'Compress after scanning (Compress a PDF)',
]);
check(Object.values(shown).every(Boolean), 'every clean-up and file size setting', JSON.stringify(shown));
const deskewOn = await page.evaluate(() => document.querySelector('.dlg-scan input[aria-label="Deskew (straighten crooked pages)"]').checked);
check(deskewOn, 'Deskew is on to begin with, like Acrobat');
await choose(page, 'Rotate all pages', '180°');
await choose(page, 'Background removal', 'Medium');
await L.tick(page, 'Despeckle (remove stray dots)', true);
await L.setValue(page, 'File size and quality', 0.2);
await choose(page, 'Color and grayscale compression', 'ZIP (lossless)');
await choose(page, 'Paper size', 'Letter');
await press(page, 'Scan');
await L.waitIdle(page);
d = await dialog(page);
check(d.thumbs === 1, 'scans with all of them', d.status);

/* Presets ------------------------------------------------------------------ */
await press(page, 'Cancel');
await press(page, 'Discard 1 page');
await L.openDialog(page);
await choose(page, 'Preset', 'Black and white document');
d = await dialog(page);
check(d.colors && (await page.evaluate(() => {
  const s = document.querySelector('.dlg-scan select[aria-label="Color mode"]');
  return s.options[s.selectedIndex].textContent;
})) === 'Black and white', 'Black and white document: black and white', d.summary);
await click(page, '.dlg-scan .sd-link', 'Save as preset');
await until(page, () => document.querySelector('[aria-label="Save as preset"]'));
await page.type('[aria-label="Preset name"]', 'Receipts');
await click(page, '[aria-label="Save as preset"] .accent-btn', 'Save');
d = await dialog(page);
check(d.preset === 'Receipts' && d.presets.includes('Receipts'), 'Save as preset… adds it, chosen', JSON.stringify(d.presets));
await press(page, 'Cancel');
await until(page, () => !document.querySelector('.dlg-scan'));
await L.openDialog(page);
check((await dialog(page)).preset === 'Receipts', 'the preset is remembered next time');
await press(page, 'Cancel');
await until(page, () => !document.querySelector('.dlg-scan'));
// Main menu ▸ Create PDF from scanner ▸ a preset: scans at once
await click(page, '#menu-btn');
await until(page, () => document.querySelector('.menu .menu-item'));
await click(page, '.menu .menu-item', 'Create PDF from scanner');
const presetItems = await until(page, () => {
  const items = [...document.querySelectorAll('.menu .menu-item')].map((m) => m.textContent.trim());
  return items.includes('Grayscale document') && items;
});
check(presetItems && presetItems[0] === 'Scan…', 'the main menu lists Scan… and the presets', JSON.stringify(presetItems));
await click(page, '.menu .menu-item', 'Grayscale document');
await until(page, () => document.querySelectorAll('.dlg-scan .sr-page').length > 0, undefined, 30000);
await L.waitIdle(page);
d = await dialog(page);
check(d?.thumbs >= 1 && d.preset === 'Grayscale document', 'a preset from the menu scans straight away', `${d?.thumbs} ${d?.preset}`);
await press(page, 'Cancel');
await press(page, (await dialog(page)).buttons.find((b) => b.startsWith('Discard')));

/* Save multiple files ------------------------------------------------------ */
await L.openDialog(page);
await choose(page, 'Preset', 'My settings');
await choose(page, 'Scanner', 'Paperwing Test Scanner');
await L.waitReady(page);
await choose(page, 'Source', 'Document feeder');
await choose(page, 'Pages', 'Both sides');
await click(page, '.dlg-scan .pd-radio', 'Save multiple files');
shown = await L.shows(page, ['Pages per file', 'File name prefix']);
check(shown['Pages per file'] && shown['File name prefix'], 'Save multiple files: pages per file, prefix, folder');
await L.setValue(page, 'Pages per file', 2);
await L.setValue(page, 'File name prefix', 'Batch');
await click(page, '.dlg-scan .sd-sub .pill-btn', 'Choose');
await press(page, 'Scan');
await L.waitIdle(page);
await press(page, 'Scan is complete');
await until(page, () => !document.querySelector('.dlg-scan'), undefined, 30000);
const files = readdirSync(outDir).sort();
check(JSON.stringify(files) === JSON.stringify(['Batch 1.pdf', 'Batch 2.pdf', 'Batch 3.pdf']), '6 pages, 2 per file: Batch 1-3.pdf in the chosen folder', JSON.stringify(files));
const counts = await Promise.all(files.map(async (f) => (await PDFDocument.load(readFileSync(join(outDir, f)))).getPageCount()));
check(counts.join() === '2,2,2', 'two pages each', counts.join());
check(/Saved 3 files/.test(await L.toasts(page)), 'and the notice says where');
await app.close();

/* Insert pages at page N; append to a PDF that isn't open ----------------- */
app = await L.start({ PAPERWING_TEST_OPEN: doc1 });
page = app.page;
const diskBefore = sha(doc1);
await app.openFile(doc1);
await until(page, () => window.__acro.viewer.pageInfo(window.__acro.viewer.current)?.total === 4);
await page.evaluate(() => document.querySelector('#right-rail [data-panel="sidebar-panel:thumbnails"]').click());
await sleep(2500);
// (page 1's thumbnail: in view on any screen)
const t1 = await thumb(page, 1);
check(!!t1, 'page thumbnails shown');
check(await fromPageMenu(t1), "the page's menu: Insert pages from scanner…", lastMenu.join(' | '));
await L.waitReady(page);
d = await dialog(page);
check(d.title === 'Insert pages from scanner', 'the dialog says what it will do');
const insertAt = await page.evaluate(() => ({
  pos: document.querySelector('.dlg-scan select[aria-label="Location"]').value,
  page: document.querySelector('.dlg-scan select[aria-label="Page"]').value,
  n: document.querySelector('.dlg-scan input[aria-label="Page number"]').value,
}));
check(insertAt.pos === 'after' && insertAt.page === 'number' && insertAt.n === '1', 'Insert Pages: after page 1 (the one clicked)', JSON.stringify(insertAt));
await choose(page, 'Scanner', 'Paperwing Test Scanner');
await L.waitReady(page);
await choose(page, 'Source', 'Flatbed');
await choose(page, 'Paper size', 'Letter');
await press(page, 'Scan');
await L.waitIdle(page);
await press(page, 'Scan is complete');
await until(page, () => window.__acro.viewer.pageInfo(window.__acro.viewer.current)?.total === 5, undefined, 30000);
let sizes = await pageSizes(page);
check(sizes.join() === '595,612,595,595,595', 'the scanned (Letter) page is page 2', sizes.join());
await fromPageMenu(t1);
await L.waitReady(page);
await choose(page, 'Location', 'Before');
await choose(page, 'Page', 'First');
check(!(await L.shows(page, ['Page number']))['Page number'], 'First: no page number');
await press(page, 'Scan');
await L.waitIdle(page);
await press(page, 'Scan is complete');
await until(page, () => window.__acro.viewer.pageInfo(window.__acro.viewer.current)?.total === 6, undefined, 30000);
sizes = await pageSizes(page);
check(sizes.join() === '612,595,612,595,595,595', 'before the first page', sizes.join());
// Close it (discarding) so Browse… opens it fresh
await page.evaluate(() => window.__acro && null);
await app.close();

app = await L.start({ PAPERWING_TEST_OPEN: doc1 });
page = app.page;
check(await L.openDialog(page), 'with no document open');
await choose(page, 'Scanner', 'Paperwing Test Scanner');
await L.waitReady(page);
await choose(page, 'Source', 'Flatbed');
await click(page, '.dlg-scan .pd-radio', 'Append to file');
await choose(page, 'File to append to', 'Browse…');
const browsed = await until(page, () => {
  const s = document.querySelector('.dlg-scan select[aria-label="File to append to"]');
  return s.options[s.selectedIndex]?.textContent.includes('(not open)') && s.options[s.selectedIndex].textContent;
});
check(browsed === 'Four pages.pdf (not open)', 'Browse… picks a PDF that isn’t open', browsed);
await press(page, 'Scan');
await L.waitIdle(page);
await press(page, 'Scan is complete');
await until(page, () => window.__acro.viewer.pageInfo(window.__acro.viewer.current)?.total === 5, undefined, 30000);
let info = await L.docInfo(page);
check(info.name === 'Four pages.pdf' && info.pages === 5 && info.dirty, 'it opens with the page added at the end, unsaved', JSON.stringify(info));
check(sha(doc1) === diskBefore, 'the file on disk is untouched');
await L.undo(page);
check(!!(await until(page, () => window.__acro.viewer.pageInfo(window.__acro.viewer.current)?.total === 4)), 'Ctrl+Z takes the page out');
await app.close();

/* Recognize text right after scanning --------------------------------------- */
// (PAPERWING_TEST_OPEN: Enhance scanned pages never waits on a real file dialog)
app = await L.start({ PAPERWING_TEST_OPEN: doc1 });
page = app.page;
await L.openDialog(page);
await choose(page, 'Scanner', 'Paperwing Test Scanner');
await L.waitReady(page);
await choose(page, 'Source', 'Flatbed');
await choose(page, 'Paper size', 'Letter');
await choose(page, 'Color mode', 'Grayscale');
await L.tick(page, 'Recognize text (OCR)', true);
check((await L.shows(page, ['Language']))['Language'], 'Recognize text: its language');
await choose(page, 'Language', 'English');
await press(page, 'Scan');
await L.waitIdle(page);
await press(page, 'Scan is complete');
await until(page, () => /Recognizing/.test(document.querySelector('.dlg-scan .sd-status')?.textContent ?? ''), undefined, 15000);
await until(page, () => !document.querySelector('.dlg-scan'), undefined, 180000);
await until(page, () => /^Scan /.test(document.querySelector('#tabs .tab.is-active')?.textContent.trim() ?? ''));
await sleep(1500);
const text = await pdfText(await docBytes(page));
// (the stand-in's blocky letters read a little differently on each OS)
check((text.match(/SHEET|TEST|LAZY|DOG|QUICK|PAGE|OVER|SCAN/gi) ?? []).length >= 3, 'the new document has the scanned text in it', text.slice(0, 120).replace(/\s+/g, ' '));

/* PDF/A, and Compress a PDF after scanning ------------------------------------ */
await L.openDialog(page);
await choose(page, 'Scanner', 'Paperwing Test Scanner');
await L.waitReady(page);
await choose(page, 'Source', 'Flatbed');
await L.tick(page, 'Recognize text (OCR)', false);
await L.tick(page, 'Make PDF/A compliant', true);
await L.openGroup(page, 'File size');
await L.tick(page, 'Compress after scanning (Compress a PDF)', true);
await press(page, 'Scan');
await L.waitIdle(page);
await press(page, 'Scan is complete');
await until(page, () => !document.querySelector('.dlg-scan'), undefined, 30000);
const pdfaTab = await until(page, () => /^Scan /.test(document.querySelector('#tabs .tab.is-active')?.textContent.trim() ?? '') && !/PDF.A compliant/.test(document.querySelector('#toasts')?.textContent ?? '') ? document.querySelector('#tabs .tab.is-active').textContent : null, undefined, 120000);
await sleep(2000);
const pdfaBytes = (await docBytes(page)).toString('latin1');
check(!!pdfaTab && /pdfaid:part/.test(pdfaBytes), 'Make PDF/A compliant: the new document says it is PDF/A', String(/pdfaid:part.{0,20}/.exec(pdfaBytes)?.[0] ?? (await L.toasts(page))));
const compressOpen = await until(page, () => [...document.querySelectorAll('.lp-title, .fh-title')].some((t) => /Compress/.test(t.textContent)), undefined, 20000);
check(!!compressOpen, 'Compress after scanning: Compress a PDF opens on it');
await click(page, '[aria-label="Back to tools"]');
await sleep(500);

/* All tools, search, Scan & OCR, Enhance -------------------------------------- */
await click(page, '#gb-tabs [data-panel="convert"]');
await sleep(500);
const convert = await page.evaluate(() =>
  [...document.querySelectorAll('.lp-tool')].filter((t) => t.offsetParent).map((t) => t.textContent.trim())
);
check(convert.includes('Scanner'), 'Convert ▸ Create PDF from: Scanner', JSON.stringify(convert.slice(0, 12)));
await click(page, '#gb-tabs [data-panel="all"]');
await sleep(400);
await click(page, '.lp-section', 'Create a PDF');
await sleep(300);
const all = await page.evaluate(() =>
  [...document.querySelectorAll('.lp-tool')].filter((t) => t.offsetParent).map((t) => t.textContent.trim())
);
check(all.includes('Scanner'), 'All tools ▸ Create a PDF ▸ Scanner');
check(all.includes('Scan & OCR'), 'All tools ▸ Scan & OCR');
/** Types into the tool search that's shown (each tab has its own panel) */
const search = async (q) => {
  const box = await page.evaluate(() => {
    const i = [...document.querySelectorAll('.lp-search input')].find((x) => x.offsetParent);
    i.value = '';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    const r = i.getBoundingClientRect();
    return { x: r.x + 20, y: r.y + r.height / 2 };
  });
  await page.mouse.click(box.x, box.y);
  await page.keyboard.type(q);
  await sleep(300);
  return page.evaluate(() =>
    [...document.querySelectorAll('.lp-tool')].filter((t) => t.offsetParent).map((t) => t.textContent.trim())
  );
};
let found = await search('scanner');
check(found.includes('Scanner'), 'tool search "scanner": Scanner', JSON.stringify(found));
found = await search('scan');
check(['Scanner', 'Scan & OCR', 'Enhance scanned pages'].every((t) => found.includes(t)), 'tool search "scan": Scanner, Scan & OCR, Enhance scanned pages', JSON.stringify(found));
await click(page, '.lp-tool', 'Scan & OCR');
const tiles = await until(page, () => {
  const d = document.querySelector('.dlg-scan-ocr');
  return d && [...d.querySelectorAll('.so-title')].map((t) => t.textContent);
});
check(JSON.stringify(tiles) === JSON.stringify(['Select a file', 'Scan a document', 'Enhance scanned pages']), "Scan & OCR: Acrobat's start page", JSON.stringify(tiles));
check(/Select a file or scan a document to recognize text/.test(await page.evaluate(() => document.querySelector('.dlg-scan-ocr').textContent)), 'with its words');
await click(page, '.so-tile', 'Scan a document');
await L.waitReady(page);
check(await page.evaluate(() => document.querySelector('.dlg-scan input[aria-label="Recognize text (OCR)"]').checked), 'Scan a document: the scan dialog with Recognize text on');
await press(page, 'Cancel');
await until(page, () => !document.querySelector('.dlg-scan'));
// Enhance a document with several pages: the 4-page one, open and shown
await app.openFile(doc1);
await until(page, () => window.__acro.viewer.pageInfo(window.__acro.viewer.current)?.total === 4, undefined, 20000);
await sleep(1000);
const before = await L.pageCount(page);
const bytesBefore = (await docBytes(page)).length;
await page.evaluate(() => document.querySelector('.lp-search input')?.blur());
let enhanceFound = [];
for (let attempt = 0; attempt < 3 && !(await page.$('.dlg-enhance')); attempt++) {
  enhanceFound = await search('enhance');
  await click(page, '.lp-tool', 'Enhance scanned pages');
  await until(page, () => document.querySelector('.dlg-enhance'), undefined, 8000);
}
check(
  !!(await page.$('.dlg-enhance')),
  'Enhance scanned pages: its choices',
  `${JSON.stringify(enhanceFound)}; dialogs open: ${await page.evaluate(() => [...document.querySelectorAll('.dlg-backdrop [role=dialog]')].map((d) => d.getAttribute('aria-label')).join(', '))}`
);
await click(page, '.dlg-enhance .accent-btn', 'Enhance');
const enhanced = await until(page, () => /Enhanced the scanned pages/.test(document.querySelector('#toasts')?.textContent ?? ''), undefined, 60000);
info = await L.docInfo(page);
check(!!enhanced && info.dirty && info.pages === before, 'it changes the pages, unsaved', JSON.stringify(info));
const changed = (await docBytes(page)).length;
await L.undo(page);
await sleep(1500);
const back = (await docBytes(page)).length;
// (the pages drawn as pictures are bigger than the text ones they replaced)
check(changed > bytesBefore * 1.5 && back < changed * 0.6, 'Ctrl+Z undoes it', `${bytesBefore} -> ${changed} -> ${back}`);
await app.close();

/* Import from a scanner app; add by IP address; recovered after a crash --- */
const profile = mkdtempSync(join(TMP, 'pw-scan-profile-'));
app = await launch({ profile, env: { PAPERWING_SCAN_TEST: '1', PAPERWING_TEST_FOLDER: watchDir } });
page = app.page;
await sleep(2500);
await L.openDialog(page);
await choose(page, 'Scanner', 'Import from a scanner app…');
d = await dialog(page);
check(d.sides === null && d.colors === null, 'Import from a scanner app: no scanner settings');
await click(page, '.dlg-scan .sd-folder .pill-btn', 'Choose');
await until(page, () => /Waiting for new scans/.test(document.querySelector('.dlg-scan .sd-status').textContent));
// A scanner app saving a picture, then a PDF in pieces
const img = render(pageContent(1, { sheet: 1, side: 'front', blank: false, width: 8.5 }), { x: 0, y: 0, width: 8.5, height: 11 }, 60, { color: 'gray' });
writeFileSync(join(watchDir, 'scan 001.png'), img.png);
const pdf = readFileSync(doc1);
const half = Math.floor(pdf.length / 2);
writeFileSync(join(watchDir, 'scan 002.pdf'), pdf.subarray(0, half));
await until(page, () => document.querySelectorAll('.dlg-scan .sr-page').length >= 1, undefined, 15000);
await sleep(2500);
check((await dialog(page)).thumbs === 1, 'a new picture shows; a half-written PDF waits', `${(await dialog(page)).thumbs}`);
appendFileSync(join(watchDir, 'scan 002.pdf'), pdf.subarray(half));
await until(page, () => document.querySelectorAll('.dlg-scan .sr-page').length === 5, undefined, 15000);
check((await dialog(page)).thumbs === 5, 'then its 4 pages', `${(await dialog(page)).thumbs}`);
await press(page, 'Scan is complete');
await until(page, () => window.__acro.viewer.pageInfo(window.__acro.viewer.current)?.total === 5, undefined, 30000);
check((await L.docInfo(page)).pages === 5, 'they make one new document');
void encodePng;

check(await L.openDialog(page), 'the scan dialog opens again', JSON.stringify(await dialog(page)));
await click(page, '.dlg-scan .sd-link', 'Add by IP address');
await until(page, () => document.querySelector('[aria-label="Add a network scanner"]'));
await page.type('[aria-label="IP address or host name"]', '10.0.0.250');
await click(page, '[aria-label="Add a network scanner"] .accent-btn', 'Add');
const refused = await until(page, () => document.querySelector('[aria-label="Add a network scanner"] .sd-status')?.textContent);
check(/No scanner answered at 10\.0\.0\.250/.test(refused ?? ''), 'an address where nothing answers says so', refused);
await page.$eval('[aria-label="IP address or host name"]', (i) => (i.value = ''));
await page.type('[aria-label="IP address or host name"]', '192.0.2.44');
await click(page, '[aria-label="Add a network scanner"] .accent-btn', 'Add');
await until(page, () => !document.querySelector('[aria-label="Add a network scanner"]'));
await L.waitReady(page);
check((await dialog(page)).scanner === 'Network scanner at 192.0.2.44', 'Add by IP address adds it and chooses it', (await dialog(page)).scanner);
await press(page, 'Scan');
await L.waitIdle(page);
await press(page, 'Scan is complete');
await until(page, () => /^Scan /.test(document.querySelector('#tabs .tab.is-active')?.textContent.trim() ?? ''), undefined, 30000);
await sleep(6000); // (the recovery copy is written a few seconds in)
app.child.kill('SIGKILL');
await new Promise((r) => app.child.once('exit', r));
app = await launch({ profile, env: { PAPERWING_SCAN_TEST: '1' } });
page = app.page;
const recovered = await until(page, () => /Recovered \d documents?/.test(document.querySelector('#toasts')?.textContent ?? ''), undefined, 20000);
const names = await page.evaluate(() => [...document.querySelectorAll('#tabs .tab')].map((t) => t.textContent.trim()));
check(!!recovered && names.some((n) => /^Scan \d{4}/.test(n)), 'after a crash, the unsaved scans come back', JSON.stringify(names));
await app.close();

L.finish();
