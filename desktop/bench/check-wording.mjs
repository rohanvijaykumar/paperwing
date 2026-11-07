/**
 * The desktop app's words in the tools (reskin/desktop-words.mjs), in the
 * real app: the signing tools said "Save & Download Signed PDF" and "Upload
 * certificate", which made a Reddit user think files went to a server.
 * Fill & Sign and Use a certificate are opened on a document; what they
 * show (text and tooltips) mustn't say upload, download, "in your browser"
 * or "your device", and their buttons say Choose and Save. The top bar's
 * Download button says Save a copy.
 *
 *   node bench/check-wording.mjs [screenshot-dir]
 *
 * BENCH_DESKTOP=<another checkout>/desktop runs it on that build (for
 * before and after screenshots).
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './harness.mjs';

const shots = process.argv[2];
if (shots) mkdirSync(shots, { recursive: true });
let failures = 0;
const check = (ok, what, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
};

const sample = fileURLToPath(
  new URL(
    '../../docs/screenshots/samples/Invoice INV-2048.pdf',
    import.meta.url
  )
);
/** What a desktop app's tool mustn't say (true statements aside) */
const SERVER =
  /\bupload|\bdownload|\bin (?:your|the) (?:web )?browser\b|your device/i;
const TRUE =
  /never upload|nothing is uploaded|no uploads?\b|uploaded to any server/i;

const app = await launch();
const { page } = app;
await page.setViewport({ width: 1440, height: 900 });
await app.openFile(sample);
await page.waitForFunction(
  () =>
    document.querySelector('#view-doc.is-active') &&
    !document.querySelector('#doc-stage.is-loading'),
  { timeout: 30000 }
);
await sleep(1200);

/* The top bar: a copy is saved through a save dialog ------------------- */
const pill = await page.$eval('#download-btn', (b) => b.textContent.trim());
check(pill === 'Save a copy', 'the top bar says Save a copy', pill);
if (shots) {
  const r = await page.$eval('#download-btn', (b) => {
    const { right, top, bottom } = b.getBoundingClientRect();
    return { right, top, bottom };
  });
  await page.screenshot({
    path: join(shots, 'top-bar.png'),
    clip: {
      x: Math.max(0, r.right - 660),
      y: Math.max(0, r.top - 8),
      width: 680,
      height: r.bottom - r.top + 16,
    },
  });
}

/** Open a tool from the All tools panel; its frame once it's shown */
async function openTool(names) {
  await page.evaluate(() => {
    document.querySelector('.full-head .pill-btn')?.click();
    document.querySelector('#left-panel [aria-label="Back to tools"]')?.click();
  });
  await sleep(300);
  const name = await page.evaluate(async (names) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const all = document.querySelector('#gb-tabs [data-panel="all"]');
    if (!all?.classList.contains('is-active')) all?.click();
    await wait(200);
    for (let i = 0; i < 40; i++) {
      const closed = document.querySelector(
        '#left-panel .lp-section:not(.is-open)'
      );
      if (!closed) break;
      closed.click();
      await wait(60);
    }
    const tools = [...document.querySelectorAll('#left-panel .lp-tool')].filter(
      (x) => x.getClientRects().length
    );
    for (const n of names) {
      const b = tools.find(
        (x) =>
          (x.querySelector('span')?.textContent.trim() ||
            x.textContent.trim()) === n
      );
      if (b) {
        b.click();
        return n;
      }
    }
    return null;
  }, names);
  if (!name) return null;
  await page
    .waitForFunction(
      () => {
        const b = document.querySelector('.frame-body');
        return b && !b.classList.contains('is-loading');
      },
      { timeout: 20000 }
    )
    .catch(() => {});
  await sleep(1500);
  return page
    .frames()
    .find((f) => f.url().startsWith('app://tools/') && !f.isDetached());
}

/** What a frame shows: its text, and its controls' tooltips */
const shown = (frame) =>
  frame.evaluate(() => {
    const tips = [
      ...document.querySelectorAll('[title], [placeholder], [aria-label]'),
    ]
      .filter((e) => e.getClientRects().length)
      .flatMap((e) =>
        ['title', 'placeholder', 'aria-label'].map((a) => e.getAttribute(a))
      )
      .filter(Boolean);
    return [document.body.innerText, ...tips]
      .join('\n')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  });
const buttons = (frame) =>
  frame.evaluate(() =>
    [...document.querySelectorAll('button, label[for], .btn-gradient')]
      .filter((b) => b.getClientRects().length)
      .map((b) => b.textContent.trim().replace(/\s+/g, ' '))
      .filter(Boolean)
  );
async function shoot(name) {
  if (!shots) return;
  const clip = await page.evaluate(() => {
    const el =
      document.querySelector('#tool-full .frame-wrap') ||
      document.querySelector('#left-panel .frame-wrap')?.closest('#view-doc') ||
      document.querySelector('#view-doc');
    const r = el?.getBoundingClientRect();
    return r && { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  await page.screenshot({
    path: join(shots, `${name}.png`),
    clip: clip ?? undefined,
    captureBeyondViewport: false,
  });
}

/* Fill & Sign ---------------------------------------------------------- */
let frame = await openTool(['Fill & Sign']);
check(!!frame, 'Fill & Sign opens');
if (frame) {
  const says = (await shown(frame)).filter(
    (l) => SERVER.test(l) && !TRUE.test(l)
  );
  check(!says.length, "it doesn't say upload, download or browser", says[0]);
  const b = await buttons(frame);
  check(
    b.some((x) => /^Save Signed PDF$/i.test(x)),
    'its button says Save Signed PDF',
    JSON.stringify(b.filter((x) => /save|download/i.test(x)))
  );
  await shoot('fill-and-sign');
}

/* Use a certificate ---------------------------------------------------- */
frame = await openTool(['Use a certificate', 'Digital Signature']);
if (await page.$('#cert-bar')) {
  // Signing with the certificates installed on the computer: Paperwing's own
  // bar and dialogs over the document, not BentoPDF's page
  await certificateDialogs();
} else {
  check(!!frame, 'Use a certificate opens');
  if (frame) {
    const lines = await shown(frame);
    const says = lines.filter((l) => SERVER.test(l) && !TRUE.test(l));
    check(!says.length, "it doesn't say upload, download or browser", says[0]);
    check(
      lines.some((l) =>
        /^Choose certificate file \(\.pfx, \.p12, \.pem\)/.test(l)
      ),
      'it asks to choose a certificate file',
      lines.find((l) => /certificate \(/i.test(l))
    );
    await shoot('use-a-certificate');
  }
}

/** Use a certificate's bar, Digitally sign's Sign with a Digital ID and
 *  Configure a Digital ID: what they show and their tooltips */
async function certificateDialogs() {
  const words = (selector) =>
    page.evaluate((selector) => {
      const root = document.querySelector(selector);
      if (!root) return [];
      const tips = [
        ...root.querySelectorAll('[title], [placeholder], [aria-label]'),
      ]
        .filter((e) => e.getClientRects().length)
        .flatMap((e) =>
          ['title', 'placeholder', 'aria-label'].map((a) => e.getAttribute(a))
        )
        .filter(Boolean);
      return [root.innerText, ...tips]
        .join('\n')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    }, selector);
  const until = async (fn, timeout = 20000) => {
    for (const end = Date.now() + timeout; Date.now() < end; await sleep(200))
      if (await page.evaluate(fn).catch(() => false)) return true;
    return false;
  };
  check(true, 'Use a certificate opens (its bar, over the document)');
  const lines = await words('#cert-bar');
  // Digitally sign: a click on the page places the box
  await page.click('#cb-sign');
  await until(() =>
    /Drag a box/.test(document.querySelector('#cert-bar')?.textContent)
  );
  const at = await page.evaluate(() => {
    const host = [...document.querySelectorAll('#viewer-host *')].find(
      (e) => e.shadowRoot
    );
    const layer = host?.shadowRoot?.querySelector(
      '.pwsig-layer[data-page="0"]'
    );
    if (!layer) return null;
    const r = layer.getBoundingClientRect();
    const top = Math.max(r.top, host.getBoundingClientRect().top);
    const bottom = Math.min(r.bottom, innerHeight - 10);
    return { x: r.left + r.width / 2, y: (top + bottom) / 2 };
  });
  if (at) await page.mouse.click(at.x, at.y);
  const listed =
    (await until(() => document.querySelector('#cid-dialog'))) &&
    (await until(
      () =>
        !/Looking for/.test(
          document.querySelector('#cid-dialog .cid-list')?.textContent ?? ''
        ),
      30000
    ));
  check(listed, 'Digitally sign: Sign with a Digital ID opens');
  lines.push(...(await words('#cid-dialog')));
  await page.click('#cid-configure').catch(() => {});
  const configure = await until(() => document.querySelector('#cfg-dialog'));
  const cfg = await words('#cfg-dialog');
  lines.push(...cfg);
  const says = lines.filter((l) => SERVER.test(l) && !TRUE.test(l));
  check(!says.length, "it doesn't say upload, download or browser", says[0]);
  check(
    configure && cfg.some((l) => /^Use a Digital ID from a file/.test(l)),
    'Configure a Digital ID: use an ID from a file (chosen, not uploaded)',
    cfg.slice(0, 4).join(' | ')
  );
  await shoot('use-a-certificate');
  for (let k = 0; k < 3; k++) await page.keyboard.press('Escape');
}

await app.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
