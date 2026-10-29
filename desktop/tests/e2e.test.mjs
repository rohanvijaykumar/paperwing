/**
 * End-to-end smoke tests for the Paperwing interface.
 *
 * Runs against a served copy of the web app (Vite dev server or
 * `vite preview` of the desktop build) in a real Chromium:
 *
 *   PAPERWING_URL=http://localhost:5173 npm run test:e2e
 *
 * Chrome/Chromium is located automatically, or set CHROME_PATH.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';

const BASE = (process.env.PAPERWING_URL || 'http://localhost:5173').replace(
  /\/$/,
  ''
);
const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = resolve(
  here,
  '..',
  '..',
  'src',
  'tests',
  'fixtures',
  'sample.pdf'
);

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('Chrome not found: set CHROME_PATH');
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll a function in a page or frame until it returns a truthy value.
 *  (Not waitForFunction for tool frames: its requestAnimationFrame poller
 *  could start in the iframe's initial blank document and never run again
 *  once the tool page replaced it, timing out on a page that was ready.)
 *  A frame that's still navigating is asked again on the next poll. */
async function waitFor(page, fn, arg, timeout = 15000) {
  const end = Date.now() + timeout;
  let error;
  for (;;) {
    try {
      const v = await page.evaluate(fn, arg);
      if (v) return v;
      error = undefined;
    } catch (e) {
      error = e;
    }
    if (Date.now() > end)
      throw new Error(
        `Timed out waiting for: ${fn}${error ? ` (${error.message})` : ''}`
      );
    await sleep(150);
  }
}

let browser;
let page;
const pdfBase64 = readFileSync(SAMPLE).toString('base64');
const protectedBase64 = readFileSync(
  resolve(dirname(SAMPLE), 'protected.pdf') // password: secret
).toString('base64');

async function openApp(scheme = 'light') {
  await page.emulateMediaFeatures([
    { name: 'prefers-color-scheme', value: scheme },
  ]);
  await page.goto(`${BASE}/app.html`, { waitUntil: 'domcontentloaded' });
  await waitFor(page, () => 'ready' in document.documentElement.dataset);
}

/** Drop a PDF onto the window like a user would, without waiting for it */
async function dropBytes(name, b64) {
  await page.evaluate(
    async ({ b64, name }) => {
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
    { b64, name }
  );
}

/** Drop a PDF onto the window like a user would */
async function dropPdf(name = 'sample.pdf') {
  await page.evaluate(
    async ({ b64, name }) => {
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
    { b64: pdfBase64, name }
  );
  await waitFor(
    page,
    () =>
      !document.querySelector('#doc-stage.is-loading') &&
      document.querySelector('#view-doc.is-active')
  );
  await sleep(800);
}

const tabNames = () =>
  page.$$eval('#tabs .tab-label', (els) => els.map((e) => e.textContent));

/** Where the form fields of formPdf are (PDF points, from the bottom left) */
const FIELDS = {
  name: { x: 50, y: 640, width: 320, height: 48 },
  agree: { x: 50, y: 560, width: 40, height: 40 },
};

/** A one-page form made with pdf-lib, as base64: a text field (name), a
 *  checkbox (agree) and a read-only field; optionally a script that runs
 *  when it opens */
async function formPdf({ text = '', checked = false, script = false } = {}) {
  const doc = await PDFDocument.create();
  const p = doc.addPage([612, 792]);
  const form = doc.getForm();
  const name = form.createTextField('name');
  name.setText(text || undefined);
  name.addToPage(p, { ...FIELDS.name, borderWidth: 0 });
  name.setFontSize(28);
  const agree = form.createCheckBox('agree');
  agree.addToPage(p, { ...FIELDS.agree, borderWidth: 0 });
  if (checked) agree.check();
  const ref = form.createTextField('reference');
  ref.setText('REF-1');
  ref.enableReadOnly();
  ref.addToPage(p, { x: 50, y: 400, width: 200, height: 30 });
  if (script)
    doc.catalog.set(
      PDFName.of('OpenAction'),
      doc.context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(1)') })
    );
  return Buffer.from(await doc.save()).toString('base64');
}

/** Dark pixels inside each form field, on page 1 of the active document as
 *  the viewer renders it (options: the viewer's render options) */
const inkInFields = (options = {}) =>
  page.evaluate(
    async ({ options, fields }) => {
      const v = window.__acro.viewer;
      const id = v.docIds.get(v.current);
      const blob = await v
        .cap('render')
        .forDocument(id)
        .renderPage({ pageIndex: 0, options: { scaleFactor: 1, ...options } })
        .toPromise();
      const img = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(img.width, img.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const scale = img.width / 612;
      const ink = {};
      for (const [field, r] of Object.entries(fields)) {
        const { data } = ctx.getImageData(
          Math.round(r.x * scale),
          Math.round((792 - r.y - r.height) * scale),
          Math.round(r.width * scale),
          Math.round(r.height * scale)
        );
        let dark = 0;
        for (let i = 0; i < data.length; i += 4)
          if (data[i] + data[i + 1] + data[i + 2] < 300) dark++;
        ink[field] = dark;
      }
      return ink;
    },
    { options, fields: FIELDS }
  );

/** The active document as the viewer would save it, read with pdf-lib */
async function exportedForm() {
  const b64 = await page.evaluate(async () => {
    const v = window.__acro.viewer;
    const bytes = new Uint8Array(await v.exportBytes(v.current));
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  const doc = await PDFDocument.load(Buffer.from(b64, 'base64'));
  return { b64, form: doc.getForm() };
}

/** Wait for a dropped document to be shown */
const shown = () =>
  waitFor(
    page,
    () =>
      !document.querySelector('#doc-stage.is-loading') &&
      document.querySelector('#view-doc.is-active') &&
      document.querySelector('#right-rail .rr-total')?.textContent === '1'
  );

describe('Paperwing UI', () => {
  before(async () => {
    browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: true,
      args: ['--no-sandbox'],
    });
    page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 860 });
    // Native dialogs: reloading the app with an unsaved document asks
    // "Leave site?" (leave); anything else is dismissed
    page.on('dialog', (d) =>
      (d.type() === 'beforeunload' ? d.accept() : d.dismiss()).catch(() => {})
    );
    await page.goto(`${BASE}/app.html`);
    await page.evaluate(() => {
      localStorage.clear();
      indexedDB.deleteDatabase('paperwing-desktop');
    });
  });

  after(async () => {
    // Close the page without its "Leave site?" check (there may be an
    // unsaved document open), then the browser
    await page?.close({ runBeforeUnload: false }).catch(() => {});
    await browser?.close();
  });

  test('loads the home view and dismisses the launch screen', async () => {
    await openApp();
    assert.equal(await page.title(), 'Paperwing');
    assert.ok(await page.$('#view-home.is-active'));
    const cards = await page.$$('#rec-tools .rec-card');
    assert.ok(cards.length >= 3, 'recommended tools shown');
  });

  test('follows the system light/dark setting', async () => {
    await openApp('dark');
    const dark = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor
    );
    await openApp('light');
    const light = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor
    );
    assert.notEqual(dark, light);
    assert.equal(light, 'rgb(255, 255, 255)');
    // Dark theme is neutral grey, not blue-tinted
    const [r, g, b] = dark.match(/\d+/g).map(Number);
    assert.ok(
      Math.abs(r - b) <= 4 && Math.abs(r - g) <= 4,
      `neutral dark: ${dark}`
    );
  });

  test('opens a dropped PDF in a document tab', async () => {
    await openApp();
    await dropPdf('Report.pdf');
    assert.deepEqual(await tabNames(), ['Report.pdf']);
    const total = await page.$eval(
      '#right-rail .rr-total',
      (e) => e.textContent
    );
    assert.equal(total, '1');
    assert.ok(await page.$('#quickbar .qb-btn'), 'quick toolbar shown');
    assert.ok(await page.$('#left-panel .lp-tool'), 'tools panel shown');
  });

  test('mirrors Acrobat shortcuts', async () => {
    const tool = () =>
      page.evaluate(() => {
        const v = window.__acro?.viewer;
        const tab = [...v.docIds.keys()][0];
        return (
          v.cap('annotation').forDocument(v.docIds.get(tab)).getActiveTool()
            ?.id ?? null
        );
      });
    await page.keyboard.press('u');
    assert.equal(await tool(), 'highlight', 'U = highlight');
    await page.keyboard.press('Escape');
    assert.equal(await tool(), null, 'Esc = back to select');
    await page.keyboard.press('d');
    assert.equal(await tool(), 'ink', 'D = draw');
    await page.keyboard.press('v');
    assert.equal(await tool(), null, 'V = select');

    await page.keyboard.down('Control');
    await page.keyboard.press('KeyD');
    await page.keyboard.up('Control');
    assert.equal(
      await page.$eval('.dlg h2', (e) => e.textContent),
      'Document properties'
    );
    await page.keyboard.press('Escape');
    await page.evaluate(() =>
      document.querySelector('.dlg-backdrop')?.remove()
    );

    await page.keyboard.down('Control');
    await page.keyboard.press('KeyK');
    await page.keyboard.up('Control');
    assert.equal(
      await page.$eval('.dlg h2', (e) => e.textContent),
      'Preferences'
    );
    await page.evaluate(() =>
      document.querySelector('.dlg-backdrop')?.remove()
    );

    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    await page.keyboard.press('KeyP');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
    assert.ok(await page.$('.find-pop .find-input'), 'command palette opens');
    await page.keyboard.press('Escape');
  });

  test('Select works on a desktop with a touchscreen, even when the viewer default is Hand', async () => {
    const previousPage = page;
    const context = await browser.createBrowserContext();
    page = await context.newPage();
    try {
      await page.setViewport({ width: 1366, height: 860, hasTouch: true });
      await openApp();
      await dropPdf('Touchscreen.pdf');
      const mode = () =>
        page.evaluate(() => {
          const v = window.__acro.viewer;
          const id = [...v.docIds.values()][0];
          return v.cap('interaction-manager').forDocument(id).getActiveMode();
        });
      assert.ok(await page.evaluate(() => navigator.maxTouchPoints > 0));
      assert.equal(
        await mode(),
        'pointerMode',
        'opening a PDF selects text by default'
      );
      await page.keyboard.press('h');
      assert.equal(await mode(), 'panMode', 'H still enables Hand');
      // Reproduce another plugin changing the default: V must still select.
      await page.evaluate(() => {
        window.__acro.viewer
          .cap('interaction-manager')
          .setDefaultMode('panMode');
      });
      await page.keyboard.press('v');
      assert.equal(
        await mode(),
        'pointerMode',
        'V explicitly enables text selection'
      );
    } finally {
      await context.close();
      page = previousPage;
    }
  });

  test('renders saved form values and checkboxes without flattening the document', async () => {
    const previousPage = page;
    const context = await browser.createBrowserContext();
    page = await context.newPage();
    try {
      const pdf = await PDFDocument.create();
      const sheet = pdf.addPage([612, 792]);
      const form = pdf.getForm();
      const text = form.createTextField('saved-text');
      text.setText('Visible saved form value');
      text.addToPage(sheet, { x: 120, y: 500, width: 210, height: 32 });
      const check = form.createCheckBox('saved-check');
      check.addToPage(sheet, { x: 120, y: 430, width: 20, height: 20 });
      check.check();
      await openApp();
      await dropBytes(
        'Saved form.pdf',
        Buffer.from(await pdf.save()).toString('base64')
      );
      await waitFor(
        page,
        () =>
          document.querySelector('#view-doc.is-active') &&
          !document.querySelector('#doc-stage.is-loading')
      );
      const rendered = await page.evaluate(async () => {
        const viewer = window.__acro.viewer;
        const id = [...viewer.docIds.values()][0];
        async function ink(options) {
          const blob = await viewer
            .cap('render')
            .renderPage({ pageIndex: 0, options }, id)
            .toPromise();
          const bitmap = await createImageBitmap(blob);
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(bitmap, 0, 0);
          const dark = (x, y, w, h) => {
            const pixels = ctx.getImageData(x, y, w, h).data;
            let count = 0;
            for (let i = 0; i < pixels.length; i += 4)
              if (pixels[i] < 100 && pixels[i + 1] < 100 && pixels[i + 2] < 100)
                count++;
            return count;
          };
          const result = {
            text: dark(123, 263, 204, 26),
            check: dark(124, 346, 12, 12),
          };
          bitmap.close();
          return result;
        }
        return {
          current: await ink({ scaleFactor: 1 }),
          withoutForms: await ink({ scaleFactor: 1, withForms: false }),
          exported: Array.from(
            new Uint8Array(
              await viewer.exportBytes([...viewer.docIds.keys()][0])
            )
          ),
        };
      });
      assert.ok(rendered.current.text > 50, 'saved text must be visible');
      assert.ok(
        rendered.current.check > 10,
        'saved checkbox mark must be visible'
      );
      assert.equal(
        rendered.withoutForms.text,
        0,
        'baseline reproduces invisible saved text'
      );
      assert.equal(
        rendered.withoutForms.check,
        0,
        'baseline reproduces invisible check mark'
      );
      const saved = await PDFDocument.load(Uint8Array.from(rendered.exported));
      assert.equal(
        saved.getForm().getTextField('saved-text').getText(),
        'Visible saved form value'
      );
      assert.equal(
        saved.getForm().getCheckBox('saved-check').isChecked(),
        true
      );
    } finally {
      await context.close();
      page = previousPage;
    }
  });

  test('tracks unsaved changes and confirms before closing', async () => {
    await page.keyboard.press('d');
    const box = await page.$eval('#viewer-host', (e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 3 };
    });
    await page.mouse.move(box.x - 60, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x, box.y + 30, { steps: 8 });
    await page.mouse.move(box.x + 60, box.y, { steps: 8 });
    await page.mouse.up();
    await waitFor(page, () => document.querySelector('#tabs .tab.is-dirty'));
    await page.keyboard.press('Escape');

    await page.keyboard.down('Control');
    await page.keyboard.press('KeyW');
    await page.keyboard.up('Control');
    await waitFor(page, () =>
      document.querySelector('.dlg[role="alertdialog"]')
    );
    const buttons = await page.$$eval('.dlg-actions button', (b) =>
      b.map((x) => x.textContent)
    );
    assert.deepEqual(buttons, ["Don't save", 'Cancel', 'Save']);
    await page.click('.dlg-actions .quiet-btn');
    await waitFor(page, () => !document.querySelector('#tabs .tab'));

    // Ctrl+Shift+T brings it back
    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    await page.keyboard.press('KeyT');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
    await waitFor(page, () => document.querySelector('#tabs .tab'));
    assert.deepEqual(await tabNames(), ['Report.pdf']);
  });

  test('runs a tool on the open document and opens the result as a new tab', async () => {
    await waitFor(page, () => !document.querySelector('#doc-stage.is-loading'));
    await page.evaluate(() =>
      [...document.querySelectorAll('.lp-tool')]
        .find((b) => b.textContent.includes('Compress'))
        .click()
    );
    const frame = await page.waitForSelector('#left-panel iframe');
    const content = await frame.contentFrame();
    await waitFor(
      content,
      () =>
        document
          .querySelector('#file-display-area')
          ?.textContent.includes('Report.pdf'),
      undefined,
      20000
    );
    await content.waitForSelector('#process-btn');
    await content.click('#process-btn');
    await waitFor(
      page,
      () => document.querySelectorAll('#tabs .tab').length === 2,
      undefined,
      60000
    );
    const names = await tabNames();
    assert.equal(names[1], 'Report (1).pdf');
  });

  test('the tools sidebar searches every tool', async () => {
    // (switching away and back guarantees the All tools list is showing)
    await page.evaluate(() =>
      document.querySelector('#gb-tabs [data-panel="edit"]').click()
    );
    await page.evaluate(() =>
      document.querySelector('#gb-tabs [data-panel="all"]').click()
    );
    await page.waitForSelector('.lp:not([hidden]) .lp-search input');
    await page.type('.lp:not([hidden]) .lp-search input', 'watermark');
    const names = await page.$$eval(
      '.lp:not([hidden]) .lp-tool span:not(.lp-pin)',
      (e) => e.map((x) => x.textContent)
    );
    assert.ok(
      names.some((n) => /watermark/i.test(n)),
      names.join(', ')
    );
    assert.equal(
      await page.$('#view-alltools'),
      null,
      'no separate All tools page'
    );
  });

  test('home lists recent files', async () => {
    await page.click('#home-btn');
    await waitFor(
      page,
      () =>
        document.querySelectorAll(
          '#recent-list .recent-row:not(.recent-header)'
        ).length > 0
    );
    const text = await page.$eval('#recent-list', (e) => e.textContent);
    assert.match(text, /Report\.pdf/);
  });

  test('Preferences can override the system theme', async () => {
    await openApp('light');
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyK');
    await page.keyboard.up('Control');
    await page.select('.pref-select', 'dark');
    const bg = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor
    );
    assert.notEqual(
      bg,
      'rgb(255, 255, 255)',
      'dark applied despite light system'
    );
    await page.select('.pref-select', 'system');
    const bg2 = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor
    );
    assert.equal(bg2, 'rgb(255, 255, 255)');
    await page.evaluate(() =>
      document.querySelector('.dlg-backdrop')?.remove()
    );
  });

  test('converters open in a workspace tab with the tool in the sidebar', async () => {
    await dropPdf('Report.pdf');
    await page.evaluate(() =>
      document.querySelector('#gb-tabs [data-panel="convert"]').click()
    );
    await page.evaluate(() =>
      [...document.querySelectorAll('.lp:not([hidden]) .lp-tool')]
        .find((b) => b.textContent.trim() === 'Word to PDF')
        .click()
    );
    await waitFor(page, () => document.querySelector('#doc-stage.is-blank'));
    const name = await page.$eval(
      '#tabs .tab.is-active .tab-label',
      (e) => e.textContent
    );
    assert.equal(name, 'Word to PDF');
    assert.ok(
      await page.$('#left-panel .lp:not([hidden]) iframe'),
      'tool shown in the sidebar'
    );
  });

  test('"See all tools" on Home opens the searchable sidebar, not a page', async () => {
    await page.click('#home-btn');
    await page.click('#see-all-tools');
    await waitFor(page, () => document.activeElement?.closest?.('.lp-search'));
    const active = await page.$eval(
      '#tabs .tab.is-active .tab-label',
      (e) => e.textContent
    );
    assert.equal(active, 'Tools');
    assert.ok(await page.$('#doc-stage.is-blank'));
  });

  test('tool pages adopt the theme and hide their own chrome when embedded', async () => {
    // Fresh page so state from earlier tests can't interfere
    await page.close();
    page = await browser.newPage();
    await page.emulateMediaFeatures([
      { name: 'prefers-color-scheme', value: 'dark' },
    ]);
    await page.goto(`${BASE}/404.html`);
    await page.evaluate(() => {
      document.body.innerHTML =
        '<iframe id="f" src="/merge-pdf.html" style="width:800px;height:600px"></iframe>';
    });
    const handle = await page.waitForSelector('#f');
    const frame = await handle.contentFrame();
    // (the class is set before the first paint, before the stylesheets have
    // loaded: check once the page has)
    await waitFor(
      frame,
      () =>
        document.documentElement.classList.contains('rs-embedded') &&
        document.readyState === 'complete'
    );
    const state = await frame.evaluate(() => ({
      navHidden: [...document.querySelectorAll('body > nav')].every(
        (n) => getComputedStyle(n).display === 'none'
      ),
      bg: getComputedStyle(document.body).backgroundColor,
    }));
    assert.ok(state.navHidden, 'navbar hidden');
    const [r, g, b] = state.bg.match(/\d+/g).map(Number);
    assert.ok(
      r < 60 && Math.abs(r - b) <= 4,
      `dark neutral background: ${state.bg}`
    );
  });
  test('a tool made before a theme change keeps the theme chosen since', async () => {
    // Its URL says "system", but the user picked dark while it loaded
    await openApp('light');
    await page.evaluate(() => localStorage.setItem('paperwing:theme', 'dark'));
    await page.evaluate(() => {
      const f = document.createElement('iframe');
      f.id = 'stale-theme';
      f.src = '/compress-pdf.html?embed=panel&theme=system';
      document.body.append(f);
    });
    const frame = await (
      await page.waitForSelector('#stale-theme')
    ).contentFrame();
    await waitFor(
      frame,
      () =>
        document.documentElement.classList.contains('rs-embedded') &&
        document.readyState === 'complete'
    );
    assert.equal(
      await page.evaluate(() => localStorage.getItem('paperwing:theme')),
      'dark',
      'the choice is still saved'
    );
    assert.equal(
      await frame.evaluate(() => document.documentElement.dataset.theme),
      'dark'
    );
    await page.evaluate(() => {
      document.getElementById('stale-theme').remove();
      localStorage.removeItem('paperwing:theme');
    });
  });
  test('asks for the password of a protected PDF', async () => {
    // Start without the documents earlier tests left in the session
    await page.evaluate(() => localStorage.removeItem('paperwing:session'));
    await openApp();
    const prompt = () =>
      waitFor(page, () =>
        document.querySelector('.dlg[aria-label="Password"] .dlg-input')
      );
    const answer = async (text) => {
      await page.$eval('.dlg-input', (el) => el.focus());
      await page.keyboard.type(text);
      await page.keyboard.press('Enter');
    };

    // Wrong password, then the right one
    await dropBytes('Locked.pdf', protectedBase64);
    await prompt();
    await answer('nope');
    await waitFor(page, () =>
      document.querySelector('.dlg-body p')?.textContent?.includes('incorrect')
    );
    await answer('secret');
    await waitFor(
      page,
      () =>
        !document.querySelector('.dlg-backdrop') &&
        !document.querySelector('#doc-stage.is-loading') &&
        document.querySelector('#right-rail .rr-total')?.textContent === '1'
    );
    assert.deepEqual(await tabNames(), ['Locked.pdf']);

    // Cancelling closes the tab quietly
    await dropBytes('Locked again.pdf', protectedBase64);
    await prompt();
    await page.keyboard.press('Escape');
    await waitFor(page, () => !document.querySelector('.dlg-backdrop'));
    await sleep(300);
    assert.deepEqual(await tabNames(), ['Locked.pdf']);
    assert.equal(
      await page.$$eval('#toasts .toast', (t) =>
        t.some((el) => el.textContent.includes("Couldn't open"))
      ),
      false
    );
  });

  test('tool frames follow the theme, and only tool frames are listened to', async () => {
    await page.evaluate(() => localStorage.removeItem('paperwing:session'));
    await openApp('light');
    await dropPdf('Report.pdf');
    await page.evaluate(() =>
      [...document.querySelectorAll('.lp-tool')]
        .find((b) => b.textContent.includes('Compress'))
        .click()
    );
    const handle = await page.waitForSelector('#left-panel iframe');
    assert.match(await handle.evaluate((f) => f.src), /[?&]theme=system\b/);
    const content = await handle.contentFrame();
    await waitFor(content, () =>
      document.documentElement.classList.contains('rs-embedded')
    );

    // Changing the theme in the workspace reaches the tool
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyK');
    await page.keyboard.up('Control');
    await page.select('.pref-select', 'dark');
    await waitFor(
      content,
      () => document.documentElement.dataset.theme === 'dark'
    );
    await page.select('.pref-select', 'system');
    await waitFor(
      content,
      () => document.documentElement.dataset.theme === undefined
    );
    await page.evaluate(() =>
      document.querySelector('.dlg-backdrop')?.remove()
    );

    // Tool messages from anything but a tool frame are ignored
    const tabs = (await tabNames()).length;
    await page.evaluate(() => {
      const blob = new Blob(['%PDF-1.4'], { type: 'application/pdf' });
      window.postMessage({ type: 'acro:download', blob, name: 'x.pdf' }, '*');
      window.postMessage(
        {
          type: 'acro:key',
          editing: false,
          key: { key: 'k', code: 'KeyK', ctrlKey: true },
        },
        '*'
      );
    });
    await sleep(500);
    assert.equal(await page.$('.dlg-backdrop'), null, 'forged key ignored');
    assert.equal((await tabNames()).length, tabs, 'forged download ignored');
  });
  test('runs a tool on several files at once from Home', async () => {
    await openApp('light');
    // Pick files through an <input>, which the test can fill in
    await page.evaluate(() => (window.showOpenFilePicker = undefined));
    const second = join(tmpdir(), 'Second.pdf');
    copyFileSync(SAMPLE, second);
    await page.click('#home-btn');
    await page.click('#see-all-tools');
    await page.waitForSelector('.lp:not([hidden]) .lp-tool');
    const [chooser] = await Promise.all([
      page.waitForFileChooser(),
      page.evaluate(() =>
        [...document.querySelectorAll('.lp:not([hidden]) .lp-tool')]
          .find((b) => b.textContent.includes('Compress'))
          .click()
      ),
    ]);
    await chooser.accept([SAMPLE, second]);
    // Both files go to the tool; neither opens as a document
    const frame = await page.waitForSelector(
      '#left-panel .lp:not([hidden]) iframe'
    );
    const content = await frame.contentFrame();
    await waitFor(
      content,
      () => {
        const text =
          document.querySelector('#file-display-area')?.textContent ?? '';
        return text.includes('sample.pdf') && text.includes('Second.pdf');
      },
      undefined,
      20000
    );
    const names = await tabNames();
    assert.ok(
      !names.includes('sample.pdf') && !names.includes('Second.pdf'),
      `files not opened as tabs (${names.join(', ')})`
    );
    // One run makes one ZIP of both
    await content.waitForSelector('#process-btn');
    await content.click('#process-btn');
    await waitFor(
      page,
      () =>
        /compressed-pdfs\.zip/.test(
          document.querySelector('#toasts')?.textContent ?? ''
        ),
      undefined,
      60000
    );
  });

  test('shows saved form values and checkbox marks, and keeps them as fields', async () => {
    await page.evaluate(() => localStorage.removeItem('paperwing:session'));
    await openApp();
    await dropBytes(
      'Filled.pdf',
      await formPdf({ text: 'SAVED VALUE', checked: true })
    );
    await shown();
    const ink = await inkInFields();
    assert.ok(ink.name > 200, `saved text painted (${ink.name} dark pixels)`);
    assert.ok(ink.agree > 40, `checkbox mark painted (${ink.agree})`);
    // What the viewer showed before: widget appearances left out
    const without = await inkInFields({ withForms: false });
    assert.ok(without.name < 20 && without.agree < 10, JSON.stringify(without));
    // Exported as a form, not flattened
    const { form } = await exportedForm();
    assert.equal(form.getTextField('name').getText(), 'SAVED VALUE');
    assert.equal(form.getCheckBox('agree').isChecked(), true);
    assert.equal(form.getFields().length, 3);
  });

  test('fills in form fields beside the document; the values are saved', async () => {
    await dropBytes('Blank form.pdf', await formPdf());
    await shown();
    assert.ok((await inkInFields()).name < 20, 'empty to start with');
    await page.waitForSelector('#right-rail [aria-label="Form fields"]');
    await page.click('#right-rail [aria-label="Form fields"]');
    await page.waitForSelector('#form-panel [data-field="name"]');
    assert.equal(
      await page
        .$eval('#form-panel [data-field="reference"]', (e) => [
          e.value,
          e.disabled,
        ])
        .then(String),
      'REF-1,true',
      'read-only field shown, not editable'
    );

    await page.click('#form-panel [data-field="name"]');
    await page.keyboard.type('TYPED VALUE');
    await page.keyboard.press('Tab'); // leaving the field writes it
    await waitFor(page, () =>
      document.querySelector('#tabs .tab.is-active.is-dirty')
    );
    await page.click('#form-panel [data-field="agree"]');
    let exported;
    for (const end = Date.now() + 15000; Date.now() < end; await sleep(200)) {
      exported = await exportedForm().catch(() => null);
      if (exported?.form.getCheckBox('agree').isChecked()) break;
    }
    // The page shows the new values
    const ink = await inkInFields();
    assert.ok(ink.name > 200 && ink.agree > 40, JSON.stringify(ink));
    const { b64, form } = exported;
    assert.equal(form.getTextField('name').getText(), 'TYPED VALUE');
    assert.equal(form.getCheckBox('agree').isChecked(), true);
    assert.equal(form.getTextField('reference').getText(), 'REF-1');
    assert.equal(form.getFields().length, 3, 'still a form');

    // Reopening the saved file shows them
    await dropBytes('Saved form.pdf', b64);
    await shown();
    await waitFor(page, () =>
      document
        .querySelector('#tabs .tab.is-active .tab-label')
        ?.textContent.includes('Saved form')
    );
    await page.waitForSelector('#right-rail [aria-label="Form fields"]');
    await page.click('#right-rail [aria-label="Form fields"]');
    await waitFor(
      page,
      () =>
        document.querySelector('#form-panel [data-field="name"]')?.value ===
          'TYPED VALUE' &&
        document.querySelector('#form-panel [data-field="agree"]')?.checked
    );
    const reopened = await inkInFields();
    assert.ok(reopened.name > 200 && reopened.agree > 40);
  });

  test('says when a document has scripts it does not run', async () => {
    await dropBytes('Scripted.pdf', await formPdf({ script: true }));
    await shown();
    const text = await waitFor(
      page,
      () => document.querySelector('#script-bar')?.textContent
    );
    assert.match(text, /scripted instructions that Paperwing does not run/);
    // Still there after switching tabs and back
    await page.click('#home-btn');
    await page.evaluate(() =>
      [...document.querySelectorAll('#tabs .tab')]
        .find((t) => t.textContent.includes('Scripted.pdf'))
        .click()
    );
    await page.waitForSelector('#script-bar');
    await sleep(300); // (it slides in)
    await page.click('#script-bar [aria-label="Dismiss"]');
    assert.equal(await page.$('#script-bar'), null, 'dismissed');

    await dropPdf('Plain.pdf');
    await sleep(500);
    assert.equal(await page.$('#script-bar'), null, 'none for a normal PDF');
  });

  /** A tool frame (or a frame inside one) once its page has `ready` */
  async function frameWhere(urlPattern, ready) {
    for (let i = 0; i < 200; i++) {
      const f = page.frames().find((f) => urlPattern.test(f.url()));
      if (f && (await f.evaluate(ready).catch(() => false))) return f;
      await sleep(150);
    }
    throw new Error(`No frame ${urlPattern}`);
  }

  /** Records the viewer commands the workspace runs; print isn't run */
  const recordCommands = () =>
    page.evaluate(() => {
      window.__commands = [];
      const v = window.__acro.viewer;
      const run = v.command.bind(v);
      v.command = (id, command) => {
        window.__commands.push(command);
        if (command !== 'document:print') return run(id, command);
      };
    });

  test('Markdown Export PDF opens the PDF as a document, without printing', async () => {
    await waitFor(page, () => 'ready' in document.documentElement.dataset);
    await page.click('#home-btn');
    await page.click('#create-btn');
    await page.evaluate(() =>
      [...document.querySelectorAll('.menu-item')]
        .find((b) => b.textContent.includes('From Markdown'))
        .click()
    );
    const tool = await frameWhere(
      /markdown-to-pdf/,
      () => !!document.getElementById('mdExport')
    );
    await recordCommands();
    await tool.evaluate(() => {
      const text = document.getElementById('mdTextarea');
      text.value =
        '# Exported\n\n' +
        Array.from({ length: 70 }, (_, i) => `- Line ${i + 1}`).join('\n');
      text.dispatchEvent(new Event('input'));
    });
    const exported = async () =>
      (await tabNames()).filter((n) => n === 'Markdown.pdf').length;
    const before = await exported();
    await tool.click('#mdExport');
    await waitFor(
      page,
      () =>
        document.querySelector('#tabs .tab.is-active .tab-label')
          ?.textContent === 'Markdown.pdf' &&
        document.querySelector('#right-rail .rr-total')?.textContent === '2',
      undefined,
      60000
    );
    assert.equal(await exported(), before + 1, 'opened as a document');
    const head = await page.evaluate(async () => {
      const v = window.__acro.viewer;
      const bytes = new Uint8Array(await v.exportBytes(v.current));
      return String.fromCharCode(...bytes.subarray(0, 5));
    });
    assert.equal(head, '%PDF-');
    assert.deepEqual(
      await page.evaluate(() => window.__commands),
      [],
      'not printed'
    );
  });

  test('print() in a tool, or in the PDF.js viewer it embeds, prints the open document', async () => {
    await dropPdf('Report.pdf');
    await recordCommands();
    await page.evaluate(() =>
      [...document.querySelectorAll('.lp-tool')]
        .find((b) => b.textContent.includes('Fill & Sign'))
        .click()
    );
    const tool = await frameWhere(/sign-pdf/, () => !!document.body);
    const viewer = await frameWhere(
      /pdfjs-viewer\/viewer\.html/,
      () =>
        !!window.PDFViewerApplication?.pdfDocument &&
        document.readyState === 'complete'
    );
    await tool.evaluate(() => window.print());
    await waitFor(page, () => window.__commands.length === 1);
    await viewer.evaluate(() => window.print());
    await waitFor(page, () => window.__commands.length === 2);
    // PDF.js's own Ctrl+P
    await viewer.evaluate(() =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'p',
          keyCode: 80,
          ctrlKey: true,
          cancelable: true,
        })
      )
    );
    await waitFor(page, () => window.__commands.length === 3);
    assert.deepEqual(await page.evaluate(() => window.__commands), [
      'document:print',
      'document:print',
      'document:print',
    ]);
    assert.equal(
      await viewer.evaluate(
        () => !!document.querySelector('#printContainer > *')
      ),
      false,
      "PDF.js didn't prepare a print of its own"
    );
  });
});
