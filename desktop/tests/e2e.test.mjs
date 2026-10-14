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
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

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

/** Poll a page function until it returns a truthy value */
async function waitFor(page, fn, arg, timeout = 15000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await page.evaluate(fn, arg);
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${fn}`);
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

describe('Paperwing UI', () => {
  before(async () => {
    browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: true,
      args: ['--no-sandbox'],
    });
    page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 860 });
    page.on('dialog', (d) => d.dismiss());
    await page.goto(`${BASE}/app.html`);
    await page.evaluate(() => {
      localStorage.clear();
      indexedDB.deleteDatabase('paperwing-desktop');
    });
  });

  after(async () => {
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
    await content.waitForFunction(
      () =>
        document
          .querySelector('#file-display-area')
          ?.textContent.includes('Report.pdf'),
      { timeout: 20000 }
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
    await frame.waitForFunction(() =>
      document.documentElement.classList.contains('rs-embedded')
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
    await content.waitForFunction(() =>
      document.documentElement.classList.contains('rs-embedded')
    );

    // Changing the theme in the workspace reaches the tool
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyK');
    await page.keyboard.up('Control');
    await page.select('.pref-select', 'dark');
    await content.waitForFunction(
      () => document.documentElement.dataset.theme === 'dark'
    );
    await page.select('.pref-select', 'system');
    await content.waitForFunction(
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
});
