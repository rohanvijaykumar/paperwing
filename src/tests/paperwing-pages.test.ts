// Page changes from the thumbnails panel (src/acro/pages.ts)
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  deletePages,
  extractPages,
  insertBlankPage,
  insertPagesFrom,
  movePage,
  rotatePages,
} from '../acro/pages';

/** A PDF whose page i is (100 + i) points wide, to tell pages apart */
async function pdf(count: number, base = 100): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < count; i++) doc.addPage([base + i, 200]);
  const out = await doc.save();
  return out.buffer.slice(
    out.byteOffset,
    out.byteOffset + out.byteLength
  ) as ArrayBuffer;
}

async function widths(bytes: ArrayBuffer) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => p.getSize().width);
}

async function rotations(bytes: ArrayBuffer) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => p.getRotation().angle);
}

describe('page changes', () => {
  it('rotates pages both ways and wraps around', async () => {
    let b = await rotatePages(await pdf(3), [1], 90);
    expect(await rotations(b)).toEqual([0, 90, 0]);
    b = await rotatePages(b, [1, 2], -90);
    expect(await rotations(b)).toEqual([0, 0, 270]);
    b = await rotatePages(b, [2], 180);
    expect(await rotations(b)).toEqual([0, 0, 90]);
  });

  it('deletes pages, but never the last one', async () => {
    const b = await deletePages(await pdf(4), [0, 2]);
    expect(await widths(b)).toEqual([101, 103]);
    await expect(deletePages(await pdf(2), [0, 1])).rejects.toThrow();
  });

  it('moves a page forwards and backwards', async () => {
    const src = await pdf(4);
    expect(await widths(await movePage(src, 0, 2))).toEqual([
      101, 102, 100, 103,
    ]);
    expect(await widths(await movePage(src, 3, 0))).toEqual([
      103, 100, 101, 102,
    ]);
    expect(await widths(await movePage(src, 1, 1))).toEqual([
      100, 101, 102, 103,
    ]);
  });

  it('inserts a blank page the size of its neighbour', async () => {
    expect(await widths(await insertBlankPage(await pdf(3), 1))).toEqual([
      100, 101, 101, 102,
    ]);
    expect(await widths(await insertBlankPage(await pdf(2), -1))).toEqual([
      100, 100, 101,
    ]);
  });

  it('inserts every page of another PDF', async () => {
    const b = await insertPagesFrom(await pdf(2), 0, await pdf(2, 500));
    expect(await widths(b)).toEqual([100, 500, 501, 101]);
  });

  it('extracts pages into a new document, in the order asked', async () => {
    const b = await extractPages(await pdf(5), [3, 1]);
    expect(await widths(b)).toEqual([103, 101]);
  });

  it('keeps annotations with the page they belong to', async () => {
    const doc = await PDFDocument.load(await pdf(3));
    const ctx = doc.context;
    const annot = ctx.register(
      ctx.obj({
        Type: 'Annot',
        Subtype: 'Text',
        Rect: [10, 10, 30, 30],
        Contents: 'note',
      })
    );
    doc
      .getPage(0)
      .node.set(
        (await import('pdf-lib')).PDFName.of('Annots'),
        ctx.obj([annot])
      );
    const out = await doc.save();
    const moved = await movePage(
      out.buffer.slice(
        out.byteOffset,
        out.byteOffset + out.byteLength
      ) as ArrayBuffer,
      0,
      2
    );
    const back = await PDFDocument.load(moved);
    expect(back.getPage(2).node.Annots()?.size()).toBe(1);
    expect(back.getPage(0).node.Annots()).toBeUndefined();
  });
});
