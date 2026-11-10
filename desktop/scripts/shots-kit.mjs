/**
 * What the screenshot scripts share (gen-screenshots.mjs in Chrome,
 * gen-desktop-screenshots.mjs in the desktop app): driving the workspace
 * (the page exposes its viewer as window.__acro.viewer) and framing a
 * capture as a macOS window on the README's backdrop.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findChrome() {
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

export const zoom = (p, level) =>
  p.evaluate((level) => {
    const v = window.__acro.viewer;
    v.command(v.current, `zoom:${level}`);
  }, level);
export const goToPage = (p, n) =>
  p.evaluate((n) => {
    const v = window.__acro.viewer;
    v.goToPage(v.current, n);
  }, n);

/** Highlights (and optionally circles) on the current document */
export async function annotate(p, spec) {
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

export async function clickTool(p, label) {
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

export async function menu(p, button, label) {
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
export async function waitThumbs(p) {
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

export const FRAME = {
  light: `
    radial-gradient(1000px 850px at 0 0, #ffe3df, rgb(255 227 223 / 0)),
    radial-gradient(1100px 900px at 100% 100%, #e7e9ff, rgb(231 233 255 / 0)),
    #f7f5f6`,
  dark: `
    radial-gradient(850px 650px at 0 0, #5c1a27, rgb(92 26 39 / 0)),
    radial-gradient(700px 650px at 100% 100%, #21193e, rgb(33 25 62 / 0)),
    linear-gradient(#18181a, #131315)`,
};

/** The workspace as a 2160×1350 window, drawn at `s`× from (x, y) */
export function windowHtml(png, { x, y, s = 1, theme = 'light' }) {
  const px = (n) => `${+(n * s).toFixed(2)}px`;
  const dots = ['#ff5f57', '#febc2e', '#28c840']
    .map(
      (c, i) =>
        `<i style="position: absolute; top: ${px(21)}; left: ${px(21 + i * 30)};
          width: ${px(18)}; height: ${px(18)}; border-radius: 50%; background: ${c}"></i>`
    )
    .join('');
  return `<div style="position: absolute; left: ${x}px; top: ${y}px;
      width: ${px(2160)}; height: ${px(1350)}; border-radius: ${px(18)}; overflow: hidden;
      box-shadow: 0 0 0 1px rgb(0 0 0 / ${theme === 'dark' ? 0.5 : 0.07}),
        0 ${px(6)} ${px(14)} rgb(24 16 40 / 0.14), 0 ${px(34)} ${px(80)} rgb(24 16 40 / 0.3)">
    <img src="data:image/png;base64,${png}" style="display: block; width: 100%; height: 100%">
    ${dots}
  </div>`;
}

/** The repository's social image (1280×640) as a page body: the icon, name,
 *  tagline and features over the 1.3 edition's dark ribbon art, beside the
 *  dark hero (docs/screenshots/hero-dark.png, so run that scene first) */
export function socialPreviewBody() {
  const root = resolve(here, '..', '..');
  const data = (...path) =>
    readFileSync(resolve(root, ...path)).toString('base64');
  const font = (weight) => `@font-face { font-family: 'Source Sans 3';
    font-weight: ${weight}; src: url(data:font/woff2;base64,${data(
      'src',
      'reskin',
      'fonts',
      `source-sans-3-latin-${weight}-normal.woff2`
    )}) format('woff2'); }`;
  const chips = [
    'Scan',
    'Sign with Digital IDs',
    'Edit',
    'Convert',
    'Fill forms',
    'OCR',
  ]
    .map((c) => `<span class="chip"><i></i>${c}</span>`)
    .join('');
  // hero-dark.png is the window (2160×1350) at (120, 120) in a 2400×1590 frame
  const k = 800 / 2160;
  return `<style>${font(400)}${font(600)}${font(700)}
      body { background: #0b0a12; font-family: 'Source Sans 3'; color: #fff; }
      .chip { display: inline-flex; align-items: center; gap: 7px; padding: 7px 14px;
        border-radius: 999px; font-weight: 600; font-size: 19px;
        background: rgb(255 255 255 / 0.09); border: 1px solid rgb(255 255 255 / 0.16); }
      .chip i { width: 8px; height: 8px; border-radius: 50%; background: #ff5a74; }
    </style>
    <div style="position: absolute; right: -200px; top: -180px; width: 1100px; height: 700px;
      opacity: 0.9; background: url(data:image/webp;base64,${data('src', 'acro', 'edition', 'about-dark.webp')})
        center / cover;
      -webkit-mask-image: radial-gradient(closest-side at 60% 45%, #000 50%, transparent 100%)"></div>
    <div style="position: absolute; left: -200px; bottom: -260px; width: 700px; height: 600px;
      background: radial-gradient(closest-side, rgb(215 25 58 / 0.35), transparent)"></div>
    <div style="position: absolute; left: 640px; top: 110px; width: 800px; height: 500px;
      border-radius: 14px; box-shadow: 0 0 0 1px rgb(255 255 255 / 0.12), 0 30px 80px rgb(0 0 0 / 0.6);
      transform: perspective(1800px) rotateY(-16deg) rotateX(5deg); transform-origin: left center;
      background: url(data:image/png;base64,${data('docs', 'screenshots', 'hero-dark.png')})
        ${-120 * k}px ${-120 * k}px / ${2400 * k}px ${1590 * k}px no-repeat"></div>
    <div style="position: absolute; left: 72px; top: 92px; width: 540px">
      <div style="display: flex; align-items: center; gap: 18px">
        <img src="data:image/png;base64,${data('desktop', 'build', 'icon.png')}"
          style="width: 76px; height: 76px; filter: drop-shadow(0 8px 24px rgb(215 25 58 / 0.5))">
        <div style="font-size: 84px; line-height: 1; font-weight: 700; letter-spacing: -1.5px">Paperwing</div>
      </div>
      <div style="font-size: 31px; line-height: 1.25; margin: 28px 0 26px; color: #e9e6f2">The
        <b>free, open-source</b> alternative to Adobe Acrobat.</div>
      <div style="display: flex; flex-wrap: wrap; gap: 10px; width: 480px">${chips}</div>
    </div>
    <div style="position: absolute; left: 72px; bottom: 50px; color: #a9a3bd; font-size: 21px;
      line-height: 1.5">Windows · macOS · Offline · No account<br>
      <span style="color: #fff; font-weight: 600">paperwingapp.com</span></div>`;
}
