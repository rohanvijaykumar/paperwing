/** Synthetic scanned pages for the clean-up tests: procedural, seeded, fast */
import type { ScanImage } from '../../acro/scan-image';

export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    // xorshift32
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 2 ** 32;
  };
}

export function gray(
  width: number,
  height: number,
  dpi: number,
  fill = 245
): ScanImage {
  return {
    width,
    height,
    channels: 1,
    data: new Uint8Array(width * height).fill(fill),
    dpi,
  };
}

export function rgba(
  width: number,
  height: number,
  dpi: number,
  rgb: [number, number, number]
): ScanImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let o = 0; o < data.length; o += 4) {
    data[o] = rgb[0];
    data[o + 1] = rgb[1];
    data[o + 2] = rgb[2];
    data[o + 3] = 255;
  }
  return { width, height, channels: 4, data, dpi };
}

export function at(img: ScanImage, x: number, y: number): number {
  const ch = img.channels;
  const o = (y * img.width + x) * ch;
  if (ch === 1) return img.data[o];
  return Math.round(
    0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2]
  );
}

export function set(
  img: ScanImage,
  x: number,
  y: number,
  v: number | [number, number, number]
) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const o = (y * img.width + x) * img.channels;
  if (img.channels === 1) img.data[o] = typeof v === 'number' ? v : v[0];
  else {
    const c = typeof v === 'number' ? [v, v, v] : v;
    img.data[o] = c[0];
    img.data[o + 1] = c[1];
    img.data[o + 2] = c[2];
  }
}

export function rect(
  img: ScanImage,
  x0: number,
  y0: number,
  w: number,
  h: number,
  v: number | [number, number, number]
) {
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) set(img, x, y, v);
}

/** Text-like ink: lines of words made of letter strokes, in page units of
 *  1/300 inch; `inkAt` tells whether a point is ink */
export function textLayout(
  width300: number,
  height300: number,
  opts: {
    seed?: number;
    margin?: number;
    lines?: number;
    wordsPerLine?: number;
  } = {}
) {
  const r = rng(opts.seed ?? 3);
  const margin = opts.margin ?? 300;
  const lineGap = 50;
  const xHeight = 22;
  const lines: Array<{ y: number; words: Array<[number, number]> }> = [];
  const maxLines = opts.lines ?? Math.floor((height300 - 2 * margin) / lineGap);
  for (let i = 0; i < maxLines; i++) {
    const y = margin + i * lineGap;
    const words: Array<[number, number]> = [];
    let x = margin;
    let n = 0;
    while (x < width300 - margin - 40 && n < (opts.wordsPerLine ?? 1e9)) {
      const len = 40 + Math.floor(r() * 140);
      words.push([x, Math.min(x + len, width300 - margin)]);
      x += len + 22;
      n++;
    }
    lines.push({ y, words });
  }
  const inkAt = (x: number, y: number) => {
    const i = Math.floor((y - margin) / lineGap);
    if (i < 0 || i >= lines.length) return false;
    const line = lines[i];
    const dy = y - line.y;
    if (dy < 0 || dy >= xHeight) return false;
    for (const [a, b] of line.words)
      if (x >= a && x < b) {
        // letters: 4-unit strokes every 11 units, a crossbar on top
        const k = (x - a) % 11;
        return k < 4 || dy < 4;
      }
    return false;
  };
  return { inkAt, lines, margin, lineGap, xHeight };
}

/** Draws ink from a layout (in 1/300 inch) at the image's dpi, rotated by
 *  `deg` about the center (positive: lines slope down to the right) */
export function drawText(
  img: ScanImage,
  inkAt: (x: number, y: number) => boolean,
  opts: { deg?: number; ink?: number | [number, number, number] } = {}
) {
  const a = ((opts.deg ?? 0) * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const cx = img.width / 2;
  const cy = img.height / 2;
  const k = 300 / img.dpi;
  const ink = opts.ink ?? 30;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      // the source point that lands here
      const sx = cx + (x - cx) * c + (y - cy) * s;
      const sy = cy - (x - cx) * s + (y - cy) * c;
      if (inkAt(sx * k, sy * k)) set(img, x, y, ink);
    }
}

export function addNoise(img: ScanImage, amount: number, seed = 9) {
  const r = rng(seed);
  for (let i = 0; i < img.data.length; i++) {
    if (img.channels === 4 && i % 4 === 3) continue;
    const v = img.data[i] + (r() - 0.5) * 2 * amount;
    img.data[i] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  }
}

/** Ink pixels (darker than t) inside a box */
export function countDark(
  img: ScanImage,
  t = 128,
  box?: { x: number; y: number; width: number; height: number }
) {
  const b = box ?? { x: 0, y: 0, width: img.width, height: img.height };
  let n = 0;
  for (let y = b.y; y < b.y + b.height; y++)
    for (let x = b.x; x < b.x + b.width; x++) if (at(img, x, y) < t) n++;
  return n;
}
