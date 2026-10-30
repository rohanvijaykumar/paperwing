/**
 * Captures every dialog, in the light and the dark theme, for reviewing
 * how they look side by side: the workspace's (Preferences, Keyboard
 * shortcuts, About, Document properties, Print, Clear recent files) and a
 * tool's own message (PDF to JPG's "done").
 *
 *   node bench/capture-dialogs.mjs <out-dir>
 *
 * Writes <out-dir>/<theme>-<dialog>.png.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch } from './harness.mjs';

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error('usage: node bench/capture-dialogs.mjs <out-dir>');
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SAMPLE = new URL(
  '../../docs/screenshots/samples/Service Agreement - Northbeam.pdf',
  import.meta.url
);

const app = await launch();
const { page } = app;
await page.setViewport({ width: 1440, height: 900 });

await page.evaluate((b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const dt = new DataTransfer();
  dt.items.add(
    new File([bytes], 'Service Agreement - Northbeam.pdf', {
      type: 'application/pdf',
    })
  );
  window.dispatchEvent(
    new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
  );
}, readFileSync(SAMPLE).toString('base64'));
await page.waitForFunction(
  () =>
    document.querySelector('#view-doc.is-active') &&
    !document.querySelector('#doc-stage.is-loading'),
  { timeout: 30000 }
);
await sleep(1500);

/** Clicks a menu's item by its label */
const fromMenu = (button, label) => async () => {
  await page.click(button);
  await sleep(300);
  await page.evaluate((label) => {
    [...document.querySelectorAll('.menu-item')]
      .find((m) => m.textContent.trim().startsWith(label))
      ?.click();
  }, label);
};

async function shot(name) {
  await sleep(700);
  const rect = await page.evaluate(() => {
    const d = [...document.querySelectorAll('.dlg')].pop();
    const r = d?.getBoundingClientRect();
    return r && { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  if (!rect) return console.log(`${name}: no dialog`);
  const pad = 16;
  await page.screenshot({
    path: join(outDir, `${name}.png`),
    clip: {
      x: Math.max(0, rect.x - pad),
      y: Math.max(0, rect.y - pad),
      width: Math.min(1440, rect.width + pad * 2),
      height: Math.min(900, rect.height + pad * 2),
    },
    captureBeyondViewport: false,
  });
  console.log(`${name}: ${Math.round(rect.width)}x${Math.round(rect.height)}`);
}

const close = async () => {
  await page.keyboard.press('Escape');
  await sleep(300);
  await page.evaluate(() => document.querySelector('.dlg-backdrop')?.remove());
};

const DIALOGS = {
  preferences: fromMenu('#menu-btn', 'Preferences'),
  'document-properties': fromMenu('#menu-btn', 'Document properties'),
  print: fromMenu('#menu-btn', 'Print'),
  shortcuts: fromMenu('#help-btn', 'Keyboard shortcuts'),
  about: fromMenu('#help-btn', 'About Paperwing'),
};

for (const theme of ['light', 'dark']) {
  await page.evaluate((theme) => {
    localStorage.setItem('paperwing:theme', theme);
    window.dispatchEvent(new CustomEvent('paperwing:themechange'));
  }, theme);
  await sleep(500);
  for (const [name, open] of Object.entries(DIALOGS)) {
    await open();
    await shot(`${theme}-${name}`);
    await close();
  }

  // A tool's own message: PDF to JPG's "done"
  await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const all = document.querySelector('#gb-tabs [data-panel="all"]');
    if (!all?.classList.contains('is-active')) all?.click();
    await wait(300);
    for (const s of document.querySelectorAll(
      '#left-panel .lp-section:not(.is-open)'
    ))
      s.click();
    await wait(300);
    [...document.querySelectorAll('#left-panel .lp-tool')]
      .find((x) => x.textContent.trim() === 'PDF to JPG')
      ?.click();
  });
  await sleep(4000);
  const frame = page
    .frames()
    .find((f) => f.url().includes('pdf-to-jpg') && !f.isDetached());
  await frame?.evaluate(() => document.getElementById('process-btn')?.click());
  await frame
    ?.waitForFunction(
      () => document.querySelector('#alert-modal:not(.hidden)'),
      { timeout: 30000 }
    )
    .catch(() => {});
  await sleep(500);
  const r = await page.evaluate(() => {
    const f =
      document.querySelector('#left-panel .frame-wrap iframe') ??
      document.querySelector('#tool-full .frame-wrap iframe');
    const b = f?.getBoundingClientRect();
    return b && { x: b.x, y: b.y, width: b.width, height: b.height };
  });
  if (r) {
    await page.screenshot({
      path: join(outDir, `${theme}-tool-message.png`),
      clip: r,
      captureBeyondViewport: false,
    });
    console.log(`${theme}-tool-message`);
  }
  await frame?.evaluate(() =>
    document.querySelector('#alert-modal:not(.hidden) #alert-ok')?.click()
  );
  await sleep(500);
  await page.evaluate(() => {
    document.querySelector('#left-panel [aria-label="Back to tools"]')?.click();
    for (const t of [
      ...document.querySelectorAll('#tabs [role="tab"]:not(.tab-home)'),
    ].slice(1))
      t.querySelector('.tab-close, [aria-label^="Close"]')?.click();
  });
  await sleep(500);
}
await app.close();
