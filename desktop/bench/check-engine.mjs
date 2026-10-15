/**
 * The PDF engine must not fail while moving through a document: jumping to
 * a page (smooth and instant) and flinging through it, at two zoom levels.
 *   node bench/check-engine.mjs <long.pdf>
 * Use a long PDF whose text isn't embedded (bench/make-fixture.mjs makes
 * one): that's what exercises the fallback fonts.
 */
import { launch, sleep } from './harness.mjs';

const file = process.argv[2];
let failures = 0;

async function run(mode, zoom) {
  const app = await launch();
  const { page } = app;
  await page.evaluate(() => {
    window.__fails = 0;
    window.__renders = 0;
    const orig = Worker.prototype.postMessage;
    const seen = new WeakSet();
    Worker.prototype.postMessage = function (msg, ...rest) {
      if (!seen.has(this)) {
        seen.add(this);
        this.addEventListener('message', (e) => {
          if (e.data?.type === 'error') window.__fails++;
        });
      }
      if (msg?.type === 'execute' && /^render/.test(msg.method))
        window.__renders++;
      return orig.call(this, msg, ...rest);
    };
  });
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
  await sleep(2500);
  await page.evaluate(
    async (mode, zoom) => {
      const v = window.__acro.viewer;
      const tab = [...v.docIds.keys()].at(-1);
      if (zoom) v.setZoom(tab, zoom);
      await new Promise((r) => setTimeout(r, 500));
      const target = Math.min(120, v.pageInfo(tab).total);
      if (mode === 'smooth') v.goToPage(tab, target);
      else if (mode === 'instant')
        v.cap('scroll')
          .forDocument(v.docIds.get(tab))
          .scrollToPage({ pageNumber: target, behavior: 'instant' });
      else {
        const scroller = document
          .querySelector('#viewer-host embedpdf-container')
          .shadowRoot.querySelector('div.bg-bg-app');
        const end = performance.now() + 4000;
        while (performance.now() < end) {
          scroller.scrollTop += 300;
          await new Promise((r) => requestAnimationFrame(r));
        }
      }
    },
    mode,
    zoom
  );
  await sleep(4000);
  const r = await page.evaluate(() => ({
    fails: window.__fails,
    renders: window.__renders,
  }));
  const ok = r.fails === 0 && r.renders > 0;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${mode} at ${zoom ? `${zoom * 100}%` : 'default zoom'}: ${r.renders} renders, ${r.fails} engine failures`
  );
  if (!ok) failures++;
  await app.close();
}

for (const zoom of [null, 0.8])
  for (const mode of ['smooth', 'instant', 'fling']) await run(mode, zoom);
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
