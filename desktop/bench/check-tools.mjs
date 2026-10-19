/**
 * Smoke test of every tool in the desktop app, with a document open: each
 * tool is opened from the All tools sidebar, and the run is recorded:
 *   - how long until it shows (the workspace hides it until it's ready)
 *   - console errors and uncaught exceptions in the tool page
 *   - features the page was refused (permissions policy) and failed
 *     network requests (anything not bundled breaks offline)
 *   - for tools with a main action button (#process-btn): pressing it, and
 *     whether a result comes back to the workspace (acro:download)
 *   - a screenshot of the tool, for reviewing toolbars and layout
 *
 *   node bench/check-tools.mjs <out-dir> [name filter…]
 *
 * Writes <out-dir>/report.json and <out-dir>/<tool>.png.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch } from './harness.mjs';

const [outDir, ...filters] = process.argv.slice(2);
if (!outDir)
  throw new Error('usage: node bench/check-tools.mjs <out-dir> [filter…]');
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SAMPLE = new URL(
  '../../docs/screenshots/samples/Service Agreement - Northbeam.pdf',
  import.meta.url
);

const app = await launch();
const { page } = app;
await page.setViewport({ width: 1440, height: 900 });

// What the tool frames say, attributed to the tool being tested
let current = null;
const note = (kind, text) =>
  current && current[kind].push(String(text).slice(0, 400));
page.on('console', (m) => {
  const url = m.location()?.url ?? '';
  if (!url.startsWith('app://tools')) return;
  if (m.type() === 'error') note('errors', m.text());
  if (/permissions policy|disallowed|not allowed/i.test(m.text()))
    note('blocked', m.text());
});
page.on('pageerror', (e) => note('errors', 'uncaught: ' + e.message));
page.on('requestfailed', (r) => {
  if (/^(app|data|blob):/.test(r.url())) return;
  note('network', `${r.failure()?.errorText} ${r.url()}`);
});
page.on('request', (r) => {
  // (the update check is the app's own, and optional)
  if (
    !/^(app|data|blob|devtools|chrome-extension):/.test(r.url()) &&
    !r.url().startsWith('https://api.github.com/repos/')
  )
    note('online', r.url());
});
page.on('dialog', (d) => {
  note('dialogs', `${d.type()}: ${d.message()}`);
  d.dismiss().catch(() => {});
});

// The results the workspace receives
await page.evaluate(() => {
  window.__results = [];
  window.addEventListener('message', (e) => {
    if (e.data?.type === 'acro:download')
      window.__results.push({
        name: e.data.name,
        size: e.data.blob?.size ?? 0,
      });
  });
});

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

/** Every tool in the All tools sidebar: [{ name, group }] */
async function toolList() {
  return page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // Each click redraws the list: look again every time
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
    let group = '';
    for (const el of document.querySelectorAll(
      '#left-panel .lp-section, #left-panel .lp-group, #left-panel .lp-tool'
    )) {
      if (!el.getClientRects().length) continue;
      if (!el.classList.contains('lp-tool')) {
        group = el.textContent.replace(/\d+$/, '').trim();
        continue;
      }
      const name =
        el.querySelector('span')?.textContent.trim() || el.textContent.trim();
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, group });
    }
    return out;
  });
}

async function clickTool(name) {
  return page.evaluate((name) => {
    const b = [...document.querySelectorAll('#left-panel .lp-tool')].find(
      (x) =>
        x.getClientRects().length &&
        (x.querySelector('span')?.textContent.trim() ||
          x.textContent.trim()) === name
    );
    if (!b) return false;
    b.click();
    return true;
  }, name);
}

async function closeTools() {
  await page.evaluate(() => {
    document.querySelector('.full-head .pill-btn')?.click();
    document.querySelector('#left-panel [aria-label="Back to tools"]')?.click();
  });
  await sleep(300);
}

/** Close every tab but the sample document (results open in new tabs) */
async function closeExtraTabs() {
  await page.evaluate(() => {
    const tabs = [
      ...document.querySelectorAll('#tabs [role="tab"]:not(.tab-home)'),
    ];
    for (const t of tabs.slice(1))
      t.querySelector('.tab-close, [aria-label^="Close"]')?.click();
  });
  await sleep(400);
  // "Save changes?" for unsaved results: don't save
  await page.evaluate(() => {
    for (const b of document.querySelectorAll(
      'dialog[open] button, .dlg button'
    ))
      if (/don.?t save|discard/i.test(b.textContent)) b.click();
  });
  await sleep(300);
}

await openSample();
const tools = (await toolList()).filter(
  (t) =>
    !filters.length ||
    filters.some((f) => t.name.toLowerCase().includes(f.toLowerCase()))
);
console.log(`${tools.length} tools`);

const report = [];
for (const t of tools) {
  current = {
    ...t,
    errors: [],
    blocked: [],
    network: [],
    online: [],
    dialogs: [],
  };
  report.push(current);
  try {
    await closeTools();
    await closeExtraTabs();
    await page.evaluate(() => {
      // (clicking it while it's open would close the panel)
      const all = document.querySelector('#gb-tabs [data-panel="all"]');
      if (!all?.classList.contains('is-active')) all?.click();
      window.__results.length = 0;
    });
    await sleep(200);
    await toolList(); // expands the sections again
    const t0 = Date.now();
    if (!(await clickTool(t.name))) {
      current.status = 'not found in sidebar';
      continue;
    }
    // Viewer actions (Add comments, Redact) open no frame
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
    current.shownMs = shown ? Date.now() - t0 : null;
    await sleep(1500);
    const frame = page
      .frames()
      .find((f) => f.url().startsWith('app://tools/') && !f.isDetached());
    current.page = frame ? new URL(frame.url()).pathname : null;
    const where = await page.evaluate(() =>
      document.querySelector('#tool-full .frame-wrap')
        ? 'full'
        : document.querySelector('#left-panel .frame-wrap')
          ? 'panel'
          : 'none'
    );
    current.where = where;
    const clip = await page.evaluate((where) => {
      const el =
        where === 'full'
          ? document.querySelector('#doc-stage')
          : document.querySelector('#view-doc');
      const r = el?.getBoundingClientRect();
      return r && { x: r.x, y: r.y, width: r.width, height: r.height };
    }, where);
    await page.screenshot({
      path: join(outDir, `${t.name.replace(/[^\w-]+/g, '_')}.png`),
      clip: clip ?? undefined,
    });
    if (!frame) {
      current.status = shown ? 'no tool frame' : 'viewer action';
      continue;
    }
    // Main action
    const action = await frame
      .evaluate(() => {
        const b = document.getElementById('process-btn');
        if (!b) return 'none';
        if (!b.getClientRects().length) return 'hidden';
        if (b.disabled) return 'disabled';
        b.click();
        return 'clicked';
      })
      .catch((e) => 'error: ' + e.message);
    current.action = action;
    if (action === 'clicked') {
      const got = await page
        .waitForFunction(() => window.__results.length > 0, {
          timeout: 45000,
          polling: 250,
        })
        .then(() => true)
        .catch(() => false);
      current.results = await page.evaluate(() => window.__results.slice());
      if (!got) {
        // What the tool says instead (an error or a request for input)
        current.toolSays = await frame
          .evaluate(() =>
            [
              ...document.querySelectorAll(
                '[role="alert"], .alert, #alert-modal, [id*="alert"], [id*="error"], .toast'
              ),
            ]
              .filter((e) => e.getClientRects().length)
              .map((e) =>
                e.textContent.trim().replace(/\s+/g, ' ').slice(0, 200)
              )
              .filter(Boolean)
          )
          .catch(() => []);
      }
      current.status = got ? 'result returned' : 'no result';
    } else {
      current.status = `action ${action}`;
    }
  } catch (e) {
    current.status = 'error: ' + e.message.slice(0, 200);
  } finally {
    current.online = [...new Set(current.online)];
    console.log(
      `${t.name.padEnd(28)} ${current.status}${current.shownMs ? ` (${current.shownMs} ms)` : ''}${current.errors.length ? ` errors:${current.errors.length}` : ''}${current.blocked.length ? ' BLOCKED' : ''}${current.online.length ? ` online:${current.online.length}` : ''}`
    );
  }
}
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 1));
await app.close();
