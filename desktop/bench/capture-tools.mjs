/**
 * Captures every tool, in the light and the dark theme, with a document
 * open, for reviewing how they look: each tool is opened from the All tools
 * sidebar and scrolled through, one picture per screenful.
 *
 *   node bench/capture-tools.mjs <out-dir> [name filter…]
 *
 * Writes <out-dir>/<theme>/<tool>-<n>.png and <out-dir>/index.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch } from './harness.mjs';

const [outDir, ...filters] = process.argv.slice(2);
if (!outDir)
  throw new Error('usage: node bench/capture-tools.mjs <out-dir> [filter…]');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SAMPLE = new URL(
  '../../docs/screenshots/samples/Service Agreement - Northbeam.pdf',
  import.meta.url
);
/** Most pictures a tool gets, scrolling down */
const MAX_SHOTS = 6;

const app = await launch();
const { page } = app;
await page.setViewport({ width: 1440, height: 900 });
page.on('dialog', (d) => d.dismiss().catch(() => {}));

async function openSample() {
  const b64 = readFileSync(SAMPLE).toString('base64');
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(
      new File([bytes], 'Service Agreement - Northbeam.pdf', {
        type: 'application/pdf',
      })
    );
    window.dispatchEvent(
      new DragEvent('drop', {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
      })
    );
  }, b64);
  await page.waitForFunction(
    () =>
      document.querySelector('#view-doc.is-active') &&
      !document.querySelector('#doc-stage.is-loading'),
    { timeout: 30000 }
  );
  await sleep(1200);
}

async function toolList() {
  return page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 40; i++) {
      const closed = document.querySelector(
        '#left-panel .lp-section:not(.is-open)'
      );
      if (!closed) break;
      closed.click();
      await wait(60);
    }
    await wait(200);
    const seen = new Set();
    const out = [];
    for (const el of document.querySelectorAll('#left-panel .lp-tool')) {
      if (!el.getClientRects().length) continue;
      const name =
        el.querySelector('span')?.textContent.trim() || el.textContent.trim();
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
    return out;
  });
}

const clickTool = (name) =>
  page.evaluate((name) => {
    const b = [...document.querySelectorAll('#left-panel .lp-tool')].find(
      (x) =>
        x.getClientRects().length &&
        (x.querySelector('span')?.textContent.trim() ||
          x.textContent.trim()) === name
    );
    b?.click();
    return !!b;
  }, name);

async function closeTools() {
  await page.evaluate(() => {
    document.querySelector('.full-head .pill-btn')?.click();
    document.querySelector('#left-panel [aria-label="Back to tools"]')?.click();
  });
  await sleep(300);
  // Results open in new tabs: close all but the document, without saving
  await page.evaluate(() => {
    const tabs = [
      ...document.querySelectorAll('#tabs [role="tab"]:not(.tab-home)'),
    ];
    for (const t of tabs.slice(1))
      t.querySelector('.tab-close, [aria-label^="Close"]')?.click();
  });
  await sleep(300);
  await page.evaluate(() => {
    for (const b of document.querySelectorAll(
      'dialog[open] button, .dlg button'
    ))
      if (/don.?t save|discard/i.test(b.textContent)) b.click();
  });
}

/** The workspace's theme preference (the tool frames follow it) */
async function setTheme(theme) {
  await page.evaluate((theme) => {
    localStorage.setItem('paperwing:theme', theme);
    window.dispatchEvent(new CustomEvent('paperwing:themechange'));
  }, theme);
  await sleep(500);
}

await openSample();
const all = await toolList();
const tools = all.filter(
  (n) =>
    !filters.length ||
    filters.some((f) => n.toLowerCase().includes(f.toLowerCase()))
);
console.log(`${tools.length} tools`);
const index = [];

for (const theme of ['light', 'dark']) {
  mkdirSync(join(outDir, theme), { recursive: true });
  await setTheme(theme);
  for (const name of tools) {
    const entry = { theme, name, shots: [] };
    index.push(entry);
    try {
      await closeTools();
      await page.evaluate(() => {
        const a = document.querySelector('#gb-tabs [data-panel="all"]');
        if (!a?.classList.contains('is-active')) a?.click();
      });
      await sleep(200);
      await toolList();
      if (!(await clickTool(name))) {
        entry.status = 'not found';
        continue;
      }
      const shown = await page
        .waitForFunction(
          () => {
            const b = document.querySelector('.frame-body');
            return b && !b.classList.contains('is-loading');
          },
          { timeout: 15000 }
        )
        .then(() => true)
        .catch(() => false);
      await sleep(1800);
      const frame = page
        .frames()
        .find((f) => f.url().startsWith('app://tools/') && !f.isDetached());
      if (!shown || !frame) {
        entry.status = 'no tool page';
        continue;
      }
      entry.page = new URL(frame.url()).pathname;
      // Until the tool has finished loading the document (its own loader)
      await frame
        .waitForFunction(
          () => !document.querySelector('#loader-modal:not(.hidden)'),
          { timeout: 15000 }
        )
        .catch(() => {});
      const rect = await page.evaluate(() => {
        const f =
          document.querySelector('#tool-full .frame-wrap iframe') ??
          document.querySelector('#left-panel .frame-wrap iframe');
        const r = f?.getBoundingClientRect();
        return r && { x: r.x, y: r.y, width: r.width, height: r.height };
      });
      if (!rect) {
        entry.status = 'no frame';
        continue;
      }
      // Sections people open (Advanced settings, options): opened, so
      // what's in them is seen too
      await frame.evaluate(() => {
        document
          .querySelectorAll('details:not([open])')
          .forEach((d) => (d.open = true));
        for (const el of document.querySelectorAll(
          '[aria-expanded="false"], button, [role="button"], h3, h4'
        )) {
          const text = (el.textContent || '').trim();
          if (
            text.length > 80 ||
            !/advanced|more options|^options|settings/i.test(text)
          )
            continue;
          if (el.getAttribute('aria-expanded') === 'true') continue;
          // (a <details> was opened above: clicking its summary would close it)
          if (el.closest('summary')) continue;
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          el.click();
        }
      });
      await sleep(400);
      // The element that scrolls in the tool page
      await frame.evaluate(() => {
        const candidates = [
          document.scrollingElement,
          ...document.querySelectorAll('*'),
        ];
        window.__scroller =
          candidates.find(
            (el) =>
              el &&
              el.scrollHeight > el.clientHeight + 40 &&
              el.clientHeight > 200 &&
              /(auto|scroll)/.test(
                getComputedStyle(el).overflowY +
                  (el === document.scrollingElement ? 'auto' : '')
              )
          ) ?? document.scrollingElement;
        window.__scroller.scrollTop = 0;
      });
      const base = name.replace(/[^\w-]+/g, '_');
      for (let n = 1; n <= MAX_SHOTS; n++) {
        await sleep(250);
        const file = `${base}-${n}.png`;
        // (captureBeyondViewport would resize the page while it's taken,
        // which tools that follow the window's size, such as Crop's cropper
        // and the PDF viewers, pick up halfway)
        await page.screenshot({
          path: join(outDir, theme, file),
          clip: rect,
          captureBeyondViewport: false,
        });
        entry.shots.push(file);
        const more = await frame.evaluate(() => {
          const s = window.__scroller;
          if (s.scrollTop + s.clientHeight >= s.scrollHeight - 4) return false;
          s.scrollTop += s.clientHeight * 0.85;
          return true;
        });
        if (!more) break;
      }
      entry.status = 'ok';
    } catch (err) {
      entry.status = `error: ${err.message}`;
    }
    console.log(
      `${theme.padEnd(5)} ${name.padEnd(28)} ${entry.status} ${entry.shots.length}`
    );
  }
}
writeFileSync(join(outDir, 'index.json'), JSON.stringify(index, null, 2));
await app.close();
