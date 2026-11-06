/**
 * Copying the text a highlight marks (#38), with real key presses and the
 * real menu button: Ctrl+C (⌘C on macOS) with a highlight selected copies
 * its text, and so does Copy text in its menu; for a highlight made in
 * another app (no text noted with it) the text under it is read from the
 * page. Underline counts too; a drawing has no text to copy.
 *   node bench/check-copy-text.mjs
 */
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './harness.mjs';

const file = fileURLToPath(
  new URL(
    '../../docs/screenshots/samples/Service Agreement - Northbeam.pdf',
    import.meta.url
  )
);
let failures = 0;
const check = (ok, what, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
};

const app = await launch({ args: [file] });
const { page } = app;
const cdp = await page.target().createCDPSession();
// CDP modifiers: Ctrl 2, Meta 4
const MOD = process.platform === 'darwin' ? 4 : 2;
const copyKey = async () => {
  for (const type of ['rawKeyDown', 'keyUp'])
    await cdp.send('Input.dispatchKeyEvent', {
      type,
      key: 'c',
      code: 'KeyC',
      modifiers: MOD,
    });
  await sleep(500);
};
for (let i = 0; i < 60; i++) {
  if (
    await page.evaluate(
      () =>
        !!window.__acro?.viewer?.pageInfo(window.__acro.viewer.current)?.total
    )
  )
    break;
  await sleep(250);
}

// What the app writes to the clipboard (the OS clipboard needs focus)
await page.evaluate(() => {
  window.__copied = [];
  const write = navigator.clipboard.writeText.bind(navigator.clipboard);
  navigator.clipboard.writeText = (text) => {
    window.__copied.push(text);
    return write(text).catch(() => {});
  };
});
const lastCopy = () => page.evaluate(() => window.__copied.at(-1) ?? null);

/** Puts an annotation on page 1 over `phrase` and selects it */
const markUp = (phrase, type, noted) =>
  page.evaluate(
    async ({ phrase, type, noted }) => {
      const v = window.__acro.viewer;
      const docId = v.docIds.get(v.current);
      const doc = v.cap('document-manager').getDocument(docId);
      const engine = v.registry.getEngine();
      const glyphs = await engine.getPageGlyphs(doc, doc.pages[0]).toPromise();
      const [text] = await engine
        .getTextSlices(doc, [
          { pageIndex: 0, charIndex: 0, charCount: glyphs.length },
        ])
        .toPromise();
      const at = text.indexOf(phrase);
      if (at < 0) return null;
      const boxes = glyphs.slice(at, at + phrase.length);
      const x1 = Math.min(...boxes.map((g) => g.origin.x));
      const y1 = Math.min(...boxes.map((g) => g.origin.y));
      const x2 = Math.max(...boxes.map((g) => g.origin.x + g.size.width));
      const y2 = Math.max(...boxes.map((g) => g.origin.y + g.size.height));
      const rect = {
        origin: { x: x1, y: y1 },
        size: { width: x2 - x1, height: y2 - y1 },
      };
      const a = v.cap('annotation').forDocument(docId);
      const id = crypto.randomUUID();
      a.createAnnotation(0, {
        type,
        id,
        pageIndex: 0,
        rect,
        ...(type === 15
          ? {
              inkList: [
                {
                  points: [
                    { x: x1, y: y1 },
                    { x: x2, y: y2 },
                  ],
                },
              ],
              strokeWidth: 2,
              color: '#D7193A',
            }
          : { segmentRects: [rect], color: '#FFD84D' }),
        ...(noted ? { custom: { text: noted } } : {}),
      });
      await new Promise((r) => setTimeout(r, 300));
      a.selectAnnotation(0, id);
      await new Promise((r) => setTimeout(r, 400));
      return id;
    },
    { phrase, type, noted }
  );
const menuButton = () =>
  page.evaluate(() => {
    const root = document.querySelector('embedpdf-container').shadowRoot;
    return [...root.querySelectorAll('button')].some(
      (b) =>
        b.getClientRects().length &&
        (b.getAttribute('aria-label') || b.title) === 'Copy text'
    );
  });
const clickMenuButton = () =>
  page.evaluate(() => {
    const root = document.querySelector('embedpdf-container').shadowRoot;
    const b = [...root.querySelectorAll('button')].find(
      (x) => (x.getAttribute('aria-label') || x.title) === 'Copy text'
    );
    b?.click();
    return !!b;
  });
const toasts = () =>
  page.evaluate(() => document.querySelector('#toasts')?.textContent ?? '');

// A highlight made in another app: no text noted with it
const PHRASE = 'Scope of work';
check(!!(await markUp(PHRASE, 9)), 'a highlight is made and selected');
await copyKey();
check(
  (await lastCopy())?.replace(/\s+/g, ' ').trim() === PHRASE,
  "Ctrl+C copies a highlight's text, read from the page",
  JSON.stringify(await lastCopy())
);
check(
  /Copied the highlighted text/.test(await toasts()),
  'and says so',
  await toasts()
);
check(await menuButton(), 'its menu offers Copy text');

// Made from a selection: the text noted with it
await markUp('Timeline', 9, 'Noted when it was made');
await page.evaluate(() => (window.__copied = []));
check(await clickMenuButton(), 'Copy text is clicked');
await sleep(400);
check(
  (await lastCopy()) === 'Noted when it was made',
  'the menu copies the text noted with the highlight',
  JSON.stringify(await lastCopy())
);

// Underline counts; a drawing has no text
await markUp('Fees and payment', 10);
await page.evaluate(() => (window.__copied = []));
await copyKey();
check(
  (await lastCopy())?.replace(/\s+/g, ' ').trim() === 'Fees and payment',
  "Ctrl+C copies an underline's text too",
  JSON.stringify(await lastCopy())
);
await markUp('Intellectual property', 15);
await page.evaluate(() => (window.__copied = []));
await copyKey();
check(
  (await lastCopy()) === null,
  'with a drawing selected, Ctrl+C copies nothing of ours'
);
check(!(await menuButton()), "and a drawing's menu has no Copy text");

// Nothing selected: Ctrl+C is left alone
await page.evaluate(() => {
  const v = window.__acro.viewer;
  v.cap('annotation')
    .forDocument(v.docIds.get(v.current))
    .deselectAnnotation?.();
});
await sleep(300);
check(
  !(await page.evaluate(() =>
    window.__acro.viewer.canCopyMarkupText(window.__acro.viewer.current)
  )),
  "with nothing selected, Ctrl+C is the viewer's (text selections)"
);

await app.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
