/**
 * The stand-in scanners (development builds, PAPERWING_SCAN_TEST=1): they
 * speak the scanner contract like the real helpers, so the benches can run
 * every part of scanning without a scanner. Not shipped (see
 * electron-builder.yml); scan.cjs only loads it in test mode.
 *
 * - Paperwing Test Scanner: a flatbed (8.5 × 14 in glass showing a test
 *   chart, see GLASS) and a two-sided feeder. Reached through TWAIN, WIA and
 *   the network on Windows (Image Capture and the network on a Mac), so it
 *   shows how one scanner with several drivers is listed.
 * - Paperwing Test Feeder: a one-sided feeder, gray and black and white
 *   only, a resolution range, nothing else (32-bit TWAIN and WIA 1.0).
 * - Paperwing Network Scanner: network only, a basic flatbed.
 *
 * They behave like real scanners: the area, paper size, resolution, color
 * mode, brightness, contrast, threshold and invert asked for are what comes
 * back, cut from the chart and converted (so the benches can check where
 * every part of a scan came from).
 *
 * PAPERWING_SCAN_TEST_PAGES   sheets in a feeder (3)
 * PAPERWING_SCAN_TEST_BLANK   pages of a pass that come out blank ("4" when
 *                             scanning both sides, else none; "none")
 * PAPERWING_SCAN_TEST_SKEW    pages fed crooked, 3° ("2"; "none")
 * PAPERWING_SCAN_TEST_UPSIDE_DOWN  pages fed upside down ("2"; none)
 * PAPERWING_SCAN_TEST_STACK   "turn": a one-sided feeder pass after one
 *                             that scanned fronts gets the same stack turned
 *                             over (its backs, last sheet first), as when
 *                             someone selects Scan reverse sides; otherwise
 *                             each pass is a new stack (sheets numbered on)
 * PAPERWING_SCAN_TEST_TOP_BOUND  backs come upside down (bound at the top)
 * PAPERWING_SCAN_TEST_MAX_DPI the highest resolution really scanned (300;
 *                             above it, pages come at this and say so)
 * PAPERWING_SCAN_TEST_IGNORE_OFFSET  the flatbed scans an area's size from
 *                             the glass's corner, ignoring where it starts
 *                             (like the TWAIN Working Group's sample driver)
 * PAPERWING_SCAN_TEST_IGNORE_AREA  the flatbed always scans the whole glass
 * PAPERWING_SCAN_TEST_GLASS_SKEW  the chart's paper turned this many degrees
 * PAPERWING_SCAN_TEST_EDGE_SHADOW  feeder pages come with a dark band along
 *                             their top and left edges (a lid's shadow)
 * PAPERWING_SCAN_TEST_LOG     a file each scan and preview is noted in (one
 *                             JSON line: the driver and what it was asked)
 * PAPERWING_SCAN_TEST_SLOW    a scanner (its name) that takes 30 s to get ready,
 *                             like a slow or stuck driver
 * PAPERWING_SCAN_TEST_ERROR   an error code, failing at the start, or after
 *                             n pages with code@n (double-feed@2);
 *                             no-scanner and blocked fail the listing
 * PAPERWING_SCAN_TEST_GLASS   a PNG of a page to lay on the glass instead of
 *                             the chart, 6 in wide at the chart paper's corner
 *                             (the README's screenshots; see GLASS_PICTURE)
 * PAPERWING_SCAN_TEST_NAME    another name for Paperwing Test Scanner
 *                             (the README's screenshots)
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

/* Feeder pages ----------------------------------------------------------- */

/**
 * A page's label as cells a bench can read without OCR: 8 cells 0.3 in
 * square, 0.45 in apart, from (0.75, 9.8) in on the paper. Cell 0 is always
 * black (where the code starts); cells 1-6 are the sheet number in binary
 * (most significant first); cell 7 is black on a back side.
 */
const CODE = { x: 0.75, y: 9.8, cell: 0.3, pitch: 0.45, cells: 8 };
function codeBits(sheet, side) {
  const bits = [1];
  for (let b = 5; b >= 0; b--) bits.push((sheet >> b) & 1);
  bits.push(side === 'back' ? 1 : 0);
  return bits;
}

/**
 * Page `n` of a pass: (u, v) in inches on the paper -> [r, g, b]. Odd pages
 * have a blue band (Autodetect keeps them in color); even pages are black
 * and grey only. Each says PAGE n and SHEET s FRONT/BACK, and carries its
 * sheet and side as cells (CODE) at its foot.
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
  const bits = codeBits(sheet, side);
  return (u, v) => {
    if (v >= 0.45 && v < 0.8 && u >= 0.75 && u < width - 0.75) return band;
    // n small squares at the foot of the page
    if (v >= 6.3 && v < 6.6) {
      const k = Math.floor((u - 0.75) / 0.5);
      if (k >= 0 && k < n && (u - 0.75) % 0.5 < 0.3) return [20, 20, 20];
    }
    if (v >= CODE.y && v < CODE.y + CODE.cell && u >= CODE.x) {
      const k = Math.floor((u - CODE.x) / CODE.pitch);
      if (k < CODE.cells && (u - CODE.x) % CODE.pitch < CODE.cell && bits[k])
        return [15, 15, 15];
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

/** Content turned upside down on a paper w × h */
const upsideDown = (content, w, h) => (u, v) => content(w - u, h - v);

/* The flatbed's glass: a test chart ------------------------------------ */

/**
 * The flatbed's glass is a fixed chart, so a bench can tell exactly which
 * part of the glass a scan shows, and in what colors: a sheet of paper
 * (DOC_ON_GLASS) on the lid's plain light grey (so Preview can find it),
 * with a title, a faint inch grid numbered in glass inches, colored squares
 * at known places (MARKERS: glass inches of their top-left corners,
 * MARKER_SIZE square), a grey step wedge (WEDGE), a printed photo's dot
 * screen (HALFTONE), dust (DUST) and lines of text.
 */
const GLASS = { width: 8.5, height: 14 };
const DOC_ON_GLASS = { x: 1, y: 1.2, width: 6, height: 12, angle: 0 };
const LID = [214, 214, 212];
const PAPER = [252, 251, 248];
const MARKER_SIZE = 0.4;
const MARKERS = [
  { name: 'red', x: 6.45, y: 1.35, rgb: [230, 30, 30] },
  { name: 'orange', x: 1.5, y: 2.2, rgb: [245, 140, 20] },
  { name: 'cyan', x: 6.1, y: 2.2, rgb: [20, 190, 210] },
  { name: 'yellow', x: 1.5, y: 8.4, rgb: [235, 215, 20] },
  { name: 'purple', x: 6.1, y: 8.4, rgb: [110, 40, 170] },
  { name: 'teal', x: 3.8, y: 5.2, rgb: [0, 125, 115] },
  // below Letter's 11 in (A4: 11.69), and below that (Legal: 14)
  { name: 'brown', x: 4.05, y: 10.2, rgb: [140, 80, 30] },
  { name: 'magenta', x: 3.8, y: 11.25, rgb: [210, 40, 200] },
  { name: 'pink', x: 4.05, y: 12.2, rgb: [250, 120, 170] },
  { name: 'green', x: 1.3, y: 12.6, rgb: [30, 170, 60] },
  { name: 'blue', x: 6.3, y: 12.6, rgb: [30, 60, 220] },
];
/** A printed photo's dot screen (for Descreen): dots 0.05 in apart */
const HALFTONE = {
  x: 4.6,
  y: 6.0,
  width: 2,
  height: 1,
  pitch: 0.05,
  radius: 0.016,
};
/** Dust (for Despeckle): 40 specks 0.15-0.25 mm across, and 6 dots the
 *  size of a full stop (0.4 mm), which must stay */
const DUST = { x: 1.5, y: 6.0, width: 2.5, height: 1 };
const SPECKS = Array.from({ length: 46 }, (_, k) => ({
  x: DUST.x + 0.1 + ((k * 0.6180339) % 1) * (DUST.width - 0.2),
  y: DUST.y + 0.1 + ((k * 0.4142135) % 1) * (DUST.height - 0.2),
  r: k < 40 ? 0.003 + (k % 3) * 0.001 : 0.008,
}));
/** Ten grey steps, white to black, 0.5 in wide, on the paper */
const WEDGE = { x: 1.5, y: 7.4, step: 0.5, height: 0.5, steps: 10 };
const wedgeLevel = (k) => Math.round(255 * (1 - k / (WEDGE.steps - 1)));

const CHART_TEXT = [
  textLine('PAPERWING TEST CHART', 1.5, 1.45, 0.04),
  ...[
    'THE QUICK BROWN FOX',
    'JUMPS OVER THE LAZY DOG',
    'SCANNED WITHOUT A SCANNER',
  ].map((t, k) => textLine(t, 1.5, 3.2 + k * 0.45, 0.035)),
];
/** The grid's numbers (glass inches), along the paper's top and left */
const GRID_TEXT = [
  ...[2, 3, 4, 5, 6].map((k) => textLine(String(k), k + 0.03, 1.25, 0.015)),
  ...[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map((k) =>
    textLine(String(k), 1.04, k + 0.03, 0.015)
  ),
];

/**
 * A picture on the glass instead of the chart (PAPERWING_SCAN_TEST_GLASS):
 * a page as an image, laid straight at DOC_ON_GLASS's corner, as wide as its
 * paper, on the lid's grey. Read once (pngjs: development builds only).
 */
let glassPicture = null;
function pictureOnGlass(env) {
  const file = env.PAPERWING_SCAN_TEST_GLASS;
  if (!file) return null;
  if (glassPicture?.file !== file) {
    const { PNG } = require('pngjs');
    const png = PNG.sync.read(require('node:fs').readFileSync(file));
    const width = DOC_ON_GLASS.width;
    glassPicture = {
      file,
      png,
      x: DOC_ON_GLASS.x,
      y: DOC_ON_GLASS.y,
      width,
      height: (width * png.height) / png.width,
      dpi: png.width / width,
    };
  }
  return glassPicture;
}

/** What the glass shows at (u, v) inches with the picture on it: the
 *  picture's pixels under a scan pixel of 1/dpi in, averaged */
function pictureContent(pic, dpi) {
  const { png } = pic;
  const k = Math.max(1, Math.round(pic.dpi / (dpi || pic.dpi)));
  return (u, v) => {
    const x0 = Math.floor((u - pic.x) * pic.dpi - k / 2);
    const y0 = Math.floor((v - pic.y) * pic.dpi - k / 2);
    if (x0 + k <= 0 || y0 + k <= 0 || x0 >= png.width || y0 >= png.height)
      return LID;
    const sum = [0, 0, 0];
    for (let y = y0; y < y0 + k; y++)
      for (let x = x0; x < x0 + k; x++) {
        // (the edge of the paper: the lid around it)
        if (x < 0 || y < 0 || x >= png.width || y >= png.height) {
          sum[0] += LID[0];
          sum[1] += LID[1];
          sum[2] += LID[2];
          continue;
        }
        const o = (y * png.width + x) * 4;
        const a = png.data[o + 3] / 255;
        for (let c = 0; c < 3; c++)
          sum[c] += png.data[o + c] * a + 255 * (1 - a);
      }
    return sum.map((c) => Math.round(c / (k * k)));
  };
}

const glassAngle = (env) =>
  Number(env.PAPERWING_SCAN_TEST_GLASS_SKEW) || DOC_ON_GLASS.angle;

/** What the glass shows at (u, v) inches (scanned at `dpi`) */
function glassContent(env = {}, dpi) {
  const pic = pictureOnGlass(env);
  if (pic) return pictureContent(pic, dpi);
  const d = DOC_ON_GLASS;
  const a = (glassAngle(env) * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const cx = d.width / 2;
  const cy = d.height / 2;
  // A point of the paper, in glass inches as if it lay straight
  const paper = (u, v) => {
    for (const m of MARKERS)
      if (
        u >= m.x &&
        u < m.x + MARKER_SIZE &&
        v >= m.y &&
        v < m.y + MARKER_SIZE
      )
        return m.rgb;
    if (
      v >= WEDGE.y &&
      v < WEDGE.y + WEDGE.height &&
      u >= WEDGE.x &&
      u < WEDGE.x + WEDGE.step * WEDGE.steps
    ) {
      const g = wedgeLevel(Math.floor((u - WEDGE.x) / WEDGE.step));
      return [g, g, g];
    }
    if (onText(CHART_TEXT, u, v)) return [25, 25, 25];
    if (onText(GRID_TEXT, u, v)) return [90, 100, 140];
    const H = HALFTONE;
    if (u >= H.x && u < H.x + H.width && v >= H.y && v < H.y + H.height) {
      const du = ((u - H.x) % H.pitch) - H.pitch / 2;
      const dv = ((v - H.y) % H.pitch) - H.pitch / 2;
      return Math.hypot(du, dv) < H.radius ? [30, 30, 30] : PAPER;
    }
    if (
      u >= DUST.x &&
      u < DUST.x + DUST.width &&
      v >= DUST.y &&
      v < DUST.y + DUST.height
    )
      for (const s of SPECKS)
        if (Math.hypot(u - s.x, v - s.y) < s.r) return [20, 20, 20];
    if (
      Math.abs(u - Math.round(u)) < 0.006 ||
      Math.abs(v - Math.round(v)) < 0.006
    )
      return [205, 215, 235];
    return PAPER;
  };
  return (u, v) => {
    const pu = u - d.x;
    const pv = v - d.y;
    const x = cos * (pu - cx) + sin * (pv - cy) + cx;
    const y = -sin * (pu - cx) + cos * (pv - cy) + cy;
    if (x >= 0 && y >= 0 && x <= d.width && y <= d.height)
      return paper(x + d.x, y + d.y);
    return LID;
  };
}
/** The paper's box on the glass (what auto-size scans) */
function docBounds(env = {}) {
  const pic = pictureOnGlass(env);
  if (pic) return { x: pic.x, y: pic.y, width: pic.width, height: pic.height };
  const d = DOC_ON_GLASS;
  const a = Math.abs((glassAngle(env) * Math.PI) / 180);
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
      const c = content(u, v);
      const r = tone(c[0]);
      const g = tone(c[1]);
      const b = tone(c[2]);
      const o = (y * w + x) * channels;
      if (channels === 3) {
        px[o] = r;
        px[o + 1] = g;
        px[o + 2] = b;
      } else {
        const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        px[o] =
          opts.color === 'bw'
            ? lum > threshold !== !!opts.invert
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
  { name: 'Legal', width: 8.5, height: 14 },
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
        maxWidth: GLASS.width,
        maxHeight: GLASS.height,
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
        paperSizes: PAPERS,
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

/** The region of the glass a flatbed scan covers, as the stand-in's driver
 *  understands the request (the quirks of some real drivers on request) */
function flatbedRegion(opts, env) {
  const glass = { x: 0, y: 0, ...GLASS };
  if (env.PAPERWING_SCAN_TEST_IGNORE_AREA) return glass;
  const clamp = (r) => {
    const x = Math.min(Math.max(0, r.x), GLASS.width - 0.1);
    const y = Math.min(Math.max(0, r.y), GLASS.height - 0.1);
    return {
      x,
      y,
      width: Math.min(r.width, GLASS.width - x),
      height: Math.min(r.height, GLASS.height - y),
    };
  };
  if (opts.area)
    return clamp(
      env.PAPERWING_SCAN_TEST_IGNORE_OFFSET
        ? { x: 0, y: 0, width: opts.area.width, height: opts.area.height }
        : opts.area
    );
  if (opts.paper === 'auto') return docBounds(env);
  if (opts.paper) return clamp({ x: 0, y: 0, ...opts.paper });
  return glass;
}

function createTestBackends({
  platform = process.platform,
  env = process.env,
} = {}) {
  const plat = platform === 'darwin' ? 'darwin' : 'win32';
  const [failCode, failAfterText] = String(
    env.PAPERWING_SCAN_TEST_ERROR ?? ''
  ).split('@');
  const failAfter = Number(failAfterText) || 0;
  const maxDpi = Number(env.PAPERWING_SCAN_TEST_MAX_DPI) || 300;
  const added = [];
  // The feeder's paper: sheets numbered on from pass to pass; with
  // PAPERWING_SCAN_TEST_STACK=turn, the last one-sided pass's stack is
  // turned over for the next one-sided pass
  const feederState = { nextSheet: 1, lastFronts: null };

  const scannersFor = (drivers) =>
    [...SCANNERS, ...added].flatMap((s) =>
      (s.drivers[plat] ?? [])
        .filter((d) => drivers.includes(d))
        .map((d) => ({ s, d }))
    );

  /** The sheets and sides a feeder pass brings, in the order they come */
  function feederPass(duplex) {
    const count = Number(env.PAPERWING_SCAN_TEST_PAGES) || 3;
    if (
      !duplex &&
      env.PAPERWING_SCAN_TEST_STACK === 'turn' &&
      feederState.lastFronts
    ) {
      const sheets = [...feederState.lastFronts].reverse();
      feederState.lastFronts = null;
      return sheets.map((sheet) => ({ sheet, side: 'back' }));
    }
    const sheets = Array.from(
      { length: count },
      (_, k) => feederState.nextSheet + k
    );
    feederState.nextSheet += count;
    feederState.lastFronts = duplex ? null : sheets;
    return sheets.flatMap((sheet) =>
      duplex
        ? [
            { sheet, side: 'front' },
            { sheet, side: 'back' },
          ]
        : [{ sheet, side: 'front' }]
    );
  }

  function backend(drivers) {
    // A scanner's id says the driver it was listed under ("test-1@wia"),
    // as the real helpers' ids do, so a scan through WIA is told apart from
    // one through TWAIN; a bare id is the first driver
    const find = (id) => {
      const [sid, drv] = String(id).split('@');
      return scannersFor(drivers).find(
        ({ s, d }) => s.id === sid && (!drv || d === drv)
      );
    };
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
              id: `${s.id}@${d}`,
              name:
                (s.id === 'test-1' && env.PAPERWING_SCAN_TEST_NAME) || s.name,
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
        if (
          env.PAPERWING_SCAN_TEST_SLOW &&
          env.PAPERWING_SCAN_TEST_SLOW === hit.s.name
        )
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
            onEvent({
              type: 'status',
              message: "Using the scanner's own window",
            });
          const source = hit.s
            .caps(hit.d)
            .sources.find((s) => s.id === opts.source);
          if (env.PAPERWING_SCAN_TEST_LOG)
            await fsp.appendFile(
              env.PAPERWING_SCAN_TEST_LOG,
              JSON.stringify({
                command,
                scanner: hit.s.name,
                driver: hit.d,
                options: opts,
              }) + '\n'
            );
          const dpi = Math.min(opts.dpi, maxDpi);
          if (command === 'preview') {
            const region = flatbedRegion(opts, env);
            const img = render(glassContent(env, dpi), region, dpi, {
              color: opts.color === 'bw' ? 'gray' : opts.color,
            });
            const file = path.join(outDir, 'preview.png');
            await fsp.writeFile(file, img.png);
            onEvent({
              type: 'page',
              file,
              dpi,
              width: img.width,
              height: img.height,
              side: 'front',
            });
            onEvent({ type: 'done', pages: 1 });
            return { exitCode: 0 };
          }
          const feeder = opts.source === 'feeder';
          const failNow = (pages) =>
            failCode &&
            !['no-scanner', 'blocked'].includes(failCode) &&
            pages === failAfter &&
            !(failCode === 'feeder-empty' && !feeder) &&
            !(
              failCode === 'double-feed' &&
              (!feeder || opts.doubleFeedStop === false)
            );
          const duplex = feeder && opts.duplex && !!source?.duplex;
          const pass = feeder
            ? feederPass(duplex)
            : [{ sheet: 1, side: 'front' }];
          const blank = pageSet(
            env.PAPERWING_SCAN_TEST_BLANK,
            new Set(duplex ? [4] : [])
          );
          const skew = pageSet(env.PAPERWING_SCAN_TEST_SKEW, new Set([2]));
          const flipped = pageSet(
            env.PAPERWING_SCAN_TEST_UPSIDE_DOWN,
            new Set()
          );
          let n = 0;
          for (const { sheet, side } of pass) {
            if (failNow(n)) {
              onEvent({
                type: 'error',
                code: failCode,
                message: `Test scanner: ${failCode}`,
              });
              return { exitCode: 1 };
            }
            if (cancelled) {
              onEvent({ type: 'done', pages: n, cancelled: true });
              return { exitCode: 0 };
            }
            n++;
            let region;
            let content;
            if (feeder) {
              // (a feeder's paper is the size asked for; auto: Letter)
              const paper =
                opts.paper && opts.paper !== 'auto'
                  ? opts.paper
                  : opts.area
                    ? { width: opts.area.width, height: opts.area.height }
                    : { width: 8.5, height: 11 };
              region = { x: 0, y: 0, ...paper };
              const isBlank = blank.has(n);
              content = pageContent(n, {
                sheet,
                side,
                blank: isBlank,
                width: paper.width,
              });
              if (side === 'back' && env.PAPERWING_SCAN_TEST_TOP_BOUND)
                content = upsideDown(content, paper.width, paper.height);
              if (flipped.has(n))
                content = upsideDown(content, paper.width, paper.height);
              if (skew.has(n) && !opts.autoDeskew && !isBlank)
                content = skewed(content, 3, paper.width, paper.height);
              if (env.PAPERWING_SCAN_TEST_EDGE_SHADOW) {
                const inner = content;
                content = (u, v) =>
                  u < 0.2 || v < 0.2 ? [55, 55, 55] : inner(u, v);
              }
            } else {
              region = flatbedRegion(opts, env);
              content = glassContent(env, dpi);
            }
            const img = render(content, region, dpi, opts);
            const file = path.join(outDir, `page-${n}.png`);
            await fsp.writeFile(file, img.png);
            onEvent({
              type: 'page',
              file,
              dpi,
              width: img.width,
              height: img.height,
              side,
            });
            await new Promise((r) => setTimeout(r, 150));
          }
          if (failNow(n) && failAfter) {
            onEvent({
              type: 'error',
              code: failCode,
              message: `Test scanner: ${failCode}`,
            });
            return { exitCode: 1 };
          }
          onEvent({
            type: 'done',
            pages: n,
            ...(cancelled ? { cancelled: true } : {}),
          });
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
      return {
        ok: false,
        error: 'offline',
        message: `Nothing answered at ${host}`,
      };
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
      scanner: {
        id,
        name: s.name,
        driver: 'escl',
        deviceKey: s.deviceKey,
        connection: 'network',
      },
    };
  };
  map.escl = net;
  return map;
}

module.exports = {
  createTestBackends,
  encodePng,
  render,
  pageContent,
  glassContent,
  codeBits,
  CODE,
  GLASS,
  DOC_ON_GLASS,
  MARKERS,
  MARKER_SIZE,
  WEDGE,
  wedgeLevel,
  HALFTONE,
  DUST,
  SPECKS,
};
