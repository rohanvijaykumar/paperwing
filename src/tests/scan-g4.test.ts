// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  PDFDocument,
  PDFName,
  popGraphicsState,
  pushGraphicsState,
  concatTransformationMatrix,
  drawObject,
} from 'pdf-lib';
import { encodeG4, bitmapRowBytes, type Bitmap } from '../acro/scan-g4';
import { decodePdfImages } from './helpers/pdf-images';

function g4Pdf(bitmaps: Bitmap[], streams: Uint8Array[]) {
  return (async () => {
    const doc = await PDFDocument.create();
    bitmaps.forEach((b, i) => {
      const stream = doc.context.stream(streams[i], {
        Type: 'XObject',
        Subtype: 'Image',
        Width: b.width,
        Height: b.height,
        ColorSpace: 'DeviceGray',
        BitsPerComponent: 1,
        Filter: 'CCITTFaxDecode',
        DecodeParms: { K: -1, Columns: b.width, Rows: b.height },
      });
      const ref = doc.context.register(stream);
      const page = doc.addPage([b.width, b.height]);
      const name = page.node.newXObject('Im', ref);
      page.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(b.width, 0, 0, b.height, 0, 0),
        drawObject(name),
        popGraphicsState()
      );
    });
    void PDFName;
    return doc.save();
  })();
}

function bitmap(w: number, h: number, f: (x: number, y: number) => boolean) {
  const rb = bitmapRowBytes(w);
  const data = new Uint8Array(rb * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (f(x, y)) data[y * rb + (x >> 3)] |= 0x80 >> (x & 7);
  return { width: w, height: h, data };
}

function black(b: Bitmap, x: number, y: number) {
  return (b.data[y * bitmapRowBytes(b.width) + (x >> 3)] >> (7 - (x & 7))) & 1;
}

describe('CCITT G4 (first pass)', () => {
  it('round trips', async () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
    const cases = [
      bitmap(37, 23, () => rnd() < 0.5),
      bitmap(1, 9, (x, y) => y % 2 === 0),
      bitmap(300, 40, (x, y) => ((x >> 3) + (y >> 2)) % 3 === 0),
      bitmap(16, 16, () => false),
      bitmap(16, 16, () => true),
      bitmap(5200, 3, (x, y) => (y === 1 ? x > 2700 : x < 2600 + y * 10)),
    ];
    const pdf = await g4Pdf(cases, cases.map(encodeG4));
    const pages = await decodePdfImages(pdf);
    cases.forEach((b, i) => {
      const img = pages[i][0];
      expect(img.width).toBe(b.width);
      let diff = 0;
      for (let y = 0; y < b.height; y++)
        for (let x = 0; x < b.width; x++)
          if ((img.gray[y * b.width + x] < 128 ? 1 : 0) !== black(b, x, y))
            diff++;
      expect(diff, `case ${i}`).toBe(0);
    });
  });
});
