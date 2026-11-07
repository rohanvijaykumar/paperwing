// @vitest-environment node
/**
 * CCITT Group 4 round trips: our encoder, pdf.js's decoder (independent
 * code), pixel for pixel.
 */
import { describe, expect, it } from 'vitest';
import { bitmapRowBytes, encodeG4, type Bitmap } from '../acro/scan-g4';
import { buildScanPdf } from '../acro/scan-pdf';
import { decodePdfImages } from './helpers/pdf-images';
import { rng } from './helpers/scan-synth';

function bitmap(
  w: number,
  h: number,
  black: (x: number, y: number) => boolean
): Bitmap {
  const rb = bitmapRowBytes(w);
  const data = new Uint8Array(rb * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (black(x, y)) data[y * rb + (x >> 3)] |= 0x80 >> (x & 7);
  return { width: w, height: h, data };
}

const isBlack = (b: Bitmap, x: number, y: number) =>
  (b.data[y * bitmapRowBytes(b.width) + (x >> 3)] >> (7 - (x & 7))) & 1;

/** Encodes every bitmap into one PDF (a page each) and decodes it back */
async function roundTrip(bitmaps: Bitmap[]) {
  const pdf = await buildScanPdf(
    bitmaps.map((b) => ({
      kind: 'g4',
      bytes: encodeG4(b),
      width: b.width,
      height: b.height,
      dpi: 72,
    }))
  );
  const pages = await decodePdfImages(pdf);
  return bitmaps.map((b, i) => {
    const img = pages[i][0];
    expect([img.width, img.height]).toEqual([b.width, b.height]);
    let diff = 0;
    for (let y = 0; y < b.height; y++)
      for (let x = 0; x < b.width; x++)
        if ((img.gray[y * b.width + x] < 128 ? 1 : 0) !== isBlack(b, x, y))
          diff++;
    return diff;
  });
}

describe('CCITT G4 encoder', () => {
  it('random bitmaps of every density', async () => {
    const r = rng(7);
    const cases = [0.02, 0.2, 0.5, 0.8, 0.98].map((p, i) =>
      bitmap(97 + i * 13, 41, () => r() < p)
    );
    expect(await roundTrip(cases)).toEqual(cases.map(() => 0));
  });

  it('text-like pages: strokes, rows of words, and a crooked line', async () => {
    const r = rng(3);
    const words: Array<[number, number, number]> = [];
    for (let k = 0; k < 120; k++)
      words.push([
        Math.floor(r() * 560),
        Math.floor(r() * 700),
        20 + Math.floor(r() * 80),
      ]);
    const text = bitmap(613, 731, (x, y) =>
      words.some(
        ([wx, wy, len]) =>
          x >= wx &&
          x < wx + len &&
          y >= wy &&
          y < wy + 18 &&
          ((x - wx) % 9 < 3 || y - wy < 3)
      )
    );
    const line = bitmap(800, 60, (x, y) => Math.abs(y - 10 - x * 0.05) < 2);
    expect(await roundTrip([text, line])).toEqual([0, 0]);
  });

  it('edge cases: all white, all black, 1 pixel wide, 1 row, odd widths', async () => {
    const r = rng(5);
    const cases = [
      bitmap(64, 32, () => false),
      bitmap(64, 32, () => true),
      bitmap(1, 50, (x, y) => y % 3 === 0),
      bitmap(1, 1, () => true),
      bitmap(1, 1, () => false),
      bitmap(300, 1, (x) => x % 7 < 3),
      bitmap(16, 16, (x, y) => (x + y) % 2 === 0), // checkerboard: no vertical mode fits
      ...[2, 3, 5, 7, 9, 15, 17, 31, 33].map((w) =>
        bitmap(w, 11, () => r() < 0.5)
      ),
    ];
    expect(await roundTrip(cases)).toEqual(cases.map(() => 0));
  });

  it('every run-length code in both colors, and runs past 2560', async () => {
    // all terminating codes, and every makeup code with remainders 0, 1, 63;
    // row n: white run n, black run n, then white; and the opposite order
    const lengths = [...Array(130).keys()];
    for (let m = 64; m <= 2560; m += 64) lengths.push(m, m + 1, m + 63);
    const rows = lengths.flatMap((n) => [n, -n - 1]);
    const width = 2 * 2600 + 300;
    const b = bitmap(width, rows.length, (x, y) => {
      const n = rows[y];
      if (n >= 0) return x >= n && x < 2 * n;
      const m = -n - 1;
      return x < m || x >= 2 * m;
    });
    const long = bitmap(9000, 3, (x, y) =>
      y === 1 ? x >= 2700 : x < 5200 + y
    );
    expect(await roundTrip([b, long])).toEqual([0, 0]);
  });

  it('a different bitmap would be caught (the check works)', async () => {
    const a = bitmap(40, 10, (x) => x < 20);
    const enc = encodeG4(bitmap(40, 10, (x) => x < 21));
    const pdf = await buildScanPdf([
      { kind: 'g4', bytes: enc, width: 40, height: 10, dpi: 72 },
    ]);
    const [[img]] = await decodePdfImages(pdf);
    let diff = 0;
    for (let y = 0; y < 10; y++)
      for (let x = 0; x < 40; x++)
        if ((img.gray[y * 40 + x] < 128 ? 1 : 0) !== isBlack(a, x, y)) diff++;
    expect(diff).toBe(10);
  });

  it('compresses text pages far below their raw size and ends with EOFB', () => {
    const b = bitmap(
      2550,
      300,
      (x, y) => y % 50 < 20 && x % 11 < 4 && x > 300 && x < 2250
    );
    const enc = encodeG4(b);
    expect(enc.length).toBeLessThan(b.data.length / 10);
    // EOFB: two EOLs (000000000001 x2), padded to a byte
    const bits = [...enc.slice(-4)]
      .map((v) => v.toString(2).padStart(8, '0'))
      .join('');
    expect(bits.replace(/0+$/, '')).toMatch(/000000000001000000000001$/);
  });

  it('rejects empty or short bitmaps', () => {
    expect(() =>
      encodeG4({ width: 0, height: 5, data: new Uint8Array(0) })
    ).toThrow();
    expect(() =>
      encodeG4({ width: 16, height: 5, data: new Uint8Array(3) })
    ).toThrow(/smaller/);
  });
});
