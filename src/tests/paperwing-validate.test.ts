// @vitest-environment node
// Validate signatures on documents signed several times, changed after
// signing, timestamped, and what it tells the user about each
// (src/js/logic: signature-changes, signature-timestamps, signature-verdict).
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef } from 'pdf-lib';
import { loadPatchedZga } from './helpers/zga-patched';

vi.mock('zgapdfsigner', () => loadPatchedZga());

import { signPdf } from '../acro/certs/pdf-sign';
import { OID } from '../acro/certs/cms';
import { keySigner } from '../acro/certs/file-id';
import { createSelfSignedId } from '../acro/certs/x509';
import type { Fetcher } from '../acro/certs/tsa';
import {
  pdfDateToIso,
  validateDocTimestamps,
  validatePdfSignatures,
} from '../js/logic/validate-signature-pdf';
import { laterChanges } from '../js/logic/signature-changes';
import {
  signatureVerdict,
  timestampVerdict,
} from '../js/logic/signature-verdict';
import type { SignatureValidationResult } from '@/types';

const SAMPLE = new Uint8Array(
  readFileSync(resolve(__dirname, 'fixtures/sample.pdf'))
);

let alice: Awaited<ReturnType<typeof createSelfSignedId>>;
let bob: Awaited<ReturnType<typeof createSelfSignedId>>;

beforeAll(async () => {
  alice = await createSelfSignedId({ name: 'Alice Signer', keyType: 'ec' });
  bob = await createSelfSignedId({ name: 'Bob Signer', keyType: 'rsa' });
});

async function sign(
  pdf: Uint8Array,
  who: typeof alice,
  extra: Partial<Parameters<typeof signPdf>[0]> = {}
) {
  const keyAlg = who === alice ? 'ec' : 'rsa';
  const curve = who === alice ? 'P-256' : null;
  return signPdf({
    pdf,
    certDer: who.certDer,
    chainDer: [],
    keyAlg,
    curve,
    sign: await keySigner(who.keyDer, keyAlg, curve),
    appearance: {
      page: 0,
      box: { x: 0.1, y: who === alice ? 0.1 : 0.3, width: 0.3, height: 0.1 },
      png: PNG,
    },
    ...extra,
  });
}

// 1×1 white PNG
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='
  ),
  (c) => c.charCodeAt(0)
);

const latin1 = (b: Uint8Array) => new TextDecoder('latin1').decode(b);

function byteRanges(pdf: Uint8Array): number[][] {
  return [
    ...latin1(pdf).matchAll(
      /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g
    ),
  ].map((m) => m.slice(1, 5).map(Number));
}

/**
 * Adds an incremental update (as another app would when editing a signed
 * document): new versions of objects, by number, with a proper xref
 * section and trailer
 */
async function appendUpdate(
  pdf: Uint8Array,
  objects: { ref: PDFRef; body: string }[]
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const text = latin1(pdf);
  const prev = Number([...text.matchAll(/startxref\s+(\d+)/g)].pop()![1]);
  let out = '\n';
  const offsets: [number, number][] = [];
  for (const { ref, body } of objects) {
    offsets.push([ref.objectNumber, pdf.length + out.length]);
    out += `${ref.objectNumber} ${ref.generationNumber} obj\n${body}\nendobj\n`;
  }
  const xrefAt = pdf.length + out.length;
  out += 'xref\n0 1\n0000000000 65535 f \n';
  for (const [num, at] of offsets)
    out += `${num} 1\n${String(at).padStart(10, '0')} 00000 n \n`;
  const size = Math.max(
    doc.context.largestObjectNumber + 1,
    ...objects.map((o) => o.ref.objectNumber + 1)
  );
  out += `trailer\n<< /Size ${size} /Root ${doc.context.trailerInfo.Root} /Prev ${prev} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  const tail = Uint8Array.from(out, (c) => c.charCodeAt(0));
  const all = new Uint8Array(pdf.length + tail.length);
  all.set(pdf);
  all.set(tail, pdf.length);
  return all;
}

async function firstPage(pdf: Uint8Array) {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const page = doc.getPage(0);
  return { doc, ref: page.ref, dict: page.node as PDFDict };
}

describe('changes after a signature', () => {
  it('signed by two people: both valid, the first covering its version', async () => {
    const once = await sign(SAMPLE, alice);
    const twice = await sign(once, bob);
    const [first, second] = byteRanges(twice);
    expect(await laterChanges(twice, first)).toEqual({
      kind: 'signing',
      details: [],
    });
    expect((await laterChanges(twice, second)).kind).toBe('none');
    const results = await validatePdfSignatures(twice);
    expect(results.map((r) => r.signerName)).toEqual([
      'Alice Signer',
      'Bob Signer',
    ]);
    expect(results.map((r) => r.coverageStatus)).toEqual(['partial', 'full']);
    expect(results.map((r) => r.isValid)).toEqual([true, true]);
    expect(results[0].laterChanges).toBe('signing');
    const verdict = signatureVerdict(results[0], false);
    expect(verdict.notes.join(' ')).toMatch(/More signatures .* added/);
  });

  it('signed after a signature that locked the document: a change', async () => {
    const locked = await sign(SAMPLE, alice, { lock: true });
    const twice = await sign(locked, bob);
    const later = await laterChanges(twice, byteRanges(twice)[0]);
    expect(later.kind).toBe('other');
    expect(later.details.join()).toMatch(/locked the document/);
    const [first] = await validatePdfSignatures(twice);
    expect(first.isValid).toBe(false);
    expect(signatureVerdict(first, false).title).toBe('Changed after signing');
  });

  it('a comment added after signing: changed, and it says what', async () => {
    const signed = await sign(SAMPLE, alice);
    const { doc, ref, dict } = await firstPage(signed);
    const annot = PDFRef.of(doc.context.largestObjectNumber + 1);
    const page = dict.clone(doc.context);
    const annots = page.lookup(PDFName.of('Annots'), PDFArray).clone();
    annots.push(annot);
    page.set(PDFName.of('Annots'), annots);
    const edited = await appendUpdate(signed, [
      {
        ref: annot,
        body: '<< /Type /Annot /Subtype /Text /Rect [50 50 70 70] /Contents (Added later) >>',
      },
      { ref, body: page.toString() },
    ]);
    const [result] = await validatePdfSignatures(edited);
    expect(result.cryptoVerified).toBe(true);
    expect(result.coverageStatus).toBe('partial');
    expect(result.laterChanges).toBe('other');
    expect(result.laterChangeDetails).toEqual([
      'page 1: a comment or mark was added',
    ]);
    expect(result.isValid).toBe(false);
    const verdict = signatureVerdict(result, false);
    expect(verdict.level).toBe('warning');
    expect(verdict.explanation).toMatch(
      /changed afterwards: page 1: a comment or mark was added/
    );
  });

  it('new text drawn on the page after signing: changed', async () => {
    const signed = await sign(SAMPLE, alice);
    const { doc, ref, dict } = await firstPage(signed);
    const content = PDFRef.of(doc.context.largestObjectNumber + 1);
    const page = dict.clone(doc.context);
    const old = page.get(PDFName.of('Contents'))!;
    page.set(PDFName.of('Contents'), doc.context.obj([old, content]));
    const body = 'BT /F1 24 Tf 72 100 Td (PAY 1,000,000) Tj ET';
    const edited = await appendUpdate(signed, [
      {
        ref: content,
        body: `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
      },
      { ref, body: page.toString() },
    ]);
    const [result] = await validatePdfSignatures(edited);
    expect(result.laterChanges).toBe('other');
    expect(result.laterChangeDetails).toContain('page 1 was changed');
    expect(result.isValid).toBe(false);
  });

  it('one byte of what was signed changed: invalid, in plain words', async () => {
    const signed = await sign(SAMPLE, alice);
    const at = latin1(signed).indexOf('/MediaBox') + 12;
    const tampered = signed.slice();
    tampered[at] = tampered[at] === 0x35 ? 0x36 : 0x35;
    const [result] = await validatePdfSignatures(tampered);
    expect(result.cryptoVerified).toBe(false);
    expect(result.isValid).toBe(false);
    const verdict = signatureVerdict(result, false);
    expect(verdict.level).toBe('invalid');
    expect(verdict.title).toBe(
      'Invalid: the document was changed after it was signed'
    );
  });
});

describe('timestamps', () => {
  it('a signature’s timestamp is checked and shown; expiry is judged by it', async () => {
    const tsa = await fakeTsa();
    const signed = await sign(SAMPLE, alice, {
      tsaUrl: 'http://tsa.example/tsr',
      fetcher: tsa.fetcher,
    });
    const [result] = await validatePdfSignatures(signed);
    expect(result.isValid).toBe(true);
    expect(result.timestamp?.problem).toBeUndefined();
    expect(result.timestamp).toMatchObject({
      authority: 'Test TSA',
      valid: true,
    });
    expect(
      Math.abs(result.timestamp!.time.getTime() - Date.now())
    ).toBeLessThan(60000);
    expect(signatureVerdict(result, false).notes[0]).toMatch(
      /^Timestamped by Test TSA on /
    );
  });

  it('a document timestamp: valid, and invalid once the document changes', async () => {
    const tsa = await fakeTsa();
    const stamped = await withDocTimestamp(SAMPLE, tsa.fetcher);
    const [ts] = await validateDocTimestamps(stamped);
    expect(ts).toMatchObject({
      valid: true,
      authority: 'Test TSA',
      coverageStatus: 'full',
      isTrusted: false,
    });
    expect(timestampVerdict(ts).title).toBe(
      'Timestamp intact: authority not verified'
    );
    // Trusting the timestamp server's certificate
    const [trusted] = await validateDocTimestamps(stamped, [tsa.certDer]);
    expect(trusted.isTrusted).toBe(true);
    expect(timestampVerdict(trusted).level).toBe('valid');
    // (still no signatures: a document timestamp isn't one)
    expect(await validatePdfSignatures(stamped)).toEqual([]);

    const at = latin1(stamped).indexOf('/MediaBox') + 12;
    const tampered = stamped.slice();
    tampered[at] = tampered[at] === 0x35 ? 0x36 : 0x35;
    const [bad] = await validateDocTimestamps(tampered);
    expect(bad.valid).toBe(false);
    expect(bad.problem).toMatch(/changed/);
    expect(timestampVerdict(bad).level).toBe('invalid');
  });

  it('a document timestamp after a signature leaves it valid', async () => {
    const tsa = await fakeTsa();
    const signed = await sign(SAMPLE, alice);
    const stamped = await withDocTimestamp(signed, tsa.fetcher);
    const [sig] = await validatePdfSignatures(stamped);
    expect(sig.laterChanges).toBe('signing');
    expect(sig.isValid).toBe(true);
  });
});

describe('what Validate signatures says', () => {
  const base: SignatureValidationResult = {
    signatureIndex: 0,
    isValid: true,
    signerName: 'Alice',
    issuer: 'Example CA',
    validFrom: new Date('2026-01-01'),
    validTo: new Date('2027-01-01'),
    isExpired: false,
    isSelfSigned: false,
    isTrusted: true,
    algorithms: { digest: 'SHA-256', signature: 'RSA' },
    serialNumber: '01',
    coverageStatus: 'full',
    cryptoVerified: true,
    cryptoVerificationStatus: 'verified',
  };
  const v = (r: Partial<SignatureValidationResult>, trusting = true) =>
    signatureVerdict({ ...base, ...r }, trusting);

  it('valid', () => {
    expect(v({})).toMatchObject({ level: 'valid', title: 'Valid Signature' });
  });
  it('self-signed: intact, identity not verified, and how to check', () => {
    const r = v({ isTrusted: false, isSelfSigned: true }, false);
    expect(r.level).toBe('warning');
    expect(r.explanation).toMatch(/self-signed/);
    expect(r.explanation).toMatch(/fingerprint/);
  });
  it('issued by a CA nobody trusts here: says how to trust it', () => {
    expect(v({ isTrusted: false }, false).explanation).toMatch(
      /trust the root certificates/
    );
    expect(v({ isTrusted: false }, true).explanation).toMatch(
      /doesn’t lead to a certificate you trust/
    );
  });
  it('expired, with no timestamp', () => {
    const r = v({ isExpired: true, expiredNow: true });
    expect(r.title).toBe('Certificate Expired');
    expect(r.explanation).toMatch(/no timestamp/);
  });
  it('expired since, but timestamped while valid: valid, with a note', () => {
    const r = v({
      isExpired: false,
      expiredNow: true,
      timestamp: {
        time: new Date('2026-06-01'),
        authority: 'TSA',
        valid: true,
      },
    });
    expect(r.level).toBe('valid');
    expect(r.notes.join(' ')).toMatch(/expired since/);
  });
  it('changed after signing, or tampered with', () => {
    expect(
      v({
        isValid: false,
        coverageStatus: 'partial',
        laterChanges: 'other',
        laterChangeDetails: ['page 2 was changed'],
      }).explanation
    ).toMatch(/page 2 was changed/);
    expect(
      v({
        isValid: false,
        cryptoVerified: false,
        cryptoVerificationStatus: 'failed',
        errorMessage: 'Content hash does not match',
      }).level
    ).toBe('invalid');
  });
});

describe('signature dates', () => {
  it('keeps the time zone (UTC, or an offset)', () => {
    expect(new Date(pdfDateToIso('D:20261107170337Z')!).toISOString()).toBe(
      '2026-11-07T17:03:37.000Z'
    );
    expect(
      new Date(pdfDateToIso("D:20261107120337-05'00'")!).toISOString()
    ).toBe('2026-11-07T17:03:37.000Z');
    expect(
      new Date(pdfDateToIso("D:20261107183037+01'30")!).toISOString()
    ).toBe('2026-11-07T17:00:37.000Z');
    expect(pdfDateToIso('yesterday')).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */

/** A document timestamp added as an incremental update (/DocTimeStamp
 *  over the whole file, its token from `fetcher`) */
async function withDocTimestamp(
  pdf: Uint8Array,
  fetcher: Fetcher
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const num = doc.context.largestObjectNumber + 1;
  const HEX = 8192;
  const head = `\n${num} 0 obj\n<< /Type /DocTimeStamp /Filter /Adobe.PPKLite /SubFilter /ETSI.RFC3161 /ByteRange [0 ********** ********** **********] /Contents <`;
  const tailText = '> >>\nendobj\n';
  const start = pdf.length + head.length - 1; // the "<"
  const end = start + 1 + HEX + 1;
  const total = pdf.length + head.length + HEX + tailText.length;
  const range = [0, start, end, total - end];
  const fill = (n: number) => String(n).padEnd(10, ' ');
  const headText = head.replace(
    '[0 ********** ********** **********]',
    `[0 ${fill(range[1])} ${fill(range[2])} ${fill(range[3])}]`
  );
  const bytes = new Uint8Array(total);
  bytes.set(pdf);
  const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
  bytes.set(enc(headText), pdf.length);
  bytes.set(enc('0'.repeat(HEX)), pdf.length + headText.length);
  bytes.set(enc(tailText), pdf.length + headText.length + HEX);
  const covered = new Uint8Array(range[1] + range[3]);
  covered.set(bytes.subarray(0, range[1]));
  covered.set(bytes.subarray(range[2]), range[1]);
  const imprint = new Uint8Array(
    await crypto.subtle.digest('SHA-256', covered)
  );
  const req = new pkijs.TimeStampReq({
    version: 1,
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({
        algorithmId: '2.16.840.1.101.3.4.2.1',
      }),
      hashedMessage: new asn1js.OctetString({ valueHex: imprint.buffer }),
    }),
    certReq: true,
  });
  const res = await fetcher('http://tsa.example/tsr', {
    method: 'POST',
    body: new Uint8Array(req.toSchema().toBER()),
  });
  const resp = pkijs.TimeStampResp.fromBER(res.body.slice());
  const token = new Uint8Array(resp.timeStampToken!.toSchema().toBER());
  const hex = [...token].map((b) => b.toString(16).padStart(2, '0')).join('');
  bytes.set(enc(hex), pdf.length + headText.length);
  return bytes;
}

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
  await cert.subjectPublicKeyInfo.importKey(keys.publicKey);
  await cert.sign(keys.privateKey, 'SHA-256');
  let serial = 0;
  const fetcher: Fetcher = async (_url, init) => {
    const req = pkijs.TimeStampReq.fromBER(init.body!.slice());
    const tst = new pkijs.TSTInfo({
      version: 1,
      policy: '1.2.3.4',
      messageImprint: req.messageImprint,
      serialNumber: new asn1js.Integer({ value: ++serial }),
      genTime: new Date(),
      nonce: req.nonce,
    });
    const sd = new pkijs.SignedData({
      version: 3,
      encapContentInfo: new pkijs.EncapsulatedContentInfo({
        eContentType: '1.2.840.113549.1.9.16.1.4',
        eContent: new asn1js.OctetString({ valueHex: tst.toSchema().toBER() }),
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
    const schema = sd.toSchema(true);
    const encap = schema.valueBlock.value[2] as asn1js.Sequence;
    (encap.valueBlock.value[1] as asn1js.Constructed).valueBlock.value[0] =
      new asn1js.OctetString({ valueHex: tst.toSchema().toBER() });
    const resp = new pkijs.TimeStampResp({
      status: new pkijs.PKIStatusInfo({ status: 0 }),
      timeStampToken: new pkijs.ContentInfo({
        contentType: OID.signedData,
        content: schema,
      }),
    });
    return {
      status: 200,
      contentType: 'application/timestamp-reply',
      body: new Uint8Array(resp.toSchema().toBER()),
    };
  };
  return { fetcher, certDer: new Uint8Array(cert.toSchema().toBER()) };
}
