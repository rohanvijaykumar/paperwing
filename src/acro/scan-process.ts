/**
 * What happens to a scanned page between the scanner and the PDF, on top of
 * scan-image.ts (the clean-up, in a worker) and scan-pdf.ts (the encoders and
 * the PDF): each page is cleaned up as it arrives, kept losslessly while the
 * pages are reviewed, and encoded at the chosen file size at the end.
 */
import { PDFDocument, degrees } from 'pdf-lib';
import type {
  Bitmap,
  OrientationDetector,
  Rect,
  ScanImage,
  ScanImageSettings,
} from './scan-image';
import { createScanImageClient } from './scan-image-client';
import {
  addScanPage,
  encodePage as encodeScanPage,
  type EncodedPage,
} from './scan-pdf';
import type { ProcessPlan, ScanSettings } from './scan-settings';

/** A page as the scanner (or a scanner's app) sent it */
export interface ScannedPage {
  data: Uint8Array;
  mime: string;
  dpi: number;
}

/** A page after clean-up, kept losslessly until the PDF is made */
export interface ProcessedPage {
  kind: 'color' | 'gray' | 'bw';
  width: number;
  height: number;
  dpi: number;
  /** Found blank (only when blank pages are looked for) */
  blank: boolean;
  /** Color and gray pages: a lossless picture; black and white: 1 bit */
  image: Blob | null;
  bitmap: Bitmap | null;
  /** A small picture for the dialog */
  thumb: Blob;
}

/** The scan dialog's plan as scan-image's settings */
export function imageSettings(
  plan: ProcessPlan,
  flip = false
): ScanImageSettings {
  return {
    crop: plan.crop,
    colorMode: plan.color,
    threshold: plan.color === 'bw' ? plan.threshold : null,
    brightness: plan.brightness,
    contrast: plan.contrast,
    invert: plan.invert,
    deskew: plan.deskew,
    autoCrop: plan.autoCrop,
    backgroundRemoval: plan.background,
    descreen: plan.descreen,
    textSharpening: plan.sharpen,
    despeckle: plan.despeckle,
    edgeShadowRemoval: plan.edgeShadow,
    removeBlank: {
      enabled: plan.blankSensitivity !== null,
      sensitivity: plan.blankSensitivity ?? 50,
    },
    autoRotate: plan.autoRotate,
    rotate: plan.rotate,
    flip,
  };
}

const canvas = (w: number, h: number) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};
const toBlob = (c: HTMLCanvasElement, type = 'image/png') =>
  new Promise<Blob>((resolve, reject) =>
    c.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("A page couldn't be kept"))),
      type
    )
  );

/** A scanner file's pixels */
export async function decode(file: Blob, dpi: number): Promise<ScanImage> {
  const bitmap = await createImageBitmap(file);
  try {
    const c = canvas(bitmap.width, bitmap.height);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    return { width: c.width, height: c.height, channels: 4, data, dpi };
  } finally {
    bitmap.close();
  }
}

function imageData(img: ScanImage): ImageData {
  const { width, height, channels, data } = img;
  const out = new ImageData(width, height);
  for (let i = 0, o = 0; i < width * height; i++, o += 4) {
    const s = i * channels;
    out.data[o] = data[s];
    out.data[o + 1] = data[channels === 1 ? s : s + 1];
    out.data[o + 2] = data[channels === 1 ? s : s + 2];
    out.data[o + 3] = 255;
  }
  return out;
}

/** A 1-bit page drawn as pixels, `scale` times smaller */
function bitmapData(b: Bitmap, scale: number): ImageData {
  const w = Math.max(1, Math.floor(b.width / scale));
  const h = Math.max(1, Math.floor(b.height / scale));
  const out = new ImageData(w, h);
  const row = (b.width + 7) >> 3;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = Math.floor(x * scale);
      const sy = Math.floor(y * scale);
      const black = (b.data[sy * row + (sx >> 3)] >> (7 - (sx & 7))) & 1;
      const o = (y * w + x) * 4;
      out.data[o] = out.data[o + 1] = out.data[o + 2] = black ? 0 : 255;
      out.data[o + 3] = 255;
    }
  return out;
}

const THUMB = 240;

/** Cleans up pages off the main thread; one per scan dialog */
export function createPageProcessor(detectOrientation?: OrientationDetector) {
  const client = createScanImageClient({ detectOrientation });

  async function process(
    page: ScannedPage,
    plan: ProcessPlan,
    flip = false
  ): Promise<ProcessedPage> {
    const image = await decode(
      new Blob([page.data as BlobPart], { type: page.mime }),
      page.dpi
    );
    const done = await client.processPage(image, imageSettings(plan, flip), {
      transfer: true,
    });
    const { width, height, dpi } = done;
    const blank = plan.blankSensitivity !== null && done.blank;
    if (done.kind === 'bw') {
      const c = canvas(1, 1);
      const small = bitmapData(done.bitmap, Math.max(1, width / THUMB));
      c.width = small.width;
      c.height = small.height;
      c.getContext('2d')!.putImageData(small, 0, 0);
      return {
        kind: 'bw',
        width,
        height,
        dpi,
        blank,
        image: null,
        bitmap: done.bitmap,
        thumb: await toBlob(c),
      };
    }
    const full = canvas(width, height);
    full.getContext('2d')!.putImageData(imageData(done.image), 0, 0);
    const png = await toBlob(full);
    const scale = Math.min(1, THUMB / width);
    const small = canvas(
      Math.max(1, Math.round(width * scale)),
      Math.max(1, Math.round(height * scale))
    );
    small.getContext('2d')!.drawImage(full, 0, 0, small.width, small.height);
    full.width = full.height = 0;
    return {
      kind: done.kind,
      width,
      height,
      dpi,
      blank,
      image: png,
      bitmap: null,
      thumb: await toBlob(small, 'image/jpeg'),
    };
  }

  /** Where the document lies on a preview of the glass, in inches from
   *  the glass's corner (null: nothing stands out) */
  async function findDocument(preview: ScanImage): Promise<Rect | null> {
    const r = await client.detectDocument(preview);
    if (r.width >= preview.width && r.height >= preview.height) return null;
    const round = (v: number) => Math.round(v * 100) / 100;
    const dpi = preview.dpi;
    return {
      x: round(r.x / dpi),
      y: round(r.y / dpi),
      width: round(r.width / dpi),
      height: round(r.height / dpi),
    };
  }

  /** The preview as the pages will come out: their color mode, threshold,
   *  brightness, contrast and invert (Autodetect shows it as it is) */
  async function look(
    preview: ScanImage,
    plan: Pick<ProcessPlan, 'color' | 'threshold' | 'brightness' | 'contrast' | 'invert'>
  ): Promise<ImageData> {
    const done = await client.processPage(preview, {
      colorMode: plan.color === 'auto' ? 'color' : plan.color,
      threshold: plan.color === 'bw' ? plan.threshold : null,
      brightness: plan.brightness,
      contrast: plan.contrast,
      invert: plan.invert,
      deskew: false,
    });
    return done.kind === 'bw' ? bitmapData(done.bitmap, 1) : imageData(done.image);
  }

  return {
    process,
    findDocument,
    look,
    /** The worker, for Enhance scanned pages */
    client,
    dispose: () => client.dispose(),
  };
}

export type PageProcessor = ReturnType<typeof createPageProcessor>;

/** A cleaned-up page in the PDF's encoding, at the chosen file size */
export async function encodePage(
  page: ProcessedPage,
  s: Pick<ScanSettings, 'quality' | 'compression'>
): Promise<EncodedPage> {
  const info = {
    width: page.width,
    height: page.height,
    dpi: page.dpi,
    blank: page.blank,
    rotation: 0 as const,
    skew: 0,
    crop: null as Rect | null,
  };
  if (page.kind === 'bw' && page.bitmap)
    return encodeScanPage({ ...info, kind: 'bw', bitmap: page.bitmap }, opts(s));
  const rgba = await decode(page.image!, page.dpi);
  // Gray pages as one channel (smaller lossless files)
  const image: ScanImage =
    page.kind === 'gray'
      ? {
          ...rgba,
          channels: 1,
          data: Uint8Array.from(
            { length: rgba.width * rgba.height },
            (_, i) => rgba.data[i * 4]
          ),
        }
      : rgba;
  return encodeScanPage(
    {
      ...info,
      width: rgba.width,
      height: rgba.height,
      kind: page.kind === 'gray' ? 'gray' : 'color',
      image,
    },
    opts(s)
  );
}

/** JPEG quality from the Small size ↔ High quality slider */
export const jpegQuality = (q: number) =>
  0.3 + Math.min(1, Math.max(0, q)) * 0.65;

const opts = (s: Pick<ScanSettings, 'quality' | 'compression'>) => ({
  compression: s.compression === 'zip' ? ('flate' as const) : ('jpeg' as const),
  quality: jpegQuality(s.quality),
});

/** A page of the PDF: a scanned image, or a page of a PDF a scanner's app
 *  saved (Import from a scanner app), copied as it is */
export type PdfPart =
  | { kind: 'image'; page: EncodedPage; rotation: number }
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
    const page = await addScanPage(doc, part.page);
    if (part.rotation) page.setRotation(degrees(part.rotation % 360));
  }
  return doc.save();
}
