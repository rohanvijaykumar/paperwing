/**
 * Second independent check of PDFs Paperwing signed: each signature's CMS
 * and the bytes it covers go to `openssl cms -verify` (signature and digest;
 * the certificate chain isn't checked, the test IDs are self-signed).
 *
 *   node desktop/tests/openssl-verify.mjs <dir-or-pdf>...
 */
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const files = process.argv.slice(2).flatMap((a) =>
  statSync(a).isDirectory()
    ? readdirSync(a)
        .filter((f) => f.endsWith('.pdf'))
        .map((f) => join(a, f))
    : [a]
);
const dir = mkdtempSync(join(process.env.BENCH_TMP || tmpdir(), 'pw-ossl-'));
let checked = 0;
let failed = 0;
for (const file of files) {
  const pdf = readFileSync(file);
  const text = pdf.toString('latin1');
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  for (const m of text.matchAll(re)) {
    const [a, b, c, d] = m.slice(1, 5).map(Number);
    const hex = text.slice(b + 1, c - 1);
    let cms = Buffer.from(hex, 'hex');
    // The CMS's own length (the placeholder is padded with zeros)
    const len =
      cms[1] < 0x80
        ? cms[1] + 2
        : 2 + (cms[1] & 0x7f) + cms.readUIntBE(2, cms[1] & 0x7f);
    cms = cms.subarray(0, len);
    writeFileSync(join(dir, 'sig.der'), cms);
    writeFileSync(
      join(dir, 'content.bin'),
      Buffer.concat([pdf.subarray(a, a + b), pdf.subarray(c, c + d)])
    );
    checked++;
    try {
      execFileSync(
        'openssl',
        [
          'cms',
          '-verify',
          '-binary',
          '-noverify',
          '-inform',
          'DER',
          '-in',
          join(dir, 'sig.der'),
          '-content',
          join(dir, 'content.bin'),
          '-out',
          join(dir, 'out.bin'),
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      console.log(`ok   ${basename(file)} (bytes ${a}-${b}, ${c}-${c + d})`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${basename(file)}: ${String(e.stderr ?? e).trim()}`);
    }
  }
}
rmSync(dir, { recursive: true, force: true });
console.log(`${checked} signature(s) checked with OpenSSL, ${failed} failed`);
process.exit(failed || !checked ? 1 : 0);
