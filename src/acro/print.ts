/**
 * The desktop app's print dialog, laid out like Acrobat's: the printer and
 * copies, which pages, the paper and which way round, how pages are sized
 * (fitted, actual size, shrunk, scaled, several to a sheet, a booklet), and
 * whether comments print. The preview shows the sheets that will print
 * (print-layout.ts makes them), and the printer gets exactly those, at
 * their size. The printing itself happens in the desktop shell
 * (desktop/print.cjs), the same way on Windows, macOS and Linux.
 */
import type {
  DesktopBridge,
  Printer,
  PrintRequest,
  PrintResult,
} from './desktop';
import { icon } from './icons';
import { openPreview, type PrintPreview } from './print-preview';
import {
  PAPERS,
  defaultSettings,
  layOut,
  type LaidOut,
  type PaperId,
  type PrintSettings,
} from './print-layout';

export type PrintBridge = Required<
  Pick<DesktopBridge, 'printers' | 'printPages'>
>;

export type PrintOutcome = 'printed' | 'saved' | 'cancelled';

/** What's printed */
export interface PrintJob {
  name: string;
  /** The page shown, 1-based ("Current page") */
  current: number;
  /** The document ready to lay out (Viewer.printReady), with or without
   *  its comments */
  source(comments: boolean): Promise<Uint8Array>;
}

const MAX_COPIES = 99;
const SETTINGS_KEY = 'paperwing:printSettings';

/** What's remembered between prints (not the pages chosen) */
interface Remembered extends Partial<PrintSettings> {
  color?: boolean;
  duplex?: 'simplex' | 'longEdge' | 'shortEdge';
  comments?: boolean;
}

function remembered(): Remembered {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

function remember(r: Remembered) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(r));
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

function select(label: string, options: [string, string][], value?: string) {
  const s = el('select', { class: 'pref-select', 'aria-label': label });
  for (const [v, text] of options) s.append(el('option', { value: v }, text));
  if (value !== undefined && options.some(([v]) => v === value))
    s.value = value;
  return s;
}

const row = (label: string, ...controls: HTMLElement[]) =>
  el(
    'label',
    { class: 'pref-row' },
    el('span', {}, el('b', {}, label)),
    ...controls
  );

const group = (title: string, ...children: (Node | false)[]) =>
  el(
    'section',
    { class: 'pd-group', 'aria-label': title },
    el('h3', {}, title),
    ...children
  );

/** Shows the dialog; resolves once the document was printed or saved, or
 *  the dialog was closed */
export async function showPrintDialog(
  bridge: PrintBridge,
  job: PrintJob,
  notify: (message: string) => void
): Promise<PrintOutcome> {
  const { printers, selected } = await bridge.printers().catch(() => ({
    printers: [] as Printer[],
    selected: null as string | null,
  }));
  const saved = remembered();
  const settings: PrintSettings = {
    ...defaultSettings(navigator.language),
    ...pick(saved),
    // Which pages: always all to begin with
    pages: 'all',
    range: '',
    subset: 'all',
    reverse: false,
  };

  return new Promise((resolve) => {
    /* Printer ------------------------------------------------------------ */
    const printer = select(
      'Printer',
      printers.map((p) => [p.name, p.displayName])
    );
    if (selected) printer.value = selected;
    const copies = el('input', {
      class: 'pref-select pd-num',
      type: 'number',
      min: '1',
      max: String(MAX_COPIES),
      value: '1',
      'aria-label': 'Copies',
    });
    const color = select(
      'Color',
      [
        ['color', 'Color'],
        ['mono', 'Black and white'],
      ],
      saved.color === false ? 'mono' : 'color'
    );
    const duplex = select(
      'Two-sided',
      [
        ['simplex', 'Off'],
        ['longEdge', 'Flip on long edge'],
        ['shortEdge', 'Flip on short edge'],
      ],
      saved.duplex
    );

    /* Pages -------------------------------------------------------------- */
    const pagesChoice = (value: string, text: string) => {
      const input = el('input', {
        type: 'radio',
        name: 'pd-pages',
        value,
        'aria-label': text,
      });
      if (value === 'all') input.checked = true;
      return { input, label: el('label', { class: 'pd-radio' }, input, text) };
    };
    const allPages = pagesChoice('all', 'All');
    const currentPage = pagesChoice('current', `Current page (${job.current})`);
    const somePages = pagesChoice('range', 'Pages');
    const range = el('input', {
      class: 'pref-select pd-range',
      type: 'text',
      placeholder: 'e.g. 1-3, 5',
      'aria-label': 'Pages to print',
      spellcheck: 'false',
    });
    const subset = select('Odd or even pages', [
      ['all', 'All pages'],
      ['odd', 'Odd pages only'],
      ['even', 'Even pages only'],
    ]);
    const reverse = el('input', {
      type: 'checkbox',
      'aria-label': 'Reverse pages',
    });

    /* Paper -------------------------------------------------------------- */
    const paper = select(
      'Paper size',
      (Object.keys(PAPERS) as PaperId[]).map((id) => [id, PAPERS[id].label]),
      settings.paper
    );
    const orientation = select(
      'Orientation',
      [
        ['auto', 'Auto portrait/landscape'],
        ['portrait', 'Portrait'],
        ['landscape', 'Landscape'],
      ],
      settings.orientation
    );

    /* Page sizing & handling ---------------------------------------------- */
    const handlingBtn = (value: PrintSettings['handling'], text: string) => {
      const b = el(
        'button',
        { type: 'button', class: 'pd-seg-btn', 'data-value': value },
        text
      );
      b.addEventListener('click', () => {
        settings.handling = value;
        // A booklet is printed on both sides, flipped on the short edge
        if (value === 'booklet' && duplex.value === 'simplex')
          duplex.value = 'shortEdge';
        showHandling();
        relayout();
      });
      return b;
    };
    const handlingBtns = [
      handlingBtn('size', 'Size'),
      handlingBtn('multiple', 'Multiple'),
      handlingBtn('booklet', 'Booklet'),
    ];
    const sizing = select(
      'Size',
      [
        ['fit', 'Fit'],
        ['actual', 'Actual size'],
        ['shrink', 'Shrink oversized pages'],
        ['custom', 'Custom scale'],
      ],
      settings.sizing
    );
    const scale = el('input', {
      class: 'pref-select pd-num',
      type: 'number',
      min: '1',
      max: '1000',
      value: String(settings.scale),
      'aria-label': 'Scale (percent)',
    });
    const scaleRow = row('Scale (%)', scale);
    const perSheet = select(
      'Pages per sheet',
      ['2', '4', '6', '9', '16'].map((n) => [n, n]),
      String(settings.perSheet)
    );
    const order = select(
      'Page order',
      [
        ['horizontal', 'Horizontal'],
        ['horizontal-reversed', 'Horizontal reversed'],
        ['vertical', 'Vertical'],
        ['vertical-reversed', 'Vertical reversed'],
      ],
      settings.order
    );
    const borders = el('input', {
      type: 'checkbox',
      'aria-label': 'Print page border',
    });
    borders.checked = settings.borders;
    const bookletSubset = select(
      'Booklet subset',
      [
        ['both', 'Both sides'],
        ['front', 'Front side only'],
        ['back', 'Back side only'],
      ],
      settings.bookletSubset
    );
    const binding = select(
      'Binding',
      [
        ['left', 'Left'],
        ['right', 'Right'],
      ],
      settings.binding
    );
    const sizePanel = el(
      'div',
      { class: 'pd-sub' },
      row('Size', sizing),
      scaleRow
    );
    const multiplePanel = el(
      'div',
      { class: 'pd-sub' },
      row('Pages per sheet', perSheet),
      row('Page order', order),
      el('label', { class: 'pd-check' }, borders, 'Print page border')
    );
    const bookletPanel = el(
      'div',
      { class: 'pd-sub' },
      row('Booklet subset', bookletSubset),
      el(
        'p',
        { class: 'pd-hint' },
        'No two-sided printer? Print the fronts, put the stack back in, then print the backs.'
      ),
      row('Binding', binding)
    );
    function showHandling() {
      handlingBtns.forEach((b) =>
        b.classList.toggle('is-on', b.dataset.value === settings.handling)
      );
      sizePanel.hidden = settings.handling !== 'size';
      multiplePanel.hidden = settings.handling !== 'multiple';
      bookletPanel.hidden = settings.handling !== 'booklet';
      scaleRow.hidden = sizing.value !== 'custom';
    }

    /* Comments & forms ---------------------------------------------------- */
    const comments = select(
      'Comments & forms',
      [
        ['markups', 'Document and markups'],
        ['document', 'Document'],
      ],
      saved.comments === false ? 'document' : 'markups'
    );

    /* Dialog ------------------------------------------------------------- */
    const status = el('p', { class: 'muted pd-status', role: 'status' });
    const btn = (cls: string, text: string, onClick: () => void) => {
      const b = el('button', { type: 'button', class: cls }, text);
      b.addEventListener('click', onClick);
      return b;
    };
    const cancelBtn = btn('quiet-btn', 'Cancel', () => finish('cancelled'));
    const pdfBtn = btn('pill-btn', 'Save as PDF…', () => void save());
    const printBtn = btn('accent-btn', 'Print', () => void print());

    const canvas = el('canvas', { class: 'pd-page' });
    const sheet = el(
      'div',
      { class: 'pd-sheet', role: 'img', 'aria-label': 'Preview' },
      canvas
    );
    const count = el(
      'span',
      { class: 'pd-count', 'aria-live': 'polite' },
      'Preparing preview…'
    );
    const navBtn = (label: string, glyph: 'chevronLeft' | 'chevronRight') => {
      const b = el(
        'button',
        { type: 'button', class: 'tb-btn', 'aria-label': label, title: label },
        icon(glyph, 16)
      );
      b.hidden = true;
      return b;
    };
    const prevBtn = navBtn('Previous sheet', 'chevronLeft');
    const nextBtn = navBtn('Next sheet', 'chevronRight');

    const closeBtn = el('button', {
      type: 'button',
      class: 'tb-btn',
      title: 'Close',
      'aria-label': 'Close',
    });
    closeBtn.append(icon('close'));
    closeBtn.addEventListener('click', () => {
      if (!cancelBtn.disabled) finish('cancelled');
    });

    const settingsPanel = el(
      'div',
      { class: 'prefs pd-settings' },
      group(
        'Printer',
        printers.length
          ? row('Printer', printer)
          : el(
              'p',
              { class: 'pd-none' },
              'No printers found. You can save the document as a PDF instead.'
            ),
        row('Copies', copies),
        row('Color', color),
        row('Two-sided', duplex)
      ),
      group(
        'Pages to print',
        el(
          'div',
          {
            class: 'pd-pages',
            role: 'radiogroup',
            'aria-label': 'Pages to print',
          },
          allPages.label,
          currentPage.label,
          el('div', { class: 'pd-range-row' }, somePages.label, range)
        ),
        row('Odd or even pages', subset),
        el('label', { class: 'pd-check' }, reverse, 'Reverse pages')
      ),
      group('Paper', row('Paper size', paper), row('Orientation', orientation)),
      group(
        'Page sizing & handling',
        el(
          'div',
          {
            class: 'pd-seg',
            role: 'group',
            'aria-label': 'Page sizing & handling',
          },
          ...handlingBtns
        ),
        sizePanel,
        multiplePanel,
        bookletPanel
      ),
      group('Comments & forms', row('Include', comments))
    );

    const backdrop = el(
      'div',
      { class: 'dlg-backdrop' },
      el(
        'div',
        { class: 'dlg dlg-print', role: 'dialog', 'aria-label': 'Print' },
        el('div', { class: 'dlg-head' }, el('h2', {}, 'Print'), closeBtn),
        el(
          'div',
          { class: 'dlg-body' },
          el(
            'div',
            { class: 'pd-layout' },
            el(
              'div',
              { class: 'pd-preview' },
              sheet,
              el('div', { class: 'pd-nav' }, prevBtn, count, nextBtn)
            ),
            settingsPanel
          ),
          status,
          el('div', { class: 'dlg-actions' }, cancelBtn, pdfBtn, printBtn)
        )
      )
    );

    const controls: (
      | HTMLInputElement
      | HTMLSelectElement
      | HTMLButtonElement
    )[] = [
      printer,
      copies,
      color,
      duplex,
      allPages.input,
      currentPage.input,
      somePages.input,
      range,
      subset,
      reverse,
      paper,
      orientation,
      ...handlingBtns,
      sizing,
      scale,
      perSheet,
      order,
      borders,
      bookletSubset,
      binding,
      comments,
      pdfBtn,
      printBtn,
    ];
    let laid: LaidOut | null = null;
    let sending = false;
    const enable = () => {
      controls.forEach((c) => (c.disabled = sending));
      pdfBtn.disabled = sending || !laid;
      printBtn.disabled = sending || !laid || !printers.length;
    };

    // The preview shows what will come out: grey for black and white
    const showColor = () =>
      sheet.classList.toggle('is-mono', color.value === 'mono');

    /* Preview ------------------------------------------------------------ */
    let preview: PrintPreview | null = null;
    let shown = 1;
    let closed = false;
    function showSheet(n: number) {
      if (!preview) return;
      shown = Math.min(Math.max(n, 1), preview.pages);
      prevBtn.hidden = nextBtn.hidden = preview.pages < 2;
      prevBtn.disabled = shown <= 1;
      nextBtn.disabled = shown >= preview.pages;
      count.textContent =
        preview.pages > 1 ? `Sheet ${shown} of ${preview.pages}` : '1 sheet';
      sheet.setAttribute('aria-label', `Preview of sheet ${shown}`);
      const pad = 16;
      preview
        .draw(
          shown,
          canvas,
          Math.max(sheet.clientWidth - pad * 2, 1),
          Math.max(sheet.clientHeight - pad * 2, 1)
        )
        .catch(() => (count.textContent = "The preview couldn't be drawn"));
    }
    prevBtn.addEventListener('click', () => showSheet(shown - 1));
    nextBtn.addEventListener('click', () => showSheet(shown + 1));

    /** The document as it prints, with or without comments, made once each */
    const sources = new Map<boolean, Promise<Uint8Array>>();
    const sourceFor = (withComments: boolean) => {
      if (!sources.has(withComments))
        sources.set(withComments, job.source(withComments));
      return sources.get(withComments)!;
    };

    function readSettings() {
      settings.pages = somePages.input.checked
        ? 'range'
        : currentPage.input.checked
          ? 'current'
          : 'all';
      settings.range = range.value;
      settings.subset = subset.value as PrintSettings['subset'];
      settings.reverse = reverse.checked;
      settings.paper = paper.value as PaperId;
      settings.orientation = orientation.value as PrintSettings['orientation'];
      settings.sizing = sizing.value as PrintSettings['sizing'];
      settings.scale = Number(scale.value) || 100;
      settings.perSheet = Number(perSheet.value) as PrintSettings['perSheet'];
      settings.order = order.value as PrintSettings['order'];
      settings.borders = borders.checked;
      settings.bookletSubset =
        bookletSubset.value as PrintSettings['bookletSubset'];
      settings.binding = binding.value as PrintSettings['binding'];
    }

    // Each change lays the sheets out again; only the latest one shows
    let seq = 0;
    let timer = 0;
    function relayout(delay = 150): void {
      // What's laid out no longer matches the settings: nothing prints
      // until the new layout is ready
      laid = null;
      seq++;
      enable();
      clearTimeout(timer);
      timer = window.setTimeout((): void => void doLayout(), delay);
    }
    async function doLayout(): Promise<void> {
      readSettings();
      const mine = ++seq;
      laid = null;
      enable();
      count.textContent = 'Preparing preview…';
      try {
        const src = await sourceFor(comments.value === 'markups');
        const result = await layOut(src, settings, job.current);
        if (mine !== seq || closed) return;
        laid = result;
        status.textContent = '';
        enable();
        // PDF.js takes over the buffer it's given: the printer gets ours.
        // (Without a preview, it still prints.)
        const p = await openPreview(result.pdf.slice()).catch((): null => null);
        if (mine !== seq || closed) return p?.close();
        preview?.close();
        preview = p;
        if (p) showSheet(shown);
        else {
          prevBtn.hidden = nextBtn.hidden = true;
          count.textContent = 'No preview for this document';
        }
      } catch (err) {
        if (mine !== seq || closed) return;
        laid = null;
        status.textContent =
          err instanceof RangeError
            ? err.message
            : `The document couldn't be prepared: ${(err as Error)?.message ?? err}`;
        count.textContent = '';
      } finally {
        if (mine === seq) enable();
      }
    }

    // Typing a page range lays out as it's typed; choosing it, at once
    range.addEventListener('input', () => {
      somePages.input.checked = true;
      relayout(400);
    });
    range.addEventListener('focus', () => {
      if (!somePages.input.checked) {
        somePages.input.checked = true;
        if (range.value.trim()) relayout(0);
      }
    });
    for (const c of [
      allPages.input,
      currentPage.input,
      somePages.input,
      subset,
      reverse,
      paper,
      orientation,
      perSheet,
      order,
      borders,
      bookletSubset,
      binding,
      comments,
    ])
      c.addEventListener('change', () => relayout(0));
    sizing.addEventListener('change', () => {
      showHandling();
      relayout(0);
    });
    scale.addEventListener('input', () => relayout(400));
    color.addEventListener('change', showColor);

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (!cancelBtn.disabled) finish('cancelled');
    };
    document.addEventListener('keydown', onKey, true);
    backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === backdrop && !cancelBtn.disabled) finish('cancelled');
    });
    document.body.append(backdrop);
    showHandling();
    showColor();
    enable();
    void doLayout();
    (printers.length ? printBtn : pdfBtn).focus();

    function finish(outcome: PrintOutcome) {
      closed = true;
      clearTimeout(timer);
      preview?.close();
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(outcome);
    }

    function keep() {
      readSettings();
      const { pages, range: _r, subset: _s, reverse: _v, ...rest } = settings;
      void pages;
      remember({
        ...rest,
        color: color.value === 'color',
        duplex: duplex.value as Remembered['duplex'],
        comments: comments.value === 'markups',
      });
    }

    async function send(request: PrintRequest): Promise<PrintResult> {
      sending = true;
      enable();
      cancelBtn.disabled = true;
      try {
        return await bridge.printPages(laid!.pdf, request);
      } catch (err) {
        return { ok: false, message: String((err as Error)?.message ?? err) };
      } finally {
        sending = false;
        enable();
        cancelBtn.disabled = false;
      }
    }

    async function print() {
      if (!laid) return;
      const n = Number(copies.value);
      if (!Number.isInteger(n) || n < 1 || n > MAX_COPIES) {
        status.textContent = `Copies must be a whole number from 1 to ${MAX_COPIES}.`;
        copies.focus();
        return;
      }
      const chosen = printers.find((p) => p.name === printer.value);
      if (!chosen) return;
      status.textContent = 'Printing…';
      const size = PAPERS[laid.paper];
      const result = await send({
        destination: 'printer',
        printer: chosen.name,
        copies: n,
        color: color.value === 'color',
        duplex: duplex.value as 'simplex' | 'longEdge' | 'shortEdge',
        paper: { width: size.width, height: size.height },
        landscape: laid.landscape === true,
      });
      if (result.ok) {
        keep();
        notify(`Sent ${job.name} to ${chosen.displayName}`);
        finish('printed');
      } else {
        status.textContent = `Couldn't print: ${result.message ?? 'printing failed'}`;
      }
    }

    async function save() {
      if (!laid) return;
      status.textContent = '';
      const result = await send({ destination: 'pdf', name: job.name });
      if (result.ok) {
        keep();
        notify(`Saved ${job.name} as a PDF`);
        finish('saved');
      } else if (!result.cancelled) {
        status.textContent = `Couldn't save: ${result.message ?? 'saving failed'}`;
      }
    }
  });
}

/** The remembered layout choices that are still valid */
function pick(r: Remembered): Partial<PrintSettings> {
  const out: Partial<PrintSettings> = {};
  const oneOf = <T extends string>(v: unknown, values: readonly T[]) =>
    values.includes(v as T) ? (v as T) : undefined;
  const set = <K extends keyof PrintSettings>(
    k: K,
    v: PrintSettings[K] | undefined
  ) => {
    if (v !== undefined) out[k] = v;
  };
  set('paper', oneOf(r.paper, Object.keys(PAPERS) as PaperId[]));
  set(
    'orientation',
    oneOf(r.orientation, ['auto', 'portrait', 'landscape'] as const)
  );
  set('handling', oneOf(r.handling, ['size', 'multiple', 'booklet'] as const));
  set(
    'sizing',
    oneOf(r.sizing, ['fit', 'actual', 'shrink', 'custom'] as const)
  );
  if (typeof r.scale === 'number' && r.scale >= 1 && r.scale <= 1000)
    out.scale = r.scale;
  if ([2, 4, 6, 9, 16].includes(r.perSheet as number))
    out.perSheet = r.perSheet as PrintSettings['perSheet'];
  set(
    'order',
    oneOf(r.order, [
      'horizontal',
      'horizontal-reversed',
      'vertical',
      'vertical-reversed',
    ] as const)
  );
  if (typeof r.borders === 'boolean') out.borders = r.borders;
  set(
    'bookletSubset',
    oneOf(r.bookletSubset, ['both', 'front', 'back'] as const)
  );
  set('binding', oneOf(r.binding, ['left', 'right'] as const));
  return out;
}
