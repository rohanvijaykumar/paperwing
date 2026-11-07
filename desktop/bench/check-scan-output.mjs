/**
 * What scanning makes, checked: in the real app with the stand-in scanners
 * (their flatbed glass is a fixed test chart, scan-test.cjs), real clicks,
 * and every check made on the result: the PDF's pages and images (sizes,
 * resolution, compression, color) and its pixels (which part of the chart,
 * where its colored squares are, the stand-in's page labels, how crooked).
 *  - the scan area drawn on the preview comes out exactly, also from
 *    drivers that ignore where an area starts (like the TWAIN Working
 *    Group's sample driver) or ignore the area altogether
 *  - the preview: the whole glass fits at any window size; color mode,
 *    threshold, brightness, contrast and invert shown live on it
 *  - paper sizes: the box on the glass, the page size, the part of the glass
 *  - color modes, Autodetect; resolution; brightness, contrast, threshold
 *  - Scan reverse sides and Flip back sides: pages in reading order
 *  - every clean-up filter, measured; file size and compression; presets;
 *    Options (driver, the scanner's own window, transfer, invert)
 *  - Preview between passes and why a feeder can't; the review strip's
 *    changes in the PDF; keyboard and screen-reader basics; errors
 *   node bench/check-scan-output.mjs
 * SHOTS=<folder> also saves screenshots for the test report; ONLY=2,5 runs
 * just those parts.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as L from './scan-bench-lib.mjs';
import * as P from './scan-pdf-check.mjs';

const { check, until, sleep, click, press, choose, dialog } = L;
const { standIn } = P;
const TMP = process.env.BENCH_TMP || tmpdir();
const work = mkdtempSync(join(TMP, 'pw-scan-out-'));
const SHOTS = process.env.SHOTS;
const GLASS = standIn.GLASS;
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const ONLY = process.env.ONLY?.split(',');
const part = (n) => !ONLY || ONLY.includes(String(n));
const fmt = (o) => JSON.stringify(o, (k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v));

let app;
let page;
async function launch(env = {}) {
  app = await L.start(env);
  page = app.page;
}
const shot = async (name) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `after-standin-${name}.png`) });
};

/* Setting the dialog up ---------------------------------------------------- */

const must = async (p, what) => {
  if (!(await p)) check(false, `(setting up) ${what}`);
};
const CLEAN = {
  deskew: false,
  autoCrop: false,
  background: 'Off',
  descreen: false,
  sharpen: 'Off',
  despeckle: false,
  removeBlank: false,
  edgeShadow: false,
  autoRotate: false,
  rotate: 'No',
};
/** Chooses settings in the dialog, as a person would; clean-up all off
 *  unless asked for */
async function prep(o = {}) {
  if (o.preset) await must(choose(page, 'Preset', o.preset), `preset ${o.preset}`);
  if (o.scanner) {
    await must(choose(page, 'Scanner', o.scanner), o.scanner);
    await L.waitReady(page);
  }
  if (o.source) await must(choose(page, 'Source', o.source), o.source);
  if (o.sides) await must(choose(page, 'Pages', o.sides), o.sides);
  if (o.color) await must(choose(page, 'Color mode', o.color), o.color);
  if (o.dpi) await must(choose(page, 'Resolution', o.dpi), o.dpi);
  if (o.paper) await must(choose(page, 'Paper size', o.paper), o.paper);
  if (o.orientation) await must(choose(page, 'Orientation', o.orientation), o.orientation);
  for (const k of ['Brightness', 'Contrast', 'Threshold'])
    if (o[k.toLowerCase()] !== undefined) await must(L.setValue(page, k, o[k.toLowerCase()]), k);
  if (o.flip !== undefined) await must(L.tick(page, 'Flip back sides (bound at the top)', o.flip), 'flip');
  if (o.keepClean) return;
  await L.openGroup(page, 'Clean-up');
  const c = { ...CLEAN, ...o.clean };
  await must(L.tick(page, 'Deskew (straighten crooked pages)', c.deskew), 'deskew');
  await must(L.tick(page, 'Auto-crop to the page edges', c.autoCrop), 'auto-crop');
  await must(choose(page, 'Background removal', c.background), 'background');
  await must(L.tick(page, 'Descreen (printed photos, magazines)', c.descreen), 'descreen');
  await must(choose(page, 'Text sharpening', c.sharpen), 'sharpen');
  await must(L.tick(page, 'Despeckle (remove stray dots)', c.despeckle), 'despeckle');
  await must(L.tick(page, 'Remove blank pages', c.removeBlank), 'blank');
  await must(L.tick(page, 'Remove edge shadows', c.edgeShadow), 'edge');
  await must(L.tick(page, 'Auto-rotate pages (finds upside-down text)', c.autoRotate), 'auto-rotate');
  await must(choose(page, 'Rotate all pages', c.rotate), 'rotate');
}

/** One pass: Scan (or Scan more pages); waits for it to end */
async function pass(button = 'Scan', timeout = 90000) {
  await must(press(page, button), button);
  await sleep(300);
  return L.waitIdle(page, timeout);
}

const complete = (pages, timeout) => L.complete(page, pages, timeout);

async function open(scanner = 'Paperwing Test Scanner') {
  await must(L.openDialog(page), 'the scan dialog opens');
  await must(choose(page, 'Scanner', scanner), scanner);
  await L.waitReady(page);
}

const boxNow = (glass = GLASS) => L.boxNow(page, glass);
const dragCorner = (corner, x, y, glass = GLASS) => L.dragCorner(page, corner, x, y, glass);
const previewPixels = (glass = GLASS) => L.previewPixels(page, glass);
const lookShows = (want) => L.lookShows(page, want);

/** The scan requests the stand-in got (PAPERWING_SCAN_TEST_LOG) */
const requests = (log) =>
  readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

/** Region (inches) of a rendered page */
const region = (img, x, y, w, h) => P.crop(img, x * img.dpi, y * img.dpi, w * img.dpi, h * img.dpi);
/** Where a chart square should be in a scan of the box `b`, px at dpi */
const expectAt = (name, b, dpi) => {
  const m = standIn.MARKERS.find((k) => k.name === name);
  return { x: (m.x + standIn.MARKER_SIZE / 2 - b.x) * dpi, y: (m.y + standIn.MARKER_SIZE / 2 - b.y) * dpi };
};
/** Which of these chart squares a page shows, and whether each is where it
 *  should be for a scan of box b (null: not there) */
function markersIn(img, b, names) {
  const out = {};
  for (const n of names) {
    const hit = P.findMarker(img, n, standIn.MARKER_SIZE * img.dpi);
    if (!hit) {
      out[n] = null;
      continue;
    }
    const e = expectAt(n, b, img.dpi);
    out[n] = Math.round(Math.hypot(hit.x - e.x, hit.y - e.y) * 10) / 10;
  }
  return out;
}

/* 1. The scan area, with three kinds of driver ------------------------------ */

async function areaRun(env, label) {
  const log = join(work, `log-${label}.jsonl`);
  writeFileSync(log, '');
  await launch({ ...env, PAPERWING_SCAN_TEST_LOG: log });
  await open();
  await prep({ source: 'Flatbed', color: 'Color', dpi: '100 dpi' });
  await click(page, '.dlg-scan .sd-tabs .pd-seg-btn', 'Preview');
  await press(page, 'Preview');
  await L.waitIdle(page);
  await lookShows({ color: 'color' });
  const found = await boxNow();
  const doc = standIn.DOC_ON_GLASS;
  check(
    !!found && near(found.x, doc.x, 0.15) && near(found.y, doc.y, 0.15) && near(found.width, doc.width, 0.2) && near(found.height, doc.height, 0.2),
    `${label}: Preview finds the sheet of paper on the glass (1, 1.2 in; 6 × 12 in)`,
    fmt(found)
  );
  const preview = await previewPixels();
  check(!!preview && near(preview.width, GLASS.width * 75, 2) && near(preview.height, GLASS.height * 75, 2), `${label}: the preview is the whole 8.5 × 14 in glass`, `${preview?.width}×${preview?.height}`);
  // A box around the teal and purple squares, with the mouse
  await dragCorner('nw', 3.5, 4.8);
  await dragCorner('se', 6.7, 9.0);
  const b = await boxNow();
  check(!!b && near(b.x, 3.5, 0.12) && near(b.y, 4.8, 0.12) && near(b.x + b.width, 6.7, 0.12) && near(b.y + b.height, 9.0, 0.12), `${label}: dragging the corners sets the box`, fmt(b));
  if (label === 'exact') await shot('crop-box');
  await pass();
  const bytes = await complete(1);
  const [facts] = await P.pdfFacts(bytes);
  check(near(facts.width, b.width * 72, 2.5) && near(facts.height, b.height * 72, 2.5), `${label}: the page is the box's size`, `${facts.width} × ${facts.height} pt for ${fmt(b)}`);
  const img = await P.renderPage(bytes, 0, 100);
  const m = markersIn(img, b, ['teal', 'purple', 'orange', 'red', 'yellow']);
  check(
    m.teal !== null && m.teal < 4 && m.purple !== null && m.purple < 4 && m.orange === null && m.red === null && m.yellow === null,
    `${label}: the scan shows what was in the box: its squares where they were (px off), none from outside`,
    fmt(m)
  );
  // The scan and the preview's box, side by side at the preview's size
  const pw = Math.round(b.width * 25);
  const ph = Math.round(b.height * 25);
  const fromPreview = P.resize(P.crop(preview, b.x * 75, b.y * 75, b.width * 75, b.height * 75), pw, ph);
  const like = P.likeness(P.resize(img, pw, ph), fromPreview);
  check(like > 0.9, `${label}: it matches what the preview showed in the box`, `likeness ${like.toFixed(3)}`);
  const asked = requests(log).filter((r) => r.command === 'scan').at(-1)?.options;
  check(
    !!asked?.area && asked.area.x === 0 && asked.area.y === 0 && near(asked.area.width, b.x + b.width, 0.02) && near(asked.area.height, b.y + b.height, 0.02),
    `${label}: the scanner was asked for the glass from its corner to the box's far corner`,
    fmt(asked?.area)
  );
  const prev = requests(log).find((r) => r.command === 'preview')?.options;
  check(
    prev?.color === 'color' && prev.dpi === 75 && prev.paper?.width === GLASS.width && prev.paper?.height === GLASS.height && prev.brightness === undefined,
    `${label}: the preview asks for the whole glass in color, nothing adjusted`,
    fmt(prev)
  );
  await app.close();
}
if (part(1)) {
  await areaRun({}, 'exact');
  await areaRun({ PAPERWING_SCAN_TEST_IGNORE_OFFSET: '1' }, 'a driver ignoring where the area starts');
  await areaRun({ PAPERWING_SCAN_TEST_IGNORE_AREA: '1' }, 'a driver ignoring the area');
}

/* 2. The preview: fits; shows the settings live; keyboard; between passes -- */
if (part(2)) {
  const log = join(work, 'log-preview.jsonl');
  writeFileSync(log, '');
  await launch({ PAPERWING_SCAN_TEST_LOG: log });
  await open();
  // Refresh: the scanners looked for again, the chosen one kept
  const listBefore = (await dialog(page)).scanners;
  await click(page, '.dlg-scan [aria-label="Refresh the scanner list"]');
  await L.waitReady(page);
  const afterRefresh = await dialog(page);
  check(
    JSON.stringify(afterRefresh.scanners) === JSON.stringify(listBefore) && afterRefresh.scanner === 'Paperwing Test Scanner',
    'Refresh looks for scanners again and keeps the one chosen',
    fmt(afterRefresh.scanners)
  );
  await prep({ source: 'Flatbed', color: 'Color', dpi: '100 dpi', paper: 'Letter' });
  await click(page, '.dlg-scan .sd-tabs .pd-seg-btn', 'Preview');
  const empty = await page.evaluate(() => {
    const st = document.querySelector('.dlg-scan .sp-stage');
    return { shown: !!st && !st.hidden, text: document.querySelector('.dlg-scan .sp-empty')?.textContent };
  });
  check(empty.shown && /Select Preview/.test(empty.text ?? ''), 'before a preview: the glass, empty, with what to do', fmt(empty));
  // Paper sizes: the box on the glass
  const boxes = {};
  for (const [paper, orient] of [
    ['Letter', 'Portrait'],
    ['A4', 'Portrait'],
    ['Legal', 'Portrait'],
    ['A5', 'Landscape'],
    ['Letter', 'Landscape'],
    ['Whole glass', null],
  ]) {
    await choose(page, 'Paper size', paper);
    if (orient) await choose(page, 'Orientation', orient);
    boxes[`${paper} ${orient ?? ''}`.trim()] = await boxNow();
  }
  const is = (b, w, h) => !!b && near(b.x, 0, 0.02) && near(b.y, 0, 0.02) && near(b.width, w, 0.03) && near(b.height, h, 0.03);
  check(
    is(boxes['Letter Portrait'], 8.5, 11) &&
      is(boxes['A4 Portrait'], 8.27, 11.69) &&
      is(boxes['Legal Portrait'], 8.5, 14) &&
      is(boxes['A5 Landscape'], 8.27, 5.83) &&
      is(boxes['Letter Landscape'], 8.5, 11) &&
      is(boxes['Whole glass'], 8.5, 14),
    'each paper size shows its box at the glass corner (landscape Letter lies upright: it doesn’t fit across)',
    fmt(boxes)
  );
  await choose(page, 'Paper size', 'Letter');
  await choose(page, 'Orientation', 'Portrait');
  await shot('paper-letter-empty-glass');
  await press(page, 'Preview');
  await L.waitIdle(page);
  await lookShows({ color: 'color' });
  check((await dialog(page))?.paper === 'Custom (from preview)', 'Preview found the paper: the size is Custom (from preview)');
  await shot('preview');
  // The whole glass fits the pane, at any window size
  const fits = [];
  for (const [w, h] of [
    [1280, 720],
    [1000, 640],
    [1600, 1000],
    [820, 600],
  ]) {
    await page.setViewport({ width: w, height: h });
    await sleep(600);
    fits.push(
      await page.evaluate(() => {
        const st = document.querySelector('.dlg-scan .sp-stage').getBoundingClientRect();
        const pane = document.querySelector('.dlg-scan .sp-glass').getBoundingClientRect();
        const se = document.querySelector('.dlg-scan .sp-se').getBoundingClientRect();
        return {
          inside: st.top >= pane.top - 1 && st.bottom <= pane.bottom + 1 && st.left >= pane.left - 1 && st.right <= pane.right + 1,
          aspect: Math.round((st.width / st.height) * 1000) / 1000,
          handle: se.bottom <= pane.bottom + 9 && se.top >= pane.top - 9,
          size: `${Math.round(st.width)}×${Math.round(st.height)}`,
        };
      })
    );
    if (w === 820) await shot('preview-small-window');
  }
  check(
    fits.every((f) => f.inside && f.handle && near(f.aspect, 8.5 / 14, 0.01)),
    'the whole glass (8.5 × 14 in) fits the pane at 1280×720, 1000×640, 1600×1000 and 820×600, the box’s corners on it',
    fmt(fits)
  );
  await page.setViewport(null);
  await sleep(600);
  // Live: color mode, threshold, brightness, contrast, invert
  const look = {};
  await choose(page, 'Color mode', 'Color');
  await lookShows({ color: 'color' });
  look.color = P.colorShare(await previewPixels());
  await choose(page, 'Color mode', 'Grayscale');
  await lookShows({ color: 'gray' });
  look.gray = P.colorShare(await previewPixels());
  await shot('live-grayscale');
  await choose(page, 'Color mode', 'Black and white');
  await L.setValue(page, 'Threshold', 128);
  await lookShows({ color: 'bw', threshold: 128 });
  let px = await previewPixels();
  look.bwGrey = P.greyShare(px);
  look.bwDark128 = P.darkShare(region(px, 1.5, 7.4, 5, 0.5));
  await shot('live-black-and-white');
  await L.setValue(page, 'Threshold', 210);
  await lookShows({ color: 'bw', threshold: 210 });
  look.bwDark210 = P.darkShare(region(await previewPixels(), 1.5, 7.4, 5, 0.5));
  await L.setValue(page, 'Threshold', 50);
  await lookShows({ color: 'bw', threshold: 50 });
  look.bwDark50 = P.darkShare(region(await previewPixels(), 1.5, 7.4, 5, 0.5));
  await choose(page, 'Color mode', 'Grayscale');
  await lookShows({ color: 'gray', brightness: 0 });
  const wedge0 = region(await previewPixels(), 1.5, 7.45, 5, 0.4);
  await L.setValue(page, 'Brightness', 50);
  await lookShows({ color: 'gray', brightness: 50 });
  look.brighter = P.meanLuma(region(await previewPixels(), 1.5, 7.45, 5, 0.4)) - P.meanLuma(wedge0);
  await L.setValue(page, 'Brightness', 0);
  await L.setValue(page, 'Contrast', 60);
  await lookShows({ color: 'gray', brightness: 0, contrast: 60 });
  look.contrast = P.stdLuma(region(await previewPixels(), 1.5, 7.45, 5, 0.4)) / P.stdLuma(wedge0);
  await L.setValue(page, 'Contrast', 0);
  await choose(page, 'Color mode', 'Autodetect');
  await lookShows({ color: 'auto', contrast: 0 });
  look.auto = P.colorShare(await previewPixels());
  check(look.color > 0.003 && look.gray < 0.0005 && look.auto > 0.003, 'live: Grayscale takes the color out of the preview; Color and Autodetect show it', fmt(look));
  check(look.bwGrey < 0.01, 'live: Black and white shows only black and white', fmt(look.bwGrey));
  check(look.bwDark50 < look.bwDark128 && look.bwDark128 < look.bwDark210, 'live: a higher threshold makes more of the grey wedge black', fmt(look));
  check(look.brighter > 20 && look.contrast > 1.1, 'live: brightness and contrast change the preview the right way', fmt(look));
  // Invert (Options) with black and white
  await choose(page, 'Color mode', 'Black and white');
  await L.setValue(page, 'Threshold', 128);
  await click(page, '.dlg-scan .sd-link', 'Options…');
  await until(page, () => document.querySelector('[aria-label="Scanner options"]'));
  await L.tick(page, 'Invert black and white images', true, '[aria-label="Scanner options"]');
  await click(page, '[aria-label="Scanner options"] .accent-btn', 'OK');
  await lookShows({ color: 'bw', invert: true });
  look.inverted = P.darkShare(await previewPixels());
  check(look.inverted > 0.6, 'live: Invert black and white images shows the negative', fmt(look.inverted));
  await click(page, '.dlg-scan .sd-link', 'Options…');
  await until(page, () => document.querySelector('[aria-label="Scanner options"]'));
  await L.tick(page, 'Invert black and white images', false, '[aria-label="Scanner options"]');
  await click(page, '[aria-label="Scanner options"] .accent-btn', 'OK');
  await choose(page, 'Color mode', 'Color');
  // Keyboard: the corners move with the arrow keys (0.1 in, Shift 0.5 in)
  const before = await boxNow();
  await page.focus('.dlg-scan .sp-nw');
  for (let k = 0; k < 3; k++) await page.keyboard.press('ArrowRight');
  await page.keyboard.down('Shift');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.up('Shift');
  const after = await boxNow();
  check(near(after.x - before.x, 0.3, 0.02) && near(after.y - before.y, 0.5, 0.02), 'keyboard: arrow keys move a corner by 0.1 in, Shift+arrow by 0.5 in', `${fmt(before)} -> ${fmt(after)}`);
  // Screen reader basics
  const a11y = await page.evaluate(() => {
    const d = document.querySelector('.dlg-scan');
    return {
      dialog: d.getAttribute('role') === 'dialog' && !!d.getAttribute('aria-label'),
      status: d.querySelector('.sd-status')?.getAttribute('role'),
      tabs: [...d.querySelectorAll('.sd-tabs [role="tab"]')].map((t) => `${t.textContent}:${t.getAttribute('aria-selected')}`),
      handles: [...d.querySelectorAll('.sp-handle')].map((h) => h.getAttribute('aria-label')),
      glass: d.querySelector('.sp-glass')?.getAttribute('aria-label'),
      unlabelled: [...d.querySelectorAll('select, input')].filter((e) => !e.closest('[hidden]') && !e.getAttribute('aria-label')).length,
    };
  });
  check(
    a11y.dialog && a11y.status === 'status' && a11y.tabs.length === 2 && a11y.handles.length === 4 && a11y.handles.every(Boolean) && a11y.unlabelled === 0,
    'screen readers: a named dialog, a status line, tabs, named corners, every control labelled',
    fmt(a11y)
  );
  // Preview between passes, and the next pass uses its box
  await pass();
  let d = await dialog(page);
  check(d.buttons.includes('Preview') && d.buttons.includes('Scan more pages'), 'after a pass, Preview is still there (put the next page on the glass, preview it)', fmt(d.buttons));
  await shot('after-pass-actions');
  await click(page, '.dlg-scan .sd-tabs .pd-seg-btn', 'Preview');
  await press(page, 'Preview');
  await L.waitIdle(page);
  await dragCorner('nw', 1.2, 2.0);
  await dragCorner('se', 4.2, 4.0);
  const b2 = await boxNow();
  await pass('Scan more pages');
  const bytes = await complete(2);
  const facts = await P.pdfFacts(bytes);
  check(near(facts[1].width, b2.width * 72, 2.5) && near(facts[1].height, b2.height * 72, 2.5), 'the page scanned after previewing between passes is the new box', `${fmt(facts[1])} for ${fmt(b2)}`);
  // A feeder can't preview: why, and what to do
  await open();
  await prep({ source: 'Document feeder', keepClean: true });
  await click(page, '.dlg-scan .sd-tabs .pd-seg-btn', 'Preview');
  const feeder = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.dlg-scan .dlg-actions button')].find((x) => x.textContent === 'Preview');
    return { shown: !!b && !b.hidden, disabled: b?.disabled, title: b?.title || b?.dataset.tip, pane: document.querySelector('.dlg-scan .sp-message')?.textContent };
  });
  check(
    feeder.shown && feeder.disabled && /choose Flatbed/i.test(feeder.title) && /A document feeder can't preview pages\. To preview, put the page on the glass and choose Flatbed\./.test(feeder.pane),
    'Document feeder: Preview is unavailable, and the preview pane says why and what to do',
    fmt(feeder)
  );
  await shot('feeder-preview-message');
  await choose(page, 'Scanner', 'Paperwing Test Feeder');
  await L.waitReady(page);
  const only = await page.evaluate(() => ({
    button: [...document.querySelectorAll('.dlg-scan .dlg-actions button')].some((x) => x.textContent === 'Preview' && !x.hidden),
    pane: document.querySelector('.dlg-scan .sp-message')?.textContent,
  }));
  check(!only.button && /only a document feeder/.test(only.pane ?? ''), 'a scanner with only a feeder: no Preview, and the pane says so', fmt(only));
  // The network flatbed previews (its glass 8.5 × 11.69 in)
  await choose(page, 'Scanner', 'Paperwing Network Scanner');
  await L.waitReady(page);
  await press(page, 'Preview');
  await L.waitIdle(page);
  const net = await page.evaluate(() => {
    const st = document.querySelector('.dlg-scan .sp-stage').getBoundingClientRect();
    return { aspect: st.width / st.height, image: !document.querySelector('.dlg-scan .sp-image').hidden };
  });
  check(net.image && near(net.aspect, 8.5 / 11.69, 0.01), 'the network scanner previews its own glass', fmt(net));
  await press(page, 'Cancel');
  await app.close();
}

/* 3. Paper sizes and color modes: the pages they make ------------------------ */
if (part(3)) {
  await launch();
  await open();
  await prep({ source: 'Flatbed', color: 'Color', dpi: '100 dpi' });
  const papers = [
    ['Letter', 'Portrait', 612, 792],
    ['A4', 'Portrait', 595.4, 841.7],
    ['Legal', 'Portrait', 612, 1008],
    ['A5', 'Landscape', 595.4, 419.8],
    ['Letter', 'Landscape', 792, 612],
  ];
  for (const [k, [paper, orient]] of papers.entries()) {
    await choose(page, 'Paper size', paper);
    await choose(page, 'Orientation', orient);
    await pass(k ? 'Scan more pages' : 'Scan');
  }
  await choose(page, 'Paper size', 'Custom size');
  await choose(page, 'Units', 'in');
  await L.setValue(page, 'Width', 5);
  await L.setValue(page, 'Height', 4);
  await pass('Scan more pages');
  await choose(page, 'Units', 'mm');
  await L.setValue(page, 'Width', 127);
  await L.setValue(page, 'Height', 102);
  await pass('Scan more pages');
  const bytes = await complete(7);
  const facts = await P.pdfFacts(bytes);
  const want = [...papers.map((p) => [p[2], p[3]]), [360, 288], [360, 289.1]];
  check(
    facts.length === 7 && facts.every((f, k) => near(f.width, want[k][0], 1.5) && near(f.height, want[k][1], 1.5)),
    'page sizes: Letter 612×792, A4 595×842, Legal 612×1008, A5 landscape 595×420, Letter landscape 792×612, custom 5×4 in, 127×102 mm',
    facts.map((f) => `${f.width}×${f.height}`).join(', ')
  );
  const pg = async (n) => P.renderPage(bytes, n, 100);
  const corner = { x: 0, y: 0 };
  const letter = markersIn(await pg(0), corner, ['orange', 'brown', 'magenta', 'pink']);
  const a4 = markersIn(await pg(1), corner, ['brown', 'magenta', 'pink']);
  const legal = markersIn(await pg(2), corner, ['pink', 'green', 'blue']);
  const a5 = markersIn(await pg(3), corner, ['orange', 'teal', 'yellow']);
  check(
    letter.orange < 4 && letter.brown < 4 && letter.magenta === null && letter.pink === null,
    'Letter: the top 11 in of the glass, from its corner (the squares below 11 in left out)',
    fmt(letter)
  );
  check(a4.brown < 4 && a4.magenta < 4 && a4.pink === null, 'A4: down to 11.69 in', fmt(a4));
  check(legal.pink < 4 && legal.green < 4 && legal.blue < 4, 'Legal: the whole 14 in', fmt(legal));
  check(a5.orange < 4 && a5.teal < 4 && a5.yellow === null, 'A5 landscape: 8.27 across, 5.83 down', fmt(a5));
  // Letter landscape: scanned upright, turned a quarter to the left
  const land = await pg(4);
  const orange = P.findMarker(land, 'orange', 40);
  const red = P.findMarker(land, 'red', 40);
  check(
    !!orange && near(orange.x, 2.4 * 100, 5) && near(orange.y, (8.5 - 1.7) * 100, 5) && !!red && near(red.x, 1.55 * 100, 5) && near(red.y, (8.5 - 6.65) * 100, 5),
    'Letter landscape: the upright scan is turned to lie across (the chart’s top on the left)',
    fmt({ orange, red })
  );
  const custom = markersIn(await pg(5), corner, ['orange', 'cyan', 'teal']);
  check(custom.orange < 4 && custom.cyan === null && custom.teal === null, 'custom 5 × 4 in: just that, from the corner', fmt(custom));

  // Color modes, one pass each
  await open();
  await prep({ source: 'Flatbed', paper: 'Letter', orientation: 'Portrait', dpi: '100 dpi' });
  for (const [k, mode] of ['Color', 'Grayscale', 'Black and white', 'Autodetect'].entries()) {
    await choose(page, 'Color mode', mode);
    if (mode === 'Black and white') await L.setValue(page, 'Threshold', 128);
    await pass(k ? 'Scan more pages' : 'Scan');
  }
  const cb = await complete(4);
  const cf = await P.pdfFacts(cb);
  const imgs = await Promise.all([0, 1, 2, 3].map((n) => P.renderPage(cb, n, 100)));
  const [c, g, bw, auto] = cf.map((f) => f.images[0]);
  check(c.colorSpace === 'DeviceRGB' && c.bpc === 8 && P.colorShare(imgs[0]) > 0.003, 'Color: an 8-bit RGB image, with the chart’s colors', fmt({ ...c, color: P.colorShare(imgs[0]) }));
  check(g.colorSpace === 'DeviceGray' && g.bpc === 8 && P.colorShare(imgs[1]) < 0.0005, 'Grayscale: an 8-bit gray image, no color', fmt({ ...g, color: P.colorShare(imgs[1]) }));
  check(bw.bpc === 1 && bw.filter === 'CCITTFaxDecode' && P.greyShare(imgs[2]) < 0.05, 'Black and white: a 1-bit image, CCITT Group 4 (lossless)', fmt({ ...bw, grey: P.greyShare(imgs[2]) }));
  check(auto.colorSpace === 'DeviceRGB', 'Autodetect: the chart has color, so color', fmt(auto));
  await app.close();
}

/* 4. Resolution ---------------------------------------------------------------- */
if (part(4)) {
  await launch({ PAPERWING_SCAN_TEST_MAX_DPI: '1200' });
  await open();
  await prep({ source: 'Flatbed', color: 'Grayscale', paper: 'Letter', orientation: 'Portrait' });
  for (const [k, dpi] of [75, 150, 300].entries()) {
    await choose(page, 'Resolution', `${dpi} dpi`);
    await pass(k ? 'Scan more pages' : 'Scan', 120000);
  }
  const facts = await P.pdfFacts(await complete(3, 120000));
  const dims = facts.map((f) => `${f.images[0].width}×${f.images[0].height}`);
  check(dims.join() === '638×825,1275×1650,2550×3300', 'resolution: a Letter page has 8.5 × 11 in × the dpi pixels (75, 150, 300 dpi)', dims.join());
  // (8.5 in at 75 dpi is 637.5 pixels: 638, half a point over)
  check(facts.every((f) => near(f.width, 612, 0.6) && near(f.height, 792, 0.6)), 'and the page stays Letter size', facts.map((f) => `${f.width}×${f.height}`).join());
  // A resolution typed in (the feeder takes 100-600 dpi in 50s)
  await open('Paperwing Test Feeder');
  await prep({ color: 'Grayscale', paper: 'Letter' });
  await choose(page, 'Resolution', 'Custom…');
  await L.setValue(page, 'Custom resolution (dpi)', 250);
  await pass('Scan', 120000);
  const ff = await P.pdfFacts(await complete(3, 120000));
  check(ff[0].images[0].width === 2125 && ff[0].images[0].height === 2750, 'a custom resolution (250 dpi): 2125 × 2750 pixels', fmt(ff[0].images[0]));
  await app.close();
}

/* 5. Brightness, contrast, threshold: measured on the pages ------------------- */
if (part(5)) {
  await launch();
  await open();
  await prep({ source: 'Flatbed', color: 'Grayscale', paper: 'Letter', orientation: 'Portrait', dpi: '100 dpi', brightness: 0, contrast: 0 });
  const runs = [
    [0, 0],
    [50, 0],
    [-50, 0],
    [0, 60],
    [0, -60],
  ];
  for (const [k, [b, c]] of runs.entries()) {
    await L.setValue(page, 'Brightness', b);
    await L.setValue(page, 'Contrast', c);
    await pass(k ? 'Scan more pages' : 'Scan');
  }
  await L.setValue(page, 'Brightness', 0);
  await L.setValue(page, 'Contrast', 0);
  const bytes = await complete(5);
  const m = [];
  for (let n = 0; n < 5; n++) {
    const img = await P.renderPage(bytes, n, 100);
    m.push({ mid: P.meanLuma(region(img, 3.55, 7.5, 0.4, 0.3)), spread: P.stdLuma(region(img, 1.5, 7.45, 5, 0.4)) });
  }
  check(m[1].mid > m[0].mid + 25 && m[2].mid < m[0].mid - 25, 'brightness +50 / −50: the grey wedge’s middle step lighter / darker', fmt(m.slice(0, 3)));
  check(m[3].spread > m[0].spread * 1.1 && m[4].spread < m[0].spread * 0.8, 'contrast +60 / −60: the wedge’s steps further apart / closer', fmt([m[0], m[3], m[4]]));
  await open();
  await prep({ source: 'Flatbed', color: 'Black and white', paper: 'Letter', dpi: '100 dpi' });
  for (const [k, t] of [50, 128, 210].entries()) {
    await L.setValue(page, 'Threshold', t);
    await pass(k ? 'Scan more pages' : 'Scan');
  }
  await L.setValue(page, 'Threshold', 128);
  const tb = await complete(3);
  const steps = [];
  for (let n = 0; n < 3; n++) {
    const img = await P.renderPage(tb, n, 100);
    let black = 0;
    for (let s = 0; s < 10; s++) if (P.meanLuma(region(img, 1.6 + s * 0.5, 7.5, 0.3, 0.3)) < 128) black++;
    steps.push(black);
  }
  check(steps[0] < steps[1] && steps[1] < steps[2] && steps[0] >= 2 && steps[2] <= 9, 'threshold 50 / 128 / 210: more of the 10 wedge steps black each time', steps.join(' / '));
  await app.close();
}

/* 6. Scan reverse sides, Flip back sides: the pages' order ------------------ */
if (part(6)) {
  await launch({ PAPERWING_SCAN_TEST_STACK: 'turn', PAPERWING_SCAN_TEST_TOP_BOUND: '1', PAPERWING_SCAN_TEST_BLANK: 'none', PAPERWING_SCAN_TEST_SKEW: 'none' });
  const labels = async (bytes, n) => {
    const out = [];
    for (let k = 0; k < n; k++) out.push(P.labelText(P.readLabel(await P.renderPage(bytes, k, 50))));
    return out;
  };
  // A one-sided pass of fronts: Scan reverse sides is offered and explained
  await open();
  await prep({ source: 'Document feeder', sides: 'Front sides', color: 'Autodetect', paper: 'Letter', dpi: '150 dpi' });
  await pass();
  let d = await dialog(page);
  const title = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.dlg-scan .dlg-actions button')].find((b) => b.textContent === 'Scan reverse sides');
    return b && (b.title || b.dataset.tip);
  });
  check(
    d.buttons.includes('Scan reverse sides') && /Printed on both sides\? Turn the stack over/.test(d.status) && /turn the scanned stack over/i.test(title ?? ''),
    'after a one-sided pass: Scan reverse sides, and what it’s for',
    `${d.status} | ${title}`
  );
  await shot('reverse-sides-offered');
  await pass('Scan reverse sides');
  let bytes = await complete(6);
  let got = await labels(bytes, 6);
  check(got.join() === '1F,1B↓,2F,2B↓,3F,3B↓', 'Scan reverse sides: pages in reading order (sheet 1 front, back, sheet 2…); top-bound backs upside down without Flip', got.join());
  const facts = await P.pdfFacts(bytes);
  const colors = await Promise.all([0, 1, 2, 3, 4, 5].map(async (k) => P.colorShare(await P.renderPage(bytes, k, 50)) > 0.001));
  check(
    facts.every((f, k) => (f.images[0].colorSpace === 'DeviceRGB') === colors[k]) && colors.some(Boolean) && colors.some((x) => !x),
    'Autodetect: pages with the blue band in color, the black-and-grey ones not',
    facts.map((f, k) => `${f.images[0].colorSpace}/${f.images[0].bpc}${colors[k] ? ' (color)' : ''}`).join(', ')
  );
  // Both sides on a one-sided feeder, flipped backs: asked to turn the stack
  await open('Paperwing Test Feeder');
  await prep({ sides: 'Both sides', color: 'Grayscale', paper: 'Letter', flip: true });
  await pass();
  d = await dialog(page);
  check(/Turn the stack over, put it back in the feeder, then select Scan reverse sides/.test(d.status) && d.first === 'Scan reverse sides', 'Both sides on a one-sided feeder: it asks for the stack turned over', d.status);
  await pass('Scan reverse sides');
  const inOrder = (got) => {
    const s = parseInt(got[0], 10);
    return got.join() === [s, s, s + 1, s + 1, s + 2, s + 2].map((n, k) => `${n}${k % 2 ? 'B' : 'F'}`).join();
  };
  got = await labels(await complete(6), 6);
  check(inOrder(got), 'with Flip back sides: in order and every page upright', got.join());
  // A two-sided feeder, flipped backs
  await open();
  await prep({ source: 'Document feeder', sides: 'Both sides', color: 'Grayscale', paper: 'Letter', flip: true });
  await pass();
  got = await labels(await complete(6), 6);
  check(inOrder(got), 'both sides at once, flipped backs: in order, upright', got.join());
  await app.close();
}

/* 7. Clean-up, measured ---------------------------------------------------------- */
if (part(7)) {
  await launch({ PAPERWING_SCAN_TEST_SKEW: '2,5', PAPERWING_SCAN_TEST_UPSIDE_DOWN: '3' });
  await open('Paperwing Test Feeder');
  await prep({ color: 'Grayscale', paper: 'Letter', clean: { deskew: false } });
  await pass();
  await prep({ keepClean: false, clean: { deskew: true, autoRotate: true } });
  await pass('Scan more pages', 120000);
  await prep({ clean: { rotate: '90° clockwise' } });
  await pass('Scan more pages');
  let bytes = await complete(9, 120000);
  const at = (n, dpi = 100) => P.renderPage(bytes, n, dpi);
  const off = P.bandSlope(await at(1));
  const on = P.bandSlope(await at(4));
  check(near(Math.abs(off), 3, 0.6) && Math.abs(on) < 0.4, 'Deskew: a page fed 3° crooked comes out straight (off: still crooked)', `off ${off?.toFixed(2)}°, on ${on?.toFixed(2)}°`);
  const upOff = P.readLabel(await at(2, 50));
  const upOn = P.readLabel(await at(5, 50));
  check(upOff?.upsideDown === true && upOn && !upOn.upsideDown, 'Auto-rotate: a page fed upside down comes out upright (off: upside down)', `${P.labelText(upOff)} / ${P.labelText(upOn)}`);
  const facts = await P.pdfFacts(bytes);
  const turned = await at(6);
  const bandRight = P.meanLuma(region(turned, 11 - 0.75, 2, 0.2, 4));
  check(facts[6].width === 792 && facts[6].height === 612 && bandRight < 120, 'Rotate all pages 90° clockwise: landscape pages, the top now on the right', `${facts[6].width}×${facts[6].height}, right edge ${bandRight.toFixed(0)}`);
  await app.close();

  await launch({ PAPERWING_SCAN_TEST_EDGE_SHADOW: '1' });
  await open('Paperwing Test Feeder');
  await prep({ color: 'Grayscale', paper: 'Letter' });
  await pass();
  await prep({ clean: { edgeShadow: true } });
  await pass('Scan more pages');
  bytes = await complete(6);
  const edge = async (n) => P.meanLuma(region(await P.renderPage(bytes, n, 100), 0.03, 1, 0.12, 8));
  const eOff = await edge(0);
  const eOn = await edge(3);
  check(eOff < 100 && eOn > 200, 'Remove edge shadows: the dark band along the edge becomes paper', `off ${eOff.toFixed(0)}, on ${eOn.toFixed(0)}`);
  await app.close();

  // The chart: descreen, sharpening, despeckle, background, auto-crop
  await launch({ PAPERWING_SCAN_TEST_MAX_DPI: '300' });
  await open();
  await prep({ source: 'Flatbed', color: 'Grayscale', paper: 'Letter', orientation: 'Portrait', dpi: '100 dpi', brightness: 0 });
  await L.openGroup(page, 'File size');
  await choose(page, 'Color and grayscale compression', 'ZIP (lossless)');
  // (dust is checked at 300 dpi: at 100 its specks are a pixel or none)
  const passes = [
    {},
    { descreen: true },
    { sharpen: 'High' },
    { dpi: '300 dpi' },
    { despeckle: true, dpi: '300 dpi' },
    { background: 'High', brightness: -40 },
    { brightness: -40 },
  ];
  for (const [k, p] of passes.entries()) {
    const { brightness = 0, dpi = '100 dpi', ...clean } = p;
    await L.setValue(page, 'Brightness', brightness);
    await choose(page, 'Resolution', dpi);
    await prep({ clean });
    await pass(k ? 'Scan more pages' : 'Scan');
  }
  await L.setValue(page, 'Brightness', 0);
  await choose(page, 'Resolution', '100 dpi');
  await choose(page, 'Paper size', 'Whole glass');
  await prep({ clean: { autoCrop: true } });
  await pass('Scan more pages');
  bytes = await complete(8);
  const img = await Promise.all([0, 1, 2, 3, 4, 5, 6].map((n) => P.renderPage(bytes, n, n === 3 || n === 4 ? 300 : 100)));
  const H = standIn.HALFTONE;
  const dots = img.map((i) => P.stdLuma(region(i, H.x + 0.1, H.y + 0.1, H.width - 0.2, H.height - 0.2)));
  check(dots[1] < dots[0] * 0.5, 'Descreen: a printed photo’s dot pattern smoothed away', `spread ${dots[0].toFixed(0)} -> ${dots[1].toFixed(0)}`);
  const text = img.map((i) => P.edgeStrength(region(i, 1.5, 3.15, 3.5, 0.35)));
  check(text[2] > text[0] * 1.05, 'Text sharpening: crisper edges on the text', `edges ${text[0].toFixed(1)} -> ${text[2].toFixed(1)}`);
  const D = standIn.DUST;
  // (at 300 dpi a speck is up to about 7 pixels, a full stop about 18)
  const dust = [3, 4].map((n) => P.blobSizes(region(img[n], D.x + 0.05, D.y + 0.05, D.width - 0.1, D.height - 0.1), 170));
  const small = dust.map((s) => s.filter((a) => a < 11).length);
  const stops = dust.map((s) => s.filter((a) => a >= 11).length);
  check(
    small[0] >= 30 && small[1] <= small[0] * 0.1 && stops[0] === 6 && stops[1] === 6,
    'Despeckle: dust removed; dots the size of a full stop kept',
    `specks ${small[0]} -> ${small[1]}, full stops ${stops[0]} -> ${stops[1]}`
  );
  const paperOf = (i) => P.meanLuma(region(i, 2.15, 9.15, 0.7, 0.7));
  const wedgeBlack = (i) => P.meanLuma(region(i, 6.1, 7.5, 0.3, 0.3));
  check(
    paperOf(img[6]) < 225 && paperOf(img[5]) > 240 && wedgeBlack(img[5]) < 60,
    'Background removal: greyish paper made white, black kept black',
    `paper ${paperOf(img[6]).toFixed(0)} -> ${paperOf(img[5]).toFixed(0)}, black ${wedgeBlack(img[5]).toFixed(0)}`
  );
  const cropFacts = (await P.pdfFacts(bytes))[7];
  check(near(cropFacts.width, 432, 25) && near(cropFacts.height, 864, 25), 'Auto-crop: the whole glass cut to the sheet of paper (6 × 12 in)', `${cropFacts.width}×${cropFacts.height}`);
  await app.close();

  // Remove blank pages (and Keep)
  await launch({ PAPERWING_SCAN_TEST_SKEW: 'none' });
  await open();
  await prep({ source: 'Document feeder', sides: 'Both sides', color: 'Grayscale', paper: 'Letter', clean: { removeBlank: true } });
  await pass();
  let d = await dialog(page);
  check(d.thumbs === 6 && d.leftOut === 1, 'Remove blank pages: the blank page is marked left out', `${d.thumbs} / ${d.leftOut}`);
  bytes = await complete(5);
  const left = [];
  for (let k = 0; k < 5; k++) left.push(P.labelText(P.readLabel(await P.renderPage(bytes, k, 50))));
  check(left.join() === '1F,1B,2F,3F,3B', 'and the PDF has the other five, in order', left.join());
  await open();
  await prep({ source: 'Document feeder', sides: 'Both sides', color: 'Grayscale', paper: 'Letter', clean: { removeBlank: true } });
  await pass();
  await click(page, '.dlg-scan .sr-keep');
  bytes = await complete(6);
  const kept = P.readLabel(await P.renderPage(bytes, 3, 50));
  check(kept === null, 'Keep: the blank page goes in after all', P.labelText(kept));
  await app.close();
}

/* 8. File size and compression ---------------------------------------------- */
// (each page is kept lossless while it's reviewed and encoded when the PDF
// is made, with the settings then: one document per setting)
if (part(8)) {
  await launch();
  const made = [];
  for (const [q, comp] of [
    [0, 'JPEG (smaller)'],
    [1, 'JPEG (smaller)'],
    [0.6, 'ZIP (lossless)'],
  ]) {
    await open();
    await prep({ source: 'Flatbed', color: 'Color', paper: 'Letter', orientation: 'Portrait', dpi: '100 dpi', keepClean: true });
    await pass();
    await choose(page, 'Color mode', 'Black and white');
    await pass('Scan more pages');
    await choose(page, 'Color mode', 'Color');
    await L.openGroup(page, 'File size');
    await L.setValue(page, 'File size and quality', q);
    await choose(page, 'Color and grayscale compression', comp);
    const bytes = await complete(2);
    made.push({ bytes, f: (await P.pdfFacts(bytes)).map((x) => x.images[0]) });
  }
  await open();
  await L.openGroup(page, 'File size');
  await L.setValue(page, 'File size and quality', 0.6);
  await choose(page, 'Color and grayscale compression', 'JPEG (smaller)');
  await press(page, 'Cancel');
  const [small, high, zip] = made;
  check(
    small.f[0].filter === 'DCTDecode' && high.f[0].filter === 'DCTDecode' && small.f[0].bytes < high.f[0].bytes * 0.6,
    'the file size slider: a smaller JPEG at Small size, a bigger one at High quality',
    `${small.f[0].bytes} vs ${high.f[0].bytes} bytes`
  );
  const lossless = P.likeness(await P.renderPage(zip.bytes, 0, 100), await P.renderPage(high.bytes, 0, 100));
  check(zip.f[0].filter === 'FlateDecode' && lossless > 0.99, 'ZIP: lossless (Flate)', `${fmt(zip.f[0])} likeness ${lossless.toFixed(3)}`);
  const bw0 = await P.renderPage(small.bytes, 1, 100);
  const bw1 = await P.renderPage(high.bytes, 1, 100);
  check(
    small.f[1].filter === 'CCITTFaxDecode' && small.f[1].bytes === high.f[1].bytes && P.likeness(bw0, bw1) > 0.999,
    'black and white: CCITT G4 whatever the slider (lossless: the same)',
    `${small.f[1].bytes} / ${high.f[1].bytes}`
  );
  await app.close();
}

/* 9. Presets and Options ---------------------------------------------------------- */
if (part(9)) {
  const log = join(work, 'log-options.jsonl');
  writeFileSync(log, '');
  await launch({ PAPERWING_SCAN_TEST_LOG: log, PAPERWING_SCAN_TEST_MAX_DPI: '1200' });
  await open();
  await prep({ source: 'Flatbed', paper: 'Business card', keepClean: true });
  const presets = ['Black and white document', 'Grayscale document', 'Color document', 'Color photograph', 'Autodetect color mode'];
  const ui = [];
  for (const [k, p] of presets.entries()) {
    await choose(page, 'Preset', p);
    ui.push(
      await page.evaluate(() => {
        const v = (l) => {
          const s = document.querySelector(`.dlg-scan select[aria-label="${l}"]`);
          return s?.options[s.selectedIndex]?.textContent;
        };
        const c = (l) => document.querySelector(`.dlg-scan input[aria-label="${l}"]`)?.checked;
        return {
          color: v('Color mode'),
          dpi: v('Resolution'),
          despeckle: c('Despeckle (remove stray dots)'),
          background: v('Background removal'),
          deskew: c('Deskew (straighten crooked pages)'),
          quality: document.querySelector('.dlg-scan input[aria-label="File size and quality"]').value,
        };
      })
    );
    await pass(k ? 'Scan more pages' : 'Scan', 120000);
  }
  const pf = (await P.pdfFacts(await complete(5, 120000))).map((p) => p.images[0]);
  check(ui[0].color === 'Black and white' && ui[0].despeckle && pf[0].bpc === 1 && pf[0].filter === 'CCITTFaxDecode' && pf[0].width === 1050, 'preset Black and white document: 1-bit CCITT at 300 dpi, despeckle on', `${fmt(ui[0])} ${fmt(pf[0])}`);
  check(ui[1].background === 'Low' && pf[1].colorSpace === 'DeviceGray' && pf[1].width === 1050, 'preset Grayscale document: gray at 300 dpi, background removal Low', `${fmt(ui[1])} ${fmt(pf[1])}`);
  check(pf[2].colorSpace === 'DeviceRGB' && pf[2].filter === 'DCTDecode' && pf[2].width === 1050, 'preset Color document: color JPEG at 300 dpi', fmt(pf[2]));
  check(ui[3].dpi === '600 dpi' && !ui[3].deskew && ui[3].quality === '0.9' && pf[3].colorSpace === 'DeviceRGB' && pf[3].width === 2100, 'preset Color photograph: color at 600 dpi, high quality, no deskew', `${fmt(ui[3])} ${fmt(pf[3])}`);
  check(ui[4].color === 'Autodetect', 'preset Autodetect color mode', fmt(ui[4]));
  // Save as preset: its settings come back, and are used
  await open();
  await prep({ preset: 'My settings', color: 'Black and white', dpi: '150 dpi', keepClean: true });
  await click(page, '.dlg-scan .sd-link', 'Save as preset');
  await until(page, () => document.querySelector('[aria-label="Save as preset"]'));
  await page.type('[aria-label="Preset name"]', 'Receipts QA');
  await click(page, '[aria-label="Save as preset"] .accent-btn', 'Save');
  await choose(page, 'Preset', 'Color document');
  await choose(page, 'Preset', 'Receipts QA');
  const back = await dialog(page);
  await pass('Scan', 120000);
  const rf = (await P.pdfFacts(await complete(1)))[0].images[0];
  check(/Black and white, .*150 dpi/.test(back.summary) && rf.bpc === 1 && rf.width === 525, 'Save as preset: chosen again, its settings come back and are used', `${back.summary} ${fmt(rf)}`);
  // Options: the driver used, the scanner's own window, transfer, invert
  const setOpts = async (fn) => {
    await click(page, '.dlg-scan .sd-link', 'Options…');
    await until(page, () => document.querySelector('[aria-label="Scanner options"]'));
    await fn('[aria-label="Scanner options"]');
    await click(page, '[aria-label="Scanner options"] .accent-btn', 'OK');
    await L.waitReady(page);
  };
  await open();
  await prep({ preset: 'My settings', source: 'Flatbed', color: 'Grayscale', paper: 'Business card', dpi: '100 dpi', keepClean: true });
  const win = process.platform === 'win32';
  const drivers = win ? ['WIA', 'Network (eSCL)', 'TWAIN'] : ['Image Capture', 'Network (eSCL)'];
  const used = [];
  for (const [k, drv] of drivers.entries()) {
    await setOpts((o) => choose(page, 'Driver', drv, o));
    await prep({ source: 'Flatbed', keepClean: true });
    await pass(k ? 'Scan more pages' : 'Scan');
    used.push(requests(log).filter((r) => r.command === 'scan').at(-1)?.driver);
  }
  check(
    JSON.stringify(used) === JSON.stringify(win ? ['wia', 'escl', 'twain'] : ['ica', 'escl']),
    'Options ▸ Driver: each scan goes through the driver chosen',
    fmt(used)
  );
  if (win) {
    await setOpts(async (o) => {
      await L.tick(page, 'Show the scanner’s own window', true, o);
      await choose(page, 'Transfer method', 'Memory', o);
    });
    await pass('Scan more pages');
    const last = requests(log).filter((r) => r.command === 'scan').at(-1)?.options;
    check(last?.nativeUi === true && last.transfer === 'memory', "Options: the scanner's own window and the transfer method reach the scanner", fmt(last));
    await setOpts(async (o) => {
      await L.tick(page, 'Show the scanner’s own window', false, o);
      await choose(page, 'Transfer method', 'Native', o);
    });
  }
  await choose(page, 'Color mode', 'Black and white');
  await pass('Scan more pages');
  const bwAsked = requests(log).filter((r) => r.command === 'scan').at(-1)?.options;
  await setOpts((o) => L.tick(page, 'Invert black and white images', true, o));
  await pass('Scan more pages');
  await setOpts((o) => L.tick(page, 'Invert black and white images', false, o));
  const n = (await dialog(page)).thumbs;
  const ob = await complete(n);
  const normal = P.darkShare(await P.renderPage(ob, n - 2, 100));
  const inverted = P.darkShare(await P.renderPage(ob, n - 1, 100));
  check(bwAsked?.color === 'gray' && bwAsked.threshold === undefined, 'black and white is scanned in gray and made black and white here (as the preview shows it)', fmt(bwAsked));
  check(normal < 0.3 && inverted > 0.7, 'Options ▸ Invert black and white images: the page comes out as a negative', `dark ${normal.toFixed(2)} -> ${inverted.toFixed(2)}`);
  await app.close();
}

/* 10. The review strip's changes, in the PDF -------------------------------- */
if (part(10)) {
  await launch({ PAPERWING_SCAN_TEST_SKEW: 'none' });
  await open('Paperwing Test Feeder');
  await prep({ color: 'Grayscale', paper: 'Letter' });
  await pass();
  await pass('Scan more pages');
  const ids = () => page.evaluate(() => [...document.querySelectorAll('.dlg-scan .sr-page')].map((p) => p.dataset.id));
  // rotate page 1, delete page 2, drag page 1 after page 3, rescan page 2
  await page.hover('.dlg-scan .sr-page');
  await click(page, '.dlg-scan .sr-tool', 'Rotate page 1 clockwise');
  await page.hover('.dlg-scan .sr-page:nth-child(2)');
  await click(page, '.dlg-scan .sr-tool', 'Delete page 2');
  const now = await ids();
  const pos = await page.evaluate(() =>
    [...document.querySelectorAll('.dlg-scan .sr-page')].map((p) => {
      const r = p.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })
  );
  await page.mouse.move(pos[0].x, pos[0].y);
  await page.mouse.down();
  await page.mouse.move(pos[2].x + 30, pos[2].y, { steps: 10 });
  await page.mouse.up();
  const moved = await ids();
  await page.hover('.dlg-scan .sr-page:nth-child(2)');
  await click(page, '.dlg-scan .sr-tool', 'Rescan page 2');
  await L.waitIdle(page);
  const bytes = await complete(5);
  const facts = await P.pdfFacts(bytes);
  const got = [];
  for (let k = 0; k < 5; k++) got.push(facts[k].rotation ? `turned ${facts[k].rotation}` : P.labelText(P.readLabel(await P.renderPage(bytes, k, 50))));
  check(
    moved[2] === now[0] && got.join() === '3F,7F,turned 90,5F,6F',
    'review strip: page 1 turned, page 2 deleted, page 1 dragged after page 3, page 2 rescanned: all as shown, in the PDF',
    got.join()
  );
  await app.close();
}

/* 11. Append to an open document: at the end; Ctrl+Z ------------------------- */
if (part(11)) {
  const fixture = join(work, 'Two pages.pdf');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 2; n++) doc.addPage([300, 400]).drawText(`Fixture ${n}`, { x: 40, y: 300, size: 24, font });
  writeFileSync(fixture, await doc.save());
  await launch();
  await app.openFile(fixture);
  await until(page, () => window.__acro.viewer.pageInfo(window.__acro.viewer.current)?.total === 2);
  await sleep(1000);
  await must(L.openDialog(page), 'the scan dialog opens');
  await prep({ scanner: 'Paperwing Test Feeder', color: 'Grayscale', paper: 'Letter', keepClean: true });
  await click(page, '.dlg-scan .pd-radio', 'Append to file');
  await pass();
  await press(page, 'Scan is complete');
  await until(page, () => window.__acro.viewer.pageInfo(window.__acro.viewer.current)?.total === 5, undefined, 30000);
  await sleep(800);
  const bytes = await P.docBytes(page);
  const facts = await P.pdfFacts(bytes);
  const got = [];
  for (let k = 2; k < 5; k++) got.push(P.labelText(P.readLabel(await P.renderPage(bytes, k, 50))));
  check(facts[0].width === 300 && facts[1].width === 300 && got.join() === '1F,2F,3F', 'Append: the document’s own pages first, the scanned ones after, in order', `${facts.map((f) => f.width).join()} ${got.join()}`);
  await L.undo(page);
  check(!!(await until(page, () => window.__acro.viewer.pageInfo(window.__acro.viewer.current)?.total === 2)), 'Ctrl+Z takes them out again');
  await app.close();
}

/* 12. Errors and stopping ---------------------------------------------------------- */
for (const [code, expect, what] of !part(12) ? [] : [
  ['feeder-empty', /feeder is empty/, 'an empty feeder'],
  ['cover-open', /cover is open/, 'the cover open'],
  ['busy', /scanner is busy/, 'a scanner busy with another app'],
  ['offline', /isn't responding/, 'a scanner that stopped answering'],
]) {
  await launch({ PAPERWING_SCAN_TEST_ERROR: code });
  await open();
  await prep({ source: 'Document feeder', keepClean: true });
  await pass();
  const d = await dialog(page);
  check(expect.test(d.status) && d.buttons.includes('Scan'), `${what}: what to do, and Scan again`, d.status);
  await app.close();
}
if (part(12)) {
  await launch({ PAPERWING_SCAN_TEST_PAGES: '12' });
  await open();
  await prep({ source: 'Document feeder', keepClean: true });
  await press(page, 'Scan');
  await until(page, () => document.querySelectorAll('.dlg-scan .sr-page').length >= 2);
  await page.keyboard.press('Escape');
  await L.waitIdle(page);
  let d = await dialog(page);
  check(!!d && /Scanning stopped/.test(d.status) && d.thumbs < 12, 'Esc while scanning stops the scan (the dialog stays, with the pages)', `${d?.thumbs}: ${d?.status}`);
  await page.keyboard.press('Escape');
  d = await dialog(page);
  check(!!d && d.buttons.some((b) => b.startsWith('Discard')), 'Esc again asks before discarding the pages', fmt(d?.buttons));
  await page.keyboard.press('Escape');
  check(!!(await until(page, () => !document.querySelector('.dlg-scan'))), 'and a third Esc discards them and closes');
  await app.close();
}

L.finish();
