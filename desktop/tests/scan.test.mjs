/**
 * Scanning in the main process (scan.cjs), with a stand-in for the scanner
 * helper (wia.ps1 / paperwing-scan): what it prints is scripted, so these
 * run without a scanner. desktop/scanner/wia.ps1 itself is run once, for
 * real, on Windows: with no scanner attached it must list none.
 *
 *   npm run test:scan
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createScanning,
  checkScanOptions,
  parseLine,
  cleanCaps,
} = require('../scan.cjs');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAC0lEQVR4nGP4DwYAFPIF+6QNfF4AAAAASUVORK5CYII=',
  'base64'
);

/** A helper that prints `lines` (pages written as real files) and exits */
function fakeHelper(script) {
  const calls = [];
  const spawnProcess = (cmd, args) => {
    calls.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit('close', null));
    };
    const outDir = args[args.indexOf('-OutDir') + 1];
    setImmediate(async () => {
      for (const step of script(args)) {
        if (child.killed) return;
        if (step.page) {
          const file = join(outDir, `page-${step.page}.png`);
          writeFileSync(file, PNG);
          child.stdout.write(
            `${JSON.stringify({ type: 'page', file, dpi: 200 })}\n`
          );
        } else if (step.wait) {
          await new Promise((r) => setTimeout(r, step.wait));
        } else if (step.exit !== undefined) {
          child.stdout.end();
          child.emit('close', step.exit);
          return;
        } else
          child.stdout.write(
            `${typeof step === 'string' ? step : JSON.stringify(step)}\n`
          );
      }
    });
    return child;
  };
  return { spawnProcess, calls };
}

const scanning = (script, extra = {}) => {
  const fake = fakeHelper(script);
  const s = createScanning({
    platform: 'win32',
    wiaScript: 'C:/fake/wia.ps1',
    tempDir: mkdtempSync(join(tmpdir(), 'pw-scan-test-')),
    spawnProcess: fake.spawnProcess,
    env: {},
    ...extra,
  });
  return { s, calls: fake.calls };
};

const OPTS = {
  source: 'feeder',
  duplex: false,
  color: 'gray',
  dpi: 200,
  width: 8.5,
  height: 11,
};

describe('the helper protocol', () => {
  test('one JSON object per line; anything else is ignored', () => {
    assert.deepEqual(parseLine('{"type":"done"}\r'), { type: 'done' });
    assert.equal(parseLine('WARNING: something'), null);
    assert.equal(parseLine('{not json'), null);
    assert.equal(parseLine('{"no":"type"}'), null);
  });

  test('scan options are checked', () => {
    assert.deepEqual(checkScanOptions({ source: 'flatbed', duplex: true }), {
      source: 'flatbed',
      duplex: false, // only a feeder scans both sides
      color: 'color',
      dpi: 300,
      width: 8.5,
      height: 11,
    });
    for (const bad of [
      null,
      { source: 'camera' },
      { color: 'sepia' },
      { dpi: 30 },
      { dpi: 300.5 },
      { width: 40 },
      { duplex: 'yes' },
    ])
      assert.throws(
        () => checkScanOptions(bad),
        TypeError,
        JSON.stringify(bad)
      );
  });

  test('capabilities are cleaned up to what the dialog can offer', () => {
    assert.deepEqual(
      cleanCaps([
        {
          id: 'flatbed',
          resolutions: [600, 150, 150, 9999, '300'],
          colors: ['color', 'infrared'],
          width: 8.5,
          height: 11.7,
          duplex: true,
        },
        { id: 'film' },
        null,
      ]),
      [
        {
          id: 'flatbed',
          duplex: false,
          resolutions: [150, 300, 600],
          colors: ['color'],
          width: 8.5,
          height: 11.7,
        },
      ]
    );
  });
});

describe('scanners and what they can do', () => {
  test('lists the scanners the helper finds, through PowerShell on Windows', async () => {
    const { s, calls } = scanning(() => [
      {
        type: 'scanners',
        scanners: [{ id: 'dev-1', name: 'Office scanner' }, { name: 'no id' }],
      },
      { exit: 0 },
    ]);
    assert.deepEqual(await s.list(), {
      ok: true,
      scanners: [{ id: 'dev-1', name: 'Office scanner' }],
    });
    assert.equal(calls[0].cmd, 'powershell.exe');
    assert.ok(calls[0].args.includes('C:/fake/wia.ps1'));
    assert.equal(calls[0].args.at(-1), 'list');
  });

  test('a helper that fails says why', async () => {
    const { s } = scanning(() => [
      { type: 'error', code: 'busy', message: 'In use' },
      { exit: 2 },
    ]);
    assert.deepEqual(await s.capabilities('dev-1'), {
      ok: false,
      error: 'busy',
      message: 'In use',
    });
  });

  test('reads what a scanner can do', async () => {
    const { s, calls } = scanning(() => [
      {
        type: 'caps',
        sources: [
          { id: 'feeder', duplex: true, resolutions: [300], colors: ['gray'] },
        ],
      },
      { exit: 0 },
    ]);
    const r = await s.capabilities('dev-1');
    assert.equal(r.ok, true);
    assert.equal(r.sources[0].duplex, true);
    assert.deepEqual(calls[0].args.slice(-3), ['caps', '-DeviceId', 'dev-1']);
  });

  test('no helper on this platform: no scanners', async () => {
    const { s } = scanning(() => [], { platform: 'linux' });
    assert.equal((await s.list()).ok, false);
  });
});

describe('scanning', () => {
  test('each page arrives as it is scanned, and the files go', async () => {
    const { s, calls } = scanning(() => [
      { page: 1 },
      { page: 2 },
      { type: 'done' },
      { exit: 0 },
    ]);
    const got = [];
    const r = await s.scan('dev-1', OPTS, (data, info) => got.push(info));
    assert.deepEqual(r, { ok: true, pages: 2 });
    assert.deepEqual(got, [
      { index: 1, dpi: 200, mime: 'image/png' },
      { index: 2, dpi: 200, mime: 'image/png' },
    ]);
    const options = calls[0].args[calls[0].args.indexOf('-Options') + 1];
    assert.deepEqual(
      JSON.parse(Buffer.from(options, 'base64').toString()),
      OPTS
    );
  });

  test('a feeder running empty after some pages is how it ends', async () => {
    const { s } = scanning(() => [
      { page: 1 },
      { type: 'error', code: 'feeder-empty', message: 'Out of paper' },
      { exit: 2 },
    ]);
    const r = await s.scan('dev-1', OPTS, () => {});
    assert.equal(r.ok, true);
    assert.equal(r.pages, 1);
  });

  test('an empty feeder before any page is an error, with the reason', async () => {
    const { s } = scanning(() => [
      { type: 'error', code: 'feeder-empty', message: 'Out of paper' },
      { exit: 2 },
    ]);
    const r = await s.scan('dev-1', OPTS, () => {});
    assert.equal(r.ok, false);
    assert.equal(r.error, 'feeder-empty');
  });

  test('a jam keeps the pages scanned before it', async () => {
    const { s } = scanning(() => [
      { page: 1 },
      { type: 'error', code: 'paper-jam', message: 'Jammed' },
      { exit: 2 },
    ]);
    const got = [];
    const r = await s.scan('dev-1', OPTS, (d) => got.push(d));
    assert.equal(r.error, 'paper-jam');
    assert.equal(r.pages, 1);
    assert.equal(got.length, 1);
  });

  test('an unknown error code is "failed"; a crash says so', async () => {
    let r = await scanning(() => [
      { type: 'error', code: 'gremlins' },
      { exit: 2 },
    ]).s.scan('dev-1', OPTS, () => {});
    assert.equal(r.error, 'failed');
    r = await scanning(() => ['Unhandled exception', { exit: 3 }]).s.scan(
      'dev-1',
      OPTS,
      () => {}
    );
    assert.equal(r.ok, false);
  });

  test('one scan at a time; cancel stops it', async () => {
    const { s } = scanning(() => [
      { page: 1 },
      { wait: 300 },
      { page: 2 },
      { type: 'done' },
      { exit: 0 },
    ]);
    const pages = [];
    const first = s.scan('dev-1', OPTS, (d) => pages.push(d));
    assert.equal((await s.scan('dev-1', OPTS, () => {})).error, 'busy');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(s.cancel(), true);
    const r = await first;
    assert.equal(r.error, 'cancelled');
    assert.equal(pages.length, 1);
    assert.equal(s.cancel(), false);
  });

  test('bad options never reach the helper', async () => {
    const { s, calls } = scanning(() => [{ exit: 0 }]);
    assert.equal(
      (await s.scan('dev-1', { dpi: 5 }, () => {})).error,
      'invalid'
    );
    assert.equal((await s.scan('', OPTS, () => {})).error, 'invalid');
    assert.equal(calls.length, 0);
  });
});

describe('the stand-in scanner (development builds)', () => {
  const testPage = (opts, n) => ({
    data: PNG,
    dpi: Math.min(opts.dpi, 100),
    n,
  });
  const make = (env) =>
    createScanning({
      platform: 'win32',
      isPackaged: false,
      env: { PAPERWING_SCAN_TEST: '1', ...env },
      tempDir: mkdtempSync(join(tmpdir(), 'pw-scan-test-')),
      makeTestPage: testPage,
    });

  test('a feeder of 3 sheets, both sides: 6 pages', async () => {
    const got = [];
    const r = await make({}).scan(
      'test:scanner',
      { ...OPTS, duplex: true },
      (d, info) => got.push(info)
    );
    assert.deepEqual(r, { ok: true, pages: 6 });
    assert.equal(got[0].dpi, 100);
  });

  test('can stand in for a failing scanner', async () => {
    const r = await make({ PAPERWING_SCAN_TEST_ERROR: 'paper-jam' }).scan(
      'test:scanner',
      OPTS,
      () => {}
    );
    assert.equal(r.error, 'paper-jam');
  });

  test('never in a packaged app', async () => {
    const s = createScanning({
      platform: 'linux',
      isPackaged: true,
      env: { PAPERWING_SCAN_TEST: '1' },
    });
    assert.equal(s.testMode, false);
  });
});

describe(
  'wia.ps1, for real (Windows)',
  { skip: process.platform !== 'win32' },
  () => {
    const script = fileURLToPath(
      new URL('../scanner/wia.ps1', import.meta.url)
    );
    const ps = (...args) => {
      try {
        return execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-STA',
            '-File',
            script,
            ...args,
          ],
          { encoding: 'utf8', windowsHide: true }
        );
      } catch (err) {
        return err.stdout;
      }
    };

    test('lists the scanners (as JSON, whether or not there are any)', () => {
      const msg = parseLine(ps('list'));
      assert.equal(msg?.type, 'scanners');
      assert.ok(Array.isArray(msg.scanners));
    });

    test('a scanner that is not there is reported as such', () => {
      assert.deepEqual(parseLine(ps('caps', '-DeviceId', 'not-a-scanner')), {
        type: 'error',
        code: 'no-scanner',
        message: 'Scanner not found',
      });
    });
  }
);
