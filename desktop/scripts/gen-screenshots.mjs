/**
 * Regenerates the README screenshots in docs/screenshots/: the real
 * workspace in Chrome at 1440×900, framed as a macOS window on a soft
 * gradient (2400×1590 PNGs). The documents are docs/screenshots/samples/.
 *
 * Against a preview of the built web app (repository root):
 *   cd desktop && npm run build:web
 *   cd .. && npx vite preview --port 4173
 *   cd desktop && PAPERWING_URL=http://localhost:4173 npm run docs:screenshots [name…]
 *
 * Set CHROME_PATH if Chrome isn't found.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '..', '..', 'docs', 'screenshots');
const SAMPLES = join(OUT, 'samples');
const BASE = (process.env.PAPERWING_URL || 'http://localhost:4173').replace(
  /\/$/,
  ''
);
// The app at 1440×900, drawn at 1.5× into a 2160×1350 window
const W = 1440;
const H = 900;
const SCALE = 1.5;
const docs = {
  report: 'Halcyon Annual Report 2026.pdf',
  contract: 'Service Agreement - Northbeam.pdf',
  invoice: 'Invoice INV-2048.pdf',
};
const only = new Set(process.argv.slice(2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const found = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ]
    .filter(Boolean)
    .find((p) => existsSync(p));
  if (!found) throw new Error('Chrome not found: set CHROME_PATH');
  return found;
}

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  args: ['--font-render-hinting=none', '--hide-scrollbars'],
});

/** A fresh workspace (its own storage) at 10:42 today, as the desktop app on macOS */
async function newApp(theme = 'light') {
  const context = await browser.createBrowserContext();
  const p = await context.newPage();
  await p.setViewport({ width: W, height: H, deviceScaleFactor: SCALE });
  await p.evaluateOnNewDocument(() => {
    const at = new Date();
    at.setHours(10, 42, 0, 0);
    const offset = at.getTime() - Date.now();
    const RealDate = Date;
    window.Date = class extends RealDate {
      constructor(...a) {
        super(...(a.length ? a : [RealDate.now() + offset]));
      }
      static now() {
        return RealDate.now() + offset;
      }
    };
    localStorage.setItem(
      'paperwing:prefs',
      JSON.stringify({ checkUpdates: false, restoreSession: false })
    );
  });
  await p.emulateMediaFeatures([
    { name: 'prefers-color-scheme', value: theme },
  ]);
  await p.goto(`${BASE}/app.html`);
  await p.waitForFunction(() => 'ready' in document.documentElement.dataset, {
    timeout: 20000,
  });
  // Leave room for the window buttons the frame draws
  await p.evaluate(() => document.body.classList.add('is-desktop', 'is-mac'));
  await sleep(800);
  p.close = () => context.close();
  return p;
}

async function open(p, key) {
  const b64 = readFileSync(join(SAMPLES, docs[key])).toString('base64');
  await p.evaluate(
    ({ b64, name }) => {
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
    { b64, name: docs[key] }
  );
  await p.waitForFunction(
    (name) =>
      document.querySelector('#view-doc.is-active') &&
      !document.querySelector('#doc-stage.is-loading') &&
      document
        .querySelector('#tabs [role="tab"][aria-selected="true"]')
        ?.textContent.includes(name.slice(0, 12)),
    { timeout: 30000 },
    docs[key]
  );
  await sleep(1500);
}

// The page exposes its viewer as window.__acro.viewer
const zoom = (p, level) =>
  p.evaluate((level) => {
    const v = window.__acro.viewer;
    v.command(v.current, `zoom:${level}`);
  }, level);
const goToPage = (p, n) =>
  p.evaluate((n) => {
    const v = window.__acro.viewer;
    v.goToPage(v.current, n);
  }, n);

/** Highlights (and optionally circles) on the current document */
async function annotate(p, spec) {
  await p.evaluate(({ page, highlight, circle }) => {
    const v = window.__acro.viewer;
    const a = v.cap('annotation').forDocument(v.docIds.get(v.current));
    if (circle) {
      const { cx, cy, rx, ry } = circle;
      const points = Array.from({ length: 60 }, (_, i) => {
        const k = (i / 59) * Math.PI * 2.08 - 0.3;
        return { x: cx + Math.cos(k) * rx, y: cy + Math.sin(k) * ry };
      });
      a.createAnnotation(page, {
        type: 15,
        id: crypto.randomUUID(),
        pageIndex: page,
        rect: {
          origin: { x: cx - rx - 4, y: cy - ry - 4 },
          size: { width: rx * 2 + 8, height: ry * 2 + 8 },
        },
        inkList: [{ points }],
        color: '#D7193A',
        strokeColor: '#D7193A',
        opacity: 1,
        strokeWidth: 3,
      });
    }
    const rect = {
      origin: { x: highlight.x, y: highlight.y },
      size: { width: highlight.w, height: highlight.h },
    };
    a.createAnnotation(page, {
      type: 9,
      id: crypto.randomUUID(),
      pageIndex: page,
      rect,
      segmentRects: [rect],
      color: '#FFD84D',
      opacity: 0.6,
    });
  }, spec);
  await sleep(600);
  await p.evaluate(() => {
    const v = window.__acro.viewer;
    for (const id of v.docIds.values()) {
      const a = v.cap('annotation').forDocument(id);
      a.deselectAnnotation?.();
      a.setSelection?.([]);
    }
  });
  await sleep(300);
}

async function clickTool(p, label) {
  await p.waitForFunction(
    (label) => {
      const b = [...document.querySelectorAll('.lp-tool')].find(
        (x) => x.getClientRects().length && x.textContent.trim() === label
      );
      b?.click();
      return !!b;
    },
    { timeout: 15000 },
    label
  );
}

async function menu(p, button, label) {
  await p.click(button);
  await sleep(300);
  await p.evaluate(
    (label) =>
      [...document.querySelectorAll('.menu-item')]
        .find((b) => b.textContent.includes(label))
        .click(),
    label
  );
  await sleep(800);
}

/** Page thumbnails in the right-hand panel have rendered */
async function waitThumbs(p) {
  await p
    .waitForFunction(
      () => {
        const found = [];
        const walk = (root) =>
          root.querySelectorAll('*').forEach((el) => {
            if (el.shadowRoot) walk(el.shadowRoot);
            if (el.tagName === 'IMG' || el.tagName === 'CANVAS') found.push(el);
          });
        walk(document);
        const host = document.querySelector('#viewer-host');
        if (!host) return false;
        const hr = host.getBoundingClientRect();
        const thumbs = found.filter((el) => {
          const r = el.getBoundingClientRect();
          return (
            r.width > 40 &&
            r.width < 200 &&
            r.top < innerHeight &&
            r.bottom > 0 &&
            r.left > hr.left + hr.width * 0.6
          );
        });
        return (
          thumbs.length >= 3 &&
          thumbs.every(
            (el) => el.tagName !== 'IMG' || (el.complete && el.naturalWidth)
          )
        );
      },
      { timeout: 30000, polling: 500 }
    )
    .catch(() => console.warn('  thumbnails not detected; continuing'));
  await sleep(2500);
}

const FRAME = {
  light: `
    radial-gradient(1000px 850px at 0 0, #ffe3df, rgb(255 227 223 / 0)),
    radial-gradient(1100px 900px at 100% 100%, #e7e9ff, rgb(231 233 255 / 0)),
    #f7f5f6`,
  dark: `
    radial-gradient(850px 650px at 0 0, #5c1a27, rgb(92 26 39 / 0)),
    radial-gradient(700px 650px at 100% 100%, #21193e, rgb(33 25 62 / 0)),
    linear-gradient(#18181a, #131315)`,
};

/** Frames the workspace as a window and saves docs/screenshots/<name>.png */
async function shot(p, name, theme = 'light') {
  await p.mouse.move(W - 2, H - 2);
  await sleep(300);
  const png = Buffer.from(await p.screenshot()).toString('base64');
  const frame = await browser.newPage();
  await frame.setViewport({ width: 2400, height: 1590 });
  await frame.setContent(`<!doctype html>
    <style>
      html, body { margin: 0; }
      body { width: 2400px; height: 1590px; overflow: hidden; background: ${FRAME[theme]}; }
      .win {
        position: absolute; left: 120px; top: 120px; width: 2160px; height: 1350px;
        border-radius: 18px; overflow: hidden;
        box-shadow: 0 0 0 1px rgb(0 0 0 / ${theme === 'dark' ? 0.5 : 0.07}),
          0 6px 14px rgb(24 16 40 / 0.14), 0 34px 80px rgb(24 16 40 / 0.3);
      }
      .win img { display: block; width: 2160px; height: 1350px; }
      .dot { position: absolute; top: 21px; width: 18px; height: 18px; border-radius: 50%; }
    </style>
    <div class="win">
      <img src="data:image/png;base64,${png}">
      <i class="dot" style="left: 21px; background: #ff5f57"></i>
      <i class="dot" style="left: 51px; background: #febc2e"></i>
      <i class="dot" style="left: 81px; background: #28c840"></i>
    </div>`);
  await frame.evaluate(() => document.querySelector('img').decode());
  await frame.screenshot({ path: join(OUT, `${name}.png`) });
  await frame.close();
  console.log('saved', `docs/screenshots/${name}.png`);
}

const scenes = {
  // The annual report: tabs, All tools, quick toolbar, annotations, thumbnails
  async hero() {
    const p = await newApp('light');
    for (const k of ['invoice', 'contract', 'report']) await open(p, k);
    await zoom(p, 'fit-width');
    await sleep(1000);
    await goToPage(p, 2);
    await sleep(1500);
    await annotate(p, {
      page: 1,
      highlight: { x: 57, y: 168, w: 466, h: 19 },
      circle: { cx: 120, cy: 275, rx: 80, ry: 31 },
    });
    await p.keyboard.press('F4');
    await waitThumbs(p);
    await shot(p, 'hero');
    await p.close();
  },
  // Home: Recent | Starred with first-page previews, as thumbnails
  async home() {
    const p = await newApp('light');
    for (const k of ['invoice', 'contract', 'report']) await open(p, k);
    await p.click('#home-btn');
    await p.click('[data-layout="grid"]');
    await p.waitForFunction(
      () => {
        const imgs = [...document.querySelectorAll('#recent-list img')];
        return (
          imgs.length >= 3 && imgs.every((i) => i.complete && i.naturalWidth)
        );
      },
      { timeout: 30000 }
    );
    await sleep(800);
    await shot(p, 'home');
    await p.close();
  },
  // Dark mode, the Edit panel, a highlight
  async dark() {
    const p = await newApp('dark');
    // At the default zoom (fit width, up to 150%), so the dark UI shows
    for (const k of ['report', 'contract']) await open(p, k);
    await annotate(p, {
      page: 0,
      highlight: { x: 67, y: 359, w: 420, h: 14 },
    });
    await p.click('#gb-tabs [data-panel="edit"]');
    await sleep(1200);
    await shot(p, 'dark', 'dark');
    await p.close();
  },
  // The All tools sidebar, searching
  async 'all-tools'() {
    const p = await newApp('light');
    await open(p, 'invoice');
    await zoom(p, 'fit-width');
    await sleep(1000);
    const input = await p.waitForSelector('.lp-search input', {
      visible: true,
    });
    await input.click();
    await p.keyboard.type('pdf to', { delay: 40 });
    await sleep(800);
    await shot(p, 'all-tools');
    await p.close();
  },
  // Compress beside the document
  async 'tool-panel'() {
    const p = await newApp('light');
    await open(p, 'contract');
    await zoom(p, 'fit-page');
    await sleep(800);
    await clickTool(p, 'Compress a PDF');
    await sleep(9000);
    await shot(p, 'tool-panel');
    await p.close();
  },
  // Edit text & images, in dark mode
  async 'edit-text'() {
    const p = await newApp('dark');
    await open(p, 'invoice');
    await p.keyboard.press('t');
    await sleep(10000);
    await shot(p, 'edit-text', 'dark');
    await p.close();
  },
  // The keyboard shortcuts sheet
  async shortcuts() {
    const p = await newApp('light');
    await open(p, 'contract');
    await zoom(p, 'fit-page');
    await sleep(800);
    await menu(p, '#help-btn', 'Keyboard shortcuts');
    await shot(p, 'shortcuts');
    await p.close();
  },
};

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
await browser.close();
process.exit(failed ? 1 : 0);
