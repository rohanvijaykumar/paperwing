/**
 * Saved signatures (Fill & Sign keeps up to 5 in PDF.js's storage,
 * "pdfjs.signature", on the tool pages' origin) survive restarting the app.
 *   node bench/check-signatures.mjs <a.pdf>
 */
import { rmSync } from 'node:fs';
import { launch, sleep } from './harness.mjs';

const file = process.argv[2];

async function signFrame(app) {
  const { page } = app;
  await app.openFile(file);
  for (let i = 0; i < 200; i++) {
    const ready = await page.evaluate(
      () =>
        document.querySelector('#view-doc.is-active') &&
        !document.querySelector('#doc-stage.is-loading')
    );
    if (ready) break;
    await sleep(150);
  }
  await sleep(1000);
  await page.evaluate(() =>
    [...document.querySelectorAll('.lp:not([hidden]) .lp-tool')]
      .find((b) => /Fill & Sign/.test(b.textContent))
      .click()
  );
  for (let i = 0; i < 200; i++) {
    const frame = page
      .frames()
      .find((f) => f.url().includes('pdfjs-viewer/viewer.html'));
    if (frame) return frame;
    await sleep(150);
  }
  throw new Error('Fill & Sign viewer frame not found');
}

let app = await launch();
const profile = app.userData;
let frame = await signFrame(app);
const origin = await frame.evaluate(() => location.origin);
await frame.evaluate(() =>
  localStorage.setItem(
    'pdfjs.signature',
    JSON.stringify({ 'pw-check': { lines: [] } })
  )
);
await sleep(1500);
await app.close({ keepProfile: true });
await sleep(800);

app = await launch({ profile });
frame = await signFrame(app);
const kept = await frame.evaluate(() =>
  localStorage.getItem('pdfjs.signature')
);
const ok = !!kept && kept.includes('pw-check');
console.log(
  `${ok ? 'ok  ' : 'FAIL'} saved signatures survive a restart (origin ${origin}): ${kept}`
);
await app.close();
try {
  rmSync(profile, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
} catch {}
process.exit(ok ? 0 : 1);
