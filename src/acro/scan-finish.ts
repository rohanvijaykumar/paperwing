/**
 * What scanning does after the PDF is made, with the engines the tools
 * use: Recognize text (Tesseract, as Scan & OCR's Select a file does),
 * Auto-rotate pages (which way up the text reads) and Make PDF/A compliant
 * (Ghostscript, as the PDF to PDF/A tool does). Loaded only when used.
 */
import type { OrientationResult, ScanImage } from './scan-image';
import type { TesseractWorker } from '../js/utils/tesseract-runtime';

/** A searchable PDF: the scanned pages with their text under them */
export async function recognizeText(
  pdf: Uint8Array,
  language: string,
  progress: (text: string) => void
): Promise<Uint8Array> {
  // (PDF.js's worker, which OCR reads the pages with)
  await import('../js/utils/setup-pdf-worker.js');
  const { performOcr } = await import('../js/utils/ocr.js');
  const result = await performOcr(pdf, {
    language,
    // Pages drawn at twice their size for Tesseract: scans are already sharp
    resolution: 2,
    binarize: false,
    whitelist: '',
    onProgress: (status, value) =>
      progress(
        /recogni/i.test(status) ? `${Math.round(value * 100)}%` : status
      ),
  });
  return result.pdfBytes;
}

/** The PDF made PDF/A-2b compliant */
export async function makePdfA(
  pdf: Uint8Array,
  progress: (text: string) => void
): Promise<Uint8Array> {
  const { convertToPdfA } = await import('../js/utils/ghostscript-loader.js');
  return convertToPdfA(pdf, 'PDF/A-2b', progress);
}

let reader: Promise<TesseractWorker> | null = null;

/**
 * Which way up a page is: the text read at each quarter turn, the most
 * confident reading wins (by a margin; else it stays as it is). Tesseract's
 * own orientation check needs data the app doesn't ship, and this works
 * with the English it does. On a small copy of the page: quick enough.
 */
export async function detectOrientation(
  page: ScanImage
): Promise<OrientationResult | null> {
  const { createConfiguredTesseractWorker } = await import(
    '../js/utils/tesseract-runtime.js'
  );
  reader ??= createConfiguredTesseractWorker('eng', 1);
  const worker = await reader;
  const scale = Math.min(1, 1200 / Math.max(page.width, page.height));
  const src = document.createElement('canvas');
  src.width = page.width;
  src.height = page.height;
  const img = new ImageData(page.width, page.height);
  for (let i = 0, o = 0; i < page.width * page.height; i++, o += 4) {
    const s = i * page.channels;
    img.data[o] = page.data[s];
    img.data[o + 1] = page.data[page.channels === 1 ? s : s + 1];
    img.data[o + 2] = page.data[page.channels === 1 ? s : s + 2];
    img.data[o + 3] = 255;
  }
  src.getContext('2d')!.putImageData(img, 0, 0);
  const scores: number[] = [];
  for (const turn of [0, 90, 180, 270] as const) {
    const sideways = turn % 180 !== 0;
    const w = Math.round((sideways ? page.height : page.width) * scale);
    const h = Math.round((sideways ? page.width : page.height) * scale);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;
    ctx.translate(w / 2, h / 2);
    ctx.rotate((turn * Math.PI) / 180);
    ctx.drawImage(src, (-page.width * scale) / 2, (-page.height * scale) / 2, page.width * scale, page.height * scale);
    const r = await worker.recognize(c);
    scores.push(r.data.confidence ?? 0);
  }
  const best = scores.indexOf(Math.max(...scores));
  if (best === 0 || scores[best] - scores[0] < 15) return { rotate: 0 };
  return { rotate: ([0, 90, 180, 270] as const)[best] };
}
