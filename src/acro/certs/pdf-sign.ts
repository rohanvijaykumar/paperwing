/**
 * Signs a PDF with a digital ID whose key is held elsewhere: the Windows
 * certificate store, the Keychain, a smart card, or a key read from a file.
 * zgapdfsigner prepares the PDF (signature field, appearance, byte range,
 * DSS), patched at build time to take the signature from Paperwing's CMS
 * builder (reskin/signer-patches.ts); the CMS builder has the key's owner
 * sign, adds the timestamp, and the result is a PAdES signature.
 */
import { PDFDocument } from 'pdf-lib';
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
  /** Where on the page, as fractions of the page as it's shown (its
   *  /Rotate applied), from the top left */
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

/** The signature box in zgapdfsigner's terms: points from the top left of
 *  the page as shown (its MediaBox, rotated), from the box as a fraction of
 *  the visible page (its CropBox) */
async function areaOf(
  pdf: Uint8Array,
  appearance: SignatureAppearance
): Promise<{ x: number; y: number; w: number; h: number }> {
  const doc = await PDFDocument.load(pdf, {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  const page = doc.getPage(appearance.page);
  const rot = (((page.getRotation().angle % 360) + 360) % 360) as
    | 0
    | 90
    | 180
    | 270;
  const media = page.getMediaBox();
  const crop = page.getCropBox();
  const turned = rot === 90 || rot === 270;
  // The visible page as shown
  const shownW = turned ? crop.height : crop.width;
  const shownH = turned ? crop.width : crop.height;
  const { x, y, width, height } = appearance.box;
  let area = {
    x: x * shownW,
    y: y * shownH,
    w: width * shownW,
    h: height * shownH,
  };
  // From the CropBox's corner to the MediaBox's (zgapdfsigner measures
  // from the MediaBox); upright pages, the usual case for a crop
  if (rot === 0)
    area = {
      ...area,
      x: area.x + (crop.x - media.x),
      y: area.y + (media.y + media.height - (crop.y + crop.height)),
    };
  return area;
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
