// Filling in a form from the workspace (src/acro/forms.ts)
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { PDFDocument, PDFName, PDFRawStream, PDFString } from 'pdf-lib';
import { inspectPdf, setFieldValues } from '../acro/forms';

/** A two-page form: a name field and a checkbox on page 1, a read-only
 *  reference on page 2 */
async function formPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const [p1, p2] = [doc.addPage([400, 400]), doc.addPage([400, 400])];
  const form = doc.getForm();
  const name = form.createTextField('applicant.name');
  name.addToPage(p1, { x: 20, y: 300, width: 200, height: 24 });
  name.acroField.dict.set(PDFName.of('TU'), PDFString.of('Full name'));
  form
    .createCheckBox('agree')
    .addToPage(p1, { x: 20, y: 250, width: 16, height: 16 });
  const ref = form.createTextField('reference');
  ref.setText('REF-1');
  ref.enableReadOnly();
  ref.addToPage(p2, { x: 20, y: 300, width: 200, height: 24 });
  form.createRadioGroup('size').addOptionToPage('s', p2, { x: 20, y: 200 });
  return doc.save();
}

describe('form fields', () => {
  it('lists text fields and checkboxes with their values', async () => {
    const { form, scripted } = await inspectPdf(await formPdf());
    expect(scripted).toBe(false);
    expect(form?.locked).toBe(false);
    expect(form?.other).toBe(1); // the radio group
    expect(form?.fields).toEqual([
      expect.objectContaining({
        name: 'applicant.name',
        label: 'Full name',
        kind: 'text',
        value: '',
        readOnly: false,
        page: 1,
      }),
      expect.objectContaining({
        name: 'agree',
        label: 'agree',
        kind: 'checkbox',
        value: false,
        page: 1,
      }),
      expect.objectContaining({
        name: 'reference',
        value: 'REF-1',
        readOnly: true,
        page: 2,
      }),
    ]);
  });

  it('saves a typed value and a ticked box, and they are there on reopening', async () => {
    const filled = await setFieldValues(await formPdf(), {
      'applicant.name': 'Ada Lovelace',
      agree: true,
    });
    // Reopened from the saved bytes
    const reopened = await PDFDocument.load(filled);
    const form = reopened.getForm();
    expect(form.getTextField('applicant.name').getText()).toBe('Ada Lovelace');
    expect(form.getCheckBox('agree').isChecked()).toBe(true);
    expect(form.getTextField('reference').getText()).toBe('REF-1');
    // Still a form: fields and their widgets are kept, not flattened
    expect(form.getFields()).toHaveLength(4);
    expect(reopened.getPage(0).node.Annots()?.size()).toBe(2);
    const { form: info } = await inspectPdf(filled);
    expect(info?.fields.map((f) => f.value)).toEqual([
      'Ada Lovelace',
      true,
      'REF-1',
    ]);

    // And unticked again
    const cleared = await setFieldValues(filled, { agree: false });
    const again = await inspectPdf(cleared);
    expect(again.form?.fields[1].value).toBe(false);
    expect(again.form?.fields[0].value).toBe('Ada Lovelace');
  });

  it('refuses read-only fields, unknown fields and wrong kinds of value', async () => {
    const pdf = await formPdf();
    await expect(setFieldValues(pdf, { reference: 'X' })).rejects.toThrow(
      /read-only/
    );
    await expect(setFieldValues(pdf, { nope: 'X' })).rejects.toThrow(
      /no field/
    );
    await expect(setFieldValues(pdf, { agree: 'yes' })).rejects.toThrow(
      /can't take/
    );
    // Nothing changed in the document itself
    const { form } = await inspectPdf(pdf);
    expect(form?.fields[2].value).toBe('REF-1');
  });

  it('fits auto-sized multiline text inside its box and keeps it auto-sized', async () => {
    const doc = await PDFDocument.create();
    const notes = doc.getForm().createTextField('notes');
    notes.enableMultiline();
    notes.addToPage(doc.addPage([400, 400]), {
      x: 20,
      y: 200,
      width: 200,
      height: 60,
    });
    notes.acroField.setDefaultAppearance('0 0 0 rg /Helv 0 Tf');
    const pdf = await doc.save({ updateFieldAppearances: false });

    const drawn = async (text: string) => {
      const out = await PDFDocument.load(
        await setFieldValues(pdf, { notes: text })
      );
      const field = out.getForm().getTextField('notes');
      const ap = out.context.lookup(
        field.acroField.getWidgets()[0].getNormalAppearance()
      ) as PDFRawStream;
      const body = (
        ap.dict.get(PDFName.of('Filter'))
          ? inflateSync(ap.contents)
          : Buffer.from(ap.contents)
      ).toString('latin1');
      return {
        da: field.acroField.getDefaultAppearance(),
        size: Number(/([\d.]+) Tf/.exec(body)?.[1]),
        baselines: [...body.matchAll(/1 0 0 1 [\d.]+ ([\d.-]+) Tm/g)].map((m) =>
          Number(m[1])
        ),
        text: [...body.matchAll(/<([0-9A-F]+)> Tj/g)]
          .map((m) => Buffer.from(m[1], 'hex').toString('latin1'))
          .join(' '),
      };
    };

    const short = await drawn('Prefers email.');
    expect(short.size).toBe(12);
    expect(short.text).toBe('Prefers email.');
    expect(short.da).toMatch(/ 0 Tf/);

    const long = 'Please call after six on weekdays, or any time at weekends. '
      .repeat(3)
      .trim();
    const shrunk = await drawn(long);
    expect(shrunk.size).toBeLessThan(12);
    expect(shrunk.text.replace(/\s+/g, ' ')).toBe(long);
    // Every line's baseline sits inside the 60pt-high box
    expect(shrunk.baselines.length).toBeGreaterThan(2);
    for (const y of shrunk.baselines) expect(y).toBeGreaterThan(0);
    expect(shrunk.da).toMatch(/ 0 Tf/);
  });

  it('has no form panel for a document without fields', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    expect((await inspectPdf(await doc.save())).form).toBeNull();
  });

  it("doesn't change a protected (encrypted) document", async () => {
    const locked = new Uint8Array(
      readFileSync(resolve(__dirname, 'fixtures', 'protected.pdf'))
    );
    await expect(setFieldValues(locked, { a: 'b' })).rejects.toThrow(
      /protected/
    );
    expect((await inspectPdf(locked)).scripted).toBe(false);
  });
});
