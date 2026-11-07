/**
 * What happens to a scanned page between the scanner and the PDF: the
 * clean-up the scanner didn't do (ProcessPlan, scan-settings.ts), then
 * encoding at the chosen file size, then the PDF itself.
 */
import { PDFDocument, degrees } from 'pdf-lib';
import type { ProcessPlan, ScanSettings } from './scan-settings';

/** A page as the scanner sent it */
export interface ScannedPage {
  data: Uint8Array;
  mime: string;
  dpi: number;
}

/** A page after clean-up: lossless, ready to be shown and encoded */
export interface ProcessedPage {
  image: Blob;
  width: number;
  height: number;
  dpi: number;
  color: 'color' | 'gray' | 'bw';
  /** Looks blank (only when blank pages are looked for) */
  blank: boolean;
}

/** A page ready for the PDF */
export interface PreparedPage {
  bytes: Uint8Array;
  kind: 'jpg' | 'png';
  width: number;
  height: number;
  dpi: number;
  /** Extra turn, clockwise (the review strip's rotate) */
  rotation: number;
}

/** Whether a page (RGBA pixels) has no real color: Autodetect keeps it gray */
export function looksGray(px: Uint8ClampedArray, step = 7): boolean {
  let colorful = 0;
  let seen = 0;
  for (let o = 0; o < px.length; o += 4 * step) {
    seen++;
    if (Math.max(px[o], px[o + 1], px[o + 2]) - Math.min(px[o], px[o + 1], px[o + 2]) > 40)
      colorful++;
  }
  // A few colored specks (scanner noise, a stamp's edge) don't count
  return seen > 0 && colorful / seen < 0.002;
}

/**
 * Whether a page is blank: the share of dark pixels away from the edges
 * (where shadows and punch holes are), against the sensitivity (0: only
 * truly empty pages; 100: pages with a little on them too).
 */
export function looksBlank(
  px: Uint8ClampedArray,
  width: number,
  height: number,
  sensitivity: number
): boolean {
  const mx = Math.round(width * 0.06);
  const my = Math.round(height * 0.06);
  let dark = 0;
  let seen = 0;
  for (let y = my; y < height - my; y += 2)
    for (let x = mx; x < width - mx; x += 2) {
      const o = (y * width + x) * 4;
      seen++;
      if (0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2] < 160) dark++;
    }
  const limit = 0.0002 + (sensitivity / 100) * 0.004;
  return seen > 0 && dark / seen <= limit;
}

const canvasFor = (w: number, h: number) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};

/** Cleans up one page as the plan says */
export async function processPage(
  page: ScannedPage,
  plan: ProcessPlan
): Promise<ProcessedPage> {
  const bitmap = await createImageBitmap(
    new Blob([page.data as BlobPart], { type: page.mime })
  );
  const turned = plan.rotate === 90 || plan.rotate === 270;
  const width = turned ? bitmap.height : bitmap.width;
  const height = turned ? bitmap.width : bitmap.height;
  const canvas = canvasFor(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.translate(width / 2, height / 2);
  ctx.rotate((plan.rotate * Math.PI) / 180);
  ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  bitmap.close();
  const img = ctx.getImageData(0, 0, width, height);
  const px = img.data;
  const gain = 1 + plan.contrast / 100;
  const lift = plan.brightness * 1.28;
  if (gain !== 1 || lift)
    for (let o = 0; o < px.length; o += 4)
      for (let c = 0; c < 3; c++)
        px[o + c] = (px[o + c] - 128) * gain + 128 + lift;
  const color: ProcessedPage['color'] =
    plan.color === 'auto'
      ? looksGray(px)
        ? 'gray'
        : 'color'
      : plan.color;
  if (color !== 'color')
    for (let o = 0; o < px.length; o += 4) {
      let y = 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2];
      if (color === 'bw') y = y > (plan.threshold ?? 128) ? 255 : 0;
      if (plan.invert && color === 'bw') y = 255 - y;
      px[o] = px[o + 1] = px[o + 2] = y;
    }
  ctx.putImageData(img, 0, 0);
  const blank =
    plan.blankSensitivity !== null &&
    looksBlank(px, width, height, plan.blankSensitivity);
  const image = await new Promise<Blob | null>((r) =>
    canvas.toBlob(r, 'image/png')
  );
  if (!image) throw new Error("A scanned page couldn't be prepared");
  return { image, width, height, dpi: page.dpi, color, blank };
}

/** JPEG quality from the Small size ↔ High quality slider */
export const jpegQuality = (q: number) => 0.3 + Math.min(1, Math.max(0, q)) * 0.65;

/** A cleaned-up page encoded for the PDF, as the file size settings say */
export async function encodePage(
  page: ProcessedPage,
  s: Pick<ScanSettings, 'quality' | 'compression' | 'bwCompression'>,
  rotation = 0
): Promise<PreparedPage> {
  const lossless =
    page.color === 'bw' || s.compression === 'zip';
  if (lossless)
    return {
      bytes: new Uint8Array(await page.image.arrayBuffer()),
      kind: 'png',
      width: page.width,
      height: page.height,
      dpi: page.dpi,
      rotation,
    };
  const bitmap = await createImageBitmap(page.image);
  const canvas = canvasFor(page.width, page.height);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  bitmap.close();
  const out = await new Promise<Blob | null>((r) =>
    canvas.toBlob(r, 'image/jpeg', jpegQuality(s.quality))
  );
  if (!out) throw new Error("A scanned page couldn't be prepared");
  return {
    bytes: new Uint8Array(await out.arrayBuffer()),
    kind: 'jpg',
    width: page.width,
    height: page.height,
    dpi: page.dpi,
    rotation,
  };
}

/** A page of the PDF: a scanned image, or a page of a PDF a scanner's app
 *  saved (Import from a scanner app), copied as it is */
export type PdfPart =
  | { kind: 'image'; page: PreparedPage }
  | { kind: 'pdf'; bytes: Uint8Array; index: number; rotation: number };

/** One PDF page per part, images at their real size (from their resolution) */
export async function buildPdf(parts: PdfPart[]): Promise<Uint8Array> {
  // (pdf-lib would name itself the producer when saving)
  const doc = await PDFDocument.create({ updateMetadata: false });
  const now = new Date();
  doc.setProducer('Paperwing');
  doc.setCreator('Paperwing');
  doc.setCreationDate(now);
  doc.setModificationDate(now);
  const sources = new Map<Uint8Array, PDFDocument>();
  for (const part of parts) {
    if (part.kind === 'pdf') {
      let src = sources.get(part.bytes);
      if (!src) {
        src = await PDFDocument.load(part.bytes, { ignoreEncryption: true });
        sources.set(part.bytes, src);
      }
      const [copied] = await doc.copyPages(src, [part.index]);
      if (part.rotation)
        copied.setRotation(
          degrees((copied.getRotation().angle + part.rotation) % 360)
        );
      doc.addPage(copied);
      continue;
    }
    const p = part.page;
    const image =
      p.kind === 'jpg' ? await doc.embedJpg(p.bytes) : await doc.embedPng(p.bytes);
    const w = (p.width / p.dpi) * 72;
    const h = (p.height / p.dpi) * 72;
    const page = doc.addPage([w, h]);
    page.drawImage(image, { x: 0, y: 0, width: w, height: h });
    if (p.rotation) page.setRotation(degrees(p.rotation % 360));
  }
  return doc.save();
}
