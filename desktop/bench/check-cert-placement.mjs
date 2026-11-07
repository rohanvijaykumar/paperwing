/**
 * Digitally sign on rotated and cropped pages, with real clicks: on pages
 * with /Rotate 0, 90, 180 and 270, a CropBox inside the MediaBox and a
 * MediaBox that doesn't start at 0,0, drag a box on the page as shown, sign,
 * and check the signature field lands exactly where the box was drawn
 * (pdf.js, independently, converts the drawn box to PDF coordinates)
 * (pass/fail).
 *
 *   PW_TEST_CERTS=certs.json node bench/check-cert-placement.mjs
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch, sleep } from './harness.mjs';

const require = createRequire(import.meta.url);
const {
  PDFDocument,
  StandardFonts,
  degrees,
  PDFName,
  PDFNumber,
} = require('../../node_modules/pdf-lib');
const pdfjs = await import(
  pathToFileURL(
    require.resolve('../../node_modules/pdfjs-dist/legacy/build/pdf.mjs')
  ).href
);

const TMP = process.env.BENCH_TMP || 'D:/tmp/paperwing-bench';
const OUT = join(TMP, 'cert-placement');
const spec = JSON.parse(
  readFileSync(process.env.PW_TEST_CERTS, 'utf8').replace(/^\uFEFF/, '')
);
const signer =
  spec.find((c) => c.label === 'rsa') ??
  spec.find((c) => c.expect === 'usable');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const CASES = [
  { name: 'rot0', rotate: 0, media: [0, 0, 612, 792], crop: [0, 0, 612, 792] },
  {
    name: 'rot90',
    rotate: 90,
    media: [0, 0, 612, 792],
    crop: [0, 0, 612, 792],
  },
  {
    name: 'rot180',
    rotate: 180,
    media: [0, 0, 612, 792],
    crop: [0, 0, 612, 792],
  },
  {
    name: 'rot270',
    rotate: 270,
    media: [0, 0, 612, 792],
    crop: [0, 0, 612, 792],
  },
  {
    name: 'crop',
    rotate: 0,
    media: [0, 0, 612, 792],
    crop: [40, 90, 520, 700],
  },
  {
    name: 'crop-rot90',
    rotate: 90,
    media: [20, 30, 632, 822],
    crop: [60, 120, 540, 760],
  },
  // Zoomed just as Digitally sign starts (the viewer reports the new layout
  // before it has moved the pages): the page still takes a box
  {
    name: 'crop-rot90-zoomed',
    rotate: 90,
    media: [20, 30, 632, 822],
    crop: [60, 120, 540, 760],
    zoomAtStart: true,
  },
  {
    name: 'crop-rot270',
    rotate: 270,
    media: [0, 0, 612, 792],
    crop: [40, 90, 520, 700],
  },
];

async function fixture(c) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const [mx, my, mx1, my1] = c.media;
  const p = doc.addPage([mx1 - mx, my1 - my]);
  p.setMediaBox(mx, my, mx1 - mx, my1 - my);
  p.setCropBox(
    c.crop[0],
    c.crop[1],
    c.crop[2] - c.crop[0],
    c.crop[3] - c.crop[1]
  );
  p.drawText(`${c.name}: the top of the text is up`, {
    x: c.crop[0] + 30,
    y: c.crop[3] - 60,
    size: 18,
    font,
  });
  p.setRotation(degrees(c.rotate));
  const file = join(OUT, `${c.name}.pdf`);
  writeFileSync(file, await doc.save());
  return file;
}

let failed = 0;
const check = (ok, what, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
};
const until = async (fn, timeout = 20000) => {
  const end = Date.now() + timeout;
  let v;
  while (Date.now() < end) {
    v = await fn().catch(() => null);
    if (v) return v;
    await sleep(200);
  }
  return v;
};

for (const c of CASES) {
  const file = await fixture(c);
  const app = await launch({
    args: [file],
    env: { PAPERWING_TEST_SAVE_DIR: OUT },
  });
  const { page } = app;
  const text = (sel) =>
    page.evaluate((s) => document.querySelector(s)?.textContent ?? '', sel);
  try {
    await until(
      () =>
        page.evaluate(
          () =>
            document.querySelector('#view-doc.is-active') &&
            !document.querySelector('#doc-stage.is-loading')
        ),
      30000
    );
    await sleep(1500);
    for (const h of await page.$$('.lp:not([hidden]) .lp-tool'))
      if (
        (await h.evaluate((e) => e.textContent)).includes('Use a certificate')
      ) {
        await h.click();
        break;
      }
    await until(() =>
      page.evaluate(() => !!document.querySelector('#cb-sign'))
    );
    await page.click('#cb-sign');
    if (c.zoomAtStart)
      for (let i = 0; i < 2; i++)
        await page.evaluate(() => {
          const host = [...document.querySelectorAll('#viewer-host *')].find(
            (e) => e.shadowRoot
          );
          [
            ...document.querySelectorAll('button'),
            ...(host?.shadowRoot?.querySelectorAll('button') ?? []),
          ]
            .find(
              (b) =>
                b.getAttribute('aria-label') === 'Zoom in' ||
                b.title === 'Zoom in'
            )
            ?.click();
        });
    const readLayer = () =>
      page.evaluate(() => {
        const host = [...document.querySelectorAll('#viewer-host *')].find(
          (e) => e.shadowRoot
        );
        const l = host?.shadowRoot?.querySelector(
          '.pwsig-layer[data-page="0"]'
        );
        if (!l) return null;
        const r = l.getBoundingClientRect();
        const top = Math.max(r.top, host.getBoundingClientRect().top);
        const bottom = Math.min(r.bottom, innerHeight - 10);
        return r.width > 0
          ? {
              left: r.left,
              top: r.top,
              w: r.width,
              h: r.height,
              visTop: top,
              visBottom: bottom,
            }
          : null;
      });
    let layer = await until(readLayer);
    // Zoomed: wait until the page has stopped moving before drawing on it
    for (let n = 0; c.zoomAtStart && layer && n < 20; n++) {
      await sleep(500);
      const again = await readLayer();
      const same =
        !!again &&
        ['left', 'top', 'w', 'h'].every(
          (k) => Math.abs(again[k] - layer[k]) < 1
        );
      layer = again ?? layer;
      if (same) break;
    }
    if (!layer) {
      // (what the page looked like, to tell why)
      const why = await page.evaluate(() => {
        const host = [...document.querySelectorAll('#viewer-host *')].find(
          (e) => e.shadowRoot
        );
        return {
          bar: document.querySelector('#cert-bar')?.textContent,
          layers: host?.shadowRoot?.querySelectorAll('.pwsig-layer').length,
        };
      });
      throw new Error(`the page took no box: ${JSON.stringify(why)}`);
    }
    // A box in the visible part of the page: from 20% to 60% across, and a
    // band near the top of what's on screen (the middle when zoomed in, clear
    // of the bar over the top of the document)
    const x0 = layer.left + layer.w * 0.2;
    const x1 = layer.left + layer.w * 0.6;
    const y0 =
      layer.visTop +
      (layer.visBottom - layer.visTop) * (c.zoomAtStart ? 0.45 : 0.15);
    const y1 = y0 + Math.min(70, (layer.visBottom - layer.visTop) * 0.12);
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 6 });
    await page.mouse.move(x1, y1, { steps: 6 });
    await page.mouse.up();
    const box = {
      x: (x0 - layer.left) / layer.w,
      y: (y0 - layer.top) / layer.h,
      width: (x1 - x0) / layer.w,
      height: (y1 - y0) / layer.h,
    };
    if (
      !(await until(
        async () => (await page.$$('#cid-dialog .cid-row')).length > 0,
        30000
      ))
    )
      throw new Error(
        `the box was drawn, but Sign with a Digital ID didn’t open (bar: ${await text('#cert-bar')})`
      );
    await page.evaluate((name) => {
      [...document.querySelectorAll('#cid-dialog .cid-row')]
        .find((r) => r.querySelector('.cid-name b')?.textContent === name)
        ?.click();
    }, signer.name);
    await page.click('#cid-continue');
    await until(() =>
      page.evaluate(() => !!document.querySelector('#sas-sign'))
    );
    await page.click('#sas-sign');
    const saved = await until(
      async () => /Signed and saved/.test(await text('#toasts')),
      60000
    );
    check(!!saved, `${c.name}: signed`);
    // (the signed page and its field drawn again)
    await sleep(3000);
    await page.screenshot({ path: join(OUT, `${c.name}.png`) });

    // Where the field is, and where pdf.js says the drawn box is
    const signed = readFileSync(join(OUT, `${c.name} (signed).pdf`));
    const doc = await PDFDocument.load(signed);
    const annots = doc.getPage(0).node.Annots();
    const widget = doc.context.lookup(annots.get(annots.size() - 1));
    const r = widget
      .get(PDFName.of('Rect'))
      .asArray()
      .map((n) => n.asNumber());
    const rect = [
      Math.min(r[0], r[2]),
      Math.min(r[1], r[3]),
      Math.max(r[0], r[2]),
      Math.max(r[1], r[3]),
    ];
    const pdf = await pdfjs.getDocument({
      data: new Uint8Array(readFileSync(file)),
    }).promise;
    const vp = (await pdf.getPage(1)).getViewport({ scale: 1 });
    const [ax, ay] = vp.convertToPdfPoint(box.x * vp.width, box.y * vp.height);
    const [bx, by] = vp.convertToPdfPoint(
      (box.x + box.width) * vp.width,
      (box.y + box.height) * vp.height
    );
    await pdf.destroy();
    const want = [
      Math.min(ax, bx),
      Math.min(ay, by),
      Math.max(ax, bx),
      Math.max(ay, by),
    ];
    const off = Math.max(...rect.map((v, i) => Math.abs(v - want[i])));
    check(
      off < 2,
      `${c.name}: the field is where the box was drawn`,
      `field [${rect.map((v) => v.toFixed(1))}] box [${want.map((v) => v.toFixed(1))}], off by ${off.toFixed(2)} pt`
    );
  } catch (e) {
    failed++;
    console.log(`FAIL ${c.name}: ${e?.stack ?? e}`);
  } finally {
    await app.close();
  }
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
