/**
 * Printing in the main process (print.cjs), with stand-ins for Electron's
 * windows and dialogs: nothing is ever sent to a real printer.
 *
 *   npm run test:print
 */
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPrinting, pickPrinter, pdfLoaded } = require('../print.cjs');

const PDF = new Uint8Array(Buffer.from('%PDF-1.7\n%test document\n%%EOF\n'));
const OFFICE = { name: 'office', displayName: 'Office laser', isDefault: true };
const LABEL = { name: 'label', displayName: 'Label printer', isDefault: false };

let dir;
let printers;
let windows;
let printResult;
let saveDialog;
let written;

/** Stand-in for a BrowserWindow: records what it loads and prints */
class FakeWindow {
  constructor(options) {
    this.options = options;
    this.destroyed = false;
    const win = this;
    this.webContents = {
      prints: [],
      on() {},
      setWindowOpenHandler() {},
      print(opts, done) {
        // What the window shows when it prints
        this.printed = readFileSync(fileURLToPath(win.url));
        this.prints.push(opts);
        const { ok, reason, delay = 0 } = printResult;
        setTimeout(() => done(ok, reason), delay);
      },
    };
    windows.push(this);
  }
  async loadURL(url) {
    this.url = url;
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
  }
}

const sender = { getPrintersAsync: async () => printers };
const prints = () => windows.flatMap((w) => w.webContents.prints);

function service() {
  return createPrinting({
    BrowserWindow: FakeWindow,
    dialog: { showSaveDialog: async (...args) => saveDialog(...args) },
    settingsFile: join(dir, 'print-settings.json'),
    documentsDir: join(dir, 'Documents'),
    writeFile: async (file, data) => written.push({ file, data }),
    tempDir: dir,
    waitForPdf: async () => {},
  });
}

const toPrinter = (printer, extra = {}) => ({
  destination: 'printer',
  printer,
  copies: 1,
  color: true,
  duplex: 'simplex',
  ...extra,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'paperwing-print-test-'));
  printers = [LABEL, OFFICE];
  windows = [];
  printResult = { ok: true };
  saveDialog = async () => ({ canceled: true });
  written = [];
});

describe('choosing the printer', () => {
  test('preselects the OS default printer', async () => {
    const { selected, printers: list } = await service().printers(sender);
    assert.equal(selected, 'office');
    assert.deepEqual(
      list.map((p) => p.displayName),
      ['Label printer', 'Office laser']
    );
  });

  test('remembers the last printer that printed', async () => {
    const p = service();
    assert.deepEqual(await p.run(sender, null, PDF, toPrinter('label')), {
      ok: true,
    });
    assert.equal((await p.printers(sender)).selected, 'label');
    // Also after a restart
    assert.equal((await service().printers(sender)).selected, 'label');
  });

  test('a failed print is not remembered', async () => {
    printResult = { ok: false, reason: 'Printer offline' };
    const result = await service().run(sender, null, PDF, toPrinter('label'));
    assert.equal(result.ok, false);
    assert.equal(result.error, 'failed');
    assert.match(result.message, /offline/);
    assert.equal((await service().printers(sender)).selected, 'office');
  });

  test('a remembered printer that is gone falls back to the default', async () => {
    await service().run(sender, null, PDF, toPrinter('label'));
    printers = [OFFICE];
    assert.equal((await service().printers(sender)).selected, 'office');
  });

  test('without a default, the first printer', () => {
    assert.equal(
      pickPrinter([{ ...LABEL }, { ...OFFICE, isDefault: false }]),
      'label'
    );
    assert.equal(pickPrinter([], 'label'), null);
  });

  test('a printer that is missing now is not printed to', async () => {
    const result = await service().run(sender, null, PDF, toPrinter('gone'));
    assert.equal(result.ok, false);
    assert.equal(result.error, 'printer-missing');
    assert.equal(windows.length, 0);
    assert.equal(prints().length, 0);
  });

  test('no printers: none listed, nothing printed', async () => {
    printers = [];
    assert.deepEqual(await service().printers(sender), {
      printers: [],
      selected: null,
    });
    const result = await service().run(sender, null, PDF, toPrinter('office'));
    assert.equal(result.error, 'no-printers');
    assert.equal(prints().length, 0);
  });
});

describe('printing', () => {
  test('prints the PDF itself, silently, with the chosen options', async () => {
    const result = await service().run(
      sender,
      null,
      PDF,
      toPrinter('office', { copies: 3, color: false, duplex: 'longEdge' })
    );
    assert.deepEqual(result, { ok: true });
    assert.equal(windows.length, 1);
    const [win] = windows;
    assert.equal(win.options.show, false);
    assert.equal(win.options.webPreferences.sandbox, true);
    assert.match(win.url, /^file:.*\.pdf$/);
    assert.deepEqual(new Uint8Array(win.webContents.printed), PDF);
    assert.deepEqual(win.webContents.prints, [
      {
        silent: true,
        deviceName: 'office',
        copies: 3,
        color: false,
        duplexMode: 'longEdge',
        printBackground: true,
      },
    ]);
    // Nothing left behind
    assert.ok(win.destroyed);
    assert.ok(!existsSync(fileURLToPath(win.url)));
    assert.deepEqual(
      readdirSync(dir).filter((f) => f.startsWith('paperwing-print-')),
      []
    );
  });

  test('rejects invalid options without printing', async () => {
    const p = service();
    for (const bad of [
      toPrinter('office', { copies: 0 }),
      toPrinter('office', { copies: 1.5 }),
      toPrinter('office', { copies: 100 }),
      toPrinter('office', { copies: '2' }),
      toPrinter('office', { color: 'yes' }),
      toPrinter('office', { duplex: 'both' }),
      toPrinter(''),
      toPrinter(42),
      { destination: 'fax' },
      null,
    ]) {
      const result = await p.run(sender, null, PDF, bad);
      assert.equal(result.ok, false, JSON.stringify(bad));
      assert.equal(result.error, 'invalid', JSON.stringify(bad));
    }
    const notPdf = await p.run(
      sender,
      null,
      new TextEncoder().encode('<html>'),
      toPrinter('office')
    );
    assert.equal(notPdf.error, 'invalid');
    assert.equal(prints().length, 0);
    assert.equal(written.length, 0);
  });

  test('one job at a time', async () => {
    const p = service();
    printResult = { ok: true, delay: 50 };
    const first = p.run(sender, null, PDF, toPrinter('office'));
    const second = await p.run(sender, null, PDF, toPrinter('office'));
    assert.equal(second.error, 'busy');
    const saving = await p.run(sender, null, PDF, { destination: 'pdf' });
    assert.equal(saving.error, 'busy');
    assert.deepEqual(await first, { ok: true });
    assert.deepEqual(await p.run(sender, null, PDF, toPrinter('office')), {
      ok: true,
    });
    assert.equal(prints().length, 2);
  });
});

describe('Save as PDF', () => {
  test('saves the document without printing', async () => {
    let asked;
    saveDialog = async (parent, options) => {
      asked = { parent, options };
      return { canceled: false, filePath: join(dir, 'Out.pdf') };
    };
    const parent = { id: 'main window' };
    const result = await service().run(sender, parent, PDF, {
      destination: 'pdf',
      name: 'Report.pdf',
    });
    assert.deepEqual(result, { ok: true, path: join(dir, 'Out.pdf') });
    assert.equal(asked.parent, parent);
    assert.equal(
      asked.options.defaultPath,
      join(dir, 'Documents', 'Report.pdf')
    );
    assert.deepEqual(written, [{ file: join(dir, 'Out.pdf'), data: PDF }]);
    assert.equal(windows.length, 0);
    assert.equal(prints().length, 0);
    // Not a printer choice
    assert.equal((await service().printers(sender)).selected, 'office');
  });

  test('cancel: nothing saved, nothing printed', async () => {
    const result = await service().run(sender, null, PDF, {
      destination: 'pdf',
      name: 'Report.pdf',
    });
    assert.deepEqual(result, { ok: false, cancelled: true });
    assert.equal(written.length, 0);
    assert.equal(prints().length, 0);
  });
});

describe('waiting for the PDF viewer', () => {
  /** webContents whose PDF viewer frame reports these states in turn */
  const contents = (states) => ({
    mainFrame: {
      get framesInSubtree() {
        return [
          { url: 'file:///tmp/doc.pdf' },
          {
            url: 'chrome-extension://viewer/index.html',
            executeJavaScript: async () =>
              states.length ? states.shift() : states.last,
          },
        ];
      },
    },
  });

  test('resolves once the document has loaded', async () => {
    const states = [null, { state: 'loading', pages: 0 }];
    states.last = { state: 'success', pages: 3 };
    await pdfLoaded(contents(states), 2000);
  });

  test('rejects a document the viewer could not read', async () => {
    const states = [{ state: 'loading' }];
    states.last = { state: 'failed', pages: 0 };
    await assert.rejects(pdfLoaded(contents(states), 2000), /couldn't be read/);
  });

  test('gives up after the timeout', async () => {
    const states = [];
    states.last = { state: 'loading', pages: 0 };
    await assert.rejects(pdfLoaded(contents(states), 200), /Timed out/);
  });
});
