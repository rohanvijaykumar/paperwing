// Every local module the packaged app loads must be in electron-builder.yml's
// `files`: a missing one only shows up when the installed app starts
// ("Cannot find module …"), never in the dev app or the benches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');

// Loaded only by the development stand-ins (PAPERWING_SCAN_TEST), never shipped
const DEV_ONLY = new Set(['scan-test.cjs']);

function packagedFiles() {
  const yml = readFileSync(join(desktop, 'electron-builder.yml'), 'utf8');
  const block = yml.split(/\r?\n/);
  const start = block.findIndex((l) => /^files:\s*$/.test(l));
  assert.ok(start >= 0, 'electron-builder.yml has a files: list');
  const files = [];
  for (const line of block.slice(start + 1)) {
    const m = /^\s+-\s+(\S+)\s*$/.exec(line);
    if (!m) break;
    files.push(m[1]);
  }
  return files;
}

test('every module the packaged app requires is packaged', () => {
  const files = packagedFiles();
  const listed = new Set(files);
  const missing = [];
  for (const file of files.filter((f) => f.endsWith('.cjs'))) {
    const code = readFileSync(join(desktop, file), 'utf8');
    for (const [, dep] of code.matchAll(
      /require\(\s*['"]\.\/([^'"]+)['"]\s*\)/g
    )) {
      if (!listed.has(dep) && !DEV_ONLY.has(dep))
        missing.push(`${file} → ${dep}`);
    }
  }
  assert.deepEqual(missing, [], 'add these to files: in electron-builder.yml');
});
