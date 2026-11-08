/**
 * Scanning with the exact-bytes Save and certificate signing (added together
 * in 1.3.0), in the real app with the stand-in scanners and real clicks:
 *  - pages appended from the scanner to a PDF opened from disk: Save writes
 *    them (the document is changed, so it's written in full)
 *  - Enhance scanned pages on it: Save writes the change
 *  - a new scan: Save writes it; Save again with no change keeps the bytes
 *  - the scan, signed with a test ID from the certificate store (Use a
 *    certificate ▸ Digitally sign): the signed file verifies
 *  - the signed-document warning (#46's QA pass): saving the unsigned
 *    document with scanned pages appended doesn't ask; saving the signed
 *    scan with a scanned page appended asks first, like any other edit
 *    (Cancel writes nothing; Save anyway writes the page)
 *   PW_TEST_CERTS=certs.json node bench/check-rc-interactions.mjs
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as L from './scan-bench-lib.mjs';

const require = createRequire(import.meta.url);
const { PDFDocument } = require('../../node_modules/pdf-lib');
const { check, until, sleep, click, press, choose } = L;
const here = dirname(fileURLToPath(import.meta.url));
const TMP = process.env.BENCH_TMP || tmpdir();
const root = join(TMP, 'rc-interactions');
const src = join(root, 'src');
const out = join(root, 'out');
rmSync(root, { recursive: true, force: true });
mkdirSync(src, { recursive: true });
mkdirSync(out, { recursive: true });
const original = join(src, 'Report.pdf');
copyFileSync(resolve(here, '../../src/tests/fixtures/sample.pdf'), original);
const pagesOf = async (file) =>
  (
    await PDFDocument.load(readFileSync(file), { ignoreEncryption: true })
  ).getPageCount();
const waitFile = async (file, differentFrom, timeout = 20000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (
      existsSync(file) &&
      (!differentFrom || !readFileSync(file).equals(differentFrom))
    )
      return true;
    await sleep(250);
  }
  return false;
};

const dialogText = (page) =>
  page.evaluate(() => document.querySelector('.dlg-backdrop')?.innerText ?? '');
/** Scan one flatbed page into the open document (Append to file) */
const appendScan = async (page, before) => {
  if (!(await L.openDialog(page))) return false;
  await choose(page, 'Scanner', 'Paperwing Test Scanner');
  await L.waitReady(page);
  await choose(page, 'Source', 'Flatbed');
  await click(page, '.dlg-scan .pd-radio', 'Append to file');
  await press(page, 'Scan');
  await L.waitIdle(page);
  await press(page, 'Scan is complete');
  return until(
    page,
    (n) =>
      window.__acro.viewer.pageInfo(window.__acro.viewer.current)?.total === n,
    before + 1,
    30000
  );
};

const app = await L.start({ PAPERWING_TEST_SAVE_DIR: out });
const { page } = app;
page.on('pageerror', (e) =>
  console.log(`     [page] ${String(e).slice(0, 300)}`)
);
try {
  await app.openFile(original);
  await until(
    page,
    () =>
      window.__acro.viewer.pageInfo(window.__acro.viewer.current)?.total > 0,
    undefined,
    30000
  );
  await sleep(1500);
  const disk0 = readFileSync(original);
  const pages0 = await pagesOf(original);

  /* Append from the scanner, then Save --------------------------------- */
  check(await L.openDialog(page), 'the scan dialog opens over the document');
  await choose(page, 'Scanner', 'Paperwing Test Scanner');
  await L.waitReady(page);
  await choose(page, 'Source', 'Flatbed');
  await click(page, '.dlg-scan .pd-radio', 'Append to file');
  await press(page, 'Scan');
  await L.waitIdle(page);
  await press(page, 'Scan is complete');
  const appended = await until(
    page,
    (n) =>
      window.__acro.viewer.pageInfo(window.__acro.viewer.current)?.total === n,
    pages0 + 1,
    30000
  );
  check(
    !!appended,
    'a scanned page appended',
    `${pages0} -> ${await L.pageCount(page)}`
  );
  check((await L.docInfo(page)).dirty, 'the document is changed');
  await click(page, '#save-btn');
  check(await waitFile(original, disk0), 'Save writes the file');
  check(
    !/signed document/.test(await dialogText(page)),
    'an unsigned document: Save doesn’t ask about signatures'
  );
  const disk1 = readFileSync(original);
  check(
    (await pagesOf(original)) === pages0 + 1,
    'the saved file has the scanned page',
    `${pages0} -> ${await pagesOf(original)}`
  );
  await sleep(1000);
  check(!(await L.docInfo(page)).dirty, 'and the document is saved');

  /* Enhance scanned pages, then Save ----------------------------------- */
  const search = async (q) => {
    const box = await page.evaluate(() => {
      const i = [...document.querySelectorAll('.lp-search input')].find(
        (x) => x.offsetParent
      );
      i.value = '';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      const r = i.getBoundingClientRect();
      return { x: r.x + 20, y: r.y + r.height / 2 };
    });
    await page.mouse.click(box.x, box.y);
    await page.keyboard.type(q);
    await sleep(300);
  };
  await search('enhance');
  await click(page, '.lp-tool', 'Enhance scanned pages');
  check(
    !!(await until(
      page,
      () => document.querySelector('.dlg-enhance'),
      undefined,
      10000
    )),
    'Enhance scanned pages opens'
  );
  await click(page, '.dlg-enhance .accent-btn', 'Enhance');
  check(
    !!(await until(
      page,
      () =>
        /Enhanced the scanned pages/.test(
          document.querySelector('#toasts')?.textContent ?? ''
        ),
      undefined,
      60000
    )),
    'the pages are enhanced'
  );
  await sleep(1000);
  check((await L.docInfo(page)).dirty, 'the document is changed');
  await click(page, '#save-btn');
  check(
    await waitFile(original, disk1, 30000),
    'Save writes the enhanced pages'
  );
  check(
    (await pagesOf(original)) === pages0 + 1,
    'with every page',
    String(await pagesOf(original))
  );

  /* A new scan: Save, then Save again unchanged ------------------------- */
  check(await L.openDialog(page), 'the scan dialog opens again');
  await choose(page, 'Scanner', 'Paperwing Test Scanner');
  await L.waitReady(page);
  await choose(page, 'Source', 'Flatbed');
  await click(page, '.dlg-scan .pd-radio', 'Create new PDF');
  await press(page, 'Scan');
  await L.waitIdle(page);
  await press(page, 'Scan is complete');
  await until(
    page,
    () =>
      /^Scan /.test(
        document.querySelector('#tabs .tab.is-active')?.textContent.trim() ?? ''
      ),
    undefined,
    30000
  );
  await sleep(1500);
  const scanTab = (await L.docInfo(page)).name;
  check(/^Scan /.test(scanTab ?? ''), 'a new scanned document', scanTab);
  await click(page, '#save-btn');
  const scanFile = join(out, scanTab.replace(/\s*$/, ''));
  check(await waitFile(scanFile), 'Save asks where and writes it', scanFile);
  await sleep(1000);
  check((await pagesOf(scanFile)) === 1, 'the saved scan has its page');
  const scanBytes = readFileSync(scanFile);
  await click(page, '#save-btn');
  await sleep(1500);
  check(
    readFileSync(scanFile).equals(scanBytes),
    'Save again with no change keeps it byte for byte'
  );

  /* Sign the saved scan with a test ID --------------------------------- */
  const certs = process.env.PW_TEST_CERTS
    ? JSON.parse(
        readFileSync(process.env.PW_TEST_CERTS, 'utf8').replace(/^\uFEFF/, '')
      )
    : [];
  const signer = certs.find((c) => c.label === 'rsa');
  if (!signer) {
    check(false, 'signing: PW_TEST_CERTS with an rsa test ID is needed');
  } else {
    await search('certificate');
    await click(page, '.lp-tool', 'Use a certificate');
    check(
      !!(await until(page, () => document.querySelector('#cert-bar'))),
      'Use a certificate shows its bar over the scan'
    );
    await page.click('#cb-sign');
    await until(page, () =>
      /Drag a box/.test(document.querySelector('#cert-bar')?.textContent)
    );
    const at = await page.evaluate(() => {
      const host = [...document.querySelectorAll('#viewer-host *')].find(
        (e) => e.shadowRoot
      );
      const layer = host?.shadowRoot?.querySelector(
        '.pwsig-layer[data-page="0"]'
      );
      if (!layer) return null;
      const r = layer.getBoundingClientRect();
      const top = Math.max(r.top, host.getBoundingClientRect().top);
      const bottom = Math.min(r.bottom, innerHeight - 10);
      return {
        x: r.left + r.width * 0.1,
        y: top + (bottom - top) * 0.6,
        w: r.width,
        h: bottom - top,
      };
    });
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x + at.w * 0.3, at.y + at.h * 0.05, { steps: 8 });
    await page.mouse.move(at.x + at.w * 0.45, at.y + at.h * 0.12, { steps: 8 });
    await page.mouse.up();
    await until(page, () => document.querySelector('#cid-dialog'));
    await until(
      page,
      () =>
        !/Looking for/.test(
          document.querySelector('#cid-dialog .cid-list')?.textContent ?? ''
        ),
      undefined,
      30000
    );
    const picked = await page.evaluate((name) => {
      const r = [...document.querySelectorAll('#cid-dialog .cid-row')].find(
        (x) => x.querySelector('.cid-name b')?.textContent === name
      );
      r?.setAttribute('data-bench', 'signer');
      return !!r;
    }, signer.name);
    check(picked, 'the test ID is listed', signer.name);
    await page.click('#cid-dialog .cid-row[data-bench="signer"]');
    await page.click('#cid-continue');
    await until(page, () => document.querySelector('#sas-dialog'));
    await page.click('#sas-sign');
    const signed = await until(
      page,
      () =>
        /Signed and saved/.test(
          document.querySelector('#toasts')?.textContent ?? ''
        ),
      undefined,
      60000
    );
    check(!!signed, 'the scan is signed and saved', await L.toasts(page));
    const signedFile = readdirSync(out).find((f) => /\(signed\)\.pdf$/.test(f));
    check(!!signedFile, 'the signed scan is on disk', signedFile);
    if (signedFile) console.log(`SIGNED ${join(out, signedFile)}`);

    /* Scan a page into the signed document, then Save: asks first ------- */
    if (signedFile) {
      const signedPath = join(out, signedFile);
      await sleep(1500);
      const signedBytes = readFileSync(signedPath);
      const before = await L.pageCount(page);
      check(
        !!(await appendScan(page, before)),
        'a scanned page appended to the signed document',
        `${before} -> ${await L.pageCount(page)}`
      );
      check((await L.docInfo(page)).dirty, 'the signed document is changed');
      await click(page, '#save-btn');
      const ask = await until(
        page,
        () => {
          const t = document.querySelector('.dlg-backdrop')?.innerText ?? '';
          return /Save changes to a signed document/.test(t) ? t : null;
        },
        undefined,
        10000
      );
      check(
        !!ask,
        'Save asks first: its signatures will no longer be valid',
        ask?.replace(/\s+/g, ' ').slice(0, 160)
      );
      if (ask) {
        await click(page, '.dlg-backdrop button', 'Cancel');
        await sleep(1500);
        check(
          readFileSync(signedPath).equals(signedBytes),
          'Cancel: the signed file is unchanged'
        );
        check(
          (await L.docInfo(page)).dirty,
          'and the document still has its change'
        );
        await click(page, '#save-btn');
        const again = await until(
          page,
          () =>
            /Save changes to a signed document/.test(
              document.querySelector('.dlg-backdrop')?.innerText ?? ''
            ),
          undefined,
          10000
        );
        check(!!again, 'Save asks again after Cancel');
        if (again) await click(page, '.dlg-backdrop button', 'Save anyway');
        check(
          await waitFile(signedPath, signedBytes, 30000),
          'Save anyway writes the file'
        );
        await sleep(1000);
        check(
          (await pagesOf(signedPath)) === before + 1,
          'with the scanned page',
          String(await pagesOf(signedPath))
        );
      }
    }
  }
} catch (e) {
  check(false, `${e?.stack ?? e}`);
} finally {
  await app.close();
}
L.finish();
