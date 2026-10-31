/**
 * Filling in forms on the page, as Firefox does: pdf.js's own form fields
 * (its AnnotationLayer: text boxes, checkboxes, radio buttons, dropdowns and
 * lists, in the document's colours) are laid over each page shown, and
 * PDFium draws the pages without their fields (Viewer.setFormsDrawn). The
 * fields are ordinary HTML controls, so typing, Tab, clicking and choosing
 * behave as anywhere else, with nothing drawn again while they're used.
 *
 * What's filled in is kept in pdf.js's annotation storage, which the
 * document's scripts work with too (form-scripts.ts). Each change also goes
 * into PDFium's copy of the document (Viewer.setFormValue), which is what's
 * saved, printed and handed to tools. The few fields pdf.js leaves to the
 * page's drawing (signatures, buttons, read-only text) show PDFium's
 * drawing of them.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PageWidget, Viewer } from './viewer';
import type { FormInfo, FieldMeta } from './forms';
import {
  buildFields,
  stepsTo,
  type FieldState,
  type LiveField,
} from './form-model';
import { FormScripts, type SandboxUpdate } from './form-scripts';
import { loadPdfjs } from './thumbnails';

/** Who changed a field: the person filling in, Ctrl+Z/Ctrl+Shift+Z, the
 *  document's scripts as a consequence (a total worked out), or its
 *  scripts formatting the fields when it opened */
export type ChangeOrigin = 'user' | 'undo' | 'script' | 'open';

export interface FormChange {
  name: string;
  before: FieldState;
  after: FieldState;
  origin: ChangeOrigin;
  /** More typing in the same field: the same change, not a new one */
  merge: boolean;
}

/** pdf.js's description of a widget (getFieldObjects) */
interface FieldObject {
  id: string;
  page?: number;
  rect?: number[];
  type?: string;
  items?: { exportValue: string; displayValue: string }[];
  /** A checkbox's or radio button's value when it's on */
  exportValues?: string | string[];
  multipleSelection?: boolean;
}

/** pdf.js's description of an annotation on a page (getAnnotations) */
interface AnnotationData {
  id: string;
  annotationType: number;
  fieldName?: string;
  rect: number[];
  hasOwnCanvas?: boolean;
  noHTML?: boolean;
  hidden?: boolean;
  fieldType?: string;
}

/** pdf.js's annotation type for form widgets */
const WIDGET = 20;
const RANK: Record<ChangeOrigin, number> = {
  open: 0,
  script: 1,
  undo: 2,
  user: 3,
};

type Storage = PDFDocumentProxy['annotationStorage'];

/** A document's form while it's open: its fields, filled in on the page
 *  (pdf.js) and kept in PDFium's copy of the document */
export class FormSession {
  /** The fields and what they're set to now */
  fields: LiveField[] = [];
  /** The fields as PDFium holds them (what's saved) */
  private saved: LiveField[] = [];
  private pages: PageWidget[][] = [];
  private meta = new Map<string, FieldMeta>();
  /** pdf.js's copy of the document, whose fields are on the page */
  pdf: PDFDocumentProxy | null = null;
  objects: Record<string, FieldObject[]> | null = null;
  hasJSActions = false;
  /** Its scripts, when they run */
  scripts: FormScripts | null = null;
  /** While its "when opened" scripts run */
  opening = false;
  /** pdf.js's widget ids for each field, in the order of its widgets */
  private ids = new Map<string, (string | undefined)[]>();
  private names = new Map<string, string>();
  private views = new Map<number, number[]>();
  private annotations = new Map<number, Promise<AnnotationData[]>>();
  /** Text fields their scripts show otherwise than typed ("$1,234.50") */
  private shown = new Map<string, string>();
  private listeners = new Set<(change: FormChange) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  /** Fields changed since the last look, and by whom */
  private touched = new Map<string, ChangeOrigin>();
  private flushQueued = false;
  /** Changes waiting to go into PDFium's copy */
  private toSave = new Map<string, ReturnType<typeof setTimeout>>();
  /** A change being made to a field from here (undo, the panel) */
  private applying?: { name: string; origin: ChangeOrigin };
  /** Changes from here the scripts may still answer, by field */
  private pending = new Map<string, { origin: ChangeOrigin; until: number }>();
  /** While what the scripts decided is put in */
  private fromScripts: 'script' | 'open' | null = null;
  /** The field being typed in, and whether its typing is a change yet */
  private typing?: { name: string; recorded: boolean };
  /** What pdf.js's fields use for links and to reach the scripts */
  readonly linkService: Record<string, unknown>;
  /** Where the fields are (to give them what the scripts decided) */
  root: () => ShadowRoot | null;

  constructor(
    private viewer: Viewer,
    readonly tabId: string,
    private hooks: {
      alert: (message: string) => void;
      print: () => void;
    }
  ) {
    this.root = () => viewer.shadow();
    const goTo = (n: number) => viewer.goToPage(tabId, n);
    this.linkService = {
      eventBus: {
        dispatch: (name: string, e: { detail?: Record<string, unknown> }) => {
          if (name !== 'dispatcheventinsandbox' || !e?.detail) return;
          // What's typed or clicked on the page comes back from the
          // scripts as the field's value: the person's change, not theirs
          const id = e.detail.id;
          const field = typeof id === 'string' ? this.names.get(id) : undefined;
          const outer = this.applying;
          if (field && !outer) this.applying = { name: field, origin: 'user' };
          try {
            this.scripts?.dispatch(e.detail);
          } finally {
            this.applying = outer;
          }
        },
        on() {},
        off() {},
        _on() {},
        _off() {},
      },
      externalLinkEnabled: false,
      isInPresentationMode: false,
      page: 1,
      rotation: 0,
      get pagesCount() {
        return viewer.pageSizes(tabId).length;
      },
      // A field's link isn't followed (a document's scripts and buttons
      // can't send anything out); its address shows as a tooltip
      addLinkAttributes(link: HTMLAnchorElement, url: string) {
        link.href = '#';
        link.title = url;
        link.addEventListener('click', (e) => e.preventDefault());
      },
      getDestinationHash: () => '#',
      getAnchorUrl: () => '#',
      setHash() {},
      goToDestination: async () => {},
      goToPage: goTo,
      goToXY: () => {},
      executeNamedAction: (action: string) => {
        if (action === 'FirstPage') goTo(1);
        else if (action === 'LastPage') goTo(viewer.pageSizes(tabId).length);
      },
      executeSetOCGState: async () => {},
      cachePageRef() {},
      isPageVisible: () => true,
      isPageCached: () => true,
    };
  }

  /**
   * Reads the form of the open document (`bytes`, as the viewer shows it):
   * its fields as PDFium holds them, and pdf.js's copy, whose fields go on
   * the page. Throws if pdf.js can't read it.
   */
  async load(info: FormInfo | null, bytes: ArrayBuffer): Promise<void> {
    this.meta = new Map((info?.fields ?? []).map((f) => [f.name, f]));
    this.pages = (await this.viewer.formWidgets(this.tabId)) ?? [];
    this.fields = buildFields(this.pages, this.meta);
    this.saved = buildFields(this.pages, this.meta);
    const { lib, worker } = await loadPdfjs();
    const pdf = await lib.getDocument({
      data: new Uint8Array(bytes.slice(0)),
      worker,
      wasmUrl: import.meta.env.BASE_URL + 'pdfjs-viewer/wasm/',
      isEvalSupported: false,
      password: this.viewer.password(this.tabId),
    }).promise;
    this.pdf = pdf;
    const [objects, hasJS] = await Promise.all([
      pdf.getFieldObjects() as Promise<Record<string, FieldObject[]> | null>,
      pdf.hasJSActions(),
    ]);
    this.objects = objects;
    this.hasJSActions = hasJS;
    const pages = new Set(
      Object.values(objects ?? {})
        .flat()
        .map((o) => o.page ?? -1)
        .filter((p) => p >= 0 && p < pdf.numPages)
    );
    for (const p of pages)
      this.views.set(p, [...(await pdf.getPage(p + 1)).view]);
    this.mapWidgets();
    this.watch(pdf.annotationStorage);
  }

  /** Starts the document's scripts (its "when opened" scripts run) */
  async startScripts(): Promise<void> {
    if (!this.pdf) return;
    this.opening = true;
    try {
      this.scripts = await FormScripts.start(this.pdf, this.objects, {
        alert: (message) => this.hooks.alert(message),
        update: (u) => this.fromSandbox(u),
      });
      // (what they formatted comes in after the event that asked for it)
      await new Promise((r) => setTimeout(r, 0));
      this.flush();
    } finally {
      this.opening = false;
    }
  }

  stopScripts() {
    this.scripts?.stop();
    this.scripts = null;
  }

  /** The document closed or was read again */
  close() {
    this.stopScripts();
    for (const t of this.toSave.values()) clearTimeout(t);
    this.toSave.clear();
    void this.pdf?.destroy();
    this.pdf = null;
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

  /** The pages with fields */
  get fieldPages(): number[] {
    return [...this.views.keys()].sort((a, b) => a - b);
  }

  /** A page's annotations, as pdf.js reads them (once) */
  annotationsOf(index: number): Promise<AnnotationData[]> {
    let list = this.annotations.get(index);
    if (!list) {
      list = (async () => {
        const page = await this.pdf!.getPage(index + 1);
        return (await page.getAnnotations({
          intent: 'display',
        })) as AnnotationData[];
      })();
      this.annotations.set(index, list);
    }
    return list;
  }

  /** The page's place (pdf.js places widgets in PDF space, PDFium from the
   *  page's top left) */
  view(index: number): number[] | undefined {
    return this.views.get(index);
  }

  /** Waits for every change so far to be in PDFium's copy */
  settled(): Promise<void> {
    this.flush();
    for (const [name, timer] of this.toSave) {
      clearTimeout(timer);
      this.toSave.delete(name);
      this.save(name);
    }
    return this.queue.then(() => {});
  }

  /** Text fields shown formatted, with their values as typed (saving puts
   *  those in: forms.ts, unformat) */
  formatted(): Map<string, string> {
    const raws = new Map<string, string>();
    for (const name of this.shown.keys()) {
      const v = this.field(name)?.value;
      if (typeof v === 'string') raws.set(name, v);
    }
    return raws;
  }

  /** A field the person is clicking or typing in: what follows is theirs
   *  (not an undo's or the panel's still being answered) */
  touchedByHand(name: string) {
    this.pending.delete(name);
  }

  /** The field being typed in (on the page): its typing is one change */
  startTyping(name: string) {
    this.pending.delete(name);
    this.typing = { name, recorded: false };
  }

  stopTyping(name: string) {
    if (this.typing?.name === name) this.typing = undefined;
  }

  /** A field being typed in went away with its page (scrolled out of
   *  view): pdf.js tells the scripts only when the focus moves on, so
   *  this does, as it would have */
  commitLost(id: string, value: string) {
    const name = this.names.get(id);
    if (!this.scripts || !name) return;
    this.applying = { name, origin: 'user' };
    try {
      this.scripts.dispatch({
        id,
        name: 'Keystroke',
        value,
        willCommit: true,
        commitKey: 1,
        selStart: value.length,
        selEnd: value.length,
      });
    } finally {
      this.applying = undefined;
    }
  }

  /** The field a widget on the page belongs to */
  nameOf(id: string): string | undefined {
    return this.names.get(id);
  }

  /**
   * Fills in a field from outside the page (the Form fields panel, undo):
   * as if it were filled in on the page, so the document's scripts check,
   * format and work out other fields from it.
   */
  fill(name: string, want: FieldState, origin: 'user' | 'undo' = 'user') {
    const f = this.field(name);
    const ids = this.ids.get(name) ?? [];
    const storage = this.pdf?.annotationStorage;
    if (!f || !storage || !ids.some(Boolean)) return;
    this.pending.set(name, { origin, until: performance.now() + 1500 });
    this.applying = { name, origin };
    const el = (i: number) => {
      const id = ids[i];
      return id ? this.element(id) : null;
    };
    try {
      if (f.kind === 'text') {
        const text = String(want);
        let answered = false;
        if (this.scripts && ids[0]) {
          const before = this.answered;
          this.scripts.dispatch({
            id: ids[0],
            name: 'Keystroke',
            value: text,
            change: '',
            willCommit: true,
            commitKey: 1,
            selStart: text.length,
            selEnd: text.length,
          });
          answered = this.answered !== before;
        }
        // No scripts (or they don't know the field): as typed
        if (!answered)
          ids.forEach((id, i) => {
            const e = el(i);
            if (
              e instanceof HTMLInputElement ||
              e instanceof HTMLTextAreaElement
            ) {
              e.value = text;
              e.dispatchEvent(new Event('input', { bubbles: true }));
            } else if (id)
              storage.setValue(id, { value: text, formattedValue: null });
          });
      } else if (f.kind === 'checkbox') {
        // (a widget on a page that's shown, which pdf.js keeps in step
        // with the others)
        const e = ids.map((_, i) => el(i)).find(Boolean);
        if (e instanceof HTMLInputElement) {
          e.checked = !!want;
          e.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          ids.forEach((id) => id && storage.setValue(id, { value: !!want }));
          if (ids[0])
            this.scripts?.dispatch({
              id: ids[0],
              name: 'Action',
              value: !!want,
            });
        }
      } else if (f.kind === 'radio') {
        const at = typeof want === 'number' ? want : -1;
        const e = at >= 0 ? el(at) : null;
        if (e instanceof HTMLInputElement) {
          e.checked = true;
          e.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          ids.forEach((id, i) => {
            const r = el(i);
            if (r instanceof HTMLInputElement) r.checked = i === at;
            if (id) storage.setValue(id, { value: i === at });
          });
          const id = ids[at];
          if (id) this.scripts?.dispatch({ id, name: 'Action', value: true });
        }
      } else if (f.kind === 'dropdown' || f.kind === 'list') {
        const items = this.items(name);
        const at = typeof want === 'number' ? want : -1;
        const value = items[at]?.exportValue ?? f.options[at] ?? null;
        let told = false;
        ids.forEach((id, i) => {
          const e = el(i);
          if (e instanceof HTMLSelectElement) {
            for (const o of e.options)
              o.selected = value !== null && o.value === value;
            // (one of them tells pdf.js and the scripts; all are set)
            if (!told) e.dispatchEvent(new Event('input', { bubbles: true }));
            else if (id) storage.setValue(id, { value });
            told = true;
          } else if (id && i > 0) storage.setValue(id, { value });
        });
        if (told && ids[0] && !el(0)) storage.setValue(ids[0], { value });
        if (!told && ids[0]) {
          storage.setValue(ids[0], { value });
          this.scripts?.dispatch({
            id: ids[0],
            name: 'Keystroke',
            value: '',
            change: items[at]?.displayValue ?? value ?? '',
            changeEx: value ?? '',
            willCommit: false,
            commitKey: 1,
            keyDown: false,
          });
        }
      }
    } finally {
      this.applying = undefined;
    }
    this.flush();
  }

  /** Updates the scripts answered with (to tell whether they knew a field) */
  private answered = 0;

  /** What the scripts decided: field values (to the fields on the page,
   *  or kept for fields not shown), or something to do */
  private fromSandbox(u: SandboxUpdate) {
    const { id, siblings, command, value } = u;
    if (!id) {
      if (command === 'print') this.hooks.print();
      else if (command === 'error')
        console.warn('A form script failed:', value);
      else if (command === 'println') console.info('Form script:', value);
      else if (command === 'page-num' && typeof value === 'number')
        this.viewer.goToPage(this.tabId, value + 1);
      return;
    }
    this.answered++;
    const detail: Record<string, unknown> = { ...u };
    delete detail.id;
    delete detail.siblings;
    this.fromScripts = this.opening ? 'open' : 'script';
    // pdf.js shows a formatted value only in a field not being typed in,
    // which it tells by document.activeElement: in the viewer's shadow
    // root, that's the viewer, so it's told the field itself meanwhile
    const active = this.root()?.activeElement;
    if (active)
      Object.defineProperty(document, 'activeElement', {
        configurable: true,
        get: () => active,
      });
    try {
      for (const elementId of [id, ...(siblings ?? [])]) {
        const el = this.element(elementId);
        if (el)
          el.dispatchEvent(new CustomEvent('updatefromsandbox', { detail }));
        else
          this.pdf?.annotationStorage.setValue(
            elementId,
            this.asKept(elementId, detail)
          );
      }
    } finally {
      if (active)
        delete (document as { activeElement?: Element }).activeElement;
      this.fromScripts = null;
    }
  }

  /** What the scripts set a checkbox or radio button to (its export value
   *  or "Off"), as pdf.js keeps it for a widget not shown (on or off) */
  private asKept(id: string, detail: Record<string, unknown>) {
    const name = this.names.get(id);
    const f = name ? this.field(name) : undefined;
    if (
      !name ||
      !f ||
      (f.kind !== 'checkbox' && f.kind !== 'radio') ||
      typeof detail.value !== 'string'
    )
      return detail;
    const own = this.objects?.[name]?.find((o) => o.id === id)?.exportValues;
    const on =
      f.kind === 'radio'
        ? detail.value === own
        : detail.value !== 'Off' &&
          (typeof own !== 'string' || detail.value === own);
    return { ...detail, value: on };
  }

  private element(id: string): HTMLElement | null {
    return (
      this.root()?.querySelector<HTMLElement>(
        `.pwf-layer [data-element-id="${CSS.escape(id)}"]`
      ) ?? null
    );
  }

  /** A dropdown's or list's options as pdf.js has them (export values) */
  private items(name: string) {
    return (
      this.objects?.[name]
        ?.find((o) => o.items)
        ?.items?.map((o) =>
          Array.isArray(o)
            ? { exportValue: String(o[0]), displayValue: String(o[1] ?? o[0]) }
            : o
        ) ?? []
    );
  }

  /** Matches pdf.js's widgets with PDFium's, by field and place */
  private mapWidgets() {
    this.ids.clear();
    this.names.clear();
    const objects = this.objects ?? {};
    for (const [name, list] of Object.entries(objects)) {
      for (const o of list) this.names.set(o.id, name);
      const field = this.field(name);
      if (!field) continue;
      const placed = list.filter(
        (o) => o.rect && o.page !== undefined && o.page >= 0
      );
      const used = new Set<string>();
      const ids = field.widgets.map((w, i) => {
        const view = this.views.get(w.pageIndex);
        const near = placed.find((o) => {
          if (o.page !== w.pageIndex || used.has(o.id) || !view) return false;
          const x = o.rect![0] - view[0];
          const y = view[3] - o.rect![3];
          return (
            Math.abs(x - w.rect.origin.x) < 3 &&
            Math.abs(y - w.rect.origin.y) < 3
          );
        });
        // (else by order: the same widgets, read in the same order)
        const id =
          near?.id ??
          placed.find((o) => o.page === w.pageIndex && !used.has(o.id))?.id ??
          placed.find((o) => !used.has(o.id))?.id ??
          placed[i]?.id;
        if (id) used.add(id);
        return id;
      });
      this.ids.set(name, ids);
    }
  }

  /** Notices each change pdf.js keeps (typed, clicked, from the scripts) */
  private watch(storage: Storage) {
    const setValue = storage.setValue.bind(storage);
    storage.setValue = (key: string, value: Record<string, unknown>) => {
      setValue(key, value);
      const name = this.names.get(key);
      if (!name) return;
      const origin = this.originOf(name);
      const was = this.touched.get(name);
      if (!was || RANK[origin] > RANK[was]) this.touched.set(name, origin);
      if (!this.flushQueued) {
        this.flushQueued = true;
        queueMicrotask(() => this.flush());
      }
    };
  }

  private originOf(name: string): ChangeOrigin {
    if (this.applying?.name === name) return this.applying.origin;
    const p = this.pending.get(name);
    if (p && p.until > performance.now()) return p.origin;
    return this.fromScripts ?? 'user';
  }

  /** The changes noticed: told, and on their way into PDFium's copy */
  private flush() {
    this.flushQueued = false;
    const touched = [...this.touched];
    this.touched.clear();
    for (const [name, origin] of touched) {
      const f = this.field(name);
      if (!f) continue;
      const shownBefore = this.shown.get(name);
      const after = this.read(f);
      const shownChanged = this.shown.get(name) !== shownBefore;
      if (after === undefined || after === f.value) {
        // (a list's other choices, or which box of a group, changed
        // without its first choice or "ticked" changing)
        if (shownChanged || this.manyStates(f)) this.saveSoon(name);
        continue;
      }
      const before = f.value;
      f.value = after;
      let merge = false;
      if (origin === 'user' && this.typing?.name === name) {
        merge = this.typing.recorded;
        this.typing.recorded = true;
      }
      this.listeners.forEach((fn) =>
        fn({ name, before, after, origin, merge })
      );
      this.saveSoon(name);
    }
  }

  /** What a field is set to, from what pdf.js keeps (undefined: nothing
   *  kept for it, so it's as it was) */
  private read(f: LiveField): FieldState | undefined {
    const storage = this.pdf?.annotationStorage;
    const ids = this.ids.get(f.name) ?? [];
    if (!storage) return undefined;
    const kept = ids.map(
      (id) =>
        (id
          ? (storage.getRawValue(id) as Record<string, unknown> | undefined)
          : undefined) ?? undefined
    );
    switch (f.kind) {
      case 'text': {
        const k = kept.find((v) => v && 'value' in v);
        if (!k) return undefined;
        const raw = k.value == null ? '' : String(k.value);
        const shown = kept.find(
          (v) => v?.formattedValue != null
        )?.formattedValue;
        if (typeof shown === 'string' && shown !== raw)
          this.shown.set(f.name, shown);
        else this.shown.delete(f.name);
        return raw;
      }
      case 'checkbox': {
        if (!kept.some((v) => v && 'value' in v)) return undefined;
        return kept.some(
          (v) =>
            v?.value === true ||
            (typeof v?.value === 'string' && v.value !== 'Off')
        );
      }
      case 'radio': {
        const on = kept.findIndex((v) => v?.value === true);
        if (on >= 0) return on;
        const cur = typeof f.value === 'number' ? f.value : -1;
        if (cur >= 0 && kept[cur]?.value === false) return -1;
        return undefined;
      }
      case 'dropdown':
      case 'list': {
        const k = kept[0];
        if (!k || !('value' in k)) return undefined;
        const v = Array.isArray(k.value) ? k.value[0] : k.value;
        if (v == null || v === '') return -1;
        const items = this.items(f.name);
        let at = items.findIndex((o) => o.exportValue === v);
        if (at < 0) at = items.findIndex((o) => o.displayValue === v);
        if (at < 0) at = f.options.indexOf(String(v));
        return at;
      }
      default:
        return undefined;
    }
  }

  /** What each widget of a field shows, as pdf.js keeps it (undefined:
   *  nothing kept for it) */
  private keptOn(f: LiveField): (boolean | undefined)[] {
    const storage = this.pdf?.annotationStorage;
    return (this.ids.get(f.name) ?? []).map((id) => {
      const v = id
        ? (storage?.getRawValue(id) as { value?: unknown } | undefined)?.value
        : undefined;
      return typeof v === 'boolean' ? v : undefined;
    });
  }

  /** Checkboxes sharing a name, each with a value of its own (M / F): the
   *  one ticked on the page is pressed in PDFium (which unticks the rest),
   *  or, none ticked, the one still ticked there */
  private boxSteps(f: LiveField, s: LiveField) {
    const want = this.keptOn(f);
    const on = s.widgets.findIndex(
      (w, i) => want[i] === true && !w.field.isChecked
    );
    if (on >= 0)
      return [{ widget: s.widgets[on], value: { kind: 'checked' as const } }];
    const off = s.widgets.findIndex(
      (w, i) => want[i] === false && !!w.field.isChecked
    );
    return off >= 0
      ? [{ widget: s.widgets[off], value: { kind: 'checked' as const } }]
      : [];
  }

  /** A field whose value here doesn't say all of it: checkboxes sharing a
   *  name, a list where several options can be chosen */
  private manyStates(f: LiveField): boolean {
    return (
      (f.kind === 'checkbox' && f.widgets.length > 1) ||
      (f.kind === 'list' && this.multiple(f.name))
    );
  }

  private multiple(name: string): boolean {
    return !!this.objects?.[name]?.some((o) => o.multipleSelection);
  }

  /** A list where several options can be chosen: each option chosen or
   *  not, as on the page */
  private listSteps(f: LiveField, s: LiveField) {
    const id = this.ids.get(f.name)?.[0];
    const v = id
      ? (
          this.pdf?.annotationStorage.getRawValue(id) as
            | { value?: unknown }
            | undefined
        )?.value
      : undefined;
    const widget = s.widgets[0];
    if (v === undefined || !widget) return [];
    const chosen = new Set(
      (Array.isArray(v) ? v : v == null ? [] : [v]).map(String)
    );
    const items = this.items(f.name);
    return widget.field.options.flatMap((o, i) => {
      const want = chosen.has(items[i]?.exportValue ?? o.label);
      return want === !!o.isSelected
        ? []
        : [
            {
              widget,
              value: { kind: 'selection' as const, index: i, isSelected: want },
            },
          ];
    });
  }

  /** Puts a field's value into PDFium's copy, once typing pauses */
  private saveSoon(name: string) {
    clearTimeout(this.toSave.get(name));
    this.toSave.set(
      name,
      setTimeout(() => {
        this.toSave.delete(name);
        this.save(name);
      }, 250)
    );
  }

  private save(name: string) {
    const run = async () => {
      const f = this.field(name);
      const s = this.saved.find((x) => x.name === name);
      if (!f || !s || !this.allowed) return;
      // PDFium draws text as shown ("$1,234.50"); the value as typed goes
      // in when it's saved (formatted())
      const want =
        f.kind === 'text' ? (this.shown.get(name) ?? f.value) : f.value;
      const group = f.kind === 'checkbox' && f.widgets.length > 1;
      const steps = group
        ? this.boxSteps(f, s)
        : f.kind === 'list' && this.multiple(name)
          ? this.listSteps(f, s)
          : stepsTo(s, want, true);
      if (!steps.length) return;
      for (const step of steps)
        if (
          !(await this.viewer.setFormValue(this.tabId, step.widget, step.value))
        )
          break;
      const pages = [...new Set(s.widgets.map((w) => w.pageIndex))];
      for (const i of pages)
        this.pages[i] = await this.viewer.pageWidgets(this.tabId, i);
      this.saved = buildFields(this.pages, this.meta);
      // (a checkbox group may take a second press: one on, then one off)
      const now = this.saved.find((x) => x.name === name);
      if (group && now && this.boxSteps(f, now).length) this.save(name);
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
  }
}

/* The fields on the page ------------------------------------------------- */

interface PageLayer {
  index: number;
  box: HTMLElement;
  div: HTMLElement;
  /** Page width in PDF units, to scale the fields with the zoom */
  width: number;
  ready: Promise<void>;
  /** PDFium's drawings of fields pdf.js leaves to the page */
  patches: { canvas: HTMLCanvasElement; rect: PageWidget['rect'] }[];
  scale: number;
}

/** pdf.js looks up a radio button's or checkbox's siblings in `document`;
 *  the fields are in the viewer's shadow root */
let fieldsRoot: (() => ShadowRoot | null) | null = null;
const documentQuery = Document.prototype.querySelector;
Document.prototype.querySelector = function (
  this: Document,
  selectors: string
) {
  const found = documentQuery.call(this, selectors);
  if (
    found ||
    this !== document ||
    !fieldsRoot ||
    !selectors.startsWith('[data-element-id=')
  )
    return found;
  return fieldsRoot()?.querySelector(selectors) ?? null;
} as typeof Document.prototype.querySelector;

/** The fields on the shown document's pages */
export class FormLayer {
  private session: FormSession | null = null;
  private observer?: MutationObserver;
  private resize = new ResizeObserver((entries) => {
    for (const e of entries) {
      const layer = [...this.layers.values()].find((l) => l.box === e.target);
      if (layer) this.fit(layer);
    }
  });
  private frame = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private interactive = true;
  private highlight = true;
  private layers = new Map<number, PageLayer>();
  /** A page's first (or last) field to focus once it's shown (Tab onto
   *  another page) */
  private pendingFocus?: { page: number; last: boolean };

  constructor(
    private viewer: Viewer,
    private hooks: {
      /** A signature field was pressed */
      onSignature: (field: LiveField) => void;
    }
  ) {
    fieldsRoot = () => viewer.shadow();
  }

  /** Shows the fields of this document (null: none) */
  show(session: FormSession | null) {
    if (session === this.session) return this.schedule();
    this.commit();
    this.session = session;
    this.removeLayers();
    if (!session) return;
    this.ensureObserver();
    this.schedule();
  }

  /** The text field being typed in, to commit if its page goes away
   *  (scrolled out of view: the browser says nothing then) */
  private focused?: {
    el: HTMLInputElement | HTMLTextAreaElement;
    id: string;
    session: FormSession;
  };

  private checkLostFocus() {
    const f = this.focused;
    if (!f || f.el.isConnected) return;
    this.focused = undefined;
    f.session.commitLost(f.id, f.el.value);
  }

  /** Lays the fields again (the document's scripts started or stopped) */
  rebuild() {
    this.commit();
    this.removeLayers();
    this.schedule();
  }

  get current(): FormSession | null {
    return this.session;
  }

  /** Off while an annotation tool, the hand or zooming is in use */
  setInteractive(on: boolean) {
    if (on === this.interactive) return;
    this.interactive = on;
    for (const l of this.layers.values()) this.applyInteractive(l.div);
  }

  /** Tints the fields (as Acrobat's "Highlight existing fields") */
  setHighlight(on: boolean) {
    this.highlight = on;
    for (const l of this.layers.values())
      l.div.classList.toggle('is-highlight', on);
  }

  /** Leaves the field being typed in, so what was typed goes in (and to
   *  the document's scripts, which pdf.js tells only when the focus moves
   *  to something else, not when it's lost) */
  commit() {
    const active = this.viewer.shadow()?.activeElement;
    if (!(active instanceof HTMLElement) || !active.closest('.pwf-layer'))
      return;
    const sink = active
      .closest('.pwf-layer')
      ?.querySelector<HTMLElement>(':scope > .pwf-sink');
    if (sink) sink.focus({ preventScroll: true });
    else active.blur();
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

  private removeLayers() {
    for (const l of this.layers.values()) this.removeLayer(l);
    this.layers.clear();
    this.viewer
      .shadow()
      ?.querySelectorAll('.pwf-layer')
      .forEach((l) => l.remove());
  }

  private removeLayer(l: PageLayer) {
    this.resize.unobserve(l.box);
    l.div.remove();
  }

  /** Lays the fields over each page shown (pages come and go as the
   *  document scrolls) */
  private reconcile() {
    this.checkLostFocus();
    const s = this.session;
    const root = this.viewer.shadow();
    if (!s?.pdf || !root) return;
    // (while the viewer switches documents, its pages are another's)
    if (!this.viewer.isShowing(s.tabId)) {
      this.removeLayers();
      return;
    }
    const layout = this.viewer.pageLayout(s.tabId);
    if (!layout) return;
    const shown = new Set<number>();
    for (const { page, index } of findPages(root, layout)) {
      if (!s.view(index)) continue;
      shown.add(index);
      const l = this.layers.get(index);
      if (l && l.box === page && l.div.isConnected) continue;
      if (l) this.removeLayer(l);
      this.layers.set(index, this.buildLayer(s, index, page));
    }
    // Layers left on pages that went away
    for (const [index, l] of this.layers)
      if (!shown.has(index)) {
        this.removeLayer(l);
        this.layers.delete(index);
      }
  }

  private buildLayer(
    s: FormSession,
    index: number,
    box: HTMLElement
  ): PageLayer {
    const div = document.createElement('div');
    div.className = 'pwf-layer annotationLayer';
    div.dataset.page = String(index);
    div.classList.toggle('is-highlight', this.highlight);
    // Something to move the focus to, so leaving a field commits it
    const sink = document.createElement('div');
    sink.className = 'pwf-sink';
    sink.tabIndex = -1;
    div.append(sink);
    // Clicking the page away from a field commits it too
    if (box.tabIndex < 0 && !box.hasAttribute('tabindex')) {
      box.tabIndex = -1;
      box.style.outline = 'none';
    }
    // The viewer selects text and annotations on pointer down: not on fields
    for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick'])
      div.addEventListener(type, (e) => {
        if ((e.target as Element).closest?.('section, .pwf-sign'))
          e.stopPropagation();
      });
    div.addEventListener('keydown', (e) => this.onKey(e, index));
    // Clicked or typed in: what follows is the person's
    for (const type of ['pointerdown', 'keydown'])
      div.addEventListener(
        type,
        (e) => {
          const id = (e.target as HTMLElement).dataset?.elementId;
          const name = e.isTrusted && id && s.nameOf(id);
          if (name) s.touchedByHand(name);
        },
        true
      );
    div.addEventListener('focusin', (e) => {
      const id = (e.target as HTMLElement).dataset?.elementId;
      const name = id && s.nameOf(id);
      if (
        id &&
        (e.target instanceof HTMLInputElement ||
          e.target instanceof HTMLTextAreaElement)
      )
        this.focused = { el: e.target, id, session: s };
      if (
        name &&
        e.target instanceof HTMLInputElement &&
        /text|password/.test(e.target.type)
      )
        s.startTyping(name);
      else if (name && e.target instanceof HTMLTextAreaElement)
        s.startTyping(name);
    });
    div.addEventListener('focusout', (e) => {
      const id = (e.target as HTMLElement).dataset?.elementId;
      const name = id && s.nameOf(id);
      if (name) s.stopTyping(name);
      if (this.focused?.el === e.target) this.focused = undefined;
    });
    box.append(div);
    const layer: PageLayer = {
      index,
      box,
      div,
      width: 0,
      ready: Promise.resolve(),
      patches: [],
      scale: 0,
    };
    layer.ready = this.render(s, layer).catch((err) =>
      console.warn(`Couldn't show the fields of page ${index + 1}`, err)
    );
    this.resize.observe(box);
    return layer;
  }

  private async render(s: FormSession, layer: PageLayer) {
    const { lib } = await loadPdfjs();
    const pdf = s.pdf;
    if (!pdf) return;
    const page = await pdf.getPage(layer.index + 1);
    const annotations = (await s.annotationsOf(layer.index)).filter(
      (a) => a.annotationType === WIDGET
    );
    if (this.session !== s || !layer.div.isConnected) return;
    const viewport = page.getViewport({ scale: 1 });
    layer.width = viewport.width;
    this.fit(layer);
    // Fields pdf.js leaves to the page's drawing: PDFium draws them
    const canvases = new Map<string, HTMLCanvasElement>();
    for (const a of annotations) {
      if (!a.hasOwnCanvas || a.hidden) continue;
      const canvas = document.createElement('canvas');
      canvases.set(a.id, canvas);
      this.patch(layer, canvas, a.rect, s);
    }
    const annotationLayer = new lib.AnnotationLayer({
      div: layer.div,
      page,
      viewport,
      annotationCanvasMap: canvases,
      accessibilityManager: null,
      annotationEditorUIManager: null,
      structTreeLayer: null,
      linkService: s.linkService,
      annotationStorage: pdf.annotationStorage,
    } as any);
    const sink = layer.div.querySelector('.pwf-sink');
    await annotationLayer.render({
      annotations,
      renderForms: true,
      linkService: s.linkService,
      downloadManager: null,
      annotationStorage: pdf.annotationStorage,
      enableScripting: !!s.scripts,
      hasJSActions: s.hasJSActions,
      fieldObjects: s.objects,
      imageResourcesPath: '',
    } as any);
    if (this.session !== s) return;
    // (pdf.js empties the layer first)
    if (sink && !sink.isConnected) layer.div.prepend(sink);
    // Signatures: PDFium's drawing, and a button to sign with Fill & Sign
    for (const a of annotations) {
      if (a.fieldType !== 'Sig' || a.hidden) continue;
      const f = a.fieldName ? s.field(a.fieldName) : undefined;
      const box = placeOf(a.rect, viewport);
      const wrap = document.createElement('div');
      wrap.className = 'pwf-sig';
      Object.assign(wrap.style, box.style);
      if (!a.hasOwnCanvas) {
        const canvas = document.createElement('canvas');
        wrap.append(canvas);
        this.patch(layer, canvas, a.rect, s);
      }
      if (f) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pwf-sign';
        b.setAttribute('aria-label', f.label);
        b.title = 'Sign with Fill & Sign';
        b.addEventListener('click', () => this.hooks.onSignature(f));
        wrap.append(b);
      }
      layer.div.append(wrap);
    }
    if (!s.allowed)
      layer.div
        .querySelectorAll<HTMLInputElement>('input, select, textarea')
        .forEach((c) => (c.disabled = true));
    this.applyInteractive(layer.div);
    if (this.pendingFocus?.page === layer.index) {
      const { last } = this.pendingFocus;
      this.pendingFocus = undefined;
      const list = focusables(layer.div);
      (last ? list.at(-1) : list[0])?.focus();
    }
  }

  /** The fields' size follows the page's (the zoom) */
  private fit(layer: PageLayer) {
    if (!layer.width) return;
    const scale = layer.box.clientWidth / layer.width;
    if (!scale) return;
    layer.div.style.setProperty('--scale-factor', String(scale));
    if (Math.abs(scale - layer.scale) / (layer.scale || 1) > 0.2) {
      layer.scale = scale;
      // Sharp again after zooming in
      if (this.session)
        for (const p of layer.patches)
          void this.drawPatch(this.session, layer, p.canvas, p.rect);
    }
  }

  /** PDFium's drawing of a field, on `canvas` */
  private patch(
    layer: PageLayer,
    canvas: HTMLCanvasElement,
    pdfRect: number[],
    s: FormSession
  ) {
    const view = s.view(layer.index);
    if (!view) return;
    const rect = {
      origin: { x: pdfRect[0] - view[0], y: view[3] - pdfRect[3] },
      size: {
        width: Math.abs(pdfRect[2] - pdfRect[0]),
        height: Math.abs(pdfRect[3] - pdfRect[1]),
      },
    };
    layer.patches.push({ canvas, rect });
    void this.drawPatch(s, layer, canvas, rect);
  }

  private async drawPatch(
    s: FormSession,
    layer: PageLayer,
    canvas: HTMLCanvasElement,
    rect: PageWidget['rect']
  ) {
    const scale = (layer.box.clientWidth / (layer.width || 1)) * (72 / 96);
    const blob = await this.viewer.drawFields(
      s.tabId,
      layer.index,
      rect,
      Math.max(scale, 0.25)
    );
    if (!blob) return;
    const bitmap = await createImageBitmap(blob);
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    bitmap.close();
  }

  private applyInteractive(div: HTMLElement) {
    div.classList.toggle('is-off', !this.interactive);
    for (const c of focusables(div, true))
      c.tabIndex = this.interactive ? 0 : -1;
  }

  /** Tab and Shift+Tab go on to the next page's fields when that page
   *  isn't shown yet (when it is, they're next on the page already) */
  private onKey(e: KeyboardEvent, index: number) {
    const s = this.session;
    if (e.key !== 'Tab' || !s) return;
    const layer = this.layers.get(index);
    if (!layer) return;
    const list = focusables(layer.div);
    const at = list.indexOf(e.target as HTMLElement);
    if (at < 0) return;
    const back = e.shiftKey;
    if (back ? at > 0 : at < list.length - 1) return;
    const pages = s.fieldPages;
    const next = back
      ? pages.filter((p) => p < index).at(-1)
      : pages.find((p) => p > index);
    if (next === undefined) return; // out of the form: the browser's own Tab
    const shownNext = this.layers.get(next);
    if (shownNext && focusables(shownNext.div).length) {
      e.preventDefault();
      const l = focusables(shownNext.div);
      (back ? l.at(-1) : l[0])?.focus();
      return;
    }
    e.preventDefault();
    this.pendingFocus = { page: next, last: back };
    this.viewer.goToPage(s.tabId, next + 1);
    this.schedule();
  }
}

/** The fields one can Tab to, in order */
function focusables(div: HTMLElement, all = false): HTMLElement[] {
  return [
    ...div.querySelectorAll<HTMLElement>(
      'section input, section select, section textarea, section a, .pwf-sign'
    ),
  ].filter(
    (c) =>
      !(c as HTMLInputElement).disabled && !c.hidden && (all || c.tabIndex >= 0)
  );
}

/** Where a widget (PDF space) sits on its page as shown (in the page's
 *  own rotation), as percentages */
function placeOf(
  rect: number[],
  viewport: {
    width: number;
    height: number;
    convertToViewportRectangle(r: number[]): number[];
  }
) {
  const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(rect);
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  return {
    style: {
      left: pct(Math.min(x1, x2), viewport.width),
      top: pct(Math.min(y1, y2), viewport.height),
      width: pct(Math.abs(x2 - x1), viewport.width),
      height: pct(Math.abs(y2 - y1), viewport.height),
    },
  };
}

/**
 * The viewer's pages shown now, with their index: each page is drawn in a
 * box as large as the page at the current zoom; which page it is follows
 * from where it sits in the document, by the viewer's layout.
 */
/**
 * The viewer's pages: each the unrotated page, a positioned box (sized in
 * px) holding the page image first, inside the box that's rotated. Nothing
 * that changes with the mode counts (Hand takes the boxes' touch-action
 * away, for one), so the fields stay on their pages in every mode.
 */
export function pageBoxes(scope: ParentNode): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>('div')].filter(
    (d) =>
      d.style.position === 'relative' &&
      /px$/.test(d.style.width) &&
      d.firstElementChild instanceof HTMLImageElement &&
      !!contentOf(d)
  );
}

/** The document's content area: everything is placed from its top left */
function contentOf(box: HTMLElement): HTMLElement | null {
  let content = box.parentElement;
  while (
    content &&
    !(
      content.style.margin === '0px auto' &&
      content.style.position === 'relative'
    )
  )
    content = content.parentElement;
  return content;
}

function findPages(
  root: ShadowRoot,
  layout: { scale: number; pages: Map<number, { x: number; y: number }> }
): { page: HTMLElement; index: number }[] {
  const out: { page: HTMLElement; index: number }[] = [];
  const boxes = pageBoxes(root);
  if (!boxes.length) return out;
  const scale = layout.scale;
  const origin = contentOf(boxes[0])!.getBoundingClientRect();
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

/** The fields' look (pdf.js's, as in Firefox and Fill & Sign), in the
 *  viewer's shadow root */
function ensureStyles(root: ShadowRoot) {
  if (root.getElementById('pwf-style')) return;
  const style = document.createElement('style');
  style.id = 'pwf-style';
  style.textContent = `
    .pwf-layer {
      --user-unit: 1;
      --total-scale-factor: calc(var(--scale-factor, 1) * var(--user-unit));
      --annotation-unfocused-field-background: none;
      --input-focus-border-color: #3b63fb;
      --input-focus-outline: 1px solid #3b63fb;
      --input-unfocused-border-color: transparent;
      --input-disabled-border-color: transparent;
      --input-hover-border-color: #3b63fb;
      color-scheme: only light;
      position: absolute; inset: 0; z-index: 3;
      width: 100% !important; height: 100% !important;
      pointer-events: none; transform-origin: 0 0;
    }
    .pwf-layer.is-highlight {
      --annotation-unfocused-field-background: linear-gradient(rgb(0 54 255 / 0.13), rgb(0 54 255 / 0.13));
    }
    .pwf-layer .pwf-sink { position: absolute; width: 0; height: 0; outline: none; }
    .pwf-layer[data-main-rotation="90"] .norotate { transform: rotate(270deg) translateX(-100%); }
    .pwf-layer[data-main-rotation="180"] .norotate { transform: rotate(180deg) translate(-100%, -100%); }
    .pwf-layer[data-main-rotation="270"] .norotate { transform: rotate(90deg) translateY(-100%); }
    .pwf-layer section {
      position: absolute; text-align: initial; pointer-events: auto;
      box-sizing: border-box; transform-origin: 0 0; user-select: none;
    }
    .pwf-layer .annotationContent { position: absolute; width: 100%; height: 100%; pointer-events: none; }
    .pwf-layer section canvas.annotationContent, .pwf-layer .pwf-sig canvas {
      position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none;
    }
    .pwf-layer.is-off section, .pwf-layer.is-off .pwf-sign { pointer-events: none; }
    .pwf-layer .buttonWidgetAnnotation.pushButton > a {
      position: absolute; font-size: 1em; top: 0; left: 0; width: 100%; height: 100%;
    }
    .pwf-layer .buttonWidgetAnnotation.pushButton:not(.hasBorder) > a:hover {
      background-color: rgb(59 99 251 / 0.15);
    }
    .pwf-layer .hasBorder { background-size: 100% 100%; }
    .pwf-layer .textWidgetAnnotation :is(input, textarea),
    .pwf-layer .choiceWidgetAnnotation select,
    .pwf-layer .buttonWidgetAnnotation:is(.checkBox, .radioButton) input {
      background-image: var(--annotation-unfocused-field-background);
      border: 2px solid var(--input-unfocused-border-color);
      box-sizing: border-box;
      font: calc(9px * var(--total-scale-factor)) Helvetica, Arial, sans-serif;
      height: 100%; margin: 0; vertical-align: top; width: 100%;
      color: #000; padding: 0 2px;
    }
    .pwf-layer .textWidgetAnnotation :is(input, textarea):required,
    .pwf-layer .choiceWidgetAnnotation select:required,
    .pwf-layer .buttonWidgetAnnotation:is(.checkBox, .radioButton) input:required {
      outline: 1px solid rgb(211 21 16 / 0.7);
    }
    .pwf-layer:not(.is-highlight) :is(input, select, textarea):required { outline: none; }
    .pwf-layer .choiceWidgetAnnotation select option { padding: 0; }
    .pwf-layer .buttonWidgetAnnotation.radioButton input { border-radius: 50%; }
    .pwf-layer .textWidgetAnnotation textarea { resize: none; }
    .pwf-layer .textWidgetAnnotation [disabled]:is(input, textarea),
    .pwf-layer .choiceWidgetAnnotation select[disabled],
    .pwf-layer .buttonWidgetAnnotation:is(.checkBox, .radioButton) input[disabled] {
      background: none; border: 2px solid var(--input-disabled-border-color); cursor: not-allowed;
    }
    .pwf-layer .textWidgetAnnotation :is(input, textarea):hover,
    .pwf-layer .choiceWidgetAnnotation select:hover,
    .pwf-layer .buttonWidgetAnnotation:is(.checkBox, .radioButton) input:hover {
      border: 2px solid var(--input-hover-border-color);
    }
    .pwf-layer .textWidgetAnnotation :is(input, textarea):hover,
    .pwf-layer .choiceWidgetAnnotation select:hover,
    .pwf-layer .buttonWidgetAnnotation.checkBox input:hover { border-radius: 2px; }
    .pwf-layer .textWidgetAnnotation :is(input, textarea):focus,
    .pwf-layer .choiceWidgetAnnotation select:focus {
      background: none; background-color: #fff;
      border: 2px solid var(--input-focus-border-color);
      border-radius: 2px; outline: var(--input-focus-outline);
    }
    .pwf-layer .buttonWidgetAnnotation:is(.checkBox, .radioButton) :focus {
      background-image: none; background-color: transparent;
    }
    .pwf-layer .buttonWidgetAnnotation.checkBox :focus {
      border: 2px solid var(--input-focus-border-color);
      border-radius: 2px; outline: var(--input-focus-outline);
    }
    .pwf-layer .buttonWidgetAnnotation.radioButton :focus {
      border: 2px solid var(--input-focus-border-color); outline: var(--input-focus-outline);
    }
    .pwf-layer .buttonWidgetAnnotation.checkBox input:checked::before,
    .pwf-layer .buttonWidgetAnnotation.checkBox input:checked::after,
    .pwf-layer .buttonWidgetAnnotation.radioButton input:checked::before {
      background-color: #000; content: ""; display: block; position: absolute;
    }
    .pwf-layer .buttonWidgetAnnotation.checkBox input:checked::before,
    .pwf-layer .buttonWidgetAnnotation.checkBox input:checked::after {
      height: 80%; left: 45%; width: 1px;
    }
    .pwf-layer .buttonWidgetAnnotation.checkBox input:checked::before { transform: rotate(45deg); }
    .pwf-layer .buttonWidgetAnnotation.checkBox input:checked::after { transform: rotate(-45deg); }
    .pwf-layer .buttonWidgetAnnotation.radioButton input:checked::before {
      border-radius: 50%; height: 50%; left: 25%; top: 25%; width: 50%;
    }
    .pwf-layer .textWidgetAnnotation input.comb { font-family: monospace; padding-left: 2px; padding-right: 0; }
    .pwf-layer .textWidgetAnnotation input.comb:focus { width: 103%; }
    .pwf-layer .buttonWidgetAnnotation:is(.checkBox, .radioButton) input { appearance: none; }
    .pwf-layer .pwf-sig { position: absolute; }
    .pwf-layer .pwf-sign {
      position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; padding: 0;
      border: 0; background: var(--annotation-unfocused-field-background); cursor: pointer;
      pointer-events: auto;
    }
    .pwf-layer .pwf-sign:hover { background: rgb(59 99 251 / 0.2); }
    .pwf-layer .pwf-sign:focus-visible { outline: 2px solid #3b63fb; }
  `;
  root.append(style);
}
