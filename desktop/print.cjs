/**
 * Printing for the desktop app (Windows, macOS and Linux alike).
 *
 * The viewer's own print (a hidden frame calling print()) reports success in
 * Electron without printing anything. Instead the page sends the document its
 * print dialog prepared (page range and annotations applied) here, where it
 * is opened in a hidden window by Chromium's PDF viewer and printed from
 * there: the real PDF goes to the printer, so text stays text.
 *
 * Tools that make a document from a web page (Markdown to PDF) have it made
 * into a PDF here too (htmlToPdf), by the same print engine, instead of
 * calling print(), whose dialog can't preview in Electron.
 *
 * Electron's dependencies are passed in, so tests can stand in for them.
 */
const path = require('node:path');
const os = require('node:os');
const fsp = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');

const DUPLEX_MODES = ['simplex', 'longEdge', 'shortEdge'];
const MAX_COPIES = 99;
/** How long the PDF viewer may take to open the document */
const LOAD_TIMEOUT_MS = 60000;
/** Pages made into a PDF (htmlToPdf) are shown on their own session, by a
 *  scheme of their own: nothing else is served there, and a page on it can't
 *  load the computer's files (file: URLs) */
const HTML_PARTITION = 'paperwing-html-to-pdf';
const HTML_SCHEME = 'paperwing-pdf';
const MAX_HTML_CHARS = 64 * 1024 * 1024;

/** The printer to preselect: the last one printed to, if it's still
 *  there, else the system default (else the first one) */
function pickPrinter(printers, remembered) {
  if (remembered && printers.some((p) => p.name === remembered))
    return remembered;
  return (printers.find((p) => p.isDefault) ?? printers[0])?.name ?? null;
}

/** The page's print options, checked; throws on anything unexpected */
function checkOptions(options) {
  if (!options || typeof options !== 'object')
    throw new TypeError('Missing print options');
  const { printer, copies = 1, color = true, duplex = 'simplex' } = options;
  if (typeof printer !== 'string' || !printer)
    throw new TypeError('No printer chosen');
  if (!Number.isInteger(copies) || copies < 1 || copies > MAX_COPIES)
    throw new TypeError(`Copies must be 1 to ${MAX_COPIES}`);
  if (typeof color !== 'boolean') throw new TypeError('Invalid color option');
  if (!DUPLEX_MODES.includes(duplex))
    throw new TypeError('Invalid two-sided option');
  return { printer, copies, color, duplex };
}

const isPdf = (data) =>
  data instanceof Uint8Array &&
  data.length > 5 &&
  Buffer.from(data.subarray(0, 1024)).includes('%PDF-');

/** Resolves once Chromium's PDF viewer in `wc` has opened the document
 *  (printing earlier prints a blank page); rejects if it can't */
async function pdfLoaded(wc, timeout = LOAD_TIMEOUT_MS) {
  const probe = `(() => {
    const v = document.querySelector('pdf-viewer');
    return v ? { state: v.loadState_ ?? null, pages: v.docLength_ ?? 0 } : null;
  })()`;
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const viewer = wc.mainFrame.framesInSubtree.find((f) =>
      f.url.startsWith('chrome-extension://')
    );
    const s = viewer
      ? await viewer.executeJavaScript(probe).catch(() => null)
      : null;
    if (s?.state === 'failed') throw new Error("The document couldn't be read");
    if (s?.state === 'success' || (s && s.state == null && s.pages > 0)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Timed out preparing the document');
}

function createPrinting({
  BrowserWindow,
  dialog,
  session,
  /** JSON file for the last printer used */
  settingsFile,
  /** Where Save as PDF suggests saving */
  documentsDir,
  writeFile = (file, data) => fsp.writeFile(file, data),
  tempDir = os.tmpdir(),
  waitForPdf = pdfLoaded,
}) {
  let busy = false;

  async function remembered() {
    try {
      const { printer } = JSON.parse(await fsp.readFile(settingsFile, 'utf8'));
      return typeof printer === 'string' ? printer : null;
    } catch {
      return null;
    }
  }

  async function remember(printer) {
    try {
      await fsp.writeFile(settingsFile, JSON.stringify({ printer }));
    } catch {
      /* read-only profile: the default is preselected next time */
    }
  }

  /** The printers to choose from, and the one to preselect */
  async function printers(wc) {
    const list = (await wc.getPrintersAsync()).map((p) => ({
      name: p.name,
      displayName: p.displayName || p.name,
      isDefault: !!p.isDefault,
    }));
    return { printers: list, selected: pickPrinter(list, await remembered()) };
  }

  async function printPdf(wc, data, options) {
    const opts = checkOptions(options);
    const available = await wc.getPrintersAsync();
    if (!available.length)
      return { ok: false, error: 'no-printers', message: 'No printers found' };
    if (!available.some((p) => p.name === opts.printer))
      return {
        ok: false,
        error: 'printer-missing',
        message: `${opts.printer} is no longer available`,
      };
    const dir = await fsp.mkdtemp(path.join(tempDir, 'paperwing-print-'));
    const file = path.join(dir, 'document.pdf');
    let win = null;
    try {
      await fsp.writeFile(file, data);
      win = new BrowserWindow({
        show: false,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      win.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', (e) => e.preventDefault());
      await win.loadURL(pathToFileURL(file).toString());
      await waitForPdf(win.webContents);
      const [ok, reason] = await new Promise((resolve) =>
        win.webContents.print(
          {
            silent: true,
            deviceName: opts.printer,
            copies: opts.copies,
            color: opts.color,
            duplexMode: opts.duplex,
            printBackground: true,
          },
          (success, failureReason) => resolve([success, failureReason])
        )
      );
      if (!ok)
        return {
          ok: false,
          error: 'failed',
          message: reason || 'Printing failed',
        };
      await remember(opts.printer);
      return { ok: true };
    } finally {
      if (win && !win.isDestroyed()) win.destroy();
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function savePdf(parent, data, name) {
    const base =
      typeof name === 'string' && name.trim()
        ? path.basename(name.trim())
        : 'Document.pdf';
    const { canceled, filePath } = await dialog.showSaveDialog(parent, {
      defaultPath: path.join(
        documentsDir,
        /\.pdf$/i.test(base) ? base : `${base}.pdf`
      ),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return { ok: false, cancelled: true };
    await writeFile(filePath, data);
    return { ok: true, path: filePath };
  }

  /**
   * One job at a time. request: { destination: 'printer', printer, copies,
   * color, duplex } or { destination: 'pdf', name }.
   */
  async function run(wc, parent, data, request) {
    if (busy) return { ok: false, error: 'busy', message: 'Already printing' };
    busy = true;
    try {
      if (!isPdf(data)) throw new TypeError('Not a PDF document');
      if (request?.destination === 'pdf')
        return await savePdf(parent, data, request.name);
      if (request?.destination !== 'printer')
        throw new TypeError('Unknown print destination');
      return await printPdf(wc, data, request);
    } catch (err) {
      return {
        ok: false,
        error: err instanceof TypeError ? 'invalid' : 'failed',
        message: String(err?.message ?? err),
      };
    } finally {
      busy = false;
    }
  }

  /** Pages being made into PDFs, by URL */
  const pages = new Map();
  let htmlSession = null;
  function sessionForHtml() {
    if (htmlSession) return htmlSession;
    const ses = session.fromPartition(HTML_PARTITION, { cache: false });
    ses.protocol.handle(HTML_SCHEME, (request) => {
      const html = pages.get(request.url);
      return html === undefined
        ? new Response('', { status: 404 })
        : new Response(html, {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
    });
    ses.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: /^(file|app):/i.test(details.url) })
    );
    ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
    htmlSession = ses;
    return ses;
  }

  /**
   * A web page (a complete HTML document, styled for print) as a PDF, laid
   * out by Chromium's print engine: text stays text. Scripts don't run.
   */
  async function htmlToPdf(html) {
    try {
      if (typeof html !== 'string' || !html.trim())
        throw new TypeError('Not an HTML document');
      if (html.length > MAX_HTML_CHARS)
        throw new TypeError('The document is too large');
      const url = `${HTML_SCHEME}://page/${randomUUID()}.html`;
      pages.set(url, html);
      let win = null;
      try {
        win = new BrowserWindow({
          show: false,
          webPreferences: {
            session: sessionForHtml(),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            javascript: false,
          },
        });
        win.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
        win.webContents.on('will-navigate', (e) => e.preventDefault());
        await win.loadURL(url);
        const data = await win.webContents.printToPDF({
          printBackground: true,
          preferCSSPageSize: true,
        });
        return { ok: true, data: new Uint8Array(data) };
      } finally {
        pages.delete(url);
        if (win && !win.isDestroyed()) win.destroy();
      }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof TypeError ? 'invalid' : 'failed',
        message: String(err?.message ?? err),
      };
    }
  }

  return { printers, run, htmlToPdf };
}

module.exports = { createPrinting, pickPrinter, checkOptions, pdfLoaded };
