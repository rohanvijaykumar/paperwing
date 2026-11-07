/**
 * Timestamps in signed PDFs (RFC 3161), checked the way Acrobat shows them:
 *
 *  - a signature's own timestamp (an unsigned attribute of its CMS): a
 *    timestamp server signed the time together with a digest of the
 *    signature value, which proves the signature existed then;
 *  - document timestamps (/Type /DocTimeStamp): the server signed a digest
 *    of the document's bytes, which proves the document existed then.
 *
 * Each is valid when the server's signature over the time verifies and the
 * digest it stamped is the one of what it claims to cover.
 */
import * as pkijs from 'pkijs';

const SIGNATURE_TIMESTAMP = '1.2.840.113549.1.9.16.2.14';
const TST_INFO = '1.2.840.113549.1.9.16.1.4';
const HASHES: Record<string, string> = {
  '1.3.14.3.2.26': 'SHA-1',
  '2.16.840.1.101.3.4.2.1': 'SHA-256',
  '2.16.840.1.101.3.4.2.2': 'SHA-384',
  '2.16.840.1.101.3.4.2.3': 'SHA-512',
};

export interface TimestampCheck {
  /** When the timestamp server says it stamped */
  time: Date;
  /** The timestamp server's name (its certificate's common name) */
  authority: string;
  /** The server's signature verifies and it stamped the right digest */
  valid: boolean;
  /** Why not, when it isn't */
  problem?: string;
  /** The server's certificate and the others in the token (DER) */
  certificates: Uint8Array[];
}

function commonName(cert: pkijs.Certificate | undefined): string {
  const tv = cert?.subject.typesAndValues;
  const cn =
    tv?.find((t) => t.type === '2.5.4.3') ??
    tv?.find((t) => t.type === '2.5.4.10');
  return cn ? String(cn.value.valueBlock.value) : 'Unknown';
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** Checks a TimeStampToken over `data` (the bytes whose digest it stamped) */
export async function checkTimestampToken(
  token: Uint8Array,
  data: Uint8Array
): Promise<TimestampCheck | null> {
  let signed: pkijs.SignedData;
  let tst: pkijs.TSTInfo;
  try {
    const info = pkijs.ContentInfo.fromBER(token.slice());
    signed = new pkijs.SignedData({ schema: info.content });
    if (signed.encapContentInfo.eContentType !== TST_INFO) return null;
    const content = signed.encapContentInfo.eContent;
    if (!content) return null;
    tst = pkijs.TSTInfo.fromBER(new Uint8Array(content.getValue()).slice());
  } catch {
    return null;
  }
  const certs = (signed.certificates ?? []).filter(
    (c): c is pkijs.Certificate => c instanceof pkijs.Certificate
  );
  const sid = signed.signerInfos[0]?.sid;
  const signer =
    sid instanceof pkijs.IssuerAndSerialNumber
      ? certs.find(
          (c) =>
            c.serialNumber.isEqual(sid.serialNumber) &&
            c.issuer.isEqual(sid.issuer)
        )
      : certs[0];
  const result: TimestampCheck = {
    time: tst.genTime,
    authority: commonName(signer ?? certs[0]),
    valid: false,
    certificates: certs.map((c) => new Uint8Array(c.toSchema().toBER(false))),
  };
  const hash = HASHES[tst.messageImprint.hashAlgorithm.algorithmId];
  if (!hash) {
    result.problem = 'It uses a digest Paperwing doesn’t know.';
    return result;
  }
  const digest = new Uint8Array(await crypto.subtle.digest(hash, data.slice()));
  const stamped = new Uint8Array(
    tst.messageImprint.hashedMessage.valueBlock.valueHexView
  );
  if (!sameBytes(digest, stamped)) {
    result.problem =
      'It was made for something else: what it covers was changed.';
    return result;
  }
  try {
    // (for a timestamp, pkijs checks the stamped digest against `data` too)
    const ok = await signed.verify({
      signer: 0,
      checkChain: false,
      data: data.slice().buffer,
    });
    if (!ok) {
      result.problem = 'The timestamp server’s signature doesn’t verify.';
      return result;
    }
  } catch {
    result.problem = 'The timestamp server’s signature can’t be checked.';
    return result;
  }
  result.valid = true;
  return result;
}

/** The timestamp in a signature's CMS, checked against its signature
 *  value; null when it has none */
export async function signatureTimestamp(
  cms: Uint8Array
): Promise<TimestampCheck | null> {
  let signerInfo: pkijs.SignerInfo | undefined;
  try {
    const info = pkijs.ContentInfo.fromBER(cms.slice());
    signerInfo = new pkijs.SignedData({ schema: info.content }).signerInfos[0];
  } catch {
    return null;
  }
  const attr = signerInfo?.unsignedAttrs?.attributes.find(
    (a) => a.type === SIGNATURE_TIMESTAMP
  );
  const token = attr?.values[0];
  if (!signerInfo || !token) return null;
  return checkTimestampToken(
    new Uint8Array(token.toBER(false)),
    new Uint8Array(signerInfo.signature.valueBlock.valueHexView)
  );
}

/** The bytes a byte range covers */
export function coveredBytes(pdf: Uint8Array, range: number[]): Uint8Array {
  const [a, b, c, d] = range;
  const out = new Uint8Array(b + d);
  out.set(pdf.subarray(a, a + b), 0);
  out.set(pdf.subarray(c, c + d), b);
  return out;
}
