/**
 * Export PDF for a tool that makes its PDF by printing a web page (Markdown
 * to PDF), when Paperwing hosts it. print() is no way to make a document
 * there: in the desktop app its dialog can't preview, and the result should
 * open as a document like every other tool's. So the print-styled page is
 * made into a PDF here and handed to the workspace (acro:download), where it
 * opens in a new tab and is printed from there.
 *
 * Desktop app: the workspace has the desktop shell lay the page out with
 * Chromium's print engine (desktop/print.cjs), so text stays text. In a
 * browser nothing but print() can do that: the page is drawn with
 * html2canvas and the drawings become the pages, so their text can't be
 * selected or searched.
 */
import { SHELL_ORIGIN, shellOrigin } from './origins';

/** A4 in PDF points, and the margin around the page's content */
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = (16 / 25.4) * 72;
/** CSS pixels per point */
const PX = 96 / 72;
/** Drawing resolution, in device pixels per CSS pixel */
const SCALE = 2;
/** A page may end early, at a break between blocks, if it's this full */
const MIN_FILL = 0.6;
/** Blocks a page may end between */
const BLOCKS =
  'body > *, p, li, tr, pre, blockquote, h1, h2, h3, h4, h5, h6, dt, dd, hr, img, table, .mermaid-diagram';

let exporting = false;

/**
 * Makes `html` (a complete HTML document, styled for print) into a PDF and
 * sends it to the workspace as `name`. Returns false, doing nothing, when
 * the page isn't hosted by Paperwing.
 */
export function exportPdfToShell(html: string, name: string): boolean {
  const shell = shellOrigin();
  if (!shell) return false;
  if (exporting) return true;
  exporting = true;
  void (async () => {
    try {
      const data =
        (shell === SHELL_ORIGIN ? await fromDesktop(shell, html) : null) ??
        (await fromBrowser(html));
      const blob = new Blob([data as BlobPart], { type: 'application/pdf' });
      window.parent.postMessage({ type: 'acro:download', blob, name }, shell);
    } catch (err) {
      console.error('Export PDF failed:', err);
      window.alert(`Couldn't make the PDF: ${(err as Error)?.message ?? err}`);
    } finally {
      exporting = false;
    }
  })();
  return true;
}

const isPdf = (data: unknown): data is Uint8Array =>
  data instanceof Uint8Array &&
  new TextDecoder().decode(data.subarray(0, 1024)).includes('%PDF-');

/** The desktop shell's PDF of the page (null if it couldn't make one). The
 *  tool page can't reach the shell's bridge: the workspace asks for it. */
function fromDesktop(shell: string, html: string): Promise<Uint8Array | null> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve) => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== shell || e.source !== window.parent) return;
      if (e.data?.type !== 'acro:html-to-pdf' || e.data.id !== id) return;
      window.removeEventListener('message', onMessage);
      resolve(isPdf(e.data.data) ? e.data.data : null);
    };
    window.addEventListener('message', onMessage);
    window.parent.postMessage({ type: 'acro:html-to-pdf', id, html }, shell);
  });
}

/** The page drawn page by page (see above), as a PDF */
async function fromBrowser(html: string): Promise<Uint8Array> {
  const [{ default: html2canvas }, { PDFDocument }] = await Promise.all([
    import('html2canvas'),
    import('pdf-lib'),
  ]);
  const width = Math.round((PAGE_W - 2 * MARGIN) * PX);
  const pageHeight = Math.floor((PAGE_H - 2 * MARGIN) * PX);
  // Its own document, so the page's styles apply to it alone; no scripts
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText = `position:fixed;top:0;left:${-width - 100}px;width:${width}px;height:${pageHeight}px;border:0`;
  const loaded = new Promise((r) =>
    frame.addEventListener('load', r, { once: true })
  );
  frame.srcdoc = html;
  document.body.append(frame);
  try {
    await loaded;
    const doc = frame.contentDocument;
    if (!doc?.body) throw new Error('The page could not be laid out');
    await doc.fonts?.ready;
    const windowHeight = Math.ceil(doc.documentElement.scrollHeight);
    frame.style.height = `${windowHeight}px`;

    // Measured in the copy html2canvas makes of the page and draws
    let total = Infinity;
    let breaks: number[] = [];
    const measure = (copy: Document) => {
      // It puts a <style> first in the body, so the first block's top margin
      // (taken off by body > :first-child) has to come off again
      const first = copy.body.querySelector<HTMLElement>(
        ':scope > :not(style)'
      );
      if (first) first.style.marginTop = '0';
      total = Math.ceil(copy.documentElement.scrollHeight);
      breaks = blockBreaks(copy);
    };

    const pdf = await PDFDocument.create();
    for (let top = 0; total - top >= 1; ) {
      const canvas = await html2canvas(doc.body, {
        x: 0,
        y: top,
        width,
        height: pageHeight,
        windowWidth: width,
        windowHeight,
        scale: SCALE,
        backgroundColor: '#ffffff',
        useCORS: true,
        logging: false,
        onclone: measure,
      });
      if (!Number.isFinite(total))
        throw new Error('The page could not be laid out');
      const end =
        top + pageHeight >= total
          ? total - top
          : pageEnd(canvas, top, pageHeight, breaks);
      const png = await pdf.embedPng(await pngBytes(canvas, end));
      const page = pdf.addPage([PAGE_W, PAGE_H]);
      page.drawImage(png, {
        x: MARGIN,
        y: PAGE_H - MARGIN - end / PX,
        width: width / PX,
        height: end / PX,
      });
      top += end;
    }
    return await pdf.save();
  } finally {
    frame.remove();
  }
}

/** Where blocks start and end, in CSS pixels from the top */
function blockBreaks(doc: Document): number[] {
  const at = new Set<number>();
  for (const el of doc.querySelectorAll(BLOCKS)) {
    const r = el.getBoundingClientRect();
    if (!r.height) continue;
    at.add(Math.round(r.top));
    at.add(Math.round(r.bottom));
  }
  return [...at].sort((a, b) => a - b);
}

/** How much of a page drawn from `top` goes on it: up to a break between
 *  blocks, else a blank line, else all of it. Drawn text can reach a pixel
 *  or two past its block, so a break moves to a blank line next to it. */
function pageEnd(
  canvas: HTMLCanvasElement,
  top: number,
  height: number,
  breaks: number[]
): number {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return height;
  const min = Math.ceil(height * MIN_FILL);
  const near = 6;
  const blocks = breaks
    .map((b) => b - top)
    .filter((b) => b >= min && b <= height)
    .reverse();
  for (const b of blocks) {
    const at = blankLine(
      ctx,
      Math.max(b - near, min),
      Math.min(b + near, height)
    );
    if (at > 0) return at;
  }
  const at = blankLine(ctx, min, height);
  return at > 0 ? at : height;
}

/** The lowest CSS pixel row in [from, to) that is blank (one colour across
 *  the page) in the drawing, or -1 */
function blankLine(
  ctx: CanvasRenderingContext2D,
  from: number,
  to: number
): number {
  const width = ctx.canvas.width;
  const rows = Math.min(to * SCALE, ctx.canvas.height) - from * SCALE;
  if (rows <= 0) return -1;
  const { data } = ctx.getImageData(0, from * SCALE, width, rows);
  const rowBytes = width * 4;
  const plain = (y: number) => {
    const row = data.subarray(y * rowBytes, (y + 1) * rowBytes);
    for (let i = 4; i < row.length; i += 4)
      if (
        row[i] !== row[0] ||
        row[i + 1] !== row[1] ||
        row[i + 2] !== row[2] ||
        row[i + 3] !== row[3]
      )
        return false;
    return true;
  };
  for (let px = Math.floor(rows / SCALE) - 1; px >= 0; px--) {
    let blank = true;
    for (let d = 0; d < SCALE && blank; d++) blank = plain(px * SCALE + d);
    if (blank) return from + px;
  }
  return -1;
}

/** The top `height` CSS pixels of the drawing, as a PNG */
async function pngBytes(
  canvas: HTMLCanvasElement,
  height: number
): Promise<Uint8Array> {
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = Math.min(Math.round(height * SCALE), canvas.height);
  out.getContext('2d')?.drawImage(canvas, 0, 0);
  const blob = await new Promise<Blob | null>((r) =>
    out.toBlob(r, 'image/png')
  );
  if (!blob) throw new Error('The page could not be drawn');
  return new Uint8Array(await blob.arrayBuffer());
}
