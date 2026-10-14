/**
 * Builds a heavy test PDF for the benchmarks: text, vector shapes and a
 * photo-like image on every page.
 *   node bench/make-fixture.mjs <out.pdf> [pages]
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';

const require = createRequire(new URL('../../package.json', import.meta.url));
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const [out, pagesArg] = process.argv.slice(2);
const PAGES = Number(pagesArg || 300);

/** Minimal PNG encoder (RGB, 8-bit) */
function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// A few distinct "photos" (noisy gradients) shared across pages
let seed = 7;
const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const photos = [0, 1, 2, 3].map((k) =>
  png(900, 600, (x, y) => {
    const n = rand() * 40;
    return [
      (x / 900) * 200 + n + k * 10,
      (y / 600) * 180 + n,
      ((x + y) / 1500) * 220 + n - k * 15,
    ].map((v) => Math.max(0, Math.min(255, v | 0)));
  })
);

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.TimesRoman);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);
const images = await Promise.all(photos.map((p) => doc.embedPng(p)));
const words =
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat'.split(
    ' '
  );

for (let p = 0; p < PAGES; p++) {
  const page = doc.addPage([612, 792]);
  page.drawText(`Chapter ${Math.floor(p / 10) + 1} - Page ${p + 1}`, {
    x: 54,
    y: 740,
    size: 18,
    font: bold,
  });
  const img = images[p % images.length];
  page.drawImage(img, { x: 54, y: 470, width: 504, height: 250 });
  for (let i = 0; i < 12; i++) {
    page.drawRectangle({
      x: 54 + i * 42,
      y: 440,
      width: 30,
      height: 10 + ((p + i) % 7) * 3,
      color: rgb((i * 20) / 255, 0.4, 0.7),
    });
  }
  let y = 420;
  for (let line = 0; line < 30; line++) {
    const text = Array.from(
      { length: 14 },
      (_, i) => words[(p * 31 + line * 7 + i) % words.length]
    ).join(' ');
    page.drawText(text, { x: 54, y, size: 10.5, font });
    y -= 13;
  }
}
writeFileSync(out, await doc.save());
console.log(`wrote ${out} (${PAGES} pages)`);
