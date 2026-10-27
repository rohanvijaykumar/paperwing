/**
 * Opening PDFs from the OS while Paperwing is already running (a second
 * launch with the file, as Explorer and "Open with" do). Each file must come
 * to the front in its own tab, including files with the same name in
 * different folders and files that are already open.
 *   node bench/check-open-running.mjs
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { launch, sleep } from './harness.mjs';

const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts } = require('../../node_modules/pdf-lib');

const root = join(
  process.env.BENCH_TMP || 'D:/tmp/paperwing-bench',
  'open running'
);
rmSync(root, { recursive: true, force: true });
// Each file has its own page count, so the document on screen tells which file it is
let pagesNext = 1;
const pagesOf = new Map();
async function pdf(dir, name, label) {
  mkdirSync(join(root, dir), { recursive: true });
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const n = pagesNext++;
  for (let i = 0; i < n; i++)
    doc
      .addPage([400, 300])
      .drawText(`${label} ${i + 1}/${n}`, { x: 40, y: 150, size: 24, font });
  const file = join(root, dir, name);
  writeFileSync(file, await doc.save());
  pagesOf.set(file, n);
  return file;
}
const files = [
  await pdf('Acme Corp/Product Manager', 'Rohan_Resume.pdf', 'Acme'),
  await pdf('Globex/Product Manager', 'Rohan_Resume.pdf', 'Globex'),
  await pdf('Initech/Associate PM', 'Rohan Resume (final).pdf', 'Initech'),
  await pdf('Umbrella', 'Cover letter.pdf', 'Umbrella'),
];

let failed = 0;
const check = (ok, what, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
};

const app = await launch({ args: [files[0]], waitFor: 'main window shown' });
const { page } = app;

/** What's in front: the active tab's name, how many pages the document on
 *  screen has, and how many document tabs are open */
const state = () =>
  page.evaluate(() => {
    const v = window.__acro.viewer;
    const active = document.querySelector('#tabs .tab.is-active');
    return {
      name: active?.querySelector('.tab-label')?.textContent?.trim() || null,
      pages: v.current ? (v.pageInfo(v.current)?.total ?? 0) : 0,
      count: document.querySelectorAll('#tabs [role="tab"]').length,
    };
  });
/** Waits until the document on screen is `file` */
async function front(file, timeout = 20000) {
  const want = { name: file.split(/[\\/]/).pop(), pages: pagesOf.get(file) };
  const end = Date.now() + timeout;
  let s;
  while (Date.now() < end) {
    s = await state();
    if (s.name === want.name && s.pages === want.pages)
      return { ...s, ok: true };
    await sleep(200);
  }
  return { ...s, ok: false, want };
}
const show = (s) =>
  `${s.name}, ${s.pages} page(s), ${s.count} tab(s)${s.ok ? '' : `; expected ${s.want.name} with ${s.want.pages} page(s)`}`;

let s = await front(files[0]);
check(s.ok, 'launched with a file: it opens', show(s));

for (const [i, f] of files.slice(1).entries()) {
  await app.openFile(f);
  s = await front(f);
  check(
    s.ok,
    `opened while running (${i + 2}): it comes to the front`,
    show(s)
  );
}

// Already open: switch to it, don't open it again
await app.openFile(files[0]);
s = await front(files[0]);
check(
  s.ok && s.count === files.length,
  'opening a file that is already open switches to it, not a new tab',
  show(s)
);

// The same file, rewritten on disk since it was opened (a resume saved again
// under the same name): opening it shows the new version
const rewritten = files[1];
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 9; i++)
    doc
      .addPage([400, 300])
      .drawText(`Globex v2 ${i + 1}/9`, { x: 40, y: 150, size: 24, font });
  writeFileSync(rewritten, await doc.save());
  pagesOf.set(rewritten, 9);
}
await app.openFile(rewritten);
s = await front(rewritten);
check(
  s.ok && s.count === files.length,
  'a file changed on disk since it was opened shows its new version',
  show(s)
);

const dirty = () =>
  page.evaluate(
    () => !!document.querySelector('#tabs .tab.is-active.is-dirty')
  );
const dialogTitle = () =>
  page.evaluate(() => document.querySelector('.dlg h2')?.textContent ?? null);
const clickDialog = (label) =>
  page.evaluate(
    (label) =>
      [...document.querySelectorAll('.dlg button')]
        .find((b) => b.textContent === label)
        ?.click(),
    label
  );
check(
  !(await dirty()),
  'after loading the new version nothing is marked unsaved'
);

// Unsaved edits in the tab: ask before replacing them
await page.evaluate(() => {
  const v = window.__acro.viewer;
  const a = v.cap('annotation').forDocument(v.docIds.get(v.current));
  const rect = { origin: { x: 40, y: 140 }, size: { width: 120, height: 30 } };
  a.createAnnotation(0, {
    type: 9,
    id: crypto.randomUUID(),
    pageIndex: 0,
    rect,
    segmentRects: [rect],
    color: '#FFD84D',
    opacity: 0.6,
  });
});
await sleep(800);
check(await dirty(), 'an edit marks the document unsaved');
async function rewrite(file, n, label) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < n; i++)
    doc
      .addPage([400, 300])
      .drawText(`${label} ${i + 1}/${n}`, { x: 40, y: 150, size: 24, font });
  writeFileSync(file, await doc.save());
  pagesOf.set(file, n);
}
await rewrite(rewritten, 11, 'Globex v3');
await app.openFile(rewritten);
let title = null;
for (let i = 0; i < 50 && !title; i++) {
  await sleep(200);
  title = await dialogTitle();
}
check(
  /has changed/.test(title ?? ''),
  'with unsaved edits it asks first',
  title ?? 'no dialog'
);
await clickDialog('Keep my version');
await sleep(800);
s = await state();
check(
  s.pages === 9 && (await dirty()),
  '"Keep my version" keeps the edited document',
  `${s.pages} page(s)`
);

await app.openFile(rewritten);
title = null;
for (let i = 0; i < 50 && !title; i++) {
  await sleep(200);
  title = await dialogTitle();
}
check(
  /has changed/.test(title ?? ''),
  'opening it again asks again',
  title ?? 'no dialog'
);
await clickDialog('Load new version');
s = await front(rewritten);
check(
  s.ok && !(await dirty()),
  '"Load new version" shows it, with nothing unsaved',
  show(s)
);

// Opened again, unchanged: no reload, no question
await app.openFile(rewritten);
await sleep(1500);
check(
  !(await dialogTitle()) && (await state()).pages === 11,
  'an unchanged file just comes to the front'
);

// Saved from Paperwing: its own save isn't a change made elsewhere
await page.evaluate(() => {
  const v = window.__acro.viewer;
  const a = v.cap('annotation').forDocument(v.docIds.get(v.current));
  const rect = { origin: { x: 40, y: 100 }, size: { width: 120, height: 30 } };
  a.createAnnotation(0, {
    type: 9,
    id: crypto.randomUUID(),
    pageIndex: 0,
    rect,
    segmentRects: [rect],
    color: '#FFD84D',
    opacity: 0.6,
  });
});
for (let i = 0; i < 25 && !(await dirty()); i++) await sleep(200);
await page.evaluate(() => document.getElementById('save-btn').click());
for (let i = 0; i < 50 && (await dirty()); i++) await sleep(200);
check(!(await dirty()), 'saving clears the unsaved mark');
await app.openFile(rewritten);
await sleep(2000);
check(
  !(await dialogTitle()) && !(await dirty()) && (await state()).pages === 11,
  'after saving in Paperwing, opening the file again neither asks nor reloads'
);

// Opening several files quickly, one after another
const more = [
  await pdf('Rapid', 'one.pdf', 'One'),
  await pdf('Rapid', 'two.pdf', 'Two'),
  await pdf('Rapid', 'three.pdf', 'Three'),
];
await Promise.all(more.map((f) => app.openFile(f)));
await sleep(3000);
s = await state();
check(
  s.count === files.length + more.length,
  'three files opened at once all open',
  `${s.count} tab(s)`
);

await app.close();
rmSync(root, { recursive: true, force: true });
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
