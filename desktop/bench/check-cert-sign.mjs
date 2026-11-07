/**
 * Use a certificate ▸ Digitally sign in the real app, with real clicks:
 * All tools ▸ Use a certificate ▸ Digitally sign, drag a box on the page,
 * the Sign with a Digital ID list (Acrobat's filters, Show all
 * certificates, View details), Sign as (reason, location, lock, a new
 * appearance), Sign, Save As; then a second signature with a new
 * self-signed ID (Configure New Digital ID ▸ Create), a wrong password on
 * an ID file, and Validate signatures on the result (pass/fail).
 *
 * Needs test IDs in the system store (the key never leaves it):
 *   Windows: pwsh native/win-certs/test-certs.ps1 -Create -Out certs.json
 *   macOS:   native/mac-certs/test-keychain.sh create certs.json
 * then
 *   PW_TEST_CERTS=certs.json node bench/check-cert-sign.mjs
 * PW_SIGNED_OUT: where the signed PDFs go (BENCH_TMP/cert-sign);
 * PW_SCREENS: a folder for screenshots of each dialog.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TMP = process.env.BENCH_TMP || 'D:/tmp/paperwing-bench';
const OUT = process.env.PW_SIGNED_OUT || join(TMP, 'cert-sign');
const SCREENS = process.env.PW_SCREENS;
const spec = JSON.parse(
  readFileSync(process.env.PW_TEST_CERTS, 'utf8').replace(/^\uFEFF/, '')
);
const byLabel = (l) => spec.find((c) => c.label === l);
const signer = byLabel('rsa') ?? spec.find((c) => c.expect === 'usable');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
if (SCREENS) mkdirSync(SCREENS, { recursive: true });
const doc = join(OUT, 'Contract.pdf');
copyFileSync(resolve(here, '../../src/tests/fixtures/sample.pdf'), doc);

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

const app = await launch({
  args: [doc],
  env: { PAPERWING_TEST_SAVE_DIR: OUT },
});
const { page } = app;
// The page's errors, to tell why a step failed
page.on('console', (m) => {
  if (m.type() === 'error')
    console.log(`     [page] ${m.text().slice(0, 300)}`);
});
page.on('pageerror', (e) =>
  console.log(`     [page] ${String(e).slice(0, 300)}`)
);
const shot = async (name, selector) => {
  if (!SCREENS) return;
  await sleep(400);
  const el = selector ? await page.$(selector) : null;
  await (el ?? page).screenshot({ path: join(SCREENS, `${name}.png`) });
};
const text = (sel) =>
  page.evaluate((s) => document.querySelector(s)?.textContent ?? '', sel);
const visible = (sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    return !!el && el.getBoundingClientRect().width > 0;
  }, sel);
const clickText = async (selector, label) => {
  const handles = await page.$$(selector);
  for (const h of handles) {
    const t = await h.evaluate((e) => e.textContent.trim());
    if (t === label || t.startsWith(label)) {
      await h.click();
      return true;
    }
  }
  return false;
};

try {
  // The document is open and shown
  const ready = await until(
    () =>
      page.evaluate(
        () =>
          document.querySelector('#view-doc.is-active') &&
          !document.querySelector('#doc-stage.is-loading')
      ),
    30000
  );
  check(!!ready, 'the document opened');
  await sleep(1500);

  // All tools ▸ Use a certificate
  const opened = await clickText(
    '.lp:not([hidden]) .lp-tool',
    'Use a certificate'
  );
  check(opened, 'All tools lists Use a certificate');
  check(
    !!(await until(() => visible('#cert-bar'))),
    'the Use a certificate bar shows'
  );
  await shot('01-use-a-certificate', '#doc-stage');

  async function drawBox(fy0, fy1) {
    await page.click('#cb-sign');
    check(
      !!(await until(async () => /Drag a box/.test(await text('#cert-bar')))),
      'Digitally sign asks for a box'
    );
    const rect = await until(() =>
      page.evaluate(() => {
        const host = [...document.querySelectorAll('#viewer-host *')].find(
          (e) => e.shadowRoot
        );
        const layer = host?.shadowRoot?.querySelector(
          '.pwsig-layer[data-page="0"]'
        );
        if (!layer) return null;
        const r = layer.getBoundingClientRect();
        // The part of the page on screen (it can be taller than the window)
        const top = Math.max(r.top, host.getBoundingClientRect().top);
        const bottom = Math.min(r.bottom, innerHeight - 10);
        return r.width > 0 && bottom > top
          ? { x: r.left, y: top, w: r.width, h: bottom - top }
          : null;
      })
    );
    check(!!rect, 'the page takes a box to be drawn');
    const x0 = rect.x + rect.w * 0.1;
    const y0 = rect.y + rect.h * fy0;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x0 + rect.w * 0.25, y0 + rect.h * 0.05, { steps: 8 });
    await page.mouse.move(x0 + rect.w * 0.45, rect.y + rect.h * fy1, {
      steps: 8,
    });
    await page.mouse.up();
  }

  await drawBox(0.62, 0.72);
  check(
    !!(await until(() => visible('#cid-dialog'))),
    'Sign with a Digital ID opens'
  );
  await until(
    async () => !/Looking for/.test(await text('#cid-dialog .cid-list')),
    30000
  );
  const rows = async () =>
    page.evaluate(() =>
      [...document.querySelectorAll('#cid-dialog .cid-row')].map((r) => ({
        name: r.querySelector('.cid-name b')?.textContent,
        disabled: r.classList.contains('is-disabled'),
        meta: r.querySelector('.cid-meta')?.textContent ?? '',
        badge: r.querySelector('.cid-badge')?.textContent ?? '',
      }))
    );
  let list = await rows();
  for (const c of spec) {
    const row = list.find((r) => r.name === c.name);
    if (c.expect === 'usable')
      check(
        !!row && !row.disabled,
        `${c.label}: listed and can sign`,
        row?.badge
      );
    if (c.expect === 'hidden')
      check(!row, `${c.label}: hidden (only for logging in)`);
    if (c.expect === 'expired')
      check(
        !!row && row.disabled && /expired/.test(row.meta),
        `${c.label}: shown, disabled, “expired”`
      );
  }
  await shot('02-sign-with-a-digital-id', '#cid-dialog');

  // Show all certificates lists the hidden ones, with why
  await page.click('#cid-show-all');
  list = await rows();
  const login = byLabel('login');
  if (login) {
    const row = list.find((r) => r.name === login.name);
    check(
      !!row && row.disabled && /logging in/.test(row.meta),
      'Show all certificates: the login-only ID, disabled, with why'
    );
  }
  await shot('03-show-all-certificates', '#cid-dialog');
  await page.click('#cid-show-all');

  // Pick the signer; View details
  await page.evaluate((name) => {
    [...document.querySelectorAll('#cid-dialog .cid-row')]
      .find((r) => r.querySelector('.cid-name b')?.textContent === name)
      ?.setAttribute('data-bench', 'signer');
  }, signer.name);
  await page.click('#cid-dialog .cid-row[data-bench="signer"]');
  await page.click('#cid-details');
  check(
    !!(await until(() => visible('#cert-details-dialog'))),
    'View details opens'
  );
  const details = await text('#cert-details-dialog');
  check(
    details.includes(signer.name) && /SHA-256 fingerprint/.test(details),
    'details show the name and fingerprint'
  );
  await shot('04-certificate-details', '#cert-details-dialog');
  await clickText('#cert-details-dialog button', 'Close');

  await page.click('#cid-continue');
  check(!!(await until(() => visible('#sas-dialog'))), 'Sign as opens');
  check(
    (await text('#sas-dialog h2')).includes(signer.name),
    'Sign as names the signer'
  );
  await page.click('#sas-reason');
  await page.keyboard.type('I approve this contract');
  await page.click('#sas-location');
  await page.keyboard.type('Praha');

  // A new appearance: no labels
  await page.click('#sas-create');
  check(
    !!(await until(() => visible('#app-dialog'))),
    'Create appearance opens'
  );
  await page.click('#app-title');
  await page.keyboard.type('Bench, no labels');
  await page.click('#app-dialog input[data-show="labels"]');
  await shot('05-create-appearance', '#app-dialog');
  await page.click('#app-save');
  await until(async () => !(await visible('#app-dialog')));
  const chosen = await page.$eval(
    '#sas-appearance',
    (s) => s.selectedOptions[0]?.textContent
  );
  check(chosen === 'Bench, no labels', 'the new appearance is chosen', chosen);
  await shot('06-sign-as', '#sas-dialog');

  await page.click('#sas-sign');
  const signedName = 'Contract (signed).pdf';
  const toast = await until(async () => {
    const t = await text('#toasts');
    return /Signed and saved/.test(t) ? t : null;
  }, 60000);
  check(
    !!toast,
    'signed and saved',
    (toast || (await text('#sas-dialog .cs-status'))).trim()
  );
  check(existsSync(join(OUT, signedName)), 'the signed file is on disk');
  const tabName = await page.evaluate(() => document.title);
  check(
    tabName.startsWith(signedName),
    'the tab shows the signed document',
    tabName
  );
  await sleep(1500);
  await shot('07-signed', '#doc-stage');

  // A second signature, with a new self-signed ID (saved as a .pfx)
  await drawBox(0.78, 0.88);
  await until(() => visible('#cid-dialog'));
  await page.click('#cid-configure');
  await until(() => visible('#cfg-dialog'));
  await shot('08-configure', '#cfg-dialog');
  await page.click('#cfg-dialog input[value="create"]');
  await page.click('#cfg-continue');
  await until(() => visible('#newid-dialog'));
  await page.type('#newid-name', 'Bench Signer');
  await page.type('#newid-email', 'bench@example.com');
  await page.type('#newid-org', 'Paperwing bench');
  await page.select('#newid-key', 'ec');
  await page.type('#newid-password', 'bench-pass');
  await page.type('#newid-password2', 'bench-pass');
  await shot('09-create-id', '#newid-dialog');
  await page.click('#newid-save');
  await until(async () => !(await visible('#newid-dialog')), 30000);
  check(
    existsSync(join(OUT, 'Bench Signer.pfx')),
    'the new ID was saved as a .pfx'
  );
  list = await rows();
  const fileRow = list.find((r) => r.name === 'Bench Signer');
  check(
    !!fileRow && fileRow.badge === 'File' && !fileRow.disabled,
    'the new ID is listed (File) and selected'
  );
  await page.click('#cid-continue');
  await until(() => visible('#sas-dialog'));
  await page.click('#sas-sign');
  const toast2 = await until(async () => {
    const t = await text('#toasts');
    return /Signed and saved as Contract \(signed\) \(signed\)/.test(t)
      ? t
      : null;
  }, 60000);
  check(
    !!toast2,
    'signed a second time',
    (toast2 || (await text('#sas-dialog .cs-status'))).trim()
  );

  // An ID file with the wrong password
  await drawBox(0.3, 0.38);
  await until(() => visible('#cid-dialog'));
  await page.click('#cid-configure');
  await until(() => visible('#cfg-dialog'));
  const choosing = page.waitForFileChooser({ timeout: 10000 });
  await page.click('#cfg-continue');
  const chooser = await choosing;
  await chooser.accept([join(OUT, 'Bench Signer.pfx')]);
  await until(() => visible('#idfile-dialog'));
  await until(async () =>
    /Bench Signer\.pfx/.test(await text('#idfile-dialog .idf-name'))
  );
  await page.type('#idfile-password', 'wrong');
  await page.click('#idfile-add');
  const wrong = await until(async () => {
    const t = await text('#idfile-dialog .cs-status');
    return /incorrect/.test(t) ? t : null;
  });
  check(!!wrong, 'a wrong password says so', wrong ?? '');
  await shot('10-wrong-password', '#idfile-dialog');
  await page.keyboard.press('Escape');
  await sleep(300);
  await page.keyboard.press('Escape');
  await sleep(300);
  check(!(await visible('#cid-dialog')), 'Escape closes the dialogs');

  // A third, with the ID file (Use a file) and Lock document after signing
  await drawBox(0.4, 0.5);
  await until(() => visible('#cid-dialog'));
  await page.click('#cid-configure');
  await until(() => visible('#cfg-dialog'));
  const choosing2 = page.waitForFileChooser({ timeout: 10000 });
  await page.click('#cfg-continue');
  await (await choosing2).accept([join(OUT, 'Bench Signer.pfx')]);
  await until(() => visible('#idfile-dialog'));
  await until(async () =>
    /Bench Signer\.pfx/.test(await text('#idfile-dialog .idf-name'))
  );
  await page.type('#idfile-password', 'bench-pass');
  await page.click('#idfile-add');
  await until(async () => !(await visible('#idfile-dialog')));
  await page.click('#cid-continue');
  await until(() => visible('#sas-dialog'));
  await page.click('#sas-lock');
  await page.click('#sas-sign');
  const toast3 = await until(async () => {
    const t = await text('#toasts');
    return /\(signed\) \(signed\) \(signed\)\.pdf/.test(t) ? t : null;
  }, 60000);
  check(
    !!toast3,
    'signed a third time with the ID file, locked',
    (toast3 || (await text('#sas-dialog .cs-status'))).trim()
  );

  // Locked: it can't be signed again
  await page.click('#cb-sign');
  const refused = await until(async () => {
    const t = await text('#toasts');
    return /can't be signed again/.test(t) ? t : null;
  });
  check(!!refused, 'a locked document can’t be signed again', refused ?? '');

  // Save on the signed, unchanged document keeps it byte for byte (an
  // export would rewrite it and break the signatures)
  const signedFile = join(OUT, 'Contract (signed) (signed) (signed).pdf');
  const before = existsSync(signedFile) ? readFileSync(signedFile) : null;
  await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
  await page.keyboard.press('s');
  await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
  await until(async () => /Saved Contract/.test(await text('#toasts')));
  const after = existsSync(signedFile) ? readFileSync(signedFile) : null;
  check(
    !!before && !!after && before.equals(after),
    'Save keeps the signed document byte for byte'
  );

  // Validate signatures on the signed document
  await clickText('#cert-bar button', 'Validate signatures');
  const frame = await until(async () =>
    page.frames().find((f) => f.url().includes('validate-signature-pdf'))
  );
  check(!!frame, 'Validate signatures opens');
  const result = await until(async () => {
    const t = await frame.evaluate(() => document.body.innerText);
    return /Paperwing Test|Bench Signer/.test(t) ? t : null;
  }, 30000);
  check(
    !!result && /3 signatures found/.test(result),
    'Validate signatures finds all three signatures'
  );
  if (!result && frame)
    console.log(
      `     frame shows: ${(await frame.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 600)}`
    );
  if (result) {
    console.log(
      `     validator says: ${result.replace(/\s+/g, ' ').slice(0, 700)}`
    );
    // Self-signed test IDs: intact, identity not verified; the earlier ones
    // cover their own version (signed again later), which leaves them valid
    check(
      !/Invalid|Changed after signing|Couldn’t check/i.test(result) &&
        (result.match(/Self-Signed: Signer Identity Not Verified/g) ?? [])
          .length === 3,
      'every signature verifies, none changed after signing'
    );
    check(
      (result.match(/Covers its version/g) ?? []).length === 2,
      'the first two cover their version, signed again later'
    );
  }
  await shot('11-validate', '#doc-stage');
} catch (e) {
  failed++;
  console.log(`FAIL ${e?.stack ?? e}`);
} finally {
  await app.close();
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
