/**
 * Filling in a document's form (text fields and checkboxes). The viewer
 * shows saved form values but can't edit them, so the workspace lists the
 * fields beside the document and writes what's typed into its bytes here
 * with pdf-lib; the tab then reopens on the result (as for page changes).
 * Fields stay fields: nothing is flattened.
 */
import {
  PDFBool,
  PDFCheckBox,
  PDFDocument,
  PDFFont,
  PDFName,
  PDFString,
  PDFHexString,
  PDFTextField,
  layoutMultilineText,
} from 'pdf-lib';
import { hasScripts } from './scripts';

export interface FormField {
  /** Fully qualified field name */
  name: string;
  /** What to call it: its tooltip (/TU) if it has one, else its name */
  label: string;
  kind: 'text' | 'checkbox';
  value: string | boolean;
  readOnly: boolean;
  multiline: boolean;
  maxLength?: number;
  /** Page of its first widget, 1-based (0 if not on a page) */
  page: number;
}

export interface FormInfo {
  fields: FormField[];
  /** Fields of other kinds (choices, radio buttons, signatures...) */
  other: number;
  /** Encrypted: its fields can't be changed here */
  locked: boolean;
}

export type FieldValues = Record<string, string | boolean>;

/** The document's form (null if it has no fields) and whether it carries
 *  scripts (see scripts.ts) */
export async function inspectPdf(
  bytes: ArrayBuffer | Uint8Array
): Promise<{ form: FormInfo | null; scripted: boolean }> {
  // (pdf-lib's EncryptedPDFError can't be told apart with instanceof)
  const doc = await PDFDocument.load(bytes, {
    updateMetadata: false,
    ignoreEncryption: true,
  });
  const locked = doc.isEncrypted;
  return { form: readForm(doc, locked), scripted: hasScripts(doc) };
}

function readForm(doc: PDFDocument, locked: boolean): FormInfo | null {
  if (!doc.catalog.getAcroForm()) return null;
  const all = doc.getForm().getFields();
  if (!all.length) return null;
  // Encrypted strings (names, values) can't be read without the key
  if (locked) return { fields: [], other: all.length, locked };

  const pageOf = new Map<string, number>();
  doc.getPages().forEach((p, i) =>
    p.node
      .Annots()
      ?.asArray()
      .forEach((a) => pageOf.set(String(a), i + 1))
  );
  const widgetPage = (field: PDFTextField | PDFCheckBox) => {
    for (const w of field.acroField.getWidgets()) {
      const ref = doc.context.getObjectRef(w.dict);
      const page = ref && pageOf.get(String(ref));
      if (page) return page;
    }
    return 0;
  };
  const tooltip = (field: PDFTextField | PDFCheckBox) => {
    const tu = field.acroField.dict.lookup(PDFName.of('TU'));
    return tu instanceof PDFString || tu instanceof PDFHexString
      ? tu.decodeText().trim()
      : '';
  };

  const fields: FormField[] = [];
  let other = 0;
  for (const f of all) {
    if (!(f instanceof PDFTextField || f instanceof PDFCheckBox)) {
      other++;
      continue;
    }
    const name = f.getName();
    const base = {
      name,
      label: tooltip(f) || name,
      readOnly: f.isReadOnly(),
      page: widgetPage(f),
    };
    fields.push(
      f instanceof PDFTextField
        ? {
            ...base,
            kind: 'text',
            value: f.getText() ?? '',
            multiline: f.isMultiline(),
            maxLength: f.getMaxLength(),
          }
        : { ...base, kind: 'checkbox', value: f.isChecked(), multiline: false }
    );
  }
  return { fields, other, locked };
}

/** Sets text fields (strings) and checkboxes (booleans) by name. Read-only
 *  fields, unknown fields and encrypted documents are refused. */
export async function setFieldValues(
  bytes: ArrayBuffer | Uint8Array,
  values: FieldValues
): Promise<ArrayBuffer> {
  try {
    return await fill(bytes, values, true);
  } catch (err) {
    // The font pdf-lib draws fields with only has Latin letters: text in
    // other scripts (Cyrillic, Greek, Chinese, Hindi...) can't be drawn
    // here. The value is stored without a drawing instead, and viewers are
    // asked to draw it themselves, as Acrobat, browsers and Paperwing do.
    if (!/cannot encode/i.test(String((err as Error)?.message))) throw err;
    return fill(bytes, values, false);
  }
}

async function fill(
  bytes: ArrayBuffer | Uint8Array,
  values: FieldValues,
  draw: boolean
): Promise<ArrayBuffer> {
  const doc = await PDFDocument.load(bytes, {
    updateMetadata: false,
    ignoreEncryption: true,
  });
  if (doc.isEncrypted)
    throw new Error("this document is protected, so its form can't be changed");
  const form = doc.getForm();
  const autoSized: PDFTextField[] = [];
  for (const [name, value] of Object.entries(values)) {
    const field = form.getFieldMaybe(name);
    if (!field) throw new Error(`there's no field named ${name}`);
    if (field.isReadOnly()) throw new Error(`${name} is read-only`);
    if (field instanceof PDFTextField && typeof value === 'string') {
      field.setText(value);
      if (field.isMultiline()) autoSized.push(field);
    } else if (field instanceof PDFCheckBox && typeof value === 'boolean') {
      if (value) field.check();
      else field.uncheck();
    } else {
      throw new Error(`${name} can't take that value`);
    }
  }
  if (draw && autoSized.length) {
    const font = form.getDefaultFont();
    autoSized.forEach((f) => drawAutoSized(f, font));
  }
  if (!draw) {
    // Without this, the field's drawing of its old value would still show
    for (const name of Object.keys(values)) {
      const field = form.getField(name);
      if (field instanceof PDFTextField)
        field.acroField
          .getWidgets()
          .forEach((w) => w.dict.delete(PDFName.of('AP')));
    }
    form.acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True);
  }
  // Appearances are redrawn for the changed fields, so the page shows them
  const out = await doc.save({ updateFieldAppearances: draw });
  return out.buffer.slice(
    out.byteOffset,
    out.byteOffset + out.byteLength
  ) as ArrayBuffer;
}

const TF = /(\/[^\0\t\n\f\r ]+[\0\t\n\f\r ]+)(\d*\.\d+|\d+)([\0\t\n\f\r ]+Tf)/g;
const lastTf = (da?: string) => [...(da ?? '').matchAll(TF)].pop();

/** pdf-lib draws "auto" (0 Tf) multiline text as large as it thinks fits,
 *  misjudges the wrapping so lines get cut off, and writes that size into
 *  the field. Such fields are drawn at up to 12pt instead, shrinking until
 *  every line fits, and stay auto-sized for other viewers. */
function drawAutoSized(field: PDFTextField, font: PDFFont) {
  const widgets = field.acroField.getWidgets();
  const holders = [...widgets, field.acroField];
  const own = holders.map((h) => h.getDefaultAppearance());
  const fieldTf = lastTf(own[own.length - 1]);
  const auto = widgets.every(
    (_, i) => Number((lastTf(own[i]) ?? fieldTf)?.[2]) === 0
  );
  if (!widgets.length || !auto) return;

  const text = field.getText() ?? '';
  let size = 12;
  for (const w of widgets) {
    const rect = w.getRectangle();
    const turned =
      (((w.getAppearanceCharacteristics()?.getRotation() ?? 0) % 360) + 360) %
        180 ===
      90;
    const pad = (w.getBorderStyle()?.getWidth() ?? 0) + 1;
    const bounds = {
      x: pad,
      y: pad,
      width: (turned ? rect.height : rect.width) - pad * 2,
      height: (turned ? rect.width : rect.height) - pad * 2,
    };
    const fits = (fontSize: number) => {
      const l = layoutMultilineText(text, {
        alignment: field.getAlignment(),
        fontSize,
        font,
        bounds,
      });
      return l.lines.length * l.lineHeight <= bounds.height;
    };
    while (size > 4 && !fits(size)) size--;
  }

  holders.forEach((h, i) => {
    const m = lastTf(own[i]);
    if (m?.index === undefined) return;
    const da = own[i]!;
    h.setDefaultAppearance(
      da.slice(0, m.index) +
        m[1] +
        size +
        m[3] +
        da.slice(m.index + m[0].length)
    );
  });
  field.updateAppearances(font);
  holders.forEach((h, i) => {
    if (own[i] === undefined) h.dict.delete(PDFName.of('DA'));
    else h.setDefaultAppearance(own[i]!);
  });
}
