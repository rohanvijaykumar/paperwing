// @vitest-environment node
// The real certificate helper with real test certificates (CI: Windows
// certificate store, macOS keychain; see .github/workflows). Skipped unless
//   PW_CERTS_HELPER=<paperwing-certs[.exe]>
//   PW_TEST_CERTS=<JSON written by test-certs.ps1 / mac-test-certs.sh>
// It lists the IDs, checks Acrobat's filters on them, signs real PDFs with
// each usable one through the helper (the key stays in the store), and
// checks every signature. PW_SIGNED_OUT keeps the PDFs for pyHanko and
// OpenSSL (the workflow runs them next).
import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { loadPatchedZga } from './helpers/zga-patched';

vi.mock('zgapdfsigner', () => loadPatchedZga());

import { signPdf } from '../acro/certs/pdf-sign';
import {
  CertSignError,
  fromBase64,
  installedIds,
  installedSigner,
} from '../acro/certs/ids';
import { validatePdfSignatures } from '../js/logic/validate-signature-pdf';
import type { CertsBridge, InstalledCert } from '../acro/desktop';

const HELPER = process.env.PW_CERTS_HELPER;
const SPEC = process.env.PW_TEST_CERTS;
const OUT = process.env.PW_SIGNED_OUT;

interface TestCert {
  label: string;
  id: string;
  keyAlg: 'rsa' | 'ec';
  curve: string | null;
  expect: 'usable' | 'hidden' | 'expired';
  name: string;
}

function run(args: string[]): Record<string, unknown> {
  let out: string;
  try {
    out = execFileSync(HELPER!, args, { encoding: 'utf8' });
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? '');
  }
  const line = out.split(/\r?\n/).find((l) => l.startsWith('{'));
  return line ? JSON.parse(line) : { type: 'error', code: 'failed' };
}

/** The bridge as the app's main process provides it, over the real helper */
const bridge: CertsBridge = {
  async list() {
    const msg = run(['list']);
    return {
      ok: msg.type === 'certs',
      certs: (msg.certs as InstalledCert[]) ?? [],
    };
  },
  async sign(id, hash, alg) {
    const msg = run(['sign', '-Id', id, '-Hash', hash, '-Alg', alg]);
    return msg.type === 'signature'
      ? { ok: true, sig: msg.sig as string }
      : { ok: false, error: msg.code as never };
  },
  async roots() {
    const msg = run(['roots']);
    return { ok: msg.type === 'roots', certs: (msg.certs as string[]) ?? [] };
  },
  async fetch() {
    return { status: 503, error: 'offline in tests' };
  },
};

const SAMPLE = readFileSync(resolve(__dirname, 'fixtures/sample.pdf'));

describe.skipIf(!HELPER || !SPEC)('the certificate helper, for real', () => {
  const spec: TestCert[] = SPEC
    ? JSON.parse(readFileSync(SPEC, 'utf8').replace(/^﻿/, ''))
    : [];

  it('lists the test IDs without opening their keys, with the right details', async () => {
    const { ids, error } = await installedIds(bridge);
    expect(error).toBeUndefined();
    for (const t of spec) {
      const id = ids.find((i) => i.key === `installed:${t.id}`);
      expect(id, `${t.label} is listed`).toBeDefined();
      expect(id!.info.name).toBe(t.name);
      expect(id!.keyAlg).toBe(t.keyAlg);
      if (t.curve) expect(id!.curve).toBe(t.curve);
      if (t.expect === 'usable') expect(id!.status.usable).toBe(true);
      if (t.expect === 'hidden')
        expect(id!.status).toMatchObject({ usable: false, hidden: true });
      if (t.expect === 'expired') {
        expect(id!.status).toMatchObject({ usable: false, hidden: false });
        expect(id!.status.reason).toMatch(/expired/);
      }
    }
  });

  for (const t of spec.filter((s) => s.expect === 'usable')) {
    it(`${t.label}: signs a PDF through the helper; the signature checks out`, async () => {
      const certs = (await bridge.list()).certs;
      const c = certs.find((x) => x.id === t.id)!;
      const certDer = fromBase64(c.certDer);
      const signed = await signPdf({
        pdf: SAMPLE,
        certDer,
        chainDer: c.chainDer.map(fromBase64),
        keyAlg: t.keyAlg,
        curve: t.curve as never,
        sign: installedSigner(bridge, t.id),
        reason: 'Paperwing CI',
        location: 'GitHub Actions',
        lock: t.label === 'p256',
      });
      if (OUT) {
        mkdirSync(OUT, { recursive: true });
        writeFileSync(join(OUT, `store-${t.label}.pdf`), signed);
      }
      const text = Buffer.from(signed).toString('latin1');
      const m = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(
        text
      )!;
      const [a, b, cc, d] = m.slice(1).map(Number);
      const covered = Buffer.concat([
        signed.subarray(a, a + b),
        signed.subarray(cc, cc + d),
      ]);
      // (zero padding included: asn1js reads just the CMS, which may itself
      // end in a 00 byte)
      const hex = text.slice(b + 1, cc - 1);
      const ci = new pkijs.ContentInfo({
        schema: asn1js.fromBER(Buffer.from(hex, 'hex')).result,
      });
      const sd = new pkijs.SignedData({ schema: ci.content });
      expect(
        await sd.verify({ signer: 0, data: new Uint8Array(covered).buffer })
      ).toBe(true);
      const [result] = await validatePdfSignatures(signed, [certDer]);
      expect(result.cryptoVerified).toBe(true);
      expect(result.isValid).toBe(true);
      expect(result.isTrusted).toBe(true);
    });
  }

  it('an ID that isn’t there is refused, without a prompt', async () => {
    const sign = installedSigner(
      bridge,
      process.platform === 'darwin'
        ? 'kc:0000000000000000000000000000000000000000'
        : 'cu:0000000000000000000000000000000000000000'
    );
    await expect(
      sign({
        data: new Uint8Array(),
        digest: new Uint8Array(32),
        hash: 'sha256',
      })
    ).rejects.toMatchObject({
      code: 'key-unusable',
    } satisfies Partial<CertSignError>);
  });

  it('lists the trusted root certificates', async () => {
    const { ok, certs } = await bridge.roots();
    expect(ok).toBe(true);
    expect(certs.length).toBeGreaterThan(5);
  });
});
