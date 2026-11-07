/**
 * Signs a PDF with a digital ID whose key is held elsewhere: the Windows
 * certificate store, the Keychain, a smart card, or a key read from a file.
 * zgapdfsigner prepares the PDF (signature field, appearance, byte range,
 * DSS), patched at build time to take the signature from Paperwing's CMS
 * builder (reskin/signer-patches.ts); the CMS builder has the key's owner
 * sign, adds the timestamp, and the result is a PAdES signature.
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import {
  buildCms,
  certParts,
  sameBytes,
  type Curve,
  type KeyAlg,
  type Signer,
  type SubFilter,
} from './cms';
import { chainForDss } from './ltv';
import { requestTimestamp, type Fetcher } from './tsa';

export interface SignatureAppearance {
  /** 0-based page */
  page: number;
  /** Where on the page, as fractions of its CropBox, unrotated, from the
   *  top left (see userRect) */
  box: { x: number; y: number; width: number; height: number };
  /** The appearance drawn into the box (PNG) */
  png: Uint8Array;
}

export interface SignPdfRequest {
  pdf: Uint8Array;
  certDer: Uint8Array;
  chainDer: Uint8Array[];
  keyAlg: KeyAlg;
  curve?: Curve | null;
  sign: Signer;
  subFilter?: SubFilter;
  reason?: string;
  location?: string;
  contactInfo?: string;
  appearance?: SignatureAppearance;
  /** Lock the document after signing (no further changes allowed) */
  lock?: boolean;
  /** Timestamp server (RFC 3161) */
  tsaUrl?: string;
  /** Gather certificate checks for long-term validation (CA-issued IDs) */
  ltv?: boolean;
  /** For the timestamp and the certificate checks */
  fetcher?: Fetcher;
}

const APP_NAME = 'Paperwing';

const toBytes = (s: string) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

/** Hex digits to reserve for the signature: generous, because running
 *  short means signing a second time (a second PIN prompt) */
export function placeholderSize(
  certs: Uint8Array[],
  timestamped: boolean
): number {
  const bytes =
    certs.reduce((n, c) => n + c.length, 0) + 4096 + (timestamped ? 16384 : 0);
  return bytes * 2;
}

export type Rotation = 0 | 90 | 180 | 270;

/**
 * Where the drawn box lies on the page, in PDF user space [x0, y0, x1, y1]:
 * the box is in fractions of the page's CropBox, unrotated, from its top
 * left (the viewer turns pages for display, /Rotate and the view's own
 * rotation, around a page layer that stays in these coordinates).
 */
export function userRect(
  box: SignatureAppearance['box'],
  crop: { x: number; y: number; width: number; height: number }
): [number, number, number, number] {
  const top = crop.y + crop.height;
  return [
    crop.x + box.x * crop.width,
    top - (box.y + box.height) * crop.height,
    crop.x + (box.x + box.width) * crop.width,
    top - box.y * crop.height,
  ];
}

/** The page's /Rotate, as 0, 90, 180 or 270 */
export async function pageRotation(
  pdf: Uint8Array,
  index: number
): Promise<Rotation> {
  try {
    const doc = await PDFDocument.load(pdf, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    const angle = ((doc.getPage(index).getRotation().angle % 360) + 360) % 360;
    return ((Math.round(angle / 90) * 90) % 360) as Rotation;
  } catch {
    return 0;
  }
}

/**
 * zgapdfsigner's area (x, y, width, height of the page as shown, measured
 * with the MediaBox's size, see its calcAreaInf) that puts the signature
 * field exactly on `rect`
 */
export function zgaArea(
  rect: [number, number, number, number],
  media: { width: number; height: number },
  rot: Rotation
): { x: number; y: number; w: number; h: number } {
  const [x0, y0, x1, y1] = rect;
  const { width: W, height: H } = media;
  switch (rot) {
    case 90:
      return { x: y0, y: x0, w: y1 - y0, h: x1 - x0 };
    case 180:
      return { x: W - x1, y: y0, w: x1 - x0, h: y1 - y0 };
    case 270:
      return { x: H - y1, y: W - x1, w: y1 - y0, h: x1 - x0 };
    default:
      return { x: x0, y: H - y1, w: x1 - x0, h: y1 - y0 };
  }
}

/** The signature box in zgapdfsigner's terms, for the box drawn on the
 *  page (any rotation, crop) */
async function areaOf(
  pdf: Uint8Array,
  appearance: SignatureAppearance
): Promise<{ x: number; y: number; w: number; h: number }> {
  const doc = await PDFDocument.load(pdf, {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  const page = doc.getPage(appearance.page);
  const angle = ((page.getRotation().angle % 360) + 360) % 360;
  const rot = ((Math.round(angle / 90) * 90) % 360) as Rotation;
  return zgaArea(
    userRect(appearance.box, page.getCropBox()),
    page.getMediaBox(),
    rot
  );
}

/** Signs; returns the signed PDF (an incremental update of `pdf`) */
export async function signPdf(req: SignPdfRequest): Promise<Uint8Array> {
  const { PdfSigner } = await import('zgapdfsigner');
  // Built without Paperwing's patch, zgapdfsigner would ignore the key's
  // owner and fail later in a confusing way
  if (
    !String(
      (PdfSigner.prototype as unknown as Record<string, unknown>).signPdf
    ).includes('pwExternal')
  )
    throw new Error(
      'This build of Paperwing can’t sign with installed certificates (zgapdfsigner wasn’t patched).'
    );

  const subFilter = req.subFilter ?? 'ETSI.CAdES.detached';
  const chain = req.chainDer.filter((c) => !sameBytes(c, req.certDer));
  const fetcher = req.fetcher;
  if ((req.tsaUrl || req.ltv) && !fetcher)
    throw new Error('Timestamps and certificate checks need a connection.');
  const selfSigned = (() => {
    const p = certParts(req.certDer);
    return sameBytes(p.issuer, p.subject);
  })();

  let signings = 0;
  const signingTime = new Date();
  const opts: Record<string, unknown> = {
    pwExternal: {
      chain: chainForDss(req.certDer, chain, fetcher ?? failingFetcher),
      sigLen: placeholderSize([req.certDer, ...chain], !!req.tsaUrl),
      subFilter,
      appName: APP_NAME,
      lock: !!req.lock,
      cms: async (covered: string) => {
        signings++;
        return buildCms(toBytes(covered), {
          certDer: req.certDer,
          chainDer: chain,
          keyAlg: req.keyAlg,
          curve: req.curve,
          subFilter,
          signingTime,
          sign: req.sign,
          timestamp: req.tsaUrl
            ? async (sig) =>
                (await requestTimestamp(req.tsaUrl!, sig, fetcher!)).token
            : undefined,
        });
      },
    },
    // Long-term validation: zgapdfsigner writes the DSS from the chain above
    ltv: req.ltv && !selfSigned ? 1 : 0,
  };
  if (req.reason) opts.reason = req.reason;
  if (req.location) opts.location = req.location;
  if (req.contactInfo) opts.contact = req.contactInfo;
  if (req.appearance) {
    opts.drawinf = {
      area: await areaOf(req.pdf, req.appearance),
      pageidx: req.appearance.page,
      imgInfo: { imgData: req.appearance.png, imgType: 'png' },
    };
  }
  const signer = new PdfSigner(opts as never);
  const out = await signer.sign(req.pdf);
  if (signings > 1)
    console.warn('[certs] the signature needed a second try (larger space)');
  return new Uint8Array(out);
}

const failingFetcher: Fetcher = async () => {
  throw new Error('offline');
};

/**
 * Was the document locked by a signature (Lock document after signing, or
 * a certification that allows no changes)? Then it can't be signed again:
 * any change, a new signature too, would invalidate that signature.
 */
export async function lockedBySignature(pdf: Uint8Array): Promise<boolean> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdf, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
  } catch {
    return false;
  }
  const p = (d: unknown) => {
    const v = d instanceof PDFDict ? d.lookup(PDFName.of('P')) : undefined;
    return v instanceof PDFNumber ? v.asNumber() : undefined;
  };
  // Certified with "no changes allowed" (DocMDP P 1)
  const perms = doc.catalog.lookup(PDFName.of('Perms'));
  const certification =
    perms instanceof PDFDict ? perms.lookup(PDFName.of('DocMDP')) : undefined;
  const refs =
    certification instanceof PDFDict
      ? certification.lookup(PDFName.of('Reference'))
      : undefined;
  if (refs instanceof PDFArray)
    for (let i = 0; i < refs.size(); i++) {
      const r = refs.lookup(i);
      if (
        r instanceof PDFDict &&
        p(r.lookup(PDFName.of('TransformParams'))) === 1
      )
        return true;
    }
  // A signed field whose lock allows no changes (P 1)
  for (const field of doc.getForm().getFields()) {
    const dict = field.acroField.dict;
    if (!(dict.lookup(PDFName.of('V')) instanceof PDFDict)) continue;
    if (p(dict.lookup(PDFName.of('Lock'))) === 1) return true;
  }
  return false;
}
