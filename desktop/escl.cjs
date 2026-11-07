/**
 * Driverless network scanners: eSCL, also sold as AirScan and Mopria Scan.
 * Most network scanners and all-in-ones from the last ten years speak it:
 * plain HTTP(S) and XML, no driver needed. It runs here in the main process,
 * the same on Windows and macOS, and answers the same calls, with the same
 * JSON, as the scanner helpers (see the build contracts in scan.cjs):
 *
 *   list({ onDevice })              -> { type: 'scanners', scanners }
 *   caps(id)                        -> { type: 'caps', driver: 'escl', sources }
 *   preview(id, options, outDir, onEvent) / scan(...)
 *                                   -> { cancel(), done: Promise<last event> }
 *     onEvent gets { type: 'page', file, dpi, width, height (pixels), side },
 *     { type: 'status', message }, then { type: 'done', pages[, cancelled] }
 *     or { type: 'error', code, message }.
 *
 * Scanners are found with multicast DNS (mdns.cjs: _uscan._tcp and
 * _uscans._tcp), or added by IP address or host name for networks that don't
 * pass multicast. What it does when a scanner misbehaves follows the
 * experience of sane-airscan, NAPS2 and OpenPrinting (read, not copied):
 * 503 means "busy, ask again" (up to 10 times; 30 while a page is coming),
 * the job's address from the scanner is used only for its path, a missing
 * page early in a job may just be late (Xerox), the scanner's status explains
 * a failed request (jam, empty feeder...), every request has a time limit,
 * and a finished or cancelled job is deleted so the scanner isn't left busy.
 */
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const path = require('node:path');
const fsp = require('node:fs/promises');
const mdns = require('./mdns.cjs');

const SERVICE_TYPES = ['_uscan._tcp.local', '_uscans._tcp.local'];
const NS_SCAN = 'http://schemas.hp.com/imaging/escl/2011/05/03';
const NS_PWG = 'http://www.pwg.org/schemas/2010/12/sm';

const DEFAULTS = {
  /** How long list() listens for scanners to announce themselves */
  discoveryMs: 4000,
  connectMs: 5000,
  /** Without a byte from the scanner (settings, status, starting a job) */
  requestMs: 20000,
  /** Waiting for a page: a slow scanner at 1200 dpi can take minutes */
  pageMs: 180000,
  /** Trying an address someone typed in */
  probeMs: 6000,
  retryDelayMs: 1000,
  maxRetryDelayMs: 3000,
  retries: 10,
  pageRetries: 30,
  /** Scanners found earlier stay listed this long if they miss a search */
  cacheMs: 5 * 60 * 1000,
};

const MESSAGES = {
  'no-scanner': "Paperwing couldn't find this scanner on the network.",
  offline:
    "The scanner isn't answering. Check that it's on and connected to the same network as this computer.",
  busy: 'The scanner is busy. Wait for it to finish, then try again.',
  'paper-jam': 'Paper is jammed in the document feeder.',
  'feeder-empty': 'The document feeder is empty.',
  'double-feed': 'Two sheets went through the feeder together.',
  'cover-open': "The scanner's cover is open.",
  unsupported: "The scanner can't scan with these settings.",
  blocked:
    "Paperwing isn't allowed to look for scanners on the local network. Allow it in your system's privacy or firewall settings.",
  failed: 'The scanner reported a problem.',
};

class ScanError extends Error {
  constructor(code, message) {
    super(message || MESSAGES[code] || MESSAGES.failed);
    this.code = code;
  }
}

const errorEvent = (code, message) => ({
  type: 'error',
  code,
  message: message || MESSAGES[code] || MESSAGES.failed,
});

// --- XML -------------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

/**
 * Just enough XML for eSCL: elements by local name (namespace prefixes
 * dropped, as every eSCL element name is distinct) and their text.
 * Attributes aren't needed. Malformed input gives a partial tree, not a hang.
 */
function parseXml(text) {
  const root = { name: '#document', children: [], text: '' };
  const stack = [root];
  const s = String(text);
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    const top = stack[stack.length - 1];
    if (lt < 0) {
      top.text += decodeEntities(s.slice(i));
      break;
    }
    if (lt > i) top.text += decodeEntities(s.slice(i, lt));
    if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt + 4);
      i = end < 0 ? s.length : end + 3;
      continue;
    }
    if (s.startsWith('<![CDATA[', lt)) {
      const end = s.indexOf(']]>', lt + 9);
      top.text += s.slice(lt + 9, end < 0 ? s.length : end);
      i = end < 0 ? s.length : end + 3;
      continue;
    }
    // The tag's end, skipping '>' inside quoted attribute values
    let gt = lt + 1;
    let quote = '';
    for (; gt < s.length; gt++) {
      const c = s[gt];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    const body = s.slice(lt + 1, gt);
    i = gt + 1;
    if (body[0] === '?' || body[0] === '!') continue;
    const local = (raw) => {
      const name = raw.split(/[\s/]/)[0];
      return name.slice(name.indexOf(':') + 1);
    };
    if (body[0] === '/') {
      const name = local(body.slice(1));
      const at = stack.map((n) => n.name).lastIndexOf(name);
      if (at > 0) stack.length = at;
      continue;
    }
    const node = { name: local(body), children: [], text: '' };
    top.children.push(node);
    if (!body.trimEnd().endsWith('/')) stack.push(node);
  }
  return root;
}

const child = (n, name) => n?.children.find((c) => c.name === name);
const kids = (n, name) => n?.children.filter((c) => c.name === name) ?? [];
const at = (n, ...names) => names.reduce((x, name) => child(x, name), n);
const textOf = (n) => (n ? n.text.trim() : '');
const num = (n) => (n && textOf(n) !== '' ? Number(textOf(n)) : NaN);
function find(n, name) {
  if (!n) return undefined;
  for (const c of n.children) {
    if (c.name === name) return c;
    const deep = find(c, name);
    if (deep) return deep;
  }
  return undefined;
}
function findAll(n, name, out = []) {
  for (const c of n?.children ?? []) {
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}

// --- What a scanner can do -------------------------------------------------

/** { min, max, step, default } from an eSCL Min/Max/Normal/Step element */
function parseRange(n) {
  if (!n) return null;
  const min = num(child(n, 'Min'));
  const max = num(child(n, 'Max'));
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return null;
  const step = num(child(n, 'Step'));
  const normal = num(child(n, 'Normal'));
  return {
    min,
    max,
    step: step > 0 ? step : 1,
    default: Number.isFinite(normal) ? normal : Math.round((min + max) / 2),
  };
}

function parseInputCaps(n) {
  if (!n) return null;
  const profiles = findAll(n, 'SettingProfile').map((p) => {
    const formats = findAll(child(p, 'DocumentFormats'), 'DocumentFormat')
      .map((f) => textOf(f).toLowerCase())
      .concat(
        findAll(child(p, 'DocumentFormats'), 'DocumentFormatExt').map((f) =>
          textOf(f).toLowerCase()
        )
      );
    const resolutions = child(p, 'SupportedResolutions');
    return {
      colorModes: kids(child(p, 'ColorModes'), 'ColorMode').map(textOf),
      formats: [...new Set(formats)],
      formatExt: !!find(child(p, 'DocumentFormats'), 'DocumentFormatExt'),
      discrete: findAll(resolutions, 'DiscreteResolution')
        .map((r) => num(child(r, 'XResolution')))
        .filter((d) => Number.isInteger(d) && d > 0),
      ranges: findAll(resolutions, 'XResolutionRange')
        .map(parseRange)
        .filter(Boolean),
    };
  });
  return {
    // Sizes in 1/300 inch
    minWidth: num(child(n, 'MinWidth')),
    maxWidth: num(child(n, 'MaxWidth')),
    minHeight: num(child(n, 'MinHeight')),
    maxHeight: num(child(n, 'MaxHeight')),
    profiles,
    intents: findAll(child(n, 'SupportedIntents'), 'Intent').map(textOf),
    autoSize: !!find(n, 'EdgeAutoDetection'),
  };
}

/** ScannerCapabilities XML, as a plain object */
function parseCapabilities(xml) {
  const doc = parseXml(xml);
  const root = child(doc, 'ScannerCapabilities');
  if (!root) throw new ScanError('failed', "The scanner's settings couldn't be read.");
  const adf = child(root, 'Adf');
  const isTrue = (name) =>
    findAll(root, name).some((n) => textOf(n).toLowerCase() === 'true');
  return {
    version: textOf(child(root, 'Version')),
    makeAndModel: textOf(child(root, 'MakeAndModel')),
    uuid: normalizeUuid(textOf(child(root, 'UUID'))),
    platen: parseInputCaps(at(root, 'Platen', 'PlatenInputCaps')),
    adfSimplex: parseInputCaps(child(adf, 'AdfSimplexInputCaps')),
    adfDuplex: parseInputCaps(child(adf, 'AdfDuplexInputCaps')),
    // Where narrower paper sits in the feeder's width
    adfJustification: textOf(at(adf, 'Justification', 'XImagePosition')),
    brightness: parseRange(find(root, 'BrightnessSupport')),
    contrast: parseRange(find(root, 'ContrastSupport')),
    threshold: parseRange(find(root, 'ThresholdSupport')),
    sharpen: parseRange(find(root, 'SharpenSupport')),
    blankPageRemoval: isTrue('BlankPageDetectionAndRemoval'),
  };
}

/** ScannerStatus XML: { state, adfState, jobs: [{ uri, uuid, state }] } */
function parseStatus(xml) {
  const root = child(parseXml(xml), 'ScannerStatus');
  if (!root) return null;
  return {
    state: textOf(child(root, 'State')),
    adfState: textOf(child(root, 'AdfState')),
    jobs: findAll(root, 'JobInfo').map((j) => ({
      uri: textOf(child(j, 'JobUri')),
      uuid: textOf(child(j, 'JobUuid')),
      state: textOf(child(j, 'JobState')),
    })),
  };
}

/** What a feeder's state or the scanner's state means, as an error code */
function statusError(status, source) {
  if (!status) return null;
  if (source === 'feeder') {
    const adf = {
      ScannerAdfEmpty: 'feeder-empty',
      // Kyocera reports a feeder with nothing in it as "processing"
      ScannerAdfProcessing: 'feeder-empty',
      ScannerAdfJam: 'paper-jam',
      ScannerAdfMispick: 'paper-jam',
      ScannerAdfDoorOpen: 'cover-open',
      ScannerAdfHatchOpen: 'cover-open',
      ScannerAdfMultipickDetected: 'double-feed',
    }[status.adfState];
    if (adf) return adf;
  }
  if (status.state === 'Down') return 'offline';
  if (status.state === 'Processing' || status.state === 'Testing') return 'busy';
  return null;
}

const MIME = { jpeg: 'image/jpeg', png: 'image/png' };
const COLOR_MODES = {
  color: ['RGB24', 'RGB48'],
  gray: ['Grayscale8', 'Grayscale16'],
  // Without a 1-bit mode, gray: Paperwing makes black and white afterwards
  bw: ['BlackAndWhite1', 'Grayscale8'],
};
const colorOf = (mode) =>
  mode.startsWith('RGB')
    ? 'color'
    : mode.startsWith('Grayscale')
      ? 'gray'
      : mode === 'BlackAndWhite1'
        ? 'bw'
        : null;
/** Only images: a PDF from the scanner would have to be taken apart */
const usable = (p) => p.formats.includes(MIME.jpeg) || p.formats.includes(MIME.png);

const PAPER_SIZES = [
  ['Letter', 8.5, 11],
  ['Legal', 8.5, 14],
  ['Tabloid', 11, 17],
  ['Executive', 7.25, 10.5],
  ['A3', 11.69, 16.54],
  ['A4', 8.27, 11.69],
  ['A5', 5.83, 8.27],
  ['A6', 4.13, 5.83],
  ['B5', 6.93, 9.84],
  ['Business card', 2, 3.5],
  ['Photo 4 × 6 in', 4, 6],
  ['Photo 5 × 7 in', 5, 7],
];

/** One input's capabilities in the helpers' shape (build contract) */
function sourceCaps(id, input, model, { duplex, status }) {
  const profiles = input.profiles.filter(usable);
  if (!profiles.length) return null;
  const colors = ['color', 'gray', 'bw'].filter((c) =>
    profiles.some((p) => p.colorModes.some((m) => colorOf(m) === c))
  );
  const discrete = [...new Set(profiles.flatMap((p) => p.discrete))].sort(
    (a, b) => a - b
  );
  const ranges = profiles.flatMap((p) => p.ranges);
  const resolutions = ranges.length
    ? {
        min: Math.min(...ranges.map((r) => r.min), ...discrete),
        max: Math.max(...ranges.map((r) => r.max), ...discrete),
        step: Math.min(...ranges.map((r) => r.step)),
      }
    : discrete;
  const inches = (v, fallback) =>
    Number.isFinite(v) && v > 0 ? Math.round((v / 300) * 1000) / 1000 : fallback;
  const maxWidth = inches(input.maxWidth, 8.5);
  const maxHeight = inches(input.maxHeight, 11.69);
  const minWidth = inches(input.minWidth, 0);
  const minHeight = inches(input.minHeight, 0);
  const fits = (w, h) =>
    w <= maxWidth + 0.05 && h <= maxHeight + 0.05 && w >= minWidth && h >= minHeight;
  const feeder = id === 'feeder';
  return {
    id,
    duplex: feeder && duplex,
    resolutions,
    colors,
    maxWidth,
    maxHeight,
    minWidth,
    minHeight,
    // A feeder can't scan a page twice
    canPreview: !feeder,
    paperSizes: PAPER_SIZES.filter(([, w, h]) => fits(w, h)).map(
      ([name, width, height]) => ({ name, width, height })
    ),
    autoSize: input.autoSize,
    autoDeskew: false,
    autoCrop: false,
    blankPageSkip: feeder && model.blankPageRemoval,
    doubleFeed: false,
    invert: false,
    brightness: model.brightness,
    contrast: model.contrast,
    threshold: colors.includes('bw') ? model.threshold : null,
    // Not in the contract yet (reported to the integrator): eSCL's sharpening
    sharpen: model.sharpen,
    feederLoaded: feeder
      ? status?.adfState
        ? status.adfState === 'ScannerAdfLoaded'
        : null
      : null,
  };
}

/** The caps event for a parsed ScannerCapabilities (and status, if known) */
function capsEvent(model, status) {
  const sources = [];
  if (model.platen) sources.push(sourceCaps('flatbed', model.platen, model, { status }));
  const adf = model.adfSimplex ?? model.adfDuplex;
  if (adf)
    sources.push(
      sourceCaps('feeder', adf, model, { duplex: !!model.adfDuplex, status })
    );
  return { type: 'caps', driver: 'escl', nativeUi: false, sources: sources.filter(Boolean) };
}

const nearest = (list, want) =>
  list.reduce((best, d) => (Math.abs(d - want) < Math.abs(best - want) ? d : best));

/**
 * The ScanSettings for a request: picks the scanner's nearest resolution,
 * a colour mode it has, JPEG (PNG for black and white) and the area in its
 * units. Returns { xml, source, duplex, dpi, color, format }.
 */
function buildScanSettings(model, options = {}, { preview = false } = {}) {
  const source = preview ? 'flatbed' : options.source ?? (model.platen ? 'flatbed' : 'feeder');
  const duplex = !preview && source === 'feeder' && !!options.duplex && !!model.adfDuplex;
  const input =
    source === 'flatbed'
      ? model.platen
      : duplex
        ? model.adfDuplex
        : model.adfSimplex ?? model.adfDuplex;
  if (!input)
    throw new ScanError(
      'unsupported',
      source === 'flatbed'
        ? 'This scanner has no flatbed.'
        : 'This scanner has no document feeder.'
    );
  const profiles = input.profiles.filter(usable);
  if (!profiles.length)
    throw new ScanError('unsupported', "This scanner doesn't send images Paperwing can use.");

  const color = preview ? 'color' : options.color;
  const order = COLOR_MODES[color] ?? ['RGB24', 'Grayscale8', 'BlackAndWhite1'];
  let mode = order.find((m) => profiles.some((p) => p.colorModes.includes(m)));
  mode ??= profiles.find((p) => p.colorModes.length)?.colorModes[0] ?? 'RGB24';
  const candidates = profiles.filter((p) => p.colorModes.includes(mode));
  const profile = candidates.length ? candidates[0] : profiles[0];
  // JPEG is small and every scanner does it well; 1-bit images need PNG
  const preferred = mode === 'BlackAndWhite1' ? [MIME.png, MIME.jpeg] : [MIME.jpeg, MIME.png];
  const format = preferred.find((f) => profile.formats.includes(f));

  // Resolution: a preview is quick and small
  const want = preview ? 75 : Number.isFinite(options.dpi) ? options.dpi : 300;
  let dpi;
  if (profile.discrete.length) dpi = nearest(profile.discrete, want);
  if (profile.ranges.length) {
    const r = profile.ranges[0];
    const snapped = Math.min(r.max, Math.max(r.min, r.min + Math.round((want - r.min) / r.step) * r.step));
    if (dpi === undefined || Math.abs(snapped - want) < Math.abs(dpi - want)) dpi = snapped;
  }
  dpi ??= want;

  // The area in 1/300 inch, inside what the scanner allows
  const maxW = Number.isFinite(input.maxWidth) ? input.maxWidth : 2550;
  const maxH = Number.isFinite(input.maxHeight) ? input.maxHeight : 3508;
  const minW = Number.isFinite(input.minWidth) ? input.minWidth : 1;
  const minH = Number.isFinite(input.minHeight) ? input.minHeight : 1;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
  let region = null;
  const area = options.area && typeof options.area === 'object' ? options.area : null;
  const paper = options.paper && typeof options.paper === 'object' ? options.paper : null;
  const auto = options.area === 'auto' || options.paper === 'auto';
  if (!preview && area) {
    const w = clamp(area.width * 300, minW, maxW);
    const h = clamp(area.height * 300, minH, maxH);
    region = {
      x: clamp((area.x ?? 0) * 300, 0, maxW - w),
      y: clamp((area.y ?? 0) * 300, 0, maxH - h),
      w,
      h,
    };
  } else if (!preview && paper) {
    const w = clamp(paper.width * 300, minW, maxW);
    const h = clamp(paper.height * 300, minH, maxH);
    let x = 0;
    // A feeder that centres the paper wants the area centred too
    if (source === 'feeder' && /center/i.test(model.adfJustification)) x = Math.round((maxW - w) / 2);
    if (source === 'feeder' && /right/i.test(model.adfJustification)) x = maxW - w;
    region = { x, y: 0, w, h };
  } else if (preview || !auto) {
    region = { x: 0, y: 0, w: maxW, h: maxH };
  }

  const intent = preview ? 'Preview' : 'Document';
  const el = (name, value) => `  <${name}>${value}</${name}>\n`;
  const ranged = (key, name) => {
    const range = model[key];
    const v = options[key];
    if (preview || !range || typeof v !== 'number' || !Number.isFinite(v)) return '';
    return el(`scan:${name}`, Math.max(range.min, Math.min(range.max, Math.round(v))));
  };
  let xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<scan:ScanSettings xmlns:scan="${NS_SCAN}" xmlns:pwg="${NS_PWG}">\n` +
    // 2.0 whatever the scanner's own version, as sane-airscan does for all
    el('pwg:Version', '2.0');
  if (input.intents.includes(intent)) xml += el('scan:Intent', intent);
  if (region)
    xml +=
      '  <pwg:ScanRegions pwg:MustHonor="false">\n    <pwg:ScanRegion>\n' +
      '      <pwg:ContentRegionUnits>escl:ThreeHundredthsOfInches</pwg:ContentRegionUnits>\n' +
      `      <pwg:XOffset>${region.x}</pwg:XOffset>\n      <pwg:YOffset>${region.y}</pwg:YOffset>\n` +
      `      <pwg:Width>${region.w}</pwg:Width>\n      <pwg:Height>${region.h}</pwg:Height>\n` +
      '    </pwg:ScanRegion>\n  </pwg:ScanRegions>\n';
  xml += el('pwg:InputSource', source === 'flatbed' ? 'Platen' : 'Feeder');
  if (duplex) xml += el('scan:Duplex', 'true');
  xml += el('scan:ColorMode', mode);
  xml += el('scan:XResolution', dpi) + el('scan:YResolution', dpi);
  xml += el('pwg:DocumentFormat', format);
  if (profile.formatExt) xml += el('scan:DocumentFormatExt', format);
  xml += ranged('brightness', 'Brightness');
  xml += ranged('contrast', 'Contrast');
  if (mode === 'BlackAndWhite1') xml += ranged('threshold', 'Threshold');
  xml += ranged('sharpen', 'Sharpen');
  if (!preview && source === 'feeder' && options.blankPageSkip && model.blankPageRemoval)
    xml += el('scan:BlankPageDetectionAndRemoval', 'true');
  xml += '</scan:ScanSettings>\n';
  return { xml, source, duplex, dpi, color: colorOf(mode), format };
}

// --- Images ----------------------------------------------------------------

/** The kind and size of an image the scanner sent */
function imageInfo(buf) {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47)
    return { ext: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
        i += marker === 0xff ? 1 : 2;
        continue;
      }
      // Start of frame (any kind except the Huffman/arithmetic table markers)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return { ext: 'jpg', width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return { ext: 'jpg', width: 0, height: 0 };
  }
  return null;
}

// --- Network ---------------------------------------------------------------

/** Private, link-local and loopback addresses: where a scanner's own
 *  self-signed certificate is accepted (nowhere else) */
function isLocalAddress(ip) {
  const addr = String(ip).replace(/%.*$/, '').toLowerCase();
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (net.isIPv6(addr)) {
    if (addr.startsWith('::ffff:') && net.isIPv4(addr.slice(7))) return isLocalAddress(addr.slice(7));
    return addr === '::1' || /^fe[89ab]/.test(addr) || /^f[cd]/.test(addr);
  }
  return false;
}

const normalizeUuid = (u) =>
  String(u ?? '')
    .trim()
    .toLowerCase()
    .replace(/^urn:uuid:/, '')
    .replace(/[{}]/g, '');

/** "eSCL", "/eSCL/" and "" (some scanners) all mean /eSCL */
const resourcePath = (rs) => {
  const clean = String(rs ?? '').replace(/^\/+|\/+$/g, '');
  return clean ? `/${clean}` : '/eSCL';
};

const MAKES = [
  'Hewlett-Packard',
  'HP',
  'Canon',
  'Epson',
  'Brother',
  'Fuji Xerox',
  'Fujifilm',
  'Xerox',
  'Ricoh',
  'Kyocera',
  'Lexmark',
  'Samsung',
  'Sharp',
  'Konica Minolta',
  'Pantum',
  'Toshiba',
  'OKI',
  'Dell',
  'Panasonic',
  'Avision',
  'Develop',
];

function splitMakeModel(text) {
  const s = String(text ?? '').trim();
  const make = MAKES.find((m) => s.toLowerCase().startsWith(`${m.toLowerCase()} `));
  if (make) return { make: make === 'Hewlett-Packard' ? 'HP' : make, model: s.slice(make.length).trim() };
  const space = s.indexOf(' ');
  return space > 0 ? { make: s.slice(0, space), model: s.slice(space + 1) } : { make: '', model: s };
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ScanError('cancelled'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(new ScanError('cancelled'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** A network failure as one of the contract's error codes */
function networkError(err) {
  if (err instanceof ScanError) return err;
  const code = err?.code;
  if (code === 'EACCES' || code === 'EPERM') return new ScanError('blocked');
  if (
    [
      'ECONNREFUSED',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'EHOSTDOWN',
      'ENOTFOUND',
      'EAI_AGAIN',
      'ECONNECT_TIMEOUT',
    ].includes(code)
  )
    return new ScanError('offline');
  if (code === 'ETIMEDOUT') return new ScanError('failed', 'The scanner stopped responding.');
  return new ScanError('failed', `The scanner couldn't be reached (${err?.message ?? err}).`);
}

function createEscl(config = {}) {
  const opt = { ...DEFAULTS, ...config.timeouts };
  /** Tests point multicast DNS at a responder on a loopback port */
  const mdnsTargets = config.mdnsTargets;
  const devices = new Map(); // id -> device
  const manualHosts = new Set(config.manualHosts ?? []);

  const backoff = (attempt) =>
    Math.min(opt.maxRetryDelayMs, opt.retryDelayMs * 1.3 ** attempt);

  /**
   * One HTTP request to an endpoint. Times out if the connection takes
   * longer than connectMs or the scanner goes quiet for idleMs.
   * headersOnly: resolve as soon as the status line is in (some Kyocera
   * scanners drop the connection after the headers of a new job).
   */
  function request(dev, ep, method, reqPath, { body, idleMs = opt.requestMs, signal, headersOnly, hostHeader } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new ScanError('cancelled'));
      const mod = ep.scheme === 'https' ? https : http;
      const headers = {
        Host: hostHeader ?? hostFor(dev, ep),
        Accept: '*/*',
        'User-Agent': 'Paperwing',
        Connection: 'close',
      };
      if (body !== undefined) {
        headers['Content-Type'] = 'text/xml';
        headers['Content-Length'] = Buffer.byteLength(body);
      }
      let req;
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        signal?.removeEventListener('abort', onAbort);
        req?.destroy();
        reject(err);
      };
      const onAbort = () => fail(new ScanError('cancelled'));
      const connectTimer = setTimeout(
        () => fail(Object.assign(new Error('Connection timed out'), { code: 'ECONNECT_TIMEOUT' })),
        opt.connectMs
      );
      try {
        req = mod.request({
          host: ep.address,
          port: ep.port,
          method,
          path: reqPath,
          headers,
          agent: false,
          // A scanner's certificate is its own, self-signed: accepted only
          // on the local network
          rejectUnauthorized: !isLocalAddress(ep.address),
          servername: ep.hostname && !net.isIP(ep.hostname) ? ep.hostname : undefined,
        });
      } catch (err) {
        return fail(err);
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      req.on('socket', (sock) =>
        sock.once(ep.scheme === 'https' ? 'secureConnect' : 'connect', () => clearTimeout(connectTimer))
      );
      req.setTimeout(idleMs, () =>
        fail(Object.assign(new Error('The scanner stopped responding'), { code: 'ETIMEDOUT' }))
      );
      req.on('error', fail);
      req.on('response', (res) => {
        clearTimeout(connectTimer);
        if (res.headers.server) noteServer(dev, res.headers.server);
        if (headersOnly) {
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          res.on('error', () => {});
          res.resume();
          return resolve({ status: res.statusCode, headers: res.headers, body: Buffer.alloc(0) });
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', fail);
        res.on('aborted', () => fail(Object.assign(new Error('Connection lost'), { code: 'ECONNRESET' })));
        res.on('end', () => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          req.destroy();
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
        });
      });
      req.end(body);
    });
  }

  /** A request that asks again while the scanner answers 503 (busy) */
  async function call(dev, method, reqPath, options = {}, retries = opt.retries) {
    const ep = dev.endpoint;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await request(dev, ep, method, reqPath, options);
      } catch (err) {
        // A dropped connection on a read is worth one more try
        if (method !== 'POST' && err?.code === 'ECONNRESET' && attempt < 2) {
          await sleep(backoff(attempt), options.signal);
          continue;
        }
        throw networkError(err);
      }
      if (res.status === 503 && attempt < retries) {
        options.onBusy?.(attempt);
        await sleep(backoff(attempt), options.signal);
        continue;
      }
      return res;
    }
  }

  /** The Host header. HP's "Compact Server" wants localhost when creating
   *  a job; Epson wants the port even when it's the default */
  function hostFor(dev, ep, { job } = {}) {
    const host = job && dev.quirks.hpLocalhost ? 'localhost' : ep.hostname ?? ep.address;
    const name = net.isIPv6(host.replace(/%.*$/, '')) ? `[${host.replace(/%.*$/, '')}]` : host;
    const usual = ep.scheme === 'https' ? 443 : 80;
    return ep.port !== usual || dev.quirks.portInHost ? `${name}:${ep.port}` : name;
  }

  function noteServer(dev, server) {
    if (/HP_Compact_Server/i.test(server)) dev.quirks.hpLocalhost = true;
  }

  function publicDevice(dev) {
    return {
      id: dev.id,
      name: dev.name,
      driver: 'escl',
      deviceKey: dev.deviceKey,
      make: dev.make,
      model: dev.model,
      connection: 'network',
    };
  }

  function upsert(id, fields) {
    const dev = devices.get(id) ?? { id, endpoints: [], endpoint: null, caps: null, quirks: {} };
    Object.assign(dev, fields, { lastSeen: Date.now() });
    // Secure first: a scanner's https needs no extra care on a local network
    dev.endpoints.sort((a, b) => (a.scheme === b.scheme ? 0 : a.scheme === 'https' ? -1 : 1));
    if (dev.endpoint && !dev.endpoints.some((e) => sameEndpoint(e, dev.endpoint))) dev.endpoint = null;
    if (/epson/i.test(`${dev.make} ${dev.name}`)) dev.quirks.portInHost = true;
    devices.set(id, dev);
    return dev;
  }

  const sameEndpoint = (a, b) =>
    a.scheme === b.scheme && a.address === b.address && a.port === b.port && a.rs === b.rs;

  function addEndpoints(dev, eps) {
    const list = dev?.endpoints ?? [];
    for (const ep of eps) if (!list.some((e) => sameEndpoint(e, ep))) list.push(ep);
    return list;
  }

  /** A scanner announced over multicast DNS */
  function fromService(s) {
    const uuid = normalizeUuid(s.txt.uuid);
    const id = `escl:${uuid || s.name.toLowerCase()}`;
    const scheme = s.type === '_uscans._tcp' ? 'https' : 'http';
    const eps = s.addresses.map((address) => ({
      scheme,
      address,
      port: s.port,
      rs: resourcePath(s.txt.rs),
      hostname: null,
    }));
    const name = (typeof s.txt.ty === 'string' && s.txt.ty) || s.name;
    const { make, model } =
      typeof s.txt.mfg === 'string' && s.txt.mfg
        ? { make: s.txt.mfg, model: typeof s.txt.mdl === 'string' ? s.txt.mdl : name }
        : splitMakeModel(name);
    return upsert(id, {
      name,
      make,
      model,
      deviceKey: uuid || `host:${s.host.toLowerCase()}`,
      endpoints: addEndpoints(devices.get(id), eps),
    });
  }

  /** Reads ScannerCapabilities, trying each of the scanner's addresses */
  async function loadCaps(dev, signal) {
    const order = dev.endpoint
      ? [dev.endpoint, ...dev.endpoints.filter((e) => !sameEndpoint(e, dev.endpoint))]
      : dev.endpoints;
    let lastError = new ScanError('offline');
    for (const ep of order) {
      dev.endpoint = ep;
      try {
        const res = await call(dev, 'GET', `${ep.rs}/ScannerCapabilities`, { signal });
        if (res.status !== 200) {
          lastError = new ScanError('failed', `The scanner answered ${res.status} when asked for its settings.`);
          continue;
        }
        dev.caps = parseCapabilities(res.body.toString('utf8'));
        if (dev.caps.makeAndModel && !dev.make) Object.assign(dev, splitMakeModel(dev.caps.makeAndModel));
        if (/epson/i.test(dev.caps.makeAndModel)) dev.quirks.portInHost = true;
        return dev.caps;
      } catch (err) {
        if (err.code === 'cancelled') throw err;
        lastError = err instanceof ScanError ? err : networkError(err);
      }
    }
    dev.endpoint = null;
    throw lastError;
  }

  async function getStatus(dev, signal) {
    try {
      const res = await call(dev, 'GET', `${dev.endpoint.rs}/ScannerStatus`, { signal }, 2);
      return res.status === 200 ? parseStatus(res.body.toString('utf8')) : null;
    } catch (err) {
      if (err.code === 'cancelled') throw err;
      return null; // the status only explains; scanning goes on without it
    }
  }

  /** Parses what someone typed: "192.168.1.20", "scanner.local:8080",
   *  "[fe80::1]", "https://host/eSCL" */
  function parseAddress(input) {
    const text = String(input ?? '').trim();
    if (!text) return null;
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(text) ? text : `http://${text}`);
    } catch {
      return null;
    }
    const explicitScheme = /^https?:\/\//i.test(text) ? url.protocol.slice(0, -1) : null;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const port = url.port ? Number(url.port) : null;
    const rs = resourcePath(url.pathname.replace(/\/ScannerCapabilities$/i, '') || 'eSCL');
    const tries = explicitScheme
      ? [[explicitScheme, port ?? (explicitScheme === 'https' ? 443 : 80)]]
      : port
        ? [['https', port], ['http', port]]
        : [['https', 443], ['http', 80], ['http', 8080]];
    return { hostname, rs, tries };
  }

  /** Tries an address someone typed in; registers the scanner it finds */
  async function probe(input) {
    const parsed = parseAddress(input);
    if (!parsed) throw new ScanError('no-scanner', 'That isn’t a valid IP address or host name.');
    let addresses;
    if (net.isIP(parsed.hostname)) addresses = [parsed.hostname];
    else {
      try {
        addresses = (await Promise.race([
          dns.promises.lookup(parsed.hostname, { all: true }),
          sleep(opt.probeMs).then(() => []),
        ])).map((a) => a.address);
      } catch {
        addresses = [];
      }
      if (!addresses.length)
        throw new ScanError('no-scanner', `Paperwing couldn't find “${parsed.hostname}” on the network.`);
    }
    const address = addresses.find((a) => net.isIPv4(a)) ?? addresses[0];
    const candidates = parsed.tries.map(([scheme, port]) => ({
      scheme,
      address,
      port,
      rs: parsed.rs,
      hostname: net.isIP(parsed.hostname) ? null : parsed.hostname,
    }));
    const probeOne = async (ep) => {
      const res = await request({ quirks: {} }, ep, 'GET', `${ep.rs}/ScannerCapabilities`, {
        idleMs: Math.min(opt.requestMs, opt.probeMs),
      });
      if (res.status !== 200) throw new Error(String(res.status));
      return { ep, caps: parseCapabilities(res.body.toString('utf8')) };
    };
    const results = await Promise.allSettled(candidates.map(probeOne));
    const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (!ok.length)
      throw new ScanError('no-scanner', `No network scanner answered at ${String(input).trim()}.`);
    const { caps } = ok[0];
    const id = caps.uuid ? `escl:${caps.uuid}` : `escl:${parsed.hostname.toLowerCase()}`;
    const known = devices.get(id);
    const { make, model } = splitMakeModel(caps.makeAndModel);
    const dev = upsert(id, {
      name: known?.name ?? (caps.makeAndModel || parsed.hostname),
      make: known?.make || make,
      model: known?.model || model,
      deviceKey: caps.uuid || `host:${parsed.hostname.toLowerCase()}`,
      endpoints: addEndpoints(known, ok.map((r) => r.ep)),
      manual: String(input).trim(),
    });
    dev.endpoint = ok[0].ep;
    dev.caps = caps;
    return dev;
  }

  /**
   * The scanners on the network: ones announced over multicast DNS and the
   * ones added by address. onDevice(device) is called as each is found,
   * starting with those found by earlier searches.
   */
  async function list({ onDevice, timeoutMs = opt.discoveryMs } = {}) {
    const seen = new Map();
    const report = (dev) => {
      if (seen.has(dev.id)) return;
      seen.set(dev.id, dev);
      try {
        onDevice?.(publicDevice(dev));
      } catch {
        /* the caller's problem; keep searching */
      }
    };
    const recent = () =>
      [...devices.values()].filter((d) => Date.now() - d.lastSeen < opt.cacheMs);
    recent().forEach(report);
    let mdnsError = null;
    await Promise.all([
      mdns
        .browse({
          types: SERVICE_TYPES,
          timeoutMs,
          targets: mdnsTargets,
          onService: (s) => report(fromService(s)),
        })
        .catch((err) => (mdnsError = err)),
      ...[...manualHosts].map((h) => probe(h).then(report, () => {})),
    ]);
    // Every query refused. On a Mac, "no route to host" from every adapter
    // is what a denied Local Network permission looks like
    const blocked = ['EACCES', 'EPERM'];
    if (process.platform === 'darwin') blocked.push('EHOSTUNREACH');
    if (!seen.size && blocked.includes(mdnsError?.code)) return errorEvent('blocked');
    return { type: 'scanners', scanners: [...seen.values()].map(publicDevice) };
  }

  /** A scanner by id: from the last search, or found again */
  async function device(id) {
    if (typeof id !== 'string' || !id) throw new ScanError('no-scanner');
    if (!devices.has(id)) await list();
    const dev = devices.get(id);
    if (!dev) throw new ScanError('no-scanner');
    return dev;
  }

  /** Adds a scanner by IP address or host name; it's searched for again
   *  by every list() until removed */
  async function add(address) {
    try {
      const dev = await probe(address);
      manualHosts.add(String(address).trim());
      return { type: 'scanners', scanners: [publicDevice(dev)] };
    } catch (err) {
      const e = networkError(err);
      return errorEvent(e.code, e.message);
    }
  }

  function remove(address) {
    return manualHosts.delete(String(address).trim());
  }

  async function caps(id) {
    try {
      const dev = await device(id);
      const model = await loadCaps(dev);
      const event = capsEvent(model, await getStatus(dev));
      // e.g. a scanner that only sends PDF files
      if (!event.sources.length)
        return errorEvent('unsupported', "This scanner doesn't send images Paperwing can use.");
      return event;
    } catch (err) {
      const e = networkError(err);
      return errorEvent(e.code, e.message);
    }
  }

  /** Where the scanner is in a job */
  function jobState(status, jobPath) {
    const job = status?.jobs.find(
      (j) => (j.uri && jobPath.endsWith(j.uri.replace(/^https?:\/\/[^/]+/, ''))) || (j.uuid && jobPath.endsWith(j.uuid))
    );
    return job?.state ?? '';
  }

  function run(id, options, outDir, onEvent, preview) {
    const ctl = new AbortController();
    const signal = ctl.signal;
    let cancelled = false;
    let creating = false;
    let dev = null;
    let jobPath = null;
    let pages = 0;
    const emit = (ev) => {
      try {
        onEvent?.(ev);
      } catch {
        /* the caller's problem */
      }
      return ev;
    };
    const status = (message) => emit({ type: 'status', message });

    async function deleteJob() {
      if (!dev?.endpoint || !jobPath) return;
      const job = jobPath;
      jobPath = null;
      try {
        await request(dev, dev.endpoint, 'DELETE', job, { idleMs: Math.min(opt.requestMs, 5000) });
      } catch {
        /* finished jobs may already be gone */
      }
    }

    async function startJob(settings) {
      for (let attempt = 0; ; attempt++) {
        // No job yet, so a cancel can stop the waiting
        if (cancelled) throw new ScanError('cancelled');
        const res = await call(
          dev,
          'POST',
          `${dev.endpoint.rs}/ScanJobs`,
          {
            body: settings.xml,
            headersOnly: true,
            hostHeader: hostFor(dev, dev.endpoint, { job: true }),
            onBusy: () => status('Waiting for the scanner…'),
          },
          0
        );
        if ((res.status === 201 || res.status === 200) && res.headers.location) {
          // Only the path: scanners put localhost or an old address here
          const loc = new URL(res.headers.location, 'http://scanner/');
          return loc.pathname.replace(/\/+$/, '');
        }
        const why = statusError(await getStatus(dev), settings.source);
        if (res.status === 503 && attempt < opt.retries && (!why || why === 'busy')) {
          status('Waiting for the scanner…');
          await sleep(backoff(attempt), signal);
          continue;
        }
        if (why) throw new ScanError(why);
        if (res.status === 503 || res.status === 409) throw new ScanError('busy');
        if (res.status === 400 || res.status === 415) throw new ScanError('unsupported');
        throw new ScanError('failed', `The scanner refused the scan (${res.status}).`);
      }
    }

    async function savePage(body, settings) {
      const info = imageInfo(body);
      if (!info) throw new ScanError('unsupported', "The scanner sent a page Paperwing can't read.");
      const side = settings.duplex && pages % 2 === 1 ? 'back' : 'front';
      pages++;
      const file = path.join(outDir, `page-${pages}.${info.ext}`);
      await fsp.writeFile(file, body);
      emit({ type: 'page', file, dpi: settings.dpi, width: info.width, height: info.height, side });
    }

    const done = (async () => {
      try {
        dev = await device(id);
        const model = dev.caps && dev.endpoint ? dev.caps : await loadCaps(dev, signal);
        const settings = buildScanSettings(model, options ?? {}, { preview });
        await fsp.mkdir(outDir, { recursive: true });

        // A scanner that has just finished a job can say it's busy for a
        // moment; wait for it rather than fail
        for (let attempt = 0; attempt < opt.retries; attempt++) {
          const s = await getStatus(dev, signal);
          if (!s || (s.state !== 'Processing' && s.state !== 'Testing')) break;
          if (attempt === 0) status('Waiting for the scanner…');
          await sleep(backoff(attempt), signal);
        }

        // Starting a job isn't interrupted: the scanner would be left with
        // a job nobody deletes. A cancel takes effect right after.
        creating = true;
        jobPath = await startJob(settings);
        creating = false;
        if (cancelled) throw new ScanError('cancelled');

        let lateRetries = 0;
        let busyRetries = 0;
        status(`Scanning page ${pages + 1}…`);
        for (;;) {
          const res = await call(dev, 'GET', `${jobPath}/NextDocument`, { idleMs: opt.pageMs, signal }, 0);
          if (res.status === 200) {
            busyRetries = 0;
            await savePage(res.body, settings);
            if (preview) break;
            status(`Scanning page ${pages + 1}…`);
            continue;
          }
          if (res.status === 503) {
            // Usually "still scanning"; but a jam can show up as 503 too
            const why = statusError(await getStatus(dev, signal), settings.source);
            if (why && why !== 'busy' && why !== 'feeder-empty') throw new ScanError(why);
            if (busyRetries < opt.pageRetries) {
              await sleep(backoff(busyRetries++), signal);
              continue;
            }
            throw new ScanError('busy');
          }
          if (res.status === 404 || res.status === 410) {
            if (pages > 0) {
              // The end of the job, unless the feeder stopped on a problem
              if (settings.source === 'feeder') {
                const why = statusError(await getStatus(dev, signal), 'feeder');
                if (why === 'paper-jam' || why === 'double-feed' || why === 'cover-open')
                  throw new ScanError(why);
              }
              break;
            }
            const s = await getStatus(dev, signal);
            const state = jobState(s, jobPath);
            // Some scanners (Xerox) say "no page" before the first one is ready
            if ((state === 'Processing' || state === 'Pending') && lateRetries < opt.pageRetries) {
              await sleep(backoff(lateRetries++), signal);
              continue;
            }
            const why = statusError(s, settings.source);
            if (why && why !== 'busy') throw new ScanError(why);
            throw new ScanError(settings.source === 'feeder' ? 'feeder-empty' : 'failed',
              settings.source === 'feeder' ? undefined : "The scanner didn't send a page.");
          }
          const why = statusError(await getStatus(dev, signal), settings.source);
          if (why && why !== 'busy') throw new ScanError(why);
          throw new ScanError('failed', `The scanner stopped the scan (${res.status}).`);
        }
        await deleteJob();
        return emit({ type: 'done', pages });
      } catch (err) {
        await deleteJob();
        if (cancelled) return emit({ type: 'done', pages, cancelled: true });
        const e = networkError(err);
        return emit(errorEvent(e.code, e.message));
      }
    })();

    return {
      cancel() {
        if (cancelled) return;
        cancelled = true;
        if (!creating) ctl.abort();
      },
      done,
    };
  }

  return {
    list,
    caps,
    add,
    remove,
    /** A quick, low-resolution scan of the whole glass */
    preview: (id, options, outDir, onEvent) => run(id, options, outDir, onEvent, true),
    scan: (id, options, outDir, onEvent) => run(id, options, outDir, onEvent, false),
  };
}

module.exports = {
  createEscl,
  parseXml,
  parseCapabilities,
  parseStatus,
  capsEvent,
  buildScanSettings,
  imageInfo,
  isLocalAddress,
  splitMakeModel,
  MESSAGES,
};
