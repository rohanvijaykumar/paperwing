/**
 * What pdf-lib reads from a document's form, beside what PDFium shows of it
 * (form-model.ts): the fields' tooltips, character limits, the size their
 * text is drawn at, and what each radio button is called. Filling in is
 * PDFium's (Viewer.setFormValue); here only fields that scripts show
 * formatted get their typed values back when saved (unformat).
 */
import {
  PDFButton,
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFField,
  PDFHexString,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFSignature,
  PDFString,
  PDFTextField,
} from 'pdf-lib';
import { hasScripts } from './scripts';

export interface FieldMeta {
  /** Fully qualified field name */
  name: string;
  /** Its tooltip (/TU) if it has one, else its name */
  label: string;
  kind:
    | 'text'
    | 'checkbox'
    | 'radio'
    | 'dropdown'
    | 'list'
    | 'button'
    | 'signature';
  readOnly: boolean;
  maxLength?: number;
  /** The size its text is drawn at (points; 0 sizes it to fit) */
  fontSize?: number;
  /** A radio group's buttons: where each is (PDF points from the page's
   *  top left, as PDFium places widgets) and what it's called */
  choices?: { page: number; x: number; y: number; value: string }[];
}

export interface FormInfo {
  fields: FieldMeta[];
  /** Encrypted: pdf-lib can't read its fields (PDFium still can) */
  locked: boolean;
}

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

const kindOf = (f: PDFField): FieldMeta['kind'] =>
  f instanceof PDFTextField
    ? 'text'
    : f instanceof PDFCheckBox
      ? 'checkbox'
      : f instanceof PDFRadioGroup
        ? 'radio'
        : f instanceof PDFDropdown
          ? 'dropdown'
          : f instanceof PDFOptionList
            ? 'list'
            : f instanceof PDFSignature
              ? 'signature'
              : f instanceof PDFButton
                ? 'button'
                : 'text';

const TF = /(\/[^\0\t\n\f\r ]+[\0\t\n\f\r ]+)(\d*\.\d+|\d+)([\0\t\n\f\r ]+Tf)/g;
/** The font size in a default appearance (/DA) string */
const sizeIn = (da?: string) => {
  const m = [...(da ?? '').matchAll(TF)].pop();
  return m ? Number(m[2]) : undefined;
};

function readForm(doc: PDFDocument, locked: boolean): FormInfo | null {
  if (!doc.catalog.getAcroForm()) return null;
  const all = doc.getForm().getFields();
  if (!all.length) return null;
  // Encrypted strings (names, values) can't be read without the key
  if (locked) return { fields: [], locked };

  const pages = doc.getPages();
  const pageOf = new Map<string, number>();
  pages.forEach((p, i) =>
    p.node
      .Annots()
      ?.asArray()
      .forEach((a) => pageOf.set(String(a), i))
  );
  const tooltip = (f: PDFField) => {
    const tu = f.acroField.dict.lookup(PDFName.of('TU'));
    return tu instanceof PDFString || tu instanceof PDFHexString
      ? tu.decodeText().trim()
      : '';
  };

  return {
    locked,
    fields: all.map((f) => {
      const kind = kindOf(f);
      const meta: FieldMeta = {
        name: f.getName(),
        label: tooltip(f) || f.getName(),
        kind,
        readOnly: f.isReadOnly(),
      };
      if (f instanceof PDFTextField) {
        meta.maxLength = f.getMaxLength();
        const widgets = f.acroField.getWidgets();
        meta.fontSize =
          sizeIn(widgets[0]?.getDefaultAppearance()) ??
          sizeIn(f.acroField.getDefaultAppearance());
      }
      if (f instanceof PDFRadioGroup) {
        meta.choices = [];
        // Each button's name, in widget order (from the field's /Opt when
        // it has one: the buttons' own "on" names are then just indexes)
        const names = f.getOptions();
        for (const [i, w] of f.acroField.getWidgets().entries()) {
          const ref = doc.context.getObjectRef(w.dict);
          const page = ref ? pageOf.get(String(ref)) : undefined;
          const value = names[i] ?? w.getOnValue()?.decodeText();
          if (page === undefined || !value) continue;
          // PDFium places widgets from the top left of the page's visible
          // area (its crop box), in points
          const crop = pages[page].getCropBox();
          const r = w.getRectangle();
          meta.choices.push({
            page,
            x: r.x - crop.x,
            y: crop.y + crop.height - (r.y + r.height),
            value,
          });
        }
      }
      return meta;
    }),
  };
}

/**
 * The document as it should be saved: fields its scripts show formatted
 * keep their values as typed ("1234.5"), drawn as shown ("$1,234.50"), as
 * Acrobat saves them. (PDFium holds the formatted text, as that's what it
 * draws; form-scripts.ts) Unchanged if no field is formatted.
 */
export async function unformat(
  bytes: ArrayBuffer,
  raws: ReadonlyMap<string, string>
): Promise<ArrayBuffer> {
  if (!raws.size) return bytes;
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch {
    // (encrypted: pdf-lib can't write it; the shown text is kept)
    return bytes;
  }
  const form = doc.getForm();
  let changed = false;
  for (const [name, raw] of raws) {
    const field = form.getFieldMaybe(name);
    if (!(field instanceof PDFTextField)) continue;
    field.acroField.dict.set(PDFName.of('V'), PDFHexString.fromText(raw));
    changed = true;
  }
  if (!changed) return bytes;
  const out = await doc.save({ updateFieldAppearances: false });
  return out.buffer.slice(
    out.byteOffset,
    out.byteOffset + out.byteLength
  ) as ArrayBuffer;
}
