/**
 * Scanning (#35): one service over every way of reaching a scanner, the
 * same on Windows and macOS.
 *
 * - Windows: paperwing-scan.exe (x64: WIA and 64-bit TWAIN) and
 *   paperwing-twain32.exe (x86: 32-bit TWAIN drivers), built on NAPS2's
 *   scanning libraries (native/win-scanner).
 * - macOS: paperwing-scan (Swift, ImageCaptureCore; native/mac-scanner).
 * - Both: network scanners (eSCL/AirScan) through escl.cjs, in this process.
 * - Development builds stand in scanners when PAPERWING_SCAN_TEST is set
 *   (scan-test.cjs), so the benches can run the whole flow without one.
 *
 * Every backend speaks the scanner contract (PLAN-SCANNING-AND-CERTIFICATES,
 * "Build contracts"): JSON lines, one process per command. A scanner reached
 * several ways (WIA and TWAIN, say) is listed once, under its deviceKey, with
 * the best driver first and the others offered under Options ▸ Driver.
 *
 * Electron's dependencies are passed in, so tests can stand in for them.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { spawn } = require('node:child_process');

/** Error codes a scanner can fail with; the dialog explains each */
const ERRORS = [
  'no-scanner',
  'offline',
  'busy',
  'paper-jam',
  'feeder-empty',
  'double-feed',
  'cover-open',
  'unsupported',
  'blocked',
  'failed',
];
const SOURCES = ['flatbed', 'feeder'];
const COLORS = ['color', 'gray', 'bw'];

/**
 * Drivers, best first (the contract's order). twain is 64-bit TWAIN through
 * the x64 helper, twain32 the 32-bit helper; wia1 is a WIA 1.0 device.
 */
const DRIVER_ORDER = {
  win32: ['twain', 'wia', 'escl', 'twain32', 'wia1'],
  darwin: ['escl', 'ica'],
};
const DRIVER_LABELS = {
  twain: 'TWAIN',
  wia: 'WIA',
  escl: 'Network (eSCL)',
  twain32: 'TWAIN (32-bit)',
  wia1: 'WIA 1.0',
  ica: 'Image Capture',
};
/** Resolutions offered from a scanner that gives a range */
const USUAL_DPI = [75, 100, 150, 200, 240, 300, 400, 600, 1200];

/** Listing or reading a scanner's settings mustn't hang the dialog */
const QUERY_TIMEOUT_MS = 45000;
/** A scanner that stops answering mid-scan */
const PAGE_TIMEOUT_MS = 180000;
/** After "cancel", a helper that hasn't stopped is ended */
const CANCEL_KILL_MS = 10000;

/** One line of a backend's output, or null if it isn't one of ours */
function parseLine(line) {
  const text = String(line).trim();
  if (!text.startsWith('{')) return null;
  try {
    const msg = JSON.parse(text);
    return msg && typeof msg.type === 'string' ? msg : null;
  } catch {
    return null;
  }
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const inches = (v, max = 60) => isNum(v) && v >= 0 && v <= max;

/** A {min, max, step, default} range, or null */
function cleanRange(r) {
  if (!r || !isNum(r.min) || !isNum(r.max) || r.max <= r.min) return null;
  const step = isNum(r.step) && r.step > 0 ? r.step : 1;
  const def = isNum(r.default)
    ? Math.min(r.max, Math.max(r.min, r.default))
    : r.min + (r.max - r.min) / 2;
  return { min: r.min, max: r.max, step, default: def };
}

/** A source's resolutions: its list, or the usual ones within its range */
function cleanResolutions(res) {
  const ok = (d) => Number.isInteger(d) && d >= 25 && d <= 4800;
  if (Array.isArray(res))
    return {
      list: [...new Set(res.map(Number).filter(ok))].sort((a, b) => a - b),
      range: null,
    };
  const range = cleanRange(res);
  if (!range) return { list: [], range: null };
  const within = USUAL_DPI.filter(
    (d) =>
      d >= range.min &&
      d <= range.max &&
      Math.abs(((d - range.min) / range.step) % 1) < 1e-9
  );
  const list = [
    ...new Set([range.min, ...within, range.max].map(Math.round).filter(ok)),
  ].sort((a, b) => a - b);
  return { list, range };
}

/** A backend's capabilities, cleaned up: only what the dialog can offer */
function cleanCaps(msg, driver) {
  const sources = Array.isArray(msg?.sources) ? msg.sources : [];
  const flag = (v) => v === true;
  return {
    driver,
    nativeUi: flag(msg?.nativeUi),
    sources: sources
      .filter((s) => s && SOURCES.includes(s.id))
      .map((s) => {
        const { list, range } = cleanResolutions(s.resolutions);
        const maxWidth = inches(s.maxWidth) && s.maxWidth > 0 ? s.maxWidth : 8.5;
        const maxHeight =
          inches(s.maxHeight) && s.maxHeight > 0 ? s.maxHeight : 11.69;
        return {
          id: s.id,
          duplex: s.id === 'feeder' && flag(s.duplex),
          resolutions: list.length ? list : [150, 200, 300, 600],
          resolutionRange: range,
          colors: COLORS.filter((c) =>
            (Array.isArray(s.colors) ? s.colors : COLORS).includes(c)
          ),
          maxWidth,
          maxHeight,
          minWidth: inches(s.minWidth) ? Math.min(s.minWidth, maxWidth) : 0,
          minHeight: inches(s.minHeight) ? Math.min(s.minHeight, maxHeight) : 0,
          canPreview: s.id === 'flatbed' && flag(s.canPreview),
          paperSizes: (Array.isArray(s.paperSizes) ? s.paperSizes : [])
            .filter(
              (p) =>
                p &&
                typeof p.name === 'string' &&
                inches(p.width) &&
                inches(p.height) &&
                p.width > 0 &&
                p.height > 0
            )
            .map((p) => ({
              name: p.name.slice(0, 60),
              width: p.width,
              height: p.height,
            })),
          autoSize: flag(s.autoSize),
          autoDeskew: flag(s.autoDeskew),
          autoCrop: flag(s.autoCrop),
          blankPageSkip: flag(s.blankPageSkip),
          doubleFeed: s.id === 'feeder' && flag(s.doubleFeed),
          invert: flag(s.invert),
          brightness: cleanRange(s.brightness),
          contrast: cleanRange(s.contrast),
          threshold: cleanRange(s.threshold),
          sharpen: cleanRange(s.sharpen),
          feederLoaded:
            typeof s.feederLoaded === 'boolean' ? s.feederLoaded : null,
        };
      }),
  };
}

/**
 * Checks the dialog's scan request and keeps only what the contract knows;
 * absent means the scanner's default. Throws on anything unexpected.
 */
function checkScanOptions(options) {
  if (!options || typeof options !== 'object')
    throw new TypeError('Missing scan options');
  const o = options;
  const out = {};
  const source = o.source ?? 'flatbed';
  if (!SOURCES.includes(source)) throw new TypeError('Invalid source');
  out.source = source;
  if (o.duplex !== undefined && typeof o.duplex !== 'boolean')
    throw new TypeError('Invalid two-sided');
  out.duplex = source === 'feeder' && o.duplex === true;
  const color = o.color ?? 'color';
  if (!COLORS.includes(color)) throw new TypeError('Invalid color mode');
  out.color = color;
  const dpi = o.dpi ?? 300;
  if (!Number.isInteger(dpi) || dpi < 25 || dpi > 4800)
    throw new TypeError('Invalid resolution');
  out.dpi = dpi;
  if (o.area !== undefined) {
    const a = o.area;
    if (
      !a ||
      !inches(a.x) ||
      !inches(a.y) ||
      !inches(a.width) ||
      !inches(a.height) ||
      a.width < 0.2 ||
      a.height < 0.2
    )
      throw new TypeError('Invalid scan area');
    out.area = { x: a.x, y: a.y, width: a.width, height: a.height };
  } else if (o.paper === 'auto') {
    out.paper = 'auto';
  } else if (o.paper !== undefined) {
    const p = o.paper;
    if (
      !p ||
      !inches(p.width) ||
      !inches(p.height) ||
      p.width < 0.5 ||
      p.height < 0.5
    )
      throw new TypeError('Invalid paper size');
    out.paper = { width: p.width, height: p.height };
  }
  for (const k of ['brightness', 'contrast', 'threshold', 'sharpen']) {
    if (o[k] === undefined) continue;
    if (!isNum(o[k]) || Math.abs(o[k]) > 100000)
      throw new TypeError(`Invalid ${k}`);
    out[k] = o[k];
  }
  for (const k of [
    'autoDeskew',
    'blankPageSkip',
    'doubleFeedStop',
    'invert',
    'nativeUi',
  ]) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== 'boolean') throw new TypeError(`Invalid ${k}`);
    out[k] = o[k];
  }
  if (o.transfer !== undefined) {
    if (!['native', 'memory'].includes(o.transfer))
      throw new TypeError('Invalid transfer method');
    out.transfer = o.transfer;
  }
  // Seconds a slow network scanner gets (escl.cjs)
  if (o.timeout !== undefined) {
    if (!Number.isInteger(o.timeout) || o.timeout < 5 || o.timeout > 600)
      throw new TypeError('Invalid timeout');
    out.timeout = o.timeout;
  }
  return out;
}

/** A deviceKey compared loosely: the same scanner seen by two drivers */
const keyOf = (k) =>
  typeof k === 'string' && k.trim() ? k.trim().toLowerCase() : null;

/**
 * One entry per physical scanner. `found` is [{ driver, scanner }] from
 * every backend; devices sharing a deviceKey become one entry, best driver
 * first. Device ids are "<driver>:<backend's id>", so any call can be routed.
 */
function mergeScanners(found, order) {
  const rank = (d) => {
    const i = order.indexOf(d);
    return i < 0 ? order.length : i;
  };
  const entries = new Map();
  for (const { driver, scanner: s } of found) {
    if (!s || typeof s.id !== 'string' || !s.id) continue;
    const id = `${driver}:${s.id}`;
    // A network scanner's eSCL uuid is the deviceKey Image Capture gives it
    const aliases = [keyOf(s.deviceKey), keyOf(s.uuid)].filter(Boolean);
    const key = aliases[0] ?? id;
    const connection = ['usb', 'network'].includes(s.connection)
      ? s.connection
      : 'unknown';
    const device = {
      id,
      driver,
      label: DRIVER_LABELS[driver] ?? driver,
      name: String(s.name || s.model || s.id).slice(0, 120),
    };
    let entry = [key, ...aliases].map((a) => entries.get(a)).find(Boolean);
    if (!entry) {
      entry = {
        key,
        name: device.name,
        make: typeof s.make === 'string' ? s.make : '',
        model: typeof s.model === 'string' ? s.model : '',
        connection,
        devices: [],
      };
    }
    for (const a of [key, ...aliases]) entries.set(a, entry);
    if (entry.devices.some((d) => d.id === id)) continue;
    entry.devices.push(device);
    entry.devices.sort((a, b) => rank(a.driver) - rank(b.driver));
    // The best driver's name; USB beats unknown, network is kept if seen
    entry.name = entry.devices[0].name;
    if (entry.connection === 'unknown') entry.connection = connection;
    if (!entry.make && typeof s.make === 'string') entry.make = s.make;
    if (!entry.model && typeof s.model === 'string') entry.model = s.model;
  }
  return [...new Set(entries.values())].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  );
}

/**
 * A helper program as a backend: one process per command, JSON lines out,
 * "cancel" in. `drivers(msgDriver, scanner)` names the driver a listed
 * scanner belongs to (the x86 helper's TWAIN is "twain32").
 */
function helperBackend({
  command,
  prefix = [],
  driverFor,
  spawnProcess,
  cancelKillMs = CANCEL_KILL_MS,
  /** The app window's handle: the scanner's own window opens in front */
  windowHandle = () => null,
}) {
  function run(args, onMessage, { timeoutMs, input = false } = {}) {
    let child;
    try {
      child = spawnProcess(command, [...prefix, ...args], {
        windowsHide: true,
        stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      return {
        cancel() {},
        done: Promise.resolve({ spawnError: String(err?.message ?? err) }),
      };
    }
    let killTimer = null;
    const done = new Promise((resolve) => {
      let buffer = '';
      let stderr = '';
      let timer;
      let timedOut = false;
      const arm = () => {
        clearTimeout(timer);
        // (null: the scanner's own window waits on the person, for as long
        // as they take)
        if (timeoutMs === null) return;
        timer = setTimeout(() => {
          timedOut = true;
          child.kill();
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
      child.stderr?.on('data', (d) => {
        stderr = (stderr + d).slice(-4000);
      });
      // (a helper gone before we write to it: nothing to do)
      child.stdin?.on?.('error', () => {});
      child.on('error', (err) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        resolve({ spawnError: String(err?.message ?? err) });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        const last = parseLine(buffer);
        if (last) onMessage(last);
        resolve({ code, stderr: stderr.trim(), timedOut });
      });
    });
    return {
      cancel() {
        try {
          child.stdin?.write('cancel\n');
        } catch {
          /* gone already */
        }
        clearTimeout(killTimer);
        killTimer = setTimeout(() => child.kill(), cancelKillMs);
      },
      done,
    };
  }

  /** A query (list, caps): its answer, or why there's none */
  async function query(args, want) {
    let answer = null;
    let error = null;
    const r = await run(
      args,
      (m) => {
        if (m.type === want) answer = m;
        if (m.type === 'error') error = m;
      },
      { timeoutMs: QUERY_TIMEOUT_MS }
    ).done;
    if (answer) return { ok: true, msg: answer };
    return {
      ok: false,
      error: ERRORS.includes(error?.code)
        ? error.code
        : r.spawnError
          ? 'blocked'
          : 'failed',
      message:
        error?.message ??
        r.spawnError ??
        (r.timedOut ? 'The scanner stopped responding' : r.stderr) ??
        '',
    };
  }

  return {
    async list() {
      const r = await query(['list'], 'scanners');
      if (!r.ok) return r;
      const scanners = Array.isArray(r.msg.scanners) ? r.msg.scanners : [];
      return {
        ok: true,
        found: scanners
          .filter((s) => s && typeof s.id === 'string')
          .map((s) => ({ driver: driverFor(s), scanner: s })),
      };
    },
    async caps(id) {
      const r = await query(['caps', '-Id', id], 'caps');
      return r.ok ? { ok: true, msg: r.msg } : r;
    },
    /** preview or scan: events as they come; resolves when it has ended */
    start(command, id, outDir, options, onEvent) {
      const job = run(
        [
          command,
          '-Id',
          id,
          '-OutDir',
          outDir,
          '-Options',
          Buffer.from(JSON.stringify(options)).toString('base64'),
          ...(windowHandle() ? ['-Window', String(windowHandle())] : []),
        ],
        onEvent,
        {
          timeoutMs: options.nativeUi ? null : PAGE_TIMEOUT_MS,
          input: true,
        }
      );
      return {
        cancel: job.cancel,
        done: job.done.then((r) =>
          r.spawnError
            ? { error: 'blocked', message: r.spawnError }
            : r.timedOut
              ? { error: 'offline', message: 'The scanner stopped responding' }
              : { exitCode: r.code, stderr: r.stderr }
        ),
      };
    },
  };
}

/**
 * escl.cjs (network scanners) as a backend. Its calls answer with the
 * contract's messages; a scan that hears nothing from the scanner for the
 * chosen time (Options ▸ wait for a slow network scanner) is stopped.
 */
function esclBackend(escl) {
  const failure = (m) => ({
    ok: false,
    error: ERRORS.includes(m?.code) ? m.code : 'failed',
    message: m?.message,
  });
  return {
    async list() {
      const r = await escl.list();
      if (r?.type !== 'scanners') return failure(r);
      return {
        ok: true,
        found: (r.scanners ?? []).map((s) => ({ driver: 'escl', scanner: s })),
      };
    },
    async caps(id) {
      const r = await escl.caps(id);
      return r?.type === 'caps' ? { ok: true, msg: r } : failure(r);
    },
    start(command, id, outDir, options, onEvent) {
      const { timeout, ...opts } = options;
      let timer = null;
      let silent = false;
      const job = escl[command === 'preview' ? 'preview' : 'scan'](
        id,
        opts,
        outDir,
        (m) => {
          arm();
          onEvent(m);
        }
      );
      function arm() {
        if (!timeout) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          silent = true;
          job.cancel();
        }, timeout * 1000);
      }
      arm();
      return {
        cancel: () => job.cancel(),
        done: job.done.then(() => {
          clearTimeout(timer);
          return silent
            ? { error: 'offline', message: 'The scanner stopped responding' }
            : { exitCode: 0 };
        }),
      };
    },
    async add(host) {
      const r = await escl.add(host);
      return r?.type === 'scanners' && r.scanners?.[0]
        ? { ok: true, scanner: r.scanners[0] }
        : failure(r);
    },
  };
}

/**
 * Watches a folder a scanner's own app saves to (ScanSnap Home and the
 * like) and hands over each new PDF or image once it's completely written.
 */
const IMPORT_EXT = /\.(pdf|png|jpe?g|tiff?|bmp)$/i;
const SETTLE_MS = 600;
const SETTLE_GIVE_UP_MS = 5 * 60000;

/** Whether a file's last bytes look like a finished file of its kind */
function looksComplete(name, head, tail) {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.pdf')
    return head.subarray(0, 5).toString('latin1') === '%PDF-' &&
      tail.toString('latin1').includes('%%EOF');
  if (ext === '.png') return tail.toString('latin1').includes('IEND');
  if (ext === '.jpg' || ext === '.jpeg') {
    const t = tail.subarray(-2);
    return head[0] === 0xff && head[1] === 0xd8 && t[0] === 0xff && t[1] === 0xd9;
  }
  return true; // TIFF and BMP end anywhere: a steady size has to do
}

function watchFolder(
  dir,
  onFile,
  { watch = fs.watch, settleMs = SETTLE_MS, pollMs = 2000 } = {}
) {
  const seen = new Map(); // name -> "size:mtime" already handed over (or there at the start)
  const pending = new Map(); // name -> { timer, last, since }
  let closed = false;
  let watcher = null;
  let poll = null;

  const stamp = (st) => `${st.size}:${st.mtimeMs}`;

  async function check(name) {
    if (closed) return;
    const file = path.join(dir, name);
    const p = pending.get(name);
    let st;
    try {
      st = await fsp.stat(file);
    } catch {
      pending.delete(name); // deleted or renamed away
      return;
    }
    if (!st.isFile() || seen.get(name) === stamp(st)) {
      pending.delete(name);
      return;
    }
    const now = Date.now();
    const steady = p?.last === stamp(st) && st.size > 0;
    if (!steady) {
      if (p && now - p.since > SETTLE_GIVE_UP_MS) return void pending.delete(name);
      pending.set(name, {
        last: stamp(st),
        since: p?.since ?? now,
        timer: setTimeout(() => void check(name), settleMs),
      });
      return;
    }
    // Steady: can it be read whole, and does it end like a finished file?
    let data;
    try {
      // (on Windows, a file still open for writing can't be opened r+)
      if (process.platform === 'win32') await (await fsp.open(file, 'r+')).close();
      data = await fsp.readFile(file);
    } catch {
      pending.set(name, { ...p, timer: setTimeout(() => void check(name), settleMs) });
      return;
    }
    const head = data.subarray(0, 8);
    const tail = data.subarray(Math.max(0, data.length - 1024));
    if (data.length !== st.size || !looksComplete(name, head, tail)) {
      if (now - p.since > SETTLE_GIVE_UP_MS) return void pending.delete(name);
      pending.set(name, {
        last: '',
        since: p.since,
        timer: setTimeout(() => void check(name), settleMs),
      });
      return;
    }
    pending.delete(name);
    seen.set(name, stamp(st));
    if (!closed) onFile({ name, path: file, data: new Uint8Array(data) });
  }

  function noticed(name) {
    if (closed || !name || !IMPORT_EXT.test(name) || name.startsWith('.')) return;
    if (pending.has(name)) return; // already settling
    pending.set(name, {
      last: null,
      since: Date.now(),
      timer: setTimeout(() => void check(name), 50),
    });
  }

  const ready = (async () => {
    // What's there already isn't new
    for (const name of await fsp.readdir(dir).catch(() => [])) {
      if (!IMPORT_EXT.test(name)) continue;
      const st = await fsp.stat(path.join(dir, name)).catch(() => null);
      if (st?.isFile()) seen.set(name, stamp(st));
    }
    if (closed) return;
    try {
      watcher = watch(dir, (_event, name) => noticed(name && String(name)));
      watcher.on?.('error', () => {});
    } catch {
      watcher = null;
    }
    // Network drives and some sync folders send no events: look every 2 s
    poll = setInterval(async () => {
      for (const name of await fsp.readdir(dir).catch(() => []))
        if (IMPORT_EXT.test(name) && !pending.has(name)) {
          const st = await fsp.stat(path.join(dir, name)).catch(() => null);
          if (st?.isFile() && seen.get(name) !== stamp(st)) noticed(name);
        }
    }, pollMs);
  })();

  return {
    ready,
    close() {
      closed = true;
      watcher?.close();
      clearInterval(poll);
      for (const p of pending.values()) clearTimeout(p.timer);
      pending.clear();
    },
  };
}

const mimeOf = (data) =>
  data[0] === 0xff && data[1] === 0xd8
    ? 'image/jpeg'
    : data[0] === 0x89 && data[1] === 0x50
      ? 'image/png'
      : data[0] === 0x25 && data[1] === 0x50
        ? 'application/pdf'
        : (data[0] === 0x49 && data[1] === 0x49) ||
            (data[0] === 0x4d && data[1] === 0x4d)
          ? 'image/tiff'
          : data[0] === 0x42 && data[1] === 0x4d
            ? 'image/bmp'
            : 'application/octet-stream';

function createScanning({
  platform = process.platform,
  /** The helpers: { scan (x64 or the Mac's), twain32 } paths */
  helpers = {},
  /** escl.cjs's network scanners (null: none) */
  escl = null,
  isPackaged = false,
  env = process.env,
  tempDir = os.tmpdir(),
  spawnProcess = spawn,
  /** The stand-in scanners (scan-test.cjs), for tests */
  testBackends,
  cancelKillMs,
  /** () => the app window's native handle, for the scanner's own window */
  windowHandle,
}) {
  const testMode = !isPackaged && !!env.PAPERWING_SCAN_TEST;
  const order = DRIVER_ORDER[platform] ?? ['escl'];
  let current = null;
  let watcher = null;

  /** driver -> the backend that reaches it */
  const backends = (() => {
    if (testMode) {
      const t =
        testBackends ?? require('./scan-test.cjs').createTestBackends({ platform, env });
      return t;
    }
    const map = {};
    const exists = (p) => typeof p === 'string' && fs.existsSync(p);
    if (platform === 'win32') {
      if (exists(helpers.scan)) {
        const x64 = helperBackend({
          command: helpers.scan,
          spawnProcess,
          cancelKillMs,
          windowHandle,
          // ("api": wia2, wia1, twain64; the x86 helper's TWAIN is twain32)
          driverFor: (s) =>
            s.driver === 'twain'
              ? s.api === 'twain32'
                ? 'twain32'
                : 'twain'
              : s.api === 'wia1'
                ? 'wia1'
                : 'wia',
        });
        map.twain = map.wia = map.wia1 = x64;
      }
      if (exists(helpers.twain32))
        map.twain32 = helperBackend({
          command: helpers.twain32,
          spawnProcess,
          cancelKillMs,
          windowHandle,
          driverFor: () => 'twain32',
        });
    } else if (platform === 'darwin' && exists(helpers.scan)) {
      map.ica = helperBackend({
        command: helpers.scan,
        spawnProcess,
        cancelKillMs,
        windowHandle,
        driverFor: () => 'ica',
      });
    }
    // (escl.cjs itself, or something already shaped as a backend)
    if (escl) map.escl = escl.start ? escl : esclBackend(escl);
    return map;
  })();

  const distinct = () => [...new Set(Object.values(backends))];

  /** The backend and its own id for one of our device ids */
  function route(deviceId) {
    if (typeof deviceId !== 'string') return null;
    const at = deviceId.indexOf(':');
    if (at <= 0) return null;
    const driver = deviceId.slice(0, at);
    const backend = backends[driver];
    return backend ? { driver, backend, id: deviceId.slice(at + 1) } : null;
  }

  /** Every scanner, from every backend at once */
  async function list() {
    const all = distinct();
    if (!all.length)
      return { ok: true, scanners: [], drivers: [] };
    const results = await Promise.all(
      all.map((b) =>
        b.list().catch((err) => ({
          ok: false,
          error: 'failed',
          message: String(err?.message ?? err),
        }))
      )
    );
    const found = results.flatMap((r) => (r.ok ? r.found : []));
    const scanners = mergeScanners(found, order);
    const failed = results.filter((r) => !r.ok);
    // Some backend answered: what it found is the answer. Only when all of
    // them failed is the failure worth showing.
    if (!scanners.length && failed.length === results.length)
      return {
        ok: false,
        scanners: [],
        error: failed[0].error,
        message: failed[0].message,
      };
    return { ok: true, scanners };
  }

  /** What one device can do */
  async function capabilities(deviceId) {
    const r = route(deviceId);
    if (!r) return { ok: false, error: 'no-scanner' };
    const got = await r.backend.caps(r.id).catch((err) => ({
      ok: false,
      error: 'failed',
      message: String(err?.message ?? err),
    }));
    if (!got.ok) return { ok: false, error: got.error, message: got.message };
    const caps = cleanCaps(got.msg, r.driver);
    if (!caps.sources.length)
      return {
        ok: false,
        error: 'unsupported',
        message: "The scanner didn't say what it can do",
      };
    return { ok: true, caps };
  }

  /**
   * Runs a preview or a scan. Pages go to onPage(data, info) as they come;
   * onStatus(message) for what the scanner says meanwhile.
   */
  async function runJob(command, deviceId, options, onPage, onStatus) {
    if (current) return { ok: false, error: 'busy', message: 'Already scanning' };
    const r = route(deviceId);
    if (!r) return { ok: false, error: 'no-scanner' };
    let opts;
    try {
      opts = checkScanOptions(options);
    } catch (err) {
      return { ok: false, error: 'invalid', message: err.message };
    }
    // (busy before anything is awaited: a second call must find it so)
    const job = { cancelled: false, handle: null };
    current = job;
    let dir;
    try {
      dir = await fsp.mkdtemp(path.join(tempDir, 'paperwing-scan-'));
    } catch (err) {
      current = null;
      return { ok: false, error: 'failed', message: String(err?.message ?? err) };
    }
    let pages = 0;
    let ended = null;
    const delivering = [];
    const deliver = async (m) => {
      // Only files the backend wrote into our folder
      const file = path.resolve(dir, String(m.file));
      if (path.dirname(file) !== path.resolve(dir)) return;
      const data = await fsp.readFile(file);
      await fsp.rm(file, { force: true });
      pages++;
      onPage(new Uint8Array(data), {
        index: pages,
        dpi: isNum(m.dpi) && m.dpi > 0 ? m.dpi : opts.dpi,
        width: isNum(m.width) ? m.width : undefined,
        height: isNum(m.height) ? m.height : undefined,
        side: m.side === 'back' ? 'back' : 'front',
        mime: mimeOf(data),
      });
    };
    try {
      job.handle = r.backend.start(command, r.id, dir, opts, (m) => {
        if (m.type === 'page' && typeof m.file === 'string')
          delivering.push(deliver(m).catch(() => {}));
        else if (m.type === 'status' && typeof m.message === 'string')
          onStatus?.(m.message.slice(0, 300));
        else if (m.type === 'done' || m.type === 'error') ended = m;
      });
      if (job.cancelled) job.handle.cancel();
      const exit = await job.handle.done;
      await Promise.all(delivering);
      // The backend gave up on its own (a scanner gone silent)
      if (exit?.error && !job.cancelled)
        return { ok: false, error: exit.error, message: exit.message, pages };
      if (ended?.type === 'done')
        return {
          ok: true,
          pages,
          ...(ended.cancelled || job.cancelled ? { cancelled: true } : {}),
        };
      if (job.cancelled) return { ok: true, pages, cancelled: true };
      if (ended?.type === 'error') {
        // The feeder running out after some pages is how a feeder scan ends
        if (ended.code === 'feeder-empty' && pages) return { ok: true, pages };
        return {
          ok: false,
          error: ERRORS.includes(ended.code) ? ended.code : 'failed',
          message: typeof ended.message === 'string' ? ended.message : undefined,
          pages,
        };
      }
      return {
        ok: false,
        error: exit?.error ?? 'failed',
        message:
          exit?.message ?? (exit?.stderr || 'The scanner stopped unexpectedly'),
        pages,
      };
    } catch (err) {
      return { ok: false, error: 'failed', message: String(err?.message ?? err), pages };
    } finally {
      if (current === job) current = null;
      fs.rm(dir, { recursive: true, force: true }, () => {});
    }
  }

  /** A quick low-resolution scan of the whole glass: one page */
  async function preview(deviceId, options) {
    let page = null;
    const r = await runJob(
      'preview',
      deviceId,
      { ...options, dpi: Math.min(Math.max(options?.dpi ?? 50, 25), 150) },
      (data, info) => (page = { data, ...info })
    );
    if (r.ok && r.cancelled) return { ok: false, cancelled: true };
    if (r.ok && !page)
      return { ok: false, error: 'failed', message: 'The scanner sent no preview' };
    return r.ok ? { ok: true, page } : r;
  }

  const scan = (deviceId, options, onPage, onStatus) =>
    runJob('scan', deviceId, options, onPage, onStatus);

  /** Stops the scan after the page being scanned (it may still arrive) and
   *  lets the scanner go; a backend that doesn't stop is ended in 10 s */
  function cancel() {
    if (!current) return false;
    current.cancelled = true;
    current.handle?.cancel();
    return true;
  }

  /** A network scanner that doesn't announce itself, by its address */
  async function addByAddress(host) {
    const text = typeof host === 'string' ? host.trim() : '';
    // A host name, IPv4 or [IPv6], optionally with a port
    if (
      !text ||
      text.length > 255 ||
      !/^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d{1,5})?$/i.test(text)
    )
      return { ok: false, error: 'invalid', message: 'Not an address' };
    const backend = backends.escl;
    if (!backend?.add) return { ok: false, error: 'unsupported' };
    const r = await backend.add(text).catch((err) => ({
      ok: false,
      error: 'offline',
      message: String(err?.message ?? err),
    }));
    if (!r.ok) return { ok: false, error: r.error ?? 'offline', message: r.message };
    const [entry] = mergeScanners([{ driver: 'escl', scanner: r.scanner }], order);
    return entry ? { ok: true, scanner: entry } : { ok: false, error: 'failed' };
  }

  /** "Import from a scanner app": new files in `dir` go to onFile; null stops */
  async function watch(dir, onFile) {
    watcher?.close();
    watcher = null;
    if (!dir) return { ok: true };
    try {
      if (!(await fsp.stat(dir)).isDirectory()) throw new Error('not a folder');
    } catch (err) {
      return { ok: false, error: 'failed', message: String(err?.message ?? err) };
    }
    watcher = watchFolder(dir, (f) =>
      onFile({ name: f.name, path: f.path, data: f.data, mime: mimeOf(f.data) })
    );
    await watcher.ready;
    return { ok: true };
  }

  return {
    list,
    capabilities,
    preview,
    scan,
    cancel,
    addByAddress,
    watch,
    testMode,
    driverLabels: DRIVER_LABELS,
  };
}

module.exports = {
  createScanning,
  checkScanOptions,
  parseLine,
  cleanCaps,
  mergeScanners,
  helperBackend,
  esclBackend,
  watchFolder,
  DRIVER_ORDER,
  ERRORS,
};
