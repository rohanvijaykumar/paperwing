/**
 * Reading certificates for the Digital ID list (name, issuer, dates, what
 * they may be used for), Acrobat's rules for which IDs can sign, and
 * creating a self-signed ID.
 */
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import type { Curve, KeyAlg } from './cms';

const DN_NAMES: Record<string, string> = {
  '2.5.4.3': 'CN',
  '2.5.4.4': 'SN',
  '2.5.4.5': 'SERIALNUMBER',
  '2.5.4.6': 'C',
  '2.5.4.7': 'L',
  '2.5.4.8': 'ST',
  '2.5.4.10': 'O',
  '2.5.4.11': 'OU',
  '2.5.4.12': 'T',
  '2.5.4.42': 'G',
  '2.5.4.97': 'organizationIdentifier',
  '1.2.840.113549.1.9.1': 'E',
  '0.9.2342.19200300.100.1.25': 'DC',
};

export const EKU = {
  serverAuth: '1.3.6.1.5.5.7.3.1',
  clientAuth: '1.3.6.1.5.5.7.3.2',
  codeSigning: '1.3.6.1.5.5.7.3.3',
  emailProtection: '1.3.6.1.5.5.7.3.4',
  timeStamping: '1.3.6.1.5.5.7.3.8',
  ocspSigning: '1.3.6.1.5.5.7.3.9',
  documentSigning: '1.3.6.1.5.5.7.3.36',
  msDocumentSigning: '1.3.6.1.4.1.311.10.3.12',
  authenticDocuments: '1.2.840.113583.1.1.5',
  smartCardLogon: '1.3.6.1.4.1.311.20.2.2',
  any: '2.5.29.37.0',
} as const;

const EKU_LABELS: Record<string, string> = {
  [EKU.serverAuth]: 'Websites (server authentication)',
  [EKU.clientAuth]: 'Logging in (client authentication)',
  [EKU.codeSigning]: 'Signing code',
  [EKU.emailProtection]: 'Email and documents',
  [EKU.timeStamping]: 'Timestamps',
  [EKU.ocspSigning]: 'Certificate status replies',
  [EKU.documentSigning]: 'Signing documents',
  [EKU.msDocumentSigning]: 'Signing documents (Microsoft)',
  [EKU.authenticDocuments]: 'Signing PDF documents',
  [EKU.smartCardLogon]: 'Smart card logon',
  [EKU.any]: 'Any purpose',
};

/** EKUs that can sign documents, as Acrobat accepts them */
const SIGNING_EKUS = new Set<string>([
  EKU.emailProtection,
  EKU.codeSigning,
  EKU.any,
  EKU.authenticDocuments,
  EKU.documentSigning,
  EKU.msDocumentSigning,
]);

const KU_LABELS = [
  'Digital signature',
  'Non-repudiation',
  'Key encipherment',
  'Data encipherment',
  'Key agreement',
  'Certificate signing',
  'CRL signing',
  'Encipher only',
  'Decipher only',
];

export interface CertInfo {
  name: string;
  email?: string;
  org?: string;
  issuerName: string;
  subjectDn: string;
  issuerDn: string;
  notBefore: Date;
  notAfter: Date;
  serial: string;
  selfSigned: boolean;
  keyAlg: KeyAlg | null;
  curve: Curve | null;
  keyBits: number;
  /** Key usage bits (0 = digitalSignature, 1 = nonRepudiation, …); null if
   *  the certificate has no key usage extension */
  keyUsage: number[] | null;
  /** Extended key usage OIDs; null if absent */
  extKeyUsage: string[] | null;
  isCa: boolean;
  sha1: string;
  sha256: string;
}

const hex = (b: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(b)]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();

function dnEntries(rdn: pkijs.RelativeDistinguishedNames) {
  return rdn.typesAndValues.map((tv) => ({
    type: tv.type,
    name: DN_NAMES[tv.type] ?? tv.type,
    value: String(
      (tv.value as asn1js.BaseStringBlock).valueBlock?.value ??
        (tv.value as any)?.valueBlock?.value ??
        ''
    ),
  }));
}

function dnString(rdn: pkijs.RelativeDistinguishedNames): string {
  return dnEntries(rdn)
    .map((e) => `${e.name}=${e.value}`)
    .join(', ');
}

function dnField(
  rdn: pkijs.RelativeDistinguishedNames,
  name: string
): string | undefined {
  return dnEntries(rdn).find((e) => e.name === name)?.value || undefined;
}

/** The name to show: the common name, else the organisation or email */
function displayName(rdn: pkijs.RelativeDistinguishedNames): string {
  const given = [dnField(rdn, 'G'), dnField(rdn, 'SN')]
    .filter(Boolean)
    .join(' ');
  return (
    dnField(rdn, 'CN') ||
    given ||
    dnField(rdn, 'O') ||
    dnField(rdn, 'E') ||
    dnField(rdn, 'OU') ||
    'Unknown'
  );
}

const CURVES: Record<string, Curve> = {
  '1.2.840.10045.3.1.7': 'P-256',
  '1.3.132.0.34': 'P-384',
  '1.3.132.0.35': 'P-521',
};

function keyInfo(cert: pkijs.Certificate): {
  keyAlg: KeyAlg | null;
  curve: Curve | null;
  keyBits: number;
} {
  const spki = cert.subjectPublicKeyInfo;
  const alg = spki.algorithm.algorithmId;
  if (alg === '1.2.840.113549.1.1.1') {
    try {
      const rsa = pkijs.RSAPublicKey.fromBER(
        spki.subjectPublicKey.valueBlock.valueHexView.slice()
      );
      const n = rsa.modulus.valueBlock.valueHexView;
      let i = 0;
      while (i < n.length && n[i] === 0) i++;
      const top = n[i] ?? 0;
      return {
        keyAlg: 'rsa',
        curve: null,
        keyBits: (n.length - i - 1) * 8 + (32 - Math.clz32(top)),
      };
    } catch {
      return { keyAlg: 'rsa', curve: null, keyBits: 0 };
    }
  }
  if (alg === '1.2.840.10045.2.1') {
    const params = spki.algorithm.algorithmParams as
      | asn1js.ObjectIdentifier
      | undefined;
    const curve = CURVES[params?.valueBlock?.toString?.() ?? ''] ?? null;
    return {
      keyAlg: 'ec',
      curve,
      keyBits: curve ? Number(curve.slice(2)) : 0,
    };
  }
  return { keyAlg: null, curve: null, keyBits: 0 };
}

function extension(cert: pkijs.Certificate, id: string) {
  return cert.extensions?.find((e) => e.extnID === id);
}

export async function certInfo(der: Uint8Array): Promise<CertInfo> {
  const cert = pkijs.Certificate.fromBER(der.slice());
  const ku = extension(cert, '2.5.29.15');
  let keyUsage: number[] | null = null;
  if (ku) {
    const bits = (ku.parsedValue as asn1js.BitString | undefined)?.valueBlock;
    const bytes = bits?.valueHexView ?? new Uint8Array();
    keyUsage = [];
    for (let i = 0; i < bytes.length * 8 && i < 9; i++)
      if (bytes[i >> 3] & (0x80 >> (i & 7))) keyUsage.push(i);
  }
  const eku = extension(cert, '2.5.29.37');
  const extKeyUsage = eku
    ? ((eku.parsedValue as pkijs.ExtKeyUsage | undefined)?.keyPurposes ?? [])
    : null;
  const bc = extension(cert, '2.5.29.19');
  const isCa = !!(bc?.parsedValue as pkijs.BasicConstraints | undefined)?.cA;
  const [sha1, sha256] = await Promise.all(
    ['SHA-1', 'SHA-256'].map(async (h) =>
      hex(await crypto.subtle.digest(h, der as Uint8Array<ArrayBuffer>))
    )
  );
  const subjectDn = dnString(cert.subject);
  const issuerDn = dnString(cert.issuer);
  return {
    name: displayName(cert.subject),
    email: dnField(cert.subject, 'E') ?? subjectAltEmail(cert),
    org: dnField(cert.subject, 'O'),
    issuerName: displayName(cert.issuer),
    subjectDn,
    issuerDn,
    notBefore: cert.notBefore.value,
    notAfter: cert.notAfter.value,
    serial: hex(cert.serialNumber.valueBlock.valueHexView),
    selfSigned: subjectDn === issuerDn,
    ...keyInfo(cert),
    keyUsage,
    extKeyUsage,
    isCa,
    sha1,
    sha256,
  };
}

function subjectAltEmail(cert: pkijs.Certificate): string | undefined {
  const san = extension(cert, '2.5.29.17')?.parsedValue as
    | pkijs.AltName
    | undefined;
  const email = san?.altNames?.find((n) => n.type === 1);
  return email ? String(email.value) : undefined;
}

export const keyUsageLabels = (bits: number[]) =>
  bits.map((b) => KU_LABELS[b] ?? `Bit ${b}`);

export const extKeyUsageLabels = (oids: string[]) =>
  oids.map((o) => EKU_LABELS[o] ?? o);

/* ------------------------------------------------------------------ */
/* Which IDs can sign (Acrobat's rules)                                */
/* ------------------------------------------------------------------ */

export interface IdStatus {
  /** It can sign now */
  usable: boolean;
  /** Left out of the list unless "Show all certificates" is on */
  hidden: boolean;
  /** Why it can't sign, in plain words */
  reason?: string;
}

export function idStatus(
  info: Pick<
    CertInfo,
    'keyUsage' | 'extKeyUsage' | 'notBefore' | 'notAfter' | 'keyAlg' | 'curve'
  >,
  hasPrivateKey: boolean,
  now = new Date()
): IdStatus {
  if (!hasPrivateKey)
    return {
      usable: false,
      hidden: true,
      reason: 'Its private key isn’t on this computer, so it can’t sign.',
    };
  if (info.keyUsage && !info.keyUsage.some((b) => b === 0 || b === 1))
    return {
      usable: false,
      hidden: true,
      reason: 'It isn’t meant for signing (only for encryption).',
    };
  if (info.extKeyUsage && !info.extKeyUsage.some((o) => SIGNING_EKUS.has(o)))
    return {
      usable: false,
      hidden: true,
      reason:
        'It isn’t meant for signing documents (only for logging in or websites).',
    };
  if (info.keyAlg !== 'rsa' && !(info.keyAlg === 'ec' && info.curve))
    return {
      usable: false,
      hidden: false,
      reason: 'Paperwing can’t sign with this kind of key yet.',
    };
  if (now > info.notAfter)
    return {
      usable: false,
      hidden: false,
      reason: `It expired on ${formatDate(info.notAfter)}.`,
    };
  if (now < info.notBefore)
    return {
      usable: false,
      hidden: false,
      reason: `It isn’t valid until ${formatDate(info.notBefore)}.`,
    };
  return { usable: true, hidden: false };
}

export function formatDate(d: Date): string {
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/* ------------------------------------------------------------------ */
/* Self-signed IDs                                                     */
/* ------------------------------------------------------------------ */

export interface NewIdOptions {
  name: string;
  org?: string;
  orgUnit?: string;
  email?: string;
  country?: string;
  keyType: 'rsa' | 'ec';
  /** ECDSA curve (P-256 unless given) */
  curve?: Curve;
  /** Years it's valid for (Acrobat's default is 5) */
  years?: number;
  /** When it starts being valid (now unless given) */
  from?: Date;
}

/**
 * A self-signed digital ID like Acrobat's: for signing documents (key usage
 * digitalSignature and nonRepudiation; email protection and document signing
 * purposes). Returns the certificate and its PKCS#8 private key, DER.
 */
export async function createSelfSignedId(
  opts: NewIdOptions
): Promise<{ certDer: Uint8Array; keyDer: Uint8Array }> {
  const algorithm =
    opts.keyType === 'ec'
      ? { name: 'ECDSA', namedCurve: opts.curve ?? 'P-256' }
      : {
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256',
        };
  const keys = (await crypto.subtle.generateKey(algorithm, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;

  const cert = new pkijs.Certificate();
  cert.version = 2;
  const serial = crypto.getRandomValues(new Uint8Array(16));
  serial[0] &= 0x7f;
  serial[0] |= 0x40;
  cert.serialNumber = new asn1js.Integer({ valueHex: serial.buffer });
  const name = new pkijs.RelativeDistinguishedNames();
  const add = (type: string, value: string | undefined, printable = false) => {
    const v = value?.trim();
    if (!v) return;
    name.typesAndValues.push(
      new pkijs.AttributeTypeAndValue({
        type,
        value: printable
          ? new asn1js.PrintableString({ value: v })
          : type === '1.2.840.113549.1.9.1'
            ? new asn1js.IA5String({ value: v })
            : new asn1js.Utf8String({ value: v }),
      })
    );
  };
  add('2.5.4.3', opts.name);
  add('2.5.4.11', opts.orgUnit);
  add('2.5.4.10', opts.org);
  add('1.2.840.113549.1.9.1', opts.email);
  add('2.5.4.6', opts.country?.toUpperCase(), true);
  cert.subject = name;
  cert.issuer = name;
  const now = opts.from ?? new Date();
  const from = new Date(now.getTime() - 5 * 60 * 1000);
  const to = new Date(now);
  to.setFullYear(to.getFullYear() + (opts.years ?? 5));
  cert.notBefore.value = from;
  cert.notAfter.value = to;
  await cert.subjectPublicKeyInfo.importKey(keys.publicKey);

  const keyId = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-1',
      cert.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView.slice()
    )
  );
  // digitalSignature + nonRepudiation
  const kuBits = new Uint8Array([0xc0]);
  cert.extensions = [
    new pkijs.Extension({
      extnID: '2.5.29.15',
      critical: true,
      extnValue: new asn1js.BitString({
        valueHex: kuBits.buffer,
        unusedBits: 6,
      }).toBER(false),
    }),
    new pkijs.Extension({
      extnID: '2.5.29.37',
      critical: false,
      extnValue: new pkijs.ExtKeyUsage({
        keyPurposes: [EKU.emailProtection, EKU.documentSigning],
      })
        .toSchema()
        .toBER(false),
    }),
    new pkijs.Extension({
      extnID: '2.5.29.14',
      critical: false,
      extnValue: new asn1js.OctetString({ valueHex: keyId.buffer }).toBER(
        false
      ),
    }),
  ];
  if (opts.email?.trim())
    cert.extensions.push(
      new pkijs.Extension({
        extnID: '2.5.29.17',
        critical: false,
        extnValue: new pkijs.GeneralNames({
          names: [new pkijs.GeneralName({ type: 1, value: opts.email.trim() })],
        })
          .toSchema()
          .toBER(false),
      })
    );
  await cert.sign(keys.privateKey, 'SHA-256');
  const certDer = new Uint8Array(cert.toSchema(true).toBER(false));
  const keyDer = new Uint8Array(
    await crypto.subtle.exportKey('pkcs8', keys.privateKey)
  );
  return { certDer, keyDer };
}
