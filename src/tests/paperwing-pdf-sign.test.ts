// @vitest-environment node
// Signing PDFs with a key held elsewhere (src/acro/certs/pdf-sign.ts):
// zgapdfsigner with Paperwing's patches, as the app builds it, and the CMS
// builder. Each signed PDF is checked byte range by byte range with pkijs,
// and with Paperwing's own validator (Validate signatures).
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRef,
  degrees,
} from 'pdf-lib';
import { loadPatchedZga } from './helpers/zga-patched';

vi.mock('zgapdfsigner', () => loadPatchedZga());

import {
  lockedBySignature,
  placeholderSize,
  signPdf,
} from '../acro/certs/pdf-sign';
import { OID, type Curve, type KeyAlg } from '../acro/certs/cms';
import { keySigner } from '../acro/certs/file-id';
import { createSelfSignedId } from '../acro/certs/x509';
import type { Fetcher } from '../acro/certs/tsa';
import { validatePdfSignatures } from '../js/logic/validate-signature-pdf';

const SAMPLE = readFileSync(resolve(__dirname, 'fixtures/sample.pdf'));
// PW_SIGNED_OUT=<dir> keeps the signed PDFs (CI checks them with pyHanko)
const OUT = process.env.PW_SIGNED_OUT;

interface TestId {
  certDer: Uint8Array;
  keyDer: Uint8Array;
  keyAlg: KeyAlg;
  curve: Curve | null;
}
const testIds: Record<string, TestId> = {};

beforeAll(async () => {
  for (const [name, keyAlg, curve] of [
    ['rsa', 'rsa', null],
    ['p256', 'ec', 'P-256'],
    ['p384', 'ec', 'P-384'],
  ] as [string, KeyAlg, Curve | null][]) {
    const id = await createSelfSignedId({
      name: `Paperwing Test ${name.toUpperCase()}`,
      org: 'Paperwing tests',
      email: 'signer@example.com',
      keyType: keyAlg,
      curve: curve ?? undefined,
    });
    testIds[name] = { ...id, keyAlg, curve };
  }
});

function keep(name: string, pdf: Uint8Array) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, name), pdf);
}

/** Every signature's CMS, byte range and dictionary */
function signaturesIn(pdf: Uint8Array) {
  const text = Buffer.from(pdf).toString('latin1');
  const out: { range: number[]; cms: Uint8Array; dict: string }[] = [];
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  for (const m of text.matchAll(re)) {
    const range = m.slice(1, 5).map(Number);
    const hex = text.slice(range[1] + 1, range[2] - 1);
    // (with the placeholder's zero padding: asn1js reads just the CMS, and
    // stripping zeros would cut a CMS that ends in a 00 byte)
    const cms = Buffer.from(hex, 'hex');
    // The dictionary around it
    const start = text.lastIndexOf('<<', m.index);
    out.push({
      range,
      cms: new Uint8Array(cms),
      dict: text.slice(start, range[2] + 400),
    });
  }
  return out;
}

async function verifyEach(pdf: Uint8Array) {
  const sigs = signaturesIn(pdf);
  for (const s of sigs) {
    const [a, b, c, d] = s.range;
    expect(a).toBe(0);
    const covered = Buffer.concat([
      Buffer.from(pdf.subarray(a, a + b)),
      Buffer.from(pdf.subarray(c, c + d)),
    ]);
    // The CMS may be followed by zero padding; parse what's there
    const parsed = asn1js.fromBER(s.cms.slice());
    const ci = new pkijs.ContentInfo({ schema: parsed.result });
    const sd = new pkijs.SignedData({ schema: ci.content });
    const ok = await sd.verify({
      signer: 0,
      data: new Uint8Array(covered).buffer,
    });
    expect(ok).toBe(true);
  }
  return sigs;
}

async function signWith(
  name: string,
  extra: Partial<Parameters<typeof signPdf>[0]> = {},
  pdf: Uint8Array = SAMPLE
) {
  const id = testIds[name];
  return signPdf({
    pdf,
    certDer: id.certDer,
    chainDer: [],
    keyAlg: id.keyAlg,
    curve: id.curve,
    sign: await keySigner(id.keyDer, id.keyAlg, id.curve),
    ...extra,
  });
}

describe('signing a PDF with an external key', () => {
  for (const name of ['rsa', 'p256', 'p384']) {
    it(`${name}: a PAdES signature that verifies, and Paperwing's validator agrees`, async () => {
      const signed = await signWith(name, {
        reason: 'I approve this document',
        location: 'Praha',
        appearance: {
          page: 0,
          box: { x: 0.1, y: 0.1, width: 0.4, height: 0.1 },
          png: await tinyPng(),
        },
      });
      keep(`signed-${name}.pdf`, signed);
      const [sig] = await verifyEach(signed);
      expect(sig.dict).toContain('/SubFilter /ETSI.CAdES.detached');
      expect(sig.dict).toContain('/Filter /Adobe.PPKLite');
      expect(sig.dict).toContain('/Name /Paperwing');
      expect(sig.dict).toContain('/M (D:');
      expect(sig.range[2] + sig.range[3]).toBe(signed.length);

      const [result] = await validatePdfSignatures(signed);
      expect(result.cryptoVerified).toBe(true);
      expect(result.coverageStatus).toBe('full');
      expect(result.isValid).toBe(true);
      expect(result.signerName).toBe(`Paperwing Test ${name.toUpperCase()}`);
      expect(result.reason).toBe('I approve this document');
      expect(result.location).toBe('Praha');
    });
  }

  it('places the appearance where the box was drawn', async () => {
    const signed = await signWith('rsa', {
      appearance: {
        page: 0,
        box: { x: 0.25, y: 0.5, width: 0.5, height: 0.125 },
        png: await tinyPng(),
      },
    });
    const doc = await PDFDocument.load(signed);
    const page = doc.getPage(0);
    const { width, height } = page.getSize();
    const annots = page.node.Annots()!;
    const widget = doc.context.lookup(annots.get(annots.size() - 1)) as PDFDict;
    const rect = (widget.get(PDFName.of('Rect')) as PDFArray)
      .asArray()
      .map((n) => (n as PDFNumber).asNumber());
    expect(rect[0]).toBeCloseTo(0.25 * width, 1);
    // From the top: 0.5 down, 0.125 tall
    expect(rect[3]).toBeCloseTo(height * 0.5, 1);
    expect(rect[1]).toBeCloseTo(height * 0.375, 1);
    // (the test image is 2:1, so it's narrower than the box; the app
    // draws the appearance at the box's own proportions)
    expect(rect[2]).toBeLessThanOrEqual(0.75 * width + 0.01);
    expect(widget.get(PDFName.of('AP'))).toBeDefined();
  });

  it('adbe.pkcs7.detached on request', async () => {
    const signed = await signWith('rsa', { subFilter: 'adbe.pkcs7.detached' });
    const [sig] = await verifyEach(signed);
    expect(sig.dict).toContain('/SubFilter /adbe.pkcs7.detached');
    keep('signed-rsa-pkcs7.pdf', signed);
  });

  it('Lock document after signing: FieldMDP reference and the field lock', async () => {
    const signed = await signWith('p256', {
      lock: true,
      appearance: {
        page: 0,
        box: { x: 0.1, y: 0.8, width: 0.3, height: 0.08 },
        png: await tinyPng(),
      },
    });
    keep('signed-locked.pdf', signed);
    await verifyEach(signed);
    const doc = await PDFDocument.load(signed);
    const annots = doc.getPage(0).node.Annots()!;
    const widget = doc.context.lookup(annots.get(annots.size() - 1)) as PDFDict;
    const lock = widget.lookup(PDFName.of('Lock'), PDFDict);
    expect(lock.get(PDFName.of('Action'))).toEqual(PDFName.of('All'));
    expect((lock.get(PDFName.of('P')) as PDFNumber).asNumber()).toBe(1);
    const v = widget.lookup(PDFName.of('V'), PDFDict);
    const ref = v.lookup(PDFName.of('Reference'), PDFArray);
    const sigRef = ref.lookup(0, PDFDict);
    expect(sigRef.get(PDFName.of('TransformMethod'))).toEqual(
      PDFName.of('FieldMDP')
    );
    expect(sigRef.get(PDFName.of('Data'))).toBeInstanceOf(PDFRef);
    // …so it can't be signed again
    expect(await lockedBySignature(signed)).toBe(true);
    expect(await lockedBySignature(await signWith('rsa'))).toBe(false);
    expect(await lockedBySignature(SAMPLE)).toBe(false);
  });

  it('a second signature keeps the first one valid', async () => {
    const first = await signWith('rsa', {
      appearance: {
        page: 0,
        box: { x: 0.05, y: 0.05, width: 0.3, height: 0.08 },
        png: await tinyPng(),
      },
    });
    const second = await signWith(
      'p384',
      {
        appearance: {
          page: 0,
          box: { x: 0.55, y: 0.05, width: 0.3, height: 0.08 },
          png: await tinyPng(),
        },
      },
      first
    );
    keep('signed-twice.pdf', second);
    const sigs = await verifyEach(second);
    expect(sigs).toHaveLength(2);
    const results = await validatePdfSignatures(second);
    expect(results.map((r) => r.cryptoVerified)).toEqual([true, true]);
    // The first covers only its revision; the last covers the whole file
    expect(results[0].coverageStatus).toBe('partial');
    expect(results[1].coverageStatus).toBe('full');
  });

  it('asks for the signature once (the space reserved is enough)', async () => {
    const id = testIds.rsa;
    const inner = await keySigner(id.keyDer, 'rsa', null);
    let calls = 0;
    await signPdf({
      pdf: SAMPLE,
      certDer: id.certDer,
      chainDer: [],
      keyAlg: 'rsa',
      sign: async (r) => {
        calls++;
        return inner(r);
      },
    });
    expect(calls).toBe(1);
    expect(placeholderSize([id.certDer], true)).toBeGreaterThan(
      placeholderSize([id.certDer], false)
    );
  });

  it('a refused signature (cancelled PIN) stops the signing with that error', async () => {
    const id = testIds.rsa;
    const cancelled = Object.assign(new Error('cancelled'), {
      code: 'cancelled',
    });
    await expect(
      signPdf({
        pdf: SAMPLE,
        certDer: id.certDer,
        chainDer: [],
        keyAlg: 'rsa',
        sign: async () => {
          throw cancelled;
        },
      })
    ).rejects.toBe(cancelled);
  });

  it('adds a timestamp from the timestamp server', async () => {
    const tsa = await fakeTsa();
    const signed = await signWith('p256', {
      tsaUrl: 'http://tsa.example/tsr',
      fetcher: tsa.fetcher,
    });
    keep('signed-timestamped.pdf', signed);
    expect(tsa.requests).toBe(1);
    const [sig] = await verifyEach(signed);
    const ci = pkijs.ContentInfo.fromBER(sig.cms.slice());
    const sd = new pkijs.SignedData({ schema: ci.content });
    const attr = sd.signerInfos[0].unsignedAttrs!.attributes.find(
      (a) => a.type === OID.timeStampToken
    )!;
    const token = new pkijs.SignedData({
      schema: new pkijs.ContentInfo({ schema: attr.values[0] }).content,
    });
    const tst = pkijs.TSTInfo.fromBER(
      new Uint8Array(token.encapContentInfo.eContent!.getValue()).slice()
    );
    const sigValue = sd.signerInfos[0].signature.valueBlock.valueHexView;
    const imprint = new Uint8Array(
      await crypto.subtle.digest('SHA-256', sigValue.slice())
    );
    expect([
      ...tst.messageImprint.hashedMessage.valueBlock.valueHexView,
    ]).toEqual([...imprint]);
  });

  it('a timestamp server that fails stops the signing with a plain message', async () => {
    const fetcher: Fetcher = async () => ({
      status: 503,
      body: new Uint8Array(),
    });
    await expect(
      signWith('rsa', { tsaUrl: 'http://tsa.example/tsr', fetcher })
    ).rejects.toThrow(/timestamp server/);
  });

  it('self-signed IDs need no certificate checks (nothing is fetched)', async () => {
    let fetched = 0;
    const fetcher: Fetcher = async () => {
      fetched++;
      throw new Error('offline');
    };
    const signed = await signWith('rsa', { ltv: true, fetcher });
    expect(fetched).toBe(0);
    await verifyEach(signed);
  });
});

/** A small opaque PNG */
async function tinyPng(): Promise<Uint8Array> {
  // 2×1 PNG, red and blue
  return new Uint8Array(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAEElEQVR4nGP4z8DAwMDAAAAZBAEAdEpvSwAAAABJRU5ErkJggg==',
      'base64'
    )
  );
}

/** A timestamp server: signs TSTInfo for each request with its own key */
async function fakeTsa() {
  const keys = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair;
  const { certDer } = await createSelfSignedId({
    name: 'Test TSA',
    keyType: 'ec',
  });
  const cert = pkijs.Certificate.fromBER(certDer.slice());
  // (its own key, so the token's signature checks out against this cert)
  await cert.subjectPublicKeyInfo.importKey(keys.publicKey);
  await cert.sign(keys.privateKey, 'SHA-256');
  const state = { requests: 0, fetcher: null as unknown as Fetcher };
  state.fetcher = async (_url, init) => {
    state.requests++;
    const req = pkijs.TimeStampReq.fromBER(init.body!.slice());
    const tst = new pkijs.TSTInfo({
      version: 1,
      policy: '1.2.3.4',
      messageImprint: req.messageImprint,
      serialNumber: new asn1js.Integer({ value: state.requests }),
      genTime: new Date(),
      nonce: req.nonce,
    });
    const sd = new pkijs.SignedData({
      version: 3,
      encapContentInfo: new pkijs.EncapsulatedContentInfo({
        eContentType: '1.2.840.113549.1.9.16.1.4',
        eContent: new asn1js.OctetString({
          valueHex: tst.toSchema().toBER(),
        }),
      }),
      signerInfos: [
        new pkijs.SignerInfo({
          version: 1,
          sid: new pkijs.IssuerAndSerialNumber({
            issuer: cert.issuer,
            serialNumber: cert.serialNumber,
          }),
        }),
      ],
      certificates: [cert],
    });
    await sd.sign(keys.privateKey, 0, 'SHA-256');
    // pkijs always writes eContent as a constructed OCTET STRING; timestamp
    // servers write a primitive one (pyHanko insists), so put that back
    const schema = sd.toSchema(true);
    const encap = schema.valueBlock.value[2] as asn1js.Sequence;
    (encap.valueBlock.value[1] as asn1js.Constructed).valueBlock.value[0] =
      new asn1js.OctetString({ valueHex: tst.toSchema().toBER() });
    const token = new pkijs.ContentInfo({
      contentType: OID.signedData,
      content: schema,
    });
    const resp = new pkijs.TimeStampResp({
      status: new pkijs.PKIStatusInfo({ status: 0 }),
      timeStampToken: token,
    });
    return {
      status: 200,
      contentType: 'application/timestamp-reply',
      body: new Uint8Array(resp.toSchema().toBER()),
    };
  };
  return state;
}

describe('Validate signatures: trusting root certificates (system roots)', () => {
  /** A certificate for `subjectKeys`, issued by `issuer` (self if absent) */
  async function issue(
    name: string,
    subjectKeys: CryptoKeyPair,
    issuer: { name: string; keys: CryptoKeyPair } | null,
    ca: boolean
  ): Promise<Uint8Array> {
    const dn = (cn: string) => {
      const rdn = new pkijs.RelativeDistinguishedNames();
      rdn.typesAndValues.push(
        new pkijs.AttributeTypeAndValue({
          type: '2.5.4.3',
          value: new asn1js.Utf8String({ value: cn }),
        })
      );
      return rdn;
    };
    const cert = new pkijs.Certificate();
    cert.version = 2;
    cert.serialNumber = new asn1js.Integer({
      value: Math.floor(Math.random() * 1e9),
    });
    cert.subject = dn(name);
    cert.issuer = dn(issuer?.name ?? name);
    cert.notBefore.value = new Date(Date.now() - 86400000);
    cert.notAfter.value = new Date(Date.now() + 86400000 * 365);
    await cert.subjectPublicKeyInfo.importKey(subjectKeys.publicKey);
    cert.extensions = [
      new pkijs.Extension({
        extnID: '2.5.29.19',
        critical: true,
        extnValue: new pkijs.BasicConstraints({ cA: ca })
          .toSchema()
          .toBER(false),
      }),
    ];
    await cert.sign((issuer?.keys ?? subjectKeys).privateKey, 'SHA-256');
    return new Uint8Array(cert.toSchema(true).toBER(false));
  }
  const ec = (curve: string) =>
    crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: curve }, true, [
      'sign',
      'verify',
    ]) as Promise<CryptoKeyPair>;

  it('an ECDSA signer under an ECDSA root is trusted when that root is', async () => {
    const rootKeys = await ec('P-384');
    const leafKeys = await ec('P-256');
    const rootDer = await issue('Test Root CA', rootKeys, null, true);
    const leafDer = await issue(
      'Test Signer',
      leafKeys,
      { name: 'Test Root CA', keys: rootKeys },
      false
    );
    const pkcs8 = new Uint8Array(
      await crypto.subtle.exportKey('pkcs8', leafKeys.privateKey)
    );
    const signed = await signPdf({
      pdf: SAMPLE,
      certDer: leafDer,
      chainDer: [rootDer],
      keyAlg: 'ec',
      curve: 'P-256',
      sign: await keySigner(pkcs8, 'ec', 'P-256'),
    });
    const other = await issue('Another Root', await ec('P-256'), null, true);
    const [trusted] = await validatePdfSignatures(signed, [other, rootDer]);
    expect(trusted.cryptoVerified).toBe(true);
    expect(trusted.isTrusted).toBe(true);
    expect(trusted.signerName).toBe('Test Signer');
    const [untrusted] = await validatePdfSignatures(signed, [other]);
    expect(untrusted.isTrusted).toBe(false);
    const [none] = await validatePdfSignatures(signed);
    expect(none.isTrusted).toBe(false);
  });
});

describe('zgapdfsigner patches', () => {
  it('each fits exactly once; a changed library is reported, not half-patched', async () => {
    const { applyPatches, SIGNER_PATCHES, FETCH_PATCHES, signerPatchesFor } =
      await import('../../reskin/signer-patches');
    const lib = resolve(__dirname, '../../node_modules/zgapdfsigner/lib');
    const signer = readFileSync(join(lib, 'zgapdfsigner.js'), 'utf8');
    const fetchJs = readFileSync(join(lib, 'zgafetch.js'), 'utf8');
    expect(applyPatches(signer, SIGNER_PATCHES).applied).toEqual([
      'external signer',
    ]);
    expect(applyPatches(fetchJs, FETCH_PATCHES).applied).toEqual([
      'signer browser check',
    ]);
    expect(signerPatchesFor('/x/zgapdfsigner/lib/zgapdfsigner.js')).toBe(
      SIGNER_PATCHES
    );
    expect(signerPatchesFor('/x/other.js')).toBeNull();
    // One of the places moved: the whole patch is left out and named
    const moved = signer.replace(
      'var asn1sig = null;',
      'var asn1sig = undefined;'
    );
    const result = applyPatches(moved, SIGNER_PATCHES);
    expect(result.applied).toEqual([]);
    expect(result.missed).toEqual(['external signer']);
    expect(result.code).toBe(moved);
  });
});

describe('long-term validation (DSS)', () => {
  const OCSP_URL = 'http://ocsp.example.test/';

  async function makeChain() {
    const caKeys = (await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify']
    )) as CryptoKeyPair;
    const leafKeys = (await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    )) as CryptoKeyPair;
    const name = (cn: string) => {
      const rdn = new pkijs.RelativeDistinguishedNames();
      rdn.typesAndValues.push(
        new pkijs.AttributeTypeAndValue({
          type: '2.5.4.3',
          value: new asn1js.Utf8String({ value: cn }),
        })
      );
      return rdn;
    };
    const make = async (
      cn: string,
      keys: CryptoKeyPair,
      ca: boolean,
      serial: number
    ) => {
      const c = new pkijs.Certificate();
      c.version = 2;
      c.serialNumber = new asn1js.Integer({ value: serial });
      c.subject = name(cn);
      c.issuer = name('LTV Test CA');
      c.notBefore.value = new Date(Date.now() - 86400000);
      c.notAfter.value = new Date(Date.now() + 86400000 * 365);
      await c.subjectPublicKeyInfo.importKey(keys.publicKey);
      c.extensions = [
        new pkijs.Extension({
          extnID: '2.5.29.19',
          critical: true,
          extnValue: new pkijs.BasicConstraints({ cA: ca })
            .toSchema()
            .toBER(false),
        }),
      ];
      if (!ca)
        c.extensions.push(
          new pkijs.Extension({
            extnID: '1.3.6.1.5.5.7.1.1',
            extnValue: new pkijs.InfoAccess({
              accessDescriptions: [
                new pkijs.AccessDescription({
                  accessMethod: '1.3.6.1.5.5.7.48.1',
                  accessLocation: new pkijs.GeneralName({
                    type: 6,
                    value: OCSP_URL,
                  }),
                }),
              ],
            })
              .toSchema()
              .toBER(false),
          })
        );
      await c.sign(caKeys.privateKey, 'SHA-256');
      return c;
    };
    const ca = await make('LTV Test CA', caKeys, true, 1);
    const leaf = await make('LTV Signer', leafKeys, false, 2);
    return { ca, caKeys, leaf, leafKeys };
  }

  /** An OCSP responder (the CA answers for itself) */
  function responder(
    chain: Awaited<ReturnType<typeof makeChain>>,
    revoked: boolean
  ) {
    const asked: string[] = [];
    const fetcher: Fetcher = async (url, init) => {
      asked.push(url);
      const req = pkijs.OCSPRequest.fromBER(init.body!.slice());
      const basic = new pkijs.BasicOCSPResponse();
      basic.tbsResponseData.responderID = chain.ca.subject;
      basic.tbsResponseData.producedAt = new Date();
      basic.tbsResponseData.responses.push(
        new pkijs.SingleResponse({
          certID: req.tbsRequest.requestList[0].reqCert,
          certStatus: revoked
            ? new asn1js.Constructed({
                idBlock: { tagClass: 3, tagNumber: 1 },
                value: [new asn1js.GeneralizedTime({ valueDate: new Date() })],
              })
            : new asn1js.Primitive({ idBlock: { tagClass: 3, tagNumber: 0 } }),
          thisUpdate: new Date(),
        })
      );
      basic.certs = [chain.ca];
      await basic.sign(chain.caKeys.privateKey, 'SHA-256');
      const resp = new pkijs.OCSPResponse({
        responseStatus: new asn1js.Enumerated({ value: 0 }),
        responseBytes: new pkijs.ResponseBytes({
          responseType: '1.3.6.1.5.5.7.48.1.1',
          response: new asn1js.OctetString({
            valueHex: basic.toSchema().toBER(false),
          }),
        }),
      });
      return {
        status: 200,
        contentType: 'application/ocsp-response',
        body: new Uint8Array(resp.toSchema().toBER(false)),
      };
    };
    return { fetcher, asked };
  }

  async function sign(
    chain: Awaited<ReturnType<typeof makeChain>>,
    fetcher: Fetcher
  ) {
    const der = (c: pkijs.Certificate) =>
      new Uint8Array(c.toSchema().toBER(false));
    return signPdf({
      pdf: SAMPLE,
      certDer: der(chain.leaf),
      chainDer: [der(chain.ca)],
      keyAlg: 'ec',
      curve: 'P-256',
      sign: await keySigner(
        new Uint8Array(
          await crypto.subtle.exportKey('pkcs8', chain.leafKeys.privateKey)
        ),
        'ec',
        'P-256'
      ),
      ltv: true,
      fetcher,
    });
  }

  it('adds the OCSP reply and the certificates to the DSS, after the signature', async () => {
    const chain = await makeChain();
    const { fetcher, asked } = responder(chain, false);
    const signed = await sign(chain, fetcher);
    expect(asked).toEqual([OCSP_URL]);
    const doc = await PDFDocument.load(signed);
    const dss = doc.catalog.lookup(PDFName.of('DSS'), PDFDict);
    expect(dss.lookup(PDFName.of('OCSPs'), PDFArray).size()).toBe(1);
    expect(dss.lookup(PDFName.of('Certs'), PDFArray).size()).toBe(2);
    expect(dss.lookup(PDFName.of('VRI'), PDFDict).keys()).toHaveLength(1);
    // (the signature still verifies: the DSS is an update after it)
    await verifyEach(signed);
    const [r] = await validatePdfSignatures(signed);
    expect(r.cryptoVerified).toBe(true);
  });

  it('a revoked certificate stops the signing with a plain message', async () => {
    const chain = await makeChain();
    const { fetcher } = responder(chain, true);
    await expect(sign(chain, fetcher)).rejects.toThrow(/revoked/);
  });

  it('a responder that can’t be reached leaves the DSS out; the signature stands', async () => {
    const chain = await makeChain();
    const signed = await sign(chain, async () => {
      throw new Error('offline');
    });
    const doc = await PDFDocument.load(signed);
    expect(doc.catalog.lookup(PDFName.of('DSS'))).toBeUndefined();
    await verifyEach(signed);
  });
});

describe('placement on rotated and cropped pages', () => {
  /** A page with this rotation, CropBox (and MediaBox) */
  async function page(rotate: number, media: number[], crop: number[]) {
    const doc = await PDFDocument.create();
    const p = doc.addPage([media[2] - media[0], media[3] - media[1]]);
    p.setMediaBox(media[0], media[1], media[2] - media[0], media[3] - media[1]);
    p.setCropBox(crop[0], crop[1], crop[2] - crop[0], crop[3] - crop[1]);
    p.setRotation(degrees(rotate));
    return doc.save();
  }

  /** Where pdf.js (independently) says that box is in PDF user space: the
   *  box is in the page's own frame (unrotated), as the viewer's page
   *  layer measures it */
  async function expected(
    pdf: Uint8Array,
    box: { x: number; y: number; width: number; height: number }
  ) {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: pdf.slice() }).promise;
    const vp = (await doc.getPage(1)).getViewport({ scale: 1, rotation: 0 });
    const [ax, ay] = vp.convertToPdfPoint(box.x * vp.width, box.y * vp.height);
    const [bx, by] = vp.convertToPdfPoint(
      (box.x + box.width) * vp.width,
      (box.y + box.height) * vp.height
    );
    await doc.destroy();
    return [
      Math.min(ax, bx),
      Math.min(ay, by),
      Math.max(ax, bx),
      Math.max(ay, by),
    ];
  }

  for (const rotate of [0, 90, 180, 270])
    for (const [label, media, crop] of [
      ['full page', [0, 0, 612, 792], [0, 0, 612, 792]],
      ['offset CropBox', [0, 0, 612, 792], [40, 90, 520, 700]],
      ['offset MediaBox and CropBox', [20, 30, 632, 822], [60, 120, 540, 760]],
    ] as [string, number[], number[]][])
      it(`/Rotate ${rotate}, ${label}: the field lands where the box was drawn`, async () => {
        const pdf = await page(rotate, media, crop);
        const box = { x: 0.15, y: 0.6, width: 0.45, height: 0.12 };
        const signed = await signWith(
          'rsa',
          {
            appearance: { page: 0, box, png: await tinyPng() },
          },
          pdf
        );
        const doc = await PDFDocument.load(signed);
        const annots = doc.getPage(0).node.Annots()!;
        const widget = doc.context.lookup(
          annots.get(annots.size() - 1)
        ) as PDFDict;
        const r = (widget.get(PDFName.of('Rect')) as PDFArray)
          .asArray()
          .map((n) => (n as PDFNumber).asNumber());
        // Corners in order (PDFium draws nothing for a swapped one)
        expect(r[0]).toBeLessThan(r[2]);
        expect(r[1]).toBeLessThan(r[3]);
        const rect = [
          Math.min(r[0], r[2]),
          Math.min(r[1], r[3]),
          Math.max(r[0], r[2]),
          Math.max(r[1], r[3]),
        ];
        const want = await expected(pdf, box);
        // The test image is 2:1, so the field may be narrower than the box
        // along the page's shown width: check the corner it's anchored to
        // and that it stays inside the box
        for (let i = 0; i < 4; i++) {
          expect(rect[i]).toBeGreaterThanOrEqual(want[i < 2 ? i : i - 2] - 0.5);
          expect(rect[i]).toBeLessThanOrEqual(want[i < 2 ? i + 2 : i] + 0.5);
        }
        // The test image (2:1) keeps its proportions, so the field fills
        // the box in one direction
        const fills = [0, 1].some(
          (i) => Math.abs(rect[i + 2] - rect[i] - (want[i + 2] - want[i])) < 0.5
        );
        expect(fills).toBe(true);
        await verifyEach(signed);
      });
});
