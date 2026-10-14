/**
 * First-page previews of recent files, for the Home screen.
 *
 * Drawn with PDF.js in its own worker, apart from the viewer's engine, so a
 * file that trips up the renderer can never affect the documents being
 * viewed. Previews are made only while Home is showing, one at a time, for
 * entries that don't have one: new files, and files saved since (saving
 * clears the old preview). So they never compete with work on a document.
 */
import { desktop } from './desktop';
import { clearThumbnail, saveThumbnail, type RecentFile } from './recent';

/** Preview width in pixels: sharp in the grid on high-DPI screens */
export const THUMB_WIDTH = 320;
/** Larger files get no preview (reading them isn't worth it) */
export const THUMB_MAX_BYTES = 150 * 1024 * 1024;

/** Object URLs for stored previews, by entry id and version */
const urls = new Map<string, { at: number; url: string }>();

export function thumbUrl(entry: RecentFile): string | null {
  if (!entry.thumb) return null;
  const at = entry.thumbAt ?? 0;
  const cached = urls.get(entry.id);
  if (cached?.at === at) return cached.url;
  if (cached) URL.revokeObjectURL(cached.url);
  const url = URL.createObjectURL(entry.thumb);
  urls.set(entry.id, { at, url });
  return url;
}

/** Called with the entry id and new preview URL when one is made */
type Listener = (id: string, url: string) => void;

export class Thumbnails {
  private queue: RecentFile[] = [];
  private running = false;
  /** Entries already tried this session (unreadable, protected, too big...) */
  private tried = new Set<string>();

  constructor(
    /** Whether background work may run now (Home is showing) */
    private allowed: () => boolean,
    private onChange: Listener
  ) {}

  /** The file changed (saved): drop its preview so Home makes a new one */
  async invalidate(recentId: string) {
    this.tried.delete(recentId);
    const old = urls.get(recentId);
    if (old) URL.revokeObjectURL(old.url);
    urls.delete(recentId);
    await clearThumbnail(recentId);
  }

  /** Make previews for these entries that don't have one yet */
  fill(entries: RecentFile[]) {
    this.queue = entries.filter(
      (e) =>
        !e.thumb &&
        !this.tried.has(e.id) &&
        e.size <= THUMB_MAX_BYTES &&
        ((e.path && desktop?.readPreview) || e.data)
    );
    if (!this.running && this.queue.length) void this.run();
  }

  private async run() {
    this.running = true;
    try {
      while (this.queue.length && this.allowed()) {
        await idle();
        if (!this.allowed()) break;
        const entry = this.queue.shift()!;
        this.tried.add(entry.id);
        try {
          const bytes = entry.path
            ? await desktop?.readPreview?.(entry.path)
            : await entry.data?.arrayBuffer();
          if (!bytes) continue;
          const blob = await renderFirstPage(
            bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes).buffer
          );
          if (blob) await this.store(entry.id, blob);
        } catch {
          /* moved, protected or unreadable: keeps the PDF glyph */
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async store(id: string, blob: Blob) {
    const at = Date.now();
    await saveThumbnail(id, blob, at);
    const old = urls.get(id);
    if (old) URL.revokeObjectURL(old.url);
    const url = URL.createObjectURL(blob);
    urls.set(id, { at, url });
    this.onChange(id, url);
  }
}

/* PDF.js, loaded the first time a preview is needed ------------------ */

type Pdfjs = typeof import('pdfjs-dist');
let pdfjs: Promise<{
  lib: Pdfjs;
  worker: InstanceType<Pdfjs['PDFWorker']>;
}> | null = null;

function loadPdfjs() {
  pdfjs ??= (async () => {
    const lib = await import('pdfjs-dist');
    await import('../js/utils/setup-pdf-worker.js');
    // One worker for every preview
    return { lib, worker: new lib.PDFWorker() };
  })();
  return pdfjs;
}

/** The first page as a small WebP on white, or null (e.g. password-protected) */
async function renderFirstPage(data: ArrayBuffer): Promise<Blob | null> {
  const { lib, worker } = await loadPdfjs();
  const doc = await lib.getDocument({
    data: new Uint8Array(data),
    worker,
    wasmUrl: import.meta.env.BASE_URL + 'pdfjs-viewer/wasm/',
    isEvalSupported: false,
  }).promise;
  try {
    const page = await doc.getPage(1);
    const scale = THUMB_WIDTH / page.getViewport({ scale: 1 }).width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    return await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/webp', 0.82)
    );
  } finally {
    void doc.destroy();
  }
}

/** Wait for a quiet moment */
function idle(): Promise<void> {
  return new Promise((resolve) => {
    if ('requestIdleCallback' in window)
      window.requestIdleCallback(() => resolve(), { timeout: 1500 });
    else setTimeout(resolve, 200);
  });
}
