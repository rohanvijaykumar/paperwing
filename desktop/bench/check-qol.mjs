/**
 * Quality-of-life checks (1.2.2):
 *  - files with the same name show their folder (tabs and Home's Recent)
 *  - the tab right-click menu
 *  - a notice when another app saves an open file, with Reload and Dismiss
 *  - saving asks before replacing a newer version saved by another app
 *  - the window comes back where it was (size, place, maximized)
 *   node bench/check-qol.mjs
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { launch, sleep } from './harness.mjs';

const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts } = require('../../node_modules/pdf-lib');

const TMP = process.env.BENCH_TMP || 'D:/tmp/paperwing-bench';
const root = join(TMP, 'qol files');
rmSync(root, { recursive: true, force: true });
async function writePdf(file, pages, label) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++)
    doc.addPage([400, 300]).drawText(`${label} ${i + 1}/${pages}`, {
      x: 40,
      y: 150,
      size: 24,
      font,
    });
  writeFileSync(file, await doc.save());
}
async function pdf(dir, name, pages, label) {
  mkdirSync(join(root, dir), { recursive: true });
  const file = join(root, dir, name);
  await writePdf(file, pages, label);
  return file;
}
const pagesOnDisk = async (file) =>
  (await PDFDocument.load(readFileSync(file))).getPageCount();

const A = await pdf('Acme Corp/Product Manager', 'Rohan_Resume.pdf', 1, 'Acme');
const B = await pdf('Globex/Product Manager', 'Rohan_Resume.pdf', 2, 'Globex');
const C = await pdf('Initech', 'Cover letter.pdf', 3, 'Initech');

let failed = 0;
const check = (ok, what, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
};
const until = async (fn, timeout = 15000) => {
  const end = Date.now() + timeout;
  let v;
  while (Date.now() < end) {
    v = await fn();
    if (v) return v;
    await sleep(200);
  }
  return v;
};

const profile = mkdtempSync(join(TMP, 'pw-qol-'));
let app = await launch({ profile, args: [A] });
let page = app.page;

const pagesShown = () =>
  page.evaluate(() => {
    const v = window.__acro.viewer;
    return v.current ? (v.pageInfo(v.current)?.total ?? 0) : 0;
  });
const tabNames = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('#tabs .tab')].map((t) => ({
      name: t.querySelector('.tab-label')?.textContent,
      hint: t.querySelector('.tab-hint')?.textContent ?? '',
      active: t.classList.contains('is-active'),
    }))
  );
const dirty = () =>
  page.evaluate(
    () => !!document.querySelector('#tabs .tab.is-active.is-dirty')
  );
const dialogTitle = () =>
  page.evaluate(() => document.querySelector('.dlg h2')?.textContent ?? null);
const clickButton = (selector, label) =>
  page.evaluate(
    (selector, label) =>
      [...document.querySelectorAll(selector)]
        .find((b) => b.textContent.trim() === label)
        ?.click(),
    selector,
    label
  );
const barText = () =>
  page.evaluate(
    () => document.querySelector('#disk-bar .db-text')?.textContent ?? null
  );
const edit = () =>
  page.evaluate(() => {
    const v = window.__acro.viewer;
    const a = v.cap('annotation').forDocument(v.docIds.get(v.current));
    const rect = {
      origin: { x: 40, y: 140 },
      size: { width: 120, height: 30 },
    };
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

await until(async () => (await pagesShown()) === 1);
await app.openFile(B);
await until(async () => (await pagesShown()) === 2);
await app.openFile(C);
await until(async () => (await pagesShown()) === 3);

// 1. Same names, different folders
let t = await tabNames();
check(
  t.length === 3 &&
    t[0].hint === 'Acme Corp' &&
    t[1].hint === 'Globex' &&
    t[2].hint === '',
  'tabs with the same name show their folder; unique names show none',
  t.map((x) => `${x.name}${x.hint ? ` [${x.hint}]` : ''}`).join(' | ')
);
await page.click('#home-btn');
const kinds = await until(async () => {
  const k = await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '#recent-list .recent-row:not(.recent-header) .rr-kind'
      ),
    ].map((e) => e.textContent)
  );
  return k.length === 3 ? k : null;
});
check(
  !!kinds &&
    kinds.includes('PDF · Acme Corp') &&
    kinds.includes('PDF · Globex') &&
    kinds.includes('PDF'),
  "Home's Recent list shows the folder for same-named files",
  JSON.stringify(kinds)
);

// 1b. The taskbar's Recent list (Windows jump list). Windows' own list kept
// one entry per file name; Paperwing keeps its own, newest first, and names
// same-named files by their folder. (The jump list itself is only set by an
// installed copy: this checks the list and the titles it's built from.)
const recentJson = join(profile, 'recent-files.json');
const recent = await until(() => {
  try {
    const l = JSON.parse(readFileSync(recentJson, 'utf8'));
    return l.length === 3 ? l : null;
  } catch {
    return null;
  }
});
check(
  !!recent && recent[0] === C && recent[1] === B && recent[2] === A,
  'every opened file is on the Recent list, newest first (same names too)',
  JSON.stringify(recent?.map((p) => p.slice(root.length)))
);
const mainSrc = readFileSync(new URL('../main.cjs', import.meta.url), 'utf8');
const hintsSrc = mainSrc.slice(
  mainSrc.indexOf('function folderHints'),
  mainSrc.indexOf('function updateJumpList')
);
const jumpHints = new Function('path', `${hintsSrc}; return folderHints;`)(
  require('node:path')
);
const hints = jumpHints(recent ?? []);
check(
  JSON.stringify(hints) === JSON.stringify(['', 'Globex', 'Acme Corp']),
  'jump list titles name same-named files by their folder',
  JSON.stringify(hints)
);
check(
  JSON.stringify(
    jumpHints([
      'D:/a/Acme/PM/r.pdf',
      'D:/a/Globex/PM/r.pdf',
      'D:/a/Initech/r.pdf',
    ])
  ) === JSON.stringify(['Acme › PM', 'Globex › PM', 'Initech']),
  'a shared parent folder is skipped for the one that tells them apart'
);
await page.click('#clear-recent');
await until(dialogTitle, 5000);
await clickButton('.dlg button', 'Clear');
check(
  !!(await until(() => !existsSync(recentJson), 5000)),
  "Home's Clear recent clears the taskbar's list too"
);

// 2. Tab right-click menu
const tabEls = await page.$$('#tabs .tab');
await tabEls[1].click({ button: 'right' });
const items = await until(() =>
  page.evaluate(() => {
    const labels = [
      ...document.querySelectorAll('.menu .menu-item .mi-label'),
    ].map((e) => e.textContent);
    return labels.length ? labels : null;
  })
);
check(
  !!items &&
    [
      'Close',
      'Close other tabs',
      'Close tabs to the right',
      'Copy path',
      'Reopen closed document',
    ].every((l) => items.includes(l)) &&
    items.some((l) => /^Show in (File Explorer|Finder)$/.test(l)),
  'right-clicking a tab offers close, close others, close to the right, show in folder, copy path, reopen',
  JSON.stringify(items)
);
await clickButton('.menu .menu-item', 'Close tabs to the right');
t = await until(async () => {
  const x = await tabNames();
  return x.length === 2 ? x : null;
});
check(
  !!t && t.map((x) => x.name).join(',') === 'Rohan_Resume.pdf,Rohan_Resume.pdf',
  '"Close tabs to the right" closes only the tabs after it',
  JSON.stringify(t?.map((x) => x.hint))
);

// 3. Another app saves an open file
await (await page.$$('#tabs .tab'))[1].click(); // Globex
await until(async () => (await pagesShown()) === 2);
await writePdf(B, 4, 'Globex v2');
let text = await until(barText, 10000);
check(
  /changed by another app/.test(text ?? ''),
  'a notice appears when another app saves the open file',
  text ?? 'no notice'
);
check(
  (await pagesShown()) === 2,
  'the document isn’t replaced until you choose'
);
await (await page.$$('#tabs .tab'))[0].click(); // Acme
await sleep(400);
check(!(await barText()), 'the notice is only on that file’s tab');
await (await page.$$('#tabs .tab'))[1].click();
await sleep(400);
check(!!(await barText()), 'it’s still there on returning to the tab');
await page.click('#disk-bar .db-reload');
check(
  (await until(async () => (await pagesShown()) === 4)) === true,
  'Reload shows the new version',
  `${await pagesShown()} page(s)`
);
check(
  !(await barText()) && !(await dirty()),
  'after reloading: no notice, nothing unsaved'
);

await writePdf(B, 5, 'Globex v3');
text = await until(barText, 10000);
check(!!text, 'a second change brings the notice back');
await page.click('#disk-bar .db-close');
await sleep(400);
check(
  !(await barText()) && (await pagesShown()) === 4,
  'Dismiss hides it and keeps the current document'
);

// 4. Saving over a newer version
await edit();
await until(dirty, 5000);
await page.click('#save-btn');
let title = await until(dialogTitle, 5000);
check(
  /newer version/.test(title ?? ''),
  'saving asks first when another app saved a newer version',
  title ?? 'no question'
);
await clickButton('.dlg button', 'Cancel');
await sleep(600);
check(
  (await dirty()) && (await pagesOnDisk(B)) === 5,
  'Cancel leaves the newer version on disk and your changes unsaved'
);
await page.click('#save-btn');
await until(dialogTitle, 5000);
await clickButton('.dlg button', 'Replace it');
await until(async () => !(await dirty()), 8000);
check(
  !(await dirty()) && (await pagesOnDisk(B)) === 4,
  '"Replace it" saves your version over it',
  `${await pagesOnDisk(B)} page(s) on disk`
);
await sleep(2500);
check(!(await barText()), 'Paperwing’s own save doesn’t bring up the notice');
await edit();
await until(dirty, 5000);
await page.click('#save-btn');
await until(async () => !(await dirty()), 8000);
check(
  !(await dialogTitle()) && !(await dirty()),
  'saving again (nothing newer on disk) just saves'
);

// 5. The window comes back where it was. Moved and maximized through Windows
// itself, as a user would (Electron has no DevTools command for it)
function win32(pid, action) {
  const ps = `Add-Type -Name W -Namespace U -MemberDefinition '[DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool r); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);'; $h = (Get-Process -Id ${pid}).MainWindowHandle; ${action}`;
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    ps,
  ]);
}
const geometry = () =>
  page.evaluate(() => ({
    x: screenX,
    y: screenY,
    w: outerWidth,
    h: outerHeight,
  }));
if (process.platform === 'win32') {
  win32(
    app.child.pid,
    '[U.W]::ShowWindow($h, 9) | Out-Null; [U.W]::MoveWindow($h, 160, 110, 1180, 760, $true) | Out-Null'
  );
  await sleep(1200);
  const placed = await geometry();
  await app.close();
  app = await launch({ profile });
  page = app.page;
  const back = await geometry();
  const near = (a, b) => Math.abs(a - b) <= 16;
  check(
    placed.w !== 1400 &&
      near(back.x, placed.x) &&
      near(back.y, placed.y) &&
      near(back.w, placed.w) &&
      near(back.h, placed.h),
    'size and place are remembered',
    `left at ${JSON.stringify(placed)}, came back at ${JSON.stringify(back)}`
  );
  // Restarting again must not grow it (it did by a few pixels a run at 125%)
  for (let i = 0; i < 2; i++) {
    await app.close();
    app = await launch({ profile });
    page = app.page;
  }
  const again = await geometry();
  check(
    JSON.stringify(again) === JSON.stringify(back),
    'it stays the same size over restarts',
    `${JSON.stringify(back)} → ${JSON.stringify(again)}`
  );
  win32(app.child.pid, '[U.W]::ShowWindow($h, 3) | Out-Null');
  await sleep(1200);
  await app.close();
  app = await launch({ profile });
  page = app.page;
  const max = await page.evaluate(() => ({
    w: outerWidth,
    aw: screen.availWidth,
    h: outerHeight,
    ah: screen.availHeight,
  }));
  check(
    max.w >= max.aw - 20 && max.h >= max.ah - 20,
    'maximized is remembered',
    JSON.stringify(max)
  );
} else console.log('skip window placement (Windows only in this check)');
// Off-screen (a monitor that's gone): it comes back at the default place
await app.close();
writeFileSync(
  join(profile, 'window-state.json'),
  JSON.stringify({
    bounds: { x: -30000, y: -30000, width: 1200, height: 800 },
    maximized: false,
  })
);
app = await launch({ profile });
page = app.page;
const lost = await page.evaluate(() => ({
  x: screenX,
  y: screenY,
  w: outerWidth,
}));
check(
  lost.x > -2000 && lost.y > -2000,
  'a place on a screen that’s no longer there is ignored',
  JSON.stringify(lost)
);

await app.close();
rmSync(root, { recursive: true, force: true });
rmSync(profile, {
  recursive: true,
  force: true,
  maxRetries: 10,
  retryDelay: 200,
});
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
