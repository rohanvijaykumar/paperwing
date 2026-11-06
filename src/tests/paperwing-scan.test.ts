import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  buildPdf,
  defaultPaper,
  interleave,
  looksGray,
  nearestResolution,
  offeredResolutions,
  scanArea,
  scanErrorMessage,
  scanRequest,
  defaultSettings,
} from '../acro/scan';
import type { ScanSource } from '../acro/desktop';

const flatbed: ScanSource = {
  id: 'flatbed',
  duplex: false,
  resolutions: [75, 150, 300, 600, 1200],
  colors: ['color', 'gray', 'bw'],
  width: 8.5,
  height: 11.7,
};
const feeder: ScanSource = {
  id: 'feeder',
  duplex: true,
  resolutions: [150, 200, 300],
  colors: ['gray', 'bw'],
  width: 8.5,
  height: 14,
};

// A 2×1 white PNG
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAC0lEQVR4nGP4DwYAFPIF+6QNfF4AAAAASUVORK5CYII='
  ),
  (c) => c.charCodeAt(0)
);

describe('Scan reverse sides', () => {
  it('weaves the backs (scanned last page first) in after their fronts', () => {
    // A 3-sheet stack: fronts 1, 3, 5; turned over, the backs come 6, 4, 2
    expect(interleave([1, 3, 5], [6, 4, 2])).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it('keeps every page when the stacks differ', () => {
    expect(interleave([1, 3, 5], [4, 2])).toEqual([1, 2, 3, 4, 5]);
    expect(interleave([1], [4, 2])).toEqual([1, 2, 4]);
    expect(interleave([], [2])).toEqual([2]);
  });
});

describe('resolutions', () => {
  it("offers Acrobat's usual ones the scanner has", () => {
    expect(offeredResolutions(flatbed)).toEqual([150, 300, 600]);
    expect(offeredResolutions(feeder)).toEqual([150, 200, 300]);
  });
  it('falls back to what it has, or the usual set', () => {
    expect(
      offeredResolutions({ ...flatbed, resolutions: [100, 1200] })
    ).toEqual([100, 1200]);
    expect(offeredResolutions(undefined)).toEqual([150, 200, 300, 400, 600]);
  });
  it('chooses the nearest one offered', () => {
    expect(nearestResolution([150, 300, 600], 400)).toBe(300);
    expect(nearestResolution([150, 300, 600], 500)).toBe(600);
    expect(nearestResolution([], 300)).toBe(300);
  });
});

describe('the area to scan', () => {
  it('is the paper, within what the source can scan', () => {
    expect(scanArea('letter', flatbed)).toEqual({ width: 8.5, height: 11 });
    // Legal is longer than this flatbed
    expect(scanArea('legal', flatbed)).toEqual({ width: 8.5, height: 11.7 });
    expect(scanArea('legal', feeder)).toEqual({ width: 8.5, height: 14 });
  });
  it('or the whole area', () => {
    expect(scanArea('max', feeder)).toEqual({ width: 8.5, height: 14 });
  });
});

describe('the request', () => {
  const s = { ...defaultSettings(), dpi: 300, paper: 'a4' as const };
  it('scans Autodetect in color, deciding gray page by page later', () => {
    expect(scanRequest({ ...s, color: 'auto' }, flatbed).color).toBe('color');
    // A scanner without color: gray
    expect(scanRequest({ ...s, color: 'auto' }, feeder).color).toBe('gray');
  });
  it('asks for both sides only from a feeder that can', () => {
    expect(
      scanRequest({ ...s, source: 'feeder', duplex: true }, feeder).duplex
    ).toBe(true);
    expect(
      scanRequest(
        { ...s, source: 'feeder', duplex: true },
        { ...feeder, duplex: false }
      ).duplex
    ).toBe(false);
    expect(
      scanRequest({ ...s, source: 'flatbed', duplex: true }, flatbed).duplex
    ).toBe(false);
  });
  it('carries the paper and resolution', () => {
    expect(scanRequest(s, flatbed)).toMatchObject({
      source: 'flatbed',
      dpi: 300,
      width: 8.27,
      height: 11.69,
    });
  });
});

describe('Autodetect', () => {
  const page = (rgb: (k: number) => [number, number, number], n = 2000) => {
    const px = new Uint8ClampedArray(n * 4);
    for (let k = 0; k < n; k++) {
      const [r, g, b] = rgb(k);
      px.set([r, g, b, 255], k * 4);
    }
    return px;
  };
  it('keeps a black-and-white or gray page gray', () => {
    expect(
      looksGray(page((k) => (k % 3 ? [250, 250, 250] : [20, 22, 21])))
    ).toBe(true);
  });
  it('keeps a page with color in color', () => {
    expect(
      looksGray(page((k) => (k % 5 ? [255, 255, 255] : [200, 40, 30])))
    ).toBe(false);
  });
  it('ignores a few colored specks (scanner noise)', () => {
    expect(
      looksGray(page((k) => (k === 700 ? [255, 0, 0] : [240, 240, 240]), 7000))
    ).toBe(true);
  });
});

describe('the PDF', () => {
  it('has one page per scan, at its real size', async () => {
    const pdf = await buildPdf([
      { bytes: PNG, kind: 'png', width: 2, height: 1, dpi: 72 },
      // 850 × 1100 px at 100 dpi is a Letter page
      { bytes: PNG, kind: 'png', width: 850, height: 1100, dpi: 100 },
    ]);
    const doc = await PDFDocument.load(pdf, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getPage(0).getSize()).toEqual({ width: 2, height: 1 });
    const letter = doc.getPage(1).getSize();
    expect(letter.width).toBeCloseTo(612);
    expect(letter.height).toBeCloseTo(792);
    expect(doc.getProducer()).toBe('Paperwing');
  });
});

describe('paper and messages', () => {
  it('starts with Letter where it is used, A4 elsewhere', () => {
    expect(defaultPaper('en-US')).toBe('letter');
    expect(defaultPaper('fr-CA')).toBe('letter');
    expect(defaultPaper('en-GB')).toBe('a4');
    expect(defaultPaper('de-DE')).toBe('a4');
  });
  it('says what to do about a failed scan', () => {
    expect(scanErrorMessage('feeder-empty')).toMatch(/feeder is empty/);
    expect(scanErrorMessage('paper-jam')).toMatch(/jammed/);
    expect(scanErrorMessage('failed', 'Device error')).toBe(
      "The scan didn't work: Device error"
    );
  });
});
