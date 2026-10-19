/**
 * Checks how documents made by tools are handled, in the real desktop app:
 *   node bench/check-results.mjs <a.pdf>
 * - a tool's result opens unsaved, stays out of Recent, has a recovery copy
 * - after a crash it's reopened (still unsaved); discarding removes the copy
 * - dropped files: the bridge can read their path
 * - right-click menu on a recent file
 */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { launch, sleep } from './harness.mjs';

const file = process.argv[2];
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures++;
};
const until = async (page, fn, timeout = 30000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await page.evaluate(fn).catch(() => false)) return true;
    await sleep(150);
  }
  return false;
};

let app = await launch();
const profile = app.userData;
const unsavedDir = join(profile, 'Unsaved');
let { page } = app;

// The bridge exposes the dropped-file path helper, and it works in the sandbox
check(
  await page.evaluate(() => {
    try {
      return window.paperwing.pathForFile(new File(['x'], 'x.pdf')) === '';
    } catch {
      return false;
    }
  }),
  'pathForFile works (no path for a file that is not on disk)'
);

await app.openFile(file);
await until(
  page,
  () =>
    document.querySelector('#view-doc.is-active') &&
    !document.querySelector('#doc-stage.is-loading')
);
await sleep(1000);

// Run Compress on it
await page.evaluate(() =>
  [...document.querySelectorAll('.lp-tool')]
    .find((b) => b.textContent.includes('Compress'))
    .click()
);
const frameEl = await page.waitForSelector('#left-panel iframe');
const frame = await frameEl.contentFrame();
await frame.waitForSelector('#process-btn', { timeout: 30000 });
await sleep(1500);
await frame.click('#process-btn');
check(
  await until(
    page,
    () => document.querySelectorAll('#tabs .tab').length === 2,
    90000
  ),
  'result opens in a new tab'
);
await sleep(1500);
const state = await page.evaluate(() => {
  const tab = document.querySelectorAll('#tabs .tab')[1];
  return {
    dirty: tab.classList.contains('is-dirty'),
    title: tab.title,
    name: tab.textContent.trim(),
  };
});
check(state.dirty, `result tab shows unsaved (${state.title})`);
const recovery = () => (existsSync(unsavedDir) ? readdirSync(unsavedDir) : []);
check(
  recovery().filter((f) => f.endsWith('.pdf')).length === 1,
  `recovery copy kept (${recovery().join(', ')})`
);
await page.evaluate(() => document.querySelector('#home-btn').click());
await sleep(800);
const recentNames = await page.evaluate(() =>
  [...document.querySelectorAll('#recent-list .rr-title')].map(
    (e) => e.textContent
  )
);
check(
  recentNames.length === 1,
  `result not in Recent (${recentNames.join(', ')})`
);

// Right-click menu on the recent file
await page.evaluate(() => {
  const row = document.querySelector('#recent-list .recent-row[data-id]');
  const r = row.getBoundingClientRect();
  row.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: r.left + 100,
      clientY: r.top + 20,
    })
  );
});
await sleep(300);
const items = await page.evaluate(() =>
  [...document.querySelectorAll('.popover .mi-label')].map((e) => e.textContent)
);
check(
  [
    'Open',
    'Show in File Explorer',
    'Copy path',
    'Compress…',
    'Combine with other files…',
    'Star',
    'Remove from Recent',
  ].every((x) => items.includes(x)),
  `right-click menu: ${items.join(' | ')}`
);
await page.keyboard.press('Escape');

// Crash: kill the app, start it again
app.child.kill();
await new Promise((r) => app.child.once('exit', r));
await sleep(800);
app = await launch({ profile });
page = app.page;
check(
  await until(
    page,
    () =>
      [...document.querySelectorAll('#tabs .tab')].some((t) =>
        t.classList.contains('is-dirty')
      ),
    30000
  ),
  'after a crash the unsaved result is reopened, still unsaved'
);
const toastText = await page.evaluate(
  () => document.querySelector('#toasts')?.textContent ?? ''
);
check(
  /unsaved changes/.test(toastText),
  `toast: ${toastText.trim().slice(0, 80)}`
);

// Close it and choose Don't save: the recovery copy goes
await page.evaluate(() => {
  const tab = [...document.querySelectorAll('#tabs .tab')].find((t) =>
    t.classList.contains('is-dirty')
  );
  tab.querySelector('.tab-close').click();
});
await until(page, () => document.querySelector('.dlg[role="alertdialog"]'));
await page.evaluate(() =>
  document.querySelector('.dlg-actions .quiet-btn').click()
);
await sleep(800);
check(
  recovery().length === 0,
  `discarding removes the recovery copy (${recovery().join(', ') || 'none left'})`
);

// Make another result, then quit and choose Don't save: no copy left behind
await app.openFile(file);
await until(
  page,
  () =>
    document.querySelector('#view-doc.is-active') &&
    !document.querySelector('#doc-stage.is-loading')
);
await sleep(1000);
await page.evaluate(() =>
  [...document.querySelectorAll('.lp:not([hidden]) .lp-tool')]
    .find((b) => b.textContent.includes('Compress'))
    .click()
);
const frame2 = await (
  await page.waitForSelector(
    '#left-panel .lp:not([hidden]) iframe, #left-panel iframe'
  )
).contentFrame();
await frame2.waitForSelector('#process-btn', { timeout: 30000 });
await sleep(1500);
await frame2.click('#process-btn');
await until(
  page,
  () =>
    [...document.querySelectorAll('#tabs .tab')].some((t) =>
      t.classList.contains('is-dirty')
    ),
  90000
);
await sleep(1500);
check(
  recovery().filter((f) => f.endsWith('.pdf')).length === 1,
  'second result has a recovery copy'
);
const exited = new Promise((r) => app.child.once('exit', r));
await page.evaluate(() => window.paperwing.requestClose());
await until(page, () => document.querySelector('.dlg[role="alertdialog"]'));
await page.evaluate(() =>
  document.querySelector('.dlg-actions .quiet-btn').click()
);
const quit = await Promise.race([
  exited.then(() => true),
  sleep(15000).then(() => false),
]);
check(quit, "app quits after Don't save");
check(
  recovery().length === 0,
  `quitting without saving leaves no copy (${recovery().join(', ') || 'none left'})`
);

try {
  app.browser.disconnect();
} catch {}
if (!quit) await app.close();
try {
  rmSync(profile, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
} catch {}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
