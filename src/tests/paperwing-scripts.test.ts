// Scripts Paperwing doesn't run, detected for the document notice
// (src/acro/scripts.ts)
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { hasScripts } from '../acro/scripts';
import { inspectPdf } from '../acro/forms';

/** A PDF changed by `edit`, saved and loaded again */
async function pdf(
  edit: (doc: PDFDocument) => void = () => {}
): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  edit(doc);
  return PDFDocument.load(await doc.save());
}

const js = (doc: PDFDocument, code = 'app.alert("Hello")') =>
  doc.context.obj({ S: 'JavaScript', JS: PDFString.of(code) });

const link = (doc: PDFDocument, action: Record<string, unknown>) => {
  const annot = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [0, 0, 50, 50],
      ...action,
    })
  );
  doc.getPage(0).node.set(PDFName.of('Annots'), doc.context.obj([annot]));
};

describe('scripted instructions', () => {
  it('a normal PDF has none', async () => {
    expect(hasScripts(await pdf())).toBe(false);
    const sample = new Uint8Array(
      readFileSync(resolve(__dirname, 'fixtures', 'sample.pdf'))
    );
    expect((await inspectPdf(sample)).scripted).toBe(false);
  });

  it('document JavaScript (Names ▸ JavaScript)', async () => {
    const doc = await pdf((d) => {
      const action = d.context.register(js(d));
      const tree = d.context.obj({
        Names: [PDFString.of('init'), action],
      });
      d.catalog.set(
        PDFName.of('Names'),
        d.context.obj({ JavaScript: d.context.register(tree) })
      );
    });
    expect(hasScripts(doc)).toBe(true);
  });

  it('a JavaScript OpenAction', async () => {
    const doc = await pdf((d) =>
      d.catalog.set(PDFName.of('OpenAction'), d.context.register(js(d)))
    );
    expect(hasScripts(doc)).toBe(true);
  });

  it('other OpenActions that do something (print when opened)', async () => {
    const doc = await pdf((d) =>
      d.catalog.set(
        PDFName.of('OpenAction'),
        d.context.obj({ S: 'Named', N: 'Print' })
      )
    );
    expect(hasScripts(doc)).toBe(true);
  });

  it('a script chained after a harmless OpenAction', async () => {
    const doc = await pdf((d) =>
      d.catalog.set(
        PDFName.of('OpenAction'),
        d.context.obj({
          S: 'GoTo',
          D: [d.getPage(0).ref, 'Fit'],
          Next: d.context.register(js(d)),
        })
      )
    );
    expect(hasScripts(doc)).toBe(true);
  });

  it('opening at a page is not a script', async () => {
    const dest = await pdf((d) =>
      d.catalog.set(
        PDFName.of('OpenAction'),
        d.context.obj([d.getPage(0).ref, 'Fit'])
      )
    );
    expect(hasScripts(dest)).toBe(false);
    const goTo = await pdf((d) =>
      d.catalog.set(
        PDFName.of('OpenAction'),
        d.context.obj({ S: 'GoTo', D: [d.getPage(0).ref, 'Fit'] })
      )
    );
    expect(hasScripts(goTo)).toBe(false);
  });

  it('additional actions on the document, a page or an annotation', async () => {
    const onDoc = await pdf((d) =>
      d.catalog.set(PDFName.of('AA'), d.context.obj({ WC: js(d) }))
    );
    expect(hasScripts(onDoc)).toBe(true);
    const onPage = await pdf((d) =>
      d.getPage(0).node.set(PDFName.of('AA'), d.context.obj({ O: js(d) }))
    );
    expect(hasScripts(onPage)).toBe(true);
    const onAnnot = await pdf((d) => link(d, { AA: { E: js(d) } }));
    expect(hasScripts(onAnnot)).toBe(true);
    const empty = await pdf((d) =>
      d.getPage(0).node.set(PDFName.of('AA'), d.context.obj({}))
    );
    expect(hasScripts(empty)).toBe(false);
  });

  it('a link that runs JavaScript, but not a web link', async () => {
    expect(hasScripts(await pdf((d) => link(d, { A: js(d) })))).toBe(true);
    const web = await pdf((d) =>
      link(d, { A: { S: 'URI', URI: PDFString.of('https://example.com') } })
    );
    expect(hasScripts(web)).toBe(false);
  });

  it('form field actions (calculations, formatting)', async () => {
    const doc = await pdf((d) => {
      const field = d.getForm().createTextField('total');
      field.addToPage(d.getPage(0), { x: 10, y: 10, width: 80, height: 20 });
      // On the parent field, not the widget
      const child = d.getForm().createTextField('parent.child');
      child.addToPage(d.getPage(0), { x: 10, y: 50, width: 80, height: 20 });
      child.acroField
        .getParent()!
        .dict.set(
          PDFName.of('AA'),
          d.context.obj({ C: js(d, 'event.value=1') })
        );
    });
    expect(hasScripts(doc)).toBe(true);
    const plain = await pdf((d) =>
      d
        .getForm()
        .createTextField('name')
        .addToPage(d.getPage(0), { x: 10, y: 10, width: 80, height: 20 })
    );
    expect(hasScripts(plain)).toBe(false);
  });
});
