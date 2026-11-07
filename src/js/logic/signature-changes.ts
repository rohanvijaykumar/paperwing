/**
 * What changed in a PDF after a signature: the revisions added after the
 * one the signature covers, compared object by object (as Acrobat and
 * pyHanko do). Adding signatures, document timestamps and the certificate
 * checks for long-term validation (DSS) is how a document gets signed by
 * several people, and leaves every earlier signature valid; anything else
 * (page content, comments, form values, pages) is a change after signing.
 * A signature that locked the document allows no further signatures.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFStream,
} from 'pdf-lib';

export type LaterChangeKind = 'none' | 'signing' | 'other';

export interface LaterChanges {
  /** none: nothing after this signature changed anything; signing: only
   *  signatures, timestamps and certificate checks were added; other: the
   *  document itself changed */
  kind: LaterChangeKind;
  /** What changed, in plain words (kind "other") */
  details: string[];
}

const LOAD = {
  ignoreEncryption: true,
  updateMetadata: false,
  throwOnInvalidObject: false,
} as const;

/** Catalog entries that signing (and long-term validation) adds or changes */
const SIGNING_CATALOG_KEYS = new Set([
  'AcroForm',
  'DSS',
  'Metadata',
  'Extensions',
  'Version',
]);
const SIGNING_ACROFORM_KEYS = new Set([
  'Fields',
  'SigFlags',
  'DR',
  'DA',
  'NeedAppearances',
]);
const MARKUP = new Set([
  'Text',
  'FreeText',
  'Line',
  'Square',
  'Circle',
  'Polygon',
  'PolyLine',
  'Highlight',
  'Underline',
  'Squiggly',
  'StrikeOut',
  'Stamp',
  'Caret',
  'Ink',
  'Popup',
  'FileAttachment',
  'Sound',
  'Redact',
]);

const name = (d: PDFDict, key: string) => {
  const v = d.get(PDFName.of(key));
  return v instanceof PDFName ? v.decodeText() : undefined;
};

function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameObject(a: PDFObject, b: PDFObject): boolean {
  if (a instanceof PDFStream || b instanceof PDFStream) {
    if (!(a instanceof PDFStream && b instanceof PDFStream)) return false;
    if (a.dict.toString() !== b.dict.toString()) return false;
    try {
      return sameBytes(a.getContents(), b.getContents());
    } catch {
      return false;
    }
  }
  return a.toString() === b.toString();
}

function dictOf(o: PDFObject | undefined): PDFDict | undefined {
  if (o instanceof PDFStream) return o.dict;
  return o instanceof PDFDict ? o : undefined;
}

/** Keys whose values differ, other than `allowed` */
function changedKeys(
  before: PDFDict,
  after: PDFDict,
  allowed: Set<string>
): string[] {
  const keys = new Set(
    [...before.keys(), ...after.keys()].map((k) => k.decodeText())
  );
  return [...keys].filter((k) => {
    if (allowed.has(k)) return false;
    const a = before.get(PDFName.of(k));
    const b = after.get(PDFName.of(k));
    return !a || !b || a.toString() !== b.toString();
  });
}

/** A signature field (or its widget), merged or not */
function isSignatureField(d: PDFDict | undefined): boolean {
  for (let i = 0; d && i < 10; i++) {
    if (name(d, 'FT') === 'Sig') return true;
    d = d.lookup(PDFName.of('Parent')) as PDFDict | undefined;
    if (!(d instanceof PDFDict)) return false;
  }
  return false;
}

/** A signature field holding a document timestamp (allowed even after a
 *  signature that locked the document, as long-term validation needs) */
function isTimestampField(d: PDFDict | undefined): boolean {
  const v = d?.lookup(PDFName.of('V'));
  return v instanceof PDFDict && name(v, 'Type') === 'DocTimeStamp';
}

function refsIn(arr: PDFObject | undefined): string[] {
  return arr instanceof PDFArray ? arr.asArray().map((o) => o.toString()) : [];
}

/** The /P of a lock or DocMDP/FieldMDP transform: 1 means no changes */
function permission(d: PDFDict | undefined): number | undefined {
  const p = d?.lookup(PDFName.of('P'));
  return p instanceof PDFNumber ? p.asNumber() : undefined;
}

/** Did the signature with this byte range lock the document (Lock
 *  document after signing, or a "no changes" certification)? */
function lockedBy(doc: PDFDocument, byteRange: number[]): boolean {
  const target = `[ ${byteRange.join(' ')} ]`;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const field = dictOf(obj);
    if (!field || name(field, 'FT') !== 'Sig') continue;
    const v = field.lookup(PDFName.of('V'));
    if (!(v instanceof PDFDict)) continue;
    const range = v.lookup(PDFName.of('ByteRange'));
    if (!(range instanceof PDFArray)) continue;
    const nums = range.asArray().map((n) => (n as PDFNumber).asNumber?.());
    if (`[ ${nums.join(' ')} ]` !== target) continue;
    const lock = field.lookup(PDFName.of('Lock'));
    if (lock instanceof PDFDict && permission(lock) === 1) return true;
    const refs = v.lookup(PDFName.of('Reference'));
    if (refs instanceof PDFArray)
      for (const r of refs.asArray()) {
        const ref = (r instanceof PDFRef ? doc.context.lookup(r) : r) as
          | PDFDict
          | undefined;
        const params = ref?.lookup?.(PDFName.of('TransformParams'));
        if (params instanceof PDFDict && permission(params) === 1) return true;
      }
  }
  return false;
}

/**
 * What changed after the revision that ends at `revisionEnd` (the end of
 * the signature's byte range). `byteRange` finds the signature, to know
 * whether it locked the document.
 */
export async function laterChanges(
  pdf: Uint8Array,
  byteRange: number[]
): Promise<LaterChanges> {
  const revisionEnd = byteRange[2] + byteRange[3];
  if (revisionEnd >= pdf.length) return { kind: 'none', details: [] };
  let before: PDFDocument;
  let after: PDFDocument;
  try {
    before = await PDFDocument.load(pdf.slice(0, revisionEnd), LOAD);
    after = await PDFDocument.load(pdf, LOAD);
  } catch {
    return {
      kind: 'other',
      details: ['the document was changed in a way Paperwing can’t compare'],
    };
  }
  const details = new Set<string>();
  let signing = false;
  const locked = lockedBy(before, byteRange);
  const signingAdded = () => {
    if (locked)
      details.add(
        'a signature was added, although this signature locked the document'
      );
    else signing = true;
  };

  const oldPages = before.getPages().map((p) => p.ref.toString());
  const newPages = after.getPages().map((p) => p.ref.toString());
  if (
    oldPages.length !== newPages.length ||
    oldPages.some((r, i) => r !== newPages[i])
  )
    details.add('pages were added, removed or moved');
  const pageNumber = new Map(newPages.map((r, i) => [r, i + 1]));
  const contentsOf = new Map<string, number>();
  after.getPages().forEach((p, i) => {
    const c = p.node.get(PDFName.of('Contents'));
    for (const r of c instanceof PDFArray ? c.asArray() : [c])
      if (r instanceof PDFRef) contentsOf.set(r.toString(), i + 1);
  });
  const catalogRef = after.context.trailerInfo.Root?.toString();
  const infoRef = after.context.trailerInfo.Info?.toString();
  const acroForm = after.catalog.get(PDFName.of('AcroForm'));
  const acroRef = acroForm instanceof PDFRef ? acroForm.toString() : undefined;
  const metadata = after.catalog.get(PDFName.of('Metadata'));
  const metaRef = metadata instanceof PDFRef ? metadata.toString() : undefined;

  /** New entries in a list of annotations or fields: signature widgets
   *  are signing, anything else a change */
  const listChange = (oldList: string[], newList: string[], where: string) => {
    if (oldList.some((r) => !newList.includes(r)))
      details.add(`${where}: something was removed`);
    for (const r of newList) {
      if (oldList.includes(r)) continue;
      const d = dictOf(after.context.lookup(PDFRef.of(...refParts(r))));
      if (isTimestampField(d)) signing = true;
      else if (isSignatureField(d)) signingAdded();
      else
        details.add(
          d && MARKUP.has(name(d, 'Subtype') ?? '')
            ? `${where}: a comment or mark was added`
            : `${where}: something was added`
        );
    }
  };

  for (const [ref, obj] of after.context.enumerateIndirectObjects()) {
    const key = ref.toString();
    const old = before.context.lookup(ref);
    if (old && sameObject(old, obj)) continue;
    const d = dictOf(obj);
    const type = d && name(d, 'Type');
    if (type === 'XRef' || type === 'ObjStm') continue;
    if (!old) {
      // New objects matter where something existing points to them (a
      // page, the catalog), which is checked below; these say what they are
      if (type === 'DocTimeStamp' || isTimestampField(d)) signing = true;
      else if (type === 'Sig' || isSignatureField(d)) signingAdded();
      continue;
    }
    if (key === infoRef || key === metaRef) continue;
    const oldDict = dictOf(old);
    if (key === catalogRef && oldDict && d) {
      if (changedKeys(oldDict, d, SIGNING_CATALOG_KEYS).length)
        details.add('the document’s settings were changed');
      const fieldsBefore = before.catalog.lookup(PDFName.of('AcroForm'));
      const fieldsAfter = after.catalog.lookup(PDFName.of('AcroForm'));
      if (fieldsAfter instanceof PDFDict && !acroRef)
        listChange(
          fieldsBefore instanceof PDFDict
            ? refsIn(fieldsBefore.lookup(PDFName.of('Fields')))
            : [],
          refsIn(fieldsAfter.lookup(PDFName.of('Fields'))),
          'form fields'
        );
      continue;
    }
    if (key === acroRef && oldDict && d) {
      if (changedKeys(oldDict, d, SIGNING_ACROFORM_KEYS).length)
        details.add('the form’s settings were changed');
      listChange(
        refsIn(oldDict.lookup(PDFName.of('Fields'))),
        refsIn(d.lookup(PDFName.of('Fields'))),
        'form fields'
      );
      continue;
    }
    const page = pageNumber.get(key);
    if (page && oldDict && d) {
      if (changedKeys(oldDict, d, new Set(['Annots'])).length)
        details.add(`page ${page} was changed`);
      listChange(
        refsIn(oldDict.lookup(PDFName.of('Annots'))),
        refsIn(d.lookup(PDFName.of('Annots'))),
        `page ${page}`
      );
      continue;
    }
    if (contentsOf.has(key)) {
      details.add(`the content of page ${contentsOf.get(key)} was changed`);
      continue;
    }
    // A list of annotations or fields kept as its own object
    if (obj instanceof PDFArray && old instanceof PDFArray) {
      const owner = newPages.find((p) => {
        const node = dictOf(after.context.lookup(PDFRef.of(...refParts(p))));
        return node?.get(PDFName.of('Annots'))?.toString() === key;
      });
      listChange(
        refsIn(old),
        refsIn(obj),
        owner ? `page ${pageNumber.get(owner)}` : 'form fields'
      );
      continue;
    }
    // An empty signature field being signed
    if (isSignatureField(d) && oldDict) {
      if (oldDict.get(PDFName.of('V'))) details.add('a signature was changed');
      else if (isTimestampField(d)) signing = true;
      else signingAdded();
      continue;
    }
    if (d && (oldDict?.get(PDFName.of('FT')) || d.get(PDFName.of('FT')))) {
      details.add('form fields were filled in or changed');
      continue;
    }
    if (d && MARKUP.has(name(d, 'Subtype') ?? '')) {
      details.add('a comment or mark was changed');
      continue;
    }
    if (type === 'Pages') continue; // (page order is checked above)
    details.add('other parts of the document were changed');
  }
  if (details.size) return { kind: 'other', details: [...details] };
  return { kind: signing ? 'signing' : 'none', details: [] };
}

function refParts(r: string): [number, number] {
  const [n, g] = r.split(' ').map(Number);
  return [n, g];
}
