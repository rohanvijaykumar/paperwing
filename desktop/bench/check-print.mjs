/**
 * Printing in real Electron (print.cjs is otherwise tested with stand-ins,
 * tests/print.test.mjs): Chromium's PDF viewer reports a document loaded,
 * the OS default printer is found and preselected, and a web page becomes
 * a PDF. Nothing is printed.
 *   node bench/check-print.mjs [more.pdf…]
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const ELECTRON = require('electron');
const TMP = process.env.BENCH_TMP || tmpdir();

const sample = resolve(
  here,
  '..',
  '..',
  'src',
  'tests',
  'fixtures',
  'sample.pdf'
);
// Twice: a second job in the same session must work too
const pdfs = [sample, sample, ...process.argv.slice(2)];
const userData = mkdtempSync(join(TMP, 'pw-print-'));
const run = spawnSync(
  ELECTRON,
  [join(here, 'print-probe.cjs'), userData, ...pdfs],
  { encoding: 'utf8', timeout: 180000, env: { ...process.env, TEMP: TMP, TMP } }
);
rmSync(userData, {
  recursive: true,
  force: true,
  maxRetries: 10,
  retryDelay: 200,
});

const line = (run.stdout || '')
  .split('\n')
  .find((l) => l.startsWith('{"checks"'));
if (!line) {
  console.log(
    `FAIL the probe didn't report: ${run.error ?? run.stderr?.slice(-400)}`
  );
  process.exit(1);
}
let failed = 0;
for (const c of JSON.parse(line).checks) {
  if (!c.ok) failed++;
  console.log(
    `${c.ok ? 'ok  ' : 'FAIL'} ${c.what}${c.detail ? `: ${c.detail}` : ''}`
  );
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
