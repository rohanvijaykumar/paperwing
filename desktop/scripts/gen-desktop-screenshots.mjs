/**
 * The README screenshots that only the desktop app can show (the print
 * dialog is the desktop shell's): a form filled in on the page, the print
 * dialog and full screen, from the real app (bench/harness.mjs), framed like
 * gen-screenshots.mjs's (2400×1590 PNGs in docs/screenshots/).
 *   cd desktop && npm run build:web && node scripts/gen-desktop-screenshots.mjs [forms|print|full-screen…]
 * Set CHROME_PATH if Chrome isn't found (it draws the frames).
 */
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { launch, sleep } from '../bench/harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '..', '..', 'docs', 'screenshots');
const SAMPLES = join(OUT, 'samples');
const W = 1440;
const H = 900;
const only = new Set(process.argv.slice(2));
const shots = {};

/** The app at 1440×900 (drawn at 1.5×), with room for macOS's window buttons */
async function start(theme, file) {
  const app = await launch({ args: [join(SAMPLES, file)] });
  const { page } = app;
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1.5 });
  await page.emulateMediaFeatures([
    { name: 'prefers-color-scheme', value: theme },
  ]);
  await page.evaluate(() => {
    document.body.classList.remove('is-win');
    document.body.classList.add('is-mac');
  });
  await sleep(4000);
  return app;
}

async function capture(page, name, theme) {
  await page.mouse.move(W - 2, H - 2);
  await sleep(500);
  shots[name] = { png: Buffer.from(await page.screenshot()), theme };
}

const fitPage = (page) =>
  page.evaluate(() => {
    const v = window.__acro.viewer;
    v.command(v.current, 'zoom:fit-page');
  });

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

const scenes = {
  // The client intake form, filled in on the page, beside the Form fields panel
  async forms() {
    const app = await start('light', 'Client intake - Northbeam.pdf');
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
    const app = await start('light', 'Halcyon Annual Report 2026.pdf');
    const { page } = app;
    await page.click('#print-btn');
    await page.waitForSelector('.dlg', { timeout: 20000 });
    await sleep(5000);
    await capture(page, 'print', 'light');
    await app.close();
  },
  // Full screen: one page on black (Ctrl+L, then the next page)
  async 'full-screen'() {
    const app = await start('dark', 'Halcyon Annual Report 2026.pdf');
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
    await page.evaluate(() =>
      document.querySelectorAll('.toast').forEach((t) => t.remove())
    );
    await capture(page, 'full-screen', 'dark');
    await app.close();
  },
};

for (const [name, run] of Object.entries(scenes))
  if (!only.size || only.has(name)) await run();

// Framed as a macOS window on the README's backdrop (as gen-screenshots.mjs)
const FRAME = {
  light: `radial-gradient(1000px 850px at 0 0, #ffe3df, rgb(255 227 223 / 0)),
    radial-gradient(1100px 900px at 100% 100%, #e7e9ff, rgb(231 233 255 / 0)), #f7f5f6`,
  dark: `radial-gradient(850px 650px at 0 0, #5c1a27, rgb(92 26 39 / 0)),
    radial-gradient(700px 650px at 100% 100%, #21193e, rgb(33 25 62 / 0)),
    linear-gradient(#18181a, #131315)`,
};
const chrome = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
]
  .filter(Boolean)
  .find((p) => existsSync(p));
if (!chrome) throw new Error('Chrome not found: set CHROME_PATH');
const browser = await puppeteer.launch({ executablePath: chrome });
for (const [name, { png, theme }] of Object.entries(shots)) {
  const dots = ['#ff5f57', '#febc2e', '#28c840']
    .map(
      (c, i) =>
        `<i style="position: absolute; top: 21px; left: ${21 + i * 30}px; width: 18px;
          height: 18px; border-radius: 50%; background: ${c}"></i>`
    )
    .join('');
  const page = await browser.newPage();
  await page.setViewport({ width: 2400, height: 1590 });
  await page.setContent(`<!doctype html>
    <style>html, body { margin: 0; } body { width: 2400px; height: 1590px;
      overflow: hidden; position: relative; }</style>
    <div style="position: absolute; inset: 0; background: ${FRAME[theme]}"></div>
    <div style="position: absolute; left: 120px; top: 120px; width: 2160px; height: 1350px;
      border-radius: 18px; overflow: hidden;
      box-shadow: 0 0 0 1px rgb(0 0 0 / ${theme === 'dark' ? 0.5 : 0.07}),
        0 6px 14px rgb(24 16 40 / 0.14), 0 34px 80px rgb(24 16 40 / 0.3)">
      <img src="data:image/png;base64,${png.toString('base64')}"
        style="display: block; width: 100%; height: 100%">${dots}
    </div>`);
  await page.evaluate(() =>
    Promise.all([...document.images].map((i) => i.decode()))
  );
  writeFileSync(join(OUT, `${name}.png`), await page.screenshot());
  await page.close();
  console.log('saved', `docs/screenshots/${name}.png`);
}
await browser.close();
