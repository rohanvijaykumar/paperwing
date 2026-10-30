const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs/promises');
const path = require('node:path');

function printHtml(pages) {
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > 2000)
    throw new Error('Invalid print pages.');
  let bytes = 0;
  for (const p of pages) {
    if (
      !p ||
      typeof p.image !== 'string' ||
      !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(p.image) ||
      !Number.isFinite(p.width) ||
      !Number.isFinite(p.height) ||
      p.width <= 0 ||
      p.height <= 0 ||
      p.width > 14400 ||
      p.height > 14400
    )
      throw new Error('Invalid print page.');
    bytes += p.image.length;
  }
  if (bytes > 256 * 1024 * 1024)
    throw new Error(
      'Print job is too large. Please print a smaller page range.'
    );
  const sizes = pages
    .map((p, i) => `@page pw${i}{size:${p.width}pt ${p.height}pt;margin:0}`)
    .join('');
  const body = pages
    .map(
      (p, i) =>
        `<section style="page:pw${i};width:${p.width}pt;height:${p.height}pt"><img src="${p.image}"></section>`
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Paperwing Print</title><style>html,body{margin:0;padding:0}*{box-sizing:border-box}section{break-after:page;break-inside:avoid;overflow:hidden}section:last-child{break-after:auto}img{display:block;width:100%;height:100%}${sizes}</style></head><body>${body}</body></html>`;
}

async function createPrintWindow(pages, parent, preview = false) {
  let html = printHtml(pages);
  if (preview) html = previewHtml(html);
  const temp = await fs.mkdtemp(
    path.join(app.getPath('temp'), 'paperwing-print-')
  );
  const win = new BrowserWindow({
    width: 900,
    height: 800,
    show: false,
    ...(parent ? { parent } : {}),
    title: 'Paperwing Print',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      ...(preview
        ? { preload: path.join(__dirname, 'print-preview-preload.cjs') }
        : {}),
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.once('closed', () =>
    fs.rm(temp, { recursive: true, force: true }).catch(() => {})
  );
  try {
    const file = path.join(temp, 'pages.html');
    await fs.writeFile(file, html);
    await win.loadFile(file);
    await win.webContents.executeJavaScript(
      'Promise.all(Array.from(document.images, image => image.decode()))'
    );
    return win;
  } catch (error) {
    if (!win.isDestroyed()) win.destroy();
    throw error;
  }
}

function previewHtml(html) {
  const controls = `<form id="print-controls"><h1>Print preview</h1><label>Printer<select id="printer" required></select></label><div class="options"><label>Copies<input id="copies" type="number" min="1" max="999" value="1"></label><label>Color<select id="color"><option value="color">Color</option><option value="gray">Black and white</option></select></label><label>Sides<select id="duplex"><option value="simplex">One-sided</option><option value="longEdge">Two-sided · long edge</option><option value="shortEdge">Two-sided · short edge</option></select></label></div><p id="status" role="status">Loading installed printers…</p><div class="buttons"><button id="advanced" type="button" title="Opens Windows' printer dialog, which may also show discovered network printers">More settings…</button><button id="cancel" type="button">Cancel</button><button id="print" type="submit" disabled>Print</button></div></form>`;
  const css = `<style>@media screen{body{background:#e5e7eb;font:14px 'Segoe UI',sans-serif}#print-controls{position:sticky;top:0;z-index:1;background:#fff;color:#222;padding:16px 24px;box-shadow:0 2px 8px #0003}h1{font-size:18px;margin:0 0 12px}label{display:flex;flex-direction:column;gap:5px}select,input,button{font:inherit;padding:7px;border:1px solid #bbb;border-radius:5px}#printer{width:100%}.options{display:flex;gap:16px;margin-top:10px}.options label{flex:1;min-width:0}input{width:80px}#status{font-size:13px;min-height:18px}.buttons{display:flex;gap:8px;justify-content:flex-end}#advanced{margin-right:auto}button{cursor:pointer;background:#f5f5f5}#print{background:#3b63fb;color:white;border-color:#3b63fb}button:disabled{opacity:.5;cursor:wait}section{margin:24px auto;max-width:calc(100vw - 48px);height:auto!important;box-shadow:0 2px 9px #0004}section img{height:auto}}@media print{#print-controls{display:none!important}}</style>`;
  return html
    .replace(
      '</head>',
      css +
        '<style>@media screen and (prefers-color-scheme:dark){body{background:#202124}#print-controls{background:#292a2d;color:#eee}select,input,button{background:#35363a;color:#eee;border-color:#666}#print{background:#3b63fb;border-color:#3b63fb}}</style></head>'
    )
    .replace(
      '<body>',
      '<body>' +
        controls.replace(
          '<button id="advanced"',
          '<button id="save-pdf" type="button">Save as PDF…</button><button id="advanced"'
        )
    )
    .replace(
      '</body>',
      `<script src="${pathToFileURL(path.join(__dirname, 'print-preview.js')).href}"></script></body>`
    );
}

function validateOptions(options, printers) {
  if (
    !options ||
    (!options.savePdf && !printers.some((p) => p.name === options.printer)) ||
    !Number.isInteger(options.copies) ||
    options.copies < 1 ||
    options.copies > 999 ||
    typeof options.color !== 'boolean' ||
    typeof options.advanced !== 'boolean' ||
    (options.savePdf !== undefined && typeof options.savePdf !== 'boolean') ||
    !['simplex', 'longEdge', 'shortEdge'].includes(options.duplex)
  )
    throw new Error('Invalid print settings.');
  return {
    silent: !options.advanced,
    deviceName: options.printer,
    copies: options.copies,
    color: options.color,
    duplexMode: options.duplex,
    printBackground: true,
    margins: { marginType: 'none' },
  };
}

/** Use only printers reported by the OS. A stale saved choice must not
 * override the current system default or introduce a missing printer. */
function choosePrinter(printers, saved) {
  return (
    printers.find((p) => p.name === saved)?.name ||
    printers.find((p) => p.isDefault)?.name ||
    printers[0]?.name ||
    ''
  );
}

let busy = false;
async function printPages(pages, parent) {
  if (busy) throw new Error('A print job is already open.');
  busy = true;
  let win;
  try {
    win = await createPrintWindow(pages, parent, true);
    const printers = await win.webContents.getPrintersAsync();
    let saved;
    const prefsFile = path.join(
      app.getPath('userData'),
      'print-preferences.json'
    );
    try {
      saved = JSON.parse(await fs.readFile(prefsFile, 'utf8')).printer;
    } catch {}
    const selected = choosePrinter(printers, saved);
    return await new Promise((resolve) => {
      let submitting = false;
      const guard = (event) => {
        if (event.sender !== win.webContents)
          throw new Error('Invalid print preview sender.');
      };
      ipcMain.handle('paperwing:preview-cancel', (event) => {
        guard(event);
        if (!submitting) resolve({ success: false, reason: 'Print canceled' });
      });
      ipcMain.handle('paperwing:preview-submit', async (event, options) => {
        guard(event);
        if (submitting) throw new Error('A print job is already being sent.');
        const settings = validateOptions(options, printers);
        submitting = true;
        try {
          let result;
          if (options.savePdf) {
            const target = await dialog.showSaveDialog(win, {
              title: 'Save printed PDF',
              defaultPath: 'Printed document.pdf',
              filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
            });
            if (target.canceled || !target.filePath)
              return { success: false, reason: 'Save canceled' };
            const pdf = await win.webContents.printToPDF({
              printBackground: true,
              preferCSSPageSize: true,
              margins: { top: 0, bottom: 0, left: 0, right: 0 },
            });
            await fs.writeFile(target.filePath, pdf);
            result = { success: true };
          } else
            result = await new Promise((done) =>
              win.webContents.print(settings, (success, reason) =>
                done({ success, reason })
              )
            );
          if (result.success) {
            await fs
              .writeFile(
                prefsFile,
                JSON.stringify({ printer: options.printer })
              )
              .catch(() => {});
            resolve(result);
          }
          return result;
        } finally {
          submitting = false;
        }
      });
      win.once('closed', () =>
        resolve({ success: false, reason: 'Print canceled' })
      );
      win.webContents.send('paperwing:preview-ready', {
        printers: printers.map((p) => ({
          name: p.name,
          displayName: p.displayName,
        })),
        selected,
        pages: pages.length,
      });
      win.show();
    });
  } finally {
    for (const channel of [
      'paperwing:preview-settings',
      'paperwing:preview-submit',
      'paperwing:preview-cancel',
    ])
      ipcMain.removeHandler(channel);
    if (win && !win.isDestroyed()) win.destroy();
    busy = false;
  }
}

module.exports = {
  printPages,
  createPrintWindow,
  printHtml,
  previewHtml,
  validateOptions,
  choosePrinter,
};
