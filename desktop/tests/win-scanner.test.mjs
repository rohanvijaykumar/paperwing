/**
 * The Windows scanner helpers (desktop/native/win-scanner), run for real:
 * paperwing-scan.exe (x64) and paperwing-twain32.exe (x86). Without a
 * scanner: they list cleanly, reject bad arguments with an error line, and
 * report unknown scanners as "no-scanner".
 *
 *   node desktop/native/win-scanner/build.mjs
 *   node --test desktop/tests/win-scanner.test.mjs
 *
 * PAPERWING_SCANNER_DIR: where the helpers are (default: the build output).
 * PAPERWING_EXPECT_NO_SCANNERS=1 (CI): the list must be empty, and quick.
 * PAPERWING_REQUIRE_SCANNER=1 (CI): fail rather than skip if not built.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { helperDir, runHelper } from './win-scanner-run.mjs';

const x64 = join(helperDir, 'paperwing-scan.exe');
const x86 = join(helperDir, 'paperwing-twain32.exe');
const built = existsSync(x64) && existsSync(x86);
if (
  process.platform === 'win32' &&
  !built &&
  process.env.PAPERWING_REQUIRE_SCANNER
)
  throw new Error(`Scanner helpers not built in ${helperDir}`);
const skip =
  process.platform !== 'win32'
    ? 'Windows only'
    : !built
      ? 'helpers not built (node desktop/native/win-scanner/build.mjs)'
      : false;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');

describe('Windows scanner helpers', { skip }, () => {
  test('list prints one scanners line and exits cleanly', async () => {
    for (const exe of [x64, x86]) {
      const r = await runHelper(exe, ['list']);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.lines.length, 1);
      assert.equal(r.lines[0].type, 'scanners');
      assert.ok(Array.isArray(r.lines[0].scanners));
      for (const s of r.lines[0].scanners) {
        assert.equal(typeof s.id, 'string');
        assert.ok(['wia', 'twain'].includes(s.driver));
        assert.ok(['usb', 'network', 'unknown'].includes(s.connection));
        assert.match(s.deviceKey, /^[a-z0-9]*:[a-z0-9]*(#.+)?$/);
        for (const key of ['name', 'make', 'model', 'api'])
          assert.equal(typeof s[key], 'string');
      }
      if (exe === x86)
        assert.ok(
          r.lines[0].scanners.every((s) => s.id.startsWith('twain32:'))
        );
    }
  });

  test(
    'with no scanners: an empty list, in under 2 seconds',
    {
      skip:
        !process.env.PAPERWING_EXPECT_NO_SCANNERS &&
        'set PAPERWING_EXPECT_NO_SCANNERS=1',
    },
    async () => {
      for (const exe of [x64, x86]) {
        // The first run warms the disk cache; the second is what Paperwing sees
        await runHelper(exe, ['list']);
        const r = await runHelper(exe, ['list']);
        console.log(`${exe.split(/[\\/]/).pop()} list: ${r.ms} ms`);
        assert.deepEqual(r.lines, [{ type: 'scanners', scanners: [] }]);
        assert.ok(r.ms < 2000, `list took ${r.ms} ms`);
      }
    }
  );

  test('bad arguments are an error line and exit code 2', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pw-winscan-'));
    try {
      const cases = [
        [[], /No command/],
        [['print'], /Unknown command "print"/],
        [['caps'], /-Id is required/],
        [['caps', '-Id'], /-Id needs a value/],
        [['scan', '-Id', 'twain:x'], /-OutDir is required/],
        [
          ['scan', '-Id', 'twain:x', '-OutDir', join(dir, 'nope')],
          /-OutDir doesn't exist/,
        ],
        [
          ['scan', '-Id', 'twain:x', '-OutDir', dir, '-Options', '%%%'],
          /isn't base64/,
        ],
        [
          [
            'scan',
            '-Id',
            'twain:x',
            '-OutDir',
            dir,
            '-Options',
            b64({ color: 'pink' }),
          ],
          /color must be one of/,
        ],
        [
          [
            'preview',
            '-Id',
            'twain:x',
            '-OutDir',
            dir,
            '-Options',
            b64({ dpi: 0 }),
          ],
          /dpi must be/,
        ],
        [
          ['scan', '-Id', 'twain:x', '-OutDir', dir, '-Window', 'here'],
          /-Window must be/,
        ],
      ];
      for (const [args, message] of cases) {
        const r = await runHelper(x64, args);
        assert.equal(r.code, 2, `${args.join(' ')}: exit ${r.code}`);
        assert.equal(r.lines.length, 1, args.join(' '));
        assert.equal(r.lines[0].type, 'error');
        assert.equal(r.lines[0].code, 'failed');
        assert.match(r.lines[0].message, message);
      }
      assert.deepEqual(readdirSync(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('caps for an unknown scanner: no-scanner', async () => {
    const cases = [
      [x64, 'wia:{6BDD1FC6-810F-11D0-BEC7-08002BE2092F}\\9999'],
      [x64, 'twain:Paperwing Missing Scanner'],
      [x64, 'twain32:Paperwing Missing Scanner'],
      [x64, 'escl:somewhere'],
      [x86, 'twain32:Paperwing Missing Scanner'],
      [x86, 'wia:{6BDD1FC6-810F-11D0-BEC7-08002BE2092F}\\9999'],
      [x86, 'twain:Paperwing Missing Scanner'],
    ];
    for (const [exe, id] of cases) {
      const r = await runHelper(exe, ['caps', '-Id', id]);
      assert.equal(r.code, 2, `${id}: exit ${r.code}`);
      assert.deepEqual(
        r.lines.map((l) => [l.type, l.code]),
        [['error', 'no-scanner']],
        id
      );
    }
  });

  test('scanning an unknown scanner: no-scanner, nothing written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pw-winscan-'));
    try {
      for (const [exe, cmd, id] of [
        [x64, 'scan', 'twain:Paperwing Missing Scanner'],
        [x64, 'preview', 'wia:{6BDD1FC6-810F-11D0-BEC7-08002BE2092F}\\9999'],
        [x86, 'scan', 'twain32:Paperwing Missing Scanner'],
      ]) {
        const r = await runHelper(exe, [
          cmd,
          '-Id',
          id,
          '-OutDir',
          dir,
          '-Options',
          b64({ source: 'flatbed', dpi: 150 }),
        ]);
        assert.equal(r.code, 2);
        assert.deepEqual(
          r.lines.map((l) => [l.type, l.code]),
          [['error', 'no-scanner']]
        );
      }
      assert.deepEqual(readdirSync(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the old -DeviceId name still works', async () => {
    const r = await runHelper(x64, [
      'caps',
      '-DeviceId',
      'twain:Paperwing Missing Scanner',
    ]);
    assert.equal(r.lines[0].code, 'no-scanner');
  });
});
