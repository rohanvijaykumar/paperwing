/**
 * Runs on every upstream tool page. When the page is hosted inside the
 * desktop shell (app.html) it:
 *  - hides the standalone page chrome (navbar, footer, back button),
 *  - follows the shell's light/dark theme,
 *  - accepts files sent by the shell and feeds them to the tool's file input,
 *  - hands generated downloads back to the shell instead of saving them, so
 *    results can open as a new document tab.
 *
 * In the desktop app the shell and the tool pages are on different origins
 * (see origins.ts), so everything goes through postMessage, and both sides
 * check the origin and source of every message:
 *   shell -> tool  { type: 'acro:load-files', files: File[] }
 *   shell -> tool  { type: 'acro:theme', pref: ThemePref }
 *   shell -> tool  { type: 'acro:edit', command: 'undo' | 'redo' }
 *   tool  -> shell { type: 'acro:ready' }
 *   tool  -> shell { type: 'acro:files-loaded' }   (after acro:load-files)
 *   tool  -> shell { type: 'acro:dirty', dirty: boolean } (full-page tools)
 *   tool  -> shell { type: 'acro:download', blob: Blob, name: string }
 *   tool  -> shell { type: 'acro:key', key: KeyInput, editing: boolean }
 *   tool  -> shell { type: 'acro:print-document' }  (print() was called)
 *   tool  -> shell { type: 'acro:html-to-pdf', id, html } (see export-pdf.ts)
 *   shell -> tool  { type: 'acro:html-to-pdf', id, data: Uint8Array | null }
 */

import { applyTheme, isThemePref, onThemeChange, setThemePref } from './theme';
import { initApps } from './apps';
import {
  initFrames,
  onViewerAlert,
  onViewerDownload,
  onViewerPrint,
} from './frames';
import { SHELL_ORIGIN, shellOrigin } from './origins';
import { initTooltips } from './tooltip';
import { initLabels } from './labels';

/** Page id for page-specific styling, e.g. <html data-page="sign-pdf"> */
document.documentElement.dataset.page =
  (location.pathname.split('/').pop() || 'index').replace(/\.html$/, '') ||
  'index';

const embedded = window.self !== window.top;
/** The shell hosting this page (null when standalone or embedded elsewhere) */
const shell = shellOrigin();
const params = new URLSearchParams(location.search);

// The shell passes its theme in the URL, so the page starts out right. Not
// when it shares this origin (served from a web server): the storage they
// share has its theme already, and the URL may be out of date (changed while
// the tool loaded), so saving it would undo the user's choice in the shell
const initialTheme = params.get('theme');
if (shell && shell !== location.origin && isThemePref(initialTheme))
  setThemePref(initialTheme);

applyTheme();
onThemeChange(() => {});
initApps();
initFrames();
initTooltips();
initLabels();

if (embedded) {
  document.documentElement.classList.add('rs-embedded');
  // The shell says whether this tool sits in the side panel or the
  // document area (?embed=panel|full)
  const mode = params.get('embed');
  if (mode === 'full' || mode === 'panel') {
    document.documentElement.classList.add(`rs-${mode}`);
  }
}

/** BentoPDF's website pages (home, About, FAQ…), which a tool's own Close
 *  or Back button goes to: not tools */
const SITE_PAGES = new Set([
  'index',
  'simple-index',
  'tools',
  'about',
  'contact',
  'faq',
  'licensing',
  'privacy',
  'terms',
  '404',
  'pdf-converter',
  'pdf-editor',
  'pdf-merge-split',
  'pdf-security',
  'hyper-compress',
  'kura',
]);

if (shell) {
  const toShell = (message: unknown) =>
    window.parent.postMessage(message, shell);

  // A tool left for one of them: it's done, so the shell closes it, and
  // the page never shows
  if (SITE_PAGES.has(document.documentElement.dataset.page!)) {
    document.documentElement.style.visibility = 'hidden';
    toShell({ type: 'acro:close-tool' });
  }

  // downloadFile() and friends revoke the object URL right after click(), so
  // remember which blob each URL points to.
  const blobsByUrl = new Map<string, Blob>();
  const createObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (obj: Blob | MediaSource) => {
    const url = createObjectURL(obj);
    if (obj instanceof Blob) blobsByUrl.set(url, obj);
    return url;
  };

  const nativeClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    const blob = this.hasAttribute('download')
      ? blobsByUrl.get(this.href)
      : undefined;
    if (!blob) return nativeClick.call(this);
    toShell({ type: 'acro:download', blob, name: this.download || 'download' });
    // The result has gone to the workspace: nothing is lost by closing now
    markSaved();
  };
  // So do files saved from a PDF.js viewer the tool embeds. PDF.js names
  // a document it was handed as data "document.pdf": use the file's name.
  let docName = '';
  onViewerDownload((blob, name) => {
    const named =
      !name || /^document\.pdf$/i.test(name) ? docName || name : name;
    toShell({ type: 'acro:download', blob, name: named || 'document.pdf' });
    markSaved();
  });

  // In the desktop app, print() would open Chromium's print dialog, which
  // can't preview or print there: Paperwing's print dialog is used instead.
  // A viewer the tool embeds (Fill a form, Fill & Sign, Add Stamps) prints
  // the document it shows, with what was filled in or added; print() in the
  // tool page itself, the workspace's open document. In a browser, its own
  // print dialog works, so it's left alone.
  // A form's scripts in a viewer the tool embeds (Fill & Sign) show their
  // messages as the workspace's dialog, as in the workspace itself
  onViewerAlert((message) => toShell({ type: 'acro:script-alert', message }));

  if (shell === SHELL_ORIGIN) {
    window.print = () => toShell({ type: 'acro:print-document' });
    onViewerPrint((win) => void printViewerDocument(win));
  }
  async function printViewerDocument(win: Window) {
    const pdf = (
      win as unknown as {
        PDFViewerApplication?: {
          pdfDocument?: {
            saveDocument?: () => Promise<Uint8Array>;
            getData?: () => Promise<Uint8Array>;
          };
        };
      }
    ).PDFViewerApplication?.pdfDocument;
    // With what was filled in or added, else as it was opened
    const data = await (pdf?.saveDocument?.() ?? Promise.reject())
      .catch(() => pdf?.getData?.())
      .catch((): undefined => undefined);
    toShell({ type: 'acro:print-document', data, name: docName });
  }

  // Unsaved work in a full-page tool (the document area): the workspace asks
  // before closing it. Edit a PDF says so itself (its Export button);
  // elsewhere, editing a field, dropping a file or pressing a button that
  // isn't just for looking around counts, once the document is in.
  let dirty = false;
  let docIn = !document.documentElement.classList.contains('rs-has-doc');
  function setDirty(value: boolean) {
    if (value === dirty) return;
    dirty = value;
    toShell({ type: 'acro:dirty', dirty });
  }
  // When the work last went to the workspace, and when it was last changed
  // (a tool that says it's unsaved still has to have been changed since)
  let savedAt = 0;
  let editedAt = 0;
  function markSaved() {
    savedAt = performance.now();
    setDirty(false);
  }
  // Tools that show it themselves. `exact`: the tool's word is final (it
  // also says when the work has been saved); otherwise it adds to the
  // general signal below.
  let docAt = 0;
  const countSince = (selector: string) => {
    let base = -1;
    return () => {
      const n = document.querySelectorAll(selector).length;
      if (base < 0) {
        // Fields already in the PDF are drawn first: count from then
        if (docAt && performance.now() - docAt > 2500) base = n;
        return false;
      }
      return n !== base;
    };
  };
  const SAYS_DIRTY: Record<string, { check: () => boolean; exact?: boolean }> =
    {
      'edit-pdf-text': {
        check: () =>
          !!document.getElementById('save')?.classList.contains('dirty'),
        exact: true,
      },
      // Fields placed by clicking (not buttons) or dragging
      'form-creator': { check: countSince('.field-label') },
    };
  const LOOKING_AROUND =
    /zoom|fit|page|next|prev|previous|scroll|close|help|back|search|find|cancel|view|theme|menu|more/i;
  if (document.documentElement.classList.contains('rs-full')) {
    const says = SAYS_DIRTY[document.documentElement.dataset.page ?? ''];
    if (says)
      setInterval(() => {
        if (says.exact) setDirty(says.check() && editedAt >= savedAt);
        else if (says.check()) setDirty(true);
      }, 700);
    const edit = (e: Event) => {
      if (!docIn || !e.isTrusted) return;
      if (e.type === 'click') {
        const b = (e.target as Element | null)?.closest?.(
          'button, [role="button"], a[href]'
        );
        if (!b || b.id === 'process-btn') return;
        const label = [
          b.getAttribute('aria-label'),
          b.getAttribute('title'),
          b.getAttribute('data-tip'),
          b.id,
          b.textContent,
        ]
          .join(' ')
          .trim();
        if (LOOKING_AROUND.test(label)) return;
      }
      editedAt = performance.now();
      if (!says?.exact) setDirty(true);
    };
    const types = ['input', 'change', 'drop', 'click'];
    // Typing into a tool's own editor (Edit a PDF) changes it too
    if (says?.exact) types.push('keydown', 'paste', 'cut');
    for (const type of types) document.addEventListener(type, edit, true);
  }

  window.addEventListener('message', (e: MessageEvent) => {
    if (e.origin !== shell || e.source !== window.parent) return;
    const data = e.data;
    if (data?.type === 'acro:load-files' && Array.isArray(data.files)) {
      const files = data.files.filter((f: unknown) => f instanceof File);
      loadFiles(files);
      shellFiles = files;
      docName = files[0]?.name ?? '';
      docIn = true;
      docAt = performance.now();
      // The shell keeps the tool hidden until it has its document, so the
      // empty upload screen never shows: tell it once that's been drawn.
      // (Frames that aren't visible may not get animation frames: the
      // timer makes sure the message goes anyway.)
      let told = false;
      const tell = () => {
        if (told) return;
        told = true;
        toShell({ type: 'acro:files-loaded' });
      };
      requestAnimationFrame(() => requestAnimationFrame(tell));
      setTimeout(tell, 150);
    } else if (data?.type === 'acro:theme' && isThemePref(data.pref)) {
      setThemePref(data.pref);
    } else if (
      data?.type === 'acro:edit' &&
      (data.command === 'undo' || data.command === 'redo')
    ) {
      // macOS Edit menu: text undo/redo in the focused field
      const focused = document.activeElement as HTMLElement | null;
      if (isEditable(focused)) document.execCommand(data.command);
    }
  });

  // App-level shortcuts (Ctrl+S, Ctrl+W, Ctrl+Tab, F4...) still work while
  // focus is inside the tool: forward the ones the tool didn't handle.
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    const mod = e.ctrlKey || e.metaKey || e.altKey;
    if (!mod && !/^F\d{1,2}$/.test(e.key)) return;
    const editing = isEditable(e.target as HTMLElement | null);
    toShell({
      type: 'acro:key',
      editing,
      key: {
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
      },
    });
    // Stop the browser acting on app shortcuts (e.g. Ctrl+P printing the tool)
    if (
      mod &&
      /^[spwofdklnqyh0-9=+\-]$/i.test(e.key) &&
      !(editing && /^[zyxcva]$/i.test(e.key))
    ) {
      e.preventDefault();
    }
  });

  // A tool that goes back to its upload screen after a result (Edit a PDF
  // after Export; PDF to JPG and others start over after their "done"
  // message): with the workspace's document that screen is hidden, in the
  // side panel as in the document area, so the tool would show a blank page. The document goes back in instead (a few times at most, in
  // case a tool keeps refusing it)
  let shellFiles: File[] = [];
  let reloads = 0;
  let reloadsSince = 0;
  const showsNothing = () => {
    if (!document.body || document.querySelector('#loader-modal:not(.hidden)'))
      return false;
    if (document.body.innerText.replace(/\s+/g, '').length > 2) return false;
    return ![
      ...document.querySelectorAll(
        'canvas, img, iframe, embed, input:not([type="file"]), select, textarea, button'
      ),
    ].some((el) => el.getClientRects().length);
  };
  let checkTimer = 0;
  const checkBlank = () => {
    clearTimeout(checkTimer);
    checkTimer = window.setTimeout(() => {
      const root = document.documentElement;
      if (!docIn || !shellFiles.length) return;
      if (!root.classList.contains('rs-has-doc') || !showsNothing()) return;
      if (performance.now() - reloadsSince > 10000) {
        reloads = 0;
        reloadsSince = performance.now();
      }
      if (reloads++ >= 3) return;
      loadFiles(shellFiles);
    }, 400);
  };
  new MutationObserver(checkBlank).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'hidden', 'style'],
  });

  const announceReady = () => toShell({ type: 'acro:ready' });
  if (document.readyState === 'complete') announceReady();
  else window.addEventListener('load', announceReady);
}

function isEditable(el: HTMLElement | null): boolean {
  return (
    !!el &&
    (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
  );
}

/** Pages whose first PDF input isn't the one that loads a document */
const FILE_INPUT_BY_PAGE: Record<string, string> = {
  // An unused hidden input comes before the drop zone's
  'form-creator': 'pdfFileInput',
};

function findFileInput(): HTMLInputElement | null {
  const page = document.documentElement.dataset.page ?? '';
  const mapped = FILE_INPUT_BY_PAGE[page]
    ? document.getElementById(FILE_INPUT_BY_PAGE[page])
    : null;
  if (mapped instanceof HTMLInputElement && mapped.type === 'file')
    return mapped;
  const byId = document.getElementById('file-input');
  if (byId instanceof HTMLInputElement && byId.type === 'file') return byId;
  const inputs = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[type="file"]')
  );
  return inputs.find((i) => /pdf/i.test(i.accept)) ?? inputs[0] ?? null;
}

function loadFiles(files: File[]) {
  const input = findFileInput();
  if (!input || !files.length) return;
  const dt = new DataTransfer();
  for (const f of input.multiple ? files : files.slice(0, 1)) dt.items.add(f);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  // The shell supplied the document: collapse the big drop zone
  document.documentElement.classList.add('rs-has-doc');
}
