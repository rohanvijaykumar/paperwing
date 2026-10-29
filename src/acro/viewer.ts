/**
 * Wrapper around BentoPDF's bundled EmbedPDF viewer. One viewer instance hosts
 * every open document; its own toolbars are hidden so the shell's
 * Acrobat-style chrome (quick toolbar, right rail) drives it via commands.
 */
import type { EmbedPdfContainer, PluginRegistry } from 'bentopdf-viewer';
import { editorFontFallback } from '../js/config/editor-fonts.js';
import notoSansUrl from './fonts/NotoSans-Regular.ttf?url';

// Same letter widths as the fonts PDFs most often name without embedding

// (see fontFallback)

import serifR from './fonts/fallback/LiberationSerif-Regular.ttf?url';

import serifB from './fonts/fallback/LiberationSerif-Bold.ttf?url';

import serifI from './fonts/fallback/LiberationSerif-Italic.ttf?url';

import serifBI from './fonts/fallback/LiberationSerif-BoldItalic.ttf?url';

import sansR from './fonts/fallback/LiberationSans-Regular.ttf?url';

import sansB from './fonts/fallback/LiberationSans-Bold.ttf?url';

import sansI from './fonts/fallback/LiberationSans-Italic.ttf?url';

import sansBI from './fonts/fallback/LiberationSans-BoldItalic.ttf?url';

import monoR from './fonts/fallback/LiberationMono-Regular.ttf?url';

import monoB from './fonts/fallback/LiberationMono-Bold.ttf?url';

import monoI from './fonts/fallback/LiberationMono-Italic.ttf?url';

import monoBI from './fonts/fallback/LiberationMono-BoldItalic.ttf?url';

import calibriR from './fonts/fallback/Carlito-Regular.ttf?url';

import calibriB from './fonts/fallback/Carlito-Bold.ttf?url';

import calibriI from './fonts/fallback/Carlito-Italic.ttf?url';

import calibriBI from './fonts/fallback/Carlito-BoldItalic.ttf?url';

import cambriaR from './fonts/fallback/Caladea-Regular.ttf?url';

import cambriaB from './fonts/fallback/Caladea-Bold.ttf?url';

import cambriaI from './fonts/fallback/Caladea-Italic.ttf?url';

import cambriaBI from './fonts/fallback/Caladea-BoldItalic.ttf?url';
import { getThemePref, onThemeChange } from '../reskin/theme';
import { getPrefs } from './prefs';

/** Zoom level for the viewer from the "Default zoom" preference */
const zoomLevel = () => {
  const z = getPrefs().defaultZoom;
  return z === '100' ? 1 : z;
};

/** Acrobat-like neutral greys for both themes */
function viewerTheme() {
  return {
    preference: getThemePref(),
    light: {
      background: {
        app: '#f8f8f8',
        surface: '#ffffff',
        surfaceAlt: '#f5f5f5',
        elevated: '#ffffff',
        input: '#ffffff',
      },
      accent: {
        primary: '#3b63fb',
        primaryHover: '#274dea',
        primaryActive: '#1d3ecf',
        primaryLight: '#edf1ff',
        primaryForeground: '#ffffff',
      },
    },
    dark: {
      background: {
        app: '#141414',
        surface: '#222222',
        surfaceAlt: '#1c1c1c',
        elevated: '#2a2a2a',
        overlay: 'rgba(0,0,0,0.6)',
        input: '#1c1c1c',
      },
      foreground: {
        primary: '#ededed',
        secondary: '#c9c9c9',
        muted: '#9c9c9c',
        disabled: '#666666',
        onAccent: '#ffffff',
      },
      border: { default: '#333333', subtle: '#2a2a2a', strong: '#4a4a4a' },
      accent: {
        primary: '#5c7cff',
        primaryHover: '#7590ff',
        primaryActive: '#4a69ef',
        primaryLight: '#242a3d',
        primaryForeground: '#ffffff',
      },
      interactive: {
        hover: '#2f2f2f',
        active: '#3a3a3a',
        selected: '#2c3350',
        focus: '#5c7cff',
        focusRing: 'rgba(92,124,255,0.4)',
      },
      scrollbar: {
        track: 'transparent',
        thumb: '#4a4a4a',
        thumbHover: '#5e5e5e',
      },
    },
  };
}

const wasmUrl = new URL('bentopdf-pdfium/editcore.wasm', import.meta.url).href;

/**
 * Fallback fonts for text in fonts a PDF doesn't embed (which is most PDFs).
 * The Latin font ships with the app, so opening a document never needs the
 * network; other scripts still come from the CDN the first time they're needed.
 *
 * Every URL is absolute: the engine fetches fonts from a worker started from
 * a blob: URL, where a path like /assets/... can't be resolved (the font then
 * fails to load and PDFium crashes on the text that needed it). With no
 * baseUrl the engine uses the URLs exactly as given.
 */
const fontFallback = (() => {
  const { baseUrl, fonts, defaultFont } = editorFontFallback;
  const latin = new URL(notoSansUrl, location.href).href;
  const absolute = (font: string) =>
    font === defaultFont ? latin : `${baseUrl}/${font}`;
  const variants = (r: string, b: string, i: string, bi: string) =>
    [
      [r, 400, false],
      [b, 700, false],
      [i, 400, true],
      [bi, 700, true],
    ].map(([url, weight, italic]) => ({
      url: new URL(url as string, location.href).href,
      weight,
      italic,
    }));
  return {
    baseUrl: '',
    fonts: Object.fromEntries(
      Object.entries(fonts).map(([charset, font]) => [charset, absolute(font)])
    ),
    defaultFont: latin,
    // Latin text in a font the PDF doesn't embed: chosen by the font's name
    // (Times, Arial, Courier, Calibri, Cambria and their kin) so the letters
    // fit the widths the PDF was laid out with (a viewer patch, see
    // reskin/vite-plugin-reskin.ts, "font faces")
    faces: {
      serif: variants(serifR, serifB, serifI, serifBI),
      sans: variants(sansR, sansB, sansI, sansBI),
      mono: variants(monoR, monoB, monoI, monoBI),
      calibri: variants(calibriR, calibriB, calibriI, calibriBI),
      cambria: variants(cambriaR, cambriaB, cambriaI, cambriaBI),
    },
  };
})();

type Unsub = () => void;
// The plugin capabilities are loosely typed in the published d.ts; keep the
// surface we use small and explicit.
type Cap = Record<string, any>;

/** What the mouse does on the page (see Viewer.mode) */
export type ViewMode = 'select' | 'hand' | 'marquee';

export interface PageInfo {
  current: number;
  total: number;
}

/** Where a document opens: a page and a zoom (1 = 100%) */
export interface DocView {
  page: number;
  zoom: number;
  /** Where it was scrolled to at that zoom (see scrollPos), rather than the
   *  top of the page */
  scroll?: { x: number; y: number };
}

/** PDFium's error code for a document that needs a password */
const PASSWORD_REQUIRED = 4;

/** The viewer's annotation styles sidebar */
const STYLES_PANEL = 'annotation-panel';

/** open() was cancelled by the user (for example at the password prompt) */
export class OpenCancelled extends Error {
  constructor() {
    super('Opening cancelled');
    this.name = 'OpenCancelled';
  }
}

export class Viewer {
  private container?: EmbedPdfContainer;
  private registry?: PluginRegistry;
  private ready?: Promise<void>;
  /** our tab id -> viewer document id */
  private docIds = new Map<string, string>();
  /** Documents still loading, by tab id */
  private opening = new Map<
    string,
    {
      docId: string;
      resolve: () => void;
      reject: (err: Error) => void;
      /** the password prompt is showing */
      prompting?: boolean;
    }
  >();
  /** Asks for the password of a protected document; null cancels opening */
  passwordPrompt?: (tabId: string, wrong: boolean) => Promise<string | null>;
  /** Takes the document the print dialog prepared (its page range and
   *  annotation choice applied) instead of the viewer's own print frame */
  printTo?: (tabId: string, pdf: Uint8Array) => void;
  /** Tabs closed while their document was loading */
  private cancelled = new Set<string>();
  /** The tab last shown, so it can get the viewer back after a discard */
  private current?: string;
  private seq = 0;
  private pageListeners = new Set<(tabId: string, info: PageInfo) => void>();
  private toolListeners = new Set<
    (tabId: string, toolId: string | null) => void
  >();
  private changeListeners = new Set<(tabId: string) => void>();
  private modeListeners = new Set<(tabId: string, mode: ViewMode) => void>();
  /** The right-hand panel (comments, thumbnails, find…) opened or closed */
  private sidebarListeners = new Set<(tabId: string) => void>();
  private zoomListeners = new Set<(tabId: string) => void>();
  /** Opened documents waiting for their first layout to get their zoom (and
   *  page): the view they were left at, or null for the preferred zoom */
  private pendingView = new Map<string, DocView | null>();
  /** The view each document being opened should start at */
  private startViews = new Map<string, DocView>();

  constructor(private host: HTMLElement) {}

  cap(name: string): Cap {
    return (this.registry as any).getPlugin(name).provides();
  }

  private init(): Promise<void> {
    this.ready ??= (async () => {
      performance.mark('pw:engine-start');
      const { default: EmbedPDF } = await import('bentopdf-viewer');
      this.container = EmbedPDF.init({
        type: 'container',
        target: this.host,
        worker: true,
        wasmUrl,
        fontFallback,
        tabBar: 'never',
        // A touchscreen does not mean the desktop Select tool should pan.
        pan: { defaultMode: 'never' },
        // Form widgets carry saved field values and checkbox appearances.
        render: { withForms: true },
        documentManager: { maxDocuments: 50 },
        theme: viewerTheme(),
        zoom: {
          defaultZoomLevel:
            zoomLevel() === 'automatic' ? 'fit-width' : zoomLevel(),
        },
      } as any) as EmbedPdfContainer;
      this.registry = await (this.container as any).registry;
      performance.mark('pw:engine-ready');
      onThemeChange(() => (this.container as any)?.setTheme?.(viewerTheme()));

      const dm = this.cap('document-manager');
      dm.onDocumentOpened((doc: { id: string; name?: string }) => {
        const tabId = doc.name ?? '';
        if (!this.opening.has(tabId)) return;
        if (this.cancelled.has(tabId)) {
          this.discard(doc.id);
        } else {
          this.docIds.set(tabId, doc.id);
          this.stripChrome(doc.id);
          // The view is applied once the first layout is ready (the viewer
          // ignores zoom requests before it can measure pages)
          this.pendingView.set(tabId, this.startViews.get(tabId) ?? null);
          this.startViews.delete(tabId);
        }
        this.settle(tabId);
      });
      // Password-protected: ask, then retry. Corrupt or unreadable file:
      // drop it and fail open()
      dm.onDocumentError(
        (e: { documentId: string; message?: string; code?: number }) => {
          for (const [tabId, o] of this.opening) {
            if (o.docId !== e.documentId) continue;
            if (
              e.code === PASSWORD_REQUIRED &&
              this.passwordPrompt &&
              !this.cancelled.has(tabId)
            ) {
              void this.askPassword(tabId, o.docId, false);
              continue;
            }
            this.discard(e.documentId);
            this.settle(
              tabId,
              new Error(e.message || 'Failed to load document')
            );
          }
        }
      );

      // Thumbnails/bookmarks and annotation styles live on the right, beside
      // the rail (as in Acrobat), clear of the floating annotation toolbar
      const ui = this.cap('ui');
      const sidebars = ui.getSchema().sidebars ?? {};
      const moved = Object.fromEntries(
        ['sidebar-panel', STYLES_PANEL]
          .filter((id) => sidebars[id])
          .map((id) => [
            id,
            {
              ...sidebars[id],
              position: { placement: 'right', slot: 'main', order: 0 },
            },
          ])
      );
      if (Object.keys(moved).length) ui.mergeSchema({ sidebars: moved });

      // The viewer's own "Annotation style" buttons always open the styles
      // on the left, whatever the schema says: move them to the right
      ui.onSidebarChanged?.((e: { documentId?: string }) => {
        const ids = e?.documentId ? [e.documentId] : [...this.docIds.values()];
        ids.forEach((id) => {
          this.keepStylesRight(id);
          const tabId = this.tabFor(id);
          if (tabId) this.sidebarListeners.forEach((fn) => fn(tabId));
        });
      });

      this.cap('zoom').onZoomChange?.((e: { documentId?: string }) => {
        const tabId = e?.documentId && this.tabFor(e.documentId);
        if (tabId) this.zoomListeners.forEach((fn) => fn(tabId));
      });

      // Keep the viewer's own toolbars closed whenever it tries to show them
      ui.onToolbarChanged?.((e: { documentId?: string }) => {
        if (e?.documentId) this.stripChrome(e.documentId);
      });

      // Any undoable edit (annotations, redactions...) marks the doc changed
      this.cap('history').onHistoryChange((e: any) => {
        const tabId = this.tabFor(e.documentId);
        if (tabId) this.changeListeners.forEach((fn) => fn(tabId));
      });

      // The viewer prints by loading the document into a hidden frame and
      // calling its print(), which in Electron reports success without
      // printing anything. With printTo set, that frame is stopped before
      // its document loads (listeners run synchronously, the load later).
      (this.registry as any)
        .getPlugin('print')
        ?.onPrintRequest?.(
          (e: { documentId: string; buffer: ArrayBuffer; task: any }) => {
            const tabId = this.tabFor(e.documentId);
            if (!this.printTo || !tabId) return;
            queueMicrotask(() => {
              const frame = this.printFrame();
              if (frame) frame.onload = null;
            });
            e.task.resolve(e.buffer);
            this.printTo(tabId, new Uint8Array(e.buffer));
          }
        );

      this.cap('annotation').onActiveToolChange((e: any) => {
        const tabId = this.tabFor(e.documentId);
        if (tabId)
          this.toolListeners.forEach((fn) => fn(tabId, e.tool?.id ?? null));
      });

      this.cap('interaction-manager').onModeChange?.((e: any) => {
        const tabId = this.tabFor(e?.documentId);
        if (!tabId) return;
        const mode = this.mode(tabId);
        this.modeListeners.forEach((fn) => fn(tabId, mode));
      });

      this.cap('scroll').onPageChange((e: any) => {
        const tabId = this.tabFor(e.documentId);
        if (tabId) this.emitPage(tabId);
      });
      this.cap('scroll').onLayoutReady?.((e: any) => {
        const tabId = this.tabFor(e.documentId);
        if (!tabId) return;
        if (this.pendingView.has(tabId)) {
          const view = this.pendingView.get(tabId);
          this.pendingView.delete(tabId);
          if (view) this.applyView(tabId, view);
          else this.applyDefaultZoom(tabId);
        }
        this.emitPage(tabId);
      });
    })();
    return this.ready;
  }

  private stripChrome(docId: string) {
    const d = this.cap('ui').forDocument(docId);
    for (const slot of ['main', 'secondary']) {
      if (d.isToolbarOpen?.('top', slot)) d.closeToolbarSlot('top', slot);
    }
    if (d.isOverlayEnabled?.('page-controls'))
      d.disableOverlay('page-controls');
  }

  /** Moves the styles panel from the left to the right sidebar. Pressing
   *  "Annotation style" while it's already open on the right closes it. */
  private keepStylesRight(docId: string) {
    const d = this.cap('ui').forDocument(docId);
    if (d.getActiveSidebar('left', 'main') !== STYLES_PANEL) return;
    d.closeSidebarSlot('left', 'main');
    if (d.getActiveSidebar('right', 'main') === STYLES_PANEL)
      d.closeSidebarSlot('right', 'main');
    else d.toggleSidebar('right', 'main', STYLES_PANEL);
  }

  /** The viewer's hidden print frame (in its shadow root) */
  private printFrame(): HTMLIFrameElement | null {
    const root = (this.container as any)?.shadowRoot ?? this.host;
    return root.querySelector('iframe[title="Print Document"]');
  }

  private tabFor(docId: string): string | undefined {
    for (const [tab, id] of this.docIds) if (id === docId) return tab;
    return undefined;
  }

  private emitPage(tabId: string) {
    const info = this.pageInfo(tabId);
    if (info) this.pageListeners.forEach((fn) => fn(tabId, info));
  }

  onPage(fn: (tabId: string, info: PageInfo) => void): Unsub {
    this.pageListeners.add(fn);
    return () => this.pageListeners.delete(fn);
  }

  /** Start the PDF engine early (idle time after launch) so the first
   *  document opens without waiting for WebAssembly to compile. */
  warmUp(): Promise<void> {
    return this.init();
  }

  /** "Automatic" = fit the page width, but never above 150% (big screens) */
  applyDefaultZoom(tabId: string) {
    const id = this.docIds.get(tabId);
    if (!id) return;
    performance.mark('pw:zoom');
    let level: number | string = zoomLevel();
    if (level === 'automatic') {
      const info = this.docInfo(tabId);
      const width = this.host.clientWidth - 96; // breathing room either side
      level =
        info?.width && width > 0
          ? Math.min(width / info.width, 1.5)
          : 'fit-width';
    }
    this.cap('zoom').forDocument(id).requestZoom(level);
    // Zooming keeps the centre in place, which can leave a document zoomed in
    // past its first page; new documents start at the top. (Only when needed:
    // a scroll restarts the viewer's layout debounce and delays the first page.)
    setTimeout(() => {
      try {
        const scroll = this.cap('scroll').forDocument(id);
        if (scroll.getCurrentPage() !== 1)
          scroll.scrollToPage({ pageNumber: 1, behavior: 'instant' });
      } catch {
        /* document closed meanwhile */
      }
    });
  }

  /** Reopen a document where it was left: its zoom, then its page */
  private applyView(tabId: string, view: DocView) {
    const id = this.docIds.get(tabId);
    if (!id) return;
    performance.mark('pw:zoom');
    this.cap('zoom').forDocument(id).requestZoom(view.zoom);
    // After the zoom has laid the pages out again
    setTimeout(() => {
      try {
        if (view.scroll) {
          this.cap('viewport')
            .forDocument(id)
            .scrollTo({ ...view.scroll, behavior: 'instant' });
          return;
        }
        const scroll = this.cap('scroll').forDocument(id);
        const page = Math.min(Math.max(1, view.page), scroll.getTotalPages());
        if (page > 1)
          scroll.scrollToPage({ pageNumber: page, behavior: 'instant' });
      } catch {
        /* document closed meanwhile */
      }
    });
  }

  /** Fires after every undoable edit in a document */
  onChange(fn: (tabId: string) => void): Unsub {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  /** Move between search results in the find panel */
  searchStep(tabId: string, dir: 1 | -1) {
    const id = this.docIds.get(tabId);
    if (!id) return;
    const s = this.cap('search').forDocument(id);
    if (dir > 0) s.nextResult();
    else s.previousResult();
  }

  /** Undo or redo an edit made in the viewer; false if there was none */
  history(tabId: string, action: 'undo' | 'redo'): boolean {
    const id = this.docIds.get(tabId);
    if (!id) return false;
    const h = this.cap('history').forDocument(id);
    if (!(action === 'undo' ? h.canUndo() : h.canRedo())) return false;
    h[action]();
    return true;
  }

  /** Page count and size of the first page (PDF points) */
  docInfo(
    tabId: string
  ): { pages: number; width: number; height: number } | null {
    const id = this.docIds.get(tabId);
    if (!id || !this.registry) return null;
    const doc = this.cap('document-manager').getDocument(id);
    if (!doc) return null;
    const size = doc.pages?.[0]?.size ?? { width: 0, height: 0 };
    return { pages: doc.pageCount, width: size.width, height: size.height };
  }

  /** Fires when the active annotation tool changes (null = select) */
  onActiveTool(fn: (tabId: string, toolId: string | null) => void): Unsub {
    this.toolListeners.add(fn);
    return () => this.toolListeners.delete(fn);
  }

  /** Resolves once the document is shown (or its tab was closed meanwhile);
   *  rejects if the file can't be opened. */
  async open(
    tabId: string,
    buffer: ArrayBuffer,
    view?: DocView
  ): Promise<void> {
    await this.init();
    if (view) this.startViews.set(tabId, view);
    const docId = `pw-${++this.seq}`;
    await new Promise<void>((resolve, reject) => {
      this.opening.set(tabId, { docId, resolve, reject });
      this.cap('document-manager')
        .openDocumentBuffer({
          buffer,
          name: tabId,
          documentId: docId,
          autoActivate: true,
        })
        // Refused before loading starts (e.g. too many documents open)
        .wait(
          () => {},
          (e: { reason?: { message?: string } }) =>
            this.settle(tabId, new Error(e.reason?.message ?? 'Open failed'))
        );
    });
  }

  private async askPassword(tabId: string, docId: string, wrong: boolean) {
    const o = this.opening.get(tabId);
    if (!o || o.prompting) return;
    o.prompting = true;
    const password = await this.passwordPrompt!(tabId, wrong);
    o.prompting = false;
    if (this.opening.get(tabId) !== o) return;
    if (password === null || this.cancelled.has(tabId)) {
      this.discard(docId);
      this.settle(tabId, new OpenCancelled());
      return;
    }
    type LoadFailure = { reason?: { code?: number; message?: string } };
    const failed = (e: LoadFailure) => {
      if (this.opening.get(tabId) !== o) return;
      // Wrong password: ask again
      if (e.reason?.code === PASSWORD_REQUIRED) {
        void this.askPassword(tabId, docId, true);
        return;
      }
      this.discard(docId);
      this.settle(
        tabId,
        new Error(e.reason?.message ?? 'Failed to load document')
      );
    };
    // The retry is accepted at once; its load task says whether it worked
    this.cap('document-manager')
      .retryDocument(docId, { password })
      .wait(
        (r: { task?: { wait(ok: () => void, fail: typeof failed): void } }) =>
          r.task?.wait(() => {}, failed),
        failed
      );
  }

  private settle(tabId: string, err?: Error) {
    const o = this.opening.get(tabId);
    if (!o) return;
    this.opening.delete(tabId);
    // A closed tab doesn't care whether its document failed
    if (this.cancelled.delete(tabId) || !err) o.resolve();
    else o.reject(err);
  }

  /** Close a document no tab shows, handing the viewer back to the current tab */
  private discard(docId: string) {
    // Not from inside the document manager's own event
    setTimeout(() =>
      this.cap('document-manager')
        .closeDocument(docId)
        .wait(
          () => {
            if (this.current) void this.activate(this.current);
          },
          () => {}
        )
    );
  }

  async activate(tabId: string) {
    this.current = tabId;
    await this.init();
    const id = this.docIds.get(tabId);
    if (id) this.cap('document-manager').setActiveDocument(id);
  }

  /** Swaps a tab's document for a new version of it (after its pages
   *  changed), at `view`. The new one opens before the old one closes, so
   *  no other document shows in between. */
  async replace(tabId: string, buffer: ArrayBuffer, view?: DocView) {
    const old = this.docIds.get(tabId);
    await this.open(tabId, buffer, view);
    if (old && old !== this.docIds.get(tabId))
      this.cap('document-manager').closeDocument(old);
  }

  close(tabId: string) {
    if (this.opening.has(tabId)) {
      // Still loading: close it once it has opened (see onDocumentOpened)
      this.cancelled.add(tabId);
      return;
    }
    const id = this.docIds.get(tabId);
    if (!id || !this.registry) return;
    this.cap('document-manager').closeDocument(id);
    this.docIds.delete(tabId);
  }

  command(tabId: string, commandId: string) {
    const id = this.docIds.get(tabId);
    if (!id) return;
    this.cap('commands').execute(commandId, id);
  }

  /** Toggle one of the viewer's sidebars, e.g. thumbnails or comments */
  toggleSidebar(tabId: string, sidebarId: string, tab?: string) {
    const id = this.docIds.get(tabId);
    if (!id) return;
    const d = this.cap('ui').forDocument(id);
    const sidebar = d.getSchema().sidebars?.[sidebarId];
    if (!sidebar) return;
    const { placement, slot } = sidebar.position;
    if (tab && d.getActiveSidebar(placement, slot) === sidebarId) {
      if (d.getSidebarTab?.(sidebarId) !== tab) {
        d.setSidebarTab(sidebarId, tab);
        return;
      }
    }
    d.toggleSidebar(placement, slot, sidebarId, tab);
  }

  /** The open right-hand panel: its id and, for thumbnails/bookmarks, tab */
  activePanel(tabId: string): { id: string; tab?: string } | null {
    const id = this.docIds.get(tabId);
    if (!id || !this.registry) return null;
    const d = this.cap('ui').forDocument(id);
    const panel = d.getActiveSidebar('right', 'main');
    if (!panel) return null;
    return { id: panel, tab: d.getSidebarTab?.(panel) ?? undefined };
  }

  /** Close the right-hand panel */
  closePanel(tabId: string) {
    const id = this.docIds.get(tabId);
    if (id) this.cap('ui').forDocument(id).closeSidebarSlot('right', 'main');
  }

  onPanel(fn: (tabId: string) => void): Unsub {
    this.sidebarListeners.add(fn);
    return () => this.sidebarListeners.delete(fn);
  }

  /** Current zoom as a scale (1 = 100%) */
  zoom(tabId: string): number | null {
    const id = this.docIds.get(tabId);
    if (!id || !this.registry) return null;
    try {
      const level = this.cap('zoom')
        .forDocument(id)
        .getState()?.currentZoomLevel;
      return typeof level === 'number' ? level : null;
    } catch {
      return null;
    }
  }

  /** Where the document is scrolled to (for DocView.scroll) */
  scrollPos(tabId: string): { x: number; y: number } | undefined {
    const id = this.docIds.get(tabId);
    if (!id || !this.registry) return undefined;
    try {
      const m = this.cap('viewport').forDocument(id).getMetrics();
      return { x: m.scrollLeft, y: m.scrollTop };
    } catch {
      return undefined;
    }
  }

  /** Zoom to a scale (1 = 100%) or a mode such as 'fit-page' */
  setZoom(tabId: string, level: number | string) {
    const id = this.docIds.get(tabId);
    if (id) this.cap('zoom').forDocument(id).requestZoom(level);
  }

  onZoom(fn: (tabId: string) => void): Unsub {
    this.zoomListeners.add(fn);
    return () => this.zoomListeners.delete(fn);
  }

  /** Toggle the annotation styles panel (right sidebar) */
  toggleStyles(tabId: string) {
    this.toggleSidebar(tabId, STYLES_PANEL);
  }

  setTool(tabId: string, toolId: string | null) {
    const id = this.docIds.get(tabId);
    if (!id) return;
    this.cap('annotation').forDocument?.(id)?.setActiveTool?.(toolId) ??
      this.cap('annotation').setActiveTool(toolId);
  }

  /** How the mouse acts on the page: selecting (or an annotation tool),
   *  dragging it around, or zooming into a dragged rectangle */
  mode(tabId: string): ViewMode {
    const id = this.docIds.get(tabId);
    if (!id || !this.registry) return 'select';
    const m = this.cap('interaction-manager').forDocument(id).getActiveMode();
    return m === 'panMode'
      ? 'hand'
      : m === 'marqueeZoom'
        ? 'marquee'
        : 'select';
  }

  setMode(tabId: string, mode: ViewMode) {
    const id = this.docIds.get(tabId);
    if (!id || !this.registry) return;
    const im = this.cap('interaction-manager').forDocument(id);
    // The viewer's default can be changed by other plugins (e.g. touch pan).
    // Select must always enable text selection, regardless of that default.
    if (mode === 'select') im.activate('pointerMode');
    else im.activate(mode === 'hand' ? 'panMode' : 'marqueeZoom');
  }

  /** Fires when the mode changes (an annotation tool counts as select) */
  onMode(fn: (tabId: string, mode: ViewMode) => void): Unsub {
    this.modeListeners.add(fn);
    return () => this.modeListeners.delete(fn);
  }

  pageInfo(tabId: string): PageInfo | null {
    const id = this.docIds.get(tabId);
    if (!id || !this.registry) return null;
    try {
      const s = this.cap('scroll').forDocument(id);
      return { current: s.getCurrentPage(), total: s.getTotalPages() };
    } catch {
      return null;
    }
  }

  /** Jump straight to a page (scrolling there would render every page on
   *  the way) */
  goToPage(tabId: string, page: number) {
    const id = this.docIds.get(tabId);
    if (!id) return;
    this.cap('scroll')
      .forDocument(id)
      .scrollToPage({ pageNumber: page, behavior: 'instant' });
  }

  /** Current document bytes, including annotations made in the viewer */
  async exportBytes(tabId: string): Promise<ArrayBuffer | null> {
    const id = this.docIds.get(tabId);
    if (!id) return null;
    return this.cap('export').forDocument(id).saveAsCopy().toPromise();
  }
}
