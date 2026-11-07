/**
 * Checking what scanning made (check-scan-output.mjs, check-scan-real.mjs):
 * the PDF's pages and the images in them (pdf-lib), the pages as pixels
 * (pdf.js), and measurements on those pixels: where a colored square is,
 * whether there's any color, the stand-in's page labels, how crooked a page
 * is, how alike two pictures are.
 */
import { createRequire } from 'node:module';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFStream } from 'pdf-lib';

const require = createRequire(import.meta.url);
export const standIn = require('../scan-test.cjs');

/** The open document's bytes, from the viewer */
export async function docBytes(page) {
  const b64 = await page.evaluate(async () => {
    const v = window.__acro.viewer;
    const bytes = new Uint8Array(await v.exportBytes(v.current));
    let s = '';
    for (let k = 0; k < bytes.length; k += 0x8000)
      s += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
    return btoa(s);
  });
  return Buffer.from(b64, 'base64');
}

const nameOf = (v) => (v instanceof PDFName ? v.decodeText() : null);

/** Each page: its size (points), rotation and the images on it */
export async function pdfFacts(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  return doc.getPages().map((p) => {
    const { width, height } = p.getSize();
    const images = [];
    const res = p.node.Resources();
    const xo = res?.lookup(PDFName.of('XObject'));
    if (xo instanceof PDFDict)
      for (const [, ref] of xo.entries()) {
        const s = doc.context.lookup(ref);
        if (!(s instanceof PDFStream)) continue;
        const d = s.dict;
        if (nameOf(d.get(PDFName.of('Subtype'))) !== 'Image') continue;
        const f = d.lookup(PDFName.of('Filter'));
        const cs = d.lookup(PDFName.of('ColorSpace'));
        images.push({
          filter: f instanceof PDFArray ? f.asArray().map(nameOf).join('+') : nameOf(f),
          bpc: d.lookup(PDFName.of('BitsPerComponent'))?.asNumber?.(),
          colorSpace:
            cs instanceof PDFArray
              ? `${nameOf(cs.get(0))}${nameOf(cs.get(0)) === 'ICCBased' ? `(${doc.context.lookup(cs.get(1)).dict.lookup(PDFName.of('N'))?.asNumber?.()})` : ''}`
              : nameOf(cs),
          width: d.lookup(PDFName.of('Width'))?.asNumber?.(),
          height: d.lookup(PDFName.of('Height'))?.asNumber?.(),
          bytes: s.getContents().length,
        });
      }
    return {
      width: Math.round(width * 10) / 10,
      height: Math.round(height * 10) / 10,
      rotation: p.getRotation().angle,
      images,
    };
  });
}

/** Page n (0-based) as RGBA pixels at `dpi`, turned as the page says
 *  (given up on after a minute rather than holding the bench up) */
export function renderPage(bytes, n, dpi) {
  let timer;
  return Promise.race([
    render(bytes, n, dpi).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`page ${n + 1} took over a minute to draw`)), 60000);
    }),
  ]);
}
async function render(bytes, n, dpi) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useWasm: false }).promise;
  try {
    const page = await doc.getPage(n + 1);
    const vp = page.getViewport({ scale: dpi / 72 });
    const { canvas, context } = doc.canvasFactory.create(Math.round(vp.width), Math.round(vp.height));
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport: vp, canvas }).promise;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    return { width: canvas.width, height: canvas.height, data, dpi };
  } finally {
    await doc.destroy();
  }
}

/** The text of every page */
export async function pdfText(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
  const out = [];
  for (let n = 1; n <= doc.numPages; n++)
    out.push((await (await doc.getPage(n)).getTextContent()).items.map((i) => i.str).join(' '));
  await doc.destroy();
  return out;
}

/* Pixels ------------------------------------------------------------------ */

const lum = (d, o) => 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];

/** A part of an image, in pixels */
export function crop(img, x, y, w, h) {
  x = Math.max(0, Math.round(x));
  y = Math.max(0, Math.round(y));
  w = Math.max(1, Math.min(img.width - x, Math.round(w)));
  h = Math.max(1, Math.min(img.height - y, Math.round(h)));
  const data = new Uint8ClampedArray(w * h * 4);
  for (let r = 0; r < h; r++)
    data.set(img.data.subarray(((y + r) * img.width + x) * 4, ((y + r) * img.width + x + w) * 4), r * w * 4);
  return { width: w, height: h, data, dpi: img.dpi };
}

/** An image made w × h (averaging the pixels that fall in each) */
export function resize(img, w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * img.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / w));
      const y0 = Math.floor((y * img.height) / h);
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / h));
      const sum = [0, 0, 0];
      let n = 0;
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          const o = (yy * img.width + xx) * 4;
          sum[0] += img.data[o];
          sum[1] += img.data[o + 1];
          sum[2] += img.data[o + 2];
          n++;
        }
      const o = (y * w + x) * 4;
      data[o] = sum[0] / n;
      data[o + 1] = sum[1] / n;
      data[o + 2] = sum[2] / n;
      data[o + 3] = 255;
    }
  return { width: w, height: h, data };
}

/** Where pixels of a color are: how many, and their middle (null: none).
 *  The median, so a few stray pixels of a like color elsewhere (JPEG
 *  fringes) don't move it */
export function findColor(img, rgb, tol = 60) {
  const xs = [];
  const ys = [];
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const o = (y * img.width + x) * 4;
      const d = Math.hypot(img.data[o] - rgb[0], img.data[o + 1] - rgb[1], img.data[o + 2] - rgb[2]);
      if (d < tol) {
        xs.push(x);
        ys.push(y);
      }
    }
  if (!xs.length) return null;
  const mid = (a) => a.sort((p, q) => p - q)[a.length >> 1];
  return { count: xs.length, x: mid(xs), y: mid(ys) };
}

/** Where the stand-in's chart square `name` is in an image, in pixels of
 *  its middle (null: not there); `size` its expected side, px */
export function findMarker(img, name, size) {
  const m = standIn.MARKERS.find((k) => k.name === name);
  const hit = findColor(img, m.rgb, 45);
  // (a few stray pixels of a similar color aren't the square)
  return hit && hit.count > size * size * 0.4 ? hit : null;
}

/** Share of pixels with any color in them */
export function colorShare(img, min = 40) {
  let n = 0;
  for (let o = 0; o < img.data.length; o += 4) {
    const r = img.data[o];
    const g = img.data[o + 1];
    const b = img.data[o + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) > min) n++;
  }
  return n / (img.data.length / 4);
}

/** Share of pixels that are neither (near) black nor white */
export function greyShare(img) {
  let n = 0;
  for (let o = 0; o < img.data.length; o += 4) {
    const v = lum(img.data, o);
    if (v > 20 && v < 235) n++;
  }
  return n / (img.data.length / 4);
}

export function meanLuma(img) {
  let s = 0;
  for (let o = 0; o < img.data.length; o += 4) s += lum(img.data, o);
  return s / (img.data.length / 4);
}
export function stdLuma(img) {
  const m = meanLuma(img);
  let s = 0;
  for (let o = 0; o < img.data.length; o += 4) s += (lum(img.data, o) - m) ** 2;
  return Math.sqrt(s / (img.data.length / 4));
}
/** Share of dark pixels */
export function darkShare(img, below = 128) {
  let n = 0;
  for (let o = 0; o < img.data.length; o += 4) if (lum(img.data, o) < below) n++;
  return n / (img.data.length / 4);
}
/** The average step between neighbouring pixels (sharpness of edges) */
export function edgeStrength(img) {
  let s = 0;
  let n = 0;
  for (let y = 0; y < img.height; y++)
    for (let x = 1; x < img.width; x++) {
      const o = (y * img.width + x) * 4;
      s += Math.abs(lum(img.data, o) - lum(img.data, o - 4));
      n++;
    }
  return s / n;
}

/** Dark specks: how many connected dark areas (4-neighbours) */
export const darkBlobs = (img, below = 128) => blobSizes(img, below).length;

/** The connected dark areas' sizes, in pixels */
export function blobSizes(img, below = 128) {
  const { width: w, height: h } = img;
  const seen = new Uint8Array(w * h);
  const sizes = [];
  const stack = [];
  for (let i = 0; i < w * h; i++) {
    if (seen[i] || lum(img.data, i * 4) >= below) continue;
    let size = 0;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop();
      size++;
      const x = j % w;
      const y = (j / w) | 0;
      for (const [nx, ny] of [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const k = ny * w + nx;
        if (!seen[k] && lum(img.data, k * 4) < below) {
          seen[k] = 1;
          stack.push(k);
        }
      }
    }
    sizes.push(size);
  }
  return sizes;
}

/** How alike two pictures of the same size are (Pearson, -1 to 1) */
export function likeness(a, b) {
  const n = a.width * a.height;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += lum(a.data, i * 4);
    sb += lum(b.data, i * 4);
  }
  const ma = sa / n;
  const mb = sb / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const x = lum(a.data, i * 4) - ma;
    const y = lum(b.data, i * 4) - mb;
    cov += x * y;
    va += x * x;
    vb += y * y;
  }
  return cov / Math.sqrt(va * vb || 1);
}

/**
 * The stand-in feeder page's label (scan-test.cjs CODE): its sheet and
 * side, and whether the page is upside down. img: the page at img.dpi.
 * null when there's no label (a blank page).
 */
export function readLabel(img) {
  const { CODE } = standIn;
  const dpi = img.dpi;
  const read = (flip) => {
    const bits = [];
    for (let k = 0; k < CODE.cells; k++) {
      let u = CODE.x + k * CODE.pitch + CODE.cell / 2;
      let v = CODE.y + CODE.cell / 2;
      if (flip) {
        u = img.width / dpi - u;
        v = img.height / dpi - v;
      }
      const x = Math.round(u * dpi);
      const y = Math.round(v * dpi);
      const c = crop(img, x - 2, y - 2, 5, 5);
      bits.push(meanLuma(c) < 100 ? 1 : 0);
    }
    if (!bits[0]) return null;
    const sheet = bits.slice(1, 7).reduce((a, b) => a * 2 + b, 0);
    return sheet ? { sheet, side: bits[7] ? 'back' : 'front', upsideDown: flip } : null;
  };
  return read(false) ?? read(true);
}
export const labelText = (l) => (l ? `${l.sheet}${l.side === 'back' ? 'B' : 'F'}${l.upsideDown ? '↓' : ''}` : 'blank');

/**
 * How crooked a stand-in feeder page is: the slope of the top edge of its
 * band (0.45 in down, from 0.75 in), in degrees (positive: down to the right)
 */
export function bandSlope(img) {
  const dpi = img.dpi;
  const edgeAt = (u) => {
    const x = Math.round(u * dpi);
    for (let y = Math.round(0.1 * dpi); y < Math.round(1.4 * dpi); y++)
      if (lum(img.data, (y * img.width + x) * 4) < 160) return y;
    return null;
  };
  const a = edgeAt(1.5);
  const b = edgeAt(6.5);
  if (a === null || b === null) return null;
  return (Math.atan2(b - a, 5 * dpi) * 180) / Math.PI;
}
