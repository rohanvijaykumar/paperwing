#!/usr/bin/env node
/**
 * A stand-in certificate helper (development only, never shipped): speaks
 * native/win-certs' protocol (one command, one JSON line on stdout) with
 * made-up Digital IDs, so screenshots of Sign with a Digital ID never show
 * the certificates of the computer they're taken on. index.mjs makes the
 * IDs; the app reaches this through PAPERWING_CERTS_HELPER (a launcher on
 * Windows, this file itself elsewhere).
 *
 *   list   → {"type":"certs","certs":[…]}  the IDs in ids.json
 *   sign -Id <id> -Hash <base64> -Alg sha256|sha384
 *          → {"type":"signature","sig":"<base64>"}  RSA PKCS#1 v1.5 with
 *            the ID's key, like Windows signs
 *   roots  → {"type":"roots","certs":[…]}  the made-up root, so Validate
 *            signatures trusts the IDs
 *
 * PAPERWING_CERTS_STANDIN_DIR: the folder index.mjs made.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const fail = (code) => {
  out({ type: 'error', code });
  process.exit(2);
};

const dir = process.env.PAPERWING_CERTS_STANDIN_DIR;
if (!dir) fail('failed');
const { ids, rootDer } = JSON.parse(
  fs.readFileSync(path.join(dir, 'ids.json'), 'utf8')
);

/** DigestInfo prefixes: what Windows puts before the digest (PKCS#1 v1.5) */
const DIGEST_INFO = {
  sha256: '3031300d060960864801650304020105000420',
  sha384: '3041300d060960864801650304020205000430',
};

const [command, ...rest] = process.argv.slice(2);
const arg = (name) => rest[rest.indexOf(`-${name}`) + 1];

if (command === 'list') {
  out({
    type: 'certs',
    // (the keys stay in the folder)
    certs: ids.map(({ keyFile: _keyFile, ...c }) => c),
  });
} else if (command === 'roots') {
  out({ type: 'roots', certs: [rootDer] });
} else if (command === 'sign') {
  const id = ids.find((c) => c.id === arg('Id'));
  const prefix = DIGEST_INFO[arg('Alg')];
  if (!id || !prefix) fail('key-unusable');
  const digest = Buffer.from(arg('Hash') ?? '', 'base64');
  const key = fs.readFileSync(path.join(dir, id.keyFile));
  const sig = crypto.privateEncrypt(
    { key, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.concat([Buffer.from(prefix, 'hex'), digest])
  );
  out({ type: 'signature', sig: sig.toString('base64') });
} else fail('failed');
