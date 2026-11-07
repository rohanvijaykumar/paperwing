/**
 * Digital IDs kept in files (.pfx/.p12, or PEM): reading one with its
 * password, signing with its key (Web Crypto, in memory, never saved
 * anywhere), and saving a new self-signed ID as a password-protected .pfx.
 *
 * node-forge reads the files (it knows the old encryptions Windows exports
 * still use) and keeps EC keys and certificates it can't interpret as raw
 * ASN.1, which is all that's needed here: Web Crypto does the signing.
 */
import forge from 'node-forge';
import {
  certParts,
  ecdsaP1363ToDer,
  sameBytes,
  type Curve,
  type KeyAlg,
  type Signer,
} from './cms';
import { certInfo } from './x509';

export interface FileId {
  certDer: Uint8Array;
  chainDer: Uint8Array[];
  keyAlg: KeyAlg;
  curve: Curve | null;
  sign: Signer;
}

/** Wrong or missing password: the caller asks again */
export class PasswordError extends Error {
  constructor(message = 'The password is incorrect.') {
    super(message);
    this.name = 'PasswordError';
  }
}

export class FileIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileIdError';
  }
}

const toBytes = (s: string) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};
const toBinary = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000)
    s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
};
const asn1ToDer = (a: forge.asn1.Asn1) =>
  toBytes(forge.asn1.toDer(a).getBytes());

const CURVE_BY_OID: Record<string, Curve> = {
  '1.2.840.10045.3.1.7': 'P-256',
  '1.3.132.0.34': 'P-384',
  '1.3.132.0.35': 'P-521',
};

/** The key's algorithm from its PKCS#8 PrivateKeyInfo */
function pkcs8Alg(keyDer: Uint8Array): { keyAlg: KeyAlg; curve: Curve | null } {
  const info = forge.asn1.fromDer(toBinary(keyDer));
  const alg = (info.value as forge.asn1.Asn1[])[1].value as forge.asn1.Asn1[];
  const id = forge.asn1.derToOid(alg[0].value as string);
  if (id === '1.2.840.113549.1.1.1') return { keyAlg: 'rsa', curve: null };
  if (id === '1.2.840.10045.2.1') {
    const curve =
      alg[1] && alg[1].type === forge.asn1.Type.OID
        ? CURVE_BY_OID[forge.asn1.derToOid(alg[1].value as string)]
        : undefined;
    if (!curve)
      throw new FileIdError(
        'This ID’s key uses a curve Paperwing can’t sign with (P-256, P-384 and P-521 work).'
      );
    return { keyAlg: 'ec', curve };
  }
  throw new FileIdError('Paperwing can’t sign with this kind of key yet.');
}

/** A signer for a PKCS#8 key, through Web Crypto */
export async function keySigner(
  keyDer: Uint8Array,
  keyAlg: KeyAlg,
  curve: Curve | null
): Promise<Signer> {
  if (keyAlg === 'rsa') {
    const keys = new Map<string, Promise<CryptoKey>>();
    const keyFor = (hash: string) => {
      let k = keys.get(hash);
      if (!k) {
        k = crypto.subtle.importKey(
          'pkcs8',
          keyDer as Uint8Array<ArrayBuffer>,
          { name: 'RSASSA-PKCS1-v1_5', hash },
          false,
          ['sign']
        );
        keys.set(hash, k);
      }
      return k;
    };
    return async ({ data, hash }) =>
      new Uint8Array(
        await crypto.subtle.sign(
          'RSASSA-PKCS1-v1_5',
          await keyFor(hash === 'sha384' ? 'SHA-384' : 'SHA-256'),
          data as Uint8Array<ArrayBuffer>
        )
      );
  }
  const key = await crypto.subtle.importKey(
    'pkcs8',
    keyDer as Uint8Array<ArrayBuffer>,
    { name: 'ECDSA', namedCurve: curve! },
    false,
    ['sign']
  );
  return async ({ data, hash }) =>
    ecdsaP1363ToDer(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: hash === 'sha384' ? 'SHA-384' : 'SHA-256' },
          key,
          data as Uint8Array<ArrayBuffer>
        )
      )
    );
}

/** Does this certificate go with this key? Signs a test message with the
 *  key and checks it with the certificate's public key. */
async function keyMatches(
  certDer: Uint8Array,
  sign: Signer,
  keyAlg: KeyAlg,
  curve: Curve | null
): Promise<boolean> {
  try {
    const { spki } = certParts(certDer);
    const data = crypto.getRandomValues(new Uint8Array(32));
    const sig = await sign({ data, digest: new Uint8Array(), hash: 'sha256' });
    if (keyAlg === 'rsa') {
      const pub = await crypto.subtle.importKey(
        'spki',
        spki as Uint8Array<ArrayBuffer>,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify']
      );
      return crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        pub,
        sig as Uint8Array<ArrayBuffer>,
        data
      );
    }
    const pub = await crypto.subtle.importKey(
      'spki',
      spki as Uint8Array<ArrayBuffer>,
      { name: 'ECDSA', namedCurve: curve! },
      false,
      ['verify']
    );
    return crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pub,
      derToP1363(sig, curve!) as Uint8Array<ArrayBuffer>,
      data
    );
  } catch {
    return false;
  }
}

/** DER ECDSA signature back to r||s (for Web Crypto's verify) */
export function derToP1363(der: Uint8Array, curve: Curve): Uint8Array {
  const size = curve === 'P-256' ? 32 : curve === 'P-384' ? 48 : 66;
  const seq = forge.asn1.fromDer(toBinary(der));
  const [r, s] = (seq.value as forge.asn1.Asn1[]).map((x) =>
    toBytes(x.value as string)
  );
  const out = new Uint8Array(size * 2);
  const put = (v: Uint8Array, at: number) => {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    const t = v.subarray(i);
    out.set(t, at + size - t.length);
  };
  put(r, 0);
  put(s, size);
  return out;
}

/** The signer's certificate first, then its issuers in order */
async function orderChain(
  leaf: Uint8Array,
  others: Uint8Array[]
): Promise<Uint8Array[]> {
  const chain: Uint8Array[] = [];
  let current = leaf;
  const pool = others.filter((c) => !sameBytes(c, leaf));
  for (;;) {
    const { issuer, subject } = certParts(current);
    if (sameBytes(issuer, subject)) break;
    const i = pool.findIndex((c) => sameBytes(certParts(c).subject, issuer));
    if (i < 0) break;
    current = pool.splice(i, 1)[0];
    chain.push(current);
  }
  return chain;
}

async function assemble(
  keyDer: Uint8Array,
  certs: Uint8Array[]
): Promise<FileId> {
  if (!certs.length)
    throw new FileIdError('There’s no certificate in this file.');
  const { keyAlg, curve } = pkcs8Alg(keyDer);
  const sign = await keySigner(keyDer, keyAlg, curve);
  // Signing certificates before CA certificates, then the rest
  const ranked = await Promise.all(
    certs.map(async (c) => ({ c, ca: (await certInfo(c)).isCa }))
  );
  ranked.sort((a, b) => Number(a.ca) - Number(b.ca));
  for (const { c } of ranked) {
    if (await keyMatches(c, sign, keyAlg, curve))
      return {
        certDer: c,
        chainDer: await orderChain(c, certs),
        keyAlg,
        curve,
        sign,
      };
  }
  throw new FileIdError(
    'The private key in this file doesn’t belong to any of its certificates.'
  );
}

/** A .pfx/.p12 file */
export async function readPfx(
  data: Uint8Array,
  password: string
): Promise<FileId> {
  let p12: forge.pkcs12.Pkcs12Pfx;
  // forge would interpret each certificate and write it out again, not
  // always byte for byte (which breaks its signature); refusing to
  // interpret them keeps each one as it is in the file
  const interpret = forge.pki.certificateFromAsn1;
  forge.pki.certificateFromAsn1 = () => {
    throw new Error('kept as is');
  };
  try {
    const asn1 = forge.asn1.fromDer(toBinary(data));
    try {
      p12 = forge.pkcs12.pkcs12FromAsn1(asn1, true, password);
    } catch (e) {
      // Some files are protected with an empty password, some with none
      if (password) throw e;
      p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
    }
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/mac|password|invalid|decrypt/i.test(msg)) throw new PasswordError();
    throw new FileIdError('This file isn’t a digital ID Paperwing can read.');
  } finally {
    forge.pki.certificateFromAsn1 = interpret;
  }
  const keyBags = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[
      forge.pki.oids.pkcs8ShroudedKeyBag
    ] ?? []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[
      forge.pki.oids.keyBag
    ] ?? []),
  ];
  const keyBag = keyBags[0];
  if (!keyBag)
    throw new FileIdError(
      'There’s no private key in this file, so it can’t sign. Export the ID again with its private key.'
    );
  const keyDer = keyBag.key
    ? asn1ToDer(
        forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(keyBag.key))
      )
    : asn1ToDer((keyBag as unknown as { asn1: forge.asn1.Asn1 }).asn1);
  const certBags =
    p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ??
    [];
  const certs = certBags
    .map((b) => (b as unknown as { asn1?: forge.asn1.Asn1 }).asn1)
    .filter((a): a is forge.asn1.Asn1 => !!a)
    .map(asn1ToDer);
  return assemble(keyDer, certs);
}

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g;

/** A PEM file (or two pasted together) with the certificate(s) and key */
export async function readPem(text: string, password = ''): Promise<FileId> {
  const certs: Uint8Array[] = [];
  let keyDer: Uint8Array | null = null;
  for (const m of text.matchAll(PEM_BLOCK)) {
    const [block, label] = m;
    if (label === 'CERTIFICATE') {
      certs.push(toBytes(forge.pem.decode(block)[0].body));
    } else if (label === 'PRIVATE KEY') {
      keyDer = toBytes(forge.pem.decode(block)[0].body);
    } else if (label === 'ENCRYPTED PRIVATE KEY') {
      if (!password) throw new PasswordError('This key needs its password.');
      const info = forge.pki.decryptPrivateKeyInfo(
        forge.asn1.fromDer(forge.pem.decode(block)[0].body),
        password
      );
      if (!info) throw new PasswordError();
      keyDer = asn1ToDer(info);
    } else if (label === 'RSA PRIVATE KEY') {
      let key: forge.pki.rsa.PrivateKey | null;
      if (/ENCRYPTED/.test(block)) {
        if (!password) throw new PasswordError('This key needs its password.');
        key = forge.pki.decryptRsaPrivateKey(block, password);
        if (!key) throw new PasswordError();
      } else {
        key = forge.pki.privateKeyFromPem(block) as forge.pki.rsa.PrivateKey;
      }
      keyDer = asn1ToDer(
        forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(key))
      );
    } else if (label === 'EC PRIVATE KEY') {
      if (/ENCRYPTED/.test(block))
        throw new FileIdError(
          'Paperwing can’t read this encrypted key. Save it as a .pfx file or a PKCS#8 key instead.'
        );
      keyDer = sec1ToPkcs8(toBytes(forge.pem.decode(block)[0].body));
    }
  }
  if (!keyDer)
    throw new FileIdError(
      'There’s no private key in this file, so it can’t sign.'
    );
  return assemble(keyDer, certs);
}

/** An EC key in SEC 1 form (BEGIN EC PRIVATE KEY) as PKCS#8 */
function sec1ToPkcs8(sec1: Uint8Array): Uint8Array {
  const a = forge.asn1;
  const key = a.fromDer(toBinary(sec1));
  const params = (key.value as forge.asn1.Asn1[]).find(
    (v) => v.tagClass === a.Class.CONTEXT_SPECIFIC && v.type === 0
  );
  const curve = params && (params.value as forge.asn1.Asn1[])[0];
  if (!curve || curve.type !== a.Type.OID)
    throw new FileIdError('This EC key doesn’t say which curve it uses.');
  return asn1ToDer(
    a.create(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, [
      a.create(a.Class.UNIVERSAL, a.Type.INTEGER, false, '\x00'),
      a.create(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, [
        a.create(
          a.Class.UNIVERSAL,
          a.Type.OID,
          false,
          a.oidToDer('1.2.840.10045.2.1').getBytes()
        ),
        curve,
      ]),
      a.create(a.Class.UNIVERSAL, a.Type.OCTETSTRING, false, toBinary(sec1)),
    ])
  );
}

/** Reads an ID file by its name: .pfx/.p12, else PEM */
export function readIdFile(
  name: string,
  data: Uint8Array,
  password: string
): Promise<FileId> {
  if (/\.(pem|crt|cer|key)$/i.test(name) || looksLikePem(data))
    return readPem(new TextDecoder().decode(data), password);
  return readPfx(data, password);
}

function looksLikePem(data: Uint8Array): boolean {
  return new TextDecoder()
    .decode(data.subarray(0, 2048))
    .includes('-----BEGIN ');
}

/**
 * A password-protected PKCS#12 file (.pfx) holding a key and its
 * certificate(s): the key encrypted with AES-256 (PBES2, PBKDF2 with
 * HMAC-SHA-256), integrity by an HMAC-SHA-256 MAC. Windows, macOS,
 * OpenSSL and Acrobat read it.
 */
export function makePfx(
  keyDer: Uint8Array,
  certs: Uint8Array[],
  password: string,
  friendlyName?: string
): Uint8Array {
  const a = forge.asn1;
  const U = a.Class.UNIVERSAL;
  const T = a.Type;
  const ctx0 = (v: forge.asn1.Asn1[]) =>
    a.create(a.Class.CONTEXT_SPECIFIC, 0, true, v);
  const oid = (o: string) =>
    a.create(U, T.OID, false, a.oidToDer(o).getBytes());
  const octets = (s: string) => a.create(U, T.OCTETSTRING, false, s);
  const seq = (v: forge.asn1.Asn1[]) => a.create(U, T.SEQUENCE, true, v);
  const set = (v: forge.asn1.Asn1[]) => a.create(U, T.SET, true, v);
  // Pairs the key with its certificate (any unique value; a fingerprint)
  const md = forge.md.sha256.create();
  md.update(toBinary(certs[0]));
  const attrs = [
    seq([
      oid(forge.pki.oids.localKeyId),
      set([octets(md.digest().getBytes())]),
    ]),
    ...(friendlyName
      ? [
          seq([
            oid(forge.pki.oids.friendlyName),
            set([a.create(U, T.BMPSTRING, false, friendlyName)]),
          ]),
        ]
      : []),
  ];
  const data = (inner: forge.asn1.Asn1) =>
    seq([oid(forge.pki.oids.data), ctx0([octets(a.toDer(inner).getBytes())])]);
  const certBags = certs.map((c, i) =>
    seq([
      oid(forge.pki.oids.certBag),
      ctx0([
        seq([oid(forge.pki.oids.x509Certificate), ctx0([octets(toBinary(c))])]),
      ]),
      ...(i === 0 ? [set(attrs)] : []),
    ])
  );
  const encrypted = forge.pki.encryptPrivateKeyInfo(
    a.fromDer(toBinary(keyDer)),
    password,
    {
      algorithm: 'aes256',
      count: 10000,
      saltSize: 16,
      prfAlgorithm: 'sha256',
    } as unknown as Parameters<typeof forge.pki.encryptPrivateKeyInfo>[2]
  );
  const keyBag = seq([
    oid(forge.pki.oids.pkcs8ShroudedKeyBag),
    ctx0([encrypted]),
    set(attrs),
  ]);
  const safe = seq([data(seq(certBags)), data(seq([keyBag]))]);
  const count = 10000;
  const salt = forge.random.getBytesSync(16);
  const macKey = forge.pkcs12.generateKey(
    password,
    forge.util.createBuffer(salt),
    3,
    count,
    32,
    forge.md.sha256.create()
  );
  const hmac = forge.hmac.create();
  hmac.start('sha256', macKey);
  hmac.update(a.toDer(safe).getBytes());
  const macData = seq([
    seq([
      seq([oid(forge.pki.oids.sha256), a.create(U, T.NULL, false, '')]),
      octets(hmac.digest().getBytes()),
    ]),
    octets(salt),
    a.create(U, T.INTEGER, false, a.integerToDer(count).getBytes()),
  ]);
  return asn1ToDer(
    seq([
      a.create(U, T.INTEGER, false, a.integerToDer(3).getBytes()),
      data(safe),
      macData,
    ])
  );
}
