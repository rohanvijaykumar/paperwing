/**
 * Clean-up for scanned pages (Acrobat's "Optimize image" settings, plus blank
 * page removal): pure functions on pixel buffers, no DOM, so they run in a
 * Web Worker (scan-image.worker.ts) as well as in tests.
 *
 * processPage runs the steps in this order, each for a reason:
 *  1. invert, brightness, contrast (one lookup table): fix the input first.
 *  2. a small analysis copy (box-averaged to about 100 dpi) for every
 *     decision, so decisions cost almost nothing and ignore scanner noise.
 *  3. edge shadows: dark bands touching the edges, measured on row/column
 *     means, filled with the paper color before they can bias anything else.
 *  4. blank detection (NAPS2's method: share of non-white pixels, ignoring
 *     the borders), so blank pages skip the expensive steps.
 *  5. descreen: a Gaussian low-pass sized to the screen frequencies of print
 *     at the scan resolution, before anything resamples the image (rotation),
 *     which would otherwise alias the dot pattern into moire.
 *  6. deskew: projection profiles of the binarized analysis copy, scored by
 *     the sum of squared differences of adjacent bins (Postl / Leptonica),
 *     -15 to 15 degrees in 0.25 degree steps, refined in 0.05 degree steps
 *     with a parabolic fit; then one bilinear rotation of the full image.
 *  7. auto-crop: the same document finder as the flatbed preview's box.
 *  8. Autodetect: color if anything is colorful after white-balancing to the
 *     paper; black and white if the page is ink on paper (few mid-tones),
 *     otherwise grayscale.
 *  9. background removal: a background map from the brightest pixels of
 *     small tiles (holes filled from neighbours, smoothed, bilinear), and
 *     each pixel divided by it (Leptonica's background normalization), then
 *     a white and black point per level. Black-and-white pages always get the
 *     normalization: a global threshold on a flat background beats any
 *     threshold on uneven paper.
 * 10. text sharpening: unsharp mask on the luminance, the same correction
 *     added to each color channel (keeps hues, a third of the work).
 * 11. despeckle: connected components (8-connected, run based); tiny ones
 *     with no other ink nearby are painted over, so dots on i's and full
 *     stops survive.
 * 12. black and white: threshold on the normalized luminance, the slider's
 *     value or Otsu's.
 * 13. orientation: flip (back sides), the injected detector (the OCR
 *     engine's orientation check), then the chosen rotation.
 */
import { bitmapRowBytes, type Bitmap } from './scan-g4';

export type { Bitmap } from './scan-g4';

/** Pixels: 4 channels (RGBA, the ImageData layout), 3 (RGB) or 1 (gray) */
export interface ScanImage {
  width: number;
  height: number;
  channels: 1 | 3 | 4;
  data: Uint8Array | Uint8ClampedArray;
  /** scan resolution; scales every filter (300 if unknown) */
  dpi: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ColorMode = 'auto' | 'color' | 'gray' | 'bw';
export type FilterLevel = 'off' | 'low' | 'medium' | 'high';
export type Rotation = 0 | 90 | 180 | 270;

export interface ScanImageSettings {
  colorMode: ColorMode;
  /** black and white: pixels darker than this (0-255, on the page with its
   *  background made white) turn black; null works it out (Otsu) */
  threshold: number | null;
  /** -100 to 100; pass 0 when the scanner applied it already */
  brightness: number;
  /** -100 to 100; pass 0 when the scanner applied it already */
  contrast: number;
  /** turns a negative positive (the dialog offers it for black and white) */
  invert: boolean;
  deskew: boolean;
  autoCrop: boolean;
  backgroundRemoval: FilterLevel;
  descreen: boolean;
  textSharpening: FilterLevel;
  despeckle: boolean;
  edgeShadowRemoval: boolean;
  /** sensitivity 0-100: higher calls more pages blank (50 keeps a page with
   *  a few words on it, 100 removes pages with a line or two) */
  removeBlank: { enabled: boolean; sensitivity: number };
  autoRotate: boolean;
  /** clockwise, applied after auto-rotate */
  rotate: Rotation;
  /** turns the page upside down: back sides of pages bound at the top */
  flip: boolean;
}

/** Acrobat's defaults: deskew on, everything else off */
export const DEFAULT_SCAN_IMAGE_SETTINGS: ScanImageSettings = {
  colorMode: 'auto',
  threshold: null,
  brightness: 0,
  contrast: 0,
  invert: false,
  deskew: true,
  autoCrop: false,
  backgroundRemoval: 'off',
  descreen: false,
  textSharpening: 'off',
  despeckle: false,
  edgeShadowRemoval: false,
  removeBlank: { enabled: false, sensitivity: 50 },
  autoRotate: false,
  rotate: 0,
  flip: false,
};

/** What the orientation check says: the clockwise rotation that makes the
 *  page upright (Tesseract OSD's "rotate"); null when it can't tell */
export interface OrientationResult {
  rotate: Rotation;
}
export type OrientationDetector = (
  page: ScanImage
) => Promise<OrientationResult | null> | OrientationResult | null;

export interface ProcessDeps {
  detectOrientation?: OrientationDetector;
}

interface PageInfo {
  width: number;
  height: number;
  dpi: number;
  /** blank by the removeBlank sensitivity (reported even when removal is
   *  off); with removal on, a blank page skips the expensive steps */
  blank: boolean;
  /** clockwise rotation applied in the end (flip, auto-rotate, rotate) */
  rotation: Rotation;
  /** degrees the page was straightened by (positive: it sloped down to the
   *  right) */
  skew: number;
  /** the part kept by auto-crop, in the straightened image's pixels */
  crop: Rect | null;
}

export type ProcessedPage =
  | (PageInfo & { kind: 'color' | 'gray'; image: ScanImage })
  | (PageInfo & { kind: 'bw'; bitmap: Bitmap });

// ---------------------------------------------------------------------------
// Working image

interface Work {
  w: number;
  h: number;
  /** RGBA while the page may be in color */
  rgba: Uint8ClampedArray | null;
  /** luminance, kept in step with rgba */
  L: Uint8Array;
}

type RGB = [number, number, number];

const luma = (r: number, g: number, b: number) =>
  (r * 77 + g * 150 + b * 29 + 128) >> 8;

const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

function refreshLuma(work: Work) {
  const { rgba, L } = work;
  if (!rgba) return;
  for (let i = 0, o = 0; i < L.length; i++, o += 4)
    L[i] = luma(rgba[o], rgba[o + 1], rgba[o + 2]);
}

function toWork(img: ScanImage, color: boolean): Work {
  const { width: w, height: h, channels: ch, data } = img;
  if (!(w > 0 && h > 0)) throw new Error('The scanned page is empty');
  if (data.length < w * h * ch)
    throw new Error('The scanned page is smaller than its size says');
  const L = new Uint8Array(w * h);
  if (ch === 1) {
    L.set(data.subarray(0, w * h));
    return { w, h, rgba: null, L };
  }
  if (!color) {
    for (let i = 0, o = 0; i < L.length; i++, o += ch)
      L[i] = luma(data[o], data[o + 1], data[o + 2]);
    return { w, h, rgba: null, L };
  }
  const rgba = new Uint8ClampedArray(w * h * 4);
  if (ch === 4) rgba.set(data.subarray(0, w * h * 4));
  else
    for (let i = 0, o = 0, p = 0; i < L.length; i++, o += 3, p += 4) {
      rgba[p] = data[o];
      rgba[p + 1] = data[o + 1];
      rgba[p + 2] = data[o + 2];
      rgba[p + 3] = 255;
    }
  const work = { w, h, rgba, L };
  refreshLuma(work);
  return work;
}

function dropColor(work: Work) {
  work.rgba = null;
}

function levelsLut(s: ScanImageSettings): Uint8Array | null {
  if (!s.brightness && !s.contrast && !s.invert) return null;
  // contrast -100..100 as a slope from flat to nearly a step, 1 at 0
  const slope = Math.tan(
    ((clamp(s.contrast, -100, 100) * 0.99 + 100) / 200) * (Math.PI / 2)
  );
  const shift = (clamp(s.brightness, -100, 100) / 100) * 128;
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    const x = s.invert ? 255 - v : v;
    lut[v] = clamp(Math.round((x - 128) * slope + 128 + shift), 0, 255);
  }
  return lut;
}

function applyLut(work: Work, lut: Uint8Array) {
  if (work.rgba) {
    const px = work.rgba;
    for (let o = 0; o < px.length; o += 4) {
      px[o] = lut[px[o]];
      px[o + 1] = lut[px[o + 1]];
      px[o + 2] = lut[px[o + 2]];
    }
    refreshLuma(work);
  } else {
    const L = work.L;
    for (let i = 0; i < L.length; i++) L[i] = lut[L[i]];
  }
}

// ---------------------------------------------------------------------------
// Analysis copy

interface Analysis {
  w: number;
  h: number;
  /** full-resolution pixels per analysis pixel */
  f: number;
  L: Uint8Array;
  /** RGB, 3 bytes a pixel, for color pages */
  rgb: Uint8Array | null;
}

function analysisFactor(dpi: number): number {
  return Math.max(1, Math.round(dpi / 100));
}

/** Box-averaged copy, f x f pixels each */
function analyse(work: Work, f: number): Analysis {
  const { w, h, rgba, L } = work;
  const aw = Math.ceil(w / f);
  const ah = Math.ceil(h / f);
  const AL = new Uint8Array(aw * ah);
  const rgb = rgba ? new Uint8Array(aw * ah * 3) : null;
  const sum = new Uint32Array(aw * 3);
  for (let ay = 0; ay < ah; ay++) {
    sum.fill(0);
    const y0 = ay * f;
    const y1 = Math.min(h, y0 + f);
    for (let y = y0; y < y1; y++) {
      const row = y * w;
      for (let ax = 0, x = 0; ax < aw; ax++) {
        const xe = Math.min(w, x + f);
        if (rgba) {
          let r = 0;
          let g = 0;
          let b = 0;
          for (let o = (row + x) * 4, oe = (row + xe) * 4; o < oe; o += 4) {
            r += rgba[o];
            g += rgba[o + 1];
            b += rgba[o + 2];
          }
          sum[ax * 3] += r;
          sum[ax * 3 + 1] += g;
          sum[ax * 3 + 2] += b;
        } else {
          let v = 0;
          for (let i = row + x, ie = row + xe; i < ie; i++) v += L[i];
          sum[ax] += v;
        }
        x = xe;
      }
    }
    for (let ax = 0; ax < aw; ax++) {
      const n = (Math.min(w, (ax + 1) * f) - ax * f) * (y1 - y0);
      const i = ay * aw + ax;
      if (rgb) {
        const r = Math.round(sum[ax * 3] / n);
        const g = Math.round(sum[ax * 3 + 1] / n);
        const b = Math.round(sum[ax * 3 + 2] / n);
        rgb[i * 3] = r;
        rgb[i * 3 + 1] = g;
        rgb[i * 3 + 2] = b;
        AL[i] = luma(r, g, b);
      } else AL[i] = Math.round(sum[ax] / n);
    }
  }
  return { w: aw, h: ah, f, L: AL, rgb };
}

/** The part of the analysis copy under a crop whose corner is on its grid */
function cropAnalysis(A: Analysis, r: Rect): Analysis {
  const x0 = Math.floor(r.x / A.f);
  const y0 = Math.floor(r.y / A.f);
  const w = Math.min(A.w - x0, Math.ceil(r.width / A.f));
  const h = Math.min(A.h - y0, Math.ceil(r.height / A.f));
  const L = new Uint8Array(w * h);
  const rgb = A.rgb ? new Uint8Array(w * h * 3) : null;
  for (let y = 0; y < h; y++) {
    const s = (y0 + y) * A.w + x0;
    L.set(A.L.subarray(s, s + w), y * w);
    if (rgb) rgb.set(A.rgb!.subarray(s * 3, (s + w) * 3), y * w * 3);
  }
  return { w, h, f: A.f, L, rgb };
}

interface Paper {
  level: number;
  rgb: RGB;
}

/** The paper: the most common brightness in the brighter half of the page */
function estimatePaper(A: Analysis): Paper {
  const hist = new Float64Array(256);
  for (let i = 0; i < A.L.length; i++) hist[A.L[i]]++;
  const total = A.L.length;
  let acc = 0;
  let p50 = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= total / 2) {
      p50 = v;
      break;
    }
  }
  let level = 255;
  let best = -1;
  for (let v = Math.max(128, p50); v < 256; v++) {
    let s = 0;
    for (let d = -2; d <= 2; d++) s += hist[clamp(v + d, 0, 255)];
    if (s > best) {
      best = s;
      level = v;
    }
  }
  const rgb: RGB = [level, level, level];
  if (A.rgb) {
    let n = 0;
    const s = [0, 0, 0];
    for (let i = 0; i < A.L.length; i++)
      if (Math.abs(A.L[i] - level) <= 6) {
        s[0] += A.rgb[i * 3];
        s[1] += A.rgb[i * 3 + 1];
        s[2] += A.rgb[i * 3 + 2];
        n++;
      }
    if (n) for (let k = 0; k < 3; k++) rgb[k] = Math.round(s[k] / n);
  }
  return { level, rgb };
}

// ---------------------------------------------------------------------------
// Edge shadows

interface Bands {
  top: number;
  bottom: number;
  left: number;
  right: number;
}
const NO_BANDS: Bands = { top: 0, bottom: 0, left: 0, right: 0 };

/** Width of a dark band starting at one edge: lines clearly darker than the
 *  paper from the edge (or within 2 lines of it), then the soft fall-off */
function bandWidth(profile: Float64Array, paper: number, max: number) {
  const dark = paper * 0.8;
  const soft = paper * 0.93;
  let i = 0;
  while (i < 3 && i < max && profile[i] >= dark) i++;
  if (i >= 3 || i >= max) return 0;
  while (i < max && profile[i] < dark) i++;
  while (i < max && profile[i] < soft) i++;
  return Math.min(max, i + 1);
}

function findEdgeShadows(A: Analysis, paper: number): Bands {
  const { w, h, L } = A;
  const x0 = Math.floor(w * 0.1);
  const x1 = Math.ceil(w * 0.9);
  const y0 = Math.floor(h * 0.1);
  const y1 = Math.ceil(h * 0.9);
  const rows = new Float64Array(h);
  const cols = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = x0; x < x1; x++) s += L[y * w + x];
    rows[y] = s / Math.max(1, x1 - x0);
  }
  for (let y = y0; y < y1; y++)
    for (let x = 0; x < w; x++) cols[x] += L[y * w + x];
  for (let x = 0; x < w; x++) cols[x] /= Math.max(1, y1 - y0);
  const maxV = Math.round(h * 0.08);
  const maxH = Math.round(w * 0.08);
  return {
    top: bandWidth(rows, paper, maxV),
    bottom: bandWidth(rows.slice().reverse(), paper, maxV),
    left: bandWidth(cols, paper, maxH),
    right: bandWidth(cols.slice().reverse(), paper, maxH),
  };
}

function fillRect(
  work: Work,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rgb: RGB
) {
  x0 = clamp(x0, 0, work.w);
  x1 = clamp(x1, 0, work.w);
  y0 = clamp(y0, 0, work.h);
  y1 = clamp(y1, 0, work.h);
  const l = luma(rgb[0], rgb[1], rgb[2]);
  for (let y = y0; y < y1; y++) {
    work.L.fill(l, y * work.w + x0, y * work.w + x1);
    if (work.rgba)
      for (let x = x0; x < x1; x++) {
        const o = (y * work.w + x) * 4;
        work.rgba[o] = rgb[0];
        work.rgba[o + 1] = rgb[1];
        work.rgba[o + 2] = rgb[2];
      }
  }
}

function fillBands(work: Work, A: Analysis, b: Bands, rgb: RGB) {
  const f = A.f;
  const { w, h } = work;
  if (b.top) fillRect(work, 0, 0, w, b.top * f, rgb);
  if (b.bottom) fillRect(work, 0, h - b.bottom * f, w, h, rgb);
  if (b.left) fillRect(work, 0, 0, b.left * f, h, rgb);
  if (b.right) fillRect(work, w - b.right * f, 0, w, h, rgb);
  // the analysis copy too, without averaging again
  const l = luma(rgb[0], rgb[1], rgb[2]);
  for (let y = 0; y < A.h; y++)
    for (let x = 0; x < A.w; x++) {
      if (y >= b.top && y < A.h - b.bottom && x >= b.left && x < A.w - b.right)
        continue;
      const i = y * A.w + x;
      A.L[i] = l;
      if (A.rgb) A.rgb.set(rgb, i * 3);
    }
}

/** The analysis pixels decisions look at: inside the edge bands and a
 *  margin (fraction of each side) */
function inner(A: Analysis, b: Bands, margin: number) {
  const mx = Math.round(A.w * margin);
  const my = Math.round(A.h * margin);
  return {
    x0: Math.max(mx, b.left),
    x1: Math.min(A.w - mx, A.w - b.right),
    y0: Math.max(my, b.top),
    y1: Math.min(A.h - my, A.h - b.bottom),
  };
}

// ---------------------------------------------------------------------------
// Blank pages

/** Share of non-white pixels below which a page is blank, for a sensitivity
 *  of 0-100 (log scale: 0.0005% at 0, 0.005% at 50, 0.2% at 100) */
export function blankCoverageLimit(sensitivity: number): number {
  const s = clamp(sensitivity, 0, 100);
  const exp = s <= 50 ? -5.3 + s / 50 : -4.3 + ((s - 50) / 50) * 1.6;
  return 10 ** exp;
}

/** Share (0-1) of the page, borders ignored, that is clearly darker than the
 *  paper. At about 100 dpi each pixel averages several scanned ones, so
 *  scanner noise and dust fall away while text strokes stay dark. */
function inkCoverage(
  A: Analysis,
  paper: number,
  b: Bands,
  sensitivity: number
): number {
  // NAPS2 ignores 1% at the edges; 5% also skips punched holes
  const r = inner(A, b, 0.05);
  const delta = 40 + (clamp(sensitivity, 0, 100) / 100) * 50;
  const limit = paper - delta;
  let ink = 0;
  let n = 0;
  for (let y = r.y0; y < r.y1; y++)
    for (let x = r.x0; x < r.x1; x++, n++) if (A.L[y * A.w + x] < limit) ink++;
  return n ? ink / n : 0;
}

// ---------------------------------------------------------------------------
// Blur (Gaussian as three box blurs: Kovesi's box sizes)

function boxRadii(sigma: number): number[] {
  const n = 3;
  const ideal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(ideal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round(
    (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4)
  );
  const radii: number[] = [];
  for (let i = 0; i < n; i++) radii.push(((i < m ? wl : wu) - 1) / 2);
  return radii.filter((r) => r > 0);
}

type Pixels = Uint8Array | Uint8ClampedArray;

/** Blurs the channels at `offsets` of an image with `stride` bytes a pixel */
function gaussianBlur(
  data: Pixels,
  w: number,
  h: number,
  stride: number,
  offsets: number[],
  sigma: number
) {
  const radii = boxRadii(sigma);
  if (!radii.length) return;
  const tmp = new Uint8Array(data.length);
  // every sample of a row, as offsets into it
  const idx = new Int32Array(w * offsets.length);
  for (let x = 0, j = 0; x < w; x++)
    for (const off of offsets) idx[j++] = x * stride + off;
  const col = new Float64Array(idx.length);
  const rowLen = w * stride;
  for (const r of radii) {
    const inv = 1 / (2 * r + 1);
    // horizontal: data -> tmp (edges repeat the end pixel)
    for (let y = 0; y < h; y++)
      for (const off of offsets) {
        const b = y * rowLen + off;
        const first = data[b];
        const last = data[b + (w - 1) * stride];
        let sum = first * (r + 1);
        for (let i = 1; i <= r; i++)
          sum += data[b + Math.min(i, w - 1) * stride];
        let x = 0;
        for (; x <= r && x < w; x++) {
          tmp[b + x * stride] = (sum * inv + 0.5) | 0;
          sum +=
            (x + r + 1 < w ? data[b + (x + r + 1) * stride] : last) - first;
        }
        for (; x < w - r - 1; x++) {
          tmp[b + x * stride] = (sum * inv + 0.5) | 0;
          sum += data[b + (x + r + 1) * stride] - data[b + (x - r) * stride];
        }
        for (; x < w; x++) {
          tmp[b + x * stride] = (sum * inv + 0.5) | 0;
          sum += last - data[b + (x - r) * stride];
        }
      }
    // vertical: tmp -> data, a row at a time with running column sums
    for (let j = 0; j < idx.length; j++) {
      const c = idx[j];
      let sum = tmp[c] * (r + 1);
      for (let i = 1; i <= r; i++) sum += tmp[Math.min(i, h - 1) * rowLen + c];
      col[j] = sum;
    }
    for (let y = 0; y < h; y++) {
      const add = Math.min(y + r + 1, h - 1) * rowLen;
      const sub = Math.max(y - r, 0) * rowLen;
      const out = y * rowLen;
      for (let j = 0; j < idx.length; j++) {
        const c = idx[j];
        data[out + c] = (col[j] * inv + 0.5) | 0;
        col[j] += tmp[add + c] - tmp[sub + c];
      }
    }
  }
}

/** Descreen: print screens are 85-175 lines per inch; this sigma damps
 *  them to a few percent at the scan's resolution while text stays legible */
export function descreenSigma(dpi: number): number {
  return Math.max(0.6, (1.2 * dpi) / 300);
}

function descreen(work: Work, dpi: number) {
  const sigma = descreenSigma(dpi);
  if (work.rgba) {
    gaussianBlur(work.rgba, work.w, work.h, 4, [0, 1, 2], sigma);
    refreshLuma(work);
  } else gaussianBlur(work.L, work.w, work.h, 1, [0], sigma);
}

// ---------------------------------------------------------------------------
// Deskew

function otsu(hist: ArrayLike<number>): number {
  let total = 0;
  let sumAll = 0;
  for (let v = 0; v < 256; v++) {
    total += hist[v];
    sumAll += v * hist[v];
  }
  let wB = 0;
  let sumB = 0;
  let best = -1;
  let t = 128;
  for (let v = 0; v < 256; v++) {
    wB += hist[v];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += v * hist[v];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      t = v + 1;
    }
  }
  return t;
}

/** Only peaks this much above the median score count: text gives several
 *  times, photos and blank pages about 1 */
const SKEW_MIN_CONFIDENCE = 1.5;
const SKEW_MAX = 15;

/** Skew of the text lines in degrees (positive: sloping down to the right),
 *  0 when there is nothing to go by */
function findSkew(A: Analysis, b: Bands, paper: number): number {
  const r = inner(A, b, 0.02);
  const hist = new Float64Array(256);
  for (let y = r.y0; y < r.y1; y++)
    for (let x = r.x0; x < r.x1; x++) hist[A.L[y * A.w + x]]++;
  const area = Math.max(1, (r.x1 - r.x0) * (r.y1 - r.y0));
  const t = Math.min(otsu(hist), paper - 40);
  if (t < 20) return 0;
  let n = 0;
  for (let v = 0; v < t; v++) n += hist[v];
  if (n < 150 || n > area * 0.4) return 0;
  // at most ~150k points: plenty for 0.05 degrees
  const step = Math.max(1, Math.ceil(n / 150000));
  const cx = A.w / 2;
  const cy = A.h / 2;
  const xs = new Float32Array(Math.ceil(n / step) + 1);
  const ys = new Float32Array(xs.length);
  let m = 0;
  let k = 0;
  for (let y = r.y0; y < r.y1; y++)
    for (let x = r.x0; x < r.x1; x++)
      if (A.L[y * A.w + x] < t && k++ % step === 0 && m < xs.length) {
        xs[m] = x - cx;
        ys[m] = y - cy;
        m++;
      }
  const offset = Math.ceil(Math.hypot(A.w, A.h) / 2) + 2;
  const bins = new Int32Array(2 * offset + 1);
  // the coarse sweep needs fewer points than the fine one
  let every = Math.max(1, Math.ceil(m / 40000));
  const score = (deg: number) => {
    const a = (deg * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    bins.fill(0);
    for (let i = 0; i < m; i += every)
      bins[(ys[i] * c - xs[i] * s + offset + 0.5) | 0]++;
    let sum = 0;
    for (let i = 1; i < bins.length; i++) {
      const d = bins[i] - bins[i - 1];
      sum += d * d;
    }
    return sum;
  };
  const coarse: number[] = [];
  let bestI = 0;
  for (let i = 0, deg = -SKEW_MAX; deg <= SKEW_MAX + 1e-9; i++, deg += 0.25) {
    coarse.push(score(deg));
    if (coarse[i] > coarse[bestI]) bestI = i;
  }
  const sorted = coarse.slice().sort((p, q) => p - q);
  const median = sorted[sorted.length >> 1];
  if (!median || coarse[bestI] / median < SKEW_MIN_CONFIDENCE) return 0;
  const center = -SKEW_MAX + bestI * 0.25;
  every = 1;
  let bestDeg = center;
  let bestScore = -1;
  const fine = new Map<number, number>();
  for (let j = -5; j <= 5; j++) {
    const deg = center + j * 0.05;
    const v = score(deg);
    fine.set(j, v);
    if (v > bestScore) {
      bestScore = v;
      bestDeg = deg;
    }
  }
  // parabola through the best fine step and its neighbours
  const j = Math.round((bestDeg - center) / 0.05);
  if (j > -5 && j < 5) {
    const l = fine.get(j - 1)!;
    const c = fine.get(j)!;
    const rr = fine.get(j + 1)!;
    const den = l - 2 * c + rr;
    if (den < 0) bestDeg += clamp((0.5 * (l - rr)) / den, -0.5, 0.5) * 0.05;
  }
  if (Math.abs(bestDeg) >= SKEW_MAX - 0.1) return 0;
  return Math.round(bestDeg * 100) / 100;
}

/** Rotates the page about its center so lines sloping by `deg` become
 *  level (bilinear, in 16.16 fixed point; the corners get the paper color) */
function rotateWork(work: Work, deg: number, fill: RGB) {
  const { w, h } = work;
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const ONE = 65536;
  const dx = Math.round(c * ONE);
  const dy = Math.round(s * ONE);
  const maxX = (w - 1) * ONE;
  const maxY = (h - 1) * ONE;
  const src = work.rgba;
  const fl = luma(fill[0], fill[1], fill[2]);
  if (src) {
    const out = new Uint8ClampedArray(src.length);
    const fill32 = new Uint32Array(1);
    new Uint8Array(fill32.buffer).set([fill[0], fill[1], fill[2], 255]);
    const out32 = new Uint32Array(out.buffer);
    out32.fill(fill32[0]);
    const row4 = w * 4;
    for (let y = 0; y < h; y++) {
      // output (x, y) samples the input at center + R(deg) (p - center)
      let sx = Math.round((cx - cx * c - (y - cy) * s) * ONE);
      let sy = Math.round((cy - cx * s + (y - cy) * c) * ONE);
      let o = y * row4;
      for (let x = 0; x < w; x++, sx += dx, sy += dy, o += 4) {
        if (sx < 0 || sy < 0 || sx >= maxX || sy >= maxY) continue;
        const fx = sx & 0xffff;
        const fy = sy & 0xffff;
        const i = ((sy >> 16) * w + (sx >> 16)) * 4;
        const j = i + row4;
        for (let k = 0; k < 3; k++) {
          const top = src[i + k] * ONE + (src[i + 4 + k] - src[i + k]) * fx;
          const bot = src[j + k] * ONE + (src[j + 4 + k] - src[j + k]) * fx;
          out[o + k] = (top + ((bot - top) / ONE) * fy) / ONE;
        }
      }
    }
    work.rgba = out;
    refreshLuma(work);
    return;
  }
  const L = work.L;
  const out = new Uint8Array(L.length).fill(fl);
  for (let y = 0; y < h; y++) {
    let sx = Math.round((cx - cx * c - (y - cy) * s) * ONE);
    let sy = Math.round((cy - cx * s + (y - cy) * c) * ONE);
    let o = y * w;
    for (let x = 0; x < w; x++, sx += dx, sy += dy, o++) {
      if (sx < 0 || sy < 0 || sx >= maxX || sy >= maxY) continue;
      const fx = sx & 0xffff;
      const fy = sy & 0xffff;
      const i = (sy >> 16) * w + (sx >> 16);
      const top = L[i] * ONE + (L[i + 1] - L[i]) * fx;
      const bot = L[i + w] * ONE + (L[i + w + 1] - L[i + w]) * fx;
      out[o] = (top + ((bot - top) / ONE) * fy + 32768) / ONE;
    }
  }
  work.L = out;
}

// ---------------------------------------------------------------------------
// Finding the document (flatbed preview box, auto-crop)

/** The document on a lid or feeder background, in pixels of L; null if
 *  there is no clear document smaller than the image.
 *  1. The background is the most common brightness of a thin ring around
 *     the image (the lid shows on most of it, wherever the page lies).
 *  2. Pixels far enough from it (noise measured on the ring) are the
 *     document; specks and dust (small components) are dropped.
 *  3. Shadows: a band of smooth pixels darker than the lid along a side,
 *     with something different inside it, is trimmed off. */
function findDocument(L0: Uint8Array, w: number, h: number): Rect | null {
  if (w < 16 || h < 16) return null;
  // 3x3 mean: noise down, edges kept
  const S = new Uint8Array(L0);
  gaussianBlur(S, w, h, 1, [0], 0.8);
  const ring = Math.max(2, Math.round(Math.min(w, h) * 0.015));
  const hist = new Float64Array(256);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (x < ring || y < ring || x >= w - ring || y >= h - ring)
        hist[S[y * w + x]]++;
  let bg = 0;
  let best = -1;
  for (let v = 0; v < 256; v++) {
    let s = 0;
    for (let d = -2; d <= 2; d++) s += hist[clamp(v + d, 0, 255)];
    if (s > best) {
      best = s;
      bg = v;
    }
  }
  // spread of the background (median absolute deviation near the mode)
  const dev = new Float64Array(41);
  let nd = 0;
  for (let v = 0; v < 256; v++) {
    const d = Math.abs(v - bg);
    if (d <= 40) {
      dev[d] += hist[v];
      nd += hist[v];
    }
  }
  let mad = 0;
  for (let acc = 0; mad < 40; mad++) {
    acc += dev[mad];
    if (acc >= nd / 2) break;
  }
  const tol = clamp(3.5 * 1.4826 * mad + 6, 12, 45);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++)
    if (Math.abs(S[i] - bg) > tol) mask[i] = 1;
  const comps = components(mask, w, h, Infinity);
  const minArea = Math.max(4, w * h * 0.0002);
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (const c of comps) {
    if (c.area < minArea) continue;
    x0 = Math.min(x0, c.x0);
    y0 = Math.min(y0, c.y0);
    x1 = Math.max(x1, c.x1);
    y1 = Math.max(y1, c.y1);
  }
  if (x1 < 0) return null;
  // shadow-like: in the mask, darker than the background, not ink-dark
  const shadowy = (i: number) =>
    mask[i] === 1 && S[i] < bg - tol && S[i] > bg * 0.3;
  const lineShare = (horizontal: boolean, at: number) => {
    let n = 0;
    let s = 0;
    if (horizontal)
      for (let x = x0; x <= x1; x++, n++) s += shadowy(at * w + x) ? 1 : 0;
    else for (let y = y0; y <= y1; y++, n++) s += shadowy(y * w + at) ? 1 : 0;
    return n ? s / n : 0;
  };
  const trim = (
    horizontal: boolean,
    from: number,
    dir: 1 | -1,
    size: number
  ) => {
    const max = Math.round(size * 0.12);
    let k = 0;
    while (k < max && lineShare(horizontal, from + dir * k) >= 0.6) k++;
    // a band all the way to the limit is the document itself (grey paper)
    return k > 0 && k < max ? k : 0;
  };
  const top = trim(true, y0, 1, h);
  const bottom = trim(true, y1, -1, h);
  const left = trim(false, x0, 1, w);
  const right = trim(false, x1, -1, w);
  y0 += top;
  y1 -= bottom;
  x0 += left;
  x1 -= right;
  const width = x1 - x0 + 1;
  const height = y1 - y0 + 1;
  if (width <= 0 || height <= 0 || width * height < w * h * 0.03) return null;
  if (width >= w * 0.98 && height >= h * 0.98) return null;
  return { x: x0, y: y0, width, height };
}

/** Where the document lies in a flatbed preview, in the image's pixels:
 *  the whole image when there is no clear document */
export function detectDocument(image: ScanImage): Rect {
  const full = { x: 0, y: 0, width: image.width, height: image.height };
  const work = toWork(image, false);
  // about 600 pixels on the long side is plenty and keeps it instant
  const f = Math.max(1, Math.round(Math.max(work.w, work.h) / 600));
  const A =
    f > 1 ? analyse(work, f) : { w: work.w, h: work.h, f: 1, L: work.L };
  const r = findDocument(A.L, A.w, A.h);
  if (!r) return full;
  const x = Math.max(0, r.x * f);
  const y = Math.max(0, r.y * f);
  return {
    x,
    y,
    width: Math.min(image.width - x, r.width * f),
    height: Math.min(image.height - y, r.height * f),
  };
}

function cropWork(work: Work, r: Rect) {
  const { w } = work;
  const L = new Uint8Array(r.width * r.height);
  for (let y = 0; y < r.height; y++)
    L.set(
      work.L.subarray((r.y + y) * w + r.x, (r.y + y) * w + r.x + r.width),
      y * r.width
    );
  if (work.rgba) {
    const rgba = new Uint8ClampedArray(r.width * r.height * 4);
    for (let y = 0; y < r.height; y++)
      rgba.set(
        work.rgba.subarray(
          ((r.y + y) * w + r.x) * 4,
          ((r.y + y) * w + r.x + r.width) * 4
        ),
        y * r.width * 4
      );
    work.rgba = rgba;
  }
  work.L = L;
  work.w = r.width;
  work.h = r.height;
}

// ---------------------------------------------------------------------------
// Color decision

/** Anything colorful once the paper's tint is balanced away (von Kries), so
 *  yellowed paper and dark text on it stay gray */
function isColorful(A: Analysis, paper: Paper, b: Bands): boolean {
  if (!A.rgb) return false;
  const r = inner(A, b, 0.03);
  const k = paper.rgb.map((c) => paper.level / Math.max(1, c));
  let colorful = 0;
  let n = 0;
  for (let y = r.y0; y < r.y1; y++)
    for (let x = r.x0; x < r.x1; x++, n++) {
      const i = (y * A.w + x) * 3;
      const R = A.rgb[i] * k[0];
      const G = A.rgb[i + 1] * k[1];
      const B = A.rgb[i + 2] * k[2];
      if (Math.max(R, G, B) - Math.min(R, G, B) > 40) colorful++;
    }
  // a few colored specks (noise, a stamp's edge) don't count
  return n > 0 && colorful / n >= 0.002;
}

/** Ink on paper (few mid-tones and no light shading) can be black and
 *  white without losing anything; `nL` has its background made white */
function looksBilevel(nL: Uint8Array): boolean {
  let dark = 0;
  let mid = 0;
  let light = 0;
  for (let i = 0; i < nL.length; i += 3) {
    const v = nL[i];
    if (v < 200) {
      dark++;
      if (v >= 60) mid++;
    } else if (v < 235) light++;
  }
  const n = Math.ceil(nL.length / 3);
  if (light / n >= 0.03) return false;
  if (dark / n < 0.001) return true;
  return mid / dark < 0.6;
}

// ---------------------------------------------------------------------------
// Background removal

interface BgMap {
  gw: number;
  gh: number;
  /** tile size in full-resolution pixels */
  tile: number;
  ch: 1 | 3;
  v: Float32Array;
}

/** The paper's brightness (or color) across the page: per tile the mean of
 *  its brightest pixels; tiles with no paper (photos, big type) are filled
 *  from their neighbours; then smoothed */
function backgroundMap(A: Analysis, paper: Paper, color: boolean): BgMap {
  const ch = color && A.rgb ? 3 : 1;
  const bs = Math.max(6, Math.round(100 / 6)); // ~1/6 inch at ~100 dpi
  const gw = Math.ceil(A.w / bs);
  const gh = Math.ceil(A.h / bs);
  const v = new Float32Array(gw * gh * ch);
  const ok = new Uint8Array(gw * gh);
  const minLevel = Math.max(60, paper.level * 0.6);
  for (let ty = 0; ty < gh; ty++)
    for (let tx = 0; tx < gw; tx++) {
      const y0 = ty * bs;
      const x0 = tx * bs;
      const y1 = Math.min(A.h, y0 + bs);
      const x1 = Math.min(A.w, x0 + bs);
      let max = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) max = Math.max(max, A.L[y * A.w + x]);
      if (max < minLevel) continue;
      const s = [0, 0, 0];
      let n = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const i = y * A.w + x;
          if (A.L[i] < max - 8) continue;
          n++;
          if (ch === 3) {
            s[0] += A.rgb![i * 3];
            s[1] += A.rgb![i * 3 + 1];
            s[2] += A.rgb![i * 3 + 2];
          } else s[0] += A.L[i];
        }
      const t = ty * gw + tx;
      for (let k = 0; k < ch; k++) v[t * ch + k] = s[k] / n;
      ok[t] = 1;
    }
  // fill tiles without paper from their neighbours, ring by ring
  let missing = ok.length - ok.reduce((a, b) => a + b, 0);
  if (missing === ok.length) {
    for (let t = 0; t < ok.length; t++)
      for (let k = 0; k < ch; k++)
        v[t * ch + k] = ch === 3 ? paper.rgb[k] : paper.level;
    missing = 0;
  }
  while (missing > 0) {
    const next = ok.slice();
    for (let ty = 0; ty < gh; ty++)
      for (let tx = 0; tx < gw; tx++) {
        const t = ty * gw + tx;
        if (ok[t]) continue;
        const s = [0, 0, 0];
        let n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = tx + dx;
            const ny = ty + dy;
            if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
            const u = ny * gw + nx;
            if (!ok[u]) continue;
            for (let k = 0; k < ch; k++) s[k] += v[u * ch + k];
            n++;
          }
        if (!n) continue;
        for (let k = 0; k < ch; k++) v[t * ch + k] = s[k] / n;
        next[t] = 1;
        missing--;
      }
    ok.set(next);
  }
  // smooth (3x3 mean), so tile edges never show
  const sm = new Float32Array(v.length);
  for (let ty = 0; ty < gh; ty++)
    for (let tx = 0; tx < gw; tx++)
      for (let k = 0; k < ch; k++) {
        let s = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = tx + dx;
            const ny = ty + dy;
            if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
            s += v[(ny * gw + nx) * ch + k];
            n++;
          }
        sm[(ty * gw + tx) * ch + k] = s / n;
      }
  return { gw, gh, tile: bs * A.f, ch, v: sm };
}

/** A map with one value everywhere (background removal "low") */
function flatMap(paper: Paper, color: boolean): BgMap {
  const ch = color ? 3 : 1;
  return {
    gw: 1,
    gh: 1,
    tile: 1 << 30,
    ch,
    v: Float32Array.from(color ? paper.rgb : [paper.level]),
  };
}

/** Calls fn(y, k) with per-pixel factors for row y: a pixel divided by the
 *  background and stretched to [black, white] is v * k - black * gain.
 *  The map is bilinear between tile centers; as it changes slowly, the
 *  factors are worked out every fourth row. */
function forEachScaleRow(
  map: BgMap,
  w: number,
  h: number,
  white: number,
  black: number,
  lumaOnly: boolean,
  fn: (y: number, k: Float32Array) => void
) {
  const { gw, gh, tile, ch, v } = map;
  const outCh = lumaOnly ? 1 : ch;
  const gain = (255 * 255) / (white - black);
  const k = new Float32Array(w * outCh);
  const tileRow = new Float32Array(gw * ch);
  for (let y = 0; y < h; y++) {
    if ((y & 3) === 0) {
      const fy = clamp((y + 1.5) / tile - 0.5, 0, gh - 1);
      const j0 = Math.floor(fy);
      const j1 = Math.min(gh - 1, j0 + 1);
      const wy = fy - j0;
      for (let i = 0; i < gw * ch; i++)
        tileRow[i] = v[j0 * gw * ch + i] * (1 - wy) + v[j1 * gw * ch + i] * wy;
      for (let x = 0; x < w; x++) {
        const fx = clamp(x / tile - 0.5, 0, gw - 1);
        const i0 = Math.floor(fx);
        const i1 = Math.min(gw - 1, i0 + 1);
        const wx = fx - i0;
        if (ch === 1) {
          k[x] = gain / Math.max(48, tileRow[i0] * (1 - wx) + tileRow[i1] * wx);
          continue;
        }
        const r = tileRow[i0 * 3] * (1 - wx) + tileRow[i1 * 3] * wx;
        const g = tileRow[i0 * 3 + 1] * (1 - wx) + tileRow[i1 * 3 + 1] * wx;
        const b = tileRow[i0 * 3 + 2] * (1 - wx) + tileRow[i1 * 3 + 2] * wx;
        if (lumaOnly)
          k[x] = gain / Math.max(48, 0.299 * r + 0.587 * g + 0.114 * b);
        else {
          k[x * 3] = gain / Math.max(48, r);
          k[x * 3 + 1] = gain / Math.max(48, g);
          k[x * 3 + 2] = gain / Math.max(48, b);
        }
      }
    }
    fn(y, k);
  }
}

/** White and black points for each background removal level (on the page
 *  divided by its background, where the paper is 255) */
const LEVEL_POINTS: Record<Exclude<FilterLevel, 'off'>, [number, number]> = {
  low: [250, 0],
  medium: [240, 8],
  high: [225, 24],
};

/** Divides each pixel by the background, then stretches [black, white] to
 *  [0, 255]. Gray pages: L only. Color pages: each channel by its own map. */
function normalize(work: Work, map: BgMap, white: number, black: number) {
  const { w, h } = work;
  const px = work.rgba;
  if (px && map.ch === 3) {
    const off = (black * 255) / (white - black);
    forEachScaleRow(map, w, h, white, black, false, (y, k) => {
      for (let x = 0, o = y * w * 4, m = 0; x < w; x++, o += 4, m += 3) {
        px[o] = px[o] * k[m] - off;
        px[o + 1] = px[o + 1] * k[m + 1] - off;
        px[o + 2] = px[o + 2] * k[m + 2] - off;
      }
    });
    refreshLuma(work);
    return;
  }
  work.L = normalizedLuma(work, map, white, black);
}

function normalizedLuma(
  work: Work,
  map: BgMap,
  white = 255,
  black = 0
): Uint8Array {
  const { w, h, L } = work;
  const off = (black * 255) / (white - black);
  const out = new Uint8ClampedArray(L.length);
  forEachScaleRow(map, w, h, white, black, true, (y, k) => {
    for (let x = 0, i = y * w; x < w; x++, i++) out[i] = L[i] * k[x] - off;
  });
  return new Uint8Array(out.buffer);
}

// ---------------------------------------------------------------------------
// Sharpening

const SHARPEN: Record<Exclude<FilterLevel, 'off'>, [number, number]> = {
  // [sigma at 300 dpi, amount]
  low: [0.8, 0.5],
  medium: [1, 0.9],
  high: [1.2, 1.5],
};

function sharpen(work: Work, level: Exclude<FilterLevel, 'off'>, dpi: number) {
  const [sigma300, amount] = SHARPEN[level];
  const blurred = new Uint8Array(work.L);
  gaussianBlur(
    blurred,
    work.w,
    work.h,
    1,
    [0],
    Math.max(0.5, (sigma300 * dpi) / 300)
  );
  const L = work.L;
  const px = work.rgba;
  for (let i = 0; i < L.length; i++) {
    const d = L[i] - blurred[i];
    // differences this small are noise; sharpening them makes grain
    if (d > -4 && d < 4) continue;
    const add = amount * d;
    if (px) {
      const o = i * 4;
      px[o] += add;
      px[o + 1] += add;
      px[o + 2] += add;
    } else L[i] = clamp(L[i] + add, 0, 255);
  }
  if (px) refreshLuma(work);
}

// ---------------------------------------------------------------------------
// Connected components and despeckle

interface Component {
  area: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 8-connected components of mask (1 = set), from its runs */
function components(
  mask: Uint8Array,
  w: number,
  h: number,
  maxArea: number
): Component[] {
  const parent: number[] = [];
  const area: number[] = [];
  const bx0: number[] = [];
  const by0: number[] = [];
  const bx1: number[] = [];
  const by1: number[] = [];
  const find = (a: number) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  let prevStart: number[] = [];
  let prevEnd: number[] = [];
  let prevId: number[] = [];
  for (let y = 0; y < h; y++) {
    const start: number[] = [];
    const end: number[] = [];
    const ids: number[] = [];
    const row = y * w;
    let x = 0;
    let p = 0;
    while (x < w) {
      if (!mask[row + x]) {
        x++;
        continue;
      }
      const s = x;
      while (x < w && mask[row + x]) x++;
      const id = parent.length;
      parent.push(id);
      area.push(x - s);
      bx0.push(s);
      bx1.push(x - 1);
      by0.push(y);
      by1.push(y);
      // runs above touching this one (diagonals included)
      while (p < prevStart.length && prevEnd[p] < s - 1) p++;
      for (let q = p; q < prevStart.length && prevStart[q] <= x; q++) {
        const a = find(prevId[q]);
        const b = find(id);
        if (a === b) continue;
        parent[b] = a;
        area[a] += area[b];
        bx0[a] = Math.min(bx0[a], bx0[b]);
        bx1[a] = Math.max(bx1[a], bx1[b]);
        by0[a] = Math.min(by0[a], by0[b]);
        by1[a] = Math.max(by1[a], by1[b]);
      }
      start.push(s);
      end.push(x - 1);
      ids.push(id);
    }
    prevStart = start;
    prevEnd = end;
    prevId = ids;
  }
  const out: Component[] = [];
  for (let i = 0; i < parent.length; i++)
    if (parent[i] === i && area[i] <= maxArea)
      out.push({
        area: area[i],
        x0: bx0[i],
        y0: by0[i],
        x1: bx1[i],
        y1: by1[i],
      });
  return out;
}

/** Specks: at most 0.08 mm² (a full stop in 8 pt type is about as big),
 *  with no other ink within 0.4 mm (dots on i's and full stops sit closer
 *  to their letters than that) */
export function speckArea(dpi: number): number {
  const mm = 25.4 / dpi;
  return Math.max(2, Math.round(0.08 / (mm * mm)));
}
function speckRadius(dpi: number): number {
  return Math.max(2, Math.round((0.4 * dpi) / 25.4));
}

function specks(mask: Uint8Array, w: number, h: number, dpi: number) {
  const r = speckRadius(dpi);
  return components(mask, w, h, speckArea(dpi)).filter((c) => {
    const x0 = Math.max(0, c.x0 - r);
    const x1 = Math.min(w - 1, c.x1 + r);
    const y0 = Math.max(0, c.y0 - r);
    const y1 = Math.min(h - 1, c.y1 + r);
    let n = 0;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) n += mask[y * w + x];
    return n === c.area;
  });
}

/** Paints over isolated specks with the pixels around them */
function despeckleWork(work: Work, dpi: number, paper: number) {
  const { w, h, L } = work;
  const t = paper * 0.6;
  const mask = new Uint8Array(L.length);
  for (let i = 0; i < L.length; i++) if (L[i] < t) mask[i] = 1;
  for (const c of specks(mask, w, h, dpi)) {
    // one pixel more all round takes the speck's soft edge too
    const x0 = Math.max(0, c.x0 - 1);
    const x1 = Math.min(w - 1, c.x1 + 1);
    const y0 = Math.max(0, c.y0 - 1);
    const y1 = Math.min(h - 1, c.y1 + 1);
    const s = [0, 0, 0, 0];
    let n = 0;
    for (let y = Math.max(0, y0 - 1); y <= Math.min(h - 1, y1 + 1); y++)
      for (let x = Math.max(0, x0 - 1); x <= Math.min(w - 1, x1 + 1); x++) {
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) continue;
        const i = y * w + x;
        s[3] += L[i];
        if (work.rgba) {
          s[0] += work.rgba[i * 4];
          s[1] += work.rgba[i * 4 + 1];
          s[2] += work.rgba[i * 4 + 2];
        }
        n++;
      }
    if (!n) continue;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const i = y * w + x;
        L[i] = Math.round(s[3] / n);
        if (work.rgba) {
          work.rgba[i * 4] = s[0] / n;
          work.rgba[i * 4 + 1] = s[1] / n;
          work.rgba[i * 4 + 2] = s[2] / n;
        }
      }
  }
}

function despeckleMask(mask: Uint8Array, w: number, h: number, dpi: number) {
  for (const c of specks(mask, w, h, dpi))
    for (let y = c.y0; y <= c.y1; y++)
      mask.fill(0, y * w + c.x0, y * w + c.x1 + 1);
}

// ---------------------------------------------------------------------------
// Black and white

/** Otsu's threshold on the page with its background made white, kept in a
 *  sane range (pages with almost no ink have no real second class) */
export function autoThreshold(nL: Uint8Array): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < nL.length; i++) hist[nL[i]]++;
  return clamp(otsu(hist), 96, 200);
}

function binarize(nL: Uint8Array, t: number): Uint8Array {
  const mask = new Uint8Array(nL.length);
  for (let i = 0; i < nL.length; i++) if (nL[i] < t) mask[i] = 1;
  return mask;
}

function packBits(mask: Uint8Array, w: number, h: number): Bitmap {
  const rb = bitmapRowBytes(w);
  const data = new Uint8Array(rb * h);
  for (let y = 0; y < h; y++) {
    const src = y * w;
    const dst = y * rb;
    for (let x = 0; x < w; x++)
      if (mask[src + x]) data[dst + (x >> 3)] |= 0x80 >> (x & 7);
  }
  return { width: w, height: h, data };
}

// ---------------------------------------------------------------------------
// Right-angle rotation

function rotatePixels<T extends Pixels>(
  data: T,
  w: number,
  h: number,
  ch: number,
  rot: Rotation
): { data: T; w: number; h: number } {
  if (rot === 0) return { data, w, h };
  const out = new (data.constructor as { new (n: number): T })(data.length);
  const nw = rot === 180 ? w : h;
  const nh = rot === 180 ? h : w;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let nx: number;
      let ny: number;
      if (rot === 90) {
        nx = h - 1 - y;
        ny = x;
      } else if (rot === 180) {
        nx = w - 1 - x;
        ny = h - 1 - y;
      } else {
        nx = y;
        ny = w - 1 - x;
      }
      const s = (y * w + x) * ch;
      const d = (ny * nw + nx) * ch;
      for (let k = 0; k < ch; k++) out[d + k] = data[s + k];
    }
  return { data: out, w: nw, h: nh };
}

// ---------------------------------------------------------------------------
// The pipeline

function withDefaults(s: Partial<ScanImageSettings>): ScanImageSettings {
  return {
    ...DEFAULT_SCAN_IMAGE_SETTINGS,
    ...s,
    removeBlank: {
      ...DEFAULT_SCAN_IMAGE_SETTINGS.removeBlank,
      ...(s.removeBlank ?? {}),
    },
  };
}

/** Cleans up one scanned page and makes it color, gray or black and white */
export async function processPage(
  image: ScanImage,
  settings: Partial<ScanImageSettings>,
  deps: ProcessDeps = {}
): Promise<ProcessedPage> {
  const s = withDefaults(settings);
  const dpi = image.dpi > 0 ? image.dpi : 300;
  const mayBeColor =
    image.channels !== 1 && (s.colorMode === 'color' || s.colorMode === 'auto');
  const work = toWork(image, mayBeColor);

  const lut = levelsLut(s);
  if (lut) applyLut(work, lut);

  const f = analysisFactor(dpi);
  let A = analyse(work, f);
  const paper = estimatePaper(A);

  let bands = NO_BANDS;
  if (s.edgeShadowRemoval) {
    bands = findEdgeShadows(A, paper.level);
    if (bands.top || bands.bottom || bands.left || bands.right)
      fillBands(work, A, bands, paper.rgb);
  }

  const coverage = inkCoverage(
    A,
    paper.level,
    bands,
    s.removeBlank.sensitivity
  );
  const blank = coverage < blankCoverageLimit(s.removeBlank.sensitivity);
  // a blank page about to be dropped gets only the cheap steps
  const full = !(blank && s.removeBlank.enabled);

  if (work.rgba && s.colorMode === 'auto' && !isColorful(A, paper, bands)) {
    dropColor(work);
    A = { ...A, rgb: null };
  }

  if (full && s.descreen) descreen(work, dpi);

  let skew = 0;
  let geometryChanged = false;
  if (full && s.deskew) {
    skew = findSkew(A, bands, paper.level);
    if (Math.abs(skew) >= 0.05) {
      rotateWork(work, skew, paper.rgb);
      geometryChanged = true;
    } else skew = 0;
  }

  let crop: Rect | null = null;
  if (full && s.autoCrop) {
    if (geometryChanged) A = analyse(work, f);
    const r = findDocument(A.L, A.w, A.h);
    if (r) {
      const x = Math.min(work.w - 1, r.x * f);
      const y = Math.min(work.h - 1, r.y * f);
      crop = {
        x,
        y,
        width: Math.min(work.w - x, r.width * f),
        height: Math.min(work.h - y, r.height * f),
      };
      cropWork(work, crop);
      A = cropAnalysis(A, crop);
    }
  } else if (geometryChanged) A = analyse(work, f);

  // the background, for removal, for black and white, and for Autodetect
  const needMap =
    s.backgroundRemoval !== 'off' ||
    s.colorMode === 'bw' ||
    s.colorMode === 'auto';
  const map =
    needMap && full
      ? backgroundMap(A, paper, !!work.rgba)
      : flatMap(paper, !!work.rgba);
  let nL: Uint8Array | null = null;
  let kind: 'color' | 'gray' | 'bw';
  if (work.rgba) kind = 'color';
  else if (s.colorMode === 'bw') kind = 'bw';
  else if (s.colorMode === 'auto') {
    nL = normalizedLuma(work, map);
    kind = looksBilevel(nL) ? 'bw' : 'gray';
  } else kind = 'gray';

  if (kind !== 'bw' && s.backgroundRemoval !== 'off') {
    const [white, black] = LEVEL_POINTS[s.backgroundRemoval];
    normalize(
      work,
      s.backgroundRemoval === 'low' ? flatMap(paper, !!work.rgba) : map,
      white,
      black
    );
  }

  if (full && s.textSharpening !== 'off') sharpen(work, s.textSharpening, dpi);
  if (full && s.despeckle && kind !== 'bw')
    despeckleWork(work, dpi, s.backgroundRemoval !== 'off' ? 255 : paper.level);

  let mask: Uint8Array | null = null;
  if (kind === 'bw') {
    if (!nL || s.textSharpening !== 'off') nL = normalizedLuma(work, map);
    mask = binarize(nL, s.threshold ?? autoThreshold(nL));
    if (full && s.despeckle) despeckleMask(mask, work.w, work.h, dpi);
  }

  // orientation
  let base: Rotation = s.flip ? 180 : 0;
  if (s.autoRotate && deps.detectOrientation) {
    const view: ScanImage = mask
      ? {
          width: work.w,
          height: work.h,
          channels: 1,
          data: maskToGray(mask),
          dpi,
        }
      : { width: work.w, height: work.h, channels: 1, data: work.L, dpi };
    const found = await deps.detectOrientation(view);
    if (found) base = found.rotate;
  }
  const rotation = ((base + s.rotate) % 360) as Rotation;

  const info = { dpi, blank, rotation, skew, crop };
  if (mask) {
    const r = rotatePixels(mask, work.w, work.h, 1, rotation);
    return {
      ...info,
      kind: 'bw',
      width: r.w,
      height: r.h,
      bitmap: packBits(r.data, r.w, r.h),
    };
  }
  if (work.rgba) {
    const r = rotatePixels(work.rgba, work.w, work.h, 4, rotation);
    return {
      ...info,
      kind: 'color',
      width: r.w,
      height: r.h,
      image: { width: r.w, height: r.h, channels: 4, data: r.data, dpi },
    };
  }
  const r = rotatePixels(work.L, work.w, work.h, 1, rotation);
  return {
    ...info,
    kind: 'gray',
    width: r.w,
    height: r.h,
    image: { width: r.w, height: r.h, channels: 1, data: r.data, dpi },
  };
}

function maskToGray(mask: Uint8Array): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] ? 0 : 255;
  return out;
}
