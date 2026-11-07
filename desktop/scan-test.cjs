/**
 * The stand-in scanners (development builds, PAPERWING_SCAN_TEST=1): they
 * speak the scanner contract like the real helpers, so the benches can run
 * every part of scanning without a scanner. Not shipped (see
 * electron-builder.yml); scan.cjs only loads it in test mode.
 *
 * - Paperwing Test Scanner: a flatbed (with a document lying on the glass,
 *   slightly crooked, for Preview) and a two-sided feeder. Reached through
 *   TWAIN, WIA and the network on Windows (Image Capture and the network on
 *   a Mac), so it shows how one scanner with several drivers is listed.
 * - Paperwing Test Feeder: a one-sided feeder, gray and black and white
 *   only, a resolution range, nothing else (32-bit TWAIN and WIA 1.0).
 * - Paperwing Network Scanner: network only, a basic flatbed.
 *
 * PAPERWING_SCAN_TEST_PAGES   sheets in a feeder (3)
 * PAPERWING_SCAN_TEST_BLANK   pages of a pass that come out blank ("4" when
 *                             scanning both sides, else none; "none")
 * PAPERWING_SCAN_TEST_SKEW    pages fed crooked, 3° ("2"; "none")
 * PAPERWING_SCAN_TEST_SLOW    a scanner (its name) that takes 30 s to get ready,
 *                             like a slow or stuck driver
 * PAPERWING_SCAN_TEST_ERROR   an error code, failing at the start, or after
 *                             n pages with code@n (double-feed@2);
 *                             no-scanner and blocked fail the listing
 */
const path = require('node:path');
const fsp = require('node:fs/promises');
const zlib = require('node:zlib');

/* A small PNG encoder (8-bit gray or RGB) ------------------------------ */

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** pixels: one byte per pixel (gray) or three (RGB), row after row */
function encodePng(pixels, width, height, channels) {
  const rowLen = width * channels;
  const raw = Buffer.alloc((rowLen + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (rowLen + 1)] = 0; // no filter
    pixels.copy(raw, y * (rowLen + 1) + 1, y * rowLen, (y + 1) * rowLen);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 1 ? 0 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 3 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* The pages' text: a 5×7 pixel font, big enough for OCR to read ------- */

// prettier-ignore
const FONT = {
  A: [14,17,17,31,17,17,17], B: [30,17,17,30,17,17,30], C: [14,17,16,16,16,17,14],
  D: [30,17,17,17,17,17,30], E: [31,16,16,30,16,16,31], F: [31,16,16,30,16,16,16],
  G: [14,17,16,23,17,17,15], H: [17,17,17,31,17,17,17], I: [14,4,4,4,4,4,14],
  J: [7,2,2,2,2,18,12], K: [17,18,20,24,20,18,17], L: [16,16,16,16,16,16,31],
  M: [17,27,21,21,17,17,17], N: [17,17,25,21,19,17,17], O: [14,17,17,17,17,17,14],
  P: [30,17,17,30,16,16,16], Q: [14,17,17,17,21,18,13], R: [30,17,17,30,20,18,17],
  S: [15,16,16,14,1,1,30], T: [31,4,4,4,4,4,4], U: [17,17,17,17,17,17,14],
  V: [17,17,17,17,17,10,4], W: [17,17,17,21,21,21,10], X: [17,17,10,4,10,17,17],
  Y: [17,17,17,10,4,4,4], Z: [31,1,2,4,8,16,31],
  0: [14,17,19,21,25,17,14], 1: [4,12,4,4,4,4,14], 2: [14,17,1,2,4,8,31],
  3: [31,2,4,2,1,17,14], 4: [2,6,10,18,31,2,2], 5: [31,16,30,1,1,17,14],
  6: [6,8,16,30,17,17,14], 7: [31,1,2,4,8,8,8], 8: [14,17,17,14,17,17,14],
  9: [14,17,17,15,1,2,12],
};

/** A line of text at (x, y) inches, `dot` inches per font pixel */
const textLine = (text, x, y, dot) => ({ text, x, y, dot });

/** Whether (u, v) inches falls on ink of one of the lines */
function onText(lines, u, v) {
  for (const l of lines) {
    const row = Math.floor((v - l.y) / l.dot);
    if (row < 0 || row > 6) continue;
    const col = Math.floor((u - l.x) / l.dot);
    if (col < 0) continue;
    const ch = l.text[Math.floor(col / 6)];
    const bit = col % 6;
    if (!ch || bit > 4) continue;
    const glyph = FONT[ch];
    if (glyph && glyph[row] & (16 >> bit)) return true;
  }
  return false;
}

/* Pages ---------------------------------------------------------------- */

/**
 * Page `n` of a pass: (u, v) in inches on the paper -> [r, g, b]. Odd pages
 * have a colored band (Autodetect keeps them in color); even pages are
 * black and gray only.
 */
function pageContent(n, { sheet, side, blank, width }) {
  if (blank) {
    // Paper with a few specks: blank to a person, not to a naive check
    const specks = [
      [1.2, 2.3],
      [5.1, 7.4],
      [3.3, 9.1],
      [6.8, 1.6],
    ];
    return (u, v) =>
      specks.some(([x, y]) => Math.hypot(u - x, v - y) < 0.012)
        ? [90, 90, 90]
        : [250, 250, 248];
  }
  const lines = [
    textLine(`PAGE ${n}`, 0.75, 1.15, 0.05),
    textLine(`SHEET ${sheet} ${side.toUpperCase()}`, 0.75, 1.75, 0.03),
    ...[
      'PAPERWING TEST SCAN',
      'THE QUICK BROWN FOX',
      'JUMPS OVER THE LAZY DOG',
      'SCANNED WITHOUT A SCANNER',
      'PAPERWING TEST SCAN',
      'THE QUICK BROWN FOX',
    ].map((t, k) => textLine(t, 0.75, 2.6 + k * 0.5, 0.03)),
  ];
  const band = n % 2 ? [40, 90, 200] : [70, 70, 70];
  return (u, v) => {
    if (v >= 0.45 && v < 0.8 && u >= 0.75 && u < width - 0.75) return band;
    // n small squares at the foot of the page
    if (v >= 6.3 && v < 6.6) {
      const k = Math.floor((u - 0.75) / 0.5);
      if (k >= 0 && k < n && (u - 0.75) % 0.5 < 0.3) return [20, 20, 20];
    }
    return onText(lines, u, v) ? [25, 25, 25] : [252, 251, 248];
  };
}

/** Rotates a paper's content by `deg` about its center; what turns out of
 *  the paper shows the feeder's grey backing */
function skewed(content, deg, w, h) {
  const a = (deg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const cx = w / 2;
  const cy = h / 2;
  return (u, v) => {
    const x = cos * (u - cx) + sin * (v - cy) + cx;
    const y = -sin * (u - cx) + cos * (v - cy) + cy;
    if (x < 0 || y < 0 || x > w || y > h) return [205, 205, 205];
    return content(x, y);
  };
}

/** The flatbed's glass: a 6 × 8 in document lying at (1, 1.2), turned 1.5°,
 *  on the lid's light grey */
const DOC_ON_GLASS = { x: 1, y: 1.2, width: 6, height: 8, angle: 1.5 };
function glassContent(n) {
  const d = DOC_ON_GLASS;
  const page = skewed(
    pageContent(n, { sheet: n, side: 'front', blank: false, width: d.width }),
    d.angle,
    d.width,
    d.height
  );
  const a = (d.angle * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const cx = d.width / 2;
  const cy = d.height / 2;
  return (u, v) => {
    const pu = u - d.x;
    const pv = v - d.y;
    const x = cos * (pu - cx) + sin * (pv - cy) + cx;
    const y = -sin * (pu - cx) + cos * (pv - cy) + cy;
    if (x < 0 || y < 0 || x > d.width || y > d.height) return [214, 214, 212];
    return page(pu, pv);
  };
}
/** The document's box on the glass (what auto-size scans) */
function docBounds() {
  const d = DOC_ON_GLASS;
  const a = (d.angle * Math.PI) / 180;
  const w = d.width * Math.cos(a) + d.height * Math.sin(a);
  const h = d.width * Math.sin(a) + d.height * Math.cos(a);
  return {
    x: d.x + d.width / 2 - w / 2,
    y: d.y + d.height / 2 - h / 2,
    width: w,
    height: h,
  };
}

/**
 * Renders the region (inches) of a content function at `dpi`, the way the
 * scanner would deliver it: brightness and contrast, then the color mode.
 */
function render(content, region, dpi, opts) {
  const w = Math.max(1, Math.round(region.width * dpi));
  const h = Math.max(1, Math.round(region.height * dpi));
  const channels = opts.color === 'color' ? 3 : 1;
  const px = Buffer.alloc(w * h * channels);
  const bright = (opts.brightness ?? 0) * 1.28;
  const gain = 1 + (opts.contrast ?? 0) / 100;
  const threshold = opts.threshold ?? 128;
  const tone = (c) =>
    Math.max(0, Math.min(255, Math.round((c - 128) * gain + 128 + bright)));
  for (let y = 0; y < h; y++) {
    const v = region.y + (y + 0.5) / dpi;
    for (let x = 0; x < w; x++) {
      const u = region.x + (x + 0.5) / dpi;
      const [r, g, b] = content(u, v).map(tone);
      const o = (y * w + x) * channels;
      if (channels === 3) {
        px[o] = r;
        px[o + 1] = g;
        px[o + 2] = b;
      } else {
        const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        px[o] =
          opts.color === 'bw'
            ? (lum > threshold) !== !!opts.invert
              ? 255
              : 0
            : lum;
      }
    }
  }
  return { png: encodePng(px, w, h, channels), width: w, height: h };
}

/* The stand-in scanners ------------------------------------------------ */

const RANGE = (min, max, step, def) => ({ min, max, step, default: def });
const PAPERS = [
  { name: 'Letter', width: 8.5, height: 11 },
  { name: 'A4', width: 8.27, height: 11.69 },
  { name: 'A5', width: 5.83, height: 8.27 },
];

function fullCaps(driver) {
  const native = driver === 'twain' || driver === 'wia' || driver === 'twain32';
  return {
    type: 'caps',
    driver,
    nativeUi: native,
    sources: [
      {
        id: 'flatbed',
        duplex: false,
        resolutions: [75, 100, 150, 200, 300, 600, 1200],
        colors: ['color', 'gray', 'bw'],
        maxWidth: 8.5,
        maxHeight: 11.69,
        minWidth: 0.5,
        minHeight: 0.5,
        canPreview: true,
        paperSizes: PAPERS,
        autoSize: true,
        autoDeskew: false,
        autoCrop: false,
        blankPageSkip: false,
        doubleFeed: false,
        invert: driver !== 'escl',
        brightness: RANGE(-100, 100, 1, 0),
        contrast: RANGE(-100, 100, 1, 0),
        threshold: RANGE(0, 255, 1, 128),
        feederLoaded: null,
      },
      {
        id: 'feeder',
        duplex: true,
        resolutions: [150, 200, 300, 600],
        colors: ['color', 'gray', 'bw'],
        maxWidth: 8.5,
        maxHeight: 14,
        minWidth: 2,
        minHeight: 3,
        canPreview: false,
        paperSizes: [...PAPERS, { name: 'Legal', width: 8.5, height: 14 }],
        autoSize: driver !== 'escl',
        autoDeskew: driver !== 'escl',
        autoCrop: false,
        blankPageSkip: driver !== 'escl',
        doubleFeed: true,
        invert: driver !== 'escl',
        brightness: RANGE(-100, 100, 1, 0),
        contrast: RANGE(-100, 100, 1, 0),
        threshold: RANGE(0, 255, 1, 128),
        feederLoaded: true,
      },
    ],
  };
}

const feederCaps = (driver) => ({
  type: 'caps',
  driver,
  nativeUi: driver === 'twain32',
  sources: [
    {
      id: 'feeder',
      duplex: false,
      resolutions: RANGE(100, 600, 50, 300),
      colors: ['gray', 'bw'],
      maxWidth: 8.5,
      maxHeight: 14,
      canPreview: false,
      paperSizes: [],
      autoSize: false,
      autoDeskew: false,
      autoCrop: false,
      blankPageSkip: false,
      doubleFeed: false,
      invert: false,
      brightness: null,
      contrast: null,
      threshold: null,
      feederLoaded: true,
    },
  ],
});

const networkCaps = () => ({
  type: 'caps',
  driver: 'escl',
  nativeUi: false,
  sources: [
    {
      id: 'flatbed',
      duplex: false,
      resolutions: [100, 200, 300],
      colors: ['color', 'gray'],
      maxWidth: 8.5,
      maxHeight: 11.69,
      canPreview: true,
      paperSizes: [],
      autoSize: false,
      autoDeskew: false,
      autoCrop: false,
      blankPageSkip: false,
      doubleFeed: false,
      invert: false,
      brightness: null,
      contrast: null,
      threshold: null,
      feederLoaded: null,
    },
  ],
});

const SCANNERS = [
  {
    id: 'test-1',
    deviceKey: 'paperwing-test-1',
    name: 'Paperwing Test Scanner',
    make: 'Paperwing',
    model: 'Test Scanner',
    connection: 'usb',
    drivers: { win32: ['twain', 'wia', 'escl'], darwin: ['ica', 'escl'] },
    caps: fullCaps,
  },
  {
    id: 'test-2',
    deviceKey: 'paperwing-test-2',
    name: 'Paperwing Test Feeder',
    make: 'Paperwing',
    model: 'Test Feeder',
    connection: 'usb',
    drivers: { win32: ['twain32', 'wia1'], darwin: ['ica'] },
    caps: feederCaps,
  },
  {
    id: 'test-3',
    deviceKey: 'paperwing-net-3',
    name: 'Paperwing Network Scanner',
    make: 'Paperwing',
    model: 'Network Scanner',
    connection: 'network',
    drivers: { win32: ['escl'], darwin: ['escl'] },
    caps: networkCaps,
  },
];

/** "4,5" -> Set{4, 5}; undefined -> the fallback */
const pageSet = (text, fallback) =>
  text === undefined
    ? fallback
    : new Set(
        String(text)
          .split(',')
          .map(Number)
          .filter((n) => Number.isInteger(n) && n > 0)
      );

function createTestBackends({ platform = process.platform, env = process.env } = {}) {
  const plat = platform === 'darwin' ? 'darwin' : 'win32';
  const [failCode, failAfterText] = String(env.PAPERWING_SCAN_TEST_ERROR ?? '').split('@');
  const failAfter = Number(failAfterText) || 0;
  const added = [];

  const scannersFor = (drivers) =>
    [...SCANNERS, ...added].flatMap((s) =>
      (s.drivers[plat] ?? []).filter((d) => drivers.includes(d)).map((d) => ({ s, d }))
    );

  function backend(drivers) {
    const find = (id) => scannersFor(drivers).find(({ s }) => s.id === id);
    return {
      async list() {
        if (failCode === 'blocked')
          return {
            ok: false,
            error: 'blocked',
            message: 'Test scanner: blocked by policy',
          };
        if (failCode === 'no-scanner') return { ok: true, found: [] };
        return {
          ok: true,
          found: scannersFor(drivers).map(({ s, d }) => ({
            driver: d,
            scanner: {
              id: s.id,
              name: s.name,
              driver: d.replace(/32$|1$/, ''),
              deviceKey: s.deviceKey,
              make: s.make,
              model: s.model,
              connection: d === 'escl' ? 'network' : s.connection,
            },
          })),
        };
      },
      async caps(id) {
        const hit = find(id);
        if (!hit) return { ok: false, error: 'no-scanner' };
        if (env.PAPERWING_SCAN_TEST_SLOW && env.PAPERWING_SCAN_TEST_SLOW === hit.s.name)
          await new Promise((r) => setTimeout(r, 30000));
        return { ok: true, msg: hit.s.caps(hit.d) };
      },
      start(command, id, outDir, opts, onEvent) {
        const hit = find(id);
        let cancelled = false;
        const done = (async () => {
          if (!hit) {
            onEvent({ type: 'error', code: 'no-scanner', message: 'Gone' });
            return { exitCode: 1 };
          }
          await new Promise((r) => setTimeout(r, 120));
          if (opts.nativeUi)
            onEvent({ type: 'status', message: "Using the scanner's own window" });
          const glass = { x: 0, y: 0, width: 8.5, height: 11.69 };
          if (command === 'preview') {
            const img = render(glassContent(1), glass, Math.min(opts.dpi, 75), {
              color: opts.color === 'bw' ? 'gray' : opts.color,
            });
            const file = path.join(outDir, 'preview.png');
            await fsp.writeFile(file, img.png);
            onEvent({ type: 'page', file, dpi: Math.min(opts.dpi, 75), width: img.width, height: img.height, side: 'front' });
            onEvent({ type: 'done', pages: 1 });
            return { exitCode: 0 };
          }
          const feeder = opts.source === 'feeder';
          const failNow = (pages) =>
            failCode &&
            !['no-scanner', 'blocked'].includes(failCode) &&
            pages === failAfter &&
            !(failCode === 'feeder-empty' && !feeder) &&
            !(failCode === 'double-feed' && (!feeder || opts.doubleFeedStop === false));
          const sheets = feeder ? Number(env.PAPERWING_SCAN_TEST_PAGES) || 3 : 1;
          const sides = feeder && opts.duplex ? 2 : 1;
          const blank = pageSet(env.PAPERWING_SCAN_TEST_BLANK, new Set(sides === 2 ? [4] : []));
          const skew = pageSet(env.PAPERWING_SCAN_TEST_SKEW, new Set([2]));
          // Up to 100 dpi, so the pages stay small (their real size goes with them)
          const dpi = Math.min(opts.dpi, 100);
          let n = 0;
          for (let sheet = 1; sheet <= sheets; sheet++) {
            for (let k = 0; k < sides; k++) {
              if (failNow(n)) {
                onEvent({ type: 'error', code: failCode, message: `Test scanner: ${failCode}` });
                return { exitCode: 1 };
              }
              if (cancelled) {
                onEvent({ type: 'done', pages: n, cancelled: true });
                return { exitCode: 0 };
              }
              n++;
              const side = k ? 'back' : 'front';
              let region;
              let content;
              if (feeder) {
                const paper =
                  opts.paper && opts.paper !== 'auto'
                    ? opts.paper
                    : opts.area
                      ? { width: opts.area.width, height: opts.area.height }
                      : { width: 8.5, height: 11 };
                region = { x: 0, y: 0, ...paper };
                content = pageContent(n, { sheet, side, blank: blank.has(n), width: paper.width });
                if (skew.has(n) && !opts.autoDeskew && !blank.has(n))
                  content = skewed(content, 3, paper.width, paper.height);
              } else {
                region = opts.area
                  ? opts.area
                  : opts.paper === 'auto'
                    ? docBounds()
                    : opts.paper
                      ? { x: 0, y: 0, ...opts.paper }
                      : glass;
                content = glassContent(n);
              }
              const img = render(content, region, dpi, opts);
              const file = path.join(outDir, `page-${n}.png`);
              await fsp.writeFile(file, img.png);
              onEvent({ type: 'page', file, dpi, width: img.width, height: img.height, side });
              await new Promise((r) => setTimeout(r, 150));
            }
          }
          if (failNow(n) && failAfter) {
            onEvent({ type: 'error', code: failCode, message: `Test scanner: ${failCode}` });
            return { exitCode: 1 };
          }
          onEvent({ type: 'done', pages: n, ...(cancelled ? { cancelled: true } : {}) });
          return { exitCode: 0 };
        })();
        return {
          cancel: () => (cancelled = true),
          done,
        };
      },
    };
  }

  const map = {};
  if (plat === 'win32') {
    map.twain = map.wia = map.wia1 = backend(['twain', 'wia', 'wia1']);
    map.twain32 = backend(['twain32']);
  } else {
    map.ica = backend(['ica']);
  }
  const net = backend(['escl']);
  // Add by IP address: the documentation addresses (192.0.2.x) answer
  net.add = async (host) => {
    if (!/^192\.0\.2\.\d{1,3}(:\d+)?$/.test(host))
      return { ok: false, error: 'offline', message: `Nothing answered at ${host}` };
    const id = `added-${host}`;
    if (!added.some((s) => s.id === id))
      added.push({
        id,
        deviceKey: `paperwing-added-${host}`,
        name: `Network scanner at ${host}`,
        make: 'Paperwing',
        model: 'Added Scanner',
        connection: 'network',
        drivers: { win32: ['escl'], darwin: ['escl'] },
        caps: networkCaps,
      });
    const s = added.find((x) => x.id === id);
    return {
      ok: true,
      scanner: { id, name: s.name, driver: 'escl', deviceKey: s.deviceKey, connection: 'network' },
    };
  };
  map.escl = net;
  return map;
}

module.exports = { createTestBackends, encodePng, render, pageContent, DOC_ON_GLASS };
