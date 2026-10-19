/**
 * Page changes from the thumbnails panel: rotate, delete, move, insert and
 * extract pages. The viewer can't change an open document's pages, so the
 * workspace takes the document's current bytes (annotations included),
 * changes them here with pdf-lib, and reopens the tab with the result.
 * Page numbers here are 0-based.
 */
import { PDFDocument, degrees } from 'pdf-lib';

async function load(bytes: ArrayBuffer | Uint8Array) {
  return PDFDocument.load(bytes, { updateMetadata: false });
}

async function save(doc: PDFDocument): Promise<ArrayBuffer> {
  const out = await doc.save();
  return out.buffer.slice(
    out.byteOffset,
    out.byteOffset + out.byteLength
  ) as ArrayBuffer;
}

/** How many pages a PDF has */
export async function pageCount(bytes: ArrayBuffer): Promise<number> {
  return (await load(bytes)).getPageCount();
}

/** Turns pages by a multiple of 90° (clockwise for positive) */
export async function rotatePages(
  bytes: ArrayBuffer,
  pages: number[],
  by: 90 | -90 | 180
): Promise<ArrayBuffer> {
  const doc = await load(bytes);
  for (const i of pages) {
    const page = doc.getPage(i);
    const now = page.getRotation().angle;
    page.setRotation(degrees((((now + by) % 360) + 360) % 360));
  }
  return save(doc);
}

/** Removes pages; a document keeps at least one */
export async function deletePages(
  bytes: ArrayBuffer,
  pages: number[]
): Promise<ArrayBuffer> {
  const doc = await load(bytes);
  const drop = [...new Set(pages)].sort((a, b) => b - a);
  if (drop.length >= doc.getPageCount())
    throw new Error('A document needs at least one page');
  for (const i of drop) doc.removePage(i);
  return save(doc);
}

/** Moves a page so that it ends up at `to` */
export async function movePage(
  bytes: ArrayBuffer,
  from: number,
  to: number
): Promise<ArrayBuffer> {
  const doc = await load(bytes);
  const count = doc.getPageCount();
  if (from === to || from < 0 || to < 0 || from >= count || to >= count)
    return bytes;
  const page = doc.getPage(from);
  doc.removePage(from);
  doc.insertPage(to, page);
  return save(doc);
}

/** Moves several pages, keeping their order, to just before the page now
 *  at `before` (the page count: to the end). Pages not moved keep theirs */
export async function movePages(
  bytes: ArrayBuffer,
  pages: number[],
  before: number
): Promise<ArrayBuffer> {
  const doc = await load(bytes);
  const count = doc.getPageCount();
  const moving = [...new Set(pages)]
    .filter((i) => i >= 0 && i < count)
    .sort((a, b) => a - b);
  if (!moving.length) return bytes;
  const rest: number[] = [];
  for (let i = 0; i < count; i++) if (!moving.includes(i)) rest.push(i);
  const at = rest.filter((i) => i < before).length;
  const order = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  if (order.every((p, i) => p === i)) return bytes;
  // One page at a time into place, so the document always has pages
  const current = [...Array(count).keys()];
  order.forEach((p, k) => {
    const j = current.indexOf(p);
    if (j === k) return;
    const page = doc.getPage(j);
    doc.removePage(j);
    doc.insertPage(k, page);
    current.splice(j, 1);
    current.splice(k, 0, p);
  });
  return save(doc);
}

/** Adds an empty page after `after` (-1: at the start), the size of the
 *  page next to it */
export async function insertBlankPage(
  bytes: ArrayBuffer,
  after: number
): Promise<ArrayBuffer> {
  const doc = await load(bytes);
  const near = doc.getPage(
    Math.max(0, Math.min(after, doc.getPageCount() - 1))
  );
  const { width, height } = near.getSize();
  const rotation = near.getRotation().angle;
  const page = doc.insertPage(after + 1, [width, height]);
  if (rotation) page.setRotation(degrees(rotation));
  return save(doc);
}

/** Copies all pages of another PDF in after `after` (-1: at the start) */
export async function insertPagesFrom(
  bytes: ArrayBuffer,
  after: number,
  other: ArrayBuffer
): Promise<ArrayBuffer> {
  const doc = await load(bytes);
  const src = await load(other);
  const copied = await doc.copyPages(src, src.getPageIndices());
  copied.forEach((page, k) => doc.insertPage(after + 1 + k, page));
  return save(doc);
}

/** A new PDF with copies of these pages, in this order */
export async function extractPages(
  bytes: ArrayBuffer,
  pages: number[]
): Promise<ArrayBuffer> {
  const src = await load(bytes);
  const doc = await PDFDocument.create();
  const copied = await doc.copyPages(src, pages);
  copied.forEach((page) => doc.addPage(page));
  return save(doc);
}
