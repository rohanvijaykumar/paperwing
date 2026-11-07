/**
 * Reads back the images a PDF draws, decoded by pdf.js (an independent
 * decoder: its CCITT, Flate and JPEG code is not ours). Node only.
 */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

export interface DecodedImage {
  width: number;
  height: number;
  /** one gray value per pixel (0 black, 255 white), whatever pdf.js gave */
  gray: Uint8Array;
}

// pdf.js image kinds (shared/util.js ImageKind)
const GRAYSCALE_1BPP = 1;
const RGB_24BPP = 2;
const RGBA_32BPP = 3;

function toGray(img: {
  width: number;
  height: number;
  kind: number;
  data: Uint8Array | Uint8ClampedArray;
}): Uint8Array {
  const { width, height, kind, data } = img;
  const out = new Uint8Array(width * height);
  if (kind === GRAYSCALE_1BPP) {
    const rowBytes = (width + 7) >> 3;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        out[y * width + x] = bit ? 255 : 0;
      }
  } else {
    const step = kind === RGB_24BPP ? 3 : kind === RGBA_32BPP ? 4 : 0;
    if (!step) throw new Error(`unexpected pdf.js image kind ${kind}`);
    for (let i = 0, o = 0; i < out.length; i++, o += step)
      out[i] = Math.round(
        0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]
      );
  }
  return out;
}

/** Every image drawn on each page, in drawing order */
export async function decodePdfImages(
  pdf: Uint8Array
): Promise<DecodedImage[][]> {
  const task = pdfjs.getDocument({
    data: pdf.slice(),
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    disableFontFace: true,
    verbosity: 0,
  });
  const doc = await task.promise;
  try {
    const pages: DecodedImage[][] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const ops = await page.getOperatorList();
      const images: DecodedImage[] = [];
      for (let i = 0; i < ops.fnArray.length; i++) {
        if (ops.fnArray[i] !== pdfjs.OPS.paintImageXObject) continue;
        const name = ops.argsArray[i][0] as string;
        const objs = name.startsWith('g_') ? page.commonObjs : page.objs;
        const img = await new Promise<{
          width: number;
          height: number;
          kind: number;
          data: Uint8Array;
        }>((resolve) => objs.get(name, resolve));
        images.push({
          width: img.width,
          height: img.height,
          gray: toGray(img),
        });
      }
      pages.push(images);
    }
    return pages;
  } finally {
    await task.destroy();
  }
}
