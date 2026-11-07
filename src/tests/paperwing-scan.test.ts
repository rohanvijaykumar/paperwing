import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  BUILTIN_PRESETS,
  buildRequest,
  chooseDevice,
  cleanSettings,
  colorChoices,
  defaultAfterPass,
  defaultPaper,
  defaultSettings,
  fileNames,
  insertAfter,
  interleave,
  nearestResolution,
  offeredResolutions,
  paperChoices,
  scanName,
  settingsSummary,
  splitIntoFiles,
  startingSettings,
  visibility,
  type ScanSettings,
} from '../acro/scan-settings';
import { buildPdf, looksBlank, looksGray } from '../acro/scan-process';
import { scanErrorMessage } from '../acro/scan';
import type { ScanCaps, ScanDevice, ScanSource } from '../acro/desktop';

const range = (min: number, max: number, step = 1, def = 0) => ({
  min,
  max,
  step,
  default: def,
});

const flatbed: ScanSource = {
  id: 'flatbed',
  duplex: false,
  resolutions: [75, 150, 300, 600, 1200],
  resolutionRange: null,
  colors: ['color', 'gray', 'bw'],
  maxWidth: 8.5,
  maxHeight: 11.69,
  minWidth: 0,
  minHeight: 0,
  canPreview: true,
  paperSizes: [],
  autoSize: true,
  autoDeskew: false,
  autoCrop: false,
  blankPageSkip: false,
  doubleFeed: false,
  invert: true,
  brightness: range(-1000, 1000, 1, 0),
  contrast: null,
  threshold: range(0, 100, 1, 50),
  feederLoaded: null,
};
const feeder: ScanSource = {
  ...flatbed,
  id: 'feeder',
  duplex: false,
  resolutions: [100, 150, 200, 300, 400, 600],
  resolutionRange: range(100, 600, 50, 300),
  colors: ['gray'],
  maxHeight: 14,
  canPreview: false,
  autoSize: false,
  autoDeskew: true,
  blankPageSkip: true,
  doubleFeed: true,
  invert: false,
  brightness: null,
  threshold: null,
};
const caps = (driver: ScanCaps['driver'], ...sources: ScanSource[]): ScanCaps => ({
  driver,
  nativeUi: driver === 'twain',
  sources,
});
const device = (driver: ScanDevice['driver']): ScanDevice => ({
  id: `${driver}:x`,
  driver,
  label: driver,
  name: 'X',
});
const settings = (patch: Partial<ScanSettings> = {}): ScanSettings => ({
  ...defaultSettings('en-US'),
  ...patch,
});

// A 2×1 white PNG
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAC0lEQVR4nGP4DwYAFPIF+6QNfF4AAAAASUVORK5CYII='
  ),
  (c) => c.charCodeAt(0)
);

describe('which settings a scanner shows', () => {
  it('a flatbed and feeder: Source; Pages only for the feeder', () => {
    const c = caps('twain', flatbed, feeder);
    const devs = [device('twain'), device('wia')];
    let v = visibility(c, flatbed, settings(), devs);
    expect(v.source).toBe(true);
    expect(v.sides).toBe(false);
    expect(v.preview).toBe(true);
    expect(v.driver).toBe(true);
    expect(v.nativeUi).toBe(true);
    expect(v.transfer).toBe(true);
    v = visibility(c, feeder, settings({ source: 'feeder', sides: 'both' }), devs);
    expect(v.sides).toBe(true);
    expect(v.flipBacks).toBe(true);
    expect(v.preview).toBe(false);
    expect(v.doubleFeedStop).toBe(true);
    expect(v.customDpi).toBe(true);
  });

  it('a network scanner: its timeout, no TWAIN options, one driver', () => {
    const v = visibility(caps('escl', flatbed), flatbed, settings(), [device('escl')]);
    expect(v.source).toBe(false);
    expect(v.networkTimeout).toBe(true);
    expect(v.transfer).toBe(false);
    expect(v.nativeUi).toBe(false);
    expect(v.driver).toBe(false);
  });

  it('threshold with black and white; size fields with a custom size', () => {
    expect(visibility(null, flatbed, settings({ color: 'bw' }), []).threshold).toBe(true);
    expect(visibility(null, flatbed, settings({ color: 'gray' }), []).threshold).toBe(false);
    expect(visibility(null, flatbed, settings({ paper: 'custom' }), []).customSize).toBe(true);
    expect(visibility(null, flatbed, settings({ paper: 'card' }), []).orientation).toBe(true);
  });

  it('color modes: Autodetect needs color; black and white always', () => {
    expect(colorChoices(flatbed)).toEqual(['auto', 'color', 'gray', 'bw']);
    // (made black and white after the scan)
    expect(colorChoices(feeder)).toEqual(['gray', 'bw']);
  });

  it('paper sizes that fit, auto if it can, the preview box once drawn', () => {
    const fb = paperChoices(flatbed, false).map(([k]) => k);
    expect(fb).toContain('auto');
    expect(fb).toContain('letter');
    expect(fb).toContain('a4'); // 8.27 × 11.69 on an 8.5 × 11.69 glass
    expect(fb).not.toContain('legal');
    expect(fb).not.toContain('tabloid');
    expect(fb.slice(-2)).toEqual(['max', 'custom']);
    const fd = paperChoices(feeder, true).map(([k]) => k);
    expect(fd[0]).toBe('preview');
    expect(fd).toContain('legal');
    expect(fd).not.toContain('auto');
  });

  it('resolutions: the usual ones it has; the nearest to what was wanted', () => {
    expect(offeredResolutions(flatbed)).toEqual([75, 150, 300, 600, 1200]);
    expect(offeredResolutions(undefined)).toEqual([150, 200, 300, 600]);
    expect(nearestResolution([150, 300, 600], 400)).toBe(300);
    expect(nearestResolution([150, 300, 600], 500)).toBe(600);
  });

  it('a driver choice picks that device, else the best', () => {
    const devs = [device('twain'), device('wia'), device('escl')];
    expect(chooseDevice(devs, 'auto')?.driver).toBe('twain');
    expect(chooseDevice(devs, 'escl')?.driver).toBe('escl');
    expect(chooseDevice(devs, 'ica')?.driver).toBe('twain');
  });
});

describe('the request, and what is done afterwards', () => {
  it('the scanner does what it can; the rest is done after the scan', () => {
    const { request, plan } = buildRequest(
      settings({ color: 'bw', threshold: 102, brightness: 50, contrast: 20, invert: true }),
      caps('twain', flatbed),
      flatbed,
      null
    );
    expect(request).toMatchObject({
      source: 'flatbed',
      duplex: false,
      color: 'bw',
      dpi: 300,
      paper: { width: 8.5, height: 11 },
      brightness: 500, // 50% of the way to its maximum
      threshold: 40, // 102 of 255 on its 0-100 scale
      invert: true,
      transfer: 'native',
    });
    expect(request.contrast).toBeUndefined();
    expect(plan.contrast).toBe(20); // no contrast on this scanner
    expect(plan.brightness).toBe(0);
    expect(plan.threshold).toBeNull();
    expect(plan.deskew).toBe(true);
  });

  it('black and white from a scanner without it: gray, then made so', () => {
    const { request, plan } = buildRequest(
      settings({ source: 'feeder', color: 'bw', threshold: 140, invert: true, sides: 'both' }),
      caps('twain32', feeder),
      feeder,
      null
    );
    expect(request.color).toBe('gray');
    expect(request.duplex).toBe(false); // one-sided feeder: Scan reverse sides
    expect(plan.threshold).toBe(140);
    expect(plan.invert).toBe(true);
    // The feeder straightens pages itself, and skips blank ones
    expect(request.autoDeskew).toBe(true);
    expect(plan.deskew).toBe(false);
    expect(request.doubleFeedStop).toBe(true);
  });

  it('Autodetect scans in color and decides per page', () => {
    const { request, plan } = buildRequest(settings(), caps('wia', flatbed), flatbed, null);
    expect(request.color).toBe('color');
    expect(plan.color).toBe('auto');
  });

  it('a box from the preview is the area; auto size if the scanner can', () => {
    const box = { x: 1, y: 1.2, width: 6.3, height: 8 };
    expect(
      buildRequest(settings({ paper: 'preview' }), null, flatbed, box).request.area
    ).toEqual(box);
    expect(buildRequest(settings({ paper: 'auto' }), null, flatbed, null).request.paper).toBe('auto');
    // A scanner that can't: the whole area, cropped afterwards
    const r = buildRequest(settings({ paper: 'auto' }), null, feeder, null);
    expect(r.request.paper).toEqual({ width: 8.5, height: 14 });
    expect(r.plan.autoCrop).toBe(true);
  });

  it('landscape and custom sizes; never bigger than the glass', () => {
    expect(
      buildRequest(settings({ paper: 'a5', orientation: 'landscape' }), null, flatbed, null).request.paper
    ).toEqual({ width: 8.27, height: 5.83 });
    expect(
      buildRequest(settings({ paper: 'custom', customWidth: 20, customHeight: 4 }), null, flatbed, null).request.paper
    ).toEqual({ width: 8.5, height: 4 });
  });

  it('network scanners get their timeout; blank pages are looked for', () => {
    const { request, plan } = buildRequest(
      settings({ networkTimeout: 120, removeBlank: true, blankSensitivity: 30 }),
      caps('escl', flatbed),
      flatbed,
      null
    );
    expect(request.timeout).toBe(120);
    expect(plan.blankSensitivity).toBe(30);
    expect(request.transfer).toBeUndefined();
  });
});

describe('presets and what is remembered', () => {
  it("Acrobat's presets, My settings first", () => {
    expect(BUILTIN_PRESETS.map((p) => p.label)).toEqual([
      'My settings',
      'Autodetect color mode',
      'Black and white document',
      'Grayscale document',
      'Color document',
      'Color photograph',
    ]);
  });

  it('a preset, its saved changes, this scanner and the output choices', () => {
    const bw = BUILTIN_PRESETS.find((p) => p.id === 'bw')!;
    const s = startingSettings('en-GB', bw, {
      preset: { dpi: 400, despeckle: false, driver: 'wia' },
      scanner: { driver: 'escl', paper: 'legal', dpi: 75 },
      output: { output: 'multiple', perFile: 2, color: 'color' },
    });
    expect(s.color).toBe('bw');
    expect(s.dpi).toBe(400); // the preset's own change
    expect(s.despeckle).toBe(false);
    expect(s.driver).toBe('escl'); // per scanner, not per preset
    expect(s.paper).toBe('legal');
    expect(s.output).toBe('multiple');
    expect(s.perFile).toBe(2);
  });

  it('anything odd read back is dropped', () => {
    expect(
      cleanSettings({
        color: 'sepia',
        dpi: 300.5,
        rotate: 45,
        paper: 'preview',
        prefix: 'x'.repeat(500),
        ocrLanguage: 'eng+deu',
        background: 'high',
        quality: 2,
      })
    ).toEqual({ ocrLanguage: 'eng+deu', background: 'high' });
    expect(cleanSettings(null)).toEqual({});
  });

  it('a summary line like Acrobat’s', () => {
    expect(settingsSummary(settings({ color: 'gray', source: 'feeder', sides: 'both' }))).toBe(
      'Grayscale, Letter, 300 dpi, Both sides'
    );
    expect(settingsSummary(settings({ paper: 'preview' }))).toBe('Autodetect, From preview, 300 dpi');
  });

  it('after a pass the last choice is offered first, not always "complete"', () => {
    expect(defaultAfterPass(undefined, true)).toBe('more');
    expect(defaultAfterPass('done', true)).toBe('done');
    expect(defaultAfterPass('reverse', true)).toBe('reverse');
    expect(defaultAfterPass('reverse', false)).toBe('more');
  });
});

describe('after the scan', () => {
  it('Scan reverse sides weaves the backs (last page first) in after their fronts', () => {
    expect(interleave([1, 3, 5], [6, 4, 2])).toEqual([1, 2, 3, 4, 5, 6]);
    expect(interleave([1, 3, 5], [4, 2])).toEqual([1, 2, 3, 4, 5]);
    expect(interleave([], [2])).toEqual([2]);
  });

  it('Save multiple files: pages per file, the last one short', () => {
    expect(splitIntoFiles(5, 2)).toEqual([[0, 1], [2, 3], [4]]);
    expect(splitIntoFiles(3, 1)).toEqual([[0], [1], [2]]);
    expect(splitIntoFiles(2, 0)).toEqual([[0], [1]]);
    expect(fileNames('Invoice', 3)).toEqual(['Invoice 1.pdf', 'Invoice 2.pdf', 'Invoice 3.pdf']);
    expect(fileNames(' ', 12)[0]).toBe('Scan 01.pdf');
  });

  it('Insert pages: before or after the first, last or nth page', () => {
    expect(insertAfter({ position: 'before', page: 'first', number: 1 }, 10)).toBe(-1);
    expect(insertAfter({ position: 'after', page: 'first', number: 1 }, 10)).toBe(0);
    expect(insertAfter({ position: 'after', page: 'last', number: 1 }, 10)).toBe(9);
    expect(insertAfter({ position: 'before', page: 'last', number: 1 }, 10)).toBe(8);
    expect(insertAfter({ position: 'after', page: 'number', number: 4 }, 10)).toBe(3);
    expect(insertAfter({ position: 'before', page: 'number', number: 4 }, 10)).toBe(2);
    expect(insertAfter({ position: 'after', page: 'number', number: 40 }, 10)).toBe(9);
  });

  it('a new scan is named by when it was made', () => {
    expect(scanName(new Date(2026, 10, 6, 18, 5))).toBe('Scan 2026-11-06 18.05.pdf');
  });

  it('Letter where it is used, A4 elsewhere', () => {
    expect(defaultPaper('en-US')).toBe('letter');
    expect(defaultPaper('fr-CA')).toBe('letter');
    expect(defaultPaper('en-GB')).toBe('a4');
    expect(defaultSettings('de-DE').units).toBe('mm');
  });
});

/** RGBA pixels, `n` of them, colored by index */
const pixels = (color: (k: number) => number[], n: number) => {
  const px = new Uint8ClampedArray(n * 4);
  for (let k = 0; k < n; k++) px.set([...color(k), 255], k * 4);
  return px;
};

describe('pages', () => {
  it('Autodetect: gray unless there is real color', () => {
    expect(looksGray(pixels(() => [200, 200, 200], 7000))).toBe(true);
    expect(looksGray(pixels((k) => (k % 5 ? [200, 200, 200] : [200, 40, 40]), 7000))).toBe(false);
    expect(looksGray(pixels((k) => (k === 700 ? [255, 0, 0] : [240, 240, 240]), 7000))).toBe(true);
  });

  it('blank pages: paper with specks is blank; a page with text is not', () => {
    const w = 200;
    const h = 260;
    const speck = pixels((k) => (k === w * 130 + 100 ? [0, 0, 0] : [250, 250, 250]), w * h);
    expect(looksBlank(speck, w, h, 50)).toBe(true);
    // Lines of "text" in the middle
    const text = pixels((k) => {
      const y = Math.floor(k / w);
      return y % 20 < 3 && y > 40 && y < 200 ? [20, 20, 20] : [250, 250, 250];
    }, w * h);
    expect(looksBlank(text, w, h, 100)).toBe(false);
    // Dark edges (the lid's shadow) don't count
    const shadow = pixels((k) => (k % w < 4 ? [30, 30, 30] : [250, 250, 250]), w * h);
    expect(looksBlank(shadow, w, h, 0)).toBe(true);
  });

  it('the PDF has a page per scan at its real size, and PDF pages as they were', async () => {
    const other = await PDFDocument.create();
    other.addPage([300, 400]);
    other.addPage([500, 200]);
    const otherBytes = await other.save();
    const pdf = await buildPdf([
      { kind: 'image', page: { bytes: PNG, kind: 'png', width: 2, height: 1, dpi: 72, rotation: 0 } },
      // 850 × 1100 px at 100 dpi is a Letter page; turned in review
      { kind: 'image', page: { bytes: PNG, kind: 'png', width: 850, height: 1100, dpi: 100, rotation: 90 } },
      { kind: 'pdf', bytes: otherBytes, index: 1, rotation: 180 },
    ]);
    const doc = await PDFDocument.load(pdf, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getPage(0).getSize()).toEqual({ width: 2, height: 1 });
    const letter = doc.getPage(1).getSize();
    expect(letter.width).toBeCloseTo(612);
    expect(letter.height).toBeCloseTo(792);
    expect(doc.getPage(1).getRotation().angle).toBe(90);
    expect(doc.getPage(2).getSize()).toEqual({ width: 500, height: 200 });
    expect(doc.getPage(2).getRotation().angle).toBe(180);
    expect(doc.getProducer()).toBe('Paperwing');
  });
});

describe('messages', () => {
  it('say what happened and what to do', () => {
    expect(scanErrorMessage('feeder-empty', undefined, false)).toMatch(/feeder is empty/);
    expect(scanErrorMessage('double-feed', undefined, false)).toMatch(/Two sheets/);
    expect(scanErrorMessage('blocked', undefined, false)).toMatch(/IT department/);
    expect(scanErrorMessage('blocked', undefined, true)).toMatch(/Local Network/);
    expect(scanErrorMessage('failed', 'Device error', false)).toBe("The scan didn't work: Device error");
  });
});
