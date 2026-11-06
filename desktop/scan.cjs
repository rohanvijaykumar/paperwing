/**
 * Scanning (issue #35): which scanners there are, what each can do, and
 * scanning page by page, the same way on Windows and macOS.
 *
 * - Windows: WIA, Windows' own scanner API, driven by scanner/wia.ps1 through
 *   PowerShell (built into Windows: nothing to install or compile). Network
 *   scanners (eSCL/WSD) show up there too.
 * - macOS: Apple's ImageCaptureCore, through the paperwing-scan helper built
 *   with the app (native/mac-scanner). AirScan network scanners show up too.
 * - Development builds stand in a scanner when PAPERWING_SCAN_TEST is set,
 *   so the benches can run the whole flow without one.
 *
 * Both helpers speak the same protocol: JSON, one object per line on stdout.
 *   list  -> { type: 'scanners', scanners: [{ id, name }] }
 *   caps  -> { type: 'caps', sources: [{ id: 'flatbed' | 'feeder', duplex,
 *              resolutions: [dpi], colors: ['color' | 'gray' | 'bw'],
 *              width, height (inches, the largest area) }] }
 *   scan  -> { type: 'page', file, dpi } for each page, then
 *            { type: 'done' } or { type: 'error', code, message }
 *
 * Electron's dependencies are passed in, so tests can stand in for them.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { spawn } = require('node:child_process');

/** What a scan can fail with; the page explains each */
const ERRORS = [
  'feeder-empty',
  'paper-jam',
  'busy',
  'offline',
  'cover-open',
  'warming-up',
  'no-scanner',
  'cancelled',
  'failed',
];
const SOURCES = ['flatbed', 'feeder'];
const COLORS = ['color', 'gray', 'bw'];
/** Listing or reading a scanner's settings mustn't hang the dialog */
const QUERY_TIMEOUT_MS = 45000;
/** A scanner that stops answering mid-scan */
const PAGE_TIMEOUT_MS = 180000;

/** Checks the page's scan request; throws on anything unexpected */
function checkScanOptions(options) {
  if (!options || typeof options !== 'object')
    throw new TypeError('Missing scan options');
  const {
    source = 'flatbed',
    duplex = false,
    color = 'color',
    dpi = 300,
    width = 8.5,
    height = 11,
  } = options;
  if (!SOURCES.includes(source)) throw new TypeError('Invalid source');
  if (typeof duplex !== 'boolean') throw new TypeError('Invalid two-sided');
  if (!COLORS.includes(color)) throw new TypeError('Invalid color mode');
  if (!Number.isInteger(dpi) || dpi < 50 || dpi > 1200)
    throw new TypeError('Invalid resolution');
  // Inches: a business card to a tabloid page
  const inches = (v) => typeof v === 'number' && v >= 1 && v <= 17;
  if (!inches(width) || !inches(height)) throw new TypeError('Invalid size');
  return {
    source,
    duplex: source === 'feeder' && duplex,
    color,
    dpi,
    width,
    height,
  };
}

/** One line of a helper's output, or null if it isn't one of ours */
function parseLine(line) {
  const text = line.trim();
  if (!text.startsWith('{')) return null;
  try {
    const msg = JSON.parse(text);
    return msg && typeof msg.type === 'string' ? msg : null;
  } catch {
    return null;
  }
}

/** A helper's capabilities, cleaned up: only what the dialog can offer */
function cleanCaps(sources) {
  if (!Array.isArray(sources)) return [];
  return sources
    .filter((s) => s && SOURCES.includes(s.id))
    .map((s) => ({
      id: s.id,
      duplex: s.id === 'feeder' && !!s.duplex,
      resolutions: [
        ...new Set(
          (Array.isArray(s.resolutions) ? s.resolutions : [])
            .map(Number)
            .filter((d) => Number.isInteger(d) && d >= 50 && d <= 1200)
        ),
      ].sort((a, b) => a - b),
      colors: COLORS.filter((c) => (s.colors ?? COLORS).includes(c)),
      width: Number(s.width) > 0 ? Number(s.width) : 8.5,
      height: Number(s.height) > 0 ? Number(s.height) : 11.7,
    }));
}

function createScanning({
  platform = process.platform,
  /** The Windows script (scanner/wia.ps1) and the macOS helper */
  wiaScript,
  macHelper,
  isPackaged = false,
  env = process.env,
  tempDir = os.tmpdir(),
  /** A stand-in scanner page for development: { data (PNG), dpi } */
  makeTestPage,
  spawnProcess = spawn,
}) {
  const testMode = !isPackaged && !!env.PAPERWING_SCAN_TEST;
  let current = null;

  /** The helper for this platform: [command, args before ours] */
  function helper() {
    if (platform === 'win32') {
      const script = wiaScript;
      return [
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-STA',
          '-File',
          script,
        ],
      ];
    }
    if (platform === 'darwin' && macHelper && fs.existsSync(macHelper))
      return [macHelper, []];
    return null;
  }

  /** Runs the helper; calls onMessage for each line; resolves at exit */
  function run(args, onMessage, timeoutMs, onSpawn) {
    const h = helper();
    if (!h) return Promise.resolve({ ok: false, error: 'no-scanner' });
    const [cmd, pre] = h;
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnProcess(cmd, [...pre, ...args], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        resolve({
          ok: false,
          error: 'failed',
          message: String(err?.message ?? err),
        });
        return;
      }
      let buffer = '';
      let stderr = '';
      let timer;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          child.kill();
          resolve({
            ok: false,
            error: 'failed',
            message: 'The scanner stopped responding',
          });
        }, timeoutMs);
      };
      arm();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const msg = parseLine(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
          if (msg) {
            arm();
            onMessage(msg);
          }
        }
      });
      child.stderr.on('data', (d) => (stderr += d).slice(-4000));
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          ok: false,
          error: 'failed',
          message: String(err?.message ?? err),
        });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const last = parseLine(buffer);
        if (last) onMessage(last);
        resolve({ ok: code === 0, code, stderr: stderr.trim() });
      });
      onSpawn?.(child);
    });
  }

  /** The scanners connected or on the network */
  async function list() {
    if (testMode)
      return {
        ok: true,
        scanners: [{ id: 'test:scanner', name: 'Paperwing test scanner' }],
      };
    let scanners = null;
    let error = null;
    const r = await run(
      ['list'],
      (m) => {
        if (m.type === 'scanners') scanners = m.scanners;
        if (m.type === 'error') error = m;
      },
      QUERY_TIMEOUT_MS
    );
    if (Array.isArray(scanners))
      return {
        ok: true,
        scanners: scanners
          .filter((s) => s && typeof s.id === 'string' && s.id)
          .map((s) => ({ id: s.id, name: String(s.name || s.id) })),
      };
    return {
      ok: false,
      scanners: [],
      error: error?.code ?? r.error ?? 'failed',
      message: error?.message ?? r.message ?? r.stderr,
    };
  }

  /** What one scanner can do */
  async function capabilities(id) {
    if (typeof id !== 'string' || !id) return { ok: false, error: 'invalid' };
    if (testMode)
      return {
        ok: true,
        sources: cleanCaps([
          {
            id: 'flatbed',
            resolutions: [75, 150, 200, 300, 600],
            colors: COLORS,
            width: 8.5,
            height: 11.7,
          },
          {
            id: 'feeder',
            duplex: true,
            resolutions: [150, 200, 300, 600],
            colors: COLORS,
            width: 8.5,
            height: 14,
          },
        ]),
      };
    let sources = null;
    let error = null;
    const r = await run(
      ['caps', '-DeviceId', id],
      (m) => {
        if (m.type === 'caps') sources = m.sources;
        if (m.type === 'error') error = m;
      },
      QUERY_TIMEOUT_MS
    );
    if (sources) return { ok: true, sources: cleanCaps(sources) };
    return {
      ok: false,
      error: error?.code ?? r.error ?? 'failed',
      message: error?.message ?? r.message ?? r.stderr,
    };
  }

  /** The stand-in scanner: numbered pages, a feeder that empties */
  async function testScan(opts, onPage, dir) {
    const fail = env.PAPERWING_SCAN_TEST_ERROR;
    if (
      fail &&
      ERRORS.includes(fail) &&
      !(opts.source === 'flatbed' && fail === 'feeder-empty')
    )
      return { ok: false, error: fail, message: `Test scanner: ${fail}` };
    const sheets =
      opts.source === 'feeder' ? Number(env.PAPERWING_SCAN_TEST_PAGES) || 3 : 1;
    const sides = opts.duplex ? 2 : 1;
    let n = 0;
    for (let sheet = 0; sheet < sheets; sheet++) {
      for (let side = 0; side < sides; side++) {
        if (current?.cancelled) return { ok: false, error: 'cancelled' };
        n++;
        const file = path.join(dir, `page-${n}.png`);
        const page = makeTestPage(opts, n);
        await fsp.writeFile(file, page.data);
        await onPage(file, page.dpi);
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    return { ok: true, pages: n };
  }

  /** Scans with these options; onPage(data, info) for each page as it comes */
  async function scan(id, options, onPage) {
    if (current)
      return { ok: false, error: 'busy', message: 'Already scanning' };
    let opts;
    try {
      opts = checkScanOptions(options);
    } catch (err) {
      return { ok: false, error: 'invalid', message: err.message };
    }
    if (typeof id !== 'string' || !id) return { ok: false, error: 'invalid' };
    // (busy before anything is awaited: a second scan must find it so)
    const job = { cancelled: false };
    current = job;
    let dir;
    try {
      dir = await fsp.mkdtemp(path.join(tempDir, 'paperwing-scan-'));
    } catch (err) {
      current = null;
      return {
        ok: false,
        error: 'failed',
        message: String(err?.message ?? err),
      };
    }
    let pages = 0;
    const deliver = async (file, dpi) => {
      const data = await fsp.readFile(file);
      await fsp.rm(file, { force: true });
      pages++;
      onPage(new Uint8Array(data), {
        index: pages,
        dpi: Number(dpi) || opts.dpi,
        mime: data[0] === 0xff && data[1] === 0xd8 ? 'image/jpeg' : 'image/png',
      });
    };
    try {
      if (testMode) return await testScan(opts, deliver, dir);
      let ended = null;
      const delivering = [];
      const r = await run(
        [
          'scan',
          '-DeviceId',
          id,
          '-OutDir',
          dir,
          '-Options',
          Buffer.from(JSON.stringify(opts)).toString('base64'),
        ],
        (m) => {
          if (m.type === 'page' && typeof m.file === 'string')
            delivering.push(deliver(m.file, m.dpi));
          if (m.type === 'done' || m.type === 'error') ended = m;
        },
        PAGE_TIMEOUT_MS,
        (child) => (job.child = child)
      );
      await Promise.all(delivering);
      if (job.cancelled) return { ok: false, error: 'cancelled', pages };
      if (ended?.type === 'done') return { ok: true, pages };
      if (ended?.type === 'error')
        return {
          ok: false,
          // The feeder running out after some pages is how a feeder scan ends
          ...(ended.code === 'feeder-empty' && pages
            ? { ok: true }
            : { error: ERRORS.includes(ended.code) ? ended.code : 'failed' }),
          message: ended.message,
          pages,
        };
      return {
        ok: false,
        error: r.error ?? 'failed',
        message: r.message ?? (r.stderr || 'The scanner stopped unexpectedly'),
        pages,
      };
    } finally {
      if (current === job) current = null;
      fs.rm(dir, { recursive: true, force: true }, () => {});
    }
  }

  /** Stops a scan; the page being scanned may still arrive */
  function cancel() {
    if (!current) return false;
    current.cancelled = true;
    current.child?.kill();
    return true;
  }

  return { list, capabilities, scan, cancel, testMode };
}

module.exports = {
  createScanning,
  checkScanOptions,
  parseLine,
  cleanCaps,
  ERRORS,
};
