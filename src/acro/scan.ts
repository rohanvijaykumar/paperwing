/**
 * Create a PDF from a scanner (#35), the way Acrobat's Create ▸ Scanner
 * works, in a dialog laid out like Paperwing's print dialog: the settings in
 * titled groups on the left (a preset at the top; Scanner, Pages, Image,
 * Clean-up, File size, Output), the flatbed preview and the scanned pages on
 * the right, the actions at the bottom. After each pass: Scan more pages,
 * Scan reverse sides or Scan is complete, with the pages so far to rotate,
 * delete, reorder or rescan. Settings a scanner can't do are hidden; what
 * it can't do itself is done after the scan (scan-process.ts).
 *
 * The scanning happens in the desktop shell (desktop/scan.cjs).
 */
import type {
  DesktopBridge,
  ScanCaps,
  ScanDevice,
  ScanError,
  ScanImport,
  ScanPageInfo,
  ScanResult,
  ScanSource,
  Scanner,
} from './desktop';
import { icon } from './icons';
import { showModal } from './modal';
import { getPrefs, setPrefs } from './prefs';
import {
  BUILTIN_PRESETS,
  COLOR_LABELS,
  OUTPUT_KEYS,
  PAPERS,
  SCANNER_KEYS,
  buildRequest,
  chooseDevice,
  colorChoices,
  defaultAfterPass,
  fileNames,
  fromInches,
  insertAfter,
  interleave,
  nearestResolution,
  offeredResolutions,
  omit,
  paperChoices,
  pick,
  settingsSummary,
  splitIntoFiles,
  startingSettings,
  toInches,
  visibility,
  type AfterPass,
  type Box,
  type InsertAt,
  type Preset,
  type ProcessPlan,
  type ScanSettings,
} from './scan-settings';
import {
  buildPdf,
  encodePage,
  processPage,
  type PdfPart,
  type ProcessedPage,
} from './scan-process';
import { createGlassPreview, findDocument } from './scan-preview';
import { createReview, type ReviewPage } from './scan-review';
import { loadPdfjs } from './thumbnails';

export type ScanBridge = Required<
  Pick<
    DesktopBridge,
    | 'scanners'
    | 'addScanner'
    | 'scannerCaps'
    | 'scanPreview'
    | 'scan'
    | 'cancelScan'
    | 'onScanPage'
    | 'onScanStatus'
    | 'watchScanFolder'
    | 'onScanImport'
    | 'chooseFolder'
    | 'saveFiles'
  >
>;

/** A PDF on disk chosen with Browse… (opened with the pages added) */
export interface PickedFile {
  name: string;
  path?: string;
  file: File;
}

export interface ScanDialogOptions {
  isMac: boolean;
  /** 'insert': Insert pages ▸ From scanner (the pages go into `insert`) */
  mode: 'create' | 'insert';
  /** Open documents the pages can be added to */
  documents: { id: string; name: string }[];
  /** The one shown, offered first */
  activeDocument: string | null;
  insert?: { name: string; total: number; page: number };
  /** Start with this preset (File ▸ Create PDF from Scanner ▸ …) */
  preset?: string;
  /** Scan as soon as the scanner is ready */
  autoStart?: boolean;
  /** Recognize text ticked (Scan & OCR ▸ Scan a document) */
  ocr?: boolean;
  /** Browse… for a PDF that isn't open */
  browse(): Promise<PickedFile | null>;
  /** Makes the text searchable (the app's OCR engine) */
  recognize(
    pdf: Uint8Array,
    language: string,
    progress: (text: string) => void
  ): Promise<Uint8Array>;
  /** OCR languages: code -> name */
  languages: Record<string, string>;
}

export type ScanOutcome =
  | {
      output: 'new';
      pdf: Uint8Array;
      pages: number;
      pdfa: boolean;
      metadata: boolean;
    }
  | {
      output: 'append';
      pdf: Uint8Array;
      pages: number;
      to: { kind: 'open'; id: string } | { kind: 'file'; file: PickedFile };
    }
  | { output: 'insert'; pdf: Uint8Array; pages: number; after: number }
  | {
      output: 'multiple';
      saved: { path: string; name: string }[];
      folder: string;
      pages: number;
    };

/** Scanning's remembered choices (prefs.ts holds them) */
interface ScanPrefs {
  presets: Record<string, unknown>;
  custom: { id: string; name: string; settings: unknown }[];
  scanners: Record<string, unknown>;
  output: unknown;
  last: { scanner?: string; preset?: string; next?: AfterPass };
}

function scanPrefs(): ScanPrefs {
  const raw = (getPrefs().scan ?? {}) as Partial<ScanPrefs>;
  return {
    presets: raw.presets && typeof raw.presets === 'object' ? raw.presets : {},
    custom: Array.isArray(raw.custom)
      ? raw.custom.filter(
          (c) => c && typeof c.id === 'string' && typeof c.name === 'string'
        )
      : [],
    scanners:
      raw.scanners && typeof raw.scanners === 'object' ? raw.scanners : {},
    output: raw.output ?? {},
    last: raw.last && typeof raw.last === 'object' ? raw.last : {},
  };
}

const saveScanPrefs = (p: ScanPrefs) => setPrefs({ scan: p });

/** What a failed scan says: what happened and what to do */
export function scanErrorMessage(
  error: ScanError | undefined,
  message: string | undefined,
  isMac: boolean
): string {
  switch (error) {
    case 'no-scanner':
      return "The scanner wasn't found. Check that it's on and connected, then select Refresh.";
    case 'offline':
      return "The scanner isn't responding. Check that it's on and connected (or on the same network), then try again.";
    case 'busy':
      return 'The scanner is busy, maybe with another app. Wait for it to finish, then scan again.';
    case 'paper-jam':
      return 'The paper is jammed. Clear it, then scan again.';
    case 'feeder-empty':
      return 'The document feeder is empty. Put the pages in, then select Scan.';
    case 'double-feed':
      return 'Two sheets went through together. Put them back in the feeder, then scan again.';
    case 'cover-open':
      return "The scanner's cover is open. Close it, then scan again.";
    case 'unsupported':
      return "The scanner can't scan with these settings. Try another color mode, resolution or paper size.";
    case 'blocked':
      return isMac
        ? 'macOS stopped Paperwing from reaching the scanner. In System Settings ▸ Privacy & Security ▸ Local Network, allow Paperwing, then select Refresh.'
        : "Paperwing's scanner helper was blocked, probably by your organization's security settings. Ask your IT department to allow Paperwing's scanner helper, or use Import from a scanner app.";
    case 'invalid':
      return `These settings can't be used${message ? `: ${message}` : '.'}`;
    default:
      return `The scan didn't work${message ? `: ${message}` : '.'}`;
  }
}

/* Small DOM helpers ------------------------------------------------------ */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string | null | false)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...(children.filter(Boolean) as (Node | string)[]));
  return e;
}

function fill(s: HTMLSelectElement, options: [string, string][], value?: string) {
  s.replaceChildren(...options.map(([v, text]) => el('option', { value: v }, text)));
  if (value !== undefined && options.some(([v]) => v === value)) s.value = value;
}

const select = (label: string) =>
  el('select', { class: 'pref-select', 'aria-label': label });

const row = (label: string, ...controls: HTMLElement[]) =>
  el('label', { class: 'pref-row' }, el('span', {}, el('b', {}, label)), ...controls);

const check = (label: string) => {
  const input = el('input', { type: 'checkbox', 'aria-label': label });
  return { input, label: el('label', { class: 'pd-check' }, input, label) };
};

const slider = (label: string, min: number, max: number, step: number) =>
  el('input', {
    type: 'range',
    class: 'sd-slider',
    min: String(min),
    max: String(max),
    step: String(step),
    'aria-label': label,
  });

const number = (label: string, min: number, max: number, step = 1) =>
  el('input', {
    type: 'number',
    class: 'pref-select pd-num',
    min: String(min),
    max: String(max),
    step: String(step),
    'aria-label': label,
  });

/** A titled group of settings; collapsible ones start closed */
function group(title: string, collapsed: boolean | null, ...children: (Node | false)[]) {
  const body = el('div', { class: 'sd-group-body' }, ...(children.filter(Boolean) as Node[]));
  const section = el('section', { class: 'pd-group sd-group', 'aria-label': title });
  if (collapsed === null) {
    section.append(el('h3', {}, title), body);
    return { section, body };
  }
  const id = `sd-${title.toLowerCase().replace(/\W+/g, '-')}`;
  body.id = id;
  const toggle = el(
    'button',
    { type: 'button', class: 'sd-toggle', 'aria-expanded': String(!collapsed), 'aria-controls': id },
    icon('chevronRight', 14),
    title
  );
  body.hidden = collapsed;
  toggle.addEventListener('click', () => {
    body.hidden = !body.hidden;
    toggle.setAttribute('aria-expanded', String(!body.hidden));
  });
  section.append(el('h3', {}, toggle), body);
  return { section, body };
}

/** A page in the dialog: scanned (cleaned up as it arrives) or a page of a
 *  PDF a scanner's app saved */
interface Page {
  id: number;
  source:
    | { kind: 'scan'; processed: ProcessedPage | null; side: 'front' | 'back' }
    | { kind: 'pdf'; bytes: Uint8Array; index: number };
  url: string;
  rotation: number;
  blank: boolean;
  keep: boolean;
  /** Settings it was scanned with (a rescan uses the same scanner) */
  rescannable: boolean;
}

let nextPageId = 1;

/** A small picture of a PDF page (Import from a scanner app) */
async function pdfPageThumbs(bytes: Uint8Array): Promise<string[]> {
  const { lib, worker } = await loadPdfjs();
  const doc = await lib.getDocument({
    data: bytes.slice(),
    worker,
    wasmUrl: import.meta.env.BASE_URL + 'pdfjs-viewer/wasm/',
    isEvalSupported: false,
  }).promise;
  try {
    const urls: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 160 / page.getViewport({ scale: 1 }).width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
      urls.push(blob ? URL.createObjectURL(blob) : '');
    }
    return urls;
  } finally {
    void doc.destroy();
  }
}

const WATCH = '__watch';
const BROWSE = '__browse';

/** Shows the scan dialog; resolves with what was made, or null */
export function showScanDialog(
  bridge: ScanBridge,
  options: ScanDialogOptions
): Promise<ScanOutcome | null> {
  const locale = navigator.language;
  const stored = scanPrefs();
  const presets = (): Preset[] => [
    ...BUILTIN_PRESETS,
    ...scanPrefs().custom.map((c) => ({
      id: `custom:${c.id}`,
      label: c.name,
      settings: {},
    })),
  ];
  let presetId =
    options.preset && presets().some((p) => p.id === options.preset)
      ? options.preset
      : stored.last.preset && presets().some((p) => p.id === stored.last.preset)
        ? stored.last.preset
        : 'mine';
  const presetSaved = (id: string) => {
    const p = scanPrefs();
    if (id.startsWith('custom:'))
      return p.custom.find((c) => `custom:${c.id}` === id)?.settings;
    return p.presets[id];
  };
  const settingsFor = (id: string, scannerKey?: string): ScanSettings => {
    const preset = presets().find((p) => p.id === id) ?? BUILTIN_PRESETS[0];
    const p = scanPrefs();
    return startingSettings(locale, preset, {
      preset: presetSaved(preset.id),
      scanner: scannerKey ? p.scanners[scannerKey] : undefined,
      output: p.output,
    });
  };
  let settings = settingsFor(presetId, stored.last.scanner);
  if (options.ocr) settings.ocr = true;
  if (options.mode === 'create' && settings.output === 'append' && !options.documents.length)
    settings.output = 'new';

  return new Promise((resolve) => {
    let scanners: Scanner[] = [];
    let entry: Scanner | undefined;
    let device: ScanDevice | undefined;
    let caps: ScanCaps | null = null;
    let busy: '' | 'list' | 'caps' | 'preview' | 'scan' | 'finish' = '';
    let closed = false;
    let pages: Page[] = [];
    /** The last pass's pages (fronts, for Scan reverse sides) */
    let lastPass: { ids: number[]; feeder: boolean; duplex: boolean } | null = null;
    let watching = '';
    let watchFolder = '';
    let saveFolder: { path: string; name: string } | null = null;
    const picked: PickedFile[] = [];
    const urls = new Set<string>();
    const thumb = (blob: Blob) => {
      const u = URL.createObjectURL(blob);
      urls.add(u);
      return u;
    };
    const source = (): ScanSource | undefined =>
      caps?.sources.find((s) => s.id === settings.source) ?? caps?.sources[0];

    /* Controls ------------------------------------------------------------ */
    const preset = select('Preset');
    const savePresetBtn = el('button', { type: 'button', class: 'quiet-btn sd-link' }, 'Save as preset…');
    const summary = el('p', { class: 'sd-summary', 'aria-live': 'polite' });

    const scanner = select('Scanner');
    const refreshBtn = el(
      'button',
      { type: 'button', class: 'tb-btn', title: 'Refresh', 'aria-label': 'Refresh the scanner list' },
      icon('refresh', 16)
    );
    const addBtn = el('button', { type: 'button', class: 'quiet-btn sd-link' }, 'Add by IP address…');
    const optionsBtn = el('button', { type: 'button', class: 'quiet-btn sd-link' }, 'Options…');
    const none = el('div', { class: 'sd-none', role: 'note' });
    none.hidden = true;
    const folderName = el('span', { class: 'sd-folder-name' }, 'No folder chosen');
    const folderBtn = el('button', { type: 'button', class: 'pill-btn' }, 'Choose…');
    const folderRow = el(
      'div',
      { class: 'sd-folder' },
      el(
        'p',
        { class: 'pd-hint' },
        "For scanners that only work with their own app (ScanSnap and the like): choose the folder that app saves to, and each new scan shows here."
      ),
      el('div', { class: 'sd-folder-row' }, folderName, folderBtn)
    );

    const src = select('Source');
    const sides = select('Pages');
    fill(sides, [
      ['front', 'Front sides'],
      ['both', 'Both sides'],
    ]);
    const flip = check('Flip back sides (bound at the top)');

    const color = select('Color mode');
    const threshold = slider('Threshold', 0, 255, 1);
    const dpi = select('Resolution');
    const customDpi = number('Custom resolution (dpi)', 25, 4800);
    const paper = select('Paper size');
    const customW = number('Width', 0.5, 1500, 0.01);
    const customH = number('Height', 0.5, 1500, 0.01);
    const units = select('Units');
    fill(units, [
      ['in', 'in'],
      ['mm', 'mm'],
    ]);
    const orientation = select('Orientation');
    fill(orientation, [
      ['portrait', 'Portrait'],
      ['landscape', 'Landscape'],
    ]);
    const brightness = slider('Brightness', -100, 100, 1);
    const contrast = slider('Contrast', -100, 100, 1);

    const deskew = check('Deskew (straighten crooked pages)');
    const autoCrop = check('Auto-crop to the page edges');
    const background = select('Background removal');
    const levels: [string, string][] = [
      ['off', 'Off'],
      ['low', 'Low'],
      ['medium', 'Medium'],
      ['high', 'High'],
    ];
    fill(background, levels);
    const descreen = check('Descreen (printed photos, magazines)');
    const sharpen = select('Text sharpening');
    fill(sharpen, levels);
    const despeckle = check('Despeckle (remove stray dots)');
    const removeBlank = check('Remove blank pages');
    const sensitivity = slider('Blank page sensitivity', 0, 100, 5);
    const edgeShadow = check('Remove edge shadows');
    const autoRotate = check('Auto-rotate pages (finds upside-down text)');
    const rotateAll = select('Rotate all pages');
    fill(rotateAll, [
      ['0', 'No'],
      ['90', '90° clockwise'],
      ['180', '180°'],
      ['270', '90° counterclockwise'],
    ]);

    const quality = slider('File size and quality', 0, 1, 0.05);
    const compression = select('Color and grayscale compression');
    fill(compression, [
      ['jpeg', 'JPEG (smaller)'],
      ['zip', 'ZIP (lossless)'],
    ]);
    const bwCompression = select('Black and white compression');
    fill(bwCompression, [
      ['g4', 'CCITT Group 4'],
      ['zip', 'ZIP (lossless)'],
    ]);

    const outputChoice = (value: string, text: string) => {
      const input = el('input', { type: 'radio', name: 'sd-output', value, 'aria-label': text });
      return { input, label: el('label', { class: 'pd-radio' }, input, text) };
    };
    const outNew = outputChoice('new', 'Create new PDF');
    const outAppend = outputChoice('append', 'Append to file');
    const outMultiple = outputChoice('multiple', 'Save multiple files');
    const appendTo = select('File to append to');
    const perFile = number('Pages per file', 1, 9999);
    const prefix = el('input', {
      type: 'text',
      class: 'pref-select sd-text',
      'aria-label': 'File name prefix',
      maxlength: '100',
      spellcheck: 'false',
    });
    const saveFolderName = el('span', { class: 'sd-folder-name' }, 'No folder chosen');
    const saveFolderBtn = el('button', { type: 'button', class: 'pill-btn' }, 'Choose…');
    const insertPos = select('Location');
    fill(insertPos, [
      ['after', 'After'],
      ['before', 'Before'],
    ]);
    const insertPage = select('Page');
    const insertNumber = number('Page number', 1, Math.max(1, options.insert?.total ?? 1));
    const promptMore = check('Prompt to scan more pages');
    const ocr = check('Recognize text (OCR)');
    const ocrLang = select('Language');
    fill(
      ocrLang,
      Object.entries(options.languages)
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([code, name]) => [code, name])
    );
    const pdfa = check('Make PDF/A compliant');
    const metadata = check('Add metadata (document properties)');

    /* Rows that come and go ------------------------------------------------ */
    const srcRow = row('Source', src);
    const sidesRow = row('Pages', sides);
    const thresholdRow = row('Threshold', threshold);
    const customDpiRow = row('Custom resolution', customDpi);
    const sizeRow = el(
      'div',
      { class: 'pref-row sd-size' },
      el('span', {}, el('b', {}, 'Size')),
      el('span', { class: 'sd-size-fields' }, customW, el('span', { 'aria-hidden': 'true' }, '×'), customH, units)
    );
    const orientationRow = row('Orientation', orientation);
    const sensitivityRow = row('Sensitivity', sensitivity);
    const appendRow = el('div', { class: 'sd-sub' }, appendTo);
    const multipleRows = el(
      'div',
      { class: 'sd-sub' },
      row('Pages per file', perFile),
      row('File name prefix', prefix),
      el('div', { class: 'sd-folder-row' }, saveFolderName, saveFolderBtn)
    );
    const ocrLangRow = row('Language', ocrLang);

    /* Groups -------------------------------------------------------------- */
    const presetRow = el(
      'div',
      { class: 'sd-preset' },
      row('Preset', preset),
      el('div', { class: 'sd-summary-row' }, summary, savePresetBtn)
    );
    const scannerGroup = group(
      'Scanner',
      null,
      el('div', { class: 'sd-scanner' }, row('Scanner', scanner), refreshBtn),
      el('div', { class: 'sd-links' }, addBtn, optionsBtn),
      none,
      folderRow
    );
    const pagesGroup = group('Pages', null, srcRow, sidesRow, flip.label);
    const imageGroup = group(
      'Image',
      null,
      row('Color mode', color),
      thresholdRow,
      row('Resolution', dpi),
      customDpiRow,
      row('Paper size', paper),
      sizeRow,
      orientationRow,
      row('Brightness', brightness),
      row('Contrast', contrast)
    );
    const cleanupGroup = group(
      'Clean-up',
      true,
      deskew.label,
      autoCrop.label,
      row('Background removal', background),
      descreen.label,
      row('Text sharpening', sharpen),
      despeckle.label,
      removeBlank.label,
      sensitivityRow,
      edgeShadow.label,
      autoRotate.label,
      row('Rotate all pages', rotateAll)
    );
    const fileGroup = group(
      'File size',
      true,
      el(
        'label',
        { class: 'pref-row sd-quality-row' },
        el('span', { class: 'sd-quality-scale' }, el('small', {}, 'Small size'), quality, el('small', {}, 'High quality'))
      ),
      row('Color and grayscale', compression),
      row('Black and white', bwCompression)
    );
    const insertRows = el(
      'div',
      { class: 'sd-insert' },
      row('Location', insertPos),
      row('Page', insertPage),
      row('Page number', insertNumber)
    );
    const outputGroup = group(
      'Output',
      null,
      options.mode === 'insert'
        ? insertRows
        : el(
            'div',
            { class: 'pd-pages', role: 'radiogroup', 'aria-label': 'Output' },
            outNew.label,
            outAppend.label,
            appendRow,
            outMultiple.label,
            multipleRows
          ),
      promptMore.label,
      ocr.label,
      ocrLangRow,
      options.mode === 'create' && pdfa.label,
      options.mode === 'create' && metadata.label
    );
    const settingsPanel = el(
      'div',
      { class: 'prefs pd-settings sd-settings' },
      presetRow,
      scannerGroup.section,
      pagesGroup.section,
      imageGroup.section,
      cleanupGroup.section,
      fileGroup.section,
      outputGroup.section
    );

    /* Right side ----------------------------------------------------------- */
    const glass = createGlassPreview((box) => {
      void box;
      if (settings.paper !== 'preview') {
        settings.paper = 'preview';
        refresh();
      }
    });
    const review = createReview({
      rotate: (id, by) => {
        const p = pages.find((x) => x.id === id);
        if (p) p.rotation = (p.rotation + by + 360) % 360;
        renderPages();
      },
      remove: (id) => {
        pages = pages.filter((x) => x.id !== id);
        if (lastPass) lastPass.ids = lastPass.ids.filter((x) => x !== id);
        renderPages();
        showActions();
      },
      move: (id, to) => {
        const from = pages.findIndex((x) => x.id === id);
        if (from < 0) return;
        const [p] = pages.splice(from, 1);
        pages.splice(to, 0, p);
        renderPages();
      },
      rescan: (id) => void scanPass('rescan', id),
      keep: (id) => {
        const p = pages.find((x) => x.id === id);
        if (p) p.keep = true;
        renderPages();
      },
    });
    const tabPreview = el('button', { type: 'button', class: 'pd-seg-btn', role: 'tab', 'aria-selected': 'false' }, 'Preview');
    const tabPages = el('button', { type: 'button', class: 'pd-seg-btn', role: 'tab', 'aria-selected': 'true' }, 'Pages');
    const tabs = el('div', { class: 'pd-seg sd-tabs', role: 'tablist', 'aria-label': 'Preview or pages' }, tabPreview, tabPages);
    const previewPane = el('div', { class: 'sd-pane', role: 'tabpanel', 'aria-label': 'Preview' }, glass.el);
    const pagesPane = el('div', { class: 'sd-pane', role: 'tabpanel', 'aria-label': 'Pages' }, review.el);
    let shown: 'preview' | 'pages' = 'pages';
    const showPane = (which: 'preview' | 'pages') => {
      shown = which;
      previewPane.hidden = which !== 'preview';
      pagesPane.hidden = which !== 'pages';
      tabPreview.classList.toggle('is-on', which === 'preview');
      tabPages.classList.toggle('is-on', which === 'pages');
      tabPreview.setAttribute('aria-selected', String(which === 'preview'));
      tabPages.setAttribute('aria-selected', String(which === 'pages'));
    };
    tabPreview.addEventListener('click', () => showPane('preview'));
    tabPages.addEventListener('click', () => showPane('pages'));
    const right = el('div', { class: 'sd-right' }, tabs, previewPane, pagesPane);

    /* Actions --------------------------------------------------------------- */
    const status = el('p', { class: 'muted pd-status sd-status', role: 'status' });
    const btn = (cls: string, text: string, onClick: () => void) => {
      const b = el('button', { type: 'button', class: cls }, text);
      b.addEventListener('click', onClick);
      return b;
    };
    const cancelBtn = btn('quiet-btn', 'Cancel', () => void cancel());
    const previewBtn = btn('pill-btn', 'Preview', () => void preview());
    const scanBtn = btn('accent-btn', 'Scan', () => void scanPass('first'));
    const moreBtn = btn('pill-btn', 'Scan more pages', () => void after('more'));
    const reverseBtn = btn('pill-btn', 'Scan reverse sides', () => void after('reverse'));
    const doneBtn = btn('pill-btn', 'Scan is complete', () => void after('done'));
    const actions = el('div', { class: 'dlg-actions' });

    const closeBtn = el('button', { type: 'button', class: 'tb-btn', title: 'Close', 'aria-label': 'Close' });
    closeBtn.append(icon('close'));
    closeBtn.addEventListener('click', () => void cancel());

    const title = options.mode === 'insert' ? 'Insert pages from scanner' : 'Create PDF from scanner';
    const backdrop = el(
      'div',
      { class: 'dlg-backdrop' },
      el(
        'div',
        { class: 'dlg dlg-scan', role: 'dialog', 'aria-label': title },
        el('div', { class: 'dlg-head' }, el('h2', {}, title), closeBtn),
        el(
          'div',
          { class: 'dlg-body' },
          el('div', { class: 'pd-layout sd-layout' }, settingsPanel, right),
          status,
          actions
        )
      )
    );

    /* Settings in and out of the controls --------------------------------- */
    function writeControls() {
      fill(
        preset,
        presets().map((p) => [p.id, p.label]),
        presetId
      );
      sides.value = settings.sides;
      flip.input.checked = settings.flipBacks;
      threshold.value = String(settings.threshold);
      customDpi.value = String(settings.dpi);
      units.value = settings.units;
      customW.value = String(fromInches(settings.customWidth, settings.units));
      customH.value = String(fromInches(settings.customHeight, settings.units));
      orientation.value = settings.orientation;
      brightness.value = String(settings.brightness);
      contrast.value = String(settings.contrast);
      deskew.input.checked = settings.deskew;
      autoCrop.input.checked = settings.autoCrop;
      background.value = settings.background;
      descreen.input.checked = settings.descreen;
      sharpen.value = settings.sharpen;
      despeckle.input.checked = settings.despeckle;
      removeBlank.input.checked = settings.removeBlank;
      sensitivity.value = String(settings.blankSensitivity);
      edgeShadow.input.checked = settings.edgeShadow;
      autoRotate.input.checked = settings.autoRotate;
      rotateAll.value = String(settings.rotate);
      quality.value = String(settings.quality);
      compression.value = settings.compression;
      bwCompression.value = settings.bwCompression;
      outNew.input.checked = settings.output === 'new';
      outAppend.input.checked = settings.output === 'append';
      outMultiple.input.checked = settings.output === 'multiple';
      perFile.value = String(settings.perFile);
      prefix.value = settings.prefix;
      promptMore.input.checked = settings.promptMore;
      ocr.input.checked = settings.ocr;
      if (options.languages[settings.ocrLanguage]) ocrLang.value = settings.ocrLanguage;
      pdfa.input.checked = settings.pdfa;
      metadata.input.checked = settings.metadata;
    }

    function readControls() {
      if (scanner.value !== WATCH && caps) settings.source = src.value as ScanSettings['source'];
      settings.sides = sides.value as ScanSettings['sides'];
      settings.flipBacks = flip.input.checked;
      settings.color = (color.value || settings.color) as ScanSettings['color'];
      settings.threshold = Number(threshold.value);
      if (dpi.value === 'custom') {
        const v = Math.round(Number(customDpi.value));
        const r = source()?.resolutionRange;
        if (r && v >= r.min && v <= r.max) settings.dpi = v;
      } else if (dpi.value) settings.dpi = Number(dpi.value);
      if (paper.value) settings.paper = paper.value;
      settings.units = units.value as ScanSettings['units'];
      const w = toInches(Number(customW.value), settings.units);
      const h = toInches(Number(customH.value), settings.units);
      if (w >= 0.5 && w <= 60) settings.customWidth = w;
      if (h >= 0.5 && h <= 60) settings.customHeight = h;
      settings.orientation = orientation.value as ScanSettings['orientation'];
      settings.brightness = Number(brightness.value);
      settings.contrast = Number(contrast.value);
      settings.deskew = deskew.input.checked;
      settings.autoCrop = autoCrop.input.checked;
      settings.background = background.value as ScanSettings['background'];
      settings.descreen = descreen.input.checked;
      settings.sharpen = sharpen.value as ScanSettings['sharpen'];
      settings.despeckle = despeckle.input.checked;
      settings.removeBlank = removeBlank.input.checked;
      settings.blankSensitivity = Number(sensitivity.value);
      settings.edgeShadow = edgeShadow.input.checked;
      settings.autoRotate = autoRotate.input.checked;
      settings.rotate = Number(rotateAll.value) as ScanSettings['rotate'];
      settings.quality = Number(quality.value);
      settings.compression = compression.value as ScanSettings['compression'];
      settings.bwCompression = bwCompression.value as ScanSettings['bwCompression'];
      settings.output = outMultiple.input.checked
        ? 'multiple'
        : outAppend.input.checked
          ? 'append'
          : 'new';
      const per = Math.round(Number(perFile.value));
      if (per >= 1) settings.perFile = per;
      settings.prefix = prefix.value.trim() || 'Scan';
      settings.promptMore = promptMore.input.checked;
      settings.ocr = ocr.input.checked;
      if (ocrLang.value) settings.ocrLanguage = ocrLang.value;
      settings.pdfa = pdfa.input.checked;
      settings.metadata = metadata.input.checked;
    }

    /** Shows what this scanner can do and these settings need */
    function refresh() {
      const watchMode = scanner.value === WATCH;
      const s = source();
      const v = visibility(caps, s, settings, entry?.devices ?? []);
      folderRow.hidden = !watchMode;
      optionsBtn.hidden = watchMode || !caps;
      pagesGroup.section.hidden = imageGroup.section.hidden = watchMode || !caps;
      fill(
        src,
        (caps?.sources ?? []).map((x) => [x.id, x.id === 'feeder' ? 'Document feeder' : 'Flatbed']),
        settings.source
      );
      if (s && s.id !== settings.source) settings.source = s.id;
      srcRow.hidden = !v.source;
      sidesRow.hidden = !v.sides;
      flip.label.hidden = !v.flipBacks;
      // A group with nothing to set for this scanner goes too
      if (srcRow.hidden && sidesRow.hidden && flip.label.hidden)
        pagesGroup.section.hidden = true;
      fill(
        color,
        colorChoices(s).map((c) => [c, COLOR_LABELS[c]]),
        settings.color
      );
      if (color.value && color.value !== settings.color) settings.color = color.value as ScanSettings['color'];
      thresholdRow.hidden = !v.threshold;
      const offered = offeredResolutions(s);
      const custom = v.customDpi && !offered.includes(settings.dpi);
      fill(
        dpi,
        [
          ...offered.map((d) => [String(d), `${d} dpi`] as [string, string]),
          ...(v.customDpi ? ([['custom', 'Custom…']] as [string, string][]) : []),
        ],
        custom ? 'custom' : String(nearestResolution(offered, settings.dpi))
      );
      if (!custom) settings.dpi = Number(dpi.value) || settings.dpi;
      customDpiRow.hidden = dpi.value !== 'custom';
      fill(paper, paperChoices(s, !!glass.box()), settings.paper);
      if (paper.value !== settings.paper) settings.paper = paper.value;
      sizeRow.hidden = !v.customSize;
      orientationRow.hidden = !v.orientation;
      sensitivityRow.hidden = !settings.removeBlank;
      // Output
      const docs: [string, string][] = [
        ...options.documents.map((d) => [`doc:${d.id}`, d.name] as [string, string]),
        ...picked.map((f, k) => [`file:${k}`, `${f.name} (not open)`] as [string, string]),
        [BROWSE, 'Browse…'],
      ];
      const was = appendTo.value;
      fill(appendTo, docs, was || (options.activeDocument ? `doc:${options.activeDocument}` : undefined));
      appendRow.hidden = settings.output !== 'append';
      multipleRows.hidden = settings.output !== 'multiple';
      ocrLangRow.hidden = !settings.ocr;
      if (options.mode === 'insert') {
        insertNumber.closest('label')!.hidden = insertPage.value !== 'number';
      }
      // Preview: for a flatbed that can
      tabPreview.hidden = !v.preview || watchMode;
      previewBtn.hidden = !v.preview || watchMode || pages.length > 0;
      if (tabPreview.hidden && shown === 'preview') showPane('pages');
      summary.textContent = watchMode
        ? 'Import from a scanner app'
        : caps
          ? settingsSummary(settings)
          : '';
      enable();
    }

    function renderPages() {
      const shownPages: ReviewPage[] = pages.map((p) => ({
        id: p.id,
        url: p.url,
        rotation: p.rotation,
        blank: p.blank,
        keep: p.keep,
        canRescan: p.rescannable && scanner.value !== WATCH,
      }));
      const n = included().length;
      tabPages.textContent = pages.length ? `Pages (${n})` : 'Pages';
      review.render(
        shownPages,
        scanner.value === WATCH
          ? watching
            ? `Waiting for new scans in ${watchFolder}…`
            : 'Choose the folder your scanner app saves to.'
          : 'Scanned pages show here as they arrive.'
      );
    }

    const included = () => pages.filter((p) => !p.blank || p.keep);

    function enable() {
      const working = busy !== '';
      const lock = (c: HTMLInputElement | HTMLSelectElement | HTMLButtonElement) => (c.disabled = working);
      for (const c of [
        preset,
        savePresetBtn,
        scanner,
        refreshBtn,
        addBtn,
        optionsBtn,
        folderBtn,
        src,
        sides,
        color,
        dpi,
        paper,
        threshold,
        customDpi,
        customW,
        customH,
        units,
        orientation,
        brightness,
        contrast,
        rotateAll,
        appendTo,
        saveFolderBtn,
        previewBtn,
      ])
        lock(c);
      // Pages scanned go together: the scanner stays the same
      if (pages.length) scanner.disabled = refreshBtn.disabled = addBtn.disabled = true;
      const ready = !!caps && !!device;
      scanBtn.disabled = working || !ready;
      previewBtn.disabled = working || !ready;
      moreBtn.disabled = reverseBtn.disabled = working || !ready;
      doneBtn.disabled = working || !included().length;
      if (busy === 'scan' || busy === 'preview') cancelBtn.textContent = 'Stop';
      else if (!confirmDiscard) cancelBtn.textContent = 'Cancel';
      review.lock(working);
      glass.setBusy(working);
    }

    /** The actions at the bottom: Scan (and Preview), or after a pass the
     *  three choices with the last one made offered first */
    function showActions() {
      if (!pages.length || scanner.value === WATCH) {
        actions.replaceChildren(cancelBtn, ...(scanner.value === WATCH ? (pages.length ? [doneBtn] : []) : [previewBtn, scanBtn]));
        doneBtn.className = 'accent-btn';
        enable();
        return;
      }
      const canReverse = !!lastPass?.feeder && !lastPass.duplex && lastPass.ids.length > 0;
      reverseBtn.hidden = !canReverse;
      const first = defaultAfterPass(scanPrefs().last.next, canReverse);
      for (const [b, k] of [
        [moreBtn, 'more'],
        [reverseBtn, 'reverse'],
        [doneBtn, 'done'],
      ] as const)
        b.className = k === first ? 'accent-btn' : 'pill-btn';
      actions.replaceChildren(cancelBtn, reverseBtn, moreBtn, doneBtn);
      enable();
      ({ more: moreBtn, reverse: reverseBtn, done: doneBtn })[first].focus();
    }

    /* Scanners ------------------------------------------------------------- */
    function noScannersText(r: { error?: ScanError; message?: string }) {
      none.replaceChildren(
        el(
          'p',
          {},
          r.error && r.error !== 'no-scanner'
            ? scanErrorMessage(r.error, r.message, options.isMac)
            : 'No scanners found.'
        ),
        el(
          'ul',
          {},
          el('li', {}, "Check that the scanner is on, and connected by USB or on the same network as this computer."),
          el('li', {}, 'A network scanner that isn’t found: select Add by IP address.'),
          el(
            'li',
            {},
            options.isMac
              ? 'Scanners that work in Image Capture work here.'
              : 'Scanners that work in Windows Scan or with a TWAIN driver work here.'
          ),
          el('li', {}, 'A scanner that only works with its own app: choose Import from a scanner app.')
        )
      );
    }

    function fillScanners(keep?: string) {
      fill(
        scanner,
        [
          ...scanners.map(
            (s) =>
              [
                s.key,
                s.connection === 'network' && !/network/i.test(s.name)
                  ? `${s.name} (network)`
                  : s.name,
              ] as [string, string]
          ),
          [WATCH, 'Import from a scanner app…'],
        ],
        keep
      );
    }

    async function loadScanners() {
      busy = 'list';
      enable();
      status.textContent = 'Looking for scanners…';
      none.hidden = true;
      const r = await bridge.scanners().catch((err: unknown) => ({
        ok: false,
        scanners: [] as Scanner[],
        error: 'failed' as ScanError,
        message: String((err as Error)?.message ?? err),
      }));
      if (closed) return;
      busy = '';
      scanners = r.scanners;
      const want = entry?.key ?? stored.last.scanner;
      fillScanners(
        scanners.some((s) => s.key === want)
          ? want
          : (scanners.find((s) => s.connection !== 'network') ?? scanners[0])?.key
      );
      none.hidden = scanners.length > 0;
      if (!scanners.length) noScannersText(r);
      status.textContent = '';
      await chooseScanner();
    }

    /** The scanner (or the folder watch) chosen: what it can do */
    async function chooseScanner() {
      if (scanner.value === WATCH) {
        entry = device = undefined;
        caps = null;
        refresh();
        renderPages();
        showActions();
        return;
      }
      if (watching) await stopWatching();
      entry = scanners.find((s) => s.key === scanner.value);
      if (!entry) {
        caps = null;
        device = undefined;
        refresh();
        showActions();
        return;
      }
      // This scanner's own choices (driver, source, paper…)
      Object.assign(settings, pick(settingsFor(presetId, entry.key), SCANNER_KEYS));
      writeControls();
      await loadCaps();
    }

    async function loadCaps() {
      if (!entry) return;
      device = chooseDevice(entry.devices, settings.driver);
      busy = 'caps';
      enable();
      status.textContent = 'Getting the scanner ready…';
      const r: { ok: boolean; caps?: ScanCaps; error?: ScanError; message?: string } =
        await bridge
          .scannerCaps(device!.id)
          .catch((err: unknown) => ({ ok: false, error: 'failed', message: String(err) }));
      if (closed) return;
      busy = '';
      caps = r.ok ? (r.caps ?? null) : null;
      status.textContent = r.ok ? '' : scanErrorMessage(r.error, r.message, options.isMac);
      // A new scanner: its glass preview no longer applies
      glass.clear('Select Preview for a quick look at what’s on the glass.');
      if (settings.paper === 'preview') settings.paper = 'max';
      refresh();
      renderPages();
      showActions();
      if (!pages.length && source()?.canPreview && shown !== 'preview' && !options.autoStart)
        showPane('preview');
      if (options.autoStart && caps) {
        options.autoStart = false;
        void scanPass('first');
      }
    }

    /* Remembering ------------------------------------------------------------ */
    function remember() {
      const p = scanPrefs();
      const presetPart = omit(settings, [...SCANNER_KEYS, ...OUTPUT_KEYS]);
      if (presetId.startsWith('custom:')) {
        const c = p.custom.find((x) => `custom:${x.id}` === presetId);
        if (c) c.settings = presetPart;
      } else p.presets[presetId] = presetPart;
      if (entry) p.scanners[entry.key] = pick(settings, SCANNER_KEYS);
      p.output = pick(settings, OUTPUT_KEYS);
      p.last = { ...p.last, preset: presetId, ...(entry ? { scanner: entry.key } : {}) };
      saveScanPrefs(p);
    }

    /* Preview ---------------------------------------------------------------- */
    async function preview() {
      if (busy || !device || !caps) return;
      readControls();
      const s = caps.sources.find((x) => x.id === 'flatbed');
      if (!s) return;
      showPane('preview');
      busy = 'preview';
      enable();
      status.textContent = 'Previewing…';
      const { request } = buildRequest({ ...settings, source: 'flatbed', paper: 'max', color: 'color' }, caps, s, null);
      const r: ScanResult & { page?: ScanPageInfo & { data: Uint8Array } } = await bridge
        .scanPreview(device.id, { ...request, dpi: 50, color: s.colors.includes('color') ? 'color' : 'gray' })
        .catch((err: unknown) => ({ ok: false, error: 'failed', message: String(err) }));
      if (closed) return;
      busy = '';
      if (r.ok && r.page) {
        const blob = new Blob([r.page.data as BlobPart], { type: r.page.mime });
        const size = { width: s.maxWidth, height: s.maxHeight };
        const box: Box | null = await findDocument(blob, size).catch((): null => null);
        glass.show(blob, size, box ?? { x: 0, y: 0, width: size.width, height: size.height });
        if (box) settings.paper = 'preview';
        status.textContent = box
          ? 'The box shows what will be scanned. Drag its corners to change it.'
          : 'Nothing stood out on the glass: drag the corners to choose what to scan.';
      } else if (!r.cancelled) {
        status.textContent = scanErrorMessage(r.error, r.message, options.isMac);
      } else status.textContent = '';
      refresh();
    }

    /* Scanning --------------------------------------------------------------- */
    /** Cleans up each page as it arrives, one after another */
    let processing: Promise<void> = Promise.resolve();
    const process = (page: Page, data: Uint8Array, info: ScanPageInfo, plan: ProcessPlan) => {
      processing = processing.then(async () => {
        try {
          const done = await processPage({ data, mime: info.mime, dpi: info.dpi }, plan);
          if (page.source.kind === 'scan') page.source.processed = done;
          page.blank = done.blank;
          page.url = thumb(done.image);
        } catch {
          // Shown as it came, if it can't be cleaned up
          const blob = new Blob([data as BlobPart], { type: info.mime });
          if (page.source.kind === 'scan')
            page.source.processed = {
              image: blob,
              width: info.width ?? 0,
              height: info.height ?? 0,
              dpi: info.dpi,
              color: 'color',
              blank: false,
            };
          page.url = thumb(blob);
        }
        if (!closed) renderPages();
      });
    };

    let confirmDiscard = false;
    async function scanPass(kind: 'first' | 'more' | 'reverse' | 'rescan', rescanId?: number) {
      if (busy || !device || !caps) return;
      readControls();
      remember();
      const s = source();
      const { request, plan } = buildRequest(settings, caps, s, glass.box());
      if (kind === 'reverse') {
        request.source = 'feeder';
        request.duplex = false;
      }
      const got: Page[] = [];
      let wanted = Infinity;
      if (kind === 'rescan') wanted = 1;
      const off = bridge.onScanPage((data, info) => {
        if (got.length >= wanted) return;
        const page: Page = {
          id: nextPageId++,
          source: { kind: 'scan', processed: null, side: info.side },
          url: '',
          // The backs of a top-bound stack come upside down
          rotation:
            settings.flipBacks && (kind === 'reverse' || info.side === 'back') ? 180 : 0,
          blank: false,
          keep: false,
          rescannable: true,
        };
        got.push(page);
        if (kind === 'first' || kind === 'more') {
          pages.push(page);
          renderPages();
          review.showLast();
        }
        process(page, data, info, plan);
        const total = pages.length + (kind === 'reverse' ? got.length : 0);
        status.textContent = `Scanned ${total} page${total === 1 ? '' : 's'}…`;
        // A rescan wants one page: the rest of a feeder stays in it
        if (got.length >= wanted) void bridge.cancelScan();
      });
      const offStatus = bridge.onScanStatus((m) => (status.textContent = m));
      busy = 'scan';
      confirmDiscard = false;
      showPane('pages');
      enable();
      status.textContent =
        kind === 'reverse'
          ? 'Scanning the reverse sides…'
          : kind === 'rescan'
            ? 'Rescanning the page…'
            : 'Scanning…';
      let result: ScanResult;
      try {
        result = await bridge.scan(device.id, request);
      } catch (err) {
        result = { ok: false, error: 'failed', message: String((err as Error)?.message ?? err) };
      } finally {
        off();
        offStatus();
      }
      await processing;
      if (closed) return;
      busy = '';
      if (kind === 'reverse' && got.length && lastPass) {
        // The backs of the last pass, woven in after their fronts
        const fronts = lastPass.ids
          .map((id) => pages.find((p) => p.id === id))
          .filter((p): p is Page => !!p);
        const start = pages.indexOf(fronts[0]);
        const rest = pages.filter((p) => !fronts.includes(p));
        rest.splice(Math.max(0, start), 0, ...interleave(fronts, got));
        pages = rest;
        lastPass = null;
      } else if (kind === 'rescan' && got.length) {
        const at = pages.findIndex((p) => p.id === rescanId);
        if (at >= 0) pages[at] = got[0];
        else pages.push(got[0]);
      } else if ((kind === 'first' || kind === 'more') && got.length) {
        lastPass = { ids: got.map((p) => p.id), feeder: request.source === 'feeder', duplex: request.duplex };
      }
      renderPages();
      const n = included().length;
      const blanks = pages.filter((p) => p.blank && !p.keep).length;
      const count = `${n} page${n === 1 ? '' : 's'} scanned${blanks ? ` (${blanks} blank left out)` : ''}.`;
      if (result.ok) {
        // Both sides from a one-sided feeder: now the backs
        const needBacks =
          kind !== 'reverse' && settings.sides === 'both' && request.source === 'feeder' && !request.duplex && got.length > 0;
        status.textContent = result.cancelled
          ? `Scanning stopped. ${count}`
          : needBacks
            ? `${count} Turn the stack over, put it back in the feeder, then select Scan reverse sides.`
            : `${count} Scan more, or select Scan is complete.`;
        if (!result.cancelled && !settings.promptMore && !needBacks && pages.length) {
          await finish();
          return;
        }
        if (needBacks) {
          const p = scanPrefs();
          p.last = { ...p.last, next: 'reverse' };
          saveScanPrefs(p);
        }
      } else {
        status.textContent =
          scanErrorMessage(result.error, result.message, options.isMac) + (pages.length ? ` ${count}` : '');
      }
      refresh();
      showActions();
    }

    /** After a pass: the choice is remembered for next time */
    async function after(choice: AfterPass) {
      const p = scanPrefs();
      p.last = { ...p.last, next: choice };
      saveScanPrefs(p);
      if (choice === 'done') return finish();
      return scanPass(choice === 'reverse' ? 'reverse' : 'more');
    }

    /* Import from a scanner app ---------------------------------------------- */
    let offImport: (() => void) | null = null;
    async function startWatching(dir: { path: string; name: string }) {
      const r: { ok: boolean; message?: string } = await bridge
        .watchScanFolder(dir.path)
        .catch((err: unknown) => ({ ok: false, message: String(err) }));
      if (closed) return;
      if (!r.ok) {
        status.textContent = `That folder can't be watched${r.message ? `: ${r.message}` : '.'}`;
        return;
      }
      watching = dir.path;
      watchFolder = dir.name;
      folderName.textContent = dir.path;
      offImport ??= bridge.onScanImport((f) => void imported(f));
      status.textContent = `Waiting for new scans in ${dir.name}…`;
      renderPages();
    }
    async function stopWatching() {
      offImport?.();
      offImport = null;
      watching = '';
      await bridge.watchScanFolder(null).catch((): null => null);
    }
    async function imported(f: ScanImport) {
      if (closed) return;
      readControls();
      if (f.mime === 'application/pdf') {
        const thumbs: string[] | null = await pdfPageThumbs(f.data).catch((): null => null);
        if (!thumbs) {
          status.textContent = `${f.name} couldn't be read.`;
          return;
        }
        thumbs.forEach((url, index) => {
          if (url) urls.add(url);
          pages.push({
            id: nextPageId++,
            source: { kind: 'pdf', bytes: f.data, index },
            url,
            rotation: 0,
            blank: false,
            keep: false,
            rescannable: false,
          });
        });
      } else if (f.mime.startsWith('image/')) {
        const { plan } = buildRequest(settings, null, undefined, null);
        const page: Page = {
          id: nextPageId++,
          source: { kind: 'scan', processed: null, side: 'front' },
          url: '',
          rotation: 0,
          blank: false,
          keep: false,
          rescannable: false,
        };
        pages.push(page);
        // (an image's own resolution isn't read: scanner apps save 300 dpi)
        process(page, f.data, { index: 0, dpi: 300, side: 'front', mime: f.mime }, plan);
        await processing;
      }
      if (closed) return;
      status.textContent = `Added ${f.name}. Select Scan is complete when you have everything.`;
      renderPages();
      showActions();
    }

    /* Finishing --------------------------------------------------------------- */
    async function partsFor(list: Page[], progress: (k: number) => void): Promise<PdfPart[]> {
      const parts: PdfPart[] = [];
      for (const [k, p] of list.entries()) {
        progress(k);
        if (p.source.kind === 'pdf')
          parts.push({ kind: 'pdf', bytes: p.source.bytes, index: p.source.index, rotation: p.rotation });
        else if (p.source.processed)
          parts.push({ kind: 'image', page: await encodePage(p.source.processed, settings, p.rotation) });
      }
      return parts;
    }

    async function makePdf(list: Page[], label: string): Promise<Uint8Array> {
      const parts = await partsFor(list, (k) => (status.textContent = `Making ${label}… page ${k + 1} of ${list.length}`));
      let pdf = await buildPdf(parts);
      if (settings.ocr) {
        status.textContent = 'Recognizing text…';
        pdf = await options.recognize(pdf, settings.ocrLanguage, (text) => (status.textContent = `Recognizing text: ${text}`));
      }
      return pdf;
    }

    async function finish() {
      if (busy) return;
      readControls();
      const list = included();
      if (!list.length) {
        status.textContent = 'Every page was left out. Keep a page, or scan some.';
        return;
      }
      remember();
      busy = 'finish';
      enable();
      try {
        if (options.mode === 'insert') {
          const at: InsertAt = {
            position: insertPos.value as InsertAt['position'],
            page: insertPage.value as InsertAt['page'],
            number: Number(insertNumber.value),
          };
          const pdf = await makePdf(list, 'the pages');
          return close({ output: 'insert', pdf, pages: list.length, after: insertAfter(at, options.insert?.total ?? 1) });
        }
        if (settings.output === 'multiple') {
          saveFolder ??= await bridge.chooseFolder('Save the scanned files in');
          if (!saveFolder) {
            status.textContent = 'Choose a folder for the files.';
            return;
          }
          const groups = splitIntoFiles(list.length, settings.perFile);
          const names = fileNames(settings.prefix, groups.length);
          const files: { name: string; data: Uint8Array }[] = [];
          for (const [k, g] of groups.entries())
            files.push({ name: names[k], data: await makePdf(g.map((i) => list[i]), `file ${k + 1} of ${groups.length}`) });
          status.textContent = 'Saving…';
          const saved = await bridge.saveFiles(saveFolder.path, files);
          if (!saved?.length) throw new Error("the files couldn't be saved there");
          return close({ output: 'multiple', saved, folder: saveFolder.path, pages: list.length });
        }
        if (settings.output === 'append') {
          const target = appendTo.value;
          const to = target.startsWith('doc:')
            ? { kind: 'open' as const, id: target.slice(4) }
            : target.startsWith('file:') && picked[Number(target.slice(5))]
              ? { kind: 'file' as const, file: picked[Number(target.slice(5))] }
              : null;
          if (!to) {
            status.textContent = 'Choose the file to add the pages to.';
            return;
          }
          const pdf = await makePdf(list, 'the pages');
          return close({ output: 'append', pdf, pages: list.length, to });
        }
        const pdf = await makePdf(list, 'the PDF');
        close({ output: 'new', pdf, pages: list.length, pdfa: settings.pdfa, metadata: settings.metadata });
      } catch (err) {
        status.textContent = `The PDF couldn't be made: ${(err as Error)?.message ?? err}`;
      } finally {
        if (!closed) {
          busy = '';
          enable();
        }
      }
    }

    /* Closing ------------------------------------------------------------------ */
    async function cancel() {
      if (busy === 'scan' || busy === 'preview') {
        status.textContent = 'Stopping…';
        await bridge.cancelScan().catch(() => false);
        return;
      }
      if (busy) return;
      // Scanned pages aren't thrown away on one click
      if (pages.length && !confirmDiscard) {
        confirmDiscard = true;
        cancelBtn.textContent = `Discard ${pages.length} page${pages.length === 1 ? '' : 's'}`;
        status.textContent = 'Select again to discard the scanned pages, or Scan is complete to keep them.';
        return;
      }
      close(null);
    }

    function close(outcome: ScanOutcome | null) {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      if (watching) void stopWatching();
      // (never leave the scanner held)
      if (busy === 'scan' || busy === 'preview') void bridge.cancelScan();
      backdrop.remove();
      for (const u of urls) URL.revokeObjectURL(u);
      resolve(outcome);
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const all = document.querySelectorAll('.dlg-backdrop');
      if (all[all.length - 1] !== backdrop) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      void cancel();
    };
    document.addEventListener('keydown', onKey, true);

    /* Small dialogs over this one ------------------------------------------- */
    function smallDialog(
      heading: string,
      body: HTMLElement,
      okText: string,
      onOk: () => Promise<boolean> | boolean
    ) {
      const err = el('p', { class: 'muted sd-status', role: 'status' });
      const cancelB = el('button', { type: 'button', class: 'quiet-btn' }, 'Cancel');
      const okB = el('button', { type: 'button', class: 'accent-btn' }, okText);
      const shut = () => {
        layer.remove();
        document.removeEventListener('keydown', esc, true);
      };
      const layer = el(
        'div',
        { class: 'dlg-backdrop' },
        el(
          'div',
          { class: 'dlg', role: 'dialog', 'aria-label': heading },
          el('div', { class: 'dlg-head' }, el('h2', {}, heading)),
          el('div', { class: 'dlg-body prefs' }, body, err, el('div', { class: 'dlg-actions' }, cancelB, okB))
        )
      );
      const esc = (e: KeyboardEvent) => {
        if (e.key !== 'Escape') return;
        const all = document.querySelectorAll('.dlg-backdrop');
        if (all[all.length - 1] !== layer) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        shut();
      };
      document.addEventListener('keydown', esc, true);
      cancelB.addEventListener('click', shut);
      const ok = async () => {
        okB.disabled = true;
        try {
          if (await onOk()) shut();
        } catch (e) {
          err.textContent = String((e as Error)?.message ?? e);
        } finally {
          okB.disabled = false;
        }
      };
      okB.addEventListener('click', () => void ok());
      body.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
          e.preventDefault();
          void ok();
        }
      });
      showModal(layer);
      return { error: (t: string) => (err.textContent = t) };
    }

    function addByAddress() {
      const input = el('input', {
        type: 'text',
        class: 'dlg-input',
        'aria-label': 'IP address or host name',
        placeholder: 'e.g. 192.168.1.40',
        spellcheck: 'false',
      });
      const d = smallDialog(
        'Add a network scanner',
        el(
          'div',
          {},
          el('p', {}, 'The scanner’s IP address or host name (on its screen, or on its network settings page):'),
          input
        ),
        'Add',
        async () => {
          const r = await bridge.addScanner(input.value.trim());
          if (!r.ok || !r.scanner) {
            d.error(
              r.error === 'invalid'
                ? 'That isn’t an address. It looks like 192.168.1.40 or scanner.local.'
                : r.error === 'unsupported'
                  ? 'Network scanning isn’t available here.'
                  : `No scanner answered at ${input.value.trim()}. Check the address, and that the scanner is on.`
            );
            return false;
          }
          scanners = [...scanners.filter((s) => s.key !== r.scanner!.key), r.scanner];
          fillScanners(r.scanner.key);
          none.hidden = true;
          await chooseScanner();
          return true;
        }
      );
      queueMicrotask(() => input.focus());
    }

    function scannerOptions() {
      if (!entry || !caps) return;
      const v = visibility(caps, source(), settings, entry.devices);
      const driver = select('Driver');
      fill(
        driver,
        [
          ['auto', `Automatic (${entry.devices[0].label})`],
          ...entry.devices.map((d) => [d.driver, d.label] as [string, string]),
        ],
        settings.driver
      );
      const native = check('Show the scanner’s own window');
      native.input.checked = settings.nativeUi;
      const transfer = select('Transfer method');
      fill(
        transfer,
        [
          ['native', 'Native'],
          ['memory', 'Memory'],
        ],
        settings.transfer
      );
      const invert = check('Invert black and white images');
      invert.input.checked = settings.invert;
      const stop = check('Stop when two sheets are fed together');
      stop.input.checked = settings.doubleFeedStop;
      const timeout = number('Seconds to wait', 5, 600);
      timeout.value = String(settings.networkTimeout);
      const body = el(
        'div',
        { class: 'sd-options' },
        v.driver && row('Driver', driver),
        v.nativeUi && native.label,
        v.transfer && row('Transfer method', transfer),
        invert.label,
        v.doubleFeedStop && stop.label,
        v.networkTimeout && row('Wait for a slow network scanner (seconds)', timeout)
      );
      smallDialog('Scanner options', body, 'OK', async () => {
        const before = settings.driver;
        settings.driver = driver.value as ScanSettings['driver'];
        settings.nativeUi = native.input.checked;
        settings.transfer = transfer.value as ScanSettings['transfer'];
        settings.invert = invert.input.checked;
        settings.doubleFeedStop = stop.input.checked;
        const t = Math.round(Number(timeout.value));
        if (t >= 5 && t <= 600) settings.networkTimeout = t;
        remember();
        if (settings.driver !== before) await loadCaps();
        else refresh();
        return true;
      });
    }

    function savePreset() {
      const input = el('input', {
        type: 'text',
        class: 'dlg-input',
        'aria-label': 'Preset name',
        maxlength: '60',
      });
      const d = smallDialog(
        'Save as preset',
        el('div', {}, el('p', {}, 'A name for these settings:'), input),
        'Save',
        () => {
          const name = input.value.trim();
          if (!name) {
            d.error('Give the preset a name.');
            return false;
          }
          readControls();
          const p = scanPrefs();
          const existing = p.custom.find((c) => c.name.toLowerCase() === name.toLowerCase());
          const id = existing?.id ?? crypto.randomUUID().slice(0, 8);
          const entrySettings = omit(settings, [...SCANNER_KEYS, ...OUTPUT_KEYS]);
          if (existing) existing.settings = entrySettings;
          else p.custom.push({ id, name, settings: entrySettings });
          saveScanPrefs(p);
          presetId = `custom:${id}`;
          remember();
          writeControls();
          refresh();
          status.textContent = `Saved the preset “${name}”.`;
          return true;
        }
      );
      queueMicrotask(() => input.focus());
    }

    /* Wiring ----------------------------------------------------------------- */
    preset.addEventListener('change', () => {
      presetId = preset.value;
      const keep = pick(settings, [...SCANNER_KEYS, ...OUTPUT_KEYS]);
      settings = { ...settingsFor(presetId, entry?.key), ...keep, ocr: settings.ocr };
      writeControls();
      refresh();
    });
    savePresetBtn.addEventListener('click', savePreset);
    scanner.addEventListener('change', () => void chooseScanner());
    refreshBtn.addEventListener('click', () => void loadScanners());
    addBtn.addEventListener('click', addByAddress);
    optionsBtn.addEventListener('click', scannerOptions);
    folderBtn.addEventListener('click', async () => {
      const dir = await bridge.chooseFolder('The folder your scanner app saves to');
      if (dir) await startWatching(dir);
    });
    saveFolderBtn.addEventListener('click', async () => {
      const dir = await bridge.chooseFolder('Save the scanned files in');
      if (dir) {
        saveFolder = dir;
        saveFolderName.textContent = dir.path;
      }
    });
    appendTo.addEventListener('change', async () => {
      if (appendTo.value !== BROWSE) return;
      const f = await options.browse();
      if (f) {
        picked.push(f);
        refresh();
        appendTo.value = `file:${picked.length - 1}`;
      } else {
        appendTo.value = options.activeDocument ? `doc:${options.activeDocument}` : '';
        refresh();
      }
    });
    units.addEventListener('change', () => {
      const was = settings.units;
      settings.units = units.value as ScanSettings['units'];
      // The same size in the other units
      customW.value = String(fromInches(toInches(Number(customW.value), was), settings.units));
      customH.value = String(fromInches(toInches(Number(customH.value), was), settings.units));
      readControls();
      refresh();
    });
    for (const c of [
      src,
      sides,
      flip.input,
      color,
      threshold,
      dpi,
      customDpi,
      paper,
      customW,
      customH,
      orientation,
      brightness,
      contrast,
      deskew.input,
      autoCrop.input,
      background,
      descreen.input,
      sharpen,
      despeckle.input,
      removeBlank.input,
      sensitivity,
      edgeShadow.input,
      autoRotate.input,
      rotateAll,
      quality,
      compression,
      bwCompression,
      outNew.input,
      outAppend.input,
      outMultiple.input,
      perFile,
      prefix,
      insertPos,
      insertPage,
      promptMore.input,
      ocr.input,
      ocrLang,
      pdfa.input,
      metadata.input,
    ])
      c.addEventListener('change', () => {
        readControls();
        confirmDiscard = false;
        refresh();
      });

    if (options.mode === 'insert' && options.insert) {
      const { total, page } = options.insert;
      fill(insertPage, [
        ['first', 'First'],
        ['last', 'Last'],
        ['number', `Page (of ${total})`],
      ]);
      insertPage.value = 'number';
      insertNumber.value = String(page);
    }

    // (modal: the page behind is inert, focus comes back when it closes)
    showModal(backdrop);
    writeControls();
    showPane('pages');
    renderPages();
    showActions();
    void loadScanners();
    scanner.focus();
  });
}
