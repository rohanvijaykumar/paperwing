/**
 * The certificate bridge in the main process (certs.cjs), with a stand-in
 * for the helper process: which helper runs, what it may be asked, what
 * comes back, and how its failures read.
 *
 *   node --test desktop/tests/certs.test.mjs
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const {
  createCerts,
  helperPath,
  isLocalAddress,
  relayAllowed,
  windowHandleOf,
  SIGN_TIMEOUT_MS,
} = require('../certs.cjs');

// A file that exists, standing in for the helper (it's never run)
const dir = mkdtempSync(join(process.env.BENCH_TMP || tmpdir(), 'pw-certs-'));
const HELPER = join(dir, 'paperwing-certs.exe');
writeFileSync(HELPER, '');

const CERT = Buffer.from('a certificate').toString('base64');
const listed = {
  type: 'certs',
  certs: [
    {
      id: 'cu:ABC',
      source: 'smart-card',
      provider: 'Microsoft Smart Card Key Storage Provider',
      certDer: CERT,
      chainDer: [CERT, 'not base64!'],
      hasPrivateKey: true,
      keyAlg: 'ec',
      keyBits: 384,
      curve: 'P-384',
    },
    { id: '', certDer: CERT },
    { id: 'cu:BAD', certDer: '<html>' },
    {
      id: 'cu:ODD',
      source: 'elsewhere',
      certDer: CERT,
      keyAlg: 'dsa',
      curve: 'brainpool',
    },
  ],
};

/** A stand-in for execFile: answers each command with `reply` */
function fakeExec(reply) {
  const calls = [];
  const exec = (file, args, options, cb) => {
    calls.push({ file, args, options });
    const out = typeof reply === 'function' ? reply(args) : reply;
    if (out instanceof Error) cb(out, '');
    else cb(null, typeof out === 'string' ? out : JSON.stringify(out) + '\n');
  };
  return { exec, calls };
}

describe('helperPath', () => {
  test('packaged: in resources/certs, per platform', () => {
    assert.equal(
      helperPath({ platform: 'win32', packaged: true, resourcesPath: 'R' }),
      join('R', 'certs', 'paperwing-certs.exe')
    );
    assert.equal(
      helperPath({ platform: 'darwin', packaged: true, resourcesPath: 'R' }),
      join('R', 'certs', 'paperwing-certs')
    );
  });
  test('development: the build output; the test override only then', () => {
    assert.equal(
      helperPath({ platform: 'win32', packaged: false, devRoot: 'D', env: {} }),
      join('D', 'native', 'win-certs', 'out', 'paperwing-certs.exe')
    );
    assert.equal(
      helperPath({
        platform: 'darwin',
        packaged: false,
        devRoot: 'D',
        env: {},
      }),
      join('D', 'native', 'mac-certs', 'out', 'paperwing-certs')
    );
    const env = { PAPERWING_CERTS_HELPER: 'X' };
    assert.equal(helperPath({ packaged: false, env }), 'X');
    assert.equal(
      helperPath({
        platform: 'win32',
        packaged: true,
        resourcesPath: 'R',
        env,
      }),
      join('R', 'certs', 'paperwing-certs.exe')
    );
  });
  test('Linux: none', () => {
    assert.equal(helperPath({ platform: 'linux', packaged: true }), null);
  });
});

describe('list', () => {
  test('passes on well-formed certificates only, cleaned', async () => {
    const { exec, calls } = fakeExec(listed);
    const certs = createCerts({ helper: HELPER, exec });
    const res = await certs.list();
    assert.equal(res.ok, true);
    assert.deepEqual(calls[0].args, ['list']);
    assert.equal(res.certs.length, 2);
    assert.deepEqual(res.certs[0], {
      id: 'cu:ABC',
      source: 'smart-card',
      provider: 'Microsoft Smart Card Key Storage Provider',
      certDer: CERT,
      chainDer: [CERT],
      hasPrivateKey: true,
      keyAlg: 'ec',
      keyBits: 384,
      curve: 'P-384',
    });
    assert.equal(res.certs[1].source, 'windows-store');
    assert.equal(res.certs[1].keyAlg, null);
    assert.equal(res.certs[1].curve, null);
    assert.equal(res.certs[1].hasPrivateKey, false);
  });
  test('no helper: says so', async () => {
    const certs = createCerts({ helper: join(dir, 'missing.exe') });
    assert.deepEqual(await certs.list(), {
      ok: false,
      error: 'no-helper',
      certs: [],
    });
  });
  test('a helper that fails or prints nonsense', async () => {
    for (const reply of [
      new Error('crashed'),
      'not json',
      { type: 'error', code: 'failed' },
    ]) {
      const certs = createCerts({ helper: HELPER, exec: fakeExec(reply).exec });
      const res = await certs.list();
      assert.equal(res.ok, false);
      assert.deepEqual(res.certs, []);
    }
  });
});

describe('sign', () => {
  const hash = Buffer.alloc(32, 7).toString('base64');

  async function ready(reply) {
    const fake = fakeExec((args) => (args[0] === 'list' ? listed : reply));
    const certs = createCerts({ helper: HELPER, exec: fake.exec });
    await certs.list();
    return { certs, calls: fake.calls };
  }

  test('only ids the last list returned', async () => {
    const { certs, calls } = await ready({ type: 'signature', sig: 'AAAA' });
    assert.deepEqual(await certs.sign('cu:OTHER', hash, 'sha256', ''), {
      ok: false,
      error: 'key-unusable',
    });
    assert.equal(calls.length, 1);
  });

  test('a digest of the right length for its algorithm', async () => {
    const { certs, calls } = await ready({ type: 'signature', sig: 'AAAA' });
    for (const [h, alg] of [
      [hash, 'sha384'],
      [Buffer.alloc(48).toString('base64'), 'sha256'],
      ['not base64', 'sha256'],
      [hash, 'md5'],
    ])
      assert.equal((await certs.sign('cu:ABC', h, alg, '')).ok, false);
    assert.equal(calls.length, 1);
  });

  test('passes the id, digest, algorithm and window; waits for the PIN', async () => {
    const { certs, calls } = await ready({ type: 'signature', sig: 'c2ln' });
    const res = await certs.sign('cu:ABC', hash, 'sha256', '123456');
    assert.deepEqual(res, { ok: true, sig: 'c2ln' });
    const call = calls[1];
    assert.deepEqual(call.args, [
      'sign',
      '-Id',
      'cu:ABC',
      '-Hash',
      hash,
      '-Alg',
      'sha256',
      '-Window',
      '123456',
    ]);
    assert.equal(call.options.timeout, SIGN_TIMEOUT_MS);
    assert.ok(SIGN_TIMEOUT_MS >= 120000);
    assert.equal(call.options.windowsHide, true);
  });

  test('a window handle that isn’t a number is left out', async () => {
    const { certs, calls } = await ready({ type: 'signature', sig: 'c2ln' });
    await certs.sign('cu:ABC', hash, 'sha256', '12; rm -rf');
    assert.ok(!calls[1].args.includes('-Window'));
  });

  test('the helper’s error codes come through; anything else is "failed"', async () => {
    for (const code of [
      'cancelled',
      'wrong-pin',
      'pin-blocked',
      'card-removed',
      'key-unusable',
      'failed',
    ]) {
      const { certs } = await ready({ type: 'error', code });
      assert.deepEqual(await certs.sign('cu:ABC', hash, 'sha256', ''), {
        ok: false,
        error: code,
      });
    }
    const { certs } = await ready({ type: 'error', code: 'weird' });
    assert.equal(
      (await certs.sign('cu:ABC', hash, 'sha256', '')).error,
      'failed'
    );
  });

  test('a helper that runs out of time', async () => {
    const err = Object.assign(new Error('timed out'), {
      killed: true,
      signal: 'SIGTERM',
    });
    const { certs } = await ready(err);
    assert.equal(
      (await certs.sign('cu:ABC', hash, 'sha256', '')).error,
      'timeout'
    );
  });

  test('a signature that isn’t base64 is refused', async () => {
    const { certs } = await ready({ type: 'signature', sig: '<script>' });
    assert.equal((await certs.sign('cu:ABC', hash, 'sha256', '')).ok, false);
  });
});

describe('roots and the window handle', () => {
  test('roots: base64 certificates only', async () => {
    const certs = createCerts({
      helper: HELPER,
      exec: fakeExec({ type: 'roots', certs: [CERT, 42, '!!'] }).exec,
    });
    assert.deepEqual(await certs.roots(), { ok: true, certs: [CERT] });
  });
  test('HWND from Electron’s buffer, as a decimal number', () => {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(0x1a2b3cn);
    assert.equal(
      windowHandleOf({ getNativeWindowHandle: () => buf }),
      String(0x1a2b3c)
    );
    assert.equal(windowHandleOf(null), '');
    assert.equal(
      windowHandleOf({ getNativeWindowHandle: () => Buffer.alloc(0) }),
      ''
    );
  });
});

describe('the relay to timestamp and certificate servers', () => {
  test('knows this computer’s addresses in every form', () => {
    for (const a of [
      '127.0.0.1',
      '127.8.8.8',
      '::1',
      '[::1]',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '169.254.169.254',
      '0.0.0.0',
      '::',
      'fe80::1',
    ])
      assert.equal(isLocalAddress(a), true, a);
    for (const a of ['10.0.0.5', '192.168.1.2', '8.8.8.8', '2001:db8::1'])
      assert.equal(isLocalAddress(a), false, a);
  });

  test('resolves names first: "localhost." or a name for 127.0.0.1 don’t get through', async () => {
    const lookup = async (host) =>
      ({
        'localhost.': [{ address: '127.0.0.1', family: 4 }],
        'sneaky.example': [
          { address: '93.184.216.34', family: 4 },
          { address: '::1', family: 6 },
        ],
        'tsa.example': [{ address: '93.184.216.34', family: 4 }],
        '::ffff:7f00:1': [{ address: '::ffff:7f00:1', family: 6 }],
        'ocsp.corp.example': [{ address: '10.1.2.3', family: 4 }],
      })[host] ??
      Promise.reject(
        Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
      );
    assert.equal(await relayAllowed('localhost.', lookup), false);
    assert.equal(await relayAllowed('sneaky.example', lookup), false);
    assert.equal(await relayAllowed('[::ffff:7f00:1]', lookup), false);
    assert.equal(await relayAllowed('tsa.example', lookup), true);
    // (a company's own certificate server on its network is fine)
    assert.equal(await relayAllowed('ocsp.corp.example', lookup), true);
    assert.equal(await relayAllowed('unknown.example', lookup), true);
  });
});
