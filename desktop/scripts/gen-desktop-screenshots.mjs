/**
 * The README screenshots from the real desktop app (bench/harness.mjs), in
 * its own words (Save a copy, not Download), framed like gen-screenshots.mjs's
 * (2400×1590 PNGs in docs/screenshots/):
 *  - the workspace: hero (and the social image), hero-dark, dark, all-tools,
 *    tool-panel, edit-text, shortcuts. gen-screenshots.mjs draws these from
 *    the web build too; run this after it so the README shows the desktop
 *    app's words (Home, home and home-dark, come from gen-screenshots.mjs)
 *  - what only the desktop app has: forms, print, full-screen, scan and
 *    scan-dark (Create ▸ From scanner), sign and sign-dark (Sign with a
 *    Digital ID), validate (Validate signatures), about and about-dark
 *
 *   cd desktop && npm run build:web && node scripts/gen-desktop-screenshots.mjs [name…]
 *
 * The scanner is the development stand-in (scan-test.cjs) with the invoice
 * on its glass and an ordinary name; the Digital IDs are made up
 * (scripts/standin-certs: OpenSSL, nothing from this computer's certificate
 * store). Temporary files go in SHOTS_TMP (BENCH_TMP, else the OS's temp
 * folder). Set CHROME_PATH if Chrome isn't found (it draws the frames).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { launch } from '../bench/harness.mjs';
import * as scanUi from '../bench/scan-bench-lib.mjs';
import {
  FRAME,
  annotate,
  clickTool,
  findChrome,
  goToPage,
  menu,
  sleep,
  socialPreviewBody,
  waitThumbs,
  windowHtml,
  zoom,
} from './shots-kit.mjs';
import { STANDIN_NAME, standinCerts } from './standin-certs/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '..', '..', 'docs', 'screenshots');
const SAMPLES = join(OUT, 'samples');
const TMP = join(
  process.env.SHOTS_TMP || process.env.BENCH_TMP || tmpdir(),
  'paperwing-shots'
);
mkdirSync(TMP, { recursive: true });
const W = 1440;
const H = 900;
const only = new Set(process.argv.slice(2));
const shots = {};
const docs = {
  report: 'Halcyon Annual Report 2026.pdf',
  contract: 'Service Agreement - Northbeam.pdf',
  invoice: 'Invoice INV-2048.pdf',
  intake: 'Client intake - Northbeam.pdf',
};

/**
 * The app at 1440×900 (drawn at 1.5×), with room for macOS's window
 * buttons, the documents open (the last one shown)
 */
async function start(theme, keys = [], env = {}) {
  const file = (k) => join(SAMPLES, docs[k]);
  const app = await launch({ args: keys.slice(0, 1).map(file), env });
  const { page } = app;
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1.5 });
  await page.emulateMediaFeatures([
    { name: 'prefers-color-scheme', value: theme },
  ]);
  await page.evaluate(() => {
    document.body.classList.remove('is-win');
    document.body.classList.add('is-mac');
  });
  // No scrollbars, as on a Mac (the frame is a Mac window; the web
  // screenshots hide them too)
  const cdp = await page.target().createCDPSession();
  await cdp.send('Emulation.setScrollbarsHidden', { hidden: true });
  // One after another, so the tabs come in this order
  for (const [i, k] of keys.entries()) {
    if (i) await app.openFile(file(k));
    await shown(page, docs[k], i + 1);
  }
  await sleep(2500);
  return app;
}

/** The document is open and shown, `tabs` tabs in all */
async function shown(page, name, tabs = 1) {
  await page.waitForFunction(
    (name, tabs) =>
      document.querySelector('#view-doc.is-active') &&
      !document.querySelector('#doc-stage.is-loading') &&
      document.querySelectorAll('#tabs [role="tab"]').length >= tabs &&
      document
        .querySelector('#tabs [role="tab"][aria-selected="true"]')
        ?.textContent.includes(name.slice(0, 12)),
    { timeout: 45000 },
    name,
    tabs
  );
  await sleep(1500);
}

/** Notes that come and go (saved, updated…) aren't part of a screenshot */
const noToasts = (page) =>
  page.evaluate(() =>
    document.querySelectorAll('.toast').forEach((t) => t.remove())
  );

async function capture(page, name, theme) {
  await page.mouse.move(W - 2, H - 2);
  await noToasts(page);
  await sleep(500);
  shots[name] = { png: Buffer.from(await page.screenshot()), theme };
}

const fitPage = (page) => zoom(page, 'fit-page');

/** A real click on the first visible element matching `selector` whose
 *  text starts with `text` */
const clickText = scanUi.click;

/** The middle of a form field on screen (scrolled into view) */
const field = (page, name, nth = 0) =>
  page.evaluate(
    async (name, nth) => {
      const c = [
        ...document
          .querySelector('embedpdf-container')
          .shadowRoot.querySelectorAll('.pwf-layer [data-element-id]'),
      ].filter((x) => x.getAttribute('name') === name)[nth];
      if (!c) return null;
      c.scrollIntoView({ block: 'center' });
      await new Promise((r) => setTimeout(r, 400));
      const r = c.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    },
    name,
    nth
  );

async function clickField(page, name, nth = 0) {
  const at = await field(page, name, nth);
  if (!at) throw new Error(`no field ${name}`);
  await page.mouse.click(at.x, at.y);
  await sleep(150);
}

async function typeIn(page, name, text) {
  await clickField(page, name);
  await page.keyboard.type(text, { delay: 15 });
}

/** The invoice's first page as a PNG, for the stand-in scanner's glass */
async function invoicePicture() {
  const file = join(TMP, 'invoice-on-glass.png');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(readFileSync(join(SAMPLES, docs.invoice))),
    isEvalSupported: false,
  }).promise;
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: 200 / 72 });
  const { canvas, context } = doc.canvasFactory.create(
    Math.round(vp.width),
    Math.round(vp.height)
  );
  context.fillStyle = '#fdfcf9';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport: vp, canvas }).promise;
  writeFileSync(file, canvas.toBuffer('image/png'));
  await doc.destroy();
  return file;
}

/**
 * Use a certificate ▸ Digitally sign on the contract, a box drawn on a page
 * (`box`: fractions of the page in view, left, top, right, bottom): Sign
 * with a Digital ID lists the made-up IDs
 */
async function digitalIdDialog(
  theme,
  { page: pageIndex = 0, box = [0.55, 0.42, 0.87, 0.51], fit = false } = {}
) {
  const { env } = standinCerts(join(TMP, 'digital-ids'));
  const saved = join(TMP, 'signed');
  mkdirSync(saved, { recursive: true });
  const app = await start(theme, ['contract'], {
    ...env,
    PAPERWING_TEST_SAVE_DIR: saved,
  });
  const { page } = app;
  if (
    !(await clickText(page, '.lp:not([hidden]) .lp-tool', 'Use a certificate'))
  )
    throw new Error('no Use a certificate tool');
  await page.waitForSelector('#cert-bar', { visible: true });
  if (fit) {
    await fitPage(page);
    await sleep(800);
    await goToPage(page, pageIndex + 1);
    await sleep(1500);
  }
  await page.click('#cb-sign');
  await page.waitForFunction(() =>
    /Drag a box/.test(document.querySelector('#cert-bar')?.textContent)
  );
  const rect = await page.waitForFunction(
    (pageIndex, fit) => {
      const host = [...document.querySelectorAll('#viewer-host *')].find(
        (e) => e.shadowRoot
      );
      const layer = host?.shadowRoot?.querySelector(
        `.pwsig-layer[data-page="${pageIndex}"]`
      );
      if (!layer) return null;
      const r = layer.getBoundingClientRect();
      const top = Math.max(r.top, host.getBoundingClientRect().top);
      const bottom = Math.min(r.bottom, innerHeight - 10);
      if (!(r.width > 0 && bottom > top)) return null;
      // (the whole page when it fits, else the part in view)
      return fit
        ? { x: r.left, y: r.top, w: r.width, h: r.height }
        : { x: r.left, y: top, w: r.width, h: bottom - top };
    },
    {},
    pageIndex,
    fit
  );
  const r = await rect.jsonValue();
  const [x0, y0, x1, y1] = [
    r.x + r.w * box[0],
    r.y + r.h * box[1],
    r.x + r.w * box[2],
    r.y + r.h * box[3],
  ];
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 8 });
  await page.mouse.move(x1, y1, { steps: 8 });
  await page.mouse.up();
  await page.waitForSelector('#cid-dialog', { visible: true });
  await page.waitForFunction(
    () =>
      document.querySelectorAll('#cid-dialog .cid-row').length >= 3 &&
      !/Looking for/.test(
        document.querySelector('#cid-dialog .cid-list')?.textContent
      ),
    { timeout: 30000 }
  );
  // Only the made-up IDs: never a certificate from this computer
  const names = await page.$$eval('#cid-dialog .cid-row .cid-name b', (b) =>
    b.map((x) => x.textContent)
  );
  if (names.some((n) => n !== STANDIN_NAME))
    throw new Error(`unexpected IDs listed: ${names.join(', ')}`);
  await sleep(800);
  return app;
}

const scenes = {
  // The annual report: tabs, All tools, quick toolbar, annotations,
  // thumbnails. Also the repository's social image.
  async hero() {
    await heroScene('light');
  },
  async 'hero-dark'() {
    await heroScene('dark');
  },
  // Dark mode, the Edit panel, a highlight
  async dark() {
    const app = await start('dark', ['report', 'contract']);
    const { page } = app;
    await annotate(page, {
      page: 0,
      highlight: { x: 67, y: 359, w: 420, h: 14 },
    });
    await page.click('#gb-tabs [data-panel="edit"]');
    await sleep(1200);
    await capture(page, 'dark', 'dark');
    await app.close();
  },
  // The All tools sidebar, searching
  async 'all-tools'() {
    const app = await start('light', ['invoice']);
    const { page } = app;
    await zoom(page, 'fit-width');
    await sleep(1000);
    const input = await page.waitForSelector('.lp-search input', {
      visible: true,
    });
    await input.click();
    await page.keyboard.type('pdf to', { delay: 40 });
    await sleep(800);
    await capture(page, 'all-tools', 'light');
    await app.close();
  },
  // Compress beside the document
  async 'tool-panel'() {
    const app = await start('light', ['contract']);
    const { page } = app;
    await fitPage(page);
    await sleep(800);
    await clickTool(page, 'Compress a PDF');
    await sleep(9000);
    await capture(page, 'tool-panel', 'light');
    await app.close();
  },
  // Edit text & images, in dark mode
  async 'edit-text'() {
    const app = await start('dark', ['invoice']);
    const { page } = app;
    await page.keyboard.press('t');
    await sleep(10000);
    await capture(page, 'edit-text', 'dark');
    await app.close();
  },
  // The keyboard shortcuts sheet
  async shortcuts() {
    const app = await start('light', ['contract']);
    const { page } = app;
    await fitPage(page);
    await sleep(800);
    await menu(page, '#help-btn', 'Keyboard shortcuts');
    await capture(page, 'shortcuts', 'light');
    await app.close();
  },
  // The client intake form, filled in on the page, beside the Form fields panel
  async forms() {
    const app = await start('light', ['intake']);
    const { page } = app;
    await typeIn(page, 'Full name', 'Jordan Ellis');
    await typeIn(page, 'Company', 'Halcyon Labs');
    await typeIn(page, 'Email', 'jordan@halcyon.example');
    await typeIn(page, 'Phone', '+1 415 555 0142');
    await page.evaluate(() => {
      const s = [
        ...document
          .querySelector('embedpdf-container')
          .shadowRoot.querySelectorAll('.pwf-layer select'),
      ].find((x) => x.getAttribute('name') === 'Project type');
      s.value = [...s.options].find(
        (o) => o.text === 'Brand identity & website'
      ).value;
      s.dispatchEvent(new Event('input', { bubbles: true }));
      s.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await typeIn(page, 'Start date', 'January 2027');
    for (const s of ['Strategy', 'Logo & identity', 'Web design'])
      await clickField(page, s);
    await clickField(page, 'Budget', 1);
    await typeIn(
      page,
      'Success looks like',
      'A brand our customers recognise at a glance'
    );
    await page.evaluate(() => document.activeElement?.blur());
    await page.evaluate(() =>
      document.querySelector('.rr-btn[aria-label="Form fields"]')?.click()
    );
    await sleep(1200);
    await fitPage(page);
    await sleep(2000);
    await capture(page, 'forms', 'light');
    await app.close();
  },
  // The print dialog, with its preview, over the annual report
  async print() {
    const app = await start('light', ['report']);
    const { page } = app;
    await page.click('#print-btn');
    await page.waitForSelector('.dlg', { timeout: 20000 });
    await sleep(5000);
    await capture(page, 'print', 'light');
    await app.close();
  },
  // Full screen: one page on black (Ctrl+L, then the next page)
  async 'full-screen'() {
    const app = await start('dark', ['report']);
    const { page } = app;
    const cdp = await page.target().createCDPSession();
    const press = async (key, code, modifiers = 0) => {
      for (const type of ['rawKeyDown', 'keyUp'])
        await cdp.send('Input.dispatchKeyEvent', {
          type,
          key,
          code,
          modifiers,
        });
    };
    await page.mouse.click(700, 450);
    await press('l', 'KeyL', process.platform === 'darwin' ? 4 : 2);
    await sleep(2000);
    await press('ArrowRight', 'ArrowRight');
    await sleep(3500);
    await capture(page, 'full-screen', 'dark');
    await app.close();
  },
  // Create ▸ From scanner: the invoice previewed on the flatbed's glass,
  // the box around it, over Home
  async scan() {
    await scanScene('light');
  },
  async 'scan-dark'() {
    await scanScene('dark');
  },
  // Sign with a Digital ID: Windows, smart card and USB token IDs
  async sign() {
    const app = await digitalIdDialog('light');
    await capture(app.page, 'sign', 'light');
    await app.close();
  },
  async 'sign-dark'() {
    const app = await digitalIdDialog('dark');
    await capture(app.page, 'sign-dark', 'dark');
    await app.close();
  },
  // Validate signatures on the contract, just signed with the Windows ID
  // above Northbeam's signature line, the made-up root trusted
  async validate() {
    const app = await digitalIdDialog('light', {
      page: 1,
      box: [0.115, 0.41, 0.46, 0.462],
      fit: true,
    });
    const { page } = app;
    await page.click('#cid-continue');
    await page.waitForSelector('#sas-dialog', { visible: true });
    await page.click('#sas-reason');
    await page.keyboard.type('I approve this agreement');
    await page.click('#sas-location');
    await page.keyboard.type('Lisbon');
    await page.click('#sas-sign');
    await page.waitForFunction(
      () =>
        /Signed and saved/.test(document.querySelector('#toasts')?.textContent),
      { timeout: 60000 }
    );
    await sleep(1500);
    await noToasts(page);
    await clickText(page, '#cert-bar button', 'Validate signatures');
    let frame;
    for (let i = 0; i < 100 && !frame; i++) {
      frame = page
        .frames()
        .find((f) => f.url().includes('validate-signature-pdf'));
      if (!frame) await sleep(200);
    }
    if (!frame) throw new Error('Validate signatures did not open');
    await frame.waitForFunction(
      (name) => document.body.innerText.includes(name),
      { timeout: 30000 },
      STANDIN_NAME
    );
    // Trust the root certificates in the system's store (the stand-in
    // helper's: the made-up root), the results in view
    await frame.evaluate(() => {
      const trust = [
        ...document.querySelectorAll('input[type="checkbox"]'),
      ].find((i) =>
        /Trust root certificates/.test(i.closest('label, div')?.textContent)
      );
      if (trust && !trust.checked) trust.click();
    });
    await frame.waitForFunction(() => /1 valid/.test(document.body.innerText), {
      timeout: 30000,
    });
    await frame.evaluate(() =>
      [...document.querySelectorAll('h1, h2, h3, h4, p, div')]
        .find((e) => e.textContent.trim() === 'Signature Validation Results')
        ?.scrollIntoView({ block: 'start' })
    );
    // (the tool's frame keeps its scrollbar otherwise)
    await frame.addStyleTag({
      content: '::-webkit-scrollbar { display: none; }',
    });
    await goToPage(page, 2);
    await sleep(800);
    await fitPage(page);
    await sleep(2500);
    await capture(page, 'validate', 'light');
    await app.close();
  },
  // About Paperwing over Home: the ribbon, the frosted details
  async about() {
    await aboutScene('light');
  },
  async 'about-dark'() {
    await aboutScene('dark');
  },
};

async function heroScene(theme) {
  const app = await start(theme, ['invoice', 'contract', 'report']);
  const { page } = app;
  await zoom(page, 'fit-width');
  await sleep(1000);
  await goToPage(page, 2);
  await sleep(1500);
  await annotate(page, {
    page: 1,
    highlight: { x: 57, y: 168, w: 466, h: 19 },
    circle: { cx: 120, cy: 275, rx: 80, ry: 31 },
  });
  await page.keyboard.press('F4');
  await waitThumbs(page);
  await capture(page, theme === 'dark' ? 'hero-dark' : 'hero', theme);
  await app.close();
}

/** Home, with the samples as recent files */
async function home(theme, env = {}) {
  const app = await start(
    theme,
    ['report', 'invoice', 'contract', 'intake'],
    env
  );
  await app.page.click('#home-btn');
  await app.page.waitForFunction(
    () => {
      const imgs = [...document.querySelectorAll('#recent-list img')];
      return (
        imgs.length >= 4 && imgs.every((i) => i.complete && i.naturalWidth)
      );
    },
    { timeout: 30000 }
  );
  await sleep(800);
  return app;
}

async function scanScene(theme) {
  const scan = await home(theme, {
    PAPERWING_SCAN_TEST: '1',
    PAPERWING_SCAN_TEST_GLASS: await invoicePicture(),
    PAPERWING_SCAN_TEST_NAME: 'Office Scanner',
  });
  const { page } = scan;
  if (!(await scanUi.openDialog(page)))
    throw new Error('Create ▸ From scanner did not open');
  await scanUi.choose(page, 'Scanner', 'Office Scanner');
  await scanUi.waitReady(page);
  await scanUi.choose(page, 'Preset', 'Color document');
  await sleep(500);
  await scanUi.choose(page, 'Source', 'Flatbed');
  await scanUi.waitReady(page);
  await scanUi.press(page, 'Preview');
  await scanUi.waitIdle(page);
  await page.waitForSelector('.dlg-scan .sp-nw', { visible: true });
  await sleep(1500);
  await capture(page, theme === 'dark' ? 'scan-dark' : 'scan', theme);
  await scan.close();
}

async function aboutScene(theme) {
  const app = await home(theme);
  const { page } = app;
  await menu(page, '#help-btn', 'About Paperwing');
  await page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll('.about-art img')];
    return imgs.length && imgs.every((i) => i.complete && i.naturalWidth);
  });
  await sleep(1500);
  await capture(page, theme === 'dark' ? 'about-dark' : 'about', theme);
  await app.close();
}

let failed = 0;
for (const [name, run] of Object.entries(scenes)) {
  if (only.size && !only.has(name)) continue;
  try {
    await run();
  } catch (err) {
    failed++;
    console.error('FAILED', name, err.message);
  }
}

// Framed as a macOS window on the README's backdrop (as gen-screenshots.mjs)
const browser = await puppeteer.launch({ executablePath: findChrome() });
async function render(name, width, height, body) {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  await page.setContent(`<!doctype html>
    <style>html, body { margin: 0; } body { width: ${width}px; height: ${height}px;
      overflow: hidden; position: relative; }</style>${body}`);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((i) => i.decode()));
  });
  writeFileSync(join(OUT, `${name}.png`), await page.screenshot());
  await page.close();
  console.log('saved', `docs/screenshots/${name}.png`);
}
for (const [name, { png, theme }] of Object.entries(shots)) {
  const b64 = png.toString('base64');
  await render(
    name,
    2400,
    1590,
    `<div style="position: absolute; inset: 0; background: ${FRAME[theme]}"></div>
    ${windowHtml(b64, { x: 120, y: 120, theme })}`
  );
  if (name === 'hero')
    await render('social-preview', 1280, 640, socialPreviewBody(b64));
}
await browser.close();
process.exit(failed ? 1 : 0);
