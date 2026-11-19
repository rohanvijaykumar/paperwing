/**
 * Scan diagnostics: a TEST BUILD for #55 (an HP Smart Tank 610 whose eSCL
 * feeder pages couldn't be decoded, and whose WIA feeder sent no pages).
 * This branch isn't merged.
 *
 * Every scan pass writes a folder under Documents\Paperwing scan
 * diagnostics (PAPERWING_SCAN_DIAGNOSTICS_DIR elsewhere, for the benches),
 * named by when it started, the 10 most recent kept:
 * - each page exactly as the driver sent it (page-1-raw.jpg…), and as fixed
 *   when the JPEG height fix changed it (page-1-fixed.jpg)
 * - scan-log.json: the version, the OS, the driver and device, the options
 *   asked for, what the driver said (eSCL: its capabilities, the
 *   ScanSettings sent, every HTTP request; WIA and TWAIN: every message and
 *   all of stderr), each page's size before and after the fix, errors, and
 *   how the pass ended.
 *
 * Nothing here may affect a scan: every failure is caught and ignored, and
 * the files are written in the background, one after another.
 */
const path = require('node:path');
const fsp = require('node:fs/promises');
const { jpegHeader, jpegSize } = require('./jpeg.cjs');

const NAME = /^\d{4}-\d{2}-\d{2} \d{6}( \(\d+\))?$/;
const pad = (n) => String(n).padStart(2, '0');
/** "2026-11-18 233005" (local time) */
const stamp = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

const extOf = (mime) =>
  ({
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/tiff': 'tif',
    'image/bmp': 'bmp',
    'application/pdf': 'pdf',
  })[mime] ?? 'bin';

const errorOf = (err) => ({
  message: String(err?.message ?? err),
  ...(err?.code ? { code: String(err.code) } : {}),
  ...(err?.stack ? { stack: String(err.stack) } : {}),
});

/** What a JPEG's header says (height 0 with a DNL: HP's feeders) */
function imageFacts(buf) {
  try {
    const head = jpegHeader(buf);
    if (!head) {
      const out = { jpeg: false, bytes: buf?.length ?? 0 };
      // PNG and BMP say their size near the start
      if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47)
        Object.assign(out, {
          width: buf.readUInt32BE(16),
          height: buf.readUInt32BE(20),
        });
      else if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d)
        Object.assign(out, {
          width: buf.readInt32LE(18),
          height: Math.abs(buf.readInt32LE(22)),
        });
      return out;
    }
    return {
      jpeg: true,
      bytes: buf.length,
      width: head.width,
      headerHeight: head.height,
      dnlFound: !!head.dnl,
      dnlLines: head.dnl?.lines ?? null,
      size: jpegSize(buf),
    };
  } catch (err) {
    return { bytes: buf?.length ?? 0, error: errorOf(err) };
  }
}

/** Does nothing: diagnostics that couldn't start */
const NONE = {
  dir: null,
  set() {},
  event() {},
  http() {},
  page() {},
  rawPage() {},
  error() {},
  finish: async () => null,
};

function createScanDiagnostics({
  root,
  about = {},
  keep = 10,
  now = () => new Date(),
}) {
  const used = new Set();

  /** Removes the oldest folders beyond `keep` (only ours, by their names) */
  async function prune(current) {
    const names = (await fsp.readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && NAME.test(e.name))
      .map((e) => e.name)
      .sort();
    const old = names.slice(0, Math.max(0, names.length - keep));
    for (const name of old)
      if (name !== current)
        await fsp
          .rm(path.join(root, name), { recursive: true, force: true })
          .catch(() => {});
  }

  /** A scan pass: meta is what's known at its start */
  function start(meta = {}) {
    try {
      if (!root) return NONE;
      const began = now();
      const t0 = Date.now();
      let name = stamp(began);
      for (let k = 2; used.has(name); k++) name = `${stamp(began)} (${k})`;
      used.add(name);
      const dir = path.join(root, name);
      const log = {
        build: 'test build for #55',
        ...about,
        startedAt: began.toISOString(),
        ...meta,
        events: [],
        http: [],
        pages: [],
        errors: [],
      };
      let writable = true;
      const elapsed = () => Date.now() - t0;
      // (one write after another, in the background)
      let chain = fsp
        .mkdir(dir, { recursive: true })
        .then(() => prune(name))
        .catch((err) => {
          writable = false;
          log.errors.push({ where: 'diagnostics folder', ...errorOf(err) });
        });
      const write = (file, data) => {
        chain = chain.then(() =>
          writable
            ? fsp.writeFile(path.join(dir, file), data).catch((err) => {
                log.errors.push({ where: `writing ${file}`, ...errorOf(err) });
              })
            : undefined
        );
      };
      const pageAt = (index) => {
        let p = log.pages.find((x) => x.index === index);
        if (!p) {
          p = { index };
          log.pages.push(p);
          log.pages.sort((a, b) => a.index - b.index);
        }
        return p;
      };
      const safe =
        (fn) =>
        (...args) => {
          try {
            fn(...args);
          } catch {
            /* never the scan's problem */
          }
        };
      return {
        dir,
        set: safe((key, value) => (log[key] = value)),
        /** What the driver or helper said, as it came */
        event: safe((kind, data) =>
          log.events.push({ t: elapsed(), kind, ...(data ?? {}) })
        ),
        http: safe((entry) => log.http.push({ t: elapsed(), ...entry })),
        /** A page as the driver sent it (before any fixing); eSCL reports
         *  its own, before escl.cjs fixes it */
        rawPage: safe((index, data, extra = {}) => {
          const p = pageAt(index);
          if (p.raw) return;
          const buf = Buffer.from(data);
          const mime = extra.mime ?? mimeOf(buf);
          const file = `page-${index}-raw.${extOf(mime)}`;
          p.raw = { file, mime, ...imageFacts(buf), ...extra };
          p.receivedAt = elapsed();
          write(file, buf);
        }),
        /** What happened to a page on its way to the dialog */
        page: safe((index, patch, fixedData) => {
          const p = pageAt(index);
          Object.assign(p, patch);
          if (fixedData) {
            const buf = Buffer.from(fixedData);
            const file = `page-${index}-fixed.jpg`;
            p.fixed = { file, ...imageFacts(buf) };
            write(file, buf);
          }
        }),
        error: safe((where, err) =>
          log.errors.push({ t: elapsed(), where, ...errorOf(err) })
        ),
        /** Writes scan-log.json; the folder, or null if nothing could be
         *  written */
        async finish(result) {
          try {
            log.result = result;
            log.endedAt = now().toISOString();
            log.durationMs = elapsed();
            log.pageCount = log.pages.length;
            write('scan-log.json', JSON.stringify(log, null, 2));
            await chain;
            return writable ? dir : null;
          } catch {
            return null;
          }
        },
      };
    } catch {
      return NONE;
    }
  }

  return { start, root };
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

module.exports = { createScanDiagnostics, imageFacts, NONE, stamp };
