/**
 * A form's scripts, run as Firefox runs them: in pdf.js's sandbox, a small
 * JavaScript engine (QuickJS, compiled to WebAssembly) that holds only
 * Acrobat's form functions. Scripts can work out totals, format numbers and
 * dates, check what's typed and show messages; they can't reach files, the
 * network or the rest of the app (pdf.js leaves out submitting forms,
 * opening links and mailing documents). It runs in a frame of its own, so
 * its messages come here, not to the app's window.
 *
 * The fields on the page (pdf.js's own, form-layer.ts) send it what's
 * typed, clicked and chosen; what it decides comes back to them.
 */
import sandboxUrl from 'pdfjs-dist/build/pdf.sandbox.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist';

export interface ScriptHost {
  /** app.alert(): a message from the document */
  alert(message: string): void;
  /** What the scripts decided: a field's value, or a command */
  update(update: SandboxUpdate): void;
}

interface Sandbox {
  create(data: unknown): void;
  dispatchEvent(event: Record<string, unknown>): void;
  nukeSandbox(): void;
}

/** What the sandbox sends: a field's new value (and how it shows), or a
 *  command (print, a message for the console...) */
export interface SandboxUpdate {
  id?: string;
  siblings?: string[];
  value?: unknown;
  formattedValue?: string | null;
  command?: string;
  [key: string]: unknown;
}

export class FormScripts {
  private sandbox?: Sandbox;

  private constructor(private frame: HTMLIFrameElement) {}

  /**
   * Starts the scripts of `pdf` (pdf.js's copy of the open document) and
   * runs its "when opened" scripts. Null if it has none.
   */
  static async start(
    pdf: PDFDocumentProxy,
    objects: Record<string, unknown[]> | null,
    host: ScriptHost
  ): Promise<FormScripts | null> {
    const [calculationOrder, actions, pageActions] = await Promise.all([
      pdf.getCalculationOrderIds(),
      pdf.getJSActions() as Promise<Record<string, string[]> | null>,
      pdf.getPage(1).then((p) => p.getJSActions()),
    ]);
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
    const scripts = new FormScripts(frame);
    // The document's messages: shown by the app (not the frame's own alert)
    win.alert = (message?: unknown) => host.alert(String(message ?? ''));
    win.addEventListener('updatefromsandbox', (e) => {
      const detail = (e as CustomEvent<SandboxUpdate>).detail;
      if (detail) host.update(detail);
    });
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
    try {
      scripts.sandbox = await win.__pwSandbox;
    } catch (err) {
      frame.remove();
      throw err;
    }
    try {
      scripts.sandbox.create({
        objects: objects ?? {},
        calculationOrder: calculationOrder ?? [],
        appInfo: { platform: navigator.platform, language: navigator.language },
        docInfo: {
          actions: actions ?? {},
          numPages: pdf.numPages,
          filename: '',
          filesize: (await pdf.getDownloadInfo()).length,
        },
      });
    } catch (err) {
      scripts.stop();
      throw err;
    }
    // When it opens: the document's scripts, then its first page's
    scripts.dispatch({ id: 'doc', name: 'Open' });
    scripts.dispatch({
      id: 'page',
      name: 'PageOpen',
      pageNumber: 1,
      actions: pageActions,
    });
    return scripts;
  }

  /** An event for the scripts: a keystroke, a click, the document saved... */
  dispatch(event: Record<string, unknown>) {
    try {
      this.sandbox?.dispatchEvent(event);
    } catch (err) {
      console.warn('A form script failed', err);
    }
  }

  stop() {
    try {
      this.sandbox?.nukeSandbox();
    } catch {
      // (already gone)
    }
    this.sandbox = undefined;
    this.frame.remove();
  }
}
