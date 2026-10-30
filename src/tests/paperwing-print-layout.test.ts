// Laying out what prints (src/acro/print-layout.ts): which pages, on what
// paper, how large, several to a sheet, booklets
import { describe, expect, it } from 'vitest';
import {
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFStream,
  degrees,
} from 'pdf-lib';
import { inflateSync } from 'node:zlib';
import {
  MARGIN,
  PAPERS,
  bookletSides,
  cellOf,
  choosePages,
  defaultPaper,
  defaultSettings,
  layOut,
  parsePageRange,
  printableComments,
  withoutComments,
  type PrintSettings,
} from '../acro/print-layout';

const settings = (s: Partial<PrintSettings> = {}): PrintSettings => ({
  ...defaultSettings('en-US'),
  ...s,
});

/** A document of `sizes` pages ([width, height] in points, rotation) */
async function docOf(sizes: [number, number, number?][]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const [w, h, r = 0] of sizes) {
    const p = doc.addPage([w, h]);
    p.drawRectangle({ x: 10, y: 10, width: w - 20, height: h - 20 });
    if (r) p.setRotation(degrees(r));
  }
  return doc.save();
}
const letterPages = (n: number) =>
  docOf(Array.from({ length: n }, () => [612, 792] as [number, number]));

/** The sheets' sizes, rounded */
async function sheetSizes(pdf: Uint8Array) {
  const doc = await PDFDocument.load(pdf);
  return doc.getPages().map((p) => {
    const { width, height } = p.getSize();
    return [Math.round(width), Math.round(height)];
  });
}

/** The placement (cm) and form (Do) operators drawn on each sheet */
async function drawings(pdf: Uint8Array) {
  const doc = await PDFDocument.load(pdf);
  return doc.getPages().map((p) => {
    const contents = p.node.Contents();
    const streams =
      contents instanceof PDFStream
        ? [contents]
        : (contents?.asArray() ?? []).map((r) => doc.context.lookup(r));
    const text = streams
      .map((s) => {
        const raw = s as PDFRawStream;
        const filter = raw.dict.get(PDFName.of('Filter'));
        return filter
          ? inflateSync(Buffer.from(raw.contents)).toString('latin1')
          : Buffer.from(raw.contents).toString('latin1');
      })
      .join('\n');
    // pdf-lib places a page with three cm operators: move, turn, scale
    return {
      places: text.match(/Do/g)?.length ?? 0,
      cm: [
        ...text.matchAll(
          /([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) cm/g
        ),
      ].map((m) => m.slice(1, 7).map(Number)),
    };
  });
}

describe('which pages print', () => {
  it('reads page ranges as Acrobat does', () => {
    expect(parsePageRange('1-3, 5', 9)).toEqual([1, 2, 3, 5]);
    expect(parsePageRange(' 6,10-12 ,2', 12)).toEqual([6, 10, 11, 12, 2]);
    expect(parsePageRange('4-2', 5)).toEqual([4, 3, 2]);
  });

  it('says what is wrong with a range', () => {
    expect(() => parsePageRange('', 5)).toThrow(/Enter the pages/);
    expect(() => parsePageRange('2-x', 5)).toThrow(/isn't a page or a range/);
    expect(() => parsePageRange('3-7', 5)).toThrow('Pages go from 1 to 5');
    expect(() => parsePageRange('0', 5)).toThrow('Pages go from 1 to 5');
    expect(() => parsePageRange('2', 1)).toThrow('This document has 1 page');
  });

  it('all, current, odd or even, reversed', () => {
    const base = {
      pages: 'all',
      range: '',
      subset: 'all',
      reverse: false,
    } as const;
    expect(choosePages(base, 5, 1)).toEqual([1, 2, 3, 4, 5]);
    expect(choosePages({ ...base, pages: 'current' }, 5, 3)).toEqual([3]);
    expect(choosePages({ ...base, subset: 'odd' }, 5, 1)).toEqual([1, 3, 5]);
    expect(choosePages({ ...base, subset: 'even' }, 5, 1)).toEqual([2, 4]);
    expect(choosePages({ ...base, reverse: true }, 3, 1)).toEqual([3, 2, 1]);
    // Odd and even go by page number, also within a range
    expect(
      choosePages(
        { ...base, pages: 'range', range: '2-6', subset: 'odd' },
        9,
        1
      )
    ).toEqual([3, 5]);
    expect(() => choosePages({ ...base, subset: 'even' }, 1, 1)).toThrow(
      /no even pages/
    );
  });
});

describe('paper', () => {
  it('Letter where it is the usual paper, A4 elsewhere', () => {
    for (const l of ['en-US', 'en-CA', 'es-MX', 'en-PH'])
      expect(defaultPaper(l)).toBe('letter');
    for (const l of ['en-GB', 'en-IN', 'de-DE', 'fr-FR', 'ja-JP', 'pt-BR'])
      expect(defaultPaper(l)).toBe('a4');
    expect(defaultPaper('en')).toBe('letter');
    expect(defaultPaper('de')).toBe('a4');
  });
});

describe('Size: one page per sheet', () => {
  it('each page on a sheet of the chosen paper, the right way round', async () => {
    // A portrait and a landscape page, on A4, orientation auto
    const src = await docOf([
      [612, 792],
      [792, 612],
    ]);
    const out = await layOut(src, settings({ paper: 'a4' }));
    expect(out.sheets).toBe(2);
    expect(await sheetSizes(out.pdf)).toEqual([
      [595, 842],
      [842, 595],
    ]);
    expect(out.landscape).toBe('mixed');
    // Portrait or landscape, all of them
    const portrait = await layOut(
      src,
      settings({ paper: 'a4', orientation: 'portrait' })
    );
    expect(await sheetSizes(portrait.pdf)).toEqual([
      [595, 842],
      [595, 842],
    ]);
    expect(portrait.landscape).toBe(false);
    const landscape = await layOut(src, settings({ orientation: 'landscape' }));
    expect(landscape.landscape).toBe(true);
  });

  it('Fit enlarges or reduces to the paper; Shrink only reduces; Actual size and Custom keep the scale', async () => {
    const small = await docOf([[300, 400]]);
    const room = (PAPERS.letter.height - 2 * MARGIN) / 400;
    const scaleOf = async (s: Partial<PrintSettings>) =>
      (await drawings((await layOut(small, settings(s))).pdf))[0].cm[2][0];
    expect(await scaleOf({ sizing: 'fit' })).toBeCloseTo(
      Math.min((612 - 2 * MARGIN) / 300, room),
      3
    );
    expect(await scaleOf({ sizing: 'shrink' })).toBe(1);
    expect(await scaleOf({ sizing: 'actual' })).toBe(1);
    expect(await scaleOf({ sizing: 'custom', scale: 150 })).toBe(1.5);

    const big = await docOf([[1224, 1584]]); // twice Letter
    const bigScale = async (s: Partial<PrintSettings>) =>
      (await drawings((await layOut(big, settings(s))).pdf))[0].cm[2][0];
    expect(await bigScale({ sizing: 'shrink' })).toBeLessThan(0.5);
    expect(await bigScale({ sizing: 'actual' })).toBe(1);
  });

  it('a page is printed as it shows, turned by its rotation', async () => {
    // A landscape-shaped page stored portrait and turned 90°
    const turned = await docOf([[612, 792, 90]]);
    const out = await layOut(turned, settings());
    // It shows landscape, so the sheet is landscape
    expect(await sheetSizes(out.pdf)).toEqual([[792, 612]]);
    const m = (await drawings(out.pdf))[0].cm[1];
    // Turned clockwise: the drawing is rotated by -90° (b = -1, c = 1)
    expect(m[1]).toBeCloseTo(-1, 5);
    expect(m[2]).toBeCloseTo(1, 5);
  });

  it('each page is placed once even if it prints twice', async () => {
    const src = await letterPages(3);
    const out = await layOut(
      src,
      settings({ pages: 'range', range: '1, 1, 2' })
    );
    expect(out.sheets).toBe(3);
    const doc = await PDFDocument.load(out.pdf);
    const forms = new Set(
      doc.getPages().flatMap(
        (p): string[] =>
          p.node
            .Resources()!
            .lookup(PDFName.of('XObject'))
            ?.toString()
            .match(/\d+ 0 R/g) ?? []
      )
    );
    expect(forms.size).toBe(2);
  });
});

describe('Multiple pages per sheet', () => {
  it('fills the cells in the chosen order', () => {
    // 2 columns × 2 rows
    expect([0, 1, 2, 3].map((k) => cellOf(k, 2, 2, 'horizontal'))).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]);
    expect(
      [0, 1, 2, 3].map((k) => cellOf(k, 2, 2, 'horizontal-reversed'))
    ).toEqual([
      [1, 0],
      [0, 0],
      [1, 1],
      [0, 1],
    ]);
    expect([0, 1, 2, 3].map((k) => cellOf(k, 2, 2, 'vertical'))).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ]);
    expect(
      [0, 1, 2, 3].map((k) => cellOf(k, 2, 2, 'vertical-reversed'))
    ).toEqual([
      [1, 0],
      [1, 1],
      [0, 0],
      [0, 1],
    ]);
  });

  it('n pages a sheet: the sheets needed, the last one partly filled', async () => {
    const src = await letterPages(9);
    const four = await layOut(
      src,
      settings({ handling: 'multiple', perSheet: 4 })
    );
    expect(four.sheets).toBe(3);
    expect((await drawings(four.pdf)).map((d) => d.places)).toEqual([4, 4, 1]);
    // Two portrait pages side by side fit best on a landscape sheet
    const two = await layOut(
      src,
      settings({ handling: 'multiple', perSheet: 2 })
    );
    expect(two.sheets).toBe(5);
    expect(two.landscape).toBe(true);
  });

  it('borders when asked', async () => {
    const src = await letterPages(2);
    const plain = await layOut(src, settings({ handling: 'multiple' }));
    const framed = await layOut(
      src,
      settings({ handling: 'multiple', borders: true })
    );
    expect(framed.pdf.length).toBeGreaterThan(plain.pdf.length);
  });
});

describe('Booklet', () => {
  it('orders pages so the folded sheets read in order', () => {
    // 8 pages: 2 sheets, front and back each
    expect(bookletSides(8, 'left')).toEqual([
      [7, 0],
      [1, 6],
      [5, 2],
      [3, 4],
    ]);
    // Right binding mirrors each side
    expect(bookletSides(8, 'right')[0]).toEqual([0, 7]);
    // 6 pages: padded to 8 with blanks
    expect(bookletSides(6, 'left')).toEqual([
      [null, 0],
      [1, null],
      [5, 2],
      [3, 4],
    ]);
  });

  it('two pages to a landscape sheet, both sides, or one side only', async () => {
    const src = await letterPages(8);
    const both = await layOut(src, settings({ handling: 'booklet' }));
    expect(both.sheets).toBe(4);
    expect(both.landscape).toBe(true);
    expect((await drawings(both.pdf)).map((d) => d.places)).toEqual([
      2, 2, 2, 2,
    ]);
    const front = await layOut(
      src,
      settings({ handling: 'booklet', bookletSubset: 'front' })
    );
    expect(front.sheets).toBe(2);
    const back = await layOut(
      src,
      settings({ handling: 'booklet', bookletSubset: 'back' })
    );
    expect(back.sheets).toBe(2);
  });
});

describe('comments', () => {
  it('"Document" keeps form fields and drops comments and stamps', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 400]);
    doc
      .getForm()
      .createTextField('name')
      .addToPage(page, { x: 20, y: 300, width: 200, height: 24 });
    const note = doc.context.obj({
      Type: 'Annot',
      Subtype: 'Text',
      Rect: [20, 20, 40, 40],
      Contents: 'A note',
    });
    page.node.Annots()!.push(doc.context.register(note));
    const out = await withoutComments(await doc.save());
    const annots = (await PDFDocument.load(out)).getPage(0).node.Annots()!;
    expect(annots.size()).toBe(1);
    expect(String(annots.lookup(0))).toContain('/Widget');
  });

  it("Paperwing's own markups (no flags at all) print; flags an author set are kept", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 400]);
    const annot = (extra: Record<string, unknown>) =>
      page.node.Annots()
        ? page.node.Annots()!.push(
            doc.context.register(
              doc.context.obj({
                Type: 'Annot',
                Rect: [0, 0, 10, 10],
                ...extra,
              })
            )
          )
        : page.node.set(
            PDFName.of('Annots'),
            doc.context.obj([
              doc.context.register(
                doc.context.obj({
                  Type: 'Annot',
                  Rect: [0, 0, 10, 10],
                  ...extra,
                })
              ),
            ])
          );
    annot({ Subtype: 'Highlight' }); // made in Paperwing: no flags
    annot({ Subtype: 'Square', F: 0 }); // hidden from print on purpose
    annot({ Subtype: 'Popup' });
    const out = await PDFDocument.load(
      await printableComments(await doc.save())
    );
    const flags = out
      .getPage(0)
      .node.Annots()!
      .asArray()
      .map(
        (r) =>
          out.context
            .lookup(r)!
            .toString()
            .match(/\/F (\d+)/)?.[1] ?? null
      );
    expect(flags).toEqual(['4', '0', null]);
  });

  it('leaves a document without comments as it is', async () => {
    const src = await letterPages(1);
    expect(await withoutComments(src)).toBe(src);
  });
});
