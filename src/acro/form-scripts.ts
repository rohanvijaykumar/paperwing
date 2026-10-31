/**
 * A form's scripts, run as Firefox runs them: in pdf.js's sandbox, a small
 * JavaScript engine (QuickJS, compiled to WebAssembly) that holds only
 * Acrobat's form functions. Scripts can work out totals, format numbers and
 * dates, check what's typed and show messages; they can't reach files, the
 * network or the rest of the app (pdf.js leaves out submitting forms,
 * opening links and mailing documents). It runs in a frame of its own, so
 * its messages come here, not to the app's window.
 *
 * What the scripts decide goes into the document through FormSession.set
 * (PDFium draws it): a formatted value is drawn as formatted ("$1,234.50")
 * while the value as typed ("1234.5") is what the document keeps when
 * saved (forms.ts, unformat), as Acrobat does.
 */
import sandboxUrl from 'pdfjs-dist/build/pdf.sandbox.mjs?url';
import type { ChangeOrigin, FormSession, ScriptedForm } from './form-layer';
import type { FieldState, LiveField } from './form-model';
import { loadPdfjs } from './thumbnails';

export interface ScriptHost {
  /** app.alert(): a message from the document */
  alert(message: string): void;
  /** this.print(): the print dialog */
  print(): void;
}

interface Sandbox {
  create(data: unknown): void;
  dispatchEvent(event: Record<string, unknown>): void;
  nukeSandbox(): void;
}

/** What the sandbox sends: a field's new value, or a command */
interface Update {
  id?: string;
  value?: unknown;
  formattedValue?: string | null;
  focus?: boolean;
  command?: string;
}

/** pdf.js's description of a widget (getFieldObjects) */
interface FieldObject {
  id: string;
  page?: number;
  rect?: number[];
  type?: string;
}

export class FormScripts implements ScriptedForm {
  private frame: HTMLIFrameElement;
  private sandbox?: Sandbox;
  /** pdf.js's widget ids by field name and widget, and the reverse */
  private ids = new Map<string, string[]>();
  private names = new Map<string, string>();
  /** Text fields' values as typed, where the scripts show them otherwise */
  private raws = new Map<string, string>();
  /** A person's change the scripts are deciding on, by field name: whose it
   *  was and what to set if the scripts say nothing */
  private pending = new Map<
    string,
    {
      origin: 'user' | 'undo';
      want: FieldState;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private opening = true;

  private constructor(
    private session: FormSession,
    private host: ScriptHost,
    frame: HTMLIFrameElement
  ) {
    this.frame = frame;
  }

  /**
   * Starts the scripts of the document `bytes` (its form as `session` holds
   * it), running its "when opened" scripts. Null if it has none to run.
   */
  static async start(
    bytes: ArrayBuffer,
    session: FormSession,
    host: ScriptHost,
    pageSizes: { width: number; height: number }[]
  ): Promise<FormScripts | null> {
    const { lib, worker } = await loadPdfjs();
    const doc = await lib.getDocument({
      data: new Uint8Array(bytes.slice(0)),
      worker,
      wasmUrl: import.meta.env.BASE_URL + 'pdfjs-viewer/wasm/',
      isEvalSupported: false,
    }).promise;
    let objects: Record<string, FieldObject[]> | null;
    let calculationOrder: string[] | null;
    let actions: Record<string, string[]> | null;
    let pageActions: unknown;
    /** Each page's view box ([x1, y1, x2, y2]): pdf.js places widgets in
     *  PDF space, PDFium from the view's top left */
    const views = new Map<number, number[]>();
    try {
      [objects, calculationOrder, actions] = await Promise.all([
        doc.getFieldObjects() as Promise<Record<string, FieldObject[]> | null>,
        doc.getCalculationOrderIds(),
        doc.getJSActions() as Promise<Record<string, string[]> | null>,
      ]);
      const first = await doc.getPage(1);
      pageActions = await first.getJSActions();
      // (fields without a widget of their own are on page -1)
      const pages = new Set(
        Object.values(objects ?? {})
          .flat()
          .map((o) => o.page ?? -1)
          .filter((p) => p >= 0 && p < doc.numPages)
      );
      for (const p of pages) views.set(p, [...(await doc.getPage(p + 1)).view]);
    } finally {
      void doc.destroy();
    }
    if (!objects && !actions && !pageActions) return null;

    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.setAttribute('aria-hidden', 'true');
    frame.srcdoc = '<!doctype html><title>Form scripts</title>';
    const loaded = new Promise((r) =>
      frame.addEventListener('load', r, { once: true })
    );
    document.body.append(frame);
    await loaded;
    const win = frame.contentWindow as Window & {
      __pwSandbox?: Promise<Sandbox>;
    };
    const scripts = new FormScripts(session, host, frame);
    scripts.mapWidgets(objects ?? {}, pageSizes, views);
    // The document's messages: shown by the app (not the frame's own alert)
    win.alert = (message?: unknown) => host.alert(String(message ?? ''));
    win.addEventListener('updatefromsandbox', (e) =>
      scripts.onUpdate((e as CustomEvent<Update>).detail)
    );
    const loader = win.document.createElement('script');
    loader.type = 'module';
    loader.textContent = `import { QuickJSSandbox } from ${JSON.stringify(
      new URL(sandboxUrl, location.href).href
    )}; window.__pwSandbox = QuickJSSandbox();`;
    win.document.head.append(loader);
    for (let i = 0; i < 200 && !win.__pwSandbox; i++)
      await new Promise((r) => setTimeout(r, 25));
    if (!win.__pwSandbox) {
      frame.remove();
      throw new Error("the script engine didn't load");
    }
    scripts.sandbox = await win.__pwSandbox;
    scripts.sandbox.create({
      objects: objects ?? {},
      calculationOrder: calculationOrder ?? [],
      appInfo: { platform: navigator.platform, language: navigator.language },
      docInfo: {
        actions: actions ?? {},
        numPages: pageSizes.length,
        filename: '',
        filesize: bytes.byteLength,
      },
    });
    // When it opens: the document's scripts, then its first page's; the
    // fields are formatted (which isn't a change to the document)
    scripts.sandbox.dispatchEvent({ id: 'doc', name: 'Open' });
    if (pageActions)
      scripts.sandbox.dispatchEvent({
        id: 'page',
        name: 'PageOpen',
        pageNumber: 1,
        actions: pageActions,
      });
    await session.settled();
    scripts.opening = false;
    return scripts;
  }

  /** Matches pdf.js's widgets with PDFium's, by field and place */
  private mapWidgets(
    objects: Record<string, FieldObject[]>,
    pageSizes: { width: number; height: number }[],
    views: Map<number, number[]>
  ) {
    for (const [name, list] of Object.entries(objects)) {
      const field = this.session.field(name);
      const widgets = list.filter(
        (o) => o.rect && o.page !== undefined && o.page >= 0
      );
      for (const o of list) this.names.set(o.id, name);
      if (!field) continue;
      const ids = field.widgets.map((w) => {
        const near = widgets.find((o) => {
          const view = views.get(o.page!) ?? [
            0,
            0,
            0,
            pageSizes[o.page!]?.height ?? 0,
          ];
          const x = o.rect![0] - view[0];
          const y = view[3] - o.rect![3];
          return (
            o.page === w.pageIndex &&
            Math.abs(x - w.rect.origin.x) < 3 &&
            Math.abs(y - w.rect.origin.y) < 3
          );
        });
        return near?.id ?? widgets[0]?.id ?? list[0]?.id;
      });
      this.ids.set(name, ids);
    }
  }

  private idFor(f: LiveField, index = 0): string | undefined {
    const ids = this.ids.get(f.name);
    return ids?.[index] ?? ids?.[0];
  }

  raw(name: string): string | undefined {
    return this.raws.get(name);
  }

  /** What a field holds, as its scripts see it (an export value) */
  private exportOf(f: LiveField, want: FieldState): string {
    if (f.kind === 'checkbox') return want ? 'Yes' : 'Off';
    if (typeof want === 'number') return f.options[want] ?? '';
    return String(want);
  }

  fill(f: LiveField, want: FieldState, origin: 'user' | 'undo'): void {
    const id = this.idFor(f);
    if (!this.sandbox || !id) {
      void this.session.set(f.name, want, origin);
      return;
    }
    if (f.kind !== 'text') {
      // Ticked, chosen or picked: set, then the scripts work out the rest
      void this.session.set(f.name, want, origin).then(() =>
        this.dispatch({
          id,
          name: 'Keystroke',
          value: this.exportOf(f, want),
          change: '',
          willCommit: true,
          commitKey: 1,
          selStart: 0,
          selEnd: 0,
        })
      );
      return;
    }
    // Typed: the scripts check it, format it and work out other fields; if
    // they say nothing about it, it goes in as typed
    const text = String(want);
    const prev = this.pending.get(f.name);
    if (prev) clearTimeout(prev.timer);
    this.pending.set(f.name, {
      origin,
      want,
      timer: setTimeout(() => {
        if (this.pending.get(f.name)?.want !== want) return;
        this.pending.delete(f.name);
        this.raws.delete(f.name);
        void this.session.set(f.name, want, origin);
      }, 600),
    });
    this.dispatch({
      id,
      name: 'Keystroke',
      value: text,
      change: '',
      willCommit: true,
      commitKey: 1,
      selStart: text.length,
      selEnd: text.length,
    });
  }

  focus(f: LiveField, index: number) {
    const id = this.idFor(f, index);
    if (id) this.dispatch({ id, name: 'Focus' });
  }

  blur(f: LiveField, index: number) {
    const id = this.idFor(f, index);
    if (id) this.dispatch({ id, name: 'Blur' });
  }

  press(f: LiveField, index: number) {
    const id = this.idFor(f, index);
    if (!id) return;
    this.dispatch({ id, name: 'Mouse Down' });
    this.dispatch({ id, name: 'Mouse Up' });
  }

  private dispatch(event: Record<string, unknown>) {
    try {
      this.sandbox?.dispatchEvent(event);
    } catch (err) {
      console.warn('A form script failed', err);
    }
  }

  /** What the scripts decided: field values, or something to do */
  private onUpdate(u: Update) {
    if (!u) return;
    if (u.command) {
      if (u.command === 'print') this.host.print();
      else if (u.command === 'error')
        console.warn('A form script failed:', u.value);
      else if (u.command === 'println') console.info('Form script:', u.value);
      return;
    }
    const name = u.id ? this.names.get(u.id) : undefined;
    const f = name ? this.session.field(name) : undefined;
    if (!f || !name || !('value' in u)) return;
    const pending = this.pending.get(name);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(name);
    }
    const origin: ChangeOrigin = pending
      ? pending.origin
      : this.opening
        ? 'open'
        : 'script';
    const value = u.value;
    if (f.kind === 'text') {
      const raw = Array.isArray(value) ? value.join(', ') : String(value ?? '');
      const shown = u.formattedValue ?? raw;
      if (shown !== raw) this.raws.set(name, raw);
      else this.raws.delete(name);
      void this.session.set(name, shown, origin);
    } else {
      const v = String(value ?? '');
      const want: FieldState =
        f.kind === 'checkbox'
          ? v !== 'Off' && v !== '' && v !== 'false'
          : f.options.indexOf(v);
      if (want !== -1) void this.session.set(name, want, origin);
    }
  }

  /** Text fields shown formatted, with their values as typed */
  formatted(): Map<string, string> {
    return new Map(this.raws);
  }

  stop() {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    try {
      this.sandbox?.nukeSandbox();
    } catch {
      // (already gone)
    }
    this.sandbox = undefined;
    this.frame.remove();
  }
}
