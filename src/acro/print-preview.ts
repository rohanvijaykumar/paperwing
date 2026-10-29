/**
 * The print dialog's preview: pages of the document it will print, drawn on
 * screen with PDF.js. Only the screen sees these pictures; the printer gets
 * the PDF itself.
 */
import type { RenderTask } from 'pdfjs-dist';
import { loadPdfjs } from './thumbnails';

export interface PrintPreview {
  pages: number;
  /** Draws page `n` (from 1) as large as fits in width × height CSS pixels.
   *  A newer call replaces one that's still drawing. */
  draw(
    n: number,
    canvas: HTMLCanvasElement,
    width: number,
    height: number
  ): Promise<void>;
  close(): void;
}

/** Opens the document for previewing. PDF.js takes over the buffer it's
 *  given (it moves to its worker): pass a copy of one still needed. */
export async function openPreview(data: Uint8Array): Promise<PrintPreview> {
  const { lib, worker } = await loadPdfjs();
  const doc = await lib.getDocument({
    data,
    worker,
    wasmUrl: import.meta.env.BASE_URL + 'pdfjs-viewer/wasm/',
    isEvalSupported: false,
  }).promise;
  let latest = 0;
  let task: RenderTask | null = null;
  return {
    pages: doc.numPages,
    async draw(n, canvas, width, height) {
      const call = ++latest;
      const page = await doc.getPage(n);
      if (call !== latest) return;
      task?.cancel();
      const base = page.getViewport({ scale: 1 });
      const fit = Math.min(width / base.width, height / base.height);
      const ratio = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: fit * ratio });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
      canvas.style.height = `${Math.floor(viewport.height / ratio)}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      task = page.render({ canvas, canvasContext: ctx, viewport });
      try {
        await task.promise;
      } catch (err) {
        if ((err as Error)?.name !== 'RenderingCancelledException') throw err;
      }
    },
    close() {
      task?.cancel();
      void doc.destroy();
    },
  };
}
