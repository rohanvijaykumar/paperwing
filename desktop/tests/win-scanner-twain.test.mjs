/**
 * The Windows scanner helpers against a real TWAIN driver: the TWAIN Working
 * Group's sample scanner (a software scanner that "scans" a picture), which
 * the CI job installs on GitHub's Windows runner, 64- and 32-bit. Never
 * install it on a development PC.
 *
 *   PAPERWING_TWAIN_SAMPLE=1 node --test desktop/tests/win-scanner-twain.test.mjs
 *
 * The sample's feeder holds CAP_XFERCOUNT sheets (an environment variable
 * the driver reads), so feeder runs and cancelling mid-feed are tested too.
 */
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { helperDir, runHelper } from './win-scanner-run.mjs';

const x64 = join(helperDir, 'paperwing-scan.exe');
const x86 = join(helperDir, 'paperwing-twain32.exe');
const skip =
  process.platform !== 'win32'
    ? 'Windows only'
    : !process.env.PAPERWING_TWAIN_SAMPLE
      ? 'needs the TWAIN sample scanner (CI only): set PAPERWING_TWAIN_SAMPLE=1'
      : false;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');

/** PNG width and height from its header */
function pngSize(file) {
  const data = readFileSync(file);
  assert.equal(data.toString('latin1', 1, 4), 'PNG', `${file} isn't a PNG`);
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'pw-twain-'));
}

/** A scan's events, checked against the contract; returns pages and the end */
function checkScan(r, dir) {
  const pages = r.lines.filter((l) => l.type === 'page');
  const end = r.lines.at(-1);
  for (const p of pages) {
    // (the helper keeps OutDir as given: 8.3 short names stay short)
    assert.equal(
      realpathSync.native(dirname(p.file)),
      realpathSync.native(dir),
      'pages are written in OutDir'
    );
    assert.ok(existsSync(p.file), p.file);
    assert.deepEqual(pngSize(p.file), { width: p.width, height: p.height });
    assert.ok(p.dpi > 0);
    assert.ok(['front', 'back'].includes(p.side));
  }
  // Nothing but pages in OutDir (no half-written files, nothing left behind)
  assert.deepEqual(
    readdirSync(dir).sort(),
    pages.map((p) => p.file.split(/[\\/]/).pop()).sort()
  );
  return { pages, end };
}

for (const [label, exe, prefix] of [
  ['64-bit (paperwing-scan.exe)', x64, 'twain:'],
  ['32-bit (paperwing-twain32.exe)', x86, 'twain32:'],
]) {
  describe(`TWAIN sample scanner, ${label}`, { skip }, () => {
    let scanner;
    let caps;

    before(async () => {
      const r = await runHelper(exe, ['list']);
      console.log(`${label} list (${r.ms} ms):`, JSON.stringify(r.lines));
      scanner = r.lines[0]?.scanners?.find(
        (s) => s.id.startsWith(prefix) && /TWAIN Working Group/i.test(s.make)
      );
    });

    test('is listed', () => {
      assert.ok(scanner, 'the sample scanner is listed');
      assert.equal(scanner.driver, 'twain');
      assert.equal(scanner.api, prefix === 'twain:' ? 'twain64' : 'twain32');
      assert.match(scanner.deviceKey, /^twainworkinggroup:/);
    });

    test('caps: flatbed and feeder with their settings', async () => {
      const r = await runHelper(exe, ['caps', '-Id', scanner.id]);
      console.log(`${label} caps:`, JSON.stringify(r.lines));
      assert.equal(r.code, 0, JSON.stringify(r.lines));
      caps = r.lines[0];
      assert.equal(caps.type, 'caps');
      assert.equal(caps.driver, 'twain');
      assert.equal(caps.nativeUi, true);
      const ids = caps.sources.map((s) => s.id);
      assert.deepEqual(ids, ['flatbed', 'feeder']);
      for (const s of caps.sources) {
        const res = s.resolutions;
        assert.ok(
          Array.isArray(res) ? res.length > 0 : res.max > res.min,
          'resolutions'
        );
        assert.deepEqual(s.colors, ['color', 'gray', 'bw']);
        assert.ok(s.maxWidth >= 8 && s.maxWidth <= 9, `width ${s.maxWidth}`);
        assert.ok(
          s.maxHeight >= 11 && s.maxHeight <= 15,
          `height ${s.maxHeight}`
        );
        assert.ok(s.paperSizes.some((p) => p.name === 'Letter'));
        for (const name of ['brightness', 'contrast', 'threshold']) {
          assert.ok(s[name], name);
          assert.ok(s[name].max > s[name].min, name);
        }
        assert.equal(s.invert, true);
      }
      assert.equal(caps.sources[0].canPreview, true);
      assert.equal(caps.sources[1].canPreview, false);
      assert.equal(typeof caps.sources[1].feederLoaded, 'boolean');
    });

    test('preview: one page of the whole glass at low resolution', async () => {
      const dir = tempDir();
      try {
        const r = await runHelper(exe, [
          'preview',
          '-Id',
          scanner.id,
          '-OutDir',
          dir,
          '-Options',
          b64({ color: 'color' }),
        ]);
        assert.equal(r.code, 0, JSON.stringify(r.lines) + r.stderr);
        const { pages, end } = checkScan(r, dir);
        assert.equal(pages.length, 1);
        assert.deepEqual(end, { type: 'done', pages: 1 });
        assert.ok(
          pages[0].dpi >= 50 && pages[0].dpi <= 150,
          `dpi ${pages[0].dpi}`
        );
        const flatbed = caps.sources[0];
        assert.ok(
          Math.abs(pages[0].width - flatbed.maxWidth * pages[0].dpi) <
            pages[0].dpi * 0.5,
          `width ${pages[0].width}`
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    for (const transfer of ['memory', 'native']) {
      test(`flatbed scan of an area (${transfer} transfer)`, async () => {
        const dir = tempDir();
        try {
          const options = {
            source: 'flatbed',
            color: 'gray',
            dpi: 150,
            area: { x: 1, y: 1, width: 4, height: 3 },
            brightness: 0,
            transfer,
          };
          const r = await runHelper(exe, [
            'scan',
            '-Id',
            scanner.id,
            '-OutDir',
            dir,
            '-Options',
            b64(options),
          ]);
          assert.equal(r.code, 0, JSON.stringify(r.lines) + r.stderr);
          const { pages, end } = checkScan(r, dir);
          assert.equal(pages.length, 1);
          assert.deepEqual(end, { type: 'done', pages: 1 });
          assert.equal(pages[0].dpi, 150);
          assert.equal(pages[0].side, 'front');
          assert.ok(
            Math.abs(pages[0].width - 600) <= 2,
            `width ${pages[0].width}`
          );
          assert.ok(
            Math.abs(pages[0].height - 450) <= 2,
            `height ${pages[0].height}`
          );
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }

    test('black and white, inverted', async () => {
      const dir = tempDir();
      try {
        const options = {
          source: 'flatbed',
          color: 'bw',
          dpi: 100,
          threshold: 128,
          invert: true,
          paper: { width: 8.5, height: 11 },
        };
        const r = await runHelper(exe, [
          'scan',
          '-Id',
          scanner.id,
          '-OutDir',
          dir,
          '-Options',
          b64(options),
        ]);
        assert.equal(r.code, 0, JSON.stringify(r.lines) + r.stderr);
        const { pages } = checkScan(r, dir);
        assert.equal(pages.length, 1);
        // A one-bit-per-pixel PNG (bit depth byte 24 of the header)
        assert.equal(readFileSync(pages[0].file)[24], 1);
        assert.equal(pages[0].width, 850);
        assert.equal(pages[0].height, 1100);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('feeder: every sheet, as each arrives', async () => {
      const dir = tempDir();
      try {
        const r = await runHelper(
          exe,
          [
            'scan',
            '-Id',
            scanner.id,
            '-OutDir',
            dir,
            '-Options',
            b64({ source: 'feeder', color: 'color', dpi: 100 }),
          ],
          {
            env: { CAP_XFERCOUNT: '4' },
          }
        );
        assert.equal(r.code, 0, JSON.stringify(r.lines) + r.stderr);
        const { pages, end } = checkScan(r, dir);
        assert.equal(pages.length, 4);
        assert.deepEqual(end, { type: 'done', pages: 4 });
        assert.ok(pages.every((p) => p.side === 'front'));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("two-sided where the scanner can't: unsupported", async () => {
      const feeder = caps.sources.find((s) => s.id === 'feeder');
      const dir = tempDir();
      try {
        const r = await runHelper(
          exe,
          [
            'scan',
            '-Id',
            scanner.id,
            '-OutDir',
            dir,
            '-Options',
            b64({ source: 'feeder', duplex: true, dpi: 100 }),
          ],
          {
            env: { CAP_XFERCOUNT: '2' },
          }
        );
        if (feeder.duplex) {
          assert.equal(r.code, 0, JSON.stringify(r.lines));
          const { pages } = checkScan(r, dir);
          assert.deepEqual(
            pages.map((p) => p.side),
            ['front', 'back', 'front', 'back']
          );
        } else {
          assert.equal(r.code, 2);
          assert.equal(r.lines.at(-1).code, 'unsupported');
          assert.deepEqual(readdirSync(dir), []);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('cancel mid-feed: stops after the current page and lets go of the scanner', async () => {
      const dir = tempDir();
      try {
        let cancelledAt = 0;
        const r = await runHelper(
          exe,
          [
            'scan',
            '-Id',
            scanner.id,
            '-OutDir',
            dir,
            '-Options',
            b64({ source: 'feeder', color: 'color', dpi: 150 }),
          ],
          {
            env: { CAP_XFERCOUNT: '12' },
            onLine: (msg, child) => {
              if (msg.type === 'page' && !cancelledAt) {
                cancelledAt = Date.now();
                child.stdin.write('cancel\n');
              }
            },
          }
        );
        assert.equal(r.code, 0, JSON.stringify(r.lines) + r.stderr);
        const { pages, end } = checkScan(r, dir);
        assert.equal(end.type, 'done');
        assert.equal(end.cancelled, true);
        assert.equal(end.pages, pages.length);
        assert.ok(
          pages.length >= 1 && pages.length < 12,
          `${pages.length} pages`
        );
        assert.ok(Date.now() - cancelledAt < 10000, 'stopped within 10 s');
        // The scanner is free again: another scan works at once
        const again = await runHelper(exe, [
          'scan',
          '-Id',
          scanner.id,
          '-OutDir',
          dir,
          '-Options',
          b64({ source: 'flatbed', dpi: 75 }),
        ]);
        assert.equal(again.code, 0, JSON.stringify(again.lines));
        assert.equal(again.lines.at(-1).pages, 1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

describe('TWAIN sample scanner, both helpers', { skip }, () => {
  test('the 64-bit and 32-bit drivers are one scanner', async () => {
    const a = (await runHelper(x64, ['list'])).lines[0].scanners.find((s) =>
      /TWAIN Working Group/i.test(s.make)
    );
    const b = (await runHelper(x86, ['list'])).lines[0].scanners.find((s) =>
      /TWAIN Working Group/i.test(s.make)
    );
    assert.ok(a && b);
    assert.notEqual(a.id, b.id);
    assert.equal(a.deviceKey, b.deviceKey);
  });
});
