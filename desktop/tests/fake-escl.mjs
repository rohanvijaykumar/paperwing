/**
 * A pretend eSCL (AirScan / Mopria) network scanner, for tests and benches.
 * It speaks the protocol over HTTP or HTTPS (with a self-signed certificate
 * made on the spot), sends real JPEG and PNG pages, can announce itself over
 * multicast DNS, and can misbehave the ways real scanners do.
 *
 *   import { startFakeEscl } from './fake-escl.mjs';
 *   const scanner = await startFakeEscl({ adf: { sheets: 3, duplex: true } });
 *   ... scanner.url, scanner.host, scanner.port, scanner.uuid ...
 *   await scanner.close();
 *
 * Or from a shell (prints one JSON line with its address, runs until killed):
 *   node desktop/tests/fake-escl.mjs --port 8090 --adf 3 --duplex [--https] [--mdns] [--log]
 *
 * Options (all optional):
 *   name, uuid, makeAndModel, serverHeader, log (prints each request)
 *   https: true                       self-signed certificate
 *   platen: false                     no flatbed
 *   adf: { sheets, duplex } | false   a document feeder with sheets in it
 *   resolutions: [75, 150, ...] | { min, max, step }
 *   colorModes: ['RGB24', 'Grayscale8', 'BlackAndWhite1']
 *   formats: ['image/jpeg', 'image/png', 'application/pdf']
 *   brightness: true, threshold: true, sharpen: false, blankPage: false
 *   justification: 'Center' | 'Left' | 'Right'   (the feeder's)
 *   quirks: { hpCompact }   (HP's server: new jobs need Host: localhost)
 *   errors: {
 *     busy: n          the first n new jobs: 503 and "Processing"
 *     flaky: n         every kind of request answers 503 n times first
 *     jamAfter: n      the feeder jams after n sheets
 *     multipickAfter: n  two sheets pulled together after n sheets
 *     coverOpen: true  the feeder's door is open
 *     lateFirstPage: n the first n page requests of a job: 404 while the
 *                      job is still "Processing" (as some Xerox do)
 *     slowPageMs: ms   each page takes this long
 *     hang: 'caps' | 'status' | 'page'   never answers that request
 *   }
 *   mdns: { port: 5353 } (the real multicast group) | { port: 0 } (a
 *     loopback port, for tests: scanner.mdnsPort) | false; address: the
 *     IPv4 address it announces (default: this computer's)
 */
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { encodePacket, decodePacket, TYPE, MDNS_ADDRESS, MDNS_PORT } = require('../mdns.cjs');

// --- Images ----------------------------------------------------------------

/**
 * A test page: white paper, a border, a band at the top, `n` blocks (the
 * page number) and, on a back side, a bar at the bottom.
 * Returns { width, height, channels: 1 | 3, data }.
 */
export function drawPage(width, height, { n = 1, color = 'color', side = 'front' } = {}) {
  const channels = color === 'color' ? 3 : 1;
  const data = Buffer.alloc(width * height * channels, 255);
  const ink = color === 'color' ? [30, 90, 200] : color === 'gray' ? [110, 110, 110] : [0, 0, 0];
  const fill = (x0, y0, w, h, rgb) => {
    for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y++)
      for (let x = Math.max(0, x0); x < Math.min(width, x0 + w); x++) {
        const i = (y * width + x) * channels;
        if (channels === 3) [data[i], data[i + 1], data[i + 2]] = rgb;
        else data[i] = Math.round(rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114);
      }
  };
  const b = Math.max(1, Math.round(width / 200));
  fill(0, 0, width, b, [0, 0, 0]);
  fill(0, height - b, width, b, [0, 0, 0]);
  fill(0, 0, b, height, [0, 0, 0]);
  fill(width - b, 0, b, height, [0, 0, 0]);
  fill(b, b, width - 2 * b, Math.round(height * 0.05), ink);
  const size = Math.max(2, Math.round(width / 14));
  for (let i = 0; i < n; i++)
    fill(
      Math.round(width * 0.08) + (i % 8) * Math.round(size * 1.3),
      Math.round(height * 0.12) + Math.floor(i / 8) * Math.round(size * 1.3),
      size,
      size,
      [0, 0, 0]
    );
  if (side === 'back') fill(Math.round(width * 0.1), Math.round(height * 0.9), Math.round(width * 0.8), size, ink);
  return { width, height, channels, data };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** PNG: RGB or gray, 8 bits; bits: 1 for black and white */
export function encodePng({ width, height, channels, data }, { bits = 8, dpi } = {}) {
  const chunk = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])));
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bits;
  ihdr[9] = channels === 3 ? 2 : 0;
  const rowBytes = bits === 1 ? Math.ceil(width / 8) : width * channels;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (rowBytes + 1) + 1;
    if (bits === 1) {
      for (let x = 0; x < width; x++)
        if (data[y * width + x] >= 128) raw[row + (x >> 3)] |= 0x80 >> (x & 7);
    } else data.copy(raw, row, y * rowBytes, (y + 1) * rowBytes);
  }
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
  if (dpi) {
    const phys = Buffer.alloc(9);
    const ppm = Math.round(dpi / 0.0254);
    phys.writeUInt32BE(ppm, 0);
    phys.writeUInt32BE(ppm, 4);
    phys[8] = 1;
    parts.push(chunk('pHYs', phys));
  }
  parts.push(chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// Baseline JPEG (ITU T.81): 4:4:4, one quantisation table and the standard
// luminance Huffman tables for every component (any table may serve any
// component), which keeps this short.
const ZIGZAG = (() => {
  const order = [];
  for (let s = 0; s < 15; s++)
    for (let i = 0; i <= s; i++) {
      const [r, c] = s % 2 ? [i, s - i] : [s - i, i];
      if (r < 8 && c < 8) order.push(r * 8 + c);
    }
  return order;
})();
const BASE_Q = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29,
  51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121,
  120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_VALS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14,
  0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09,
  0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a,
  0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65,
  0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88,
  0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9,
  0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca,
  0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea,
  0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];
function huffmanCodes(bits, vals) {
  const codes = {};
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len - 1]; i++) codes[vals[k++]] = [code++, len];
    code <<= 1;
  }
  return codes;
}
const DC_CODES = huffmanCodes(DC_BITS, DC_VALS);
const AC_CODES = huffmanCodes(AC_BITS, AC_VALS);
const COS = Array.from({ length: 64 }, (_, i) => Math.cos(((2 * (i >> 3) + 1) * (i & 7) * Math.PI) / 16));

export function encodeJpeg({ width, height, channels, data }, { quality = 80, dpi = 0 } = {}) {
  const scale = quality < 50 ? 5000 / quality : 200 - quality * 2;
  const q = BASE_Q.map((v) => Math.min(255, Math.max(1, Math.floor((v * scale + 50) / 100))));
  const out = [];
  let acc = 0;
  let nbits = 0;
  const put = (code, len) => {
    acc = (acc << len) | code;
    nbits += len;
    while (nbits >= 8) {
      const byte = (acc >> (nbits - 8)) & 0xff;
      out.push(byte);
      if (byte === 0xff) out.push(0);
      nbits -= 8;
    }
    acc &= (1 << nbits) - 1;
  };
  const category = (v) => (v === 0 ? 0 : 32 - Math.clz32(Math.abs(v)));
  const valueBits = (v, size) => (v >= 0 ? v : v + (1 << size) - 1);

  const comps = channels;
  const pred = new Array(comps).fill(0);
  const block = new Float64Array(64);
  const tmp = new Float64Array(64);
  const sample = (x, y, c) => {
    const i = (Math.min(y, height - 1) * width + Math.min(x, width - 1)) * channels;
    if (channels === 1) return data[i];
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    if (c === 0) return 0.299 * r + 0.587 * g + 0.114 * b;
    if (c === 1) return -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
    return 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
  };
  for (let by = 0; by < height; by += 8)
    for (let bx = 0; bx < width; bx += 8)
      for (let c = 0; c < comps; c++) {
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) block[y * 8 + x] = sample(bx + x, by + y, c) - 128;
        // Separable DCT: rows, then columns
        for (let y = 0; y < 8; y++)
          for (let u = 0; u < 8; u++) {
            let s = 0;
            for (let x = 0; x < 8; x++) s += block[y * 8 + x] * COS[x * 8 + u];
            tmp[y * 8 + u] = s * (u ? 0.5 : Math.SQRT1_2 / 2);
          }
        for (let u = 0; u < 8; u++)
          for (let v = 0; v < 8; v++) {
            let s = 0;
            for (let y = 0; y < 8; y++) s += tmp[y * 8 + u] * COS[y * 8 + v];
            block[v * 8 + u] = s * (v ? 0.5 : Math.SQRT1_2 / 2);
          }
        const zz = ZIGZAG.map((pos) => Math.round(block[pos] / q[pos]));
        const diff = zz[0] - pred[c];
        pred[c] = zz[0];
        const dc = category(diff);
        put(...DC_CODES[dc]);
        if (dc) put(valueBits(diff, dc), dc);
        let run = 0;
        for (let k = 1; k < 64; k++) {
          const v = zz[k];
          if (v === 0) {
            run++;
            continue;
          }
          while (run > 15) {
            put(...AC_CODES[0xf0]);
            run -= 16;
          }
          const size = category(v);
          put(...AC_CODES[(run << 4) | size]);
          put(valueBits(v, size), size);
          run = 0;
        }
        if (run) put(...AC_CODES[0x00]);
      }
  if (nbits) put((1 << (8 - nbits)) - 1, 8 - nbits);

  const seg = (marker, body) => {
    const head = Buffer.from([0xff, marker, 0, 0]);
    head.writeUInt16BE(body.length + 2, 2);
    return Buffer.concat([head, Buffer.from(body)]);
  };
  const jfif = Buffer.from([0x4a, 0x46, 0x49, 0x46, 0, 1, 1, dpi ? 1 : 0, 0, 0, 0, 0, 0, 0]);
  jfif.writeUInt16BE(dpi || 1, 8);
  jfif.writeUInt16BE(dpi || 1, 10);
  const sof = [8, height >> 8, height & 255, width >> 8, width & 255, comps];
  const sos = [comps];
  for (let c = 0; c < comps; c++) {
    sof.push(c + 1, 0x11, 0);
    sos.push(c + 1, 0x00);
  }
  sos.push(0, 63, 0);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, jfif),
    seg(0xdb, [0, ...ZIGZAG.map((pos) => q[pos])]),
    seg(0xc0, sof),
    seg(0xc4, [0x00, ...DC_BITS, ...DC_VALS, 0x10, ...AC_BITS, ...AC_VALS]),
    seg(0xda, sos),
    Buffer.from(out),
    Buffer.from([0xff, 0xd9]),
  ]);
}

// --- A self-signed certificate (as a scanner's own) -------------------------

function der(tag, ...parts) {
  const body = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  const len = body.length;
  const head =
    len < 128 ? [tag, len] : len < 256 ? [tag, 0x81, len] : [tag, 0x82, len >> 8, len & 255];
  return Buffer.concat([Buffer.from(head), body]);
}
const seq = (...p) => der(0x30, ...p);
function oid(text) {
  const [a, b, ...rest] = text.split('.').map(Number);
  const bytes = [40 * a + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = n >> 7; v; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return der(0x06, bytes);
}
const utcTime = (d) => der(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));

export function selfSignedCertificate(commonName = 'Paperwing test scanner') {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const alg = seq(oid('1.2.840.10045.4.3.2')); // ecdsa-with-SHA256
  const name = seq(der(0x31, seq(oid('2.5.4.3'), der(0x0c, Buffer.from(commonName)))));
  const serial = crypto.randomBytes(8);
  serial[0] &= 0x7f;
  const now = Date.now();
  const tbs = seq(
    der(0x02, serial),
    alg,
    name,
    seq(utcTime(new Date(now - 86400000)), utcTime(new Date(now + 365 * 86400000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' })
  );
  const signature = crypto.sign('sha256', tbs, privateKey);
  const cert = seq(tbs, alg, der(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const b64 = cert.toString('base64').replace(/.{64}/g, '$&\n');
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

// --- The scanner -----------------------------------------------------------

const NS = 'xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm"';

function firstLanAddress() {
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  return '127.0.0.1';
}

export async function startFakeEscl(options = {}) {
  const cfg = {
    name: 'Paperwing Test Scanner',
    uuid: crypto.randomUUID(),
    makeAndModel: 'Paperwing Test Scanner 3000',
    platen: true,
    adf: false,
    resolutions: [75, 150, 300, 600],
    colorModes: ['RGB24', 'Grayscale8', 'BlackAndWhite1'],
    formats: ['image/jpeg', 'image/png', 'application/pdf'],
    brightness: true,
    threshold: true,
    sharpen: false,
    blankPage: false,
    justification: 'Center',
    host: '0.0.0.0',
    port: 0,
    ...options,
    quirks: { ...options.quirks },
    errors: { ...options.errors },
  };
  // Letter width, A4 length: what most flatbeds and feeders take
  const maxWidth = 2550;
  const maxHeight = 3508;
  const state = {
    sheets: cfg.adf ? cfg.adf.sheets ?? 3 : 0,
    fed: 0,
    busy: cfg.errors.busy ?? 0,
    flaky: {},
    adfState: null,
    jobs: new Map(),
    requests: [],
  };

  const caps = () => {
    const res = Array.isArray(cfg.resolutions)
      ? `<scan:DiscreteResolutions>${cfg.resolutions
          .map(
            (d) =>
              `<scan:DiscreteResolution><scan:XResolution>${d}</scan:XResolution><scan:YResolution>${d}</scan:YResolution></scan:DiscreteResolution>`
          )
          .join('')}</scan:DiscreteResolutions>`
      : `<scan:ResolutionRange><scan:XResolutionRange><scan:Min>${cfg.resolutions.min}</scan:Min><scan:Max>${cfg.resolutions.max}</scan:Max><scan:Normal>300</scan:Normal><scan:Step>${cfg.resolutions.step}</scan:Step></scan:XResolutionRange><scan:YResolutionRange><scan:Min>${cfg.resolutions.min}</scan:Min><scan:Max>${cfg.resolutions.max}</scan:Max><scan:Normal>300</scan:Normal><scan:Step>${cfg.resolutions.step}</scan:Step></scan:YResolutionRange></scan:ResolutionRange>`;
    const input = (tag) => `<scan:${tag}>
      <scan:MinWidth>16</scan:MinWidth><scan:MaxWidth>${maxWidth}</scan:MaxWidth>
      <scan:MinHeight>16</scan:MinHeight><scan:MaxHeight>${maxHeight}</scan:MaxHeight>
      <scan:MaxScanRegions>1</scan:MaxScanRegions>
      <scan:SettingProfiles><scan:SettingProfile>
        <scan:ColorModes>${cfg.colorModes.map((m) => `<scan:ColorMode>${m}</scan:ColorMode>`).join('')}</scan:ColorModes>
        <scan:DocumentFormats>${cfg.formats.map((f) => `<pwg:DocumentFormat>${f}</pwg:DocumentFormat><scan:DocumentFormatExt>${f}</scan:DocumentFormatExt>`).join('')}</scan:DocumentFormats>
        <scan:SupportedResolutions>${res}</scan:SupportedResolutions>
      </scan:SettingProfile></scan:SettingProfiles>
      <scan:SupportedIntents><scan:Intent>Document</scan:Intent><scan:Intent>Photo</scan:Intent><scan:Intent>Preview</scan:Intent></scan:SupportedIntents>
      <scan:MaxOpticalXResolution>600</scan:MaxOpticalXResolution>
    </scan:${tag}>`;
    const range = (tag, min, max, normal) =>
      `<scan:${tag}><scan:Min>${min}</scan:Min><scan:Max>${max}</scan:Max><scan:Normal>${normal}</scan:Normal><scan:Step>1</scan:Step></scan:${tag}>`;
    return `<?xml version="1.0" encoding="UTF-8"?>
<scan:ScannerCapabilities ${NS}>
  <pwg:Version>2.63</pwg:Version>
  <pwg:MakeAndModel>${cfg.makeAndModel}</pwg:MakeAndModel>
  <pwg:SerialNumber>PW0001</pwg:SerialNumber>
  <scan:UUID>${cfg.uuid}</scan:UUID>
  <!-- a comment, as some scanners have -->
  ${cfg.platen ? `<scan:Platen>${input('PlatenInputCaps')}</scan:Platen>` : ''}
  ${
    cfg.adf
      ? `<scan:Adf>${input('AdfSimplexInputCaps')}${cfg.adf.duplex ? input('AdfDuplexInputCaps') : ''}
    <scan:FeederCapacity>50</scan:FeederCapacity>
    <scan:AdfOptions><scan:AdfOption>DetectPaperLoaded</scan:AdfOption>${cfg.adf.duplex ? '<scan:AdfOption>Duplex</scan:AdfOption>' : ''}</scan:AdfOptions>
    <scan:Justification><pwg:XImagePosition>${cfg.justification}</pwg:XImagePosition><pwg:YImagePosition>Top</pwg:YImagePosition></scan:Justification>
  </scan:Adf>`
      : ''
  }
  ${cfg.brightness ? range('BrightnessSupport', 0, 2000, 1000) + range('ContrastSupport', 0, 2000, 1000) : ''}
  ${cfg.threshold ? range('ThresholdSupport', 0, 255, 128) : ''}
  ${cfg.sharpen ? range('SharpenSupport', 0, 5, 0) : ''}
  ${cfg.blankPage ? '<scan:BlankPageDetection>true</scan:BlankPageDetection><scan:BlankPageDetectionAndRemoval>true</scan:BlankPageDetectionAndRemoval>' : ''}
</scan:ScannerCapabilities>`;
  };

  const adfState = () => {
    if (!cfg.adf) return '';
    if (state.adfState) return state.adfState;
    if (cfg.errors.coverOpen) return 'ScannerAdfDoorOpen';
    return state.sheets > 0 ? 'ScannerAdfLoaded' : 'ScannerAdfEmpty';
  };

  const status = () => {
    const processing = state.busy > 0 || [...state.jobs.values()].some((j) => j.state === 'Processing');
    const jobs = [...state.jobs.values()]
      .map(
        (j) =>
          `<scan:JobInfo><pwg:JobUri>/eSCL/ScanJobs/${j.id}</pwg:JobUri><pwg:JobUuid>${j.id}</pwg:JobUuid><scan:Age>1</scan:Age><pwg:ImagesCompleted>${j.sent}</pwg:ImagesCompleted><pwg:JobState>${j.state}</pwg:JobState></scan:JobInfo>`
      )
      .join('');
    const adf = adfState();
    return `<?xml version="1.0" encoding="UTF-8"?>
<scan:ScannerStatus ${NS}><pwg:Version>2.63</pwg:Version><pwg:State>${processing ? 'Processing' : 'Idle'}</pwg:State>${adf ? `<scan:AdfState>${adf}</scan:AdfState>` : ''}<scan:Jobs>${jobs}</scan:Jobs></scan:ScannerStatus>`;
  };

  /** Settings from a ScanSettings document (plain text matching, so the
   *  fake doesn't share the parser it's testing) */
  const setting = (xml, name) => xml.match(new RegExp(`<(?:\\w+:)?${name}>([^<]*)</(?:\\w+:)?${name}>`))?.[1];

  function makeImage(job, n, side) {
    const s = job.settings;
    const dpi = s.dpi;
    const w = Math.max(8, Math.round(((s.width ?? maxWidth) / 300) * dpi));
    const h = Math.max(8, Math.round(((s.height ?? maxHeight) / 300) * dpi));
    const color = s.mode === 'RGB24' ? 'color' : s.mode === 'Grayscale8' ? 'gray' : 'bw';
    const page = drawPage(w, h, { n, color, side });
    if (s.format === 'image/png') return encodePng(page, { bits: color === 'bw' ? 1 : 8, dpi });
    return encodeJpeg(page, { dpi });
  }

  const xmlReply = (res, body, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'text/xml' });
    res.end(body);
  };
  const reply = (res, code, extra = {}) => {
    res.writeHead(code, extra);
    res.end();
  };

  async function handle(req, res, body) {
    const url = new URL(req.url, 'http://scanner');
    const route = url.pathname.replace(/\/+$/, '');
    state.requests.push({ method: req.method, path: route, host: req.headers.host });
    const hangs = (what) => cfg.errors.hang === what;
    const flaky = (kind) => {
      state.flaky[kind] = (state.flaky[kind] ?? 0) + 1;
      return state.flaky[kind] <= (cfg.errors.flaky ?? 0);
    };
    if (cfg.serverHeader) res.setHeader('Server', cfg.serverHeader);

    if (req.method === 'GET' && route === '/eSCL/ScannerCapabilities') {
      if (hangs('caps')) return;
      if (flaky('caps')) return reply(res, 503);
      return xmlReply(res, caps());
    }
    if (req.method === 'GET' && route === '/eSCL/ScannerStatus') {
      if (hangs('status')) return;
      if (flaky('status')) return reply(res, 503);
      return xmlReply(res, status());
    }
    if (req.method === 'POST' && route === '/eSCL/ScanJobs') {
      if (flaky('post')) return reply(res, 503);
      if (cfg.quirks.hpCompact && !/^localhost(:\d+)?$/.test(req.headers.host ?? '')) return reply(res, 400);
      if (state.busy > 0) {
        state.busy--;
        return reply(res, 503);
      }
      const xml = body.toString('utf8');
      const source = setting(xml, 'InputSource');
      const mode = setting(xml, 'ColorMode');
      const dpi = Number(setting(xml, 'XResolution'));
      const format = setting(xml, 'DocumentFormat');
      const okDpi = Array.isArray(cfg.resolutions)
        ? cfg.resolutions.includes(dpi)
        : dpi >= cfg.resolutions.min && dpi <= cfg.resolutions.max && (dpi - cfg.resolutions.min) % cfg.resolutions.step === 0;
      const duplex = setting(xml, 'Duplex') === 'true';
      if (
        !okDpi ||
        !cfg.colorModes.includes(mode) ||
        !cfg.formats.includes(format) ||
        (source === 'Platen' && !cfg.platen) ||
        (source === 'Feeder' && !cfg.adf) ||
        (duplex && !cfg.adf?.duplex)
      )
        return reply(res, 409);
      if (source === 'Feeder' && (state.sheets === 0 || cfg.errors.coverOpen)) return reply(res, 409);
      const id = crypto.randomUUID();
      const width = Number(setting(xml, 'Width')) || undefined;
      const height = Number(setting(xml, 'Height')) || undefined;
      state.jobs.set(id, {
        id,
        state: 'Processing',
        sent: 0,
        late: cfg.errors.lateFirstPage ?? 0,
        queue: [],
        xml,
        settings: { source, mode, dpi, format, duplex, width, height, intent: setting(xml, 'Intent') },
      });
      // An absolute address with the wrong host, as many scanners send
      return reply(res, 201, { Location: `http://localhost:1/eSCL/ScanJobs/${id}` });
    }
    const m = route.match(/^\/eSCL\/ScanJobs\/([\w-]+)(\/NextDocument|\/ScanImageInfo)?$/);
    const job = m && state.jobs.get(m[1]);
    if (m && !job) return reply(res, 404);
    if (job && req.method === 'DELETE' && !m[2]) {
      if (job.state === 'Processing') job.state = 'Canceled';
      job.deleted = true;
      return reply(res, 200);
    }
    if (job && req.method === 'GET' && m[2] === '/NextDocument') {
      if (hangs('page')) return;
      if (flaky('page')) return reply(res, 503);
      if (job.state !== 'Processing') return reply(res, job.state === 'Aborted' ? 500 : 404);
      if (job.late > 0) {
        job.late--;
        return reply(res, 404);
      }
      if (cfg.errors.slowPageMs) await new Promise((r) => setTimeout(r, cfg.errors.slowPageMs));
      if (job.state !== 'Processing') return reply(res, 404);
      const s = job.settings;
      if (s.source === 'Platen') {
        if (job.sent) {
          job.state = 'Completed';
          return reply(res, 404);
        }
      } else if (!job.queue.length) {
        if (state.sheets === 0) {
          job.state = 'Completed';
          return reply(res, 404);
        }
        if (cfg.errors.jamAfter !== undefined && state.fed >= cfg.errors.jamAfter) {
          job.state = 'Aborted';
          state.adfState = 'ScannerAdfJam';
          return reply(res, 500);
        }
        if (cfg.errors.multipickAfter !== undefined && state.fed >= cfg.errors.multipickAfter) {
          job.state = 'Aborted';
          state.adfState = 'ScannerAdfMultipickDetected';
          return reply(res, 500);
        }
        state.sheets--;
        state.fed++;
        job.queue.push('front');
        if (s.duplex) job.queue.push('back');
      }
      const side = s.source === 'Platen' ? 'front' : job.queue.shift();
      job.sent++;
      const image = makeImage(job, job.sent, side);
      res.writeHead(200, { 'Content-Type': s.format, 'Content-Length': image.length });
      return res.end(image);
    }
    if (job && req.method === 'GET' && m[2] === '/ScanImageInfo')
      return xmlReply(
        res,
        `<?xml version="1.0" encoding="UTF-8"?><scan:ScanImageInfo ${NS}><pwg:JobUri>/eSCL/ScanJobs/${job.id}</pwg:JobUri><pwg:JobUuid>${job.id}</pwg:JobUuid></scan:ScanImageInfo>`
      );
    return reply(res, 404);
  }

  const onRequest = (req, res) => {
    if (cfg.log) console.log(req.method, req.url, 'Host:', req.headers.host, req.headers['user-agent'] ?? '');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () =>
      handle(req, res, Buffer.concat(chunks)).catch(() => {
        if (!res.headersSent) reply(res, 500);
      })
    );
  };
  const tls = cfg.https ? selfSignedCertificate(cfg.name) : null;
  const server = tls ? https.createServer(tls, onRequest) : http.createServer(onRequest);
  const sockets = new Set();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, resolve);
  });
  const port = server.address().port;
  const scheme = tls ? 'https' : 'http';
  let closing = null;

  // Announcing itself on multicast DNS
  let responder = null;
  let mdnsPort = null;
  if (cfg.mdns) {
    const loopback = cfg.mdns.port === 0;
    const address = cfg.mdns.address ?? (loopback ? '127.0.0.1' : firstLanAddress());
    const type = `${tls ? '_uscans' : '_uscan'}._tcp.local`;
    const instance = `${cfg.name}.${type}`;
    const hostName = `paperwing-test-${cfg.uuid.slice(0, 8)}.local`;
    const records = {
      ptr: { name: type, type: TYPE.PTR, ttl: 4500, data: instance },
      srv: { name: instance, type: TYPE.SRV, ttl: 120, flush: true, data: { port, target: hostName } },
      txt: {
        name: instance,
        type: TYPE.TXT,
        ttl: 4500,
        flush: true,
        data: {
          txtvers: 1,
          vers: '2.63',
          rs: 'eSCL',
          ty: cfg.name,
          UUID: cfg.uuid,
          representation: `${scheme}://${hostName}:${port}/icon.png`,
          pdl: cfg.formats.join(','),
          cs: 'color,grayscale,binary',
          is: [cfg.platen && 'platen', cfg.adf && 'adf'].filter(Boolean).join(','),
          duplex: cfg.adf?.duplex ? 'T' : 'F',
        },
      },
      a: { name: hostName, type: TYPE.A, ttl: 120, flush: true, data: address },
    };
    responder = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    responder.on('error', () => {});
    responder.on('message', (msg, rinfo) => {
      let packet;
      try {
        packet = decodePacket(msg);
      } catch {
        return;
      }
      if (packet.response) return;
      const answers = [];
      for (const q of packet.questions) {
        const name = q.name.toLowerCase();
        const any = q.type === TYPE.ANY;
        if (name === type.toLowerCase() && (any || q.type === TYPE.PTR)) answers.push(records.ptr);
        if (name === instance.toLowerCase() && (any || q.type === TYPE.SRV)) answers.push(records.srv);
        if (name === instance.toLowerCase() && (any || q.type === TYPE.TXT)) answers.push(records.txt);
        if (name === hostName.toLowerCase() && (any || q.type === TYPE.A)) answers.push(records.a);
      }
      if (!answers.length) return;
      const additionals = [records.srv, records.txt, records.a].filter((r) => !answers.includes(r));
      // Answers to a query from another port go straight back to it, with
      // its id and question (RFC 6762 section 6.7)
      const legacy = rinfo.port !== MDNS_PORT;
      const out = encodePacket({
        id: legacy ? packet.id : 0,
        response: true,
        questions: legacy ? packet.questions.map((q) => ({ name: q.name, type: q.type })) : [],
        answers: answers.map((r) => (legacy ? { ...r, ttl: Math.min(r.ttl, 10), flush: false } : r)),
        additionals: additionals.map((r) => (legacy ? { ...r, ttl: Math.min(r.ttl, 10), flush: false } : r)),
      });
      const unicast = legacy || packet.questions.some((q) => q.unicast);
      if (unicast) responder.send(out, rinfo.port, rinfo.address);
      else responder.send(out, MDNS_PORT, MDNS_ADDRESS);
    });
    await new Promise((resolve, reject) => {
      responder.once('error', reject);
      responder.bind(loopback ? 0 : MDNS_PORT, loopback ? '127.0.0.1' : undefined, () => {
        responder.removeListener('error', reject);
        resolve();
      });
    });
    if (!loopback) {
      responder.setMulticastLoopback(true);
      for (const list of Object.values(os.networkInterfaces()))
        for (const a of list ?? [])
          if (a.family === 'IPv4' && !a.internal)
            try {
              responder.addMembership(MDNS_ADDRESS, a.address);
            } catch {
              /* an adapter without multicast */
            }
    }
    mdnsPort = responder.address().port;
  }

  return {
    url: `${scheme}://127.0.0.1:${port}/eSCL`,
    host: '127.0.0.1',
    port,
    scheme,
    uuid: cfg.uuid,
    name: cfg.name,
    mdnsPort,
    /** Every request, oldest first: { method, path, host } */
    requests: state.requests,
    jobs: state.jobs,
    /** Puts sheets in the feeder (and clears a jam) */
    load(sheets) {
      state.sheets = sheets;
      state.adfState = null;
    },
    get sheets() {
      return state.sheets;
    },
    /** Switches it off (again is fine) */
    close() {
      closing ??= new Promise((resolve) => {
        responder?.close();
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      });
      return closing;
    },
  };
}

// From a shell: node desktop/tests/fake-escl.mjs [--port N] [--https] [--adf N]
// [--duplex] [--name X] [--uuid U] [--mdns] [--slow <ms per page>] [--log (requests)]
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const value = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const sheets = value('--adf');
  const scanner = await startFakeEscl({
    port: Number(value('--port') ?? 0),
    https: args.includes('--https'),
    name: value('--name') ?? 'Paperwing Test Scanner',
    ...(value('--uuid') ? { uuid: value('--uuid') } : {}),
    adf: sheets !== undefined ? { sheets: Number(sheets), duplex: args.includes('--duplex') } : false,
    mdns: args.includes('--mdns') ? { port: MDNS_PORT } : false,
    errors: value('--slow') ? { slowPageMs: Number(value('--slow')) } : {},
    log: args.includes('--log'),
  });
  console.log(JSON.stringify({ url: scanner.url, port: scanner.port, uuid: scanner.uuid, name: scanner.name }));
  const stop = () => scanner.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
