/** Run with Electron: electron tests/printing.test.cjs.
 * All windows stay hidden and printer submissions are intercepted. */
const { app, BrowserWindow, dialog } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument } = require('pdf-lib');
const {
  printPages,
  choosePrinter,
  validateOptions,
} = require('../print-pages.cjs');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'paperwing-print-test-'));
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
BrowserWindow.prototype.show = function () {};
const printers = [
  { name: 'test-queue-α', displayName: 'Test printer α', isDefault: false },
  { name: 'default-queue', displayName: 'System default', isDefault: true },
  { name: 'another-queue', displayName: 'Another printer', isDefault: false },
];
let sent,
  jobCount = 0;
app.on('browser-window-created', (_event, win) => {
  win.webContents.getPrintersAsync = async () => printers;
  win.webContents.print = (options, callback) => {
    sent = options;
    jobCount++;
    callback(true);
  };
});
const image =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
const pages = [{ image, width: 612, height: 792 }];
const options = {
  printer: printers[0].name,
  copies: 2,
  color: false,
  duplex: 'longEdge',
  advanced: false,
  savePdf: false,
};
async function preview() {
  for (let i = 0; i < 100; i++) {
    const win = BrowserWindow.getAllWindows().find(
      (w) => w.getTitle() === 'Paperwing Print'
    );
    if (win) {
      let settings;
      try {
        settings = await win.webContents.executeJavaScript(
          'Promise.race([window.printPreview.settings(),new Promise(resolve=>setTimeout(()=>resolve(null),50))])'
        );
      } catch {}
      if (settings) return { win, settings };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Print preview did not become ready');
}
app.whenReady().then(async () => {
  let failed = false;
  try {
    assert.equal(choosePrinter(printers), printers[1].name);
    assert.equal(choosePrinter(printers, printers[0].name), printers[0].name);
    assert.equal(choosePrinter(printers, 'removed-printer'), printers[1].name);
    assert.equal(choosePrinter([]), '');
    assert.equal(choosePrinter([{ name: 'only-printer' }]), 'only-printer');
    assert.throws(() =>
      validateOptions({ ...options, printer: 'not-installed' }, printers)
    );
    assert.equal(
      validateOptions({ ...options, advanced: true }, printers).silent,
      false
    );
    const job = printPages(pages);
    let { win, settings } = await preview();
    assert.equal(settings.selected, printers[1].name);
    assert.deepEqual(
      settings.printers.map((p) => p.name),
      printers.map((p) => p.name)
    );
    assert.deepEqual(
      await win.webContents.executeJavaScript(
        'Array.from(document.querySelector("#printer").options,o=>o.value)'
      ),
      printers.map((p) => p.name)
    );
    const rendered = await win.webContents.printToPDF({
      preferCSSPageSize: true,
      printBackground: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });
    assert.equal(
      (await PDFDocument.load(rendered)).getPageCount(),
      1,
      'controls must not add printed pages'
    );
    win.webContents
      .executeJavaScript(
        `window.printPreview.submit(${JSON.stringify(options)})`
      )
      .catch(() => {});
    assert.equal((await job).success, true);
    assert.deepEqual(sent, {
      silent: true,
      deviceName: printers[0].name,
      copies: 2,
      color: false,
      duplexMode: 'longEdge',
      printBackground: true,
      margins: { marginType: 'none' },
    });
    const canceled = printPages(pages);
    ({ win, settings } = await preview());
    assert.equal(
      settings.selected,
      printers[0].name,
      'last successful selection is restored'
    );
    win.webContents
      .executeJavaScript('window.printPreview.cancel()')
      .catch(() => {});
    assert.match((await canceled).reason, /cancel/i);
    printers.length = 0;
    const noPrinters = printPages(pages);
    ({ win, settings } = await preview());
    assert.equal(settings.printers.length, 0);
    assert.equal(
      await win.webContents.executeJavaScript(
        'document.querySelector("#print").disabled'
      ),
      true
    );
    const pdfPath = path.join(profile, 'saved.pdf');
    dialog.showSaveDialog = async () => ({
      canceled: false,
      filePath: pdfPath,
    });
    win.webContents
      .executeJavaScript(
        `window.printPreview.submit(${JSON.stringify({ ...options, printer: '', savePdf: true })})`
      )
      .catch(() => {});
    assert.equal((await noPrinters).success, true);
    assert.equal(
      (await PDFDocument.load(fs.readFileSync(pdfPath))).getPageCount(),
      1
    );
    assert.equal(jobCount, 1, 'PDF export must not submit a printer job');
    console.log(
      'PASS: OS default, dynamic queues, missing queue, options, preview, remembered choice, cancel, no printers, and PDF export. No physical jobs sent.'
    );
  } catch (error) {
    failed = true;
    console.error(error);
  } finally {
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
    // Chromium may retain its profile lock until app.exit on Windows.
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    app.exit(failed ? 1 : 0);
  }
});
