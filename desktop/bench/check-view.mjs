/**
 * "Reopen where you left off": a document reopens at the page and zoom it
 * was left at, after closing its tab and after restarting the app.
 *   node bench/check-view.mjs <long.pdf>
 */
import { rmSync } from 'node:fs';
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
const where = (page) =>
  page.evaluate(() => {
    const v = window.__acro.viewer;
    const tab = [...v.docIds.keys()].at(-1);
    return {
      page: v.pageInfo(tab)?.current,
      zoom: Math.round(v.zoom(tab) * 100),
    };
  });
const opened = (page) =>
  until(
    page,
    () =>
      document.querySelector('#view-doc.is-active') &&
      !document.querySelector('#doc-stage.is-loading')
  );

let app = await launch();
const profile = app.userData;
let { page } = app;
await app.openFile(file);
await opened(page);
await sleep(2500); // past the first layout; changes are remembered from here
await page.evaluate(() => {
  const v = window.__acro.viewer;
  const tab = [...v.docIds.keys()].at(-1);
  v.setZoom(tab, 0.8);
});
await sleep(600);
await page.evaluate(() => {
  const v = window.__acro.viewer;
  v.goToPage([...v.docIds.keys()].at(-1), 120);
});
await sleep(2000);
const left = await where(page);
console.log('left at', JSON.stringify(left));

// Close the tab, open the file again
await page.evaluate(() =>
  document.querySelector('#tabs .tab .tab-close').click()
);
await sleep(800);
await app.openFile(file);
await opened(page);
await sleep(2000);
const again = await where(page);
check(
  Math.abs(again.page - left.page) <= 1 && again.zoom === left.zoom,
  `reopened at ${JSON.stringify(again)}`
);

// Quit with it open; the restored session opens it where it was
await sleep(1500);
await app.close({ keepProfile: true });
await sleep(800);
app = await launch({ profile });
page = app.page;
await opened(page);
await sleep(2500);
const restored = await where(page);
check(
  Math.abs(restored.page - left.page) <= 1 && restored.zoom === left.zoom,
  `after restart at ${JSON.stringify(restored)}`
);

// With the preference off, it opens at the start
await page.evaluate(() => {
  const prefs = JSON.parse(localStorage.getItem('paperwing:prefs') || '{}');
  localStorage.setItem(
    'paperwing:prefs',
    JSON.stringify({ ...prefs, restoreView: false, restoreSession: false })
  );
});
await app.close({ keepProfile: true });
await sleep(800);
app = await launch({ profile });
page = app.page;
await app.openFile(file);
await opened(page);
await sleep(2000);
const off = await where(page);
check(off.page === 1, `preference off: opens at page ${off.page}`);

await app.close();
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
