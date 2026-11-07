// @vitest-environment node
// The CMS (PAdES) signature builder (src/acro/certs/cms.ts), the file IDs
// (file-id.ts) and certificate reading (x509.ts): structure, attributes,
// digests, RSA and ECDSA, checked with pkijs, Web Crypto and (when it's
// installed, as on CI) OpenSSL.
import { describe, expect, it } from 'vitest';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import forge from 'node-forge';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OID,
  buildCms,
  certParts,
  derOrder,
  digest,
  ecdsaP1363ToDer,
  hashFor,
  type Curve,
  type KeyAlg,
  type SignRequest,
} from '../acro/certs/cms';
import {
  derToP1363,
  keySigner,
  makePfx,
  readIdFile,
  readPem,
  readPfx,
  PasswordError,
} from '../acro/certs/file-id';
import {
  EKU,
  certInfo,
  createSelfSignedId,
  idStatus,
} from '../acro/certs/x509';

const ids = new Map<string, Promise<{ certDer: Uint8Array; keyDer: Uint8Array }>>();
function testId(keyType: KeyAlg, curve?: Curve) {
  const k = `${keyType}-${curve ?? ''}`;
  if (!ids.has(k))
    ids.set(
      k,
      createSelfSignedId({
        name: `Test ${k}`,
        org: 'Paperwing tests',
        email: 'test@example.com',
        keyType,
        curve,
      })
    );
  return ids.get(k)!;
}

function parseCms(der: Uint8Array) {
  const ci = pkijs.ContentInfo.fromBER(der.slice());
  expect(ci.contentType).toBe(OID.signedData);
  return new pkijs.SignedData({ schema: ci.content });
}

function attr(sd: pkijs.SignedData, type: string) {
  return sd.signerInfos[0].signedAttrs?.attributes.find((a) => a.type === type);
}

const opensslAvailable = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const lines = (b: Uint8Array) =>
  Buffer.from(b).toString('base64').match(/.{1,64}/g)!.join('\n');
const pem = (der: Uint8Array) =>
  `-----BEGIN CERTIFICATE-----\n${lines(der)}\n-----END CERTIFICATE-----\n`;

describe('CMS builder', () => {
  const content = new TextEncoder().encode('%PDF-1.7 the signed bytes…');

  for (const [keyAlg, curve] of [
    ['rsa', undefined],
    ['ec', 'P-256'],
    ['ec', 'P-384'],
    ['ec', 'P-521'],
  ] as [KeyAlg, Curve | undefined][]) {
    const label = keyAlg === 'rsa' ? 'RSA 2048' : `ECDSA ${curve}`;
    it(`${label}: a valid, verifiable PAdES signature`, async () => {
      const { certDer, keyDer } = await testId(keyAlg, curve);
      const sign = await keySigner(keyDer, keyAlg, curve ?? null);
      const seen: SignRequest[] = [];
      const der = await buildCms(content, {
        certDer,
        keyAlg,
        curve,
        subFilter: 'ETSI.CAdES.detached',
        sign: async (req) => {
          seen.push(req);
          return sign(req);
        },
      });
      const hash = hashFor(keyAlg, curve);
      expect(hash).toBe(
        keyAlg === 'ec' && curve !== 'P-256' ? 'sha384' : 'sha256'
      );
      // The signer is given the DER SET OF signed attributes and its digest
      expect(seen).toHaveLength(1);
      expect(seen[0].data[0]).toBe(0x31);
      expect(seen[0].hash).toBe(hash);
      expect([...seen[0].digest]).toEqual([
        ...(await digest(hash, seen[0].data)),
      ]);

      const sd = parseCms(der);
      expect(sd.version).toBe(1);
      expect(sd.encapContentInfo.eContentType).toBe(OID.data);
      expect(sd.encapContentInfo.eContent).toBeUndefined();
      const si = sd.signerInfos[0];
      expect(si.version).toBe(1);
      expect(si.digestAlgorithm.algorithmId).toBe(
        hash === 'sha384' ? OID.sha384 : OID.sha256
      );
      expect(si.signatureAlgorithm.algorithmId).toBe(
        keyAlg === 'rsa'
          ? OID.sha256WithRSA
          : hash === 'sha384'
            ? OID.ecdsaWithSHA384
            : OID.ecdsaWithSHA256
      );
      // The certificate travels unchanged
      expect(sd.certificates).toHaveLength(1);
      const embedded = new Uint8Array(
        (sd.certificates![0] as pkijs.Certificate).toSchema().toBER()
      );
      expect([...embedded]).toEqual([...certDer]);

      // contentType id-data, messageDigest, signingCertificateV2; no signingTime
      expect(si.signedAttrs!.attributes.map((a) => a.type).sort()).toEqual(
        [OID.contentType, OID.messageDigest, OID.signingCertificateV2].sort()
      );
      expect(
        (attr(sd, OID.contentType)!.values[0] as asn1js.ObjectIdentifier)
          .valueBlock.toString()
      ).toBe(OID.data);
      const md = (attr(sd, OID.messageDigest)!.values[0] as asn1js.OctetString)
        .valueBlock.valueHexView;
      expect([...md]).toEqual([...(await digest(hash, content))]);
      const ess = attr(sd, OID.signingCertificateV2)!.values[0] as asn1js.Sequence;
      const certId = (
        (ess.valueBlock.value[0] as asn1js.Sequence).valueBlock
          .value[0] as asn1js.Sequence
      ).valueBlock.value;
      // SHA-256 is the default, so the first field is the hash itself
      expect(certId[0]).toBeInstanceOf(asn1js.OctetString);
      expect([...(certId[0] as asn1js.OctetString).valueBlock.valueHexView]).toEqual(
        [...(await digest('sha256', certDer))]
      );
      const issuerSerial = (certId[1] as asn1js.Sequence).valueBlock.value;
      expect(
        [...(issuerSerial[1] as asn1js.Integer).valueBeforeDecodeView]
      ).toEqual([...certParts(certDer).serial]);

      // What was signed is the signed attributes as stored, retagged 0x31
      const stored = new Uint8Array(si.signedAttrs!.toSchema().toBER());
      stored[0] = 0x31;
      expect([...stored]).toEqual([...seen[0].data]);
      // …in DER order
      const encoded = si.signedAttrs!.attributes.map(
        (a) => new Uint8Array(a.toSchema().toBER())
      );
      expect(encoded.map((e) => [...e])).toEqual(
        [...encoded].sort(derOrder).map((e) => [...e])
      );

      // pkijs verifies the signature and the message digest
      const ok = await sd.verify({ signer: 0, data: content.slice().buffer });
      expect(ok).toBe(true);
      // …and a changed byte fails
      const changed = content.slice();
      changed[3] ^= 1;
      const tampered = await sd
        .verify({ signer: 0, data: changed.buffer })
        .catch(() => false);
      expect(tampered).toBe(false);
    });

    it.skipIf(!opensslAvailable)(`${label}: OpenSSL verifies it`, async () => {
      const { certDer, keyDer } = await testId(keyAlg, curve);
      const der = await buildCms(content, {
        certDer,
        keyAlg,
        curve,
        subFilter: 'ETSI.CAdES.detached',
        sign: await keySigner(keyDer, keyAlg, curve ?? null),
      });
      const dir = mkdtempSync(join(tmpdir(), 'pw-cms-'));
      try {
        writeFileSync(join(dir, 'sig.der'), der);
        writeFileSync(join(dir, 'content.bin'), content);
        writeFileSync(join(dir, 'ca.pem'), pem(certDer));
        const out = execFileSync(
          'openssl',
          [
            'cms',
            '-verify',
            '-binary',
            '-inform',
            'DER',
            '-in',
            join(dir, 'sig.der'),
            '-content',
            join(dir, 'content.bin'),
            '-CAfile',
            join(dir, 'ca.pem'),
            '-purpose',
            'any',
            '-out',
            join(dir, 'out.bin'),
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] }
        );
        expect(out).toBeDefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('adbe.pkcs7.detached carries a signingTime', async () => {
    const { certDer, keyDer } = await testId('rsa');
    const when = new Date(Date.UTC(2026, 10, 6, 12, 30, 0));
    const der = await buildCms(content, {
      certDer,
      keyAlg: 'rsa',
      subFilter: 'adbe.pkcs7.detached',
      signingTime: when,
      sign: await keySigner(keyDer, 'rsa', null),
    });
    const sd = parseCms(der);
    const t = attr(sd, OID.signingTime)!.values[0] as asn1js.UTCTime;
    expect(t.toDate().getTime()).toBe(when.getTime());
    expect(await sd.verify({ signer: 0, data: content.slice().buffer })).toBe(
      true
    );
  });

  it('adds the timestamp token as an unsigned attribute over the signature value', async () => {
    const { certDer, keyDer } = await testId('rsa');
    const token = new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x07]);
    let stamped: Uint8Array | null = null;
    const der = await buildCms(content, {
      certDer,
      keyAlg: 'rsa',
      subFilter: 'ETSI.CAdES.detached',
      sign: await keySigner(keyDer, 'rsa', null),
      timestamp: async (sig) => {
        stamped = sig;
        return token;
      },
    });
    const sd = parseCms(der);
    const si = sd.signerInfos[0];
    expect([...si.signature.valueBlock.valueHexView]).toEqual([...stamped!]);
    const ts = si.unsignedAttrs!.attributes.find(
      (a) => a.type === OID.timeStampToken
    )!;
    expect([...new Uint8Array(ts.values[0].toBER())]).toEqual([...token]);
  });

  it('includes the chain once, signer first', async () => {
    const { certDer, keyDer } = await testId('rsa');
    const other = (await testId('ec', 'P-256')).certDer;
    const der = await buildCms(content, {
      certDer,
      chainDer: [other, certDer, other],
      keyAlg: 'rsa',
      subFilter: 'ETSI.CAdES.detached',
      sign: await keySigner(keyDer, 'rsa', null),
    });
    const sd = parseCms(der);
    expect(sd.certificates).toHaveLength(2);
  });

  it('refuses an empty signature', async () => {
    const { certDer } = await testId('rsa');
    await expect(
      buildCms(content, {
        certDer,
        keyAlg: 'rsa',
        subFilter: 'ETSI.CAdES.detached',
        sign: async () => new Uint8Array(),
      })
    ).rejects.toThrow();
  });

  it('takes a digest computed elsewhere', async () => {
    const { certDer, keyDer } = await testId('rsa');
    const der = await buildCms(
      { digest: await digest('sha256', content) },
      {
        certDer,
        keyAlg: 'rsa',
        subFilter: 'ETSI.CAdES.detached',
        sign: await keySigner(keyDer, 'rsa', null),
      }
    );
    expect(
      await parseCms(der).verify({ signer: 0, data: content.slice().buffer })
    ).toBe(true);
  });
});

describe('ECDSA signature encoding', () => {
  const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
  const bytes = (h: string) => new Uint8Array(Buffer.from(h, 'hex'));

  it('r||s to DER: minimal positive INTEGERs', () => {
    expect(hex(ecdsaP1363ToDer(bytes('0102030405060708')))).toBe(
      '300c020401020304020405060708'
    );
    expect(hex(ecdsaP1363ToDer(bytes('80000001ff000001')))).toBe(
      '300e02050080000001020500ff000001'
    );
    expect(hex(ecdsaP1363ToDer(bytes('0000000100000002')))).toBe(
      '3006020101020102'
    );
    expect(() => ecdsaP1363ToDer(bytes('010203'))).toThrow();
  });

  it('P-521 signatures get a long-form length', () => {
    const der = ecdsaP1363ToDer(new Uint8Array(132).fill(0xff));
    expect(der[0]).toBe(0x30);
    expect(der[1]).toBe(0x81);
    expect(der[2]).toBe(der.length - 3);
  });

  it('round trips with real signatures', async () => {
    for (const curve of ['P-256', 'P-384', 'P-521'] as Curve[]) {
      const keys = (await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: curve },
        false,
        ['sign', 'verify']
      )) as CryptoKeyPair;
      for (let i = 0; i < 10; i++) {
        const data = crypto.getRandomValues(new Uint8Array(40));
        const sig = new Uint8Array(
          await crypto.subtle.sign(
            { name: 'ECDSA', hash: 'SHA-256' },
            keys.privateKey,
            data
          )
        );
        const back = derToP1363(ecdsaP1363ToDer(sig), curve);
        expect(hex(back)).toBe(hex(sig));
      }
    }
  });
});

describe('Certificates and Acrobat’s filters', () => {
  it('reads a self-signed ID', async () => {
    const { certDer } = await testId('rsa');
    const info = await certInfo(certDer);
    expect(info.name).toBe('Test rsa-');
    expect(info.org).toBe('Paperwing tests');
    expect(info.email).toBe('test@example.com');
    expect(info.selfSigned).toBe(true);
    expect(info.keyAlg).toBe('rsa');
    expect(info.keyBits).toBe(2048);
    expect(info.keyUsage).toEqual([0, 1]);
    expect(info.extKeyUsage).toEqual([EKU.emailProtection, EKU.documentSigning]);
    expect(info.sha256).toMatch(/^[0-9A-F]{64}$/);
    const years =
      (info.notAfter.getTime() - info.notBefore.getTime()) /
      (365.25 * 86400000);
    expect(Math.round(years)).toBe(5);
    const ec = await certInfo((await testId('ec', 'P-384')).certDer);
    expect(ec.keyAlg).toBe('ec');
    expect(ec.curve).toBe('P-384');
    expect(ec.keyBits).toBe(384);
  });

  const base = {
    keyUsage: [0, 1],
    extKeyUsage: [EKU.emailProtection],
    notBefore: new Date('2026-01-01'),
    notAfter: new Date('2027-01-01'),
    keyAlg: 'rsa' as KeyAlg,
    curve: null as Curve | null,
  };
  const now = new Date('2026-06-01');

  it('a signing ID can sign', () => {
    expect(idStatus(base, true, now)).toEqual({ usable: true, hidden: false });
  });

  it('without a private key: hidden', () => {
    expect(idStatus(base, false, now)).toMatchObject({
      usable: false,
      hidden: true,
    });
  });

  it('key usage: digitalSignature or nonRepudiation if present', () => {
    expect(idStatus({ ...base, keyUsage: [2] }, true, now).hidden).toBe(true);
    expect(idStatus({ ...base, keyUsage: [1] }, true, now).usable).toBe(true);
    expect(idStatus({ ...base, keyUsage: null }, true, now).usable).toBe(true);
  });

  it('extended key usage: signing purposes only, if present', () => {
    for (const ok of [
      EKU.emailProtection,
      EKU.codeSigning,
      EKU.any,
      EKU.authenticDocuments,
      EKU.documentSigning,
    ])
      expect(idStatus({ ...base, extKeyUsage: [ok] }, true, now).usable).toBe(
        true
      );
    const login = idStatus(
      { ...base, extKeyUsage: [EKU.clientAuth] },
      true,
      now
    );
    expect(login).toMatchObject({ usable: false, hidden: true });
    expect(login.reason).toMatch(/logging in/);
    expect(
      idStatus({ ...base, extKeyUsage: [EKU.serverAuth] }, true, now).hidden
    ).toBe(true);
    expect(
      idStatus({ ...base, extKeyUsage: [EKU.clientAuth, EKU.emailProtection] }, true, now).usable
    ).toBe(true);
    expect(idStatus({ ...base, extKeyUsage: null }, true, now).usable).toBe(true);
  });

  it('expired and not yet valid IDs show, disabled, with the reason', () => {
    const expired = idStatus(base, true, new Date('2027-02-01'));
    expect(expired).toMatchObject({ usable: false, hidden: false });
    expect(expired.reason).toMatch(/expired/);
    const early = idStatus(base, true, new Date('2025-12-01'));
    expect(early).toMatchObject({ usable: false, hidden: false });
    expect(early.reason).toMatch(/isn’t valid until/);
  });

  it('keys Paperwing can’t sign with show, disabled', () => {
    expect(
      idStatus({ ...base, keyAlg: null }, true, now)
    ).toMatchObject({ usable: false, hidden: false });
    expect(
      idStatus({ ...base, keyAlg: 'ec', curve: null }, true, now).usable
    ).toBe(false);
    expect(
      idStatus({ ...base, keyAlg: 'ec', curve: 'P-256' }, true, now).usable
    ).toBe(true);
  });
});

describe('Digital ID files', () => {
  it('a new self-signed ID saved as .pfx reads back and signs (RSA and ECDSA)', async () => {
    for (const keyType of ['rsa', 'ec'] as KeyAlg[]) {
      const { certDer, keyDer } = await testId(keyType, keyType === 'ec' ? 'P-256' : undefined);
      const pfx = makePfx(keyDer, [certDer], 'correct horse', 'Test ID');
      const id = await readPfx(pfx, 'correct horse');
      expect([...id.certDer]).toEqual([...certDer]);
      expect(id.keyAlg).toBe(keyType);
      const der = await buildCms(new Uint8Array([1, 2, 3]), {
        certDer: id.certDer,
        keyAlg: id.keyAlg,
        curve: id.curve,
        subFilter: 'ETSI.CAdES.detached',
        sign: id.sign,
      });
      expect(
        await parseCms(der).verify({
          signer: 0,
          data: new Uint8Array([1, 2, 3]).buffer,
        })
      ).toBe(true);
      await expect(readPfx(pfx, 'wrong')).rejects.toBeInstanceOf(PasswordError);
    }
  });

  it.skipIf(!opensslAvailable)('OpenSSL opens the .pfx Paperwing saves', async () => {
    const { certDer, keyDer } = await testId('ec', 'P-256');
    const dir = mkdtempSync(join(tmpdir(), 'pw-pfx-'));
    try {
      writeFileSync(join(dir, 'id.pfx'), makePfx(keyDer, [certDer], 'pw'));
      const out = execFileSync(
        'openssl',
        ['pkcs12', '-in', join(dir, 'id.pfx'), '-passin', 'pass:pw', '-nodes', '-info'],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      ).toString();
      expect(out).toMatch(/BEGIN CERTIFICATE/);
      expect(out).toMatch(/BEGIN PRIVATE KEY/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the .pfx files forge itself makes (the old way, 3DES)', async () => {
    const keys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 });
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date(Date.now() + 86400000);
    cert.setSubject([{ name: 'commonName', value: 'Forge' }]);
    cert.setIssuer([{ name: 'commonName', value: 'Forge' }]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    const p12 = forge.asn1
      .toDer(
        forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], 'pw', {
          algorithm: '3des',
        })
      )
      .getBytes();
    const id = await readPfx(
      Uint8Array.from(p12, (c) => c.charCodeAt(0)),
      'pw'
    );
    expect((await certInfo(id.certDer)).name).toBe('Forge');
  });

  it('PEM: certificate with a PKCS#8, SEC 1 or encrypted key', async () => {
    const { certDer, keyDer } = await testId('ec', 'P-256');
    const b64 = lines;
    const pkcs8 = `-----BEGIN PRIVATE KEY-----\n${b64(keyDer)}\n-----END PRIVATE KEY-----\n`;
    const id = await readPem(pem(certDer) + pkcs8);
    expect(id.keyAlg).toBe('ec');
    expect(id.curve).toBe('P-256');

    // SEC 1 (BEGIN EC PRIVATE KEY): the inner key of the PKCS#8
    const info = forge.asn1.fromDer(Buffer.from(keyDer).toString('binary'));
    const sec1 = Buffer.from(
      (info.value as forge.asn1.Asn1[])[2].value as string,
      'binary'
    );
    // (Web Crypto's PKCS#8 leaves the curve out of the inner key; SEC 1
    // files from OpenSSL have it, so add it back for this test)
    const sec1Asn = forge.asn1.fromDer(sec1.toString('binary'));
    (sec1Asn.value as forge.asn1.Asn1[]).splice(
      2,
      0,
      forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 0, true, [
        forge.asn1.create(
          forge.asn1.Class.UNIVERSAL,
          forge.asn1.Type.OID,
          false,
          forge.asn1.oidToDer('1.2.840.10045.3.1.7').getBytes()
        ),
      ])
    );
    const sec1Der = Buffer.from(forge.asn1.toDer(sec1Asn).getBytes(), 'binary');
    const sec1Pem = `-----BEGIN EC PRIVATE KEY-----\n${b64(sec1Der)}\n-----END EC PRIVATE KEY-----\n`;
    expect((await readPem(sec1Pem + pem(certDer))).curve).toBe('P-256');

    // Encrypted PKCS#8
    const enc = forge.pki.encryptPrivateKeyInfo(
      forge.asn1.fromDer(Buffer.from(keyDer).toString('binary')),
      'secret',
      { algorithm: 'aes256' }
    );
    const encPem = forge.pki.encryptedPrivateKeyToPem(enc);
    await expect(readPem(pem(certDer) + encPem)).rejects.toBeInstanceOf(
      PasswordError
    );
    expect((await readPem(pem(certDer) + encPem, 'secret')).keyAlg).toBe('ec');
    expect(
      (await readIdFile('id.pem', new TextEncoder().encode(pem(certDer) + pkcs8), ''))
        .keyAlg
    ).toBe('ec');
  });

  it('a key that belongs to none of the certificates is refused', async () => {
    const a = await testId('rsa');
    const b = await testId('ec', 'P-256');
    await expect(
      readPfx(makePfx(a.keyDer, [b.certDer], 'x'), 'x')
    ).rejects.toThrow(/doesn’t belong/);
  });
});
