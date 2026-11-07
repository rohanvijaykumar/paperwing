/**
 * Signing with certificates installed on this computer: the bridge between
 * the app page and the certificate helper (native/win-certs on Windows,
 * native/mac-certs on macOS). The helper lists the certificates (without
 * opening any private key, so no PIN prompt) and signs a digest with one;
 * the private key never leaves Windows, the Keychain or the smart card.
 *
 * One helper process per command; it prints one JSON line. Ids the page
 * passes are only ever ones the last list returned. Digests and keys are
 * never logged.
 */
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** Signing can wait at the PIN prompt this long */
const SIGN_TIMEOUT_MS = 120000;
const LIST_TIMEOUT_MS = 30000;
const MAX_OUTPUT = 64 * 1024 * 1024;
const ERROR_CODES = new Set([
  'cancelled',
  'wrong-pin',
  'pin-blocked',
  'card-removed',
  'key-unusable',
  'failed',
]);

/** Where the helper is: next to the app's resources once packaged, the
 *  build output in a development checkout; PAPERWING_CERTS_HELPER (tests) */
function helperPath({
  platform = process.platform,
  packaged,
  resourcesPath,
  devRoot = __dirname,
  env = process.env,
} = {}) {
  if (!packaged && env.PAPERWING_CERTS_HELPER)
    return env.PAPERWING_CERTS_HELPER;
  const exe = platform === 'win32' ? 'paperwing-certs.exe' : 'paperwing-certs';
  if (platform !== 'win32' && platform !== 'darwin') return null;
  if (packaged) return path.join(resourcesPath, 'certs', exe);
  const dir = platform === 'win32' ? 'win-certs' : 'mac-certs';
  return path.join(devRoot, 'native', dir, 'out', exe);
}

/** Runs one helper command; resolves with its JSON line */
function runHelper(file, args, timeout, exec = execFile) {
  return new Promise((resolve) => {
    exec(
      file,
      args,
      { timeout, windowsHide: true, maxBuffer: MAX_OUTPUT, encoding: 'utf8' },
      (err, stdout) => {
        const line = String(stdout ?? '')
          .split(/\r?\n/)
          .find((l) => l.startsWith('{'));
        let msg;
        try {
          msg = line ? JSON.parse(line) : null;
        } catch {
          msg = null;
        }
        if (msg && typeof msg === 'object') return resolve(msg);
        if (err?.killed || err?.signal === 'SIGTERM')
          return resolve({ type: 'error', code: 'timeout' });
        if (err?.code === 'ENOENT')
          return resolve({ type: 'error', code: 'no-helper' });
        resolve({ type: 'error', code: 'failed' });
      }
    );
  });
}

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

function cleanCert(c) {
  if (!c || typeof c !== 'object') return null;
  const str = (v, max = 4096) =>
    typeof v === 'string' && v.length <= max ? v : '';
  const id = str(c.id, 512);
  const certDer = str(c.certDer, 1 << 20);
  if (!id || !certDer || !B64.test(certDer)) return null;
  return {
    id,
    source: ['windows-store', 'smart-card', 'keychain', 'token'].includes(
      c.source
    )
      ? c.source
      : 'windows-store',
    provider: str(c.provider, 512),
    certDer,
    chainDer: Array.isArray(c.chainDer)
      ? c.chainDer.filter((d) => typeof d === 'string' && B64.test(d))
      : [],
    hasPrivateKey: c.hasPrivateKey === true,
    keyAlg: c.keyAlg === 'rsa' || c.keyAlg === 'ec' ? c.keyAlg : null,
    keyBits: Number.isInteger(c.keyBits) ? c.keyBits : 0,
    curve: ['P-256', 'P-384', 'P-521'].includes(c.curve) ? c.curve : null,
  };
}

/**
 * @param {{ helper: string | null, exec?: typeof execFile }} deps
 */
function createCerts({ helper, exec = execFile }) {
  /** Ids from the last list: sign only takes one of these */
  let known = new Set();

  const available = () => !!helper && fs.existsSync(helper);

  async function list() {
    if (!available()) return { ok: false, error: 'no-helper', certs: [] };
    const msg = await runHelper(helper, ['list'], LIST_TIMEOUT_MS, exec);
    if (msg.type !== 'certs' || !Array.isArray(msg.certs))
      return { ok: false, error: msg.code ?? 'failed', certs: [] };
    const certs = msg.certs.map(cleanCert).filter(Boolean);
    known = new Set(certs.map((c) => c.id));
    return { ok: true, certs };
  }

  /**
   * @param {string} id  one the last list returned
   * @param {string} hash  base64 digest
   * @param {'sha256'|'sha384'} alg
   * @param {string} windowHandle  the window the PIN prompt belongs to
   */
  async function sign(id, hash, alg, windowHandle) {
    if (!available()) return { ok: false, error: 'no-helper' };
    if (typeof id !== 'string' || !known.has(id))
      return { ok: false, error: 'key-unusable' };
    const length = alg === 'sha384' ? 48 : alg === 'sha256' ? 32 : 0;
    if (
      !length ||
      typeof hash !== 'string' ||
      !B64.test(hash) ||
      Buffer.from(hash, 'base64').length !== length
    )
      return { ok: false, error: 'failed' };
    const args = ['sign', '-Id', id, '-Hash', hash, '-Alg', alg];
    if (windowHandle && /^\d+$/.test(windowHandle))
      args.push('-Window', windowHandle);
    const msg = await runHelper(helper, args, SIGN_TIMEOUT_MS, exec);
    if (
      msg.type === 'signature' &&
      typeof msg.sig === 'string' &&
      B64.test(msg.sig)
    )
      return { ok: true, sig: msg.sig };
    const code =
      ERROR_CODES.has(msg.code) ||
      msg.code === 'timeout' ||
      msg.code === 'no-helper'
        ? msg.code
        : 'failed';
    return { ok: false, error: code };
  }

  /** The system's trusted root certificates (Validate signatures) */
  async function roots() {
    if (!available()) return { ok: false, certs: [] };
    const msg = await runHelper(helper, ['roots'], LIST_TIMEOUT_MS, exec);
    if (msg.type !== 'roots' || !Array.isArray(msg.certs))
      return { ok: false, certs: [] };
    return {
      ok: true,
      certs: msg.certs.filter((d) => typeof d === 'string' && B64.test(d)),
    };
  }

  return { available, list, sign, roots };
}

/** The window handle as the helper takes it: a decimal number (HWND on
 *  Windows; the window number on macOS isn't used) */
function windowHandleOf(win) {
  try {
    const buf = win?.getNativeWindowHandle?.();
    if (!buf || !buf.length) return '';
    return buf.length >= 8
      ? buf.readBigUInt64LE(0).toString()
      : String(buf.readUInt32LE(0));
  } catch {
    return '';
  }
}

module.exports = {
  createCerts,
  helperPath,
  runHelper,
  windowHandleOf,
  SIGN_TIMEOUT_MS,
};
