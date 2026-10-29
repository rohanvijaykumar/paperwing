/**
 * Does a PDF carry instructions meant to run on their own: document
 * JavaScript, an action when it opens, or additional actions (on a page,
 * an annotation or a form field)? Paperwing never runs any of them; the
 * workspace just says so. Only the PDF's structure is read here.
 */
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFRef,
  type PDFDocument,
  type PDFObject,
} from 'pdf-lib';

const N = (name: string) => PDFName.of(name);

export function hasScripts(doc: PDFDocument): boolean {
  const ctx = doc.context;
  const resolve = (o: PDFObject | undefined) =>
    o instanceof PDFRef ? ctx.lookup(o) : o;
  const dict = (o: PDFObject | undefined) => {
    const v = resolve(o);
    return v instanceof PDFDict ? v : undefined;
  };
  const array = (o: PDFObject | undefined) => {
    const v = resolve(o);
    return v instanceof PDFArray ? v : undefined;
  };
  /** Additional actions: a non-empty /AA dictionary */
  const hasAA = (d: PDFDict | undefined) =>
    !!dict(d?.get(N('AA')))?.keys().length;

  /** An action (and the ones chained after it with /Next) that `runs`
   *  matches */
  const action = (
    o: PDFObject | undefined,
    runs: (type: string) => boolean,
    seen = new Set<PDFObject>()
  ): boolean => {
    const a = dict(o);
    if (!a || seen.has(a)) return false;
    seen.add(a);
    const type = a.get(N('S'));
    if (type instanceof PDFName && runs(type.decodeText())) return true;
    const next = resolve(a.get(N('Next')));
    if (next instanceof PDFArray)
      return next.asArray().some((n) => action(n, runs, seen));
    return action(next, runs, seen);
  };

  const catalog = doc.catalog;
  if (dict(dict(catalog.get(N('Names')))?.get(N('JavaScript')))) return true;
  // Opening at a page (a destination or a GoTo action) is not an instruction
  if (action(catalog.get(N('OpenAction')), (t) => t !== 'GoTo')) return true;
  if (hasAA(catalog)) return true;

  const isScript = (t: string) => t === 'JavaScript';
  for (const page of doc.getPages()) {
    if (hasAA(page.node)) return true;
    for (const a of array(page.node.get(N('Annots')))?.asArray() ?? []) {
      const annot = dict(a);
      if (hasAA(annot) || action(annot?.get(N('A')), isScript)) return true;
    }
  }

  // Form fields that aren't also widgets keep their actions on the field
  const seen = new Set<PDFDict>();
  const fields = (list: PDFArray | undefined, depth = 0): boolean =>
    depth < 32 &&
    (list?.asArray() ?? []).some((f) => {
      const field = dict(f);
      if (!field || seen.has(field)) return false;
      seen.add(field);
      return hasAA(field) || fields(array(field.get(N('Kids'))), depth + 1);
    });
  return fields(array(dict(catalog.get(N('AcroForm')))?.get(N('Fields'))));
}
