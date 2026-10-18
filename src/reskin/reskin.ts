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
 *   tool  -> shell { type: 'acro:download', blob: Blob, name: string }
 *   tool  -> shell { type: 'acro:key', key: KeyInput, editing: boolean }
 */

import { applyTheme, isThemePref, onThemeChange, setThemePref } from './theme';
import { initApps } from './apps';
import { initFrames } from './frames';
import { shellOrigin } from './origins';

/** Page id for page-specific styling, e.g. <html data-page="sign-pdf"> */
document.documentElement.dataset.page =
  (location.pathname.split('/').pop() || 'index').replace(/\.html$/, '') ||
  'index';

const embedded = window.self !== window.top;
/** The shell hosting this page (null when standalone or embedded elsewhere) */
const shell = shellOrigin();
const params = new URLSearchParams(location.search);

// The shell passes its theme in the URL, so the page starts out right
const initialTheme = params.get('theme');
if (shell && isThemePref(initialTheme)) setThemePref(initialTheme);

applyTheme();
onThemeChange(() => {});
initApps();
initFrames();

if (embedded) {
  document.documentElement.classList.add('rs-embedded');
  // The shell says whether this tool sits in the side panel or the
  // document area (?embed=panel|full)
  const mode = params.get('embed');
  if (mode === 'full' || mode === 'panel') {
    document.documentElement.classList.add(`rs-${mode}`);
  }
}

if (shell) {
  const toShell = (message: unknown) =>
    window.parent.postMessage(message, shell);

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
  };

  window.addEventListener('message', (e: MessageEvent) => {
    if (e.origin !== shell || e.source !== window.parent) return;
    const data = e.data;
    if (data?.type === 'acro:load-files' && Array.isArray(data.files)) {
      loadFiles(data.files.filter((f: unknown) => f instanceof File));
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
