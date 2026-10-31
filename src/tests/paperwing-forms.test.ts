// Forms: what pdf-lib reads from a document's form (src/acro/forms.ts), and
// the form as PDFium holds it (src/acro/form-model.ts). Filling in happens in
// PDFium, in the running app (desktop/bench/check-forms.mjs).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { inspectPdf, type FieldMeta } from '../acro/forms';
import { buildFields, fillable, pagesOf, stepsTo } from '../acro/form-model';
import type { PageWidget } from '../acro/viewer';

/** A two-page form: a name, a checkbox and a dropdown on page 1; a
 *  read-only reference and a radio group on page 2 */
async function formPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const [p1, p2] = [doc.addPage([400, 400]), doc.addPage([400, 400])];
  const form = doc.getForm();
  const name = form.createTextField('applicant.name');
  name.addToPage(p1, { x: 20, y: 300, width: 200, height: 24 });
  name.acroField.dict.set(PDFName.of('TU'), PDFString.of('Full name'));
  name.setMaxLength(40);
  form
    .createCheckBox('agree')
    .addToPage(p1, { x: 20, y: 250, width: 16, height: 16 });
  const country = form.createDropdown('country');
  country.addOptions(['India', 'Japan']);
  country.addToPage(p1, { x: 20, y: 200, width: 120, height: 20 });
  const ref = form.createTextField('reference');
  ref.setText('REF-1');
  ref.enableReadOnly();
  ref.addToPage(p2, { x: 20, y: 300, width: 200, height: 24 });
  const size = form.createRadioGroup('size');
  size.addOptionToPage('small', p2, { x: 20, y: 200, width: 14, height: 14 });
  size.addOptionToPage('large', p2, { x: 60, y: 200, width: 14, height: 14 });
  return doc.save();
}

describe('what pdf-lib reads from a form', () => {
  it('lists every field with its label, kind and limits', async () => {
    const { form, scripted } = await inspectPdf(await formPdf());
    expect(scripted).toBe(false);
    expect(form?.locked).toBe(false);
    const byName = new Map(form!.fields.map((f) => [f.name, f]));
    expect(byName.get('applicant.name')).toMatchObject({
      label: 'Full name',
      kind: 'text',
      readOnly: false,
      maxLength: 40,
    });
    expect(byName.get('agree')).toMatchObject({ kind: 'checkbox' });
    expect(byName.get('country')).toMatchObject({ kind: 'dropdown' });
    expect(byName.get('reference')).toMatchObject({ readOnly: true });
  });

  it('names each radio button where PDFium places it (from the top left)', async () => {
    const { form } = await inspectPdf(await formPdf());
    const size = form!.fields.find((f) => f.name === 'size');
    expect(size?.kind).toBe('radio');
    // (within the 3 points matching allows: borders shift rectangles a bit)
    const want = [
      { x: 20, y: 400 - 214, value: 'small' },
      { x: 60, y: 400 - 214, value: 'large' },
    ];
    expect(size?.choices).toHaveLength(2);
    size!.choices!.forEach((c, i) => {
      expect(c.page).toBe(1);
      expect(c.value).toBe(want[i].value);
      expect(Math.abs(c.x - want[i].x)).toBeLessThan(1);
      expect(Math.abs(c.y - want[i].y)).toBeLessThan(1);
    });
  });

  it('has no form for a document without fields', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    expect((await inspectPdf(await doc.save())).form).toBeNull();
  });

  it("can't read a protected (encrypted) document's fields (PDFium can)", async () => {
    const locked = new Uint8Array(
      readFileSync(resolve(__dirname, 'fixtures', 'protected.pdf'))
    );
    const { form, scripted } = await inspectPdf(locked);
    expect(scripted).toBe(false);
    if (form) expect(form).toEqual({ fields: [], locked: true });
  });
});

/** A widget as PDFium reads it */
function widget(
  name: string,
  type: number,
  page: number,
  more: Partial<PageWidget['field']> = {},
  at = { x: 10, y: 10 }
): PageWidget {
  return {
    id: `${name}-${Math.random()}`,
    pageIndex: page,
    rect: { origin: at, size: { width: 100, height: 20 } },
    field: {
      flag: 0,
      type,
      name,
      alternateName: '',
      value: '',
      isChecked: false,
      options: [],
      ...more,
    },
  };
}

describe('the form as PDFium holds it', () => {
  const pages = (): PageWidget[][] => [
    [
      widget('name', 6, 0, { value: 'Alex', flag: 2 }),
      widget('agree', 2, 0, { isChecked: 1 }),
      widget('country', 4, 0, {
        options: [
          { label: 'India', isSelected: 0 },
          { label: 'Japan', isSelected: 1 },
        ],
      }),
      widget('notes', 6, 0, { flag: 1 << 12 }),
      widget('ref', 6, 0, { value: 'R1', flag: 1 }),
      widget('sig', 7, 0),
    ],
    [
      widget('plan', 3, 1, {}, { x: 20, y: 186 }),
      widget('plan', 3, 1, { isChecked: 1 }, { x: 60, y: 186 }),
      // The same field shown twice
      widget('name', 6, 1, { value: 'Alex' }),
    ],
  ];

  it('groups widgets into fields, with their values and flags', () => {
    const fields = buildFields(pages());
    const f = (n: string) => fields.find((x) => x.name === n)!;
    expect(fields.map((x) => x.name)).toEqual([
      'name',
      'agree',
      'country',
      'notes',
      'ref',
      'sig',
      'plan',
    ]);
    expect(f('name')).toMatchObject({
      kind: 'text',
      value: 'Alex',
      required: true,
    });
    expect(pagesOf(f('name'))).toEqual([0, 1]);
    expect(f('agree').value).toBe(true);
    expect(f('country')).toMatchObject({
      options: ['India', 'Japan'],
      value: 1,
    });
    expect(f('notes').multiline).toBe(true);
    expect(f('ref').readOnly).toBe(true);
    expect(f('plan').value).toBe(1);
    expect(fillable(f('ref'))).toBe(false);
    expect(fillable(f('sig'))).toBe(false);
    expect(fillable(f('name'))).toBe(true);
  });

  it("takes labels, limits and radio choices from pdf-lib's reading", () => {
    const meta = new Map<string, FieldMeta>([
      [
        'name',
        {
          name: 'name',
          label: 'Full name',
          kind: 'text',
          readOnly: false,
          maxLength: 30,
          fontSize: 10,
        },
      ],
      [
        'plan',
        {
          name: 'plan',
          label: 'Plan',
          kind: 'radio',
          readOnly: false,
          choices: [
            { page: 1, x: 60.5, y: 186.5, value: 'Team' },
            { page: 1, x: 20.5, y: 186.5, value: 'Free' },
          ],
        },
      ],
    ]);
    const fields = buildFields(pages(), meta);
    const f = (n: string) => fields.find((x) => x.name === n)!;
    expect(f('name')).toMatchObject({
      label: 'Full name',
      maxLength: 30,
      fontSize: 10,
    });
    // Matched by place, not by order
    expect(f('plan').options).toEqual(['Free', 'Team']);
    // Without a reading: by place in the group
    expect(
      buildFields(pages()).find((x) => x.name === 'plan')!.options
    ).toEqual(['Option 1', 'Option 2']);
  });

  it('works out what PDFium must be told to set each kind of field', () => {
    const fields = buildFields(pages());
    const f = (n: string) => fields.find((x) => x.name === n)!;
    expect(stepsTo(f('name'), 'Sam').map((s) => s.value)).toEqual([
      { kind: 'text', text: 'Sam' },
    ]);
    // A ticked box pressed once to untick
    expect(stepsTo(f('agree'), false).map((s) => s.value)).toEqual([
      { kind: 'checked' },
    ]);
    // The second radio button is chosen already; choosing the first presses it
    const plan = f('plan');
    expect(stepsTo(plan, 1)).toEqual([]);
    const press = stepsTo(plan, 0);
    expect(press).toHaveLength(1);
    expect(press[0].widget).toBe(plan.widgets[0]);
    expect(stepsTo(f('country'), 0).map((s) => s.value)).toEqual([
      { kind: 'selection', index: 0, isSelected: true },
    ]);
    // An option can't be unchosen (PDFium would still draw it chosen)
    expect(stepsTo(f('country'), -1)).toEqual([]);
  });

  it('refuses what a field can’t take, and fields that can’t be filled in', () => {
    const fields = buildFields(pages());
    const f = (n: string) => fields.find((x) => x.name === n)!;
    expect(stepsTo(f('ref'), 'X')).toEqual([]); // read-only
    expect(stepsTo(f('sig'), 'X')).toEqual([]); // a signature
    expect(stepsTo(f('name'), true)).toEqual([]); // wrong kind of value
    expect(stepsTo(f('country'), 5)).toEqual([]); // no such option
    expect(stepsTo(f('plan'), -1)).toEqual([]); // radio buttons can't be unchosen
    expect(stepsTo(f('name'), 'Alex')).toEqual([]); // already so
  });
});

describe('saving fields shown formatted by their scripts', () => {
  it('keeps the value as typed, drawn as shown (as Acrobat saves it)', async () => {
    const { unformat } = await import('../acro/forms');
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 200]);
    const total = doc.getForm().createTextField('total');
    total.addToPage(page, { x: 20, y: 100, width: 120, height: 24 });
    total.setText('$37.50'); // what PDFium holds and draws
    const bytes = await doc.save();
    const ap = (d: PDFDocument) =>
      d
        .getForm()
        .getTextField('total')
        .acroField.getWidgets()[0]
        .getNormalAppearance();
    const before = ap(await PDFDocument.load(bytes));

    const saved = await PDFDocument.load(
      await unformat(bytes.slice().buffer, new Map([['total', '37.5']]))
    );
    expect(saved.getForm().getTextField('total').getText()).toBe('37.5');
    // The drawing (still "$37.50") isn't redrawn
    expect(String(ap(saved))).toBe(String(before));
  });

  it('leaves a document alone when nothing is formatted', async () => {
    const { unformat } = await import('../acro/forms');
    const doc = await PDFDocument.create();
    doc.addPage();
    const bytes = (await doc.save()).slice().buffer;
    expect(await unformat(bytes, new Map())).toBe(bytes);
  });
});
