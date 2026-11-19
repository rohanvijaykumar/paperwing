/**
 * Scan diagnostics (test build for #55, scan-diagnostics.cjs): a folder per
 * scan pass with the pages as the driver sent them and scan-log.json. With
 * the real eSCL code against a pretend HP feeder (heights at the end), a
 * scripted WIA helper (messages, stderr, a feeder pass with no pages), and
 * the 10 most recent folders kept.
 *
 *   node --test tests/scan-diagnostics.test.mjs
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createRequire } from 'node:module';
import { startFakeEscl } from './fake-escl.mjs';

const require = createRequire(import.meta.url);
const { createScanning } = require('../scan.cjs');
const { createEscl } = require('../escl.cjs');
const { createScanDiagnostics } = require('../scan-diagnostics.cjs');

const work = mkdtempSync(join(tmpdir(), 'paperwing-diag-'));
let n = 0;
const fresh = (name) => mkdtempSync(join(work, `${name}-${++n}-`));
const readLog = (dir) =>
  JSON.parse(readFileSync(join(dir, 'scan-log.json'), 'utf8'));
const diagnostics = (root, now) =>
  createScanDiagnostics({
    root,
    about: { version: '1.3.1', os: 'test' },
    ...(now ? { now } : {}),
  });

const fakes = [];
after(() => Promise.all(fakes.map((f) => f.close())));

describe('eSCL: a feeder like HP’s, heights at the end', () => {
  test('the pages as they came, as fixed, and every request', async () => {
    const hp = await startFakeEscl({
      host: '127.0.0.1',
      mdns: false,
      name: 'Pretend Smart Tank',
      makeAndModel: 'Pretend Smart Tank 610 series',
      platen: false,
      adf: { sheets: 2 },
      quirks: { heightAtEnd: true },
    });
    fakes.push(hp);
    const root = fresh('escl');
    const s = createScanning({
      platform: 'win32',
      helpers: {},
      escl: createEscl({ mdnsTargets: [] }),
      tempDir: fresh('tmp'),
      env: {},
      diagnostics: diagnostics(root),
    });
    const added = await s.addByAddress(`127.0.0.1:${hp.port}`);
    assert.ok(added.ok, JSON.stringify(added));
    const id = added.scanner.devices[0].id;
    assert.ok((await s.capabilities(id)).ok);
    const pages = [];
    const r = await s.scan(
      id,
      { source: 'feeder', color: 'gray', dpi: 75 },
      (data, info) => pages.push(info)
    );
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(pages.length, 2);
    assert.ok(r.diagnostics?.startsWith(root), r.diagnostics);
    const files = readdirSync(r.diagnostics).sort();
    assert.deepEqual(files, [
      'page-1-fixed.jpg',
      'page-1-raw.jpg',
      'page-2-fixed.jpg',
      'page-2-raw.jpg',
      'scan-log.json',
    ]);
    const log = readLog(r.diagnostics);
    assert.equal(log.version, '1.3.1');
    assert.equal(log.driver, 'escl');
    assert.equal(log.deviceId, id);
    assert.match(log.device.name, /Pretend Smart Tank/);
    assert.equal(log.optionsRequested.source, 'feeder');
    assert.equal(log.cancelled, false);
    assert.equal(log.pageCount, 2);
    // The raw page: height 0 in its header, the lines in a DNL
    const p1 = log.pages[0];
    assert.equal(p1.raw.headerHeight, 0);
    assert.equal(p1.raw.dnlFound, true);
    assert.ok(p1.raw.dnlLines > 0);
    assert.equal(p1.fixed.headerHeight, p1.raw.dnlLines);
    assert.equal(p1.fixed.dnlFound, false);
    const raw = readFileSync(join(r.diagnostics, 'page-1-raw.jpg'));
    assert.equal(raw.readUInt16BE(0), 0xffd8);
    assert.equal(raw.length, p1.raw.bytes);
    // What was said to the scanner, and what it answered
    const kinds = log.events.map((e) => e.kind);
    for (const k of ['device', 'capabilities', 'scanSettings', 'job'])
      assert.ok(kinds.includes(k), `${k} in ${kinds}`);
    const caps = log.events.find((e) => e.kind === 'capabilities');
    assert.match(caps.xml, /ScannerCapabilities/);
    const settings = log.events.find((e) => e.kind === 'scanSettings');
    assert.match(settings.xml, /<scan:ScanSettings/);
    assert.match(settings.xml, /Feeder/);
    const post = log.http.find(
      (h) => h.method === 'POST' && /ScanJobs$/.test(h.path)
    );
    assert.equal(post.status, 201);
    assert.ok(post.headers.location);
    const docs = log.http.filter((h) => /NextDocument$/.test(h.path));
    assert.equal(docs[0].status, 200);
    assert.equal(docs[0].headers['content-type'], 'image/jpeg');
    assert.equal(docs[0].bytes, p1.raw.bytes);
    assert.ok(docs.some((h) => h.status === 404));
    assert.ok(log.http.every((h) => typeof h.ms === 'number'));
  });
});

/** A WIA helper that says these lines, then ends with `exit` */
function helper(lines, { exit = 0, stderr = '' } = {}) {
  const dir = fresh('win');
  const exe = join(dir, 'paperwing-scan.exe');
  writeFileSync(exe, '');
  const spawnProcess = (cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => setImmediate(() => child.emit('close', null));
    const outDir = args[args.indexOf('-OutDir') + 1];
    setImmediate(() => {
      if (args[0] === 'list')
        child.stdout.write(
          `${JSON.stringify({ type: 'scanners', scanners: [{ id: 'HP1', name: 'HP Smart Tank 610', driver: 'wia', api: 'wia2' }] })}\n`
        );
      else
        for (const l of lines) {
          if (l.page) {
            const file = join(outDir, `page-${l.page}.png`);
            writeFileSync(file, l.bytes);
            child.stdout.write(
              `${JSON.stringify({ type: 'page', file, dpi: 200 })}\n`
            );
          } else child.stdout.write(`${l}\n`);
        }
      if (stderr && args[0] !== 'list') child.stderr.write(stderr);
      child.stdout.end();
      setImmediate(() => child.emit('close', exit));
    });
    return child;
  };
  return createScanning({
    platform: 'win32',
    helpers: { scan: exe },
    tempDir: dir,
    spawnProcess,
    env: {},
    diagnostics: diagnostics(fresh('wia-diag')),
  });
}

describe('WIA and TWAIN: every message and stderr', () => {
  test('a feeder pass with no pages', async () => {
    const s = helper(
      [
        JSON.stringify({ type: 'status', message: 'Scanning…' }),
        'not json: WIA said something',
        JSON.stringify({ type: 'done', pages: 0 }),
      ],
      { stderr: 'WIA_ERROR_PAPER_EMPTY 0x80210003\n' }
    );
    await s.list();
    const r = await s.scan('wia:HP1', { source: 'feeder', dpi: 200 }, () => {});
    assert.ok(r.ok && r.pages === 0, JSON.stringify(r));
    const log = readLog(r.diagnostics);
    assert.equal(log.driver, 'wia');
    assert.equal(log.device.name, 'HP Smart Tank 610');
    assert.equal(log.pageCount, 0);
    const kinds = log.events.map((e) => e.kind);
    assert.ok(kinds.includes('spawn'));
    assert.ok(
      log.events.some(
        (e) => e.kind === 'stdout' && /WIA said something/.test(e.line)
      )
    );
    assert.ok(
      log.events.some((e) => e.kind === 'stderr' && /0x80210003/.test(e.text))
    );
    assert.ok(
      log.events.some((e) => e.kind === 'event' && e.msg.type === 'done')
    );
    assert.ok(log.events.some((e) => e.kind === 'exit' && e.code === 0));
    assert.equal(log.backendExit.exitCode, 0);
  });

  test('a page that can’t be opened is kept as it came', async () => {
    // A JPEG frame header with height 0 and no DNL to give it
    const bad = Buffer.from([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x00, 0x00, 0x10, 0x01,
      0x01, 0x11, 0x00, 0xff, 0xd9,
    ]);
    const s = helper([
      { page: 1, bytes: bad },
      JSON.stringify({ type: 'done', pages: 1 }),
    ]);
    await s.list();
    const got = [];
    const r = await s.scan('wia:HP1', { source: 'feeder', dpi: 200 }, (d, i) =>
      got.push(i)
    );
    assert.ok(r.ok);
    assert.equal(got[0].unreadable, true);
    const log = readLog(r.diagnostics);
    assert.equal(log.pages[0].raw.headerHeight, 0);
    assert.equal(log.pages[0].raw.dnlFound, false);
    assert.equal(log.pages[0].delivered.unreadable, 'no-height');
    // (named by what it is: a JPEG, whatever the helper called it)
    assert.ok(existsSync(join(r.diagnostics, 'page-1-raw.jpg')));
  });
});

describe('the folders', () => {
  test('one per pass, named by when it started; the 10 most recent kept', async () => {
    const root = fresh('keep');
    let t = new Date(2026, 10, 18, 9, 0, 0).getTime();
    const d = diagnostics(root, () => new Date((t += 1000)));
    const made = [];
    for (let k = 0; k < 12; k++) {
      const pass = d.start({ driver: 'wia' });
      pass.event('note', { k });
      made.push(basename(await pass.finish({ ok: true })));
    }
    assert.match(made[0], /^2026-11-18 0900\d\d$/);
    assert.deepEqual(readdirSync(root).sort(), made.slice(2));
  });

  test('two passes in the same second get folders of their own', async () => {
    const root = fresh('same');
    const at = new Date(2026, 10, 18, 9, 30, 5);
    const d = diagnostics(root, () => at);
    const a = await d.start().finish({ ok: true });
    const b = await d.start().finish({ ok: true });
    assert.notEqual(a, b);
    assert.match(b, /2026-11-18 093005 \(2\)$/);
  });

  test('a folder that can’t be written changes nothing', async () => {
    const file = join(fresh('nowhere'), 'a file');
    writeFileSync(file, '');
    const d = diagnostics(join(file, 'under it'));
    const pass = d.start({ driver: 'wia' });
    pass.rawPage(1, Buffer.from([1, 2, 3]));
    assert.equal(await pass.finish({ ok: true }), null);
  });
});
