/**
 * Lays out what will print, as Acrobat's Print dialog does: which pages,
 * on what paper, which way round, how large, how many to a sheet, or as a
 * booklet. The result is a PDF of the sheets themselves, so the preview
 * shows exactly what the printer gets, and the printer gets it at its own
 * size (nothing is scaled again on the way). Pages are placed as they are
 * (vector content, text stays text); the document is expected flattened
 * already, so comments and form fields are part of its pages (see
 * Viewer.printReady).
 */
import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFPage,
  degrees,
  rgb,
} from 'pdf-lib';

/** Paper sizes in points (portrait) */
export const PAPERS = {
  letter: { label: 'Letter', width: 612, height: 792 },
  legal: { label: 'Legal', width: 612, height: 1008 },
  tabloid: { label: 'Tabloid', width: 792, height: 1224 },
  a3: { label: 'A3', width: 841.89, height: 1190.55 },
  a4: { label: 'A4', width: 595.28, height: 841.89 },
  a5: { label: 'A5', width: 419.53, height: 595.28 },
} as const;
export type PaperId = keyof typeof PAPERS;

/** Where Letter is the usual paper (elsewhere, A4) */
const LETTER_REGIONS = new Set([
  'US',
  'CA',
  'MX',
  'PH',
  'CL',
  'CO',
  'VE',
  'PR',
  'GT',
  'SV',
  'CR',
  'PA',
  'DO',
  'NI',
  'HN',
  'BZ',
]);

export function defaultPaper(locale: string): PaperId {
  const region = /[-_]([A-Za-z]{2})\b/.exec(locale)?.[1]?.toUpperCase();
  if (region) return LETTER_REGIONS.has(region) ? 'letter' : 'a4';
  return /^en\b/i.test(locale) ? 'letter' : 'a4';
}

export type PagesChoice = 'all' | 'current' | 'range';
export type Subset = 'all' | 'odd' | 'even';
export type Orientation = 'auto' | 'portrait' | 'landscape';
export type Handling = 'size' | 'multiple' | 'booklet';
export type Sizing = 'fit' | 'actual' | 'shrink' | 'custom';
export type PageOrder =
  | 'horizontal'
  | 'horizontal-reversed'
  | 'vertical'
  | 'vertical-reversed';
export type BookletSubset = 'both' | 'front' | 'back';

export interface PrintSettings {
  pages: PagesChoice;
  /** For 'range': "1-3, 5" */
  range: string;
  subset: Subset;
  reverse: boolean;
  paper: PaperId;
  orientation: Orientation;
  handling: Handling;
  sizing: Sizing;
  /** For 'custom' sizing, percent */
  scale: number;
  perSheet: 2 | 4 | 6 | 9 | 16;
  order: PageOrder;
  borders: boolean;
  bookletSubset: BookletSubset;
  binding: 'left' | 'right';
}

export function defaultSettings(locale: string): PrintSettings {
  return {
    pages: 'all',
    range: '',
    subset: 'all',
    reverse: false,
    paper: defaultPaper(locale),
    orientation: 'auto',
    handling: 'size',
    sizing: 'shrink',
    scale: 100,
    perSheet: 2,
    order: 'horizontal',
    borders: false,
    bookletSubset: 'both',
    binding: 'left',
  };
}

/** Space left around the pages for the printer's unprintable edge (when
 *  pages are fitted; "Actual size" doesn't move them) */
export const MARGIN = 18;
/** Between pages printed several to a sheet */
const GUTTER = 6;

/** "1-3, 5, 8-6" -> [1, 2, 3, 5, 8, 7, 6] (1-based, in the order given);
 *  throws a RangeError saying what's wrong */
export function parsePageRange(text: string, total: number): number[] {
  const out: number[] = [];
  const parts = text.split(',').map((p) => p.trim());
  if (!parts.some(Boolean))
    throw new RangeError('Enter the pages to print, like 1-3, 5');
  for (const part of parts) {
    if (!part) continue;
    const m = /^(\d+)\s*(?:-\s*(\d+))?$/.exec(part);
    if (!m) throw new RangeError(`"${part}" isn't a page or a range, like 1-3`);
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    for (const n of [a, b])
      if (n < 1 || n > total)
        throw new RangeError(
          total === 1
            ? 'This document has 1 page'
            : `Pages go from 1 to ${total}`
        );
    const step = a <= b ? 1 : -1;
    for (let n = a; n !== b + step; n += step) out.push(n);
  }
  return out;
}

/** The pages to print (1-based), in order */
export function choosePages(
  s: Pick<PrintSettings, 'pages' | 'range' | 'subset' | 'reverse'>,
  total: number,
  current: number
): number[] {
  let pages =
    s.pages === 'current'
      ? [Math.min(Math.max(current, 1), total)]
      : s.pages === 'range'
        ? parsePageRange(s.range, total)
        : Array.from({ length: total }, (_, i) => i + 1);
  if (s.subset !== 'all')
    pages = pages.filter((n) => (n % 2 === 1) === (s.subset === 'odd'));
  if (s.reverse) pages = pages.reverse();
  if (!pages.length)
    throw new RangeError(
      s.subset === 'even'
        ? 'There are no even pages to print'
        : 'There are no pages to print'
    );
  return pages;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The size a page shows at (its crop box, turned by its rotation) */
function shownSize(page: PDFPage) {
  const box = page.getCropBox();
  const turned = ((page.getRotation().angle % 360) + 360) % 180 === 90;
  return turned
    ? { width: box.height, height: box.width }
    : { width: box.width, height: box.height };
}

/** Sizes `w`×`h` to fit `room` (never larger than `max` times) */
const fitScale = (w: number, h: number, room: Box, max = Infinity) =>
  Math.min(room.width / w, room.height / h, max);

/** Grid (columns × rows) for several pages to a portrait sheet; landscape
 *  sheets swap it */
const GRID: Record<PrintSettings['perSheet'], [number, number]> = {
  2: [1, 2],
  4: [2, 2],
  6: [2, 3],
  9: [3, 3],
  16: [4, 4],
};

/** Column and row (row 0 at the top) of the k-th page on a sheet */
export function cellOf(
  k: number,
  cols: number,
  rows: number,
  order: PageOrder
): [col: number, row: number] {
  switch (order) {
    case 'horizontal':
      return [k % cols, Math.floor(k / cols)];
    case 'horizontal-reversed':
      return [cols - 1 - (k % cols), Math.floor(k / cols)];
    case 'vertical':
      return [Math.floor(k / rows), k % rows];
    case 'vertical-reversed':
      return [cols - 1 - Math.floor(k / rows), k % rows];
  }
}

/**
 * Booklet page order: for each sheet, its front then its back, each as
 * [left half, right half] (0-based positions in `count` pages, padded to a
 * multiple of four; null is a blank half). Printed on both sides and
 * folded, the pages read in order.
 */
export function bookletSides(
  count: number,
  binding: 'left' | 'right'
): [number | null, number | null][] {
  const n = Math.ceil(count / 4) * 4;
  const at = (i: number) => (i < count ? i : null);
  const sides: [number | null, number | null][] = [];
  for (let s = 0; s < n / 4; s++) {
    const front: [number | null, number | null] = [
      at(n - 1 - 2 * s),
      at(2 * s),
    ];
    const back: [number | null, number | null] = [
      at(2 * s + 1),
      at(n - 2 - 2 * s),
    ];
    sides.push(
      binding === 'left' ? front : [front[1], front[0]],
      binding === 'left' ? back : [back[1], back[0]]
    );
  }
  return sides;
}

export interface LaidOut {
  pdf: Uint8Array;
  /** The paper it was laid out for */
  paper: PaperId;
  sheets: number;
  /** Sheet size in points (of the first sheet, if they differ) */
  sheet: { width: number; height: number };
  /** Every sheet is landscape (true), portrait (false), or both kinds */
  landscape: boolean | 'mixed';
}

/** Lays out `source` (a flattened PDF) by `s` */
export async function layOut(
  source: Uint8Array | ArrayBuffer,
  s: PrintSettings,
  current = 1
): Promise<LaidOut> {
  const src = await PDFDocument.load(source, {
    updateMetadata: false,
    ignoreEncryption: true,
  });
  const pages = choosePages(s, src.getPageCount(), current);
  const out = await PDFDocument.create({ updateMetadata: false });
  const paper = PAPERS[s.paper];
  const sheetSize = (landscape: boolean) =>
    landscape
      ? { width: paper.height, height: paper.width }
      : { width: paper.width, height: paper.height };

  // Each page once, however often it prints
  const unique = [...new Set(pages)];
  // A blank page may have no content at all, which can't be placed: give
  // it an empty one
  for (const n of unique) {
    const node = src.getPage(n - 1).node;
    if (!node.Contents())
      node.set(
        PDFName.of('Contents'),
        src.context.register(src.context.stream(''))
      );
  }
  const embedded = new Map(
    (
      await out.embedPages(
        unique.map((n) => src.getPage(n - 1)),
        unique.map((n) => {
          const b = src.getPage(n - 1).getCropBox();
          return {
            left: b.x,
            bottom: b.y,
            right: b.x + b.width,
            top: b.y + b.height,
          };
        })
      )
    ).map((e, i) => [unique[i], e])
  );

  /** Draws page `n` into `room`, centered, as it shows (rotation applied) */
  const place = (
    sheet: PDFPage,
    n: number,
    room: Box,
    scale: number,
    border = false
  ) => {
    const page = src.getPage(n - 1);
    const xo = embedded.get(n)!;
    const { width: w, height: h } = shownSize(page);
    const sw = w * scale;
    const sh = h * scale;
    const x = room.x + (room.width - sw) / 2;
    const y = room.y + (room.height - sh) / 2;
    // The page's own rotation turns it clockwise; pdf-lib turns
    // counter-clockwise around where it's drawn
    const r = ((page.getRotation().angle % 360) + 360) % 360;
    const at =
      r === 90
        ? { x, y: y + sh }
        : r === 180
          ? { x: x + sw, y: y + sh }
          : r === 270
            ? { x: x + sw, y }
            : { x, y };
    sheet.drawPage(xo, {
      ...at,
      xScale: scale,
      yScale: scale,
      rotate: degrees(-r),
    });
    if (border)
      sheet.drawRectangle({
        x,
        y,
        width: sw,
        height: sh,
        borderColor: rgb(0.35, 0.35, 0.35),
        borderWidth: 0.5,
      });
  };

  const orientations = new Set<boolean>();
  const addSheet = (landscape: boolean) => {
    orientations.add(landscape);
    const size = sheetSize(landscape);
    return out.addPage([size.width, size.height]);
  };

  if (s.handling === 'size') {
    for (const n of pages) {
      const { width: w, height: h } = shownSize(src.getPage(n - 1));
      const landscape =
        s.orientation === 'auto' ? w > h : s.orientation === 'landscape';
      const sheet = addSheet(landscape);
      const size = sheetSize(landscape);
      const room = {
        x: MARGIN,
        y: MARGIN,
        width: size.width - 2 * MARGIN,
        height: size.height - 2 * MARGIN,
      };
      const whole = { x: 0, y: 0, ...size };
      const scale =
        s.sizing === 'fit'
          ? fitScale(w, h, room)
          : s.sizing === 'shrink'
            ? fitScale(w, h, room, 1)
            : s.sizing === 'custom'
              ? Math.min(Math.max(s.scale, 1), 1000) / 100
              : 1;
      place(
        sheet,
        n,
        s.sizing === 'fit' || s.sizing === 'shrink' ? room : whole,
        scale
      );
    }
  } else if (s.handling === 'multiple') {
    const [pc, pr] = GRID[s.perSheet];
    const first = shownSize(src.getPage(pages[0] - 1));
    const cellScale = (landscape: boolean) => {
      const size = sheetSize(landscape);
      const [c, r] = landscape ? [pr, pc] : [pc, pr];
      const cw = (size.width - 2 * MARGIN - (c - 1) * GUTTER) / c;
      const ch = (size.height - 2 * MARGIN - (r - 1) * GUTTER) / r;
      return Math.min(cw / first.width, ch / first.height);
    };
    const landscape =
      s.orientation === 'auto'
        ? cellScale(true) > cellScale(false)
        : s.orientation === 'landscape';
    const size = sheetSize(landscape);
    const [cols, rows] = landscape ? [pr, pc] : [pc, pr];
    const cw = (size.width - 2 * MARGIN - (cols - 1) * GUTTER) / cols;
    const ch = (size.height - 2 * MARGIN - (rows - 1) * GUTTER) / rows;
    for (let i = 0; i < pages.length; i += s.perSheet) {
      const sheet = addSheet(landscape);
      pages.slice(i, i + s.perSheet).forEach((n, k) => {
        const [col, row] = cellOf(k, cols, rows, s.order);
        const room = {
          x: MARGIN + col * (cw + GUTTER),
          y: size.height - MARGIN - (row + 1) * ch - row * GUTTER,
          width: cw,
          height: ch,
        };
        const { width: w, height: h } = shownSize(src.getPage(n - 1));
        place(sheet, n, room, fitScale(w, h, room), s.borders);
      });
    }
  } else {
    // Booklet: two pages side by side on a landscape sheet, both sides
    const size = sheetSize(true);
    const half = (size.width - 2 * MARGIN) / 2;
    const sides = bookletSides(pages.length, s.binding);
    sides.forEach((side, i) => {
      const isFront = i % 2 === 0;
      if (s.bookletSubset === 'front' && !isFront) return;
      if (s.bookletSubset === 'back' && isFront) return;
      const sheet = addSheet(true);
      side.forEach((pos, h) => {
        if (pos === null) return;
        const n = pages[pos];
        const room = {
          x: MARGIN + h * half,
          y: MARGIN,
          width: half,
          height: size.height - 2 * MARGIN,
        };
        const { width: w, height: hh } = shownSize(src.getPage(n - 1));
        place(sheet, n, room, fitScale(w, hh, room));
      });
    });
  }

  const pdf = await out.save();
  const firstSheet = out.getPage(0).getSize();
  return {
    pdf,
    paper: s.paper,
    sheets: out.getPageCount(),
    sheet: firstSheet,
    landscape: orientations.size > 1 ? 'mixed' : orientations.has(true),
  };
}

/** Annotations that never print, whatever their flags */
const NEVER_PRINTED = new Set(['Popup', 'Link']);
const PRINT_FLAG = 4;

/**
 * `pdf` with every markup set to print: those with no flags at all, as
 * Paperwing's viewer makes them, would otherwise be left out (print-mode
 * flattening, like Acrobat, prints only annotations flagged for printing).
 * Flags an author set explicitly are kept, so a comment hidden from print
 * stays hidden.
 */
export async function printableComments(pdf: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf, {
    updateMetadata: false,
    ignoreEncryption: true,
  });
  const F = PDFName.of('F');
  let changed = false;
  for (const page of doc.getPages())
    for (const ref of page.node.Annots()?.asArray() ?? []) {
      const annot = doc.context.lookupMaybe(ref, PDFDict);
      const subtype = annot?.get(PDFName.of('Subtype'))?.toString().slice(1);
      if (!annot || !subtype || NEVER_PRINTED.has(subtype) || annot.has(F))
        continue;
      annot.set(F, PDFNumber.of(PRINT_FLAG));
      changed = true;
    }
  return changed ? doc.save() : pdf;
}

/** `pdf` without its comments, stamps and other markups: form fields stay
 *  (Acrobat's "Document" in Comments & Forms) */
export async function withoutComments(pdf: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf, {
    updateMetadata: false,
    ignoreEncryption: true,
  });
  const widget = PDFName.of('Widget');
  let changed = false;
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    const keep = annots
      .asArray()
      .filter(
        (ref) =>
          doc.context.lookupMaybe(ref, PDFDict)?.get(PDFName.of('Subtype')) ===
          widget
      );
    if (keep.length === annots.size()) continue;
    page.node.set(PDFName.of('Annots'), doc.context.obj(keep));
    changed = true;
  }
  return changed ? doc.save() : pdf;
}
