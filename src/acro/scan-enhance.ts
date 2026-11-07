/**
 * Enhance scanned pages (All tools ▸ Scan & OCR): scanning's clean-up run
 * on the pages of a PDF that was scanned earlier. Each page is drawn at
 * 300 dpi, cleaned up like a fresh scan (scan-process.ts) and put back at
 * its size; pages found blank can go.
 */
import { showModal } from './modal';
import { icon } from './icons';
import { loadPdfjs } from './thumbnails';
import {
  buildPdf,
  encodePage,
  processPage,
  type PdfPart,
} from './scan-process';
import type { Level, ProcessPlan } from './scan-settings';

export interface EnhanceOptions {
  color: 'keep' | 'gray' | 'bw';
  deskew: boolean;
  background: Level;
  despeckle: boolean;
  sharpen: Level;
  edgeShadow: boolean;
  descreen: boolean;
  removeBlank: boolean;
}

export const DEFAULT_ENHANCE: EnhanceOptions = {
  color: 'keep',
  deskew: true,
  background: 'medium',
  despeckle: true,
  sharpen: 'low',
  edgeShadow: true,
  descreen: false,
  removeBlank: false,
};

/** The clean-up for an existing page */
export function enhancePlan(o: EnhanceOptions): ProcessPlan {
  return {
    color: o.color === 'keep' ? 'auto' : o.color,
    threshold: o.color === 'bw' ? 128 : null,
    brightness: 0,
    contrast: 0,
    invert: false,
    deskew: o.deskew,
    autoCrop: false,
    background: o.background,
    descreen: o.descreen,
    sharpen: o.sharpen,
    despeckle: o.despeckle,
    edgeShadow: o.edgeShadow,
    blankSensitivity: o.removeBlank ? 50 : null,
    rotate: 0,
    autoRotate: false,
  };
}

const DPI = 300;

/** The PDF with every page cleaned up (blank ones left out if asked; never
 *  all of them) */
export async function enhancePdf(
  bytes: ArrayBuffer,
  o: EnhanceOptions,
  progress: (page: number, of: number) => void = () => {}
): Promise<ArrayBuffer> {
  const { lib, worker } = await loadPdfjs();
  const doc = await lib.getDocument({
    data: new Uint8Array(bytes.slice(0)),
    worker,
    wasmUrl: import.meta.env.BASE_URL + 'pdfjs-viewer/wasm/',
    isEvalSupported: false,
  }).promise;
  const plan = enhancePlan(o);
  const parts: PdfPart[] = [];
  const blanks: PdfPart[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      progress(n, doc.numPages);
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: DPI / 72 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      const png = await new Promise<Blob | null>((r) =>
        canvas.toBlob(r, 'image/png')
      );
      canvas.width = canvas.height = 0;
      if (!png) throw new Error(`page ${n} couldn't be drawn`);
      const done = await processPage(
        {
          data: new Uint8Array(await png.arrayBuffer()),
          mime: 'image/png',
          dpi: DPI,
        },
        plan
      );
      const part: PdfPart = {
        kind: 'image',
        page: await encodePage(done, {
          quality: 0.75,
          compression: 'jpeg',
          bwCompression: 'g4',
        }),
      };
      (done.blank ? blanks : parts).push(part);
      page.cleanup();
    }
  } finally {
    void doc.destroy();
  }
  const out = await buildPdf(parts.length ? parts : blanks);
  return out.slice().buffer;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...children);
  return e;
}

/** Asks which clean-up to do; resolves with what runs it, or null */
export function showEnhanceDialog(
  name: string
): Promise<{ run(bytes: ArrayBuffer): Promise<ArrayBuffer> } | null> {
  return new Promise((resolve) => {
    const o = { ...DEFAULT_ENHANCE };
    const check = (label: string, key: keyof EnhanceOptions) => {
      const input = el('input', { type: 'checkbox', 'aria-label': label });
      input.checked = o[key] as boolean;
      input.addEventListener('change', () => ((o as any)[key] = input.checked));
      return el('label', { class: 'pd-check' }, input, label);
    };
    const choice = (
      label: string,
      key: 'background' | 'sharpen' | 'color',
      options: [string, string][]
    ) => {
      const s = el('select', { class: 'pref-select', 'aria-label': label });
      for (const [v, t] of options) s.append(el('option', { value: v }, t));
      s.value = o[key];
      s.addEventListener('change', () => ((o as any)[key] = s.value));
      return el(
        'label',
        { class: 'pref-row' },
        el('span', {}, el('b', {}, label)),
        s
      );
    };
    const levels: [string, string][] = [
      ['off', 'Off'],
      ['low', 'Low'],
      ['medium', 'Medium'],
      ['high', 'High'],
    ];
    const cancelBtn = el('button', { type: 'button', class: 'quiet-btn' }, 'Cancel');
    const okBtn = el('button', { type: 'button', class: 'accent-btn' }, 'Enhance');
    const closeBtn = el('button', { type: 'button', class: 'tb-btn', title: 'Close', 'aria-label': 'Close' }, icon('close'));
    const backdrop = el(
      'div',
      { class: 'dlg-backdrop' },
      el(
        'div',
        { class: 'dlg dlg-enhance', role: 'dialog', 'aria-label': 'Enhance scanned pages' },
        el('div', { class: 'dlg-head' }, el('h2', {}, 'Enhance scanned pages'), closeBtn),
        el(
          'div',
          { class: 'dlg-body prefs' },
          el('p', { class: 'muted' }, `Cleans up every page of ${name}. Undo takes it back.`),
          choice('Color', 'color', [
            ['keep', 'Keep as it is'],
            ['gray', 'Grayscale'],
            ['bw', 'Black and white'],
          ]),
          check('Deskew (straighten crooked pages)', 'deskew'),
          choice('Background removal', 'background', levels),
          check('Despeckle (remove stray dots)', 'despeckle'),
          choice('Text sharpening', 'sharpen', levels),
          check('Remove edge shadows', 'edgeShadow'),
          check('Descreen (printed photos, magazines)', 'descreen'),
          check('Remove blank pages', 'removeBlank'),
          el('div', { class: 'dlg-actions' }, cancelBtn, okBtn)
        )
      )
    );
    const close = (v: { run(bytes: ArrayBuffer): Promise<ArrayBuffer> } | null) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const all = document.querySelectorAll('.dlg-backdrop');
      if (all[all.length - 1] !== backdrop) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close(null);
    };
    document.addEventListener('keydown', onKey, true);
    cancelBtn.addEventListener('click', () => close(null));
    closeBtn.addEventListener('click', () => close(null));
    okBtn.addEventListener('click', () =>
      close({ run: (bytes) => enhancePdf(bytes, { ...o }) })
    );
    showModal(backdrop);
    okBtn.focus();
  });
}
