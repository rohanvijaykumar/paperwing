// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName, PDFRawStream, degrees } from 'pdf-lib';
import {
  addScanPage,
  buildScanPdf,
  encodePage,
  enhancePdfPages,
  pageImageDpi,
  pngPredict,
  type EncodedPage,
  type JpegEncoder,
} from '../acro/scan-pdf';
import { encodeG4, bitmapRowBytes } from '../acro/scan-g4';
import { buildPdf } from '../acro/scan-process';
import type { ProcessedPage, ScanImage } from '../acro/scan-image';
import { decodePdfImages } from './helpers/pdf-images';
import {
  addNoise,
  drawText,
  gray,
  rect,
  textLayout,
} from './helpers/scan-synth';

// A 16x8 JPEG (gray gradient), made once with a canvas
const JPEG = Uint8Array.from(
  atob(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAIABADASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAAAAcI/8QAFxABAAMAAAAAAAAAAAAAAAAAAAdDgf/EABQBAQAAAAAAAAAAAAAAAAAAAAD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCPxtVjVcbVYAP/2Q=='
  ),
  (c) => c.charCodeAt(0)
);

function grayImage(
  w: number,
  h: number,
  dpi: number,
  f: (x: number, y: number) => number
): ScanImage {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) data[y * w + x] = f(x, y);
  return { width: w, height: h, channels: 1, data, dpi };
}

const info = { blank: false, rotation: 0 as const, skew: 0, crop: null as null };

describe('buildScanPdf', () => {
  it('makes one page per image, sized from its resolution', async () => {
    const bw = {
      width: 170,
      height: 220,
      data: new Uint8Array(bitmapRowBytes(170) * 220),
    };
    const pages: EncodedPage[] = [
      { kind: 'g4', bytes: encodeG4(bw), width: 170, height: 220, dpi: 20 },
      { kind: 'jpg', bytes: JPEG, width: 16, height: 8, dpi: 2 },
    ];
    const pdf = await buildScanPdf(pages);
    const doc = await PDFDocument.load(pdf, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    expect(doc.getPage(1).getSize()).toEqual({ width: 576, height: 288 });
    expect(doc.getProducer()).toBe('Paperwing');
    // pdf-lib didn't name itself
    expect(new TextDecoder().decode(pdf)).not.toContain('pdf-lib');
  });

  it("the scan dialog's buildPdf takes the new kinds", async () => {
    const bw = {
      width: 9,
      height: 9,
      data: new Uint8Array(bitmapRowBytes(9) * 9).fill(0xff),
    };
    const pdf = await buildPdf([
      {
        kind: 'image',
        page: { kind: 'g4', bytes: encodeG4(bw), width: 9, height: 9, dpi: 72 },
        rotation: 0,
      },
    ]);
    const [[img]] = await decodePdfImages(pdf);
    expect(img.gray.every((v) => v === 0)).toBe(true);
  });

  it('embeds CCITT G4 with the right parameters', async () => {
    const bw = {
      width: 33,
      height: 7,
      data: new Uint8Array(bitmapRowBytes(33) * 7),
    };
    const doc = await PDFDocument.create();
    await addScanPage(doc, {
      kind: 'g4',
      bytes: encodeG4(bw),
      width: 33,
      height: 7,
      dpi: 72,
    });
    const reloaded = await PDFDocument.load(await doc.save());
    const streams = reloaded.context
      .enumerateIndirectObjects()
      .map(([, o]) => o)
      .filter(
        (o): o is PDFRawStream =>
          o instanceof PDFRawStream &&
          o.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')
      );
    expect(streams).toHaveLength(1);
    const d = streams[0].dict;
    expect(d.get(PDFName.of('Filter'))).toBe(PDFName.of('CCITTFaxDecode'));
    expect(String(d.get(PDFName.of('DecodeParms')))).toMatch(
      /\/K -1[\s\S]*\/Columns 33[\s\S]*\/Rows 7/
    );
    expect(String(d.get(PDFName.of('BitsPerComponent')))).toBe('1');
  });
});

describe('encodePage', () => {
  const gradient = grayImage(61, 37, 100, (x, y) => (x * 4 + y * 3) & 255);

  it('Flate is lossless for gray and color (decoded by pdf.js)', async () => {
    const color: ScanImage = {
      width: 23,
      height: 19,
      channels: 4,
      data: Uint8ClampedArray.from({ length: 23 * 19 * 4 }, (_, i) =>
        i % 4 === 3 ? 255 : (i * 37) & 255
      ),
      dpi: 100,
    };
    for (const image of [gradient, color]) {
      const page: ProcessedPage = {
        ...info,
        kind: image.channels === 1 ? 'gray' : 'color',
        image,
        width: image.width,
        height: image.height,
        dpi: 100,
      };
      const enc = await encodePage(page, {
        compression: 'flate',
        quality: 0.5,
      });
      expect(enc.kind).toBe('flate');
      const [[img]] = await decodePdfImages(await buildScanPdf([enc]));
      expect([img.width, img.height]).toEqual([image.width, image.height]);
      for (let i = 0; i < image.width * image.height; i++) {
        const o = i * image.channels;
        const want =
          image.channels === 1
            ? image.data[o]
            : Math.round(
                0.299 * image.data[o] +
                  0.587 * image.data[o + 1] +
                  0.114 * image.data[o + 2]
              );
        expect(Math.abs(img.gray[i] - want)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('predicts each row with a PNG filter', () => {
    const rows = pngPredict(gradient.data, 61, 37, 1, 1);
    expect(rows.length).toBe(62 * 37);
    for (let y = 0; y < 37; y++) expect([0, 1, 2, 4]).toContain(rows[y * 62]);
  });

  it('JPEG goes through the encoder with RGBA pixels and the quality', async () => {
    const jpeg = vi.fn<JpegEncoder>(async () => JPEG);
    const page: ProcessedPage = {
      ...info,
      kind: 'gray',
      image: gradient,
      width: 61,
      height: 37,
      dpi: 100,
    };
    const enc = await encodePage(
      page,
      { compression: 'jpeg', quality: 0.6 },
      jpeg
    );
    expect(enc).toMatchObject({ kind: 'jpg', width: 61, height: 37, dpi: 100 });
    const [rgba, w, h, q] = jpeg.mock.calls[0];
    expect([rgba.length, w, h, q]).toEqual([61 * 37 * 4, 61, 37, 0.6]);
    expect([rgba[4], rgba[5], rgba[6], rgba[7]]).toEqual([4, 4, 4, 255]);
  });

  it('black and white is always CCITT G4', async () => {
    const bitmap = { width: 10, height: 3, data: new Uint8Array(6) };
    const page: ProcessedPage = {
      ...info,
      kind: 'bw',
      bitmap,
      width: 10,
      height: 3,
      dpi: 300,
    };
    expect(
      (await encodePage(page, { compression: 'flate', quality: 1 })).kind
    ).toBe('g4');
  });
});

describe('Enhance scanned pages', () => {
  const DPI = 100;
  /** a crooked page of text, as a scanner made it */
  function scanned(deg: number) {
    const img = gray(850, 1100, DPI, 236);
    drawText(img, textLayout(2550, 3300).inkAt, { deg });
    addNoise(img, 5);
    return img;
  }
  async function scannedPdf(images: ScanImage[], rotate = 0) {
    const doc = await PDFDocument.create();
    for (const im of images) {
      const page = await encodePage(
        {
          ...info,
          kind: 'gray',
          image: im,
          width: im.width,
          height: im.height,
          dpi: DPI,
        },
        { compression: 'flate', quality: 1 }
      );
      const p = await addScanPage(doc, page);
      p.setRotation(degrees(rotate));
    }
    return doc.save();
  }

  it('cleans each page in place and drops blank ones', async () => {
    const page1 = scanned(2.5);
    const blank = gray(850, 1100, DPI, 240);
    addNoise(blank, 4);
    const pdf = await scannedPdf([page1, blank]);
    const render = vi.fn(async (i: number, dpi: number) => {
      expect(dpi).toBe(DPI);
      return i === 0 ? page1 : blank;
    });
    const progress = vi.fn();
    const result = await enhancePdfPages(
      pdf,
      {
        colorMode: 'gray',
        deskew: true,
        backgroundRemoval: 'medium',
        removeBlank: { enabled: true, sensitivity: 50 },
      },
      render,
      { encode: { compression: 'flate', quality: 1 }, onProgress: progress }
    );
    expect(render).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenLastCalledWith(2, 2);
    expect(result.removed).toEqual([1]);
    expect(Math.abs(result.pages[0].skew - 2.5)).toBeLessThanOrEqual(0.2);
    const doc = await PDFDocument.load(result.pdf);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    const [[img]] = await decodePdfImages(result.pdf);
    // background removed: the corner is white now
    expect(img.gray[5 * img.width + 5]).toBeGreaterThan(250);
  });

  it('keeps the page rotation and adds auto-rotation to it', async () => {
    const img = gray(300, 400, DPI, 240);
    rect(img, 10, 10, 30, 20, 20);
    const pdf = await scannedPdf([img], 90);
    const doc0 = await PDFDocument.load(pdf);
    expect(pageImageDpi(doc0, doc0.getPage(0))).toBe(DPI);
    const result = await enhancePdfPages(
      pdf,
      { colorMode: 'gray', deskew: false, rotate: 90 },
      async () => img,
      {
        encode: { compression: 'flate', quality: 1 },
      }
    );
    const doc = await PDFDocument.load(result.pdf);
    expect(doc.getPage(0).getRotation().angle).toBe(180);
    // the image is drawn turned so it shows upright on the rotated page
    const [[decoded]] = await decodePdfImages(result.pdf);
    expect([decoded.width, decoded.height]).toEqual([400, 300]);
  });

  it('never leaves a document without pages', async () => {
    const blank = gray(200, 260, DPI, 240);
    const pdf = await scannedPdf([blank, blank]);
    const result = await enhancePdfPages(
      pdf,
      { colorMode: 'gray', removeBlank: { enabled: true, sensitivity: 50 } },
      async () => blank,
      {
        encode: { compression: 'flate', quality: 1 },
      }
    );
    expect(result.removed).toEqual([1]);
    expect((await PDFDocument.load(result.pdf)).getPageCount()).toBe(1);
  });
});
