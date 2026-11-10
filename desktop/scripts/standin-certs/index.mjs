/**
 * Made-up Digital IDs for screenshots (development only): Daniel Reyes's ID
 * in the Windows store, on a smart card and on a USB token, issued by a
 * made-up Northbeam CA, made with OpenSSL into a folder, and a stand-in
 * certificate helper that lists them, signs with them and trusts their root
 * (helper.cjs). Nothing is read from or added to the computer's own
 * certificate store.
 *
 *   const { env } = standinCerts('D:/tmp/ids');
 *   launch({ env }); // bench/harness.mjs: the app lists only these IDs
 *
 * Needs openssl on the PATH (Git for Windows has one) and, on Windows, the
 * C# compiler that comes with Windows (for the launcher, see launcher.cs).
 */
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** The IDs, in the order the dialog lists them (all named alike) */
export const STANDIN_IDS = [
  {
    file: 'windows',
    source: 'windows-store',
    provider: 'Microsoft Software Key Storage Provider',
    ca: 'Northbeam Issuing CA 1',
    notAfter: '20280301120000Z',
  },
  {
    file: 'card',
    source: 'smart-card',
    provider: 'Microsoft Smart Card Key Storage Provider',
    ca: 'Northbeam Smart Card CA',
    notAfter: '20290609120000Z',
  },
  {
    file: 'token',
    source: 'token',
    provider: 'USB Token Key Storage Provider',
    ca: 'Northbeam Qualified Signing CA',
    notAfter: '20280831120000Z',
  },
];
export const STANDIN_NAME = 'Daniel Reyes';
export const STANDIN_EMAIL = 'daniel.reyes@northbeam.example';

const EXTENSIONS = `[ca]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
[leaf]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, nonRepudiation
extendedKeyUsage = emailProtection, 1.3.6.1.4.1.311.10.3.12
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
subjectAltName = email:${STANDIN_EMAIL}
`;

/**
 * Makes the IDs and the helper in `dir` (once; again if it's missing) and
 * returns the environment that points the app at them.
 */
export function standinCerts(dir) {
  mkdirSync(dir, { recursive: true });
  const at = (f) => join(dir, f);
  const ssl = (...args) =>
    execFileSync('openssl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  if (!existsSync(at('ids.json'))) {
    writeFileSync(at('ext.cnf'), EXTENSIONS);
    const key = (name) =>
      ssl(
        'genpkey',
        '-algorithm',
        'RSA',
        '-pkeyopt',
        'rsa_keygen_bits:2048',
        '-out',
        at(`${name}.key`)
      );
    const csr = (name, subject) =>
      ssl(
        'req',
        '-new',
        '-key',
        at(`${name}.key`),
        '-subj',
        subject,
        '-out',
        at(`${name}.csr`)
      );
    const issue = (name, ca, ext, dates) =>
      ssl(
        'x509',
        '-req',
        '-in',
        at(`${name}.csr`),
        '-CA',
        at(`${ca}.pem`),
        '-CAkey',
        at(`${ca}.key`),
        '-set_serial',
        `0x${Buffer.from(name).toString('hex')}01`,
        ...dates,
        '-sha256',
        '-extfile',
        at('ext.cnf'),
        '-extensions',
        ext,
        '-out',
        at(`${name}.pem`)
      );
    const caDates = [
      '-not_before',
      '20250101000000Z',
      '-not_after',
      '20350101000000Z',
    ];
    key('root');
    ssl(
      'req',
      '-x509',
      '-new',
      '-key',
      at('root.key'),
      '-subj',
      '/O=Northbeam Studio/CN=Northbeam Root CA',
      '-not_before',
      '20250101000000Z',
      '-not_after',
      '20400101000000Z',
      '-sha256',
      '-config',
      at('ext.cnf'),
      '-extensions',
      'ca',
      '-out',
      at('root.pem')
    );
    const der = (name) =>
      new X509Certificate(readFileSync(at(`${name}.pem`))).raw;
    const ids = STANDIN_IDS.map((id) => {
      const ca = `${id.file}-ca`;
      key(ca);
      csr(ca, `/O=Northbeam Studio/CN=${id.ca}`);
      issue(ca, 'root', 'ca', caDates);
      key(id.file);
      csr(
        id.file,
        `/O=Northbeam Studio/CN=${STANDIN_NAME}/emailAddress=${STANDIN_EMAIL}`
      );
      issue(id.file, ca, 'leaf', [
        '-not_before',
        '20251101000000Z',
        '-not_after',
        id.notAfter,
      ]);
      const cert = new X509Certificate(readFileSync(at(`${id.file}.pem`)));
      return {
        id: `cu:${cert.fingerprint.replace(/:/g, '')}`,
        source: id.source,
        provider: id.provider,
        certDer: der(id.file).toString('base64'),
        chainDer: [der(ca), der('root')].map((d) => d.toString('base64')),
        hasPrivateKey: true,
        keyAlg: 'rsa',
        keyBits: 2048,
        curve: null,
        keyFile: `${id.file}.key`,
      };
    });
    writeFileSync(
      at('ids.json'),
      JSON.stringify({ ids, rootDer: der('root').toString('base64') })
    );
  }

  // The helper the app runs: an .exe on Windows, the script elsewhere
  let helper;
  const script = join(here, 'helper.cjs');
  if (process.platform === 'win32') {
    helper = at('paperwing-certs.exe');
    if (!existsSync(helper)) {
      const csc = join(
        process.env.WINDIR || 'C:/Windows',
        'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
      );
      execFileSync(csc, [
        '-nologo',
        `-out:${helper}`,
        join(here, 'launcher.cs'),
      ]);
    }
  } else {
    helper = at('paperwing-certs');
    copyFileSync(script, helper);
    chmodSync(helper, 0o755);
  }
  return {
    helper,
    env: {
      PAPERWING_CERTS_HELPER: helper,
      PAPERWING_CERTS_STANDIN: script,
      PAPERWING_CERTS_STANDIN_DIR: dir,
      PAPERWING_CERTS_STANDIN_NODE: process.execPath,
    },
  };
}
