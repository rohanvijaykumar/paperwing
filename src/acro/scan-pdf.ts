/**
 * Scanned pages into PDF: encoders (JPEG through OffscreenCanvas, lossless
 * Flate with PNG predictors, CCITT Group 4 for black and white), the PDF
 * builder (one page per image, sized from its resolution), and "Enhance
 * scanned pages" (the clean-up filters run again on an existing PDF's pages,
 * with rendering injected). Framework-free: runs in a Web Worker.
 */
import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  type PDFPage,
} from 'pdf-lib';
import { encodeG4 } from './scan-g4';
import { encodeGrayJpeg } from './scan-jpeg';
import {
  processPage,
  type ProcessDeps,
  type ProcessedPage,
  type Rect,
  type Rotation,
  type ScanImage,
  type ScanImageSettings,
} from './scan-image';

export type Compression = 'jpeg' | 'flate';

/** Turns RGBA pixels into JPEG bytes (quality 0-1) */
export type JpegEncoder = (
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  quality: number
) => Promise<Uint8Array>;

export interface EncodeOptions {
  /** color and gray pages: JPEG (size set by quality) or Flate (lossless,
   *  Acrobat's "ZIP"); black and white pages are always CCITT Group 4 */
  compression: Compression;
  /** JPEG quality, 0.3 (small) to 0.95 (high), from the file size slider */
  quality: number;
}

/** A page ready for the PDF */
export type EncodedPage =
  | {
      /** JPEG or PNG bytes, embedded as they are */
      kind: 'jpg' | 'png';
      bytes: Uint8Array;
      width: number;
      height: number;
      dpi: number;
    }
  | {
      /** CCITT Group 4 (T.6) stream, 1 bit a pixel */
      kind: 'g4';
      bytes: Uint8Array;
      width: number;
      height: number;
      dpi: number;
    }
  | {
      /** zlib data of rows with PNG predictors (PDF Predictor 15) */
      kind: 'flate';
      bytes: Uint8Array;
      width: number;
      height: number;
      dpi: number;
      colors: 1 | 3;
    };

// ---------------------------------------------------------------------------
// Encoders

/** JPEG through OffscreenCanvas (workers and pages in Chromium) */
export const canvasJpeg: JpegEncoder = async (rgba, width, height, quality) => {
  if (typeof OffscreenCanvas === 'undefined')
    throw new Error('JPEG needs OffscreenCanvas');
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error("A scanned page couldn't be drawn");
  ctx.putImageData(
    new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, width, height),
    0,
    0
  );
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return new Uint8Array(await blob.arrayBuffer());
};

function rgbaOf(image: ScanImage): Uint8ClampedArray {
  const { width, height, channels, data } = image;
  if (channels === 4 && data instanceof Uint8ClampedArray) return data;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, o = 0; i < width * height; i++, o += 4) {
    const s = i * channels;
    out[o] = data[s];
    out[o + 1] = data[channels === 1 ? s : s + 1];
    out[o + 2] = data[channels === 1 ? s : s + 2];
    out[o + 3] = 255;
  }
  return out;
}

/** zlib (RFC 1950), what FlateDecode reads, by the platform's own zlib */
export async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Rows with the PNG filter that suits each best (smallest sum of absolute
 *  differences, the PNG specification's heuristic): None, Sub, Up or Paeth */
export function pngPredict(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  colors: 1 | 3,
  stride: number
): Uint8Array {
  const rowLen = width * colors;
  const out = new Uint8Array((rowLen + 1) * height);
  const cur = new Uint8Array(rowLen);
  let prev = new Uint8Array(rowLen);
  const cand = [0, 1, 2, 3].map(() => new Uint8Array(rowLen));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++)
      for (let k = 0; k < colors; k++)
        cur[x * colors + k] = data[(y * width + x) * stride + k];
    const sums = [0, 0, 0, 0];
    for (let i = 0; i < rowLen; i++) {
      const a = i >= colors ? cur[i - colors] : 0;
      const b = prev[i];
      const c = i >= colors ? prev[i - colors] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      const v = cur[i];
      const f = [v, (v - a) & 255, (v - b) & 255, (v - paeth) & 255];
      for (let k = 0; k < 4; k++) {
        cand[k][i] = f[k];
        sums[k] += f[k] < 128 ? f[k] : 256 - f[k];
      }
    }
    let best = 0;
    for (let k = 1; k < 4; k++) if (sums[k] < sums[best]) best = k;
    const o = y * (rowLen + 1);
    out[o] = [0, 1, 2, 4][best];
    out.set(cand[best], o + 1);
    prev = cur.slice();
  }
  return out;
}

/** A processed page in the PDF's encoding */
export async function encodePage(
  page: ProcessedPage,
  opts: EncodeOptions,
  jpeg: JpegEncoder = canvasJpeg
): Promise<EncodedPage> {
  const { width, height, dpi } = page;
  if (page.kind === 'bw')
    return { kind: 'g4', bytes: encodeG4(page.bitmap), width, height, dpi };
  const image = page.image;
  if (opts.compression === 'flate') {
    const colors = image.channels === 1 ? 1 : 3;
    const rows = pngPredict(image.data, width, height, colors, image.channels);
    return {
      kind: 'flate',
      bytes: await deflate(rows),
      width,
      height,
      dpi,
      colors,
    };
  }
  const quality = Math.min(1, Math.max(0.05, opts.quality));
  // Gray pages as gray JPEGs (the canvas only writes color ones)
  const bytes =
    image.channels === 1
      ? encodeGrayJpeg(image.data, width, height, quality, dpi)
      : await jpeg(rgbaOf(image), width, height, quality);
  return { kind: 'jpg', bytes, width, height, dpi };
}

// ---------------------------------------------------------------------------
// PDF

/** The image as an XObject in doc */
async function embed(doc: PDFDocument, p: EncodedPage): Promise<PDFRef> {
  if (p.kind !== 'g4' && p.kind !== 'flate') {
    const image =
      p.kind === 'jpg'
        ? await doc.embedJpg(p.bytes)
        : await doc.embedPng(p.bytes);
    return image.ref;
  }
  const common = {
    Type: 'XObject',
    Subtype: 'Image',
    Width: p.width,
    Height: p.height,
  };
  const dict =
    p.kind === 'g4'
      ? {
          ...common,
          ColorSpace: 'DeviceGray',
          BitsPerComponent: 1,
          Filter: 'CCITTFaxDecode',
          // (BlackIs1 false: the decoded 0 bits are black, as DeviceGray
          // draws them)
          DecodeParms: {
            K: -1,
            Columns: p.width,
            Rows: p.height,
            BlackIs1: false,
          },
        }
      : flateDict(p, common);
  return doc.context.register(doc.context.stream(p.bytes, dict));
}

function flateDict(
  p: Extract<EncodedPage, { kind: 'flate' }>,
  common: Record<string, string | number>
) {
  return {
    ...common,
    ColorSpace: p.colors === 3 ? 'DeviceRGB' : 'DeviceGray',
    BitsPerComponent: 8,
    Filter: 'FlateDecode',
    DecodeParms: {
      Predictor: 15,
      Colors: p.colors,
      BitsPerComponent: 8,
      Columns: p.width,
    },
  };
}

/** PDF matrix drawing an image upright over box on a page shown rotated
 *  clockwise by `rotate` */
function placement(box: Rect, rotate: Rotation): number[] {
  const { x, y, width: w, height: h } = box;
  switch (rotate) {
    case 90:
      return [0, h, -w, 0, x + w, y];
    case 180:
      return [-w, 0, 0, -h, x + w, y + h];
    case 270:
      return [0, -h, w, 0, x, y + h];
    default:
      return [w, 0, 0, h, x, y];
  }
}

/** Makes the image the page's only content */
function setPageImage(
  doc: PDFDocument,
  page: PDFPage,
  ref: PDFRef,
  box: Rect,
  rotate: Rotation
) {
  const m = placement(box, rotate)
    .map((v) => +v.toFixed(4))
    .join(' ');
  const content = doc.context.register(
    doc.context.stream(`q ${m} cm /Im0 Do Q`)
  );
  const xobjects = doc.context.obj({ Im0: ref });
  page.node.set(
    PDFName.of('Resources'),
    doc.context.obj({ XObject: xobjects })
  );
  page.node.set(PDFName.of('Contents'), content);
  page.node.set(PDFName.of('Rotate'), PDFNumber.of(rotate));
  // a thumbnail of the old content would be wrong now
  page.node.delete(PDFName.of('Thumb'));
}

/** Paperwing as producer, without pdf-lib naming itself */
async function newDoc(): Promise<PDFDocument> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const now = new Date();
  doc.setProducer('Paperwing');
  doc.setCreator('Paperwing');
  doc.setCreationDate(now);
  doc.setModificationDate(now);
  return doc;
}

/** One PDF page per image, at its real size (from its resolution) */
export async function buildScanPdf(pages: EncodedPage[]): Promise<Uint8Array> {
  const doc = await newDoc();
  for (const p of pages) await addScanPage(doc, p);
  return doc.save();
}

/** Adds a page for p at the end of doc (or at `index`) */
export async function addScanPage(
  doc: PDFDocument,
  p: EncodedPage,
  index?: number
): Promise<PDFPage> {
  const w = (p.width / p.dpi) * 72;
  const h = (p.height / p.dpi) * 72;
  const page =
    index === undefined ? doc.addPage([w, h]) : doc.insertPage(index, [w, h]);
  setPageImage(
    doc,
    page,
    await embed(doc, p),
    { x: 0, y: 0, width: w, height: h },
    0
  );
  return page;
}

// ---------------------------------------------------------------------------
// Process and encode in one go (what the worker does per page)

export interface PageSummary {
  kind: 'color' | 'gray' | 'bw';
  blank: boolean;
  rotation: Rotation;
  skew: number;
  crop: Rect | null;
}

export interface PreparedScan extends PageSummary {
  encoded: EncodedPage;
}

export async function preparePage(
  image: ScanImage,
  settings: Partial<ScanImageSettings>,
  encode: EncodeOptions,
  deps: ProcessDeps & { jpeg?: JpegEncoder } = {}
): Promise<PreparedScan> {
  const page = await processPage(image, settings, deps);
  const encoded = await encodePage(page, encode, deps.jpeg);
  return summary(page, encoded);
}

export function summary(
  page: ProcessedPage,
  encoded: EncodedPage
): PreparedScan {
  const { kind, blank, rotation, skew, crop } = page;
  return { kind, blank, rotation, skew, crop, encoded };
}

// ---------------------------------------------------------------------------
// Enhance scanned pages

/** Draws page `index` (0-based) as shown (its /Rotate applied) at `dpi` */
export type PageRenderer = (index: number, dpi: number) => Promise<ScanImage>;

export type PagePreparer = (
  image: ScanImage,
  settings: Partial<ScanImageSettings>,
  encode: EncodeOptions
) => Promise<PreparedScan>;

export interface EnhanceOptions {
  /** 0-based pages to enhance; all by default */
  pages?: number[];
  /** resolution when a page's own scan resolution can't be read (300) */
  dpi?: number;
  encode?: EncodeOptions;
  /** e.g. the worker client's preparePage; in this thread by default */
  prepare?: PagePreparer;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export interface EnhanceResult {
  pdf: Uint8Array;
  /** pages (0-based, original numbering) removed as blank */
  removed: number[];
  pages: Array<PageSummary & { index: number }>;
}

/** The resolution of the biggest image drawn on the page, if any */
export function pageImageDpi(doc: PDFDocument, page: PDFPage): number | null {
  const res = page.node.Resources();
  const xobjects = res?.lookup(PDFName.of('XObject'));
  if (!(xobjects instanceof PDFDict)) return null;
  let best = 0;
  let size: [number, number] = [0, 0];
  for (const [, value] of xobjects.entries()) {
    const obj = value instanceof PDFRef ? doc.context.lookup(value) : value;
    if (!(obj instanceof PDFRawStream)) continue;
    if (obj.dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
    const w = obj.dict.lookup(PDFName.of('Width'));
    const h = obj.dict.lookup(PDFName.of('Height'));
    if (!(w instanceof PDFNumber) || !(h instanceof PDFNumber)) continue;
    if (w.asNumber() * h.asNumber() > best) {
      best = w.asNumber() * h.asNumber();
      size = [w.asNumber(), h.asNumber()];
    }
  }
  if (!best) return null;
  const { width, height } = page.getCropBox();
  const dpi = (Math.max(...size) / Math.max(width, height)) * 72;
  return Math.round(Math.min(600, Math.max(100, dpi)));
}

/** Runs the clean-up filters on pages of an existing PDF: each page's
 *  content becomes its cleaned image (page size, links and annotations stay;
 *  an OCR text layer has to be recognized again). Auto-crop is ignored so
 *  pages keep their size. */
export async function enhancePdfPages(
  pdfBytes: Uint8Array,
  settings: Partial<ScanImageSettings>,
  renderPage: PageRenderer,
  options: EnhanceOptions = {}
): Promise<EnhanceResult> {
  const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  const count = doc.getPageCount();
  const indices = (options.pages ?? [...Array(count).keys()]).filter(
    (i) => Number.isInteger(i) && i >= 0 && i < count
  );
  const encode = options.encode ?? { compression: 'jpeg', quality: 0.75 };
  const prepare: PagePreparer =
    options.prepare ?? ((img, s, e) => preparePage(img, s, e));
  const effective = { ...settings, autoCrop: false };
  const removed: number[] = [];
  const pages: EnhanceResult['pages'] = [];
  let done = 0;
  for (const index of indices) {
    options.signal?.throwIfAborted();
    const page = doc.getPage(index);
    const dpi = pageImageDpi(doc, page) ?? options.dpi ?? 300;
    const image = await renderPage(index, dpi);
    const result = await prepare(image, effective, encode);
    const { encoded, ...info } = result;
    pages.push({ index, ...info });
    if (settings.removeBlank?.enabled && result.blank) removed.push(index);
    else {
      const old = (((page.getRotation().angle % 360) + 360) % 360) as Rotation;
      const rotate = ((old + result.rotation) % 360) as Rotation;
      setPageImage(
        doc,
        page,
        await embed(doc, encoded),
        page.getCropBox(),
        rotate
      );
    }
    options.onProgress?.(++done, indices.length);
  }
  // never leave a document without pages
  const remove = removed.length === count ? removed.slice(1) : removed;
  for (const index of [...remove].sort((a, b) => b - a)) doc.removePage(index);
  return { pdf: await doc.save(), removed: remove, pages };
}

// ---------------------------------------------------------------------------
// Decoding scanner files (PNG, JPEG, BMP...) where createImageBitmap exists

export interface ScanFile {
  bytes: Uint8Array;
  mime: string;
  dpi: number;
}

export async function decodeScanFile(file: ScanFile): Promise<ScanImage> {
  const bitmap = await createImageBitmap(
    new Blob([file.bytes as BlobPart], { type: file.mime })
  );
  try {
    const { width, height } = bitmap;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error("A scanned page couldn't be read");
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, width, height);
    return { width, height, channels: 4, data, dpi: file.dpi };
  } finally {
    bitmap.close();
  }
}
