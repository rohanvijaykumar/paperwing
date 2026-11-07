/**
 * Scanning in the main process (scan.cjs): the helpers are stood in for (what
 * they print is scripted), so these run without a scanner: the contract,
 * merging one scanner seen by several drivers, cancel, errors, the folder
 * a scanner's own app saves to, and the stand-in scanners the benches use.
 *
 *   npm run test:scan
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { inflateSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const {
  createScanning,
  checkScanOptions,
  parseLine,
  cleanCaps,
  mergeScanners,
  watchFolder,
  DRIVER_ORDER,
} = require('../scan.cjs');
const { createTestBackends } = require('../scan-test.cjs');

const TMP = process.env.BENCH_TMP || tmpdir();
const temp = (name) => mkdtempSync(join(TMP, `pw-scan-${name}-`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The share of dark pixels in one of the stand-in's PNGs (8-bit, unfiltered) */
function darkShare(png) {
  const buf = Buffer.from(png);
  const width = buf.readUInt32BE(16);
  const channels = buf[25] === 2 ? 3 : 1;
  const idat = [];
  for (let o = 8; o < buf.length; ) {
    const len = buf.readUInt32BE(o);
    if (buf.toString('latin1', o + 4, o + 8) === 'IDAT')
      idat.push(buf.subarray(o + 8, o + 8 + len));
    o += len + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const row = width * channels + 1;
  let dark = 0;
  let all = 0;
  for (let o = 0; o < raw.length; o += row)
    for (let x = 1; x < row; x += channels) {
      all++;
      if (raw[o + x] < 128) dark++;
    }
  return dark / all;
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAC0lEQVR4nGP4DwYAFPIF+6QNfF4AAAAASUVORK5CYII=',
  'base64'
);

/**
 * Stands in for the helper programs. script(args, child) yields steps:
 * a page number (a real file is written), { wait }, { exit }, { untilCancel }
 * or a message object. What the scanner was sent on stdin is recorded.
 */
function fakeHelpers(script) {
  const calls = [];
  const spawnProcess = (cmd, args) => {
    const call = { cmd, args, stdin: '' };
    calls.push(call);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on('data', (d) => (call.stdin += d));
    child.killed = false;
    child.kill = () => {
      if (child.killed) return;
      child.killed = true;
      setImmediate(() => child.emit('close', null));
    };
    const outDir = args[args.indexOf('-OutDir') + 1];
    setImmediate(async () => {
      for (const step of script(args, call)) {
        if (child.killed) return;
        if (typeof step === 'number') {
          const file = join(outDir, `page-${step}.png`);
          writeFileSync(file, PNG);
          child.stdout.write(
            `${JSON.stringify({ type: 'page', file, dpi: 200, side: step % 2 ? 'front' : 'back' })}\n`
          );
        } else if (step.wait) {
          const end = Date.now() + step.wait;
          while (Date.now() < end && !child.killed) await sleep(10);
        } else if (step.untilCancel) {
          while (!call.stdin.includes('cancel') && !child.killed)
            await sleep(10);
          if (step.untilCancel === 'ignore') continue;
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

/** A real (empty) file standing for a helper program */
const helperFile = (dir, name) => {
  const p = join(dir, name);
  writeFileSync(p, '');
  return p;
};

function windows(script, extra = {}) {
  const dir = temp('win');
  const fake = fakeHelpers(script);
  const s = createScanning({
    platform: 'win32',
    helpers: {
      scan: helperFile(dir, 'paperwing-scan.exe'),
      twain32: helperFile(dir, 'paperwing-twain32.exe'),
    },
    tempDir: dir,
    spawnProcess: fake.spawnProcess,
    env: {},
    ...extra,
  });
  return { s, calls: fake.calls };
}

const listed = (scanners) => ({ type: 'scanners', scanners });
const CAPS = {
  type: 'caps',
  driver: 'wia',
  nativeUi: true,
  sources: [
    {
      id: 'feeder',
      duplex: true,
      resolutions: [100, 200, 300],
      colors: ['color', 'gray', 'bw'],
      maxWidth: 8.5,
      maxHeight: 14,
      canPreview: false,
      paperSizes: [{ name: 'Letter', width: 8.5, height: 11 }],
      doubleFeed: true,
      brightness: { min: -1000, max: 1000, step: 1, default: 0 },
      contrast: null,
      threshold: null,
      feederLoaded: true,
    },
  ],
};
const OPTS = { source: 'feeder', duplex: false, color: 'gray', dpi: 200 };

describe('the contract', () => {
  test('one JSON object per line; anything else is ignored', () => {
    assert.deepEqual(parseLine('{"type":"done"}\r'), { type: 'done' });
    assert.equal(parseLine('WARNING: something'), null);
    assert.equal(parseLine('{not json'), null);
    assert.equal(parseLine('{"no":"type"}'), null);
  });

  test('scan options: only what the contract knows, absent stays absent', () => {
    assert.deepEqual(checkScanOptions({ source: 'flatbed', duplex: true }), {
      source: 'flatbed',
      duplex: false, // only a feeder scans both sides
      color: 'color',
      dpi: 300,
    });
    assert.deepEqual(
      checkScanOptions({
        source: 'feeder',
        duplex: true,
        color: 'bw',
        dpi: 300,
        paper: { width: 8.5, height: 11 },
        threshold: 140,
        brightness: -20,
        doubleFeedStop: true,
        transfer: 'memory',
        nativeUi: false,
        timeout: 60,
        somethingElse: 1,
      }),
      {
        source: 'feeder',
        duplex: true,
        color: 'bw',
        dpi: 300,
        paper: { width: 8.5, height: 11 },
        threshold: 140,
        brightness: -20,
        doubleFeedStop: true,
        transfer: 'memory',
        nativeUi: false,
        timeout: 60,
      }
    );
    // An area wins over a paper size; "auto" is the scanner finding it
    assert.deepEqual(
      checkScanOptions({
        area: { x: 1, y: 1.2, width: 6, height: 8 },
        paper: 'auto',
      }).area,
      { x: 1, y: 1.2, width: 6, height: 8 }
    );
    assert.equal(checkScanOptions({ paper: 'auto' }).paper, 'auto');
    for (const bad of [
      null,
      { source: 'camera' },
      { color: 'sepia' },
      { dpi: 10 },
      { dpi: 300.5 },
      { paper: { width: 80, height: 11 } },
      { area: { x: 0, y: 0, width: 0, height: 5 } },
      { duplex: 'yes' },
      { brightness: 'up' },
      { transfer: 'file' },
      { timeout: 1 },
    ])
      assert.throws(() => checkScanOptions(bad), TypeError, JSON.stringify(bad));
  });

  test('capabilities are cleaned up to what the dialog can offer', () => {
    const caps = cleanCaps(
      {
        nativeUi: true,
        sources: [
          {
            id: 'flatbed',
            duplex: true, // a flatbed can't
            resolutions: { min: 100, max: 600, step: 50 },
            colors: ['gray', 'bw', 'sepia'],
            maxWidth: 8.5,
            maxHeight: 11.7,
            canPreview: true,
            paperSizes: [
              { name: 'A4', width: 8.27, height: 11.69 },
              { name: 'broken' },
            ],
            threshold: { min: 0, max: 255, step: 1, default: 128 },
            brightness: { min: 5, max: 5 },
          },
          { id: 'camera' },
        ],
      },
      'twain'
    );
    assert.equal(caps.driver, 'twain');
    assert.equal(caps.nativeUi, true);
    assert.equal(caps.sources.length, 1);
    const [s] = caps.sources;
    assert.equal(s.duplex, false);
    // A range: the usual resolutions within it, on its steps
    assert.deepEqual(s.resolutions, [100, 150, 200, 300, 400, 600]);
    assert.deepEqual(s.resolutionRange, {
      min: 100,
      max: 600,
      step: 50,
      default: 350,
    });
    assert.deepEqual(s.colors, ['gray', 'bw']);
    assert.deepEqual(s.paperSizes, [{ name: 'A4', width: 8.27, height: 11.69 }]);
    assert.deepEqual(s.threshold, { min: 0, max: 255, step: 1, default: 128 });
    assert.equal(s.brightness, null); // an empty range is none
    assert.equal(s.canPreview, true);
    assert.equal(s.feederLoaded, null);
  });
});

describe('one entry per scanner', () => {
  const found = [
    { driver: 'wia', scanner: { id: 'w1', name: 'Brother MFC (WIA)', deviceKey: 'BROTHER-123', connection: 'usb' } },
    { driver: 'twain', scanner: { id: 't1', name: 'Brother MFC', deviceKey: 'brother-123 ' } },
    { driver: 'escl', scanner: { id: 'e1', name: 'Brother MFC (network)', deviceKey: 'brother-123', connection: 'network' } },
    { driver: 'twain32', scanner: { id: 'old', name: 'Old Scanner', deviceKey: 'old-1' } },
    { driver: 'wia1', scanner: { id: 'old-wia', name: 'Old Scanner (WIA)', deviceKey: 'old-1' } },
    { driver: 'wia', scanner: { id: 'nokey', name: 'Another Scanner' } },
    { driver: 'wia', scanner: { name: 'no id' } },
  ];

  test('Windows: TWAIN-64 > WIA 2 > eSCL > TWAIN-32 > WIA 1, the rest as alternatives', () => {
    const entries = mergeScanners(found, DRIVER_ORDER.win32);
    assert.deepEqual(
      entries.map((e) => [e.name, e.devices.map((d) => d.id)]),
      [
        ['Another Scanner', ['wia:nokey']],
        ['Brother MFC', ['twain:t1', 'wia:w1', 'escl:e1']],
        ['Old Scanner', ['twain32:old', 'wia1:old-wia']],
      ]
    );
    const brother = entries[1];
    assert.equal(brother.connection, 'usb');
    assert.deepEqual(
      brother.devices.map((d) => d.label),
      ['TWAIN', 'WIA', 'Network (eSCL)']
    );
  });

  test('Mac: eSCL > Image Capture', () => {
    const entries = mergeScanners(
      [
        { driver: 'ica', scanner: { id: 'i', name: 'HP Envy', deviceKey: 'hp-1' } },
        { driver: 'escl', scanner: { id: 'e', name: 'HP Envy (AirScan)', deviceKey: 'hp-1', connection: 'network' } },
      ],
      DRIVER_ORDER.darwin
    );
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].devices.map((d) => d.driver), ['escl', 'ica']);
    assert.equal(entries[0].name, 'HP Envy (AirScan)');
  });

  test('lists every helper at once, merged; one failing helper is no failure', async () => {
    const { s, calls } = windows((args, call) =>
      call.cmd.endsWith('twain32.exe')
        ? [{ type: 'error', code: 'failed', message: 'no 32-bit drivers' }, { exit: 1 }]
        : [
            listed([
              { id: 'w', name: 'Canon LiDE', driver: 'wia', api: 'wia2', deviceKey: 'canon' },
              { id: 't', name: 'Canon LiDE', driver: 'twain', api: 'twain64', deviceKey: 'canon' },
              { id: 'old', name: 'Old Scanner', driver: 'wia', api: 'wia1', deviceKey: 'old' },
            ]),
            { exit: 0 },
          ]
    );
    const r = await s.list();
    assert.equal(r.ok, true);
    assert.equal(r.scanners.length, 2);
    assert.deepEqual(r.scanners[0].devices.map((d) => d.id), ['twain:t', 'wia:w']);
    assert.deepEqual(r.scanners[1].devices.map((d) => d.id), ['wia1:old']);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args, ['list']);
  });

  test('every helper failing says why; a helper that can\'t start is "blocked"', async () => {
    const dir = temp('blocked');
    const s = createScanning({
      platform: 'win32',
      helpers: { scan: helperFile(dir, 'paperwing-scan.exe') },
      tempDir: dir,
      env: {},
      spawnProcess: () => {
        throw new Error('This program is blocked by group policy');
      },
    });
    const r = await s.list();
    assert.equal(r.ok, false);
    assert.equal(r.error, 'blocked');
    assert.match(r.message, /group policy/);
  });

  test('no helpers (and no network scanning): no scanners, no error', async () => {
    const s = createScanning({ platform: 'linux', env: {} });
    assert.deepEqual(await s.list(), { ok: true, scanners: [], drivers: [] });
  });

  test('capabilities go to the helper that lists the device', async () => {
    const { s, calls } = windows(() => [CAPS, { exit: 0 }]);
    const r = await s.capabilities('twain32:old-1');
    assert.equal(r.ok, true);
    assert.equal(r.caps.driver, 'twain32');
    assert.equal(r.caps.sources[0].doubleFeed, true);
    assert.ok(calls[0].cmd.endsWith('paperwing-twain32.exe'));
    assert.deepEqual(calls[0].args, ['caps', '-Id', 'old-1']);
    assert.equal((await s.capabilities('nonsense')).error, 'no-scanner');
    assert.equal((await s.capabilities('ica:x')).error, 'no-scanner');
  });
});

describe('scanning', () => {
  test('each page arrives as it is scanned; the options go base64 JSON; files go', async () => {
    const { s, calls } = windows(() => [
      { type: 'status', message: 'Warming up' },
      1,
      2,
      { type: 'done', pages: 2 },
      { exit: 0 },
    ]);
    const pages = [];
    const status = [];
    const r = await s.scan(
      'wia:dev',
      { ...OPTS, duplex: true },
      (data, info) => pages.push({ data, info }),
      (m) => status.push(m)
    );
    assert.deepEqual(r, { ok: true, pages: 2 });
    assert.deepEqual(status, ['Warming up']);
    assert.equal(pages.length, 2);
    assert.deepEqual(
      pages.map((p) => [p.info.index, p.info.side, p.info.mime, p.info.dpi]),
      [
        [1, 'front', 'image/png', 200],
        [2, 'back', 'image/png', 200],
      ]
    );
    const args = calls[0].args;
    assert.deepEqual(args.slice(0, 3), ['scan', '-Id', 'dev']);
    assert.deepEqual(
      JSON.parse(Buffer.from(args[args.indexOf('-Options') + 1], 'base64').toString()),
      { source: 'feeder', duplex: true, color: 'gray', dpi: 200 }
    );
  });

  test("the scanner's own window opens in front of the app's (-Window)", async () => {
    const { s, calls } = windows(() => [{ type: 'done', pages: 0, cancelled: true }, { exit: 0 }], {
      windowHandle: () => '8589934594',
    });
    // Closing the scanner's window is a cancel, not an error
    assert.deepEqual(await s.scan('twain:x', { ...OPTS, nativeUi: true }, () => {}), {
      ok: true,
      pages: 0,
      cancelled: true,
    });
    const args = calls[0].args;
    assert.deepEqual(args.slice(-2), ['-Window', '8589934594']);
  });

  test('only files in its own folder are read', async () => {
    const { s } = windows(() => [
      { type: 'page', file: '../../secret.png', dpi: 100 },
      { type: 'done', pages: 1 },
      { exit: 0 },
    ]);
    const pages = [];
    await s.scan('wia:dev', OPTS, (d) => pages.push(d));
    assert.equal(pages.length, 0);
  });

  test('the feeder running empty after some pages is how it ends', async () => {
    const { s } = windows(() => [1, 2, { type: 'error', code: 'feeder-empty' }, { exit: 1 }]);
    assert.deepEqual(await s.scan('wia:dev', OPTS, () => {}), { ok: true, pages: 2 });
  });

  test('errors keep their code and the pages before them', async () => {
    for (const code of ['feeder-empty', 'paper-jam', 'double-feed', 'cover-open', 'offline', 'unsupported']) {
      const { s } = windows(() =>
        code === 'feeder-empty'
          ? [{ type: 'error', code, message: 'm' }, { exit: 1 }]
          : [1, { type: 'error', code, message: 'm' }, { exit: 1 }]
      );
      const r = await s.scan('wia:dev', OPTS, () => {});
      assert.equal(r.ok, false, code);
      assert.equal(r.error, code);
      assert.equal(r.pages, code === 'feeder-empty' ? 0 : 1);
    }
  });

  test('an unknown code is "failed"; a crash says so', async () => {
    let { s } = windows(() => [{ type: 'error', code: 'cosmic-rays' }, { exit: 1 }]);
    assert.equal((await s.scan('wia:dev', OPTS, () => {})).error, 'failed');
    ({ s } = windows(() => [1, { exit: 3 }]));
    const r = await s.scan('wia:dev', OPTS, () => {});
    assert.equal(r.ok, false);
    assert.equal(r.error, 'failed');
    assert.equal(r.pages, 1);
  });

  test('cancel: "cancel" on stdin, the helper stops after the page and says so', async () => {
    const { s, calls } = windows(() => [
      1,
      { untilCancel: true },
      2,
      { type: 'done', pages: 2, cancelled: true },
      { exit: 0 },
    ]);
    const pages = [];
    const scanning = s.scan('wia:dev', OPTS, (d) => {
      pages.push(d);
      if (pages.length === 1) s.cancel();
    });
    const r = await scanning;
    assert.deepEqual(r, { ok: true, pages: 2, cancelled: true });
    assert.equal(calls[0].stdin, 'cancel\n');
    assert.equal(s.cancel(), false); // nothing left to cancel
  });

  test('cancel: a helper that ignores it is ended (after 10 s; here sooner)', async () => {
    const { s } = windows(
      () => [1, { untilCancel: 'ignore' }, { wait: 60000 }, { exit: 0 }],
      { cancelKillMs: 100 }
    );
    const started = Date.now();
    const r = await s.scan('wia:dev', OPTS, () => s.cancel());
    assert.deepEqual(r, { ok: true, pages: 1, cancelled: true });
    assert.ok(Date.now() - started < 5000);
  });

  test('one job at a time; the scanner is free again afterwards', async () => {
    const { s } = windows(() => [{ wait: 100 }, 1, { type: 'done' }, { exit: 0 }]);
    const first = s.scan('wia:dev', OPTS, () => {});
    const second = await s.scan('wia:dev', OPTS, () => {});
    assert.equal(second.error, 'busy');
    assert.equal((await s.preview('wia:dev', { source: 'flatbed' })).error, 'busy');
    assert.equal((await first).ok, true);
    assert.equal((await s.scan('wia:dev', OPTS, () => {})).ok, true);
  });

  test('bad options and unknown devices never reach a helper', async () => {
    const { s, calls } = windows(() => [{ exit: 0 }]);
    assert.equal((await s.scan('wia:dev', { ...OPTS, dpi: 3 }, () => {})).error, 'invalid');
    assert.equal((await s.scan('mystery', OPTS, () => {})).error, 'no-scanner');
    assert.equal(calls.length, 0);
  });

  test('preview: one low-resolution page of the glass', async () => {
    const { s, calls } = windows(() => [1, { type: 'done', pages: 1 }, { exit: 0 }]);
    const r = await s.preview('wia:dev', { source: 'flatbed', color: 'color', dpi: 600 });
    assert.equal(r.ok, true);
    assert.equal(r.page.mime, 'image/png');
    const args = calls[0].args;
    assert.equal(args[0], 'preview');
    // (never at full resolution)
    assert.equal(
      JSON.parse(Buffer.from(args[args.indexOf('-Options') + 1], 'base64').toString()).dpi,
      150
    );
  });

  test('a helper that stops answering is "offline"', async () => {
    // (the helper's timeouts are long; a helper that can't start is quick)
    const dir = temp('gone');
    const s = createScanning({
      platform: 'darwin',
      helpers: { scan: helperFile(dir, 'paperwing-scan') },
      tempDir: dir,
      env: {},
      spawnProcess: () => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => {};
        setImmediate(() => child.emit('error', new Error('ENOENT')));
        return child;
      },
    });
    const r = await s.scan('ica:x', OPTS, () => {});
    assert.equal(r.ok, false);
    assert.equal(r.error, 'blocked');
  });
});

describe('network scanners added by address', () => {
  test('goes to escl.cjs; nonsense addresses never do', async () => {
    const seen = [];
    // (escl.cjs's own calls, answering with the contract's messages)
    const escl = {
      list: async () => ({ type: 'scanners', scanners: [] }),
      add: async (host) => {
        seen.push(host);
        return {
          type: 'scanners',
          scanners: [{ id: `http://${host}/eSCL`, name: 'Office scanner', deviceKey: 'uuid-1', connection: 'network' }],
        };
      },
      caps: async () => ({ type: 'error', code: 'offline' }),
      scan: () => ({ cancel() {}, done: new Promise(() => {}) }),
      preview: () => ({ cancel() {}, done: Promise.resolve() }),
    };
    const s = createScanning({ platform: 'win32', escl, env: {} });
    const r = await s.addByAddress(' 192.168.1.40:8080 ');
    assert.equal(r.ok, true);
    assert.equal(r.scanner.name, 'Office scanner');
    assert.equal(r.scanner.devices[0].id, 'escl:http://192.168.1.40:8080/eSCL');
    for (const bad of ['', 'http://x', 'a b', '1.2.3.4/../x', 'x'.repeat(300)])
      assert.equal((await s.addByAddress(bad)).error, 'invalid', bad);
    assert.deepEqual(seen, ['192.168.1.40:8080']);
    assert.equal((await s.capabilities('escl:x')).error, 'offline');
  });

  test('a network scanner gone silent longer than the chosen wait is "offline"', async () => {
    let cancelled = false;
    const escl = {
      list: async () => ({ type: 'scanners', scanners: [] }),
      caps: async () => ({ type: 'caps', sources: [] }),
      scan: (id, opts, outDir, onEvent) => {
        let end;
        const done = new Promise((r) => (end = r));
        onEvent({ type: 'status', message: 'Starting' });
        return {
          cancel() {
            cancelled = true;
            end(onEvent({ type: 'done', pages: 0, cancelled: true }));
          },
          done,
        };
      },
    };
    const s = createScanning({ platform: 'win32', escl, env: {}, tempDir: temp('escl') });
    // (the shortest wait the dialog allows is 5 s)
    const started = Date.now();
    const r = await s.scan('escl:x', { ...OPTS, timeout: 5 }, () => {});
    assert.equal(cancelled, true);
    assert.equal(r.error, 'offline');
    assert.ok(Date.now() - started >= 4900);
  });
});

describe('import from a scanner app (a watched folder)', () => {
  test('hands over each new file once it is completely written', async () => {
    const dir = temp('watch');
    writeFileSync(join(dir, 'old.pdf'), '%PDF-1.4\n%%EOF\n'); // there before: not new
    const got = [];
    const w = watchFolder(dir, (f) => got.push(f), { settleMs: 80, pollMs: 100 });
    await w.ready;
    // A PDF written in pieces, slowly, like a scanner app saving
    const file = join(dir, 'scan 1.pdf');
    writeFileSync(file, '%PDF-1.7\n');
    for (let k = 0; k < 4; k++) {
      await sleep(60);
      appendFileSync(file, `${k} 0 obj\n<<>>\nendobj\n`);
    }
    await sleep(400);
    assert.equal(got.length, 0, 'not before it ends like a PDF');
    appendFileSync(file, 'trailer\n<<>>\n%%EOF\n');
    // An image too, and a file that isn't one
    writeFileSync(join(dir, 'photo.jpg'), Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]));
    writeFileSync(join(dir, 'notes.txt'), 'hello');
    const end = Date.now() + 5000;
    while (got.length < 2 && Date.now() < end) await sleep(50);
    await sleep(300);
    w.close();
    assert.deepEqual(got.map((f) => f.name).sort(), ['photo.jpg', 'scan 1.pdf']);
    const pdf = got.find((f) => f.name === 'scan 1.pdf');
    assert.equal(Buffer.from(pdf.data).toString(), readFileSync(file, 'utf8'));
  });

  test('a half-written JPEG waits for its end marker', async () => {
    const dir = temp('watch-jpg');
    const got = [];
    const w = watchFolder(dir, (f) => got.push(f), { settleMs: 60, pollMs: 100 });
    await w.ready;
    writeFileSync(join(dir, 'p.jpeg'), Buffer.from([0xff, 0xd8, 9, 9, 9]));
    await sleep(500);
    assert.equal(got.length, 0);
    appendFileSync(join(dir, 'p.jpeg'), Buffer.from([0xff, 0xd9]));
    const end = Date.now() + 3000;
    while (!got.length && Date.now() < end) await sleep(40);
    w.close();
    assert.equal(got.length, 1);
  });

  test('only folders: watching stops on null', async () => {
    const s = createScanning({ platform: 'win32', env: {} });
    assert.equal((await s.watch(join(temp('nf'), 'missing'), () => {})).ok, false);
    assert.equal((await s.watch(temp('ok'), () => {})).ok, true);
    assert.equal((await s.watch(null)).ok, true);
  });
});

describe('the stand-in scanners (development builds)', () => {
  const standIn = (env = {}, platform = 'win32') =>
    createScanning({
      platform,
      env: { PAPERWING_SCAN_TEST: '1', ...env },
      tempDir: temp('standin'),
    });

  test('three scanners; one reached three ways, one only on the network', async () => {
    const r = await standIn().list();
    assert.equal(r.ok, true);
    const byName = Object.fromEntries(r.scanners.map((e) => [e.name, e]));
    assert.deepEqual(byName['Paperwing Test Scanner'].devices.map((d) => d.driver), ['twain', 'wia', 'escl']);
    assert.deepEqual(byName['Paperwing Test Feeder'].devices.map((d) => d.driver), ['twain32', 'wia1']);
    assert.deepEqual(byName['Paperwing Network Scanner'].devices.map((d) => d.driver), ['escl']);
    assert.equal(byName['Paperwing Network Scanner'].connection, 'network');
    const mac = await standIn({}, 'darwin').list();
    assert.deepEqual(
      mac.scanners.find((e) => e.key === 'paperwing-test-1').devices.map((d) => d.driver),
      ['escl', 'ica']
    );
  });

  test('a feeder of 3 sheets, both sides: 6 pages, the 4th blank, the 2nd crooked', async () => {
    const s = standIn();
    const pages = [];
    const r = await s.scan(
      'twain:test-1',
      { source: 'feeder', duplex: true, color: 'gray', dpi: 100, paper: { width: 8.5, height: 11 } },
      (data, info) => pages.push({ data, info })
    );
    assert.deepEqual(r, { ok: true, pages: 6 });
    assert.deepEqual(pages.map((p) => p.info.side), ['front', 'back', 'front', 'back', 'front', 'back']);
    assert.deepEqual([pages[0].info.width, pages[0].info.height], [850, 1100]);
    // The blank page has (next to) no ink; the others have text
    const ink = pages.map((p) => darkShare(p.data));
    assert.ok(ink[3] < 0.0005, `blank: ${ink[3]}`);
    assert.ok(ink.every((v, k) => k === 3 || v > 0.01), JSON.stringify(ink));
  });

  test('a preview is the whole glass; a scan of an area is just that', async () => {
    const s = standIn();
    const p = await s.preview('twain:test-1', { source: 'flatbed', color: 'color', dpi: 50 });
    assert.equal(p.ok, true);
    assert.deepEqual([p.page.width, p.page.height], [425, 585]);
    const pages = [];
    await s.scan(
      'twain:test-1',
      { source: 'flatbed', color: 'color', dpi: 100, area: { x: 1, y: 1, width: 6, height: 8.5 } },
      (d, info) => pages.push(info)
    );
    assert.deepEqual([pages[0].width, pages[0].height], [600, 850]);
  });

  test('errors, also after some pages; no stop on double-feed when asked not to', async () => {
    let s = standIn({ PAPERWING_SCAN_TEST_ERROR: 'paper-jam' });
    let r = await s.scan('twain:test-1', { source: 'feeder', dpi: 100 }, () => {});
    assert.equal(r.error, 'paper-jam');
    s = standIn({ PAPERWING_SCAN_TEST_ERROR: 'double-feed@2' });
    r = await s.scan('twain:test-1', { source: 'feeder', dpi: 100, doubleFeedStop: true }, () => {});
    assert.deepEqual([r.error, r.pages], ['double-feed', 2]);
    r = await s.scan('twain:test-1', { source: 'feeder', dpi: 100, doubleFeedStop: false }, () => {});
    assert.deepEqual(r, { ok: true, pages: 3 });
    assert.equal((await standIn({ PAPERWING_SCAN_TEST_ERROR: 'no-scanner' }).list()).scanners.length, 0);
    assert.equal((await standIn({ PAPERWING_SCAN_TEST_ERROR: 'blocked' }).list()).error, 'blocked');
  });

  test('cancel stops after the page being scanned', async () => {
    const s = standIn({ PAPERWING_SCAN_TEST_PAGES: '10' });
    const pages = [];
    const r = await s.scan('wia:test-1', { source: 'feeder', dpi: 75 }, (d) => {
      pages.push(d);
      if (pages.length === 2) s.cancel();
    });
    assert.equal(r.cancelled, true);
    assert.ok(r.pages >= 2 && r.pages <= 3, `${r.pages}`);
  });

  test('add by IP address: documentation addresses answer, others are offline', async () => {
    const s = standIn();
    const ok = await s.addByAddress('192.0.2.7');
    assert.equal(ok.ok, true);
    assert.equal(ok.scanner.name, 'Network scanner at 192.0.2.7');
    assert.ok((await s.list()).scanners.some((e) => e.name === 'Network scanner at 192.0.2.7'));
    assert.equal((await s.addByAddress('10.9.9.9')).error, 'offline');
  });

  test('never in a packaged app', async () => {
    const s = createScanning({
      platform: 'win32',
      isPackaged: true,
      env: { PAPERWING_SCAN_TEST: '1' },
    });
    assert.equal(s.testMode, false);
    assert.deepEqual((await s.list()).scanners, []);
  });

  test('the stand-in backends speak the contract on their own too', async () => {
    const b = createTestBackends({ platform: 'win32', env: {} });
    const caps = await b.twain32.caps('test-2');
    assert.equal(caps.ok, true);
    assert.deepEqual(cleanCaps(caps.msg, 'twain32').sources[0].colors, ['gray', 'bw']);
  });
});

/**
 * scan.cjs over the real Windows helpers and the TWAIN Working Group's
 * sample scanner (installed on GitHub's Windows runner only; CI sets
 * PAPERWING_TWAIN_SAMPLE): one entry for the 64- and 32-bit drivers, its
 * settings, a feeder scan streamed page by page, and cancel.
 */
describe(
  'the real helpers with the TWAIN sample scanner',
  {
    skip:
      process.platform !== 'win32' || !process.env.PAPERWING_TWAIN_SAMPLE
        ? 'CI only (PAPERWING_TWAIN_SAMPLE)'
        : false,
  },
  () => {
    const dir = join(import.meta.dirname, '..', 'native', 'win-scanner', 'out');
    const real = () =>
      createScanning({
        platform: 'win32',
        helpers: {
          scan: join(dir, 'paperwing-scan.exe'),
          twain32: join(dir, 'paperwing-twain32.exe'),
        },
        env: {},
        tempDir: temp('twain'),
      });

    test('listed once, TWAIN first, its 32-bit driver as the alternative', async () => {
      const r = await real().list();
      console.log(JSON.stringify(r));
      const sample = r.scanners.find((e) => /^twainworkinggroup:/.test(e.key));
      assert.ok(sample, 'the sample scanner is listed');
      assert.deepEqual(
        sample.devices.map((d) => d.driver).filter((d) => d.startsWith('twain')),
        ['twain', 'twain32']
      );
    });

    test('its settings, and a feeder scan page by page', async () => {
      // (the sample's feeder holds this many sheets; the helpers inherit it)
      process.env.CAP_XFERCOUNT = '3';
      const s = real();
      const sample = (await s.list()).scanners.find((e) => /^twainworkinggroup:/.test(e.key));
      for (const device of sample.devices.filter((d) => d.driver.startsWith('twain'))) {
        const c = await s.capabilities(device.id);
        assert.equal(c.ok, true, JSON.stringify(c));
        assert.equal(c.caps.nativeUi, true);
        assert.deepEqual(c.caps.sources.map((x) => x.id), ['flatbed', 'feeder']);
        const pages = [];
        const r = await s.scan(
          device.id,
          { source: 'feeder', color: 'gray', dpi: 100, paper: { width: 8.5, height: 11 } },
          (data, info) => pages.push(info)
        );
        assert.equal(r.ok, true, `${device.driver}: ${JSON.stringify(r)}`);
        assert.ok(pages.length >= 1);
        assert.equal(pages.length, r.pages);
        assert.ok(pages.every((p) => p.mime === 'image/png' && p.dpi > 0));
        const p = await s.preview(device.id, { source: 'flatbed', color: 'color' });
        assert.equal(p.ok, true, JSON.stringify(p));
      }
    });

    test('cancel stops a feeder run and lets the scanner go', async () => {
      process.env.CAP_XFERCOUNT = '12';
      const s = real();
      const sample = (await s.list()).scanners.find((e) => /^twainworkinggroup:/.test(e.key));
      const id = sample.devices[0].id;
      let n = 0;
      const r = await s.scan(id, { source: 'feeder', color: 'gray', dpi: 100 }, () => {
        if (++n === 1) s.cancel();
      });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.cancelled, true);
      // free again at once
      const again = await s.scan(id, { source: 'flatbed', color: 'gray', dpi: 75 }, () => {});
      assert.equal(again.ok, true, JSON.stringify(again));
    });
  }
);
