/**
 * Saving keeps what it should: a document with no changes is saved byte for
 * byte (Save As, Save and Download alike, so signatures in it stay valid);
 * a document with a change (a highlight) is saved with it, and reopening it
 * shows it (pass/fail).
 *   node bench/check-save-bytes.mjs
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './harness.mjs';

const require = createRequire(import.meta.url);
const { PDFDocument, PDFName, PDFDict } = require('../../node_modules/pdf-lib');
const here = dirname(fileURLToPath(import.meta.url));
const TMP = process.env.BENCH_TMP || 'D:/tmp/paperwing-bench';
const root = join(TMP, 'save-bytes');
const src = join(root, 'src');
const out = join(root, 'out');
rmSync(root, { recursive: true, force: true });
mkdirSync(src, { recursive: true });
mkdirSync(out, { recursive: true });
const original = join(src, 'Report.pdf');
copyFileSync(resolve(here, '../../src/tests/fixtures/sample.pdf'), original);
const saved = join(out, 'Report.pdf');

let failed = 0;
const check = (ok, what, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
};
const until = async (fn, timeout = 20000) => {
  const end = Date.now() + timeout;
  let v;
  while (Date.now() < end) {
    v = await fn().catch(() => null);
    if (v) return v;
    await sleep(200);
  }
  return v;
};
const ready = (page) =>
  until(
    () =>
      page.evaluate(
        () =>
          !!window.__acro?.viewer?.pageInfo(window.__acro.viewer.current)?.total
      ),
    30000
  );
const toasts = (page) =>
  page.evaluate(() => document.querySelector('#toasts')?.textContent ?? '');
const annotations = (page) =>
  page.evaluate(async () => {
    const v = window.__acro.viewer;
    const doc = v.cap('document-manager').getDocument(v.docIds.get(v.current));
    const list = await v.registry
      .getEngine()
      .getPageAnnotations(doc, doc.pages[0])
      .toPromise();
    return list.map((a) => a.type);
  });
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

let app = await launch({
  args: [original],
  env: { PAPERWING_TEST_SAVE_DIR: out },
});
let page = app.page;
try {
  check(!!(await ready(page)), 'the document opened');
  await sleep(1500);
  const before = readFileSync(original);

  // Save As with no changes: the same bytes
  await page.keyboard.down(mod);
  await page.keyboard.down('Shift');
  await page.keyboard.press('s');
  await page.keyboard.up('Shift');
  await page.keyboard.up(mod);
  await until(async () => /Saved Report/.test(await toasts(page)));
  check(
    readFileSync(saved).equals(before),
    'Save As of an unchanged document is byte for byte the same'
  );

  // Save again, still unchanged: still the same
  await page.click('#save-btn');
  await sleep(1500);
  check(
    readFileSync(saved).equals(before),
    'Save of an unchanged document too'
  );

  // A change: a highlight over the title, then Save
  const id = await page.evaluate(async () => {
    const v = window.__acro.viewer;
    const docId = v.docIds.get(v.current);
    const a = v.cap('annotation').forDocument(docId);
    const rect = { origin: { x: 72, y: 72 }, size: { width: 200, height: 30 } };
    const id = crypto.randomUUID();
    a.createAnnotation(0, {
      type: 9,
      id,
      pageIndex: 0,
      rect,
      segmentRects: [rect],
      color: '#FFD84D',
    });
    await new Promise((r) => setTimeout(r, 600));
    return id;
  });
  check(!!id, 'a highlight was added');
  await page.click('#save-btn');
  await until(async () => !readFileSync(saved).equals(before), 15000);
  const after = readFileSync(saved);
  check(!after.equals(before), 'Save with a change writes the change');
  const doc = await PDFDocument.load(after);
  const annots = doc.getPage(0).node.Annots();
  const types = (annots?.asArray() ?? []).map((r) =>
    doc.context.lookup(r, PDFDict).get(PDFName.of('Subtype'))?.toString()
  );
  check(
    types.includes('/Highlight'),
    'the saved file has the highlight',
    types.join(' ')
  );
} catch (e) {
  failed++;
  console.log(`FAIL ${e?.stack ?? e}`);
} finally {
  await app.close();
}

// Reopen the saved file: the highlight is there
app = await launch({ args: [saved] });
page = app.page;
try {
  check(!!(await ready(page)), 'the saved file reopens');
  await sleep(1500);
  const types = await until(async () => {
    const t = await annotations(page);
    return t.length ? t : null;
  });
  check(
    !!types && types.includes(9),
    'reopened, it shows the highlight',
    JSON.stringify(types)
  );
} catch (e) {
  failed++;
  console.log(`FAIL ${e?.stack ?? e}`);
} finally {
  await app.close();
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
