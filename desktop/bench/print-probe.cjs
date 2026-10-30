/**
 * Run by check-print.mjs in real Electron (not stand-ins): the parts of
 * printing that depend on Electron and Chromium themselves. Prints nothing.
 * Writes one JSON line: { checks: [{ ok, what, detail }] }.
 */
const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  createPrinting,
  pdfLoaded,
  systemDefaultPrinter,
} = require('../print.cjs');

// electron print-probe.cjs <userData> <pdf…>
const [userData, ...pdfs] = process.argv.slice(2);
app.setPath('userData', userData);
// The probe's windows come and go; the app stays until it reports
app.on('window-all-closed', () => {});

const checks = [];
const check = (ok, what, detail = '') =>
  checks.push({ ok: !!ok, what, detail });

app.whenReady().then(async () => {
  try {
    // 1. Chromium's PDF viewer says when a document has loaded (print.cjs
    //    reads its private state: an Electron update could change it)
    for (const file of pdfs) {
      const win = new BrowserWindow({
        show: false,
        webPreferences: { sandbox: true, contextIsolation: true },
      });
      const t0 = Date.now();
      try {
        await win.loadURL(pathToFileURL(file).toString());
        await pdfLoaded(win.webContents, 20000);
        check(
          true,
          `the PDF viewer reports ${path.basename(file)} loaded`,
          `${Date.now() - t0} ms`
        );
      } catch (err) {
        check(
          false,
          `the PDF viewer reports ${path.basename(file)} loaded`,
          err.message
        );
      }
      win.destroy();
    }

    // 2. The OS default printer is found among Electron's printers
    const probe = new BrowserWindow({ show: false });
    const printers = await probe.webContents.getPrintersAsync();
    const system = await systemDefaultPrinter();
    if (!printers.length)
      check(true, 'default printer (no printers installed: skipped)');
    else
      check(
        system && printers.some((p) => p.name === system),
        'the OS default printer is one Electron lists',
        `${system} of ${printers.map((p) => p.name).join(', ')}`
      );
    const printing = createPrinting({
      BrowserWindow,
      dialog: null,
      session,
      settingsFile: path.join(userData, 'print-settings.json'),
      documentsDir: userData,
      tempDir: userData,
    });
    const { selected } = await printing.printers(probe.webContents);
    check(
      !printers.length || selected === system,
      'the dialog preselects the OS default printer',
      String(selected)
    );
    probe.destroy();

    // 3. A web page made into a PDF, with nothing loaded from the network
    const html =
      '<!DOCTYPE html><html><head><title>t</title></head><body><h1>Quarterly notes</h1>' +
      '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">' +
      '<iframe src="http://127.0.0.1:9/"></iframe></body></html>';
    const t0 = Date.now();
    const made = await printing.htmlToPdf(html);
    const isPdf =
      made.ok &&
      Buffer.from(made.data.subarray(0, 8)).toString().startsWith('%PDF-');
    check(
      isPdf,
      'a web page becomes a PDF',
      made.ok
        ? `${made.data.length} bytes, ${Date.now() - t0} ms`
        : made.message
    );
  } catch (err) {
    check(false, 'probe', String(err?.stack ?? err));
  }
  process.stdout.write(`${JSON.stringify({ checks })}\n`);
  app.exit(0);
});
