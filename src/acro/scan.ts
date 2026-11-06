/**
 * Create a PDF from a scanner (#35), the way Acrobat's Create ▸ Scanner
 * works: choose the scanner, flatbed or document feeder (one or both sides),
 * color mode (including Autodetect), resolution, paper and how small the
 * file should be; scan; then scan more pages, scan the reverse sides of a
 * one-sided stack, or finish. The pages become a new document, or go at the
 * end of the open one. The scanning itself happens in the desktop shell
 * (desktop/scan.cjs: WIA on Windows, ImageCaptureCore on macOS).
 */
import { PDFDocument } from 'pdf-lib';
import type {
  DesktopBridge,
  ScanError,
  ScanRequest,
  ScanResult,
  ScanSource,
  Scanner,
} from './desktop';
import { icon } from './icons';

export type ScanBridge = Required<
  Pick<
    DesktopBridge,
    'scanners' | 'scannerCaps' | 'scan' | 'cancelScan' | 'onScanPage'
  >
>;

export type ColorMode = 'auto' | 'color' | 'gray' | 'bw';

/** Paper, in inches; "max" is the whole area the scanner can scan */
export const SCAN_PAPERS = {
  letter: { label: 'Letter', width: 8.5, height: 11 },
  legal: { label: 'Legal', width: 8.5, height: 14 },
  a4: { label: 'A4', width: 8.27, height: 11.69 },
  a5: { label: 'A5', width: 5.83, height: 8.27 },
  max: { label: 'Whole scanning area', width: 0, height: 0 },
} as const;
export type ScanPaper = keyof typeof SCAN_PAPERS;

/** Resolutions offered when the scanner has them (Acrobat's usual set) */
const USUAL_DPI = [150, 200, 300, 400, 600];

export interface ScanSettings {
  scanner: string;
  source: 'flatbed' | 'feeder';
  duplex: boolean;
  color: ColorMode;
  dpi: number;
  paper: ScanPaper;
  /** JPEG quality for color and gray pages, 0.3 (small) to 0.95 (high) */
  quality: number;
  output: 'new' | 'append';
  ocr: boolean;
}

/** A page as the scanner sent it */
export interface ScannedPage {
  data: Uint8Array;
  mime: string;
  dpi: number;
}

/** A page ready for the PDF */
export interface PreparedPage {
  bytes: Uint8Array;
  kind: 'jpg' | 'png';
  width: number;
  height: number;
  dpi: number;
}

export interface ScanOutcome {
  pdf: Uint8Array;
  pages: number;
  output: 'new' | 'append';
  ocr: boolean;
}

const SETTINGS_KEY = 'paperwing:scanSettings';

/** Letter where it's used, A4 everywhere else */
export function defaultPaper(locale: string): ScanPaper {
  return /^(en-US|en-CA|es-MX|es-US|fr-CA)$|-(US|CA|MX|PH|CL|CO|VE|GT|PR)$/i.test(
    locale
  )
    ? 'letter'
    : 'a4';
}

export function defaultSettings(locale = 'en-US'): ScanSettings {
  return {
    scanner: '',
    source: 'flatbed',
    duplex: false,
    color: 'auto',
    dpi: 300,
    paper: defaultPaper(locale),
    quality: 0.75,
    output: 'new',
    ocr: false,
  };
}

/** The resolutions to offer: the usual ones it has, else all it has */
export function offeredResolutions(source: ScanSource | undefined): number[] {
  const all = source?.resolutions ?? [];
  if (!all.length) return USUAL_DPI;
  const usual = USUAL_DPI.filter((d) => all.includes(d));
  return usual.length ? usual : all;
}

/** The offered resolution nearest the one wanted */
export function nearestResolution(offered: number[], wanted: number): number {
  return offered.reduce(
    (best, d) => (Math.abs(d - wanted) < Math.abs(best - wanted) ? d : best),
    offered[0] ?? wanted
  );
}

/** The area to scan, in inches, within what the source can scan */
export function scanArea(
  paper: ScanPaper,
  source: ScanSource | undefined
): { width: number; height: number } {
  const maxW = source?.width || 8.5;
  const maxH = source?.height || 11.69;
  if (paper === 'max') return { width: maxW, height: maxH };
  const p = SCAN_PAPERS[paper];
  return { width: Math.min(p.width, maxW), height: Math.min(p.height, maxH) };
}

/** The request the shell gets ("auto" scans in color and decides later) */
export function scanRequest(
  s: ScanSettings,
  source: ScanSource | undefined
): ScanRequest {
  const color: ScanRequest['color'] =
    s.color === 'auto'
      ? source?.colors.includes('color') === false
        ? 'gray'
        : 'color'
      : s.color;
  return {
    source: s.source,
    duplex: s.source === 'feeder' && s.duplex && !!source?.duplex,
    color,
    dpi: s.dpi,
    ...scanArea(s.paper, source),
  };
}

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

/** Whether a page (RGBA pixels) has no real color: Autodetect keeps it gray */
export function looksGray(px: Uint8ClampedArray, step = 7): boolean {
  let colorful = 0;
  let seen = 0;
  for (let o = 0; o < px.length; o += 4 * step) {
    const r = px[o];
    const g = px[o + 1];
    const b = px[o + 2];
    seen++;
    if (Math.max(r, g, b) - Math.min(r, g, b) > 40) colorful++;
  }
  // A few colored specks (scanner noise, a stamp's edge) don't count
  return seen > 0 && colorful / seen < 0.002;
}

/** A scanned page made ready for the PDF: JPEG at the chosen quality for
 *  color and gray (gray drawn in gray), lossless for black and white */
export async function preparePage(
  page: ScannedPage,
  color: ColorMode,
  quality: number
): Promise<PreparedPage> {
  const blob = new Blob([page.data as BlobPart], { type: page.mime });
  const bitmap = await createImageBitmap(blob);
  const { width, height } = bitmap;
  if (color === 'bw') {
    bitmap.close();
    if (page.mime === 'image/png')
      return { bytes: page.data, kind: 'png', width, height, dpi: page.dpi };
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  if (color === 'bw') {
    // (a JPEG from the scanner: drawn and kept lossless)
    ctx.drawImage(await createImageBitmap(blob), 0, 0);
  } else {
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
  }
  const image = ctx.getImageData(0, 0, width, height);
  const gray =
    color !== 'bw' &&
    (color === 'gray' || (color === 'auto' && looksGray(image.data)));
  if (gray) {
    const px = image.data;
    for (let o = 0; o < px.length; o += 4) {
      const y = Math.round(
        0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2]
      );
      px[o] = px[o + 1] = px[o + 2] = y;
    }
    ctx.putImageData(image, 0, 0);
  }
  const lossless = color === 'bw';
  const out = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(
      resolve,
      lossless ? 'image/png' : 'image/jpeg',
      lossless ? undefined : quality
    )
  );
  if (!out) throw new Error("A scanned page couldn't be prepared");
  return {
    bytes: new Uint8Array(await out.arrayBuffer()),
    kind: lossless ? 'png' : 'jpg',
    width,
    height,
    dpi: page.dpi,
  };
}

/** One PDF page per image, at its real size (from its resolution) */
export async function buildPdf(pages: PreparedPage[]): Promise<Uint8Array> {
  // (pdf-lib would name itself the producer when saving)
  const doc = await PDFDocument.create({ updateMetadata: false });
  const now = new Date();
  doc.setProducer('Paperwing');
  doc.setCreator('Paperwing');
  doc.setCreationDate(now);
  doc.setModificationDate(now);
  for (const p of pages) {
    const image =
      p.kind === 'jpg'
        ? await doc.embedJpg(p.bytes)
        : await doc.embedPng(p.bytes);
    const w = (p.width / p.dpi) * 72;
    const h = (p.height / p.dpi) * 72;
    doc.addPage([w, h]).drawImage(image, { x: 0, y: 0, width: w, height: h });
  }
  return doc.save();
}

/** What a failed scan says */
export function scanErrorMessage(
  error: ScanError | undefined,
  message?: string
) {
  switch (error) {
    case 'feeder-empty':
      return 'The document feeder is empty. Put the pages in, then select Scan.';
    case 'paper-jam':
      return 'The paper is jammed. Clear it, then scan again.';
    case 'busy':
      return 'The scanner is busy. Wait for it to finish, then scan again.';
    case 'offline':
      return "The scanner isn't responding. Check that it's on and connected.";
    case 'cover-open':
      return "The scanner's cover is open. Close it, then scan again.";
    case 'warming-up':
      return 'The scanner is warming up. Try again in a moment.';
    case 'no-scanner':
      return "The scanner wasn't found. Check that it's on and connected, then select Refresh.";
    case 'cancelled':
      return 'Scanning stopped.';
    default:
      return `The scan didn't work${message ? `: ${message}` : '.'}`;
  }
}

function remembered(): Partial<ScanSettings> {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

function remember(s: ScanSettings) {
  try {
    const { output: _o, ...keep } = s;
    void _o;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(keep));
  } catch {
    /* storage unavailable: the defaults next time */
  }
}

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

function fillSelect(
  s: HTMLSelectElement,
  options: [string, string][],
  value?: string
) {
  s.replaceChildren(
    ...options.map(([v, text]) => el('option', { value: v }, text))
  );
  if (value !== undefined && options.some(([v]) => v === value))
    s.value = value;
}

const row = (label: string, ...controls: HTMLElement[]) =>
  el(
    'label',
    { class: 'pref-row' },
    el('span', {}, el('b', {}, label)),
    ...controls
  );

const COLOR_LABELS: Record<ColorMode, string> = {
  auto: 'Autodetect',
  color: 'Color',
  gray: 'Grayscale',
  bw: 'Black and white',
};

export interface ScanDialogOptions {
  /** The open document pages can be added to (its name), if any */
  appendTo: string | null;
  isMac: boolean;
}

/** Shows the scan dialog; resolves with the scanned document, or null */
export function showScanDialog(
  bridge: ScanBridge,
  options: ScanDialogOptions
): Promise<ScanOutcome | null> {
  const settings: ScanSettings = {
    ...defaultSettings(navigator.language),
    ...remembered(),
    output: 'new',
  };
  if (!options.appendTo) settings.output = 'new';

  return new Promise((resolve) => {
    let scanners: Scanner[] = [];
    let sources: ScanSource[] = [];
    let busy = false;
    let closed = false;
    /** The pages so far, in reading order */
    let pages: ScannedPage[] = [];
    /** The last pass's pages (fronts, for Scan reverse sides) */
    let lastPass: ScannedPage[] = [];
    let lastPassFeeder = false;
    let lastPassDuplex = false;
    const thumbs: string[] = [];

    /* Controls ------------------------------------------------------------ */
    const scanner = el('select', {
      class: 'pref-select',
      'aria-label': 'Scanner',
    });
    const refreshBtn = el(
      'button',
      {
        type: 'button',
        class: 'tb-btn',
        title: 'Refresh',
        'aria-label': 'Refresh the scanner list',
      },
      icon('refresh', 16)
    );
    const source = el('select', {
      class: 'pref-select',
      'aria-label': 'Source',
    });
    const sides = el('select', { class: 'pref-select', 'aria-label': 'Sides' });
    fillSelect(sides, [
      ['one', 'One side'],
      ['both', 'Both sides'],
    ]);
    const color = el('select', {
      class: 'pref-select',
      'aria-label': 'Color mode',
    });
    const dpi = el('select', {
      class: 'pref-select',
      'aria-label': 'Resolution',
    });
    const paper = el('select', {
      class: 'pref-select',
      'aria-label': 'Paper size',
    });
    fillSelect(
      paper,
      (Object.keys(SCAN_PAPERS) as ScanPaper[]).map((k) => [
        k,
        SCAN_PAPERS[k].label,
      ]),
      settings.paper
    );
    const quality = el('input', {
      type: 'range',
      class: 'sd-quality',
      min: '0.3',
      max: '0.95',
      step: '0.05',
      'aria-label': 'File size and quality',
    });
    quality.value = String(settings.quality);
    const output = el('select', {
      class: 'pref-select',
      'aria-label': 'Output',
    });
    fillSelect(
      output,
      [
        ['new', 'New document'],
        ...(options.appendTo
          ? ([['append', `Add to ${options.appendTo}`]] as [string, string][])
          : []),
      ],
      settings.output
    );
    const ocr = el('input', {
      type: 'checkbox',
      'aria-label': 'Recognize text (OCR)',
    });
    ocr.checked = settings.ocr;

    const sidesRow = row('Sides', sides);
    const status = el('p', { class: 'muted sd-status', role: 'status' });
    const strip = el('div', {
      class: 'sd-strip',
      'aria-label': 'Scanned pages',
    });
    const none = el(
      'p',
      { class: 'sd-none' },
      'No scanners found. Check that your scanner is on and connected (or on the same network), then select Refresh.',
      options.isMac
        ? ' Scanners that work in Image Capture work here.'
        : ' Scanners that work in Windows Fax and Scan work here.'
    );
    none.hidden = true;

    const btn = (cls: string, text: string, onClick: () => void) => {
      const b = el('button', { type: 'button', class: cls }, text);
      b.addEventListener('click', onClick);
      return b;
    };
    const cancelBtn = btn('quiet-btn', 'Cancel', () => void cancel());
    const scanBtn = btn('accent-btn', 'Scan', () => void scanPass('more'));
    const moreBtn = btn(
      'pill-btn',
      'Scan more pages',
      () => void scanPass('more')
    );
    const reverseBtn = btn(
      'pill-btn',
      'Scan reverse sides',
      () => void scanPass('reverse')
    );
    const doneBtn = btn('accent-btn', 'Done', () => void finish());
    const closeBtn = el('button', {
      type: 'button',
      class: 'tb-btn',
      title: 'Close',
      'aria-label': 'Close',
    });
    closeBtn.append(icon('close'));
    closeBtn.addEventListener('click', () => void cancel());

    const settingsPanel = el(
      'div',
      { class: 'prefs sd-settings' },
      el('div', { class: 'sd-scanner' }, row('Scanner', scanner), refreshBtn),
      none,
      row('Source', source),
      sidesRow,
      row('Color mode', color),
      row('Resolution', dpi),
      row('Paper size', paper),
      el(
        'label',
        { class: 'pref-row sd-quality-row' },
        el('span', {}, el('b', {}, 'File size')),
        el(
          'span',
          { class: 'sd-quality-scale' },
          el('small', {}, 'Small'),
          quality,
          el('small', {}, 'High quality')
        )
      ),
      row('Output', output),
      el('label', { class: 'pd-check' }, ocr, 'Recognize text (OCR) afterwards')
    );
    const actions = el('div', { class: 'dlg-actions' }, cancelBtn, scanBtn);
    const backdrop = el(
      'div',
      { class: 'dlg-backdrop' },
      el(
        'div',
        { class: 'dlg dlg-scan', role: 'dialog', 'aria-label': 'Scan' },
        el(
          'div',
          { class: 'dlg-head' },
          el('h2', {}, 'Create PDF from scanner'),
          closeBtn
        ),
        el('div', { class: 'dlg-body' }, settingsPanel, strip, status, actions)
      )
    );
    strip.hidden = true;

    /* Behaviour ------------------------------------------------------------ */
    const current = () => sources.find((s) => s.id === source.value);
    const controls = [
      scanner,
      refreshBtn,
      source,
      sides,
      color,
      dpi,
      paper,
      quality,
      output,
      ocr,
    ];

    function readSettings() {
      settings.scanner = scanner.value;
      settings.source = source.value as ScanSettings['source'];
      settings.duplex = sides.value === 'both';
      settings.color = color.value as ColorMode;
      settings.dpi = Number(dpi.value) || 300;
      settings.paper = paper.value as ScanPaper;
      settings.quality = Number(quality.value);
      settings.output = output.value as ScanSettings['output'];
      settings.ocr = ocr.checked;
    }

    function showSource() {
      const s = current();
      sidesRow.hidden = !(s?.id === 'feeder' && s.duplex);
      fillSelect(
        color,
        (['auto', ...(s?.colors ?? ['color', 'gray', 'bw'])] as ColorMode[])
          .filter((c, k, all) => all.indexOf(c) === k)
          .filter(
            (c) => c !== 'auto' || (s?.colors ?? ['color']).includes('color')
          )
          .map((c) => [c, COLOR_LABELS[c]]),
        settings.color
      );
      const offered = offeredResolutions(s);
      fillSelect(
        dpi,
        offered.map((d) => [String(d), `${d} dpi`]),
        String(nearestResolution(offered, settings.dpi))
      );
    }

    function enable() {
      const scanning = busy;
      const have = !!scanner.value && sources.length > 0;
      for (const c of controls) c.disabled = scanning;
      // Pages scanned: they go together, so the scanner stays the same
      if (pages.length) scanner.disabled = refreshBtn.disabled = true;
      scanBtn.disabled = scanning || !have;
      moreBtn.disabled = reverseBtn.disabled = doneBtn.disabled = scanning;
      cancelBtn.textContent = scanning ? 'Stop' : 'Cancel';
    }

    async function loadScanners() {
      busy = true;
      enable();
      status.textContent = 'Looking for scanners…';
      none.hidden = true;
      const r = await bridge
        .scanners()
        .catch(() => ({ ok: false, scanners: [] as Scanner[] }));
      if (closed) return;
      scanners = r.scanners;
      fillSelect(
        scanner,
        scanners.map((s) => [s.id, s.name]),
        settings.scanner
      );
      busy = false;
      none.hidden = scanners.length > 0;
      status.textContent = '';
      if (scanners.length) await loadCaps();
      else {
        sources = [];
        fillSelect(source, []);
        enable();
      }
    }

    async function loadCaps() {
      busy = true;
      enable();
      status.textContent = 'Getting the scanner ready…';
      const r = await bridge.scannerCaps(scanner.value).catch(() => ({
        ok: false,
        sources: [] as ScanSource[],
        error: 'failed' as ScanError,
        message: undefined as string | undefined,
      }));
      if (closed) return;
      busy = false;
      sources = r.ok ? (r.sources ?? []) : [];
      fillSelect(
        source,
        sources.map((s) => [
          s.id,
          s.id === 'feeder' ? 'Document feeder' : 'Flatbed',
        ]),
        settings.source
      );
      sides.value = settings.duplex ? 'both' : 'one';
      showSource();
      status.textContent = r.ok ? '' : scanErrorMessage(r.error, r.message);
      enable();
    }

    async function scanPass(kind: 'more' | 'reverse') {
      if (busy) return;
      readSettings();
      remember(settings);
      const src = current();
      const request =
        kind === 'reverse'
          ? {
              ...scanRequest(settings, src),
              source: 'feeder' as const,
              duplex: false,
            }
          : scanRequest(settings, src);
      const got: ScannedPage[] = [];
      const off = bridge.onScanPage((data, info) => {
        got.push({ data, mime: info.mime, dpi: info.dpi });
        addThumb(data, info.mime);
        status.textContent = `Scanned ${pages.length + got.length} page${pages.length + got.length === 1 ? '' : 's'}…`;
      });
      busy = true;
      enable();
      status.textContent = 'Scanning…';
      let result: ScanResult;
      try {
        result = await bridge.scan(settings.scanner, request);
      } catch (err) {
        result = {
          ok: false,
          error: 'failed',
          message: String((err as Error)?.message ?? err),
        };
      } finally {
        off();
      }
      busy = false;
      if (closed) return;
      if (kind === 'reverse' && got.length) {
        // The backs of the last pass: woven in after their fronts
        const before = pages.slice(0, pages.length - lastPass.length);
        pages = [...before, ...interleave(lastPass, got)];
        lastPass = [];
        lastPassFeeder = false;
      } else if (got.length) {
        pages = [...pages, ...got];
        lastPass = got;
        lastPassFeeder = request.source === 'feeder';
        lastPassDuplex = request.duplex;
      }
      status.textContent = result.ok
        ? `${pages.length} page${pages.length === 1 ? '' : 's'} scanned. Scan more, or select Done.`
        : scanErrorMessage(result.error, result.message) +
          (pages.length
            ? ` ${pages.length} page${pages.length === 1 ? '' : 's'} scanned so far.`
            : '');
      showActions();
      enable();
    }

    function addThumb(data: Uint8Array, mime: string) {
      const url = URL.createObjectURL(
        new Blob([data as BlobPart], { type: mime })
      );
      thumbs.push(url);
      strip.append(
        el('img', { src: url, alt: `Page ${thumbs.length}`, class: 'sd-thumb' })
      );
      strip.hidden = false;
      strip.scrollLeft = strip.scrollWidth;
    }

    function showActions() {
      if (!pages.length) {
        actions.replaceChildren(cancelBtn, scanBtn);
        return;
      }
      reverseBtn.hidden = !(
        lastPassFeeder &&
        !lastPassDuplex &&
        lastPass.length
      );
      actions.replaceChildren(cancelBtn, reverseBtn, moreBtn, doneBtn);
    }

    async function finish() {
      if (busy || !pages.length) return;
      readSettings();
      remember(settings);
      busy = true;
      enable();
      status.textContent = 'Making the PDF…';
      try {
        const prepared: PreparedPage[] = [];
        for (const p of pages)
          prepared.push(await preparePage(p, settings.color, settings.quality));
        const pdf = await buildPdf(prepared);
        close({
          pdf,
          pages: pages.length,
          output: settings.output,
          ocr: settings.ocr,
        });
      } catch (err) {
        busy = false;
        status.textContent = `The PDF couldn't be made: ${(err as Error)?.message ?? err}`;
        enable();
      }
    }

    let confirmDiscard = false;
    async function cancel() {
      if (busy) {
        await bridge.cancelScan().catch(() => false);
        return;
      }
      // Scanned pages aren't thrown away on one click
      if (pages.length && !confirmDiscard) {
        confirmDiscard = true;
        cancelBtn.textContent = `Discard ${pages.length} page${pages.length === 1 ? '' : 's'}`;
        status.textContent =
          'Select again to discard the scanned pages, or Done to keep them.';
        return;
      }
      close(null);
    }

    function close(outcome: ScanOutcome | null) {
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      for (const url of thumbs) URL.revokeObjectURL(url);
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

    scanner.addEventListener('change', () => {
      settings.scanner = scanner.value;
      void loadCaps();
    });
    refreshBtn.addEventListener('click', () => void loadScanners());
    source.addEventListener('change', () => {
      settings.source = source.value as ScanSettings['source'];
      showSource();
    });
    for (const c of [sides, color, dpi, paper, quality, output, ocr])
      c.addEventListener('change', () => {
        readSettings();
        confirmDiscard = false;
      });

    document.body.append(backdrop);
    enable();
    void loadScanners();
    scanner.focus();
  });
}
