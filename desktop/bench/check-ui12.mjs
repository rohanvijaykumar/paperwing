/**
 * Checks the 1.2 interface in the real desktop app:
 *   node bench/check-ui12.mjs
 * - quick toolbar: buttons with related tools have an arrow and a menu; the
 *   tool picked becomes the button's tool (and is remembered); shortcuts
 *   follow along
 * - tooltips: shown on hover, with the shortcut; native titles moved aside
 * - a full-page tool hides the right rail; closing it brings it back
 * - page thumbnails: right-click menu, delete, move, rotate, undo, redo;
 *   Ctrl+click selects several pages; a PDF dropped on them is inserted
 * - a newer version: a notice that stays, and a marker on Help
 * - unsaved edits get a recovery copy; after a crash they come back
 * - a full-page tool with unsaved work asks before closing
 * Uses the sample documents in docs/screenshots/samples/.
 */
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './harness.mjs';

const SAMPLES = new URL('../../docs/screenshots/samples/', import.meta.url);
const REPORT = 'Halcyon Annual Report 2026.pdf'; // 4 pages
const CONTRACT = 'Service Agreement - Northbeam.pdf';

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures++;
};
const until = async (page, fn, arg, timeout = 20000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true;
    await sleep(150);
  }
  return false;
};

async function drop(page, name) {
  const b64 = readFileSync(new URL(name, SAMPLES)).toString('base64');
  await page.evaluate(
    (b64, name) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type: 'application/pdf' }));
      window.dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: dt,
          bubbles: true,
          cancelable: true,
        })
      );
    },
    b64,
    name
  );
  await until(
    page,
    () =>
      document.querySelector('#view-doc.is-active') &&
      !document.querySelector('#doc-stage.is-loading')
  );
  await sleep(1500);
}

const pages = (page) =>
  page.evaluate(() => {
    const v = window.__acro.viewer;
    return v.pageInfo(v.current)?.total ?? 0;
  });

let app = await launch();
const profile = app.userData;
let { page } = app;
await page.setViewport({ width: 1440, height: 900 });
// The report opened from disk (a real path), as from Explorer or Finder
await app.openFile(fileURLToPath(new URL(REPORT, SAMPLES)));
await until(
  page,
  () =>
    document.querySelector('#view-doc.is-active') &&
    !document.querySelector('#doc-stage.is-loading')
);
await sleep(1500);

/* Quick toolbar ------------------------------------------------------- */
const qb = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('#quickbar .qb-item')].map((i) => ({
      label: i.querySelector('.qb-btn')?.getAttribute('aria-label'),
      arrow: !!i.querySelector('.qb-arrow'),
      active: i.querySelector('.qb-btn')?.classList.contains('is-active'),
    }))
  );
let bar = await qb();
check(
  JSON.stringify(bar.map((b) => b.arrow)) ===
    JSON.stringify([true, true, true, true, true, false, false]),
  `arrows on the buttons with related tools only: ${bar.map((b) => `${b.label}${b.arrow ? '▾' : ''}`).join(', ')}`
);
// Open the highlight button's menu with its arrow
await page.evaluate(() =>
  document
    .querySelectorAll('#quickbar .qb-item')[2]
    .querySelector('.qb-arrow')
    .click()
);
await sleep(300);
const menu = await page.evaluate(() =>
  [...document.querySelectorAll('.popover .menu-item')].map(
    (b) =>
      `${b.textContent.trim()}${b.classList.contains('is-checked') ? '✓' : ''}`
  )
);
check(
  menu.length === 5 &&
    menu[0].startsWith('Highlight text') &&
    menu[0].endsWith('✓'),
  `highlight menu: ${menu.join(' | ')}`
);
await page.evaluate(() =>
  [...document.querySelectorAll('.popover .menu-item')]
    .find((b) => b.textContent.includes('Underline'))
    .click()
);
await sleep(500);
bar = await qb();
check(
  bar[2].label === 'Underline text' && bar[2].active,
  `picked tool becomes the button's (and is on): ${bar[2].label}, active=${bar[2].active}`
);
check(
  await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem('paperwing:prefs')).quickbarTools
        .highlight === 'underline'
  ),
  'the choice is remembered'
);
// Escape goes back to selecting without forgetting the choice
await page.keyboard.press('Escape');
await sleep(400);
bar = await qb();
check(
  bar[0].active && bar[2].label === 'Underline text',
  'Escape: back to Select, button keeps its tool'
);
// Shortcut: D (draw) then Shift+D steps through the shapes on the draw button
await page.keyboard.press('KeyD');
await sleep(300);
await page.keyboard.down('Shift');
await page.keyboard.press('KeyD');
await page.keyboard.up('Shift');
await sleep(400);
bar = await qb();
check(
  bar[3].label === 'Rectangle' && bar[3].active,
  `Shift+D puts a shape on the draw button: ${bar[3].label}`
);
await page.keyboard.press('Escape');
await sleep(300);
// The select button's hand
await page.keyboard.press('KeyH');
await sleep(400);
bar = await qb();
check(
  bar[0].label === 'Hand' && bar[0].active,
  `H switches the select button to the hand: ${bar[0].label}`
);
await page.keyboard.press('KeyV');
await sleep(400);
bar = await qb();
check(bar[0].label === 'Select', `V back to Select: ${bar[0].label}`);

/* Tooltips ------------------------------------------------------------ */
const zoomIn = await page.$('#right-rail [aria-label="Zoom in"]');
const box = await zoomIn.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await sleep(900);
const tip = await page.evaluate(() => {
  const t = document.querySelector('.pw-tip.is-shown');
  return t ? t.textContent : null;
});
check(tip === 'Zoom in', `tooltip on hover: "${tip}"`);
check(
  await page.evaluate(
    () =>
      !document
        .querySelector('#right-rail [aria-label="Zoom in"]')
        .hasAttribute('title')
  ),
  'native title moved aside (no second browser tooltip)'
);
await page.mouse.move(700, 450);
await sleep(300);

/* Full-page tool hides the rail ---------------------------------------- */
await page.evaluate(() =>
  [...document.querySelectorAll('#left-panel .lp-tool')]
    .find((x) => x.textContent.trim() === 'Organize pages')
    .click()
);
await until(
  page,
  () =>
    document.querySelector('.frame-body') &&
    !document.querySelector('.frame-body.is-loading')
);
check(
  await page.evaluate(
    () =>
      getComputedStyle(document.querySelector('#right-rail')).display === 'none'
  ),
  'full-page tool: rail hidden'
);
await page.evaluate(() =>
  document.querySelector('.full-head .pill-btn').click()
);
await sleep(600);
check(
  await page.evaluate(
    () =>
      getComputedStyle(document.querySelector('#right-rail')).display !== 'none'
  ),
  'closed: rail back'
);

/* Page thumbnails ------------------------------------------------------ */
await page.evaluate(() =>
  document
    .querySelector('#right-rail [data-panel="sidebar-panel:thumbnails"]')
    .click()
);
await sleep(2500);
const thumb = async (n) =>
  page.evaluate((n) => {
    const out = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll('div')) {
        if (
          el.style.position === 'absolute' &&
          el.textContent.trim() === String(n) &&
          el.querySelector('img')
        ) {
          const r = el.querySelector('img').getBoundingClientRect();
          out.push({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        }
      }
      for (const el of root.querySelectorAll('*'))
        if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(document);
    return out[0] ?? null;
  }, n);
let t2 = await thumb(2);
check(!!t2, 'thumbnail 2 found');
await page.mouse.click(t2.x, t2.y, { button: 'right' });
await sleep(400);
const pmenu = await page.evaluate(() =>
  [...document.querySelectorAll('.popover .menu-item')].map((b) =>
    b.textContent.trim()
  )
);
check(
  pmenu.includes('Delete page') &&
    pmenu.includes('Rotate clockwise') &&
    pmenu.includes('Extract page'),
  `page menu: ${pmenu.join(' | ')}`
);
await page.evaluate(() =>
  [...document.querySelectorAll('.popover .menu-item')]
    .find((b) => b.textContent.trim() === 'Delete page')
    .click()
);
check(
  await until(
    page,
    () =>
      window.__acro.viewer.pageInfo(window.__acro.viewer.current)?.total === 3
  ),
  `delete: ${await pages(page)} pages`
);
check(
  await page.evaluate(
    () =>
      !!document.querySelector('#tabs [role="tab"].is-dirty, #tabs .is-dirty')
  ),
  'the tab shows unsaved changes'
);
await sleep(800);
await page.keyboard.down('Control');
await page.keyboard.press('KeyZ');
await page.keyboard.up('Control');
check(
  await until(
    page,
    () =>
      window.__acro.viewer.pageInfo(window.__acro.viewer.current)?.total === 4
  ),
  `undo: ${await pages(page)} pages`
);
await sleep(800);
await page.keyboard.down('Control');
await page.keyboard.down('Shift');
await page.keyboard.press('KeyZ');
await page.keyboard.up('Shift');
await page.keyboard.up('Control');
check(
  await until(
    page,
    () =>
      window.__acro.viewer.pageInfo(window.__acro.viewer.current)?.total === 3
  ),
  `redo: ${await pages(page)} pages`
);
await sleep(800);
// Drag page 1 below page 2 (the panel shows pages 1-3 now)
const firstText = async () =>
  page.evaluate(async () => {
    const v = window.__acro.viewer;
    const reg = v.registry;
    const core = (reg.store?.getState?.() ?? reg.getStore().getState()).core;
    const doc = core.documents[v.docIds.get(v.current)].document;
    const engine = reg.engine ?? reg.getEngine();
    const [t] = await engine
      .getTextSlices(doc, [{ pageIndex: 0, charIndex: 0, charCount: 400 }])
      .toPromise();
    return t.replace(/\s+/g, ' ').trim();
  });
const before = await firstText();
const a = await thumb(1);
const b2 = await thumb(2);
await page.mouse.move(a.x, a.y);
await page.mouse.down();
await page.mouse.move(a.x, a.y + 20, { steps: 4 });
await page.mouse.move(b2.x, b2.y + 70, { steps: 10 });
await sleep(200);
await page.mouse.up();
await sleep(500);
await sleep(2500);
const after = await firstText();
check(
  before !== after,
  `drag moved page 1: first page now starts "${after.slice(0, 30)}" (was "${before.slice(0, 30)}")`
);

/* Several pages selected, and PDFs dropped onto the thumbnails --------- */
const selected = () =>
  page.evaluate(() => {
    let n = 0;
    const walk = (root) => {
      n += root.querySelectorAll('[data-pw-selected]').length;
      for (const el of root.querySelectorAll('*'))
        if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(document);
    return n;
  });
await sleep(800);
const s1 = await thumb(1);
const s2 = await thumb(2);
// Page 1 (the selection starts from the current page), then Ctrl+click 2
await page.mouse.click(s1.x, s1.y);
await sleep(600);
await page.keyboard.down('Control');
await page.mouse.click(s2.x, s2.y);
await page.keyboard.up('Control');
await sleep(400);
check(
  (await selected()) === 2,
  `Ctrl+click selects two pages: ${await selected()}`
);
await page.mouse.click(s2.x, s2.y, { button: 'right' });
await sleep(400);
const smenu = await page.evaluate(() =>
  [...document.querySelectorAll('.popover .menu-item')].map((b) =>
    b.textContent.trim()
  )
);
check(
  smenu.includes('Rotate 2 pages clockwise') &&
    smenu.includes('Extract 2 pages') &&
    smenu.includes('Delete 2 pages'),
  `menu for the selection: ${smenu.join(' | ')}`
);
await page.evaluate(() =>
  [...document.querySelectorAll('.popover .menu-item')]
    .find((b) => b.textContent.trim() === 'Delete 2 pages')
    .click()
);
check(
  await until(
    page,
    () =>
      window.__acro.viewer.pageInfo(window.__acro.viewer.current)?.total === 1
  ),
  `deleting the selection: ${await pages(page)} page left`
);
await sleep(800);
await page.keyboard.down('Control');
await page.keyboard.press('KeyZ');
await page.keyboard.up('Control');
check(
  await until(
    page,
    () =>
      window.__acro.viewer.pageInfo(window.__acro.viewer.current)?.total === 3
  ),
  `undo brings them back: ${await pages(page)} pages`
);
await sleep(1500);
check((await selected()) === 0, 'the selection is cleared after a change');

// Drop a 2-page PDF before the first page
const tabsBefore = await page.evaluate(
  () => document.querySelectorAll('#tabs [role="tab"]:not(.tab-home)').length
);
const t1 = await thumb(1);
const dropB64 = readFileSync(new URL(CONTRACT, SAMPLES)).toString('base64');
await page.evaluate(
  (b64, y) => {
    let target = null;
    const walk = (root) => {
      for (const el of root.querySelectorAll('div'))
        if (
          !target &&
          el.style.position === 'absolute' &&
          el.textContent.trim() === '1' &&
          el.querySelector('img')
        )
          target = el.querySelector('img');
      for (const el of root.querySelectorAll('*'))
        if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(document);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(
      new File([bytes], 'Contract.pdf', { type: 'application/pdf' })
    );
    const r = target.getBoundingClientRect();
    const at = { clientX: r.x + r.width / 2, clientY: r.y + 4 };
    const fire = (type) =>
      target.dispatchEvent(
        new DragEvent(type, {
          dataTransfer: dt,
          bubbles: true,
          cancelable: true,
          composed: true,
          ...at,
        })
      );
    fire('dragenter');
    fire('dragover');
    fire('drop');
  },
  dropB64,
  t1.y
);
check(
  await until(
    page,
    () =>
      window.__acro.viewer.pageInfo(window.__acro.viewer.current)?.total === 5
  ),
  `dropping a 2-page PDF on the thumbnails inserts it: ${await pages(page)} pages`
);
check(
  (await page.evaluate(
    () => document.querySelectorAll('#tabs [role="tab"]:not(.tab-home)').length
  )) === tabsBefore,
  'it is inserted, not opened in a new tab'
);
check(
  (await firstText()).startsWith('Northbeam'),
  `inserted at the start: "${(await firstText()).slice(0, 30)}"`
);

/* Recovery of unsaved edits -------------------------------------------- */
const unsaved = join(profile, 'Unsaved');
await sleep(6000); // past the recovery delay
const copies = existsSync(unsaved)
  ? readdirSync(unsaved).filter((f) => f.endsWith('.pdf'))
  : [];
check(
  copies.length === 1,
  `unsaved edits copied for recovery: ${copies.join(', ')}`
);
// Crash: kill the app, then start it again with the same profile
app.child.kill();
await sleep(1500);
app = await launch({ profile });
page = app.page;
await page.setViewport({ width: 1440, height: 900 });
const recovered = await until(
  page,
  () =>
    [...document.querySelectorAll('#tabs [role="tab"]')].some((t) =>
      t.textContent.includes('(Recovered)')
    ),
  undefined,
  30000
);
check(recovered, 'after a crash the edits come back as "… (Recovered).pdf"');
check(
  await until(
    page,
    () =>
      window.__acro.viewer.pageInfo(window.__acro.viewer.current)?.total === 5,
    undefined,
    15000
  ),
  `the recovered copy has the edits (5 pages): ${await pages(page)}`
);

/* A full-page tool with unsaved work asks before closing --------------- */
await drop(page, CONTRACT);
await page.evaluate(() =>
  [...document.querySelectorAll('#left-panel .lp-tool')]
    // (the shown tab's panel: other tabs keep theirs, hidden)
    .find(
      (x) =>
        x.textContent.trim() === 'Prepare a form' &&
        x.getClientRects().length > 0
    )
    .click()
);
await until(
  page,
  () =>
    document.querySelector('.frame-body') &&
    !document.querySelector('.frame-body.is-loading')
);
await sleep(2500);
const frame = page.frames().find((f) => f.url().includes('form-creator'));
// A change in the tool: place a text field (the Text tool, then the page)
const frameEl = await frame.frameElement();
const fb = await frameEl.boundingBox();
const at = (r) => ({
  x: fb.x + r.x + r.width / 2,
  y: fb.y + r.y + r.height / 2,
});
const toolRect = await frame.evaluate(() => {
  const t = document.querySelector('.tool-item[data-type="text"]');
  const r = t?.getBoundingClientRect();
  return r && r.width
    ? { x: r.x, y: r.y, width: r.width, height: r.height }
    : null;
});
const canvasRect = await frame.evaluate(() => {
  const c = document.querySelector('canvas');
  const r = c?.getBoundingClientRect();
  return r && r.width
    ? { x: r.x, y: r.y, width: r.width, height: r.height }
    : null;
});
const changed = !!toolRect && !!canvasRect;
if (changed) {
  const t = at(toolRect);
  await page.mouse.click(t.x, t.y);
  await sleep(300);
  const c = at({ ...canvasRect, height: canvasRect.height / 2 });
  await page.mouse.click(c.x, c.y);
}
await sleep(1500);
await page.evaluate(() =>
  document.querySelector('.full-head .pill-btn').click()
);
await sleep(500);
const asked = await page.evaluate(
  () => document.querySelector('.dlg-backdrop')?.textContent ?? ''
);
check(
  changed && /Discard changes in Prepare a form/.test(asked),
  `closing asks: "${asked.slice(0, 70)}"`
);
await page.evaluate(() =>
  [...document.querySelectorAll('.dlg-backdrop button')]
    .find((b) => /Keep working/.test(b.textContent))
    ?.click()
);
await sleep(400);
check(
  await page.evaluate(() => !!document.querySelector('#tool-full .frame-wrap')),
  '"Keep working" keeps the tool open'
);

/* A newer version (builds that don't update themselves) ---------------- */
await page.evaluate(() => {
  const real = window.fetch;
  window.fetch = (url, ...rest) =>
    new URL(String(url), location.href).hostname === 'api.github.com'
      ? Promise.resolve(
          new Response(
            JSON.stringify({
              tag_name: 'v9.9.9',
              html_url:
                'https://github.com/owner/paperwing/releases/tag/v9.9.9',
              assets: [
                {
                  name: 'Paperwing-Portable-9.9.9-win-x64.zip',
                  browser_download_url: 'https://example.invalid/portable.zip',
                },
              ],
            })
          )
        )
      : real(url, ...rest);
  document.querySelector('#help-btn').click();
});
await sleep(300);
await page.evaluate(() =>
  [...document.querySelectorAll('.popover .menu-item')]
    .find((b) => /Check for updates/.test(b.textContent))
    .click()
);
await sleep(800);
const notice = await page.evaluate(() => ({
  text: document.querySelector('#update-toast')?.textContent ?? '',
  dot: document.querySelector('#help-btn').classList.contains('has-update'),
}));
check(
  /9\.9\.9 is available/.test(notice.text) && /Download/.test(notice.text),
  `update notice: "${notice.text}"`
);
check(notice.dot, 'Help shows a dot');
await sleep(5500);
check(
  await page.evaluate(() => !!document.querySelector('#update-toast')),
  'the notice stays (after 5 s)'
);
await page.evaluate(() =>
  [...document.querySelectorAll('#update-toast button')]
    .find((b) => b.textContent.trim() === 'Later')
    .click()
);
await page.evaluate(() => document.querySelector('#help-btn').click());
await sleep(300);
const hmenu = await page.evaluate(() =>
  [...document.querySelectorAll('.popover .menu-item')].map((b) =>
    b.textContent.trim()
  )
);
check(
  hmenu[0] === 'Download Paperwing 9.9.9',
  `Help menu after "Later": ${hmenu.slice(0, 2).join(' | ')}`
);
await page.keyboard.press('Escape');
await page.evaluate(() => localStorage.removeItem('paperwing:availableUpdate'));

await page.evaluate(() => {
  // Leave without prompts
  window.onbeforeunload = null;
});
app.child.kill();
await sleep(1000);
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
