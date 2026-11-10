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

/** The repository's social image (1280×640) as a page body: name and
 *  tagline beside the window (`png`: the hero's workspace, base64) */
export function socialPreviewBody(png) {
  const data = (file) => readFileSync(file).toString('base64');
  const font = (
    weight
  ) => `@font-face { font-family: 'Source Sans 3'; font-weight: ${weight};
    src: url(data:font/woff2;base64,${data(
      resolve(
        here,
        '..',
        '..',
        'src',
        'reskin',
        'fonts',
        `source-sans-3-latin-${weight}-normal.woff2`
      )
    )}) format('woff2'); }`;
  return `<style>${font(400)}${font(700)}
      .text { position: absolute; left: 64px; font-family: 'Source Sans 3'; }
    </style>
    <div style="position: absolute; inset: 0; background:
      radial-gradient(560px 420px at 0 0, #ffe3df, rgb(255 227 223 / 0)),
      radial-gradient(640px 420px at 100% 100%, #e7e9ff, rgb(231 233 255 / 0)), #f7f5f6"></div>
    <img src="data:image/png;base64,${data(resolve(here, '..', 'build', 'icon.png'))}"
      style="position: absolute; left: 64px; top: 165px; width: 84px; height: 84px">
    <div class="text" style="top: 280px; font-size: 63px; font-weight: 700; line-height: 1.2;
      color: #1d1d1f; letter-spacing: -1px">Paperwing</div>
    <div class="text" style="top: 365px; font-size: 26.5px; line-height: 35px; color: #3a3a3c">
      The free, open-source alternative<br>to Adobe Acrobat.</div>
    <div class="text" style="top: 453px; font-size: 18.4px; line-height: 1.4; color: #6e6e73">
      Windows · macOS · Offline · No account</div>
    ${windowHtml(png, { x: 544, y: 85, s: 878 / 2160 })}`;
}
