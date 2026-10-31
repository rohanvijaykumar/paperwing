/**
 * Filling in forms on the page, as in Chrome or Acrobat: click a field and
 * type, tick a checkbox, choose a radio button or an option. PDFium holds
 * the values and draws the fields (Viewer.setFormValue), so what shows is
 * the document's own drawing, and saving and printing see it. Over each
 * page shown, this lays an invisible control on every field: typing shows a
 * text box over the field until PDFium has drawn what was typed.
 */
import type { PageWidget, Viewer } from './viewer';
import type { FormInfo, FieldMeta } from './forms';
import {
  buildFields,
  fillable,
  pagesOf,
  stepsTo,
  type FieldState,
  type LiveField,
} from './form-model';

export interface FormChange {
  name: string;
  before: FieldState;
  after: FieldState;
}

/** A document's form while it's open: its fields as PDFium holds them, and
 *  changes to them, one after another */
export class FormSession {
  fields: LiveField[] = [];
  private pages: PageWidget[][] = [];
  private meta = new Map<string, FieldMeta>();
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(change: FormChange) => void>();

  constructor(
    private viewer: Viewer,
    readonly tabId: string
  ) {}

  /** Reads the fields from the open document (again, after it changed) */
  async load(info: FormInfo | null): Promise<void> {
    this.meta = new Map((info?.fields ?? []).map((f) => [f.name, f]));
    this.pages = (await this.viewer.formWidgets(this.tabId)) ?? [];
    this.fields = buildFields(this.pages, this.meta);
  }

  field(name: string): LiveField | undefined {
    return this.fields.find((f) => f.name === name);
  }

  /** Can this document's form be filled in at all (encryption can forbid it) */
  get allowed(): boolean {
    return this.viewer.canFillForms(this.tabId);
  }

  onChange(fn: (change: FormChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Waits for the changes asked for so far */
  settled(): Promise<void> {
    return this.queue.then(() => {});
  }

  /** Sets a field (after the changes before it). False if it couldn't be. */
  set(name: string, want: FieldState): Promise<boolean> {
    const run = async () => {
      const f = this.field(name);
      if (!f || !this.allowed) return false;
      const steps = stepsTo(f, want);
      if (!steps.length) return want === f.value;
      const before = f.value;
      const pages = pagesOf(f);
      for (const s of steps) {
        if (
          !(await this.viewer.setFormValue(
            this.tabId,
            s.widget,
            s.value,
            pages
          ))
        )
          break;
      }
      await this.reload(pages);
      const after = this.field(name)?.value ?? before;
      if (after !== before)
        this.listeners.forEach((fn) => fn({ name, before, after }));
      return after === want;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  /** Reads these pages' widgets again (their values changed) */
  private async reload(pageIndexes: number[]) {
    for (const i of pageIndexes)
      this.pages[i] = await this.viewer.pageWidgets(this.tabId, i);
    this.fields = buildFields(this.pages, this.meta);
  }
}

/** Points to CSS pixels at 100% */
const PX = 96 / 72;

/** Each widget's control, by field name and the widget's place in it
 *  (PDFium's widget ids can change when it reads a page again) */
type Controls = Map<string, HTMLElement>;
const keyOf = (name: string, i: number) => `${name}#${i}`;

/** The fields on the shown document's pages */
export class FormLayer {
  private session: FormSession | null = null;
  private unsub?: () => void;
  private observer?: MutationObserver;
  private frame = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private interactive = true;
  private highlight = true;
  /** A field to focus once its page is shown (Tab onto another page) */
  private pendingFocus?: string;
  private controls: Controls = new Map();

  constructor(
    private viewer: Viewer,
    private hooks: {
      /** A signature field was pressed */
      onSignature: (field: LiveField) => void;
      /** A push button was pressed */
      onButton?: (field: LiveField) => void;
    }
  ) {}

  /** Shows the fields of this document (null: none) */
  show(session: FormSession | null) {
    if (session === this.session) return this.schedule();
    this.unsub?.();
    this.unsub = undefined;
    this.session = session;
    this.removeLayers();
    if (!session) return;
    this.unsub = session.onChange(() => this.update());
    this.ensureObserver();
    this.schedule();
  }

  get current(): FormSession | null {
    return this.session;
  }

  /** Off while an annotation tool, the hand or zooming is in use */
  setInteractive(on: boolean) {
    this.interactive = on;
    for (const l of this.layers()) l.classList.toggle('is-off', !on);
    for (const c of this.controls.values()) c.tabIndex = on ? 0 : -1;
  }

  /** Tints the fields (as Acrobat's "Highlight existing fields") */
  setHighlight(on: boolean) {
    this.highlight = on;
    for (const l of this.layers()) l.classList.toggle('is-highlight', on);
  }

  /** Brings the controls up to date with the fields' values */
  update() {
    const s = this.session;
    if (!s) return;
    for (const f of s.fields) {
      f.widgets.forEach((_, i) => {
        const c = this.controls.get(keyOf(f.name, i));
        if (c) this.sync(c, f, i);
      });
    }
    this.schedule();
  }

  /** Leaves the field being typed in (its text is committed) */
  blur() {
    const active = this.viewer.shadow()?.activeElement;
    if (active instanceof HTMLElement && active.closest('.pwf-layer'))
      active.blur();
  }

  /** Looks for pages that need their fields laid over them */
  schedule() {
    if (this.frame) return;
    // The next frame, or soon (a window not drawing gets no frames)
    const run = () => {
      if (!this.frame) return;
      cancelAnimationFrame(this.frame);
      clearTimeout(this.timer);
      this.frame = 0;
      this.reconcile();
    };
    this.frame = requestAnimationFrame(run);
    this.timer = setTimeout(run, 100);
  }

  private ensureObserver() {
    const root = this.viewer.shadow();
    if (!root || this.observer) return;
    this.observer = new MutationObserver((records) => {
      // Our own changes don't count
      if (
        records.every((r) =>
          [...r.addedNodes, ...r.removedNodes, r.target].every(
            (n) => n instanceof Element && !!n.closest('.pwf-layer')
          )
        )
      )
        return;
      this.schedule();
    });
    this.observer.observe(root, { childList: true, subtree: true });
    ensureStyles(root);
  }

  private layers(): HTMLElement[] {
    const root = this.viewer.shadow();
    return root ? [...root.querySelectorAll<HTMLElement>('.pwf-layer')] : [];
  }

  private removeLayers() {
    this.layers().forEach((l) => l.remove());
    this.controls.clear();
  }

  /** Lays the fields over each page shown (pages come and go as the
   *  document scrolls) */
  private reconcile() {
    const s = this.session;
    const root = this.viewer.shadow();
    if (!s || !root) return;
    // (while the viewer switches documents, its pages are another's)
    if (!this.viewer.isShowing(s.tabId)) {
      this.removeLayers();
      return;
    }
    const layout = this.viewer.pageLayout(s.tabId);
    const sizes = this.viewer.pageSizes(s.tabId);
    if (!layout || !sizes.length) return;
    const seen = new Set<HTMLElement>();
    for (const { page, index } of findPages(root, layout)) {
      let layer = page.querySelector<HTMLElement>(':scope > .pwf-layer');
      if (layer && layer.dataset.page !== String(index)) {
        layer.remove();
        layer = null;
      }
      if (!layer) layer = this.buildLayer(index, sizes[index]);
      if (!layer) continue;
      if (layer.parentElement !== page) page.append(layer);
      seen.add(layer);
    }
    // Layers left on pages that went away
    for (const l of this.layers())
      if (!seen.has(l)) {
        l.querySelectorAll<HTMLElement>('[data-key]').forEach((c) =>
          this.controls.delete(c.dataset.key!)
        );
        l.remove();
      }
    if (this.pendingFocus) {
      const c = this.controls.get(this.pendingFocus);
      if (c) {
        this.pendingFocus = undefined;
        c.focus();
      }
    }
  }

  private buildLayer(
    index: number,
    size: { width: number; height: number } | undefined
  ): HTMLElement | null {
    const s = this.session!;
    if (!size) return null;
    const widgets = s.fields.flatMap((f) =>
      f.widgets
        .map((w, i) => ({ f, w, i }))
        .filter((x) => x.w.pageIndex === index)
    );
    if (!widgets.length) return null;
    const layer = document.createElement('div');
    layer.className = 'pwf-layer';
    layer.dataset.page = String(index);
    layer.classList.toggle('is-off', !this.interactive);
    layer.classList.toggle('is-highlight', this.highlight);
    // The viewer selects text and annotations on pointer down: not on fields
    for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick'])
      layer.addEventListener(type, (e) => {
        if ((e.target as Element).closest?.('.pwf-field')) e.stopPropagation();
      });
    layer.addEventListener('keydown', (e) => this.onKey(e));
    for (const { f, w, i } of widgets) {
      const c = this.buildControl(f, w, i);
      if (!c) continue;
      const r = w.rect;
      Object.assign(c.style, {
        left: `${(r.origin.x / size.width) * 100}%`,
        top: `${(r.origin.y / size.height) * 100}%`,
        width: `${(r.size.width / size.width) * 100}%`,
        height: `${(r.size.height / size.height) * 100}%`,
      });
      c.dataset.key = keyOf(f.name, i);
      c.classList.toggle('is-required', f.required);
      if (!this.interactive) c.tabIndex = -1;
      this.controls.set(keyOf(f.name, i), c);
      layer.append(c);
    }
    return layer;
  }

  private buildControl(
    f: LiveField,
    w: PageWidget,
    i: number
  ): HTMLElement | null {
    const s = this.session!;
    const editable = fillable(f) && s.allowed;
    if (f.kind === 'signature') {
      const b = button(f.label, 'pwf-sign');
      b.title = 'Sign with Fill & Sign';
      b.addEventListener('click', () => this.hooks.onSignature(f));
      return b;
    }
    if (f.kind === 'button') {
      if (!this.hooks.onButton) return null;
      const b = button(f.label, 'pwf-button');
      b.addEventListener('click', () => this.hooks.onButton?.(f));
      return b;
    }
    if (!editable) return null;
    if (f.kind === 'checkbox' || f.kind === 'radio') {
      const b = button(f.label, 'pwf-toggle');
      b.setAttribute('role', f.kind);
      b.addEventListener('click', () => {
        const now = s.field(f.name);
        if (!now) return;
        void s.set(f.name, f.kind === 'checkbox' ? !now.value : i);
      });
      this.sync(b, f, i);
      return b;
    }
    if (f.kind === 'dropdown' || f.kind === 'list') {
      const sel = document.createElement('select');
      sel.className = `pwf-field pwf-choice${f.kind === 'list' ? ' is-list' : ''}`;
      sel.setAttribute('aria-label', f.label);
      if (f.kind === 'list')
        sel.size = Math.max(2, Math.min(f.options.length, 8));
      for (const o of f.options) sel.append(new Option(o, o));
      sel.addEventListener('change', () => {
        void s.set(f.name, sel.selectedIndex).then(() => sel.blur());
      });
      // A list shows itself to be picked from (it can't be picked from
      // through the drawing: its rows don't line up)
      sel.addEventListener('focus', () => this.fitText(sel, f));
      this.sync(sel, f, i);
      return sel;
    }
    // Text
    const input = f.multiline
      ? document.createElement('textarea')
      : document.createElement('input');
    input.className = 'pwf-field pwf-text';
    input.setAttribute('aria-label', f.label);
    if (input instanceof HTMLInputElement)
      input.type = f.password ? 'password' : 'text';
    if (f.maxLength) input.maxLength = f.maxLength;
    input.spellcheck = false;
    let original = '';
    input.addEventListener('focus', () => {
      const now = s.field(f.name);
      original = typeof now?.value === 'string' ? now.value : '';
      input.value = original;
      this.fitText(input, f);
      input.classList.add('is-editing');
      if (input instanceof HTMLInputElement) input.select();
    });
    input.addEventListener('blur', () => {
      const text = input.value;
      if (text === original) {
        input.classList.remove('is-editing');
        return;
      }
      // The typed text stays shown until PDFium has drawn it
      void s.set(f.name, text).finally(() =>
        whenDrawn(input).then(() => {
          if (input !== this.viewer.shadow()?.activeElement)
            input.classList.remove('is-editing');
        })
      );
    });
    input.addEventListener('keydown', (e) => {
      const k = e as KeyboardEvent;
      if (k.key === 'Escape') {
        input.value = original;
        input.blur();
        k.stopPropagation();
      } else if (k.key === 'Enter' && input instanceof HTMLInputElement) {
        input.blur();
      }
    });
    this.sync(input, f, i);
    return input;
  }

  /** A control showing a field's value */
  private sync(c: HTMLElement, f: LiveField, i: number) {
    if (c.classList.contains('pwf-toggle')) {
      const on = f.kind === 'checkbox' ? f.value === true : f.value === i;
      c.setAttribute('aria-checked', String(on));
    } else if (c instanceof HTMLSelectElement) {
      if (c !== this.viewer.shadow()?.activeElement)
        c.selectedIndex = typeof f.value === 'number' ? f.value : -1;
    } else if (
      (c instanceof HTMLInputElement || c instanceof HTMLTextAreaElement) &&
      !c.classList.contains('is-editing')
    ) {
      c.value = typeof f.value === 'string' ? f.value : '';
    }
  }

  /** Text in a control at about the size the field draws it at */
  private fitText(c: HTMLElement, f: LiveField) {
    const layout = this.session && this.viewer.pageLayout(this.session.tabId);
    const scale = (layout?.scale ?? 1) * PX;
    const h = (c.getBoundingClientRect().height || 16) / scale;
    const pt =
      f.fontSize > 0
        ? f.fontSize
        : f.multiline || f.kind === 'list'
          ? 12
          : Math.max(6, Math.min(12, h * 0.68));
    c.style.fontSize = `${pt * scale}px`;
  }

  /** Tab and Shift+Tab go through the fields in order, page after page */
  private onKey(e: KeyboardEvent) {
    if (e.key !== 'Tab' || !this.session) return;
    // Each page's fields in the page's order (the order PDFium reads them)
    const order = this.session.fields
      .filter(fillable)
      .flatMap((f) => f.widgets.map((w, i) => ({ key: keyOf(f.name, i), w })))
      .sort((a, b) => a.w.pageIndex - b.w.pageIndex);
    const from = (e.target as HTMLElement).dataset?.key;
    const at = order.findIndex((o) => o.key === from);
    if (at < 0) return;
    const next = order[at + (e.shiftKey ? -1 : 1)];
    if (!next) return; // out of the form: the browser's own Tab
    e.preventDefault();
    const c = this.controls.get(next.key);
    if (c) {
      c.focus();
      return;
    }
    // On a page not shown yet
    this.pendingFocus = next.key;
    (e.target as HTMLElement).blur();
    this.viewer.goToPage(this.session.tabId, next.w.pageIndex + 1);
    this.schedule();
  }
}

function button(label: string, cls: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `pwf-field ${cls}`;
  b.setAttribute('aria-label', label);
  return b;
}

/** Resolves once the page under `el` has been drawn again (its image
 *  changed), or after a moment */
function whenDrawn(el: HTMLElement): Promise<void> {
  const page = el.closest('.pwf-layer')?.parentElement;
  const img = page?.querySelector('img');
  if (!img) return Promise.resolve();
  const was = img.src;
  return new Promise((resolve) => {
    const start = performance.now();
    const check = () => {
      const now = page!.querySelector('img');
      if (
        (now && now.src !== was && now.complete) ||
        performance.now() - start > 1500
      )
        resolve();
      else setTimeout(check, 30);
    };
    setTimeout(check, 30);
  });
}

/**
 * The viewer's pages shown now, with their index: each page is drawn in a
 * box as large as the page at the current zoom; which page it is follows
 * from where it sits in the document, by the viewer's layout.
 */
function findPages(
  root: ShadowRoot,
  layout: { scale: number; pages: Map<number, { x: number; y: number }> }
): { page: HTMLElement; index: number }[] {
  const out: { page: HTMLElement; index: number }[] = [];
  // The unrotated page: a positioned box (sized in px) holding the page
  // image first, inside the box that's rotated
  const boxes = [...root.querySelectorAll<HTMLElement>('div')].filter(
    (d) =>
      d.style.position === 'relative' &&
      d.style.touchAction === 'none' &&
      /px$/.test(d.style.width) &&
      d.firstElementChild instanceof HTMLImageElement
  );
  if (!boxes.length) return out;
  const scale = layout.scale;
  // The document's content area: everything is placed from its top left
  let content: HTMLElement | null = boxes[0].parentElement;
  while (
    content &&
    !(
      content.style.margin === '0px auto' &&
      content.style.position === 'relative'
    )
  )
    content = content.parentElement;
  if (!content) return out;
  const origin = content.getBoundingClientRect();
  for (const box of boxes) {
    const outer = box.parentElement?.parentElement ?? box;
    const r = outer.getBoundingClientRect();
    const x = (r.left - origin.left) / scale;
    const y = (r.top - origin.top) / scale;
    let best = -1;
    let bestD = Infinity;
    for (const [index, p] of layout.pages) {
      const d = Math.abs(p.y - y) + Math.abs(p.x - x);
      if (d < bestD) {
        bestD = d;
        best = index;
      }
    }
    if (best >= 0 && bestD < 4) out.push({ page: box, index: best });
  }
  return out;
}

/** The fields' look, in the viewer's shadow root */
function ensureStyles(root: ShadowRoot) {
  if (root.getElementById('pwf-style')) return;
  const style = document.createElement('style');
  style.id = 'pwf-style';
  style.textContent = `
    .pwf-layer { position: absolute; inset: 0; z-index: 3; pointer-events: none; }
    .pwf-layer .pwf-field {
      position: absolute; box-sizing: border-box; margin: 0; padding: 0 2px;
      border: 0; border-radius: 0; background: transparent; color: transparent;
      caret-color: transparent; font: inherit; font-family: Helvetica, Arial, sans-serif;
      line-height: 1.15; outline: none; resize: none; appearance: none;
      pointer-events: auto; cursor: pointer;
    }
    .pwf-layer.is-off .pwf-field { pointer-events: none; }
    .pwf-layer .pwf-text { cursor: text; }
    .pwf-layer textarea.pwf-text { padding: 2px; overflow: hidden; }
    .pwf-layer.is-highlight .pwf-field:not(.is-editing) {
      background: rgb(204 215 255 / 0.45);
    }
    .pwf-layer .pwf-field:hover:not(.is-editing) {
      background: rgb(204 215 255 / 0.6);
    }
    .pwf-layer.is-highlight .pwf-field.is-required:not(.is-editing) {
      box-shadow: inset 0 0 0 1px rgb(211 21 16 / 0.7);
    }
    .pwf-layer .pwf-field:focus-visible { box-shadow: 0 0 0 2px #3b63fb; }
    .pwf-layer .pwf-text.is-editing {
      background: #fff; color: #000; caret-color: #000;
      box-shadow: 0 0 0 2px #3b63fb; overflow: auto;
    }
    .pwf-layer .pwf-choice { opacity: 0; }
    .pwf-layer .pwf-choice.is-list:focus {
      opacity: 1; height: auto !important; min-height: 100%; background: #fff;
      color: #000; box-shadow: 0 0 0 2px #3b63fb, 0 4px 16px rgb(0 0 0 / 0.2);
      z-index: 1;
    }
    .pwf-layer .pwf-choice:focus-visible { opacity: 1; background: transparent; }
  `;
  root.append(style);
}
