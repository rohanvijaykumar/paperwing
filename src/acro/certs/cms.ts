/**
 * The signature inside a signed PDF: a CMS SignedData (RFC 5652) built to
 * PAdES (ETSI EN 319 142-1), the profile Acrobat and the EU's validators
 * expect. The private key is never here: `sign` is handed the bytes to sign
 * and their digest, and whoever holds the key (Windows, the Keychain, a smart
 * card, or a key read from a file) returns the signature.
 *
 *  - Signed attributes: contentType (id-data), messageDigest, and the ESS
 *    signingCertificateV2 that binds the signer's certificate. No
 *    signingTime with ETSI.CAdES.detached (the time is the PDF's /M, or the
 *    timestamp); adbe.pkcs7.detached carries one, as older readers expect.
 *  - Their DER SET OF (tag 0x31, members in DER order) is what's signed.
 *  - RSA: PKCS#1 v1.5 (sha256WithRSAEncryption). ECDSA: P-256 with SHA-256,
 *    P-384 and P-521 with SHA-384, the signature DER-encoded (the format
 *    that ECDSA ID cards trip other apps up on: never r||s here).
 *  - An RFC 3161 timestamp over the signature value, as an unsigned
 *    attribute, when a timestamp server is chosen.
 */
import * as asn1js from 'asn1js';

export const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  timeStampToken: '1.2.840.113549.1.9.16.2.14',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  rsaEncryption: '1.2.840.113549.1.1.1',
  sha256WithRSA: '1.2.840.113549.1.1.11',
  sha384WithRSA: '1.2.840.113549.1.1.12',
  ecPublicKey: '1.2.840.10045.2.1',
  ecdsaWithSHA256: '1.2.840.10045.4.3.2',
  ecdsaWithSHA384: '1.2.840.10045.4.3.3',
} as const;

export type HashName = 'sha256' | 'sha384';
export type KeyAlg = 'rsa' | 'ec';
export type Curve = 'P-256' | 'P-384' | 'P-521';
export type SubFilter = 'ETSI.CAdES.detached' | 'adbe.pkcs7.detached';

export interface SignRequest {
  /** The DER SET OF signed attributes: what a signer given data signs */
  data: Uint8Array;
  /** Its digest: what a signer given a digest (Windows, Keychain) signs */
  digest: Uint8Array;
  hash: HashName;
}

/** Returns the signature: RSA PKCS#1 v1.5, or ECDSA DER-encoded */
export type Signer = (req: SignRequest) => Promise<Uint8Array>;

/** Returns a TimeStampToken (a CMS ContentInfo, DER) over these bytes */
export type Timestamper = (signatureValue: Uint8Array) => Promise<Uint8Array>;

export interface CmsOptions {
  /** The signer's certificate, DER */
  certDer: Uint8Array;
  /** Its issuers (not repeating it), DER */
  chainDer?: Uint8Array[];
  keyAlg: KeyAlg;
  curve?: Curve | null;
  subFilter: SubFilter;
  /** adbe.pkcs7.detached only */
  signingTime?: Date;
  sign: Signer;
  timestamp?: Timestamper;
}

/** The digest each kind of key signs with */
export function hashFor(keyAlg: KeyAlg, curve?: Curve | null): HashName {
  return keyAlg === 'ec' && (curve === 'P-384' || curve === 'P-521')
    ? 'sha384'
    : 'sha256';
}

export async function digest(
  hash: HashName,
  data: Uint8Array | Uint8Array[]
): Promise<Uint8Array> {
  const parts = Array.isArray(data) ? data : [data];
  const whole = parts.length === 1 ? parts[0] : concat(...parts.map((p) => p));
  return new Uint8Array(
    await crypto.subtle.digest(
      hash === 'sha384' ? 'SHA-384' : 'SHA-256',
      whole as Uint8Array<ArrayBuffer>
    )
  );
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// Constructed values are put together from their members' bytes, so
// certificates, names and the signed attributes go in exactly as they are
// (re-encoding a certificate could change it and break its signature).
// asn1js encodes the primitive values.
const ber = (block: { toBER(): ArrayBuffer }) => new Uint8Array(block.toBER());
const oid = (value: string) => ber(new asn1js.ObjectIdentifier({ value }));
const int = (value: number) => ber(new asn1js.Integer({ value }));
const octets = (bytes: Uint8Array) =>
  ber(new asn1js.OctetString({ valueHex: bytes.slice().buffer }));
const NULL = () => ber(new asn1js.Null());

/** Tag, DER length, then the members' bytes */
function tlv(tag: number, ...members: Uint8Array[]): Uint8Array {
  return concat(new Uint8Array([tag]), derLength(members), ...members);
}
const seq = (...members: Uint8Array[]) => tlv(0x30, ...members);

function algorithm(id: string, nullParams = false) {
  return nullParams ? seq(oid(id), NULL()) : seq(oid(id));
}

/** The parts of a certificate the signature refers to, as their exact bytes */
export interface CertParts {
  issuer: Uint8Array;
  subject: Uint8Array;
  serial: Uint8Array;
  spki: Uint8Array;
}

export function certParts(der: Uint8Array): CertParts {
  const parsed = asn1js.fromBER(der as Uint8Array<ArrayBuffer>);
  if (parsed.offset === -1) throw new Error('Not a certificate');
  const tbs = (parsed.result as asn1js.Sequence).valueBlock.value[0] as
    | asn1js.Sequence
    | undefined;
  const fields = tbs?.valueBlock?.value;
  if (!fields) throw new Error('Not a certificate');
  // [0] version is optional (v1 certificates leave it out)
  const i = fields[0].idBlock.tagClass === 3 ? 1 : 0;
  const bytes = (b: asn1js.AsnType) =>
    new Uint8Array((b as asn1js.BaseBlock).valueBeforeDecodeView);
  if (fields.length < i + 6) throw new Error('Not a certificate');
  return {
    serial: bytes(fields[i]),
    issuer: bytes(fields[i + 2]),
    subject: bytes(fields[i + 4]),
    spki: bytes(fields[i + 5]),
  };
}

/** Byte order DER requires for the members of a SET OF (X.690 11.6) */
export function derOrder(a: Uint8Array, b: Uint8Array): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function attribute(type: string, value: Uint8Array) {
  return seq(oid(type), tlv(0x31, value));
}

/** ESS signingCertificateV2 (RFC 5035): SHA-256 of the certificate (the
 *  default algorithm, so not written) and its issuer and serial number */
async function signingCertificateV2(certDer: Uint8Array, parts: CertParts) {
  const certHash = await digest('sha256', certDer);
  // IssuerSerial: GeneralNames { directoryName [4] EXPLICIT Name }, serial
  const issuerSerial = seq(seq(tlv(0xa4, parts.issuer)), parts.serial);
  const essCertIdV2 = seq(octets(certHash), issuerSerial);
  return attribute(OID.signingCertificateV2, seq(seq(essCertIdV2)));
}

/** The signed attributes, each DER-encoded, in DER order */
export async function signedAttributes(
  contentDigest: Uint8Array,
  opts: Pick<CmsOptions, 'certDer' | 'subFilter' | 'signingTime'>,
  parts = certParts(opts.certDer)
): Promise<Uint8Array[]> {
  const attrs = [
    attribute(OID.contentType, oid(OID.data)),
    attribute(OID.messageDigest, octets(contentDigest)),
    await signingCertificateV2(opts.certDer, parts),
  ];
  if (opts.subFilter === 'adbe.pkcs7.detached')
    attrs.push(
      attribute(
        OID.signingTime,
        ber(new asn1js.UTCTime({ valueDate: opts.signingTime ?? new Date() }))
      )
    );
  return attrs.sort(derOrder);
}

/** A SET (or [n] IMPLICIT SET) of already-encoded members */
function setOf(members: Uint8Array[], tag = 0x31): Uint8Array {
  return concat(new Uint8Array([tag]), derLength(members), ...members);
}

function derLength(members: Uint8Array[]): Uint8Array {
  const n = members.reduce((s, m) => s + m.length, 0);
  if (n < 0x80) return new Uint8Array([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function signatureAlgorithm(keyAlg: KeyAlg, hash: HashName) {
  if (keyAlg === 'ec')
    return algorithm(
      hash === 'sha384' ? OID.ecdsaWithSHA384 : OID.ecdsaWithSHA256
    );
  return algorithm(
    hash === 'sha384' ? OID.sha384WithRSA : OID.sha256WithRSA,
    true
  );
}

/**
 * Builds the CMS for the bytes a PDF signature covers (`content`, or its
 * digest when that's already known). Returns its DER encoding.
 */
export async function buildCms(
  content: Uint8Array | { digest: Uint8Array },
  opts: CmsOptions
): Promise<Uint8Array> {
  const hash = hashFor(opts.keyAlg, opts.curve);
  const contentDigest =
    'digest' in content ? content.digest : await digest(hash, content);
  const parts = certParts(opts.certDer);
  const attrs = await signedAttributes(contentDigest, opts, parts);
  const toSign = setOf(attrs);
  const signature = await opts.sign({
    data: toSign,
    digest: await digest(hash, toSign),
    hash,
  });
  if (!signature?.length) throw new Error('The signature is empty');

  const unsigned: Uint8Array[] = [];
  if (opts.timestamp) {
    const token = await opts.timestamp(signature);
    unsigned.push(attribute(OID.timeStampToken, token));
  }

  const hashAlg = algorithm(hash === 'sha384' ? OID.sha384 : OID.sha256);
  const signerInfo = seq(
    int(1),
    // IssuerAndSerialNumber
    seq(parts.issuer, parts.serial),
    hashAlg,
    // [0] IMPLICIT SET OF Attribute: the very bytes signed, retagged
    setOf(attrs, 0xa0),
    signatureAlgorithm(opts.keyAlg, hash),
    octets(signature),
    ...(unsigned.length ? [setOf(unsigned, 0xa1)] : [])
  );

  const certs = [opts.certDer, ...(opts.chainDer ?? [])].filter(
    (c, i, all) => all.findIndex((d) => sameBytes(c, d)) === i
  );
  const signedData = seq(
    int(1),
    tlv(0x31, hashAlg),
    // Detached: the content is the PDF around the signature
    seq(oid(OID.data)),
    // [0] IMPLICIT SET OF Certificate
    setOf(certs, 0xa0),
    tlv(0x31, signerInfo)
  );
  return seq(oid(OID.signedData), tlv(0xa0, signedData));
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** An ECDSA signature as WebCrypto returns it (r||s, IEEE P1363) as the
 *  DER SEQUENCE { r INTEGER, s INTEGER } CMS carries */
export function ecdsaP1363ToDer(sig: Uint8Array): Uint8Array {
  if (!sig.length || sig.length % 2) throw new Error('Not an r||s signature');
  const half = sig.length / 2;
  const integer = (part: Uint8Array) => {
    let i = 0;
    while (i < part.length - 1 && part[i] === 0) i++;
    const v = part.subarray(i);
    return v[0] & 0x80 ? concat(new Uint8Array([0]), v) : v;
  };
  return tlv(
    0x30,
    concat(
      tlv(0x02, integer(sig.subarray(0, half))),
      tlv(0x02, integer(sig.subarray(half)))
    )
  );
}
