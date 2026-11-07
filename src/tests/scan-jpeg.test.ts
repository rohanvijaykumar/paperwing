// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { encodeGrayJpeg, optimalTable, quantTable } from '../acro/scan-jpeg';

/** A gradient with a sharp black square: smooth and hard edges */
function picture(w: number, h: number) {
  const px = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      px[y * w + x] = x > 20 && x < 40 && y > 10 && y < 30 ? 0 : Math.round((x / (w - 1)) * 255);
  return px;
}

async function decode(jpeg: Uint8Array, w: number, h: number) {
  // pdf.js decodes it, as it would in the PDF
  const doc = await PDFDocument.create();
  const img = await doc.embedJpg(jpeg);
  doc.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
  const bytes = await doc.save();
  const cs = (await PDFDocument.load(bytes)).context
    .lookup(img.ref)
    // @ts-expect-error a stream's dict
    .dict.get(PDFName.of('ColorSpace'))
    .toString();
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
  const page = await pdf.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  // @ts-expect-error pdf.js's own canvas factory (Node: @napi-rs/canvas)
  const { canvas, context } = pdf.canvasFactory.create(w, h);
  await page.render({ canvasContext: context, viewport: vp, canvas }).promise;
  const rgba = context.getImageData(0, 0, w, h).data;
  await pdf.destroy();
  return { cs, rgba };
}

describe('gray JPEG', () => {
  it('a gray image comes back close to what went in, gray, at its size', async () => {
    const w = 61; // (not a multiple of 8)
    const h = 45;
    const px = picture(w, h);
    const jpeg = encodeGrayJpeg(px, w, h, 0.9, 300);
    expect([jpeg[0], jpeg[1], jpeg.at(-2), jpeg.at(-1)]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
    const { cs, rgba } = await decode(jpeg, w, h);
    expect(cs).toBe('/DeviceGray');
    let err = 0;
    for (let i = 0; i < w * h; i++) {
      err += Math.abs(rgba[i * 4] - px[i]);
      expect(rgba[i * 4]).toBe(rgba[i * 4 + 1]);
    }
    expect(err / (w * h)).toBeLessThan(4);
    // (pdf.js loads slowly while the whole suite runs)
  }, 60000);

  it('lower quality: coarser steps, smaller files', () => {
    expect(quantTable(50)[0]).toBe(16);
    expect(quantTable(100)[0]).toBe(1);
    expect(quantTable(10)[0]).toBe(80);
    const px = picture(160, 120);
    expect(encodeGrayJpeg(px, 160, 120, 0.3).length).toBeLessThan(encodeGrayJpeg(px, 160, 120, 0.95).length);
  });
});

describe('Huffman tables made for the image', () => {
  it('no code longer than 16 bits, every symbol used gets one', () => {
    const freq = Array.from({ length: 256 }, (_, i) => (i < 200 ? 2 ** (i % 30) : 0));
    const { bits, vals } = optimalTable(freq);
    expect(bits).toHaveLength(16);
    expect(vals).toHaveLength(200);
    expect(bits.reduce((a, b) => a + b, 0)).toBe(200);
    // a prefix code: Kraft's sum under 1 (one code is left unused)
    expect(bits.reduce((a, n, i) => a + n * 2 ** -(i + 1), 0)).toBeLessThan(1);
  });

  it('a page of text is a fraction of its raw size', () => {
    const w = 400;
    const h = 300;
    const px = new Uint8Array(w * h).fill(250);
    for (let y = 20; y < h - 20; y += 14) for (let x = 20; x < w - 20; x++) if ((x * 7 + y) % 11 < 6) for (let k = 0; k < 6; k++) px[(y + k) * w + x] = 30;
    const jpeg = encodeGrayJpeg(px, w, h, 0.6);
    expect(jpeg.length).toBeLessThan((w * h) / 3);
  });
});
