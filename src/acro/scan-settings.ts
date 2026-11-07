/**
 * Scanning's settings and the decisions made from them, without any UI
 * (scan.ts shows them): the presets, which settings a scanner shows (a
 * setting it can't do is hidden, or done after the scan by scan-image.ts),
 * the request the scanner gets and the clean-up done afterwards, Scan
 * reverse sides, splitting into several files, and where inserted pages go.
 */
import type {
  ScanCaps,
  ScanDevice,
  ScanDriver,
  ScanRange,
  ScanRequest,
  ScanSource,
} from './desktop';

export type ColorMode = 'auto' | 'color' | 'gray' | 'bw';
export type Level = 'off' | 'low' | 'medium' | 'high';
export type Output = 'new' | 'append' | 'multiple';
export type AfterPass = 'more' | 'reverse' | 'done';

export interface ScanSettings {
  /* Scanner ▸ Options… (kept per scanner) */
  /** 'auto': the best driver; else a ScanDriver to use */
  driver: 'auto' | ScanDriver;
  nativeUi: boolean;
  transfer: 'native' | 'memory';
  invert: boolean;
  doubleFeedStop: boolean;
  /** Seconds a network scanner gets */
  networkTimeout: number;
  /* Pages (source and paper kept per scanner) */
  source: 'flatbed' | 'feeder';
  sides: 'front' | 'both';
  /** Backs upside down (bound at the top, like a calendar) */
  flipBacks: boolean;
  /* Image */
  color: ColorMode;
  /** Black and white: darker than this is black (0-255) */
  threshold: number;
  dpi: number;
  /** A PAPERS key, 'auto', 'max' (the whole glass), 'custom' or 'preview' */
  paper: string;
  customWidth: number;
  customHeight: number;
  units: 'in' | 'mm';
  orientation: 'portrait' | 'landscape';
  /** -100 to 100 */
  brightness: number;
  contrast: number;
  /* Clean-up */
  deskew: boolean;
  autoCrop: boolean;
  background: Level;
  descreen: boolean;
  sharpen: Level;
  despeckle: boolean;
  removeBlank: boolean;
  /** 0 (only truly empty pages) to 100 (pages with a little on them) */
  blankSensitivity: number;
  edgeShadow: boolean;
  autoRotate: boolean;
  rotate: 0 | 90 | 180 | 270;
  /* File size */
  /** 0 (small) to 1 (high quality) */
  quality: number;
  /** Color and grayscale pages (black and white: always CCITT Group 4) */
  compression: 'jpeg' | 'zip';
  /** Open Compress a PDF on the new document (Acrobat's adaptive
   *  compression isn't here: this is the plan's way to smaller files) */
  compressAfter: boolean;
  /* Output (kept for every preset) */
  output: Output;
  perFile: number;
  prefix: string;
  promptMore: boolean;
  ocr: boolean;
  ocrLanguage: string;
  pdfa: boolean;
  metadata: boolean;
}

/** Paper sizes, in inches (portrait) */
export const PAPERS: Record<
  string,
  { label: string; width: number; height: number }
> = {
  letter: { label: 'Letter', width: 8.5, height: 11 },
  legal: { label: 'Legal', width: 8.5, height: 14 },
  tabloid: { label: 'Tabloid', width: 11, height: 17 },
  a3: { label: 'A3', width: 11.69, height: 16.54 },
  a4: { label: 'A4', width: 8.27, height: 11.69 },
  a5: { label: 'A5', width: 5.83, height: 8.27 },
  a6: { label: 'A6', width: 4.13, height: 5.83 },
  b5: { label: 'B5', width: 6.93, height: 9.84 },
  executive: { label: 'Executive', width: 7.25, height: 10.5 },
  card: { label: 'Business card', width: 3.5, height: 2 },
  photo4x6: { label: 'Photo 4 × 6 in', width: 4, height: 6 },
  photo5x7: { label: 'Photo 5 × 7 in', width: 5, height: 7 },
};

export const SCANNER_KEYS = [
  'driver',
  'nativeUi',
  'transfer',
  'invert',
  'doubleFeedStop',
  'networkTimeout',
  'source',
  'paper',
  'customWidth',
  'customHeight',
  'units',
  'orientation',
] as const satisfies readonly (keyof ScanSettings)[];

export const OUTPUT_KEYS = [
  'output',
  'perFile',
  'prefix',
  'promptMore',
  'pdfa',
  'metadata',
] as const satisfies readonly (keyof ScanSettings)[];

/** Letter where it's used, A4 everywhere else */
export function defaultPaper(locale: string): 'letter' | 'a4' {
  return /^(en-US|en-CA|es-MX|es-US|fr-CA)$|-(US|CA|MX|PH|CL|CO|VE|GT|PR)$/i.test(
    locale
  )
    ? 'letter'
    : 'a4';
}

export function defaultSettings(locale = 'en-US'): ScanSettings {
  return {
    driver: 'auto',
    nativeUi: false,
    transfer: 'native',
    invert: false,
    doubleFeedStop: true,
    networkTimeout: 180,
    source: 'flatbed',
    sides: 'front',
    flipBacks: false,
    color: 'auto',
    threshold: 128,
    dpi: 300,
    paper: defaultPaper(locale),
    customWidth: defaultPaper(locale) === 'letter' ? 8.5 : 8.27,
    customHeight: defaultPaper(locale) === 'letter' ? 11 : 11.69,
    units: defaultPaper(locale) === 'letter' ? 'in' : 'mm',
    orientation: 'portrait',
    brightness: 0,
    contrast: 0,
    // Acrobat straightens pages unless told not to
    deskew: true,
    autoCrop: false,
    background: 'off',
    descreen: false,
    sharpen: 'off',
    despeckle: false,
    removeBlank: false,
    blankSensitivity: 50,
    edgeShadow: false,
    autoRotate: false,
    rotate: 0,
    quality: 0.6,
    compression: 'jpeg',
    compressAfter: false,
    output: 'new',
    perFile: 1,
    prefix: 'Scan',
    promptMore: true,
    ocr: false,
    ocrLanguage: 'eng',
    pdfa: false,
    metadata: false,
  };
}

export interface Preset {
  id: string;
  label: string;
  /** Applied over the defaults */
  settings: Partial<ScanSettings>;
}

/** Acrobat's presets, and "My settings" (Acrobat's Default settings) */
export const BUILTIN_PRESETS: Preset[] = [
  { id: 'mine', label: 'My settings', settings: {} },
  { id: 'auto', label: 'Autodetect color mode', settings: { color: 'auto' } },
  {
    id: 'bw',
    label: 'Black and white document',
    settings: { color: 'bw', dpi: 300, despeckle: true },
  },
  {
    id: 'gray',
    label: 'Grayscale document',
    settings: { color: 'gray', dpi: 300, background: 'low' },
  },
  {
    id: 'color',
    label: 'Color document',
    settings: { color: 'color', dpi: 300, quality: 0.6 },
  },
  {
    id: 'photo',
    label: 'Color photograph',
    settings: {
      color: 'color',
      dpi: 600,
      quality: 0.9,
      deskew: false,
      compression: 'jpeg',
    },
  },
];

/* Reading saved settings back ----------------------------------------- */

const LEVELS: Level[] = ['off', 'low', 'medium', 'high'];
const DRIVERS: ScanDriver[] = ['twain', 'wia', 'escl', 'twain32', 'wia1', 'ica'];

/** What's valid of something read from storage (anything else is dropped) */
export function cleanSettings(raw: unknown): Partial<ScanSettings> {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<ScanSettings> = {};
  const set = <K extends keyof ScanSettings>(k: K, ok: boolean) => {
    if (ok) out[k] = r[k] as ScanSettings[K];
  };
  const oneOf = (k: string, values: readonly unknown[]) =>
    values.includes(r[k]);
  const bool = (k: string) => typeof r[k] === 'boolean';
  const num = (k: string, min: number, max: number) =>
    typeof r[k] === 'number' &&
    Number.isFinite(r[k]) &&
    (r[k] as number) >= min &&
    (r[k] as number) <= max;
  set('driver', oneOf('driver', ['auto', ...DRIVERS]));
  for (const k of [
    'nativeUi',
    'invert',
    'doubleFeedStop',
    'flipBacks',
    'deskew',
    'autoCrop',
    'descreen',
    'despeckle',
    'removeBlank',
    'edgeShadow',
    'autoRotate',
    'compressAfter',
    'promptMore',
    'ocr',
    'pdfa',
    'metadata',
  ] as const)
    set(k, bool(k));
  set('transfer', oneOf('transfer', ['native', 'memory']));
  set('networkTimeout', num('networkTimeout', 5, 600) && Number.isInteger(r.networkTimeout));
  set('source', oneOf('source', ['flatbed', 'feeder']));
  set('sides', oneOf('sides', ['front', 'both']));
  set('color', oneOf('color', ['auto', 'color', 'gray', 'bw']));
  set('threshold', num('threshold', 0, 255));
  set('dpi', num('dpi', 25, 4800) && Number.isInteger(r.dpi));
  // ("preview" is a box on this one scan's glass: not kept)
  set(
    'paper',
    typeof r.paper === 'string' &&
      (r.paper in PAPERS || ['auto', 'max', 'custom'].includes(r.paper))
  );
  set('customWidth', num('customWidth', 0.5, 60));
  set('customHeight', num('customHeight', 0.5, 60));
  set('units', oneOf('units', ['in', 'mm']));
  set('orientation', oneOf('orientation', ['portrait', 'landscape']));
  set('brightness', num('brightness', -100, 100));
  set('contrast', num('contrast', -100, 100));
  set('background', oneOf('background', LEVELS));
  set('sharpen', oneOf('sharpen', LEVELS));
  set('blankSensitivity', num('blankSensitivity', 0, 100));
  set('rotate', oneOf('rotate', [0, 90, 180, 270]));
  set('quality', num('quality', 0, 1));
  set('compression', oneOf('compression', ['jpeg', 'zip']));
  set('output', oneOf('output', ['new', 'append', 'multiple']));
  set('perFile', num('perFile', 1, 9999) && Number.isInteger(r.perFile));
  set('prefix', typeof r.prefix === 'string' && r.prefix.length <= 100);
  set(
    'ocrLanguage',
    typeof r.ocrLanguage === 'string' &&
      r.ocrLanguage.length <= 100 &&
      r.ocrLanguage.split('+').every((code) => /^[a-z_]+$/.test(code))
  );
  return out;
}

/** Only these keys of a settings object */
export function pick<K extends keyof ScanSettings>(
  s: Partial<ScanSettings>,
  keys: readonly K[]
): Partial<ScanSettings> {
  const out: Partial<ScanSettings> = {};
  for (const k of keys)
    if (s[k] !== undefined) Object.assign(out, { [k]: s[k] });
  return out;
}

/** Everything but these keys */
export function omit(
  s: Partial<ScanSettings>,
  keys: readonly (keyof ScanSettings)[]
): Partial<ScanSettings> {
  const out = { ...s };
  for (const k of keys) delete out[k];
  return out;
}

/**
 * The settings a scan starts with: the defaults, the preset (with the
 * changes saved to it), what's kept for this scanner, and the output
 * choices kept for all.
 */
export function startingSettings(
  locale: string,
  preset: Preset,
  saved: {
    preset?: unknown;
    scanner?: unknown;
    output?: unknown;
  }
): ScanSettings {
  return {
    ...defaultSettings(locale),
    ...preset.settings,
    ...omit(cleanSettings(saved.preset), [...SCANNER_KEYS, ...OUTPUT_KEYS]),
    ...pick(cleanSettings(saved.scanner), SCANNER_KEYS),
    ...pick(cleanSettings(saved.output), OUTPUT_KEYS),
  };
}

/* What a scanner shows ------------------------------------------------- */

/** The device a driver choice picks (the best when 'auto' or not there) */
export function chooseDevice(
  devices: ScanDevice[],
  driver: ScanSettings['driver']
): ScanDevice | undefined {
  return devices.find((d) => d.driver === driver) ?? devices[0];
}

export const COLOR_LABELS: Record<ColorMode, string> = {
  auto: 'Autodetect',
  color: 'Color',
  gray: 'Grayscale',
  bw: 'Black and white',
};

/** Color modes to offer: Autodetect needs color */
export function colorChoices(source: ScanSource | undefined): ColorMode[] {
  const has = source?.colors ?? ['color', 'gray', 'bw'];
  return [
    ...(has.includes('color') ? (['auto'] as ColorMode[]) : []),
    ...(['color', 'gray', 'bw'] as const).filter((c) => has.includes(c)),
    // Black and white works on any scanner (the page is made so afterwards)
    ...(has.includes('bw') || !has.length ? [] : (['bw'] as ColorMode[])),
  ];
}

/** Resolutions offered when the scanner has them (Acrobat's usual set) */
const USUAL_DPI = [75, 100, 150, 200, 300, 400, 600, 1200];

/** The resolutions to offer: the usual ones it has, else all it has */
export function offeredResolutions(source: ScanSource | undefined): number[] {
  const all = source?.resolutions ?? [];
  if (!all.length) return [150, 200, 300, 600];
  const usual = USUAL_DPI.filter((d) => all.includes(d));
  return usual.length >= 3 ? usual : all;
}

/** The offered resolution nearest the one wanted */
export function nearestResolution(offered: number[], wanted: number): number {
  return offered.reduce(
    (best, d) => (Math.abs(d - wanted) < Math.abs(best - wanted) ? d : best),
    offered[0] ?? wanted
  );
}

/** Paper sizes that fit the glass (or feeder), then auto, the whole area,
 *  custom, and the box drawn on the preview when there is one */
export function paperChoices(
  source: ScanSource | undefined,
  hasPreviewBox: boolean
): [string, string][] {
  const maxW = source?.maxWidth ?? 8.5;
  const maxH = source?.maxHeight ?? 11.69;
  // (a little over is a rounding difference: A4 on an 8.5 × 11.69 glass)
  const fits = (w: number, h: number) =>
    (w <= maxW + 0.05 && h <= maxH + 0.05) ||
    (h <= maxW + 0.05 && w <= maxH + 0.05);
  return [
    ...(hasPreviewBox
      ? ([['preview', 'Custom (from preview)']] as [string, string][])
      : []),
    ...(source?.autoSize
      ? ([['auto', 'Auto-detect']] as [string, string][])
      : []),
    ...Object.entries(PAPERS)
      .filter(([, p]) => fits(p.width, p.height))
      .map(([k, p]) => [k, p.label] as [string, string]),
    ['max', source?.id === 'feeder' ? 'Largest size' : 'Whole glass'],
    ['custom', 'Custom size'],
  ];
}

/** Which settings show (hidden, not greyed out, when there's no point) */
export interface Visibility {
  source: boolean;
  sides: boolean;
  flipBacks: boolean;
  threshold: boolean;
  customDpi: boolean;
  customSize: boolean;
  orientation: boolean;
  preview: boolean;
  /* Options… */
  driver: boolean;
  nativeUi: boolean;
  transfer: boolean;
  doubleFeedStop: boolean;
  networkTimeout: boolean;
  /* Output */
  multiple: boolean;
}

export function visibility(
  caps: ScanCaps | null,
  source: ScanSource | undefined,
  s: ScanSettings,
  devices: ScanDevice[]
): Visibility {
  const driver = caps?.driver;
  return {
    source: (caps?.sources.length ?? 0) > 1,
    // A feeder that scans one side does both through Scan reverse sides
    sides: source?.id === 'feeder',
    flipBacks: source?.id === 'feeder' && s.sides === 'both',
    threshold: s.color === 'bw',
    customDpi: !!source?.resolutionRange,
    customSize: s.paper === 'custom',
    orientation: s.paper in PAPERS && PAPERS[s.paper].width !== PAPERS[s.paper].height,
    preview: !!source?.canPreview,
    driver: devices.length > 1,
    nativeUi: !!caps?.nativeUi,
    transfer: driver === 'twain' || driver === 'twain32',
    doubleFeedStop: !!source?.doubleFeed,
    networkTimeout: driver === 'escl',
    multiple: true,
  };
}

/* The request, and what's done after the scan ------------------------- */

/** A box on the glass, inches from its top left */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The clean-up done to each page after the scan (scan-image.ts), for what
 * the scanner didn't do itself.
 */
export interface ProcessPlan {
  /** The page's final color: 'auto' decides from the page */
  color: ColorMode;
  /** Black and white: darker than this is black (the scanner may have
   *  done it already: doing it again changes nothing) */
  threshold: number | null;
  brightness: number;
  contrast: number;
  invert: boolean;
  deskew: boolean;
  autoCrop: boolean;
  background: Level;
  descreen: boolean;
  sharpen: Level;
  despeckle: boolean;
  edgeShadow: boolean;
  /** Blank pages are marked (0-100), or not looked for (null) */
  blankSensitivity: number | null;
  rotate: 0 | 90 | 180 | 270;
  autoRotate: boolean;
}

/** -100..100 onto a scanner's range */
const toRange = (v: number, r: ScanRange) => {
  const raw =
    v >= 0
      ? r.default + (v / 100) * (r.max - r.default)
      : r.default + (v / 100) * (r.default - r.min);
  const stepped = r.min + Math.round((raw - r.min) / r.step) * r.step;
  return Math.min(r.max, Math.max(r.min, Number(stepped.toFixed(4))));
};
/** 0..255 onto a scanner's threshold range */
const thresholdToRange = (v: number, r: ScanRange) =>
  Math.min(
    r.max,
    Math.max(r.min, Math.round(r.min + (v / 255) * (r.max - r.min)))
  );

/** The paper size in inches, turned for landscape */
export function paperSize(s: ScanSettings): { width: number; height: number } {
  const p =
    s.paper === 'custom'
      ? { width: s.customWidth, height: s.customHeight }
      : (PAPERS[s.paper] ?? PAPERS.letter);
  const landscape = s.paper !== 'custom' && s.orientation === 'landscape';
  return landscape
    ? { width: p.height, height: p.width }
    : { width: p.width, height: p.height };
}

export function buildRequest(
  s: ScanSettings,
  caps: ScanCaps | null,
  source: ScanSource | undefined,
  box: Box | null
): { request: ScanRequest; plan: ProcessPlan } {
  const colors = source?.colors ?? ['color', 'gray', 'bw'];
  // Autodetect scans in color and decides afterwards; black and white from
  // a scanner without it comes from gray
  const color: ScanRequest['color'] =
    s.color === 'auto'
      ? colors.includes('color')
        ? 'color'
        : 'gray'
      : colors.includes(s.color)
        ? s.color
        : s.color === 'bw'
          ? 'gray'
          : colors[0];
  const maxW = source?.maxWidth ?? 8.5;
  const maxH = source?.maxHeight ?? 11.69;
  const request: ScanRequest = {
    source: source?.id ?? s.source,
    duplex: source?.id === 'feeder' && s.sides === 'both' && !!source.duplex,
    color,
    dpi: s.dpi,
  };
  if (s.paper === 'preview' && box)
    request.area = {
      x: round(box.x),
      y: round(box.y),
      width: round(Math.min(box.width, maxW - box.x)),
      height: round(Math.min(box.height, maxH - box.y)),
    };
  else if (s.paper === 'auto' && source?.autoSize) request.paper = 'auto';
  else if (s.paper === 'max' || s.paper === 'auto' || s.paper === 'preview')
    request.paper = { width: maxW, height: maxH };
  else {
    const p = paperSize(s);
    request.paper = {
      width: round(Math.min(p.width, maxW)),
      height: round(Math.min(p.height, maxH)),
    };
  }
  const plan: ProcessPlan = {
    color: s.color,
    threshold: s.color === 'bw' ? s.threshold : null,
    brightness: 0,
    contrast: 0,
    invert: false,
    deskew: s.deskew,
    autoCrop: s.autoCrop || (s.paper === 'auto' && !source?.autoSize),
    background: s.background,
    descreen: s.descreen,
    sharpen: s.sharpen,
    despeckle: s.despeckle,
    edgeShadow: s.edgeShadow,
    blankSensitivity: s.removeBlank ? s.blankSensitivity : null,
    rotate: s.rotate,
    autoRotate: s.autoRotate,
  };
  // Each adjustment: by the scanner when it can, else afterwards
  if (s.brightness) {
    if (source?.brightness)
      request.brightness = toRange(s.brightness, source.brightness);
    else plan.brightness = s.brightness;
  }
  if (s.contrast) {
    if (source?.contrast) request.contrast = toRange(s.contrast, source.contrast);
    else plan.contrast = s.contrast;
  }
  if (s.color === 'bw' && color === 'bw' && source?.threshold)
    request.threshold = thresholdToRange(s.threshold, source.threshold);
  if (s.invert && s.color === 'bw') {
    if (color === 'bw' && source?.invert) request.invert = true;
    else plan.invert = true;
  }
  if (s.deskew && source?.autoDeskew) {
    request.autoDeskew = true;
    plan.deskew = false;
  }
  // (the blank check afterwards still runs, with its sensitivity)
  if (s.removeBlank && source?.blankPageSkip) request.blankPageSkip = true;
  if (source?.doubleFeed) request.doubleFeedStop = s.doubleFeedStop;
  if (caps?.nativeUi && s.nativeUi) request.nativeUi = true;
  if (caps?.driver === 'twain' || caps?.driver === 'twain32')
    request.transfer = s.transfer;
  if (caps?.driver === 'escl') request.timeout = s.networkTimeout;
  return { request, plan };
}

const round = (v: number) => Math.round(v * 1000) / 1000;

/* After the scan -------------------------------------------------------- */

/** Fronts scanned as one stack and backs as another (the stack turned
 *  over, so they come last page first) into reading order */
export function interleave<T>(fronts: T[], backs: T[]): T[] {
  const reversed = [...backs].reverse();
  const out: T[] = [];
  for (let k = 0; k < Math.max(fronts.length, reversed.length); k++) {
    if (k < fronts.length) out.push(fronts[k]);
    if (k < reversed.length) out.push(reversed[k]);
  }
  return out;
}

/** Save multiple files: the pages of each file (the last may be short) */
export function splitIntoFiles(count: number, perFile: number): number[][] {
  const n = Math.max(1, Math.floor(perFile) || 1);
  const out: number[][] = [];
  for (let k = 0; k < count; k += n)
    out.push(Array.from({ length: Math.min(n, count - k) }, (_, i) => k + i));
  return out;
}

/** "Scan 1.pdf", "Scan 2.pdf"… (numbers padded so they sort) */
export function fileNames(prefix: string, files: number): string[] {
  const base = prefix.trim() || 'Scan';
  const width = String(files).length;
  return Array.from(
    { length: files },
    (_, k) => `${base} ${String(k + 1).padStart(width, '0')}.pdf`
  );
}

/** Where inserted pages go (Acrobat's Insert Pages): before or after the
 *  first, last or nth page. Returns insertPagesFrom's "after" (-1: at the
 *  start) */
export interface InsertAt {
  position: 'before' | 'after';
  page: 'first' | 'last' | 'number';
  /** 1-based, for 'number' */
  number: number;
}
export function insertAfter(at: InsertAt, total: number): number {
  const n =
    at.page === 'first'
      ? 1
      : at.page === 'last'
        ? total
        : Math.min(Math.max(1, Math.floor(at.number) || 1), Math.max(total, 1));
  return at.position === 'before' ? n - 2 : n - 1;
}

/** A new scan's name: "Scan 2026-11-06 18.30.pdf" */
export function scanName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `Scan ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.pdf`;
}

/** "Grayscale, Letter, 300 dpi, Both sides" */
export function settingsSummary(s: ScanSettings): string {
  const paper =
    s.paper in PAPERS
      ? PAPERS[s.paper].label
      : s.paper === 'auto'
        ? 'Auto size'
        : s.paper === 'max'
          ? 'Whole glass'
          : s.paper === 'preview'
            ? 'From preview'
            : 'Custom size';
  return [
    COLOR_LABELS[s.color],
    paper,
    `${s.dpi} dpi`,
    s.source === 'feeder' && s.sides === 'both' ? 'Both sides' : null,
  ]
    .filter(Boolean)
    .join(', ');
}

/** The choice offered first after a pass: the last one made (not always
 *  "complete", as Acrobat does), when it applies */
export function defaultAfterPass(
  last: AfterPass | undefined,
  canReverse: boolean
): AfterPass {
  if (last === 'reverse') return canReverse ? 'reverse' : 'more';
  return last ?? 'more';
}

/** mm and inches */
export const toInches = (v: number, units: 'in' | 'mm') =>
  units === 'mm' ? v / 25.4 : v;
export const fromInches = (v: number, units: 'in' | 'mm') =>
  units === 'mm' ? Math.round(v * 25.4) : Math.round(v * 100) / 100;
