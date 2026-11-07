#!/usr/bin/env node
// Builds Paperwing's scanner helpers for Windows (.NET Framework 4.8, built
// into Windows 10 and 11):
//   paperwing-scan.exe     x64: WIA (2.0, falling back to 1.0) and 64-bit TWAIN
//   paperwing-twain32.exe  x86: 32-bit TWAIN drivers
//
//   node desktop/native/win-scanner/build.mjs [--test]
//
// Needs the .NET SDK (dotnet on PATH, or DOTNET pointing at it). Output in
// desktop/native/win-scanner/out, which electron-builder ships as
// resources/scanner (see electron-builder.yml and scripts/after-pack.cjs).
// --test also runs the unit tests and checks the built helpers start and
// answer (no scanner needed).
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'out');
const test = process.argv.includes('--test');
const dotnet = process.env.DOTNET || 'dotnet';

if (process.platform !== 'win32') {
  console.error('The Windows scanner helpers build on Windows only.');
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: here, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    console.error(`${cmd} exited with ${r.status}`);
    process.exit(r.status || 1);
  }
}

const common = [
  '-c',
  'Release',
  '-nologo',
  '-p:ContinuousIntegrationBuild=true',
];
run(dotnet, ['build', 'paperwing-scan/paperwing-scan.csproj', ...common]);
run(dotnet, ['build', 'paperwing-twain32/paperwing-twain32.csproj', ...common]);
if (test) run(dotnet, ['test', 'tests/PaperwingScan.Tests.csproj', ...common]);

// Both helpers in one folder: the managed libraries are the same for x64 and x86
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const files = [
  ['paperwing-scan', 'paperwing-scan.exe'],
  ['paperwing-scan', 'paperwing-scan.exe.config'],
  ['paperwing-scan', 'NAPS2.Wia.dll'],
  ['paperwing-scan', 'NTwain.dll'],
  ['paperwing-twain32', 'paperwing-twain32.exe'],
  ['paperwing-twain32', 'paperwing-twain32.exe.config'],
];
for (const [project, name] of files) {
  const from = join(here, project, 'bin', 'Release', name);
  if (!existsSync(from)) {
    console.error(`Missing build output: ${from}`);
    process.exit(1);
  }
  copyFileSync(from, join(out, name));
}
copyFileSync(
  join(here, 'THIRD-PARTY-NOTICES.txt'),
  join(out, 'THIRD-PARTY-NOTICES.txt')
);

let total = 0;
for (const name of readdirSync(out)) {
  const size = statSync(join(out, name)).size;
  total += size;
  console.log(
    `  ${name.padEnd(32)} ${(size / 1024).toFixed(0).padStart(6)} KB`
  );
}
console.log(
  `  ${'total'.padEnd(32)} ${(total / 1024).toFixed(0).padStart(6)} KB`
);

if (test) {
  // With or without scanners, both list (and say so on one JSON line) and
  // report an unknown scanner as such
  for (const [exe, prefix] of [
    ['paperwing-scan.exe', 'twain'],
    ['paperwing-twain32.exe', 'twain32'],
  ]) {
    const started = Date.now();
    const list = spawnSync(join(out, exe), ['list'], {
      encoding: 'utf8',
      timeout: 30000,
    });
    const line = list.stdout
      .split('\n')
      .find((l) => l.startsWith('{"type":"scanners"'));
    if (list.status !== 0 || !line) {
      console.error(
        `${exe} list failed:`,
        list.status,
        list.stdout,
        list.stderr
      );
      process.exit(1);
    }
    console.log(`${exe} list (${Date.now() - started} ms): ${line}`);
    const caps = spawnSync(
      join(out, exe),
      ['caps', '-Id', `${prefix}:Paperwing build check`],
      { encoding: 'utf8', timeout: 30000 }
    );
    if (caps.status !== 2 || !caps.stdout.includes('"code":"no-scanner"')) {
      console.error(
        `${exe} caps didn't report no-scanner:`,
        caps.status,
        caps.stdout
      );
      process.exit(1);
    }
  }
  console.log('scanner helpers ok');
}
