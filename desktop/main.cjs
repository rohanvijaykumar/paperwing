/**
 * Paperwing — Electron main process.
 *
 * Serves the BentoPDF-based web app from the app:// protocol (so it runs fully
 * offline with the cross-origin isolation headers its WebAssembly needs), opens
 * PDFs passed by the OS, and gives the renderer a small file bridge.
 */
const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  nativeTheme,
  net,
  protocol,
  session,
  shell,
} = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const crypto = require('node:crypto');

/** PAPERWING_TRACE=1 prints startup timings (ms since the process started) */
const trace = process.env.PAPERWING_TRACE
  ? (what) =>
      console.log(`[paperwing] ${Math.round(performance.now())} ms  ${what}`)
  : () => {};

const pkg = require('./package.json');

const SCHEME = 'app';
/** The workspace page (app.html), the only page given the file bridge */
const HOST = 'paperwing';
const ORIGIN = `${SCHEME}://${HOST}`;
/**
 * BentoPDF's tool pages, on an origin of their own so the same-origin policy
 * keeps them away from the workspace page and its bridge. The two talk only
 * via postMessage. (Keep in sync with src/reskin/origins.ts.)
 */
const TOOLS_HOST = 'tools';
const IS_MAC = process.platform === 'darwin';

/* ------------------------------------------------------------------ */
/* Portable mode: keep settings next to the executable                 */
/* ------------------------------------------------------------------ */

function portableDataDir() {
  const appDir = path.dirname(process.execPath);
  const beside = path.join(appDir, 'Paperwing Data');
  // An existing "Paperwing Data" folder always wins
  if (fs.existsSync(beside)) return beside;
  // The Windows zip is the portable build: anything that wasn't put there
  // by the installer (which leaves an uninstaller beside the exe) keeps its
  // settings next to itself, if that folder is writable
  if (process.platform !== 'win32') return null;
  if (fs.existsSync(path.join(appDir, `Uninstall ${app.getName()}.exe`)))
    return null;
  try {
    fs.mkdirSync(beside, { recursive: true });
    return beside;
  } catch {
    return null;
  }
}

const portableDir = app.isPackaged ? portableDataDir() : null;
if (portableDir) app.setPath('userData', portableDir);
// Development and benchmarks: a throwaway profile instead of the real one
if (!app.isPackaged && process.env.PAPERWING_USER_DATA)
  app.setPath('userData', process.env.PAPERWING_USER_DATA);

/* ------------------------------------------------------------------ */
/* Single instance + files opened from the OS                          */
/* ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

let mainWindow = null;
let rendererReady = false;
/** Set once the renderer has dealt with unsaved documents */
let allowClose = false;
/** macOS: Cmd+Q is in progress, so quit once the window has closed */
let quitting = false;
const pendingFiles = [];
const pendingCommands = [];
/**
 * Files the user opened or saved through Paperwing. The renderer may only
 * write back to these, never to an arbitrary path.
 */
const knownPaths = new Set();
const pathKey = (p) => (IS_MAC ? p : path.resolve(p).toLowerCase());

const isPdfPath = (p) =>
  typeof p === 'string' && /\.pdf$/i.test(p) && fs.existsSync(p);

function pdfArgs(argv) {
  return argv.slice(app.isPackaged ? 1 : 2).filter(isPdfPath);
}

async function sendFile(filePath) {
  if (!mainWindow || !rendererReady) {
    pendingFiles.push(filePath);
    // macOS: a file opened while the app runs with no window
    if (!mainWindow && app.isReady()) createWindow();
    return;
  }
  try {
    const data = await fsp.readFile(filePath);
    knownPaths.add(pathKey(filePath));
    mainWindow.webContents.send('paperwing:open-file', {
      path: filePath,
      name: path.basename(filePath),
      data,
    });
  } catch (err) {
    dialog.showErrorBox('Could not open file', `${filePath}\n\n${err.message}`);
  }
}

pendingFiles.push(...pdfArgs(process.argv));

app.on('second-instance', (_e, argv) => {
  pdfArgs(argv).forEach(sendFile);
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// macOS: Finder "Open With", dock drops
app.on('open-file', (e, filePath) => {
  e.preventDefault();
  if (isPdfPath(filePath)) sendFile(filePath);
});

/* ------------------------------------------------------------------ */
/* app:// protocol                                                     */
/* ------------------------------------------------------------------ */

// A standard scheme, so each host is its own origin: app://paperwing (the
// workspace) and app://tools (tool pages) can't script each other.
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      codeCache: true,
    },
  },
]);

const WEB_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'web')
  : path.resolve(__dirname, '..', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.icc': 'application/vnd.iccprofile',
  '.data': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.gz': 'application/gzip',
  '.zip': 'application/zip',
};

const SECURITY_HEADERS = {
  // Same isolation policy as upstream's nginx config: enables
  // SharedArrayBuffer for the multi-threaded WebAssembly engines. Both
  // origins send it; the workspace delegates isolation to its cross-origin
  // tool frames (allow="cross-origin-isolated"), which CORP lets it embed.
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'X-Content-Type-Options': 'nosniff',
};

const APP_PAGE = path.join(WEB_ROOT, 'app.html');

function resolveRequestPath(url) {
  let host;
  let pathname;
  try {
    const parsed = new URL(url);
    host = parsed.host;
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null; // malformed URL
  }
  if (host !== HOST && host !== TOOLS_HOST) return null;
  if ((pathname === '/' || pathname === '') && host === HOST)
    pathname = '/app.html';
  let file = path.normalize(path.join(WEB_ROOT, pathname));
  // Path traversal: must stay inside the web folder
  if (file !== WEB_ROOT && !file.startsWith(WEB_ROOT + path.sep)) return null;
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    file = path.join(file, 'index.html');
  } else if (!path.extname(file) && fs.existsSync(`${file}.html`)) {
    file = `${file}.html`;
  }
  // Each origin serves only its own pages: tool pages never run on the
  // workspace origin (where the bridge is), nor the workspace on the tools one
  if (/\.html?$/i.test(file) && (file === APP_PAGE) !== (host === HOST))
    return null;
  return file;
}

/* ------------------------------------------------------------------ */
/* Engines downloaded on first use                                     */
/* ------------------------------------------------------------------ */

// Large engine files (LibreOffice, ~77 MB) aren't shipped in the installer.
// The first time a tool requests one, it's downloaded from this project's
// GitHub Releases, cached in the user data folder and served from there.
let engines = { tag: '', files: [] };
try {
  engines = require('./engines.json');
} catch {
  /* dev run without a desktop build: all engine files are in ../dist */
}
const ENGINE_DIR = () =>
  path.join(app.getPath('userData'), 'engines', engines.tag);
const engineDownloads = new Map();

function engineUrl(name) {
  const base =
    process.env.PAPERWING_ENGINE_BASE ||
    `https://github.com/${pkg.paperwing.repository}/releases/download/${engines.tag}`;
  return `${base.replace(/\/$/, '')}/${name}`;
}

/** Downloads an engine file into the cache and checks its SHA-256 */
async function fetchEngine(entry) {
  const cached = path.join(ENGINE_DIR(), entry.name);
  const tmp = `${cached}.part`;
  await fsp.mkdir(ENGINE_DIR(), { recursive: true });
  const res = await net.fetch(engineUrl(entry.name));
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const hash = crypto.createHash('sha256');
  let received = 0;
  const check = new Transform({
    transform(chunk, _enc, done) {
      hash.update(chunk);
      received += chunk.length;
      engineProgress(entry, received);
      done(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(res.body),
      check,
      fs.createWriteStream(tmp)
    );
    if (hash.digest('hex') !== entry.sha256)
      throw new Error('Checksum mismatch');
    await fsp.rename(tmp, cached);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

/** One download per file, however many requests ask for it */
function downloadEngine(entry) {
  if (!engineDownloads.has(entry.name)) {
    const job = fetchEngine(entry).finally(() =>
      engineDownloads.delete(entry.name)
    );
    engineDownloads.set(entry.name, job);
  }
  return engineDownloads.get(entry.name);
}

/** Tells the app how the first-use download is going (shown as a toast) */
const engineReceived = new Map();
function engineProgress(entry, received) {
  engineReceived.set(entry.name, received);
  const total = engines.files.reduce((n, f) => n + f.size, 0);
  const got = [...engineReceived.values()].reduce((n, v) => n + v, 0);
  mainWindow?.webContents.send('paperwing:engine-progress', {
    percent: Math.min(100, Math.floor((got / total) * 100)),
  });
}

let engineErrorShown = false;
function engineFailed(err) {
  console.error('Engine download failed:', err);
  engineReceived.clear();
  mainWindow?.webContents.send('paperwing:engine-progress', { error: true });
  if (engineErrorShown || !mainWindow) return;
  engineErrorShown = true;
  dialog
    .showMessageBox(mainWindow, {
      type: 'warning',
      message: "Couldn't download the Office conversion engine",
      detail:
        'Converting Word, Excel and PowerPoint files needs a one-time download (about 75 MB). ' +
        'Check your internet connection and try the tool again.',
    })
    .finally(() => (engineErrorShown = false));
}

/** Response for an on-demand engine file, downloading it first if needed */
async function serveEngineFile(entry, headers) {
  const cached = path.join(ENGINE_DIR(), entry.name);
  if (!fs.existsSync(cached)) {
    try {
      // Only verified bytes ever reach the page
      await downloadEngine(entry);
    } catch (err) {
      engineFailed(err);
      return new Response('Engine download failed', { status: 503, headers });
    }
  }
  headers.set('Content-Length', String(entry.size));
  const res = await net.fetch(pathToFileURL(cached).toString());
  return new Response(res.body, { status: 200, headers });
}

/** Removes engine downloads left over from older versions */
async function pruneOldEngines() {
  const root = path.join(app.getPath('userData'), 'engines');
  const dirs = await fsp.readdir(root).catch(() => []);
  await Promise.all(
    dirs
      .filter((d) => d !== engines.tag)
      .map((d) => fsp.rm(path.join(root, d), { recursive: true, force: true }))
  );
}

function registerProtocol() {
  protocol.handle(SCHEME, async (request) => {
    const file = resolveRequestPath(request.url);
    if (!file) return new Response('Not found', { status: 404 });
    const headers = new Headers({
      'Content-Type':
        MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      ...SECURITY_HEADERS,
    });
    if (!fs.existsSync(file)) {
      const rel = path.relative(WEB_ROOT, file).split(path.sep).join('/');
      const entry = engines.files.find((f) => f.path === rel);
      if (entry) return serveEngineFile(entry, headers);
      return new Response('Not found', { status: 404 });
    }
    const res = await net.fetch(pathToFileURL(file).toString());
    const length = res.headers.get('Content-Length');
    if (length) headers.set('Content-Length', length);
    return new Response(res.body, { status: 200, headers });
  });
}

/* ------------------------------------------------------------------ */
/* Window                                                              */
/* ------------------------------------------------------------------ */

const TITLEBAR_HEIGHT = 40;

/**
 * The window is created hidden and shown once it has painted and the app has
 * rendered its first screen, so it appears fully drawn, with no launch screen.
 */
let windowPainted = false;

function revealMainWindow() {
  if (!mainWindow || mainWindow.isVisible()) return;
  if (!windowPainted || !rendererReady) return;
  mainWindow.show();
  mainWindow.focus();
  trace('main window shown');
}

/** Title bar colours matching the app's light/dark chrome */
function chromeColors() {
  return nativeTheme.shouldUseDarkColors
    ? { color: '#1a1a1a', symbolColor: '#d0d0d0' }
    : { color: '#f3f3f3', symbolColor: '#4b4b4b' };
}

nativeTheme.on('updated', () => {
  if (!mainWindow) return;
  const { color, symbolColor } = chromeColors();
  mainWindow.setBackgroundColor(color);
  if (!IS_MAC) {
    mainWindow.setTitleBarOverlay({
      color,
      symbolColor,
      height: TITLEBAR_HEIGHT,
    });
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 620,
    // Hidden until the first screen is drawn (see revealMainWindow)
    show: false,
    title: 'Paperwing',
    backgroundColor: chromeColors().color,
    titleBarStyle: 'hidden',
    ...(IS_MAC
      ? { trafficLightPosition: { x: 14, y: 13 } }
      : { titleBarOverlay: { ...chromeColors(), height: TITLEBAR_HEIGHT } }),
    icon: app.isPackaged
      ? undefined
      : path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  // Let the app ask about unsaved documents before the window closes
  mainWindow.on('close', (e) => {
    if (allowClose || !rendererReady) return;
    e.preventDefault();
    mainWindow.webContents.send('paperwing:close-requested');
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    rendererReady = false;
    allowClose = false;
    if (quitting) app.quit();
  });
  // A crashed page can't answer the unsaved-changes check: let it close
  mainWindow.webContents.on('render-process-gone', () => {
    rendererReady = false;
  });

  // Links to the web open in the default browser; nothing else may open windows
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // The window only shows the workspace page, and only the workspace itself
  // may (re)load it: a tool frame can't navigate it anywhere
  mainWindow.webContents.on('will-navigate', (e) => {
    if (isWorkspaceUrl(e.url) && isWorkspaceFrame(e.initiator)) return;
    e.preventDefault();
    if (/^https?:\/\//.test(e.url)) shell.openExternal(e.url);
  });

  // Tool frames stay inside the app too
  mainWindow.webContents.on('will-frame-navigate', (e) => {
    if (e.isMainFrame || frameMayLoad(e.url, e.initiator)) return;
    e.preventDefault();
    if (/^https?:\/\//.test(e.url)) shell.openExternal(e.url);
  });

  mainWindow.webContents.once('dom-ready', () => trace('app.html parsed'));
  windowPainted = false;
  mainWindow.once('ready-to-show', () => {
    windowPainted = true;
    trace('first paint');
    revealMainWindow();
  });
  mainWindow.loadURL(`${ORIGIN}/app.html`);
  // Safety net: show the window even if the page never reports ready
  const win = mainWindow;
  setTimeout(() => {
    if (win.isDestroyed() || win.isVisible()) return;
    win.show();
    trace('main window shown (timeout)');
  }, 6000);
}

/** "app://host/…" or "blob:app://host/…" -> "host", otherwise null */
function appHost(url) {
  const m = /^(?:blob:)?app:\/\/([^/?#]*)/i.exec(url);
  return m ? m[1].toLowerCase() : null;
}

const isWorkspaceUrl = (url) => /^app:\/\/paperwing(?:[/?#]|$)/i.test(url);

/** The window's top-level frame, showing the workspace */
function isWorkspaceFrame(frame) {
  try {
    return (
      !!frame &&
      !!mainWindow &&
      frame === mainWindow.webContents.mainFrame &&
      frame.origin === ORIGIN
    );
  } catch {
    return false; // frame already gone
  }
}

/**
 * What a frame inside the window may load: tool pages, and documents with
 * no origin of their own (about:, data:). Never the workspace origin, where
 * the bridge lives, apart from the viewer's own print frame (a blob: PDF the
 * workspace creates).
 */
function frameMayLoad(url, initiator) {
  if (/^(about|data):/i.test(url)) return true;
  const host = appHost(url);
  if (host === TOOLS_HOST) return true;
  if (host === HOST && /^blob:/i.test(url)) return isWorkspaceFrame(initiator);
  return false;
}

/* ------------------------------------------------------------------ */
/* IPC bridge (see preload.cjs)                                        */
/* ------------------------------------------------------------------ */

/**
 * Requests must come through the workspace page's own bridge. Tool pages are
 * cross-origin frames (app://tools), so they can't reach it via window.top.
 * The bridge stays narrow anyway: PDFs only, and writes only to files the
 * user opened or saved.
 */
function senderIsApp(e) {
  return !!e.senderFrame && isWorkspaceFrame(e.senderFrame);
}

/** Write via a temporary file, so a crash can't leave a half-written PDF */
async function writeAtomic(filePath, data) {
  const tmp = `${filePath}.paperwing-${process.pid}.tmp`;
  await fsp.writeFile(tmp, Buffer.from(data));
  try {
    await fsp.rename(tmp, filePath);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

ipcMain.handle('paperwing:ready', (e) => {
  if (!senderIsApp(e)) return;
  rendererReady = true;
  trace('app ready');
  revealMainWindow();
  pendingFiles.splice(0).forEach(sendFile);
  pendingCommands
    .splice(0)
    .forEach((c) => mainWindow?.webContents.send('paperwing:menu', c));
});

ipcMain.handle('paperwing:set-theme', (e, pref) => {
  if (!senderIsApp(e)) return;
  nativeTheme.themeSource = ['light', 'dark'].includes(pref) ? pref : 'system';
});

// Same path as the window's close button (so unsaved work is checked)
ipcMain.handle('paperwing:request-close', (e) => {
  if (senderIsApp(e)) mainWindow?.close();
});

ipcMain.handle('paperwing:confirm-close', (e) => {
  if (!senderIsApp(e) || !mainWindow) return;
  allowClose = true;
  mainWindow.close();
});

// Reopening a recent file or the last session
ipcMain.handle('paperwing:read-file', async (e, filePath) => {
  if (!senderIsApp(e) || !isPdfPath(filePath)) return null;
  const data = await fsp.readFile(filePath);
  knownPaths.add(pathKey(filePath));
  return data;
});

// Previews of recent files on Home: read-only, so (unlike read-file) this
// doesn't make the file writable. Very large files get no preview.
const PREVIEW_MAX_BYTES = 150 * 1024 * 1024;
ipcMain.handle('paperwing:read-preview', async (e, filePath) => {
  if (!senderIsApp(e) || !isPdfPath(filePath)) return null;
  const { size } = await fsp.stat(filePath);
  if (size > PREVIEW_MAX_BYTES) return null;
  return fsp.readFile(filePath);
});

// "Save" back to a file the user opened
ipcMain.handle('paperwing:write-file', async (e, filePath, data) => {
  if (!senderIsApp(e) || typeof filePath !== 'string') return false;
  if (!knownPaths.has(pathKey(filePath))) return false;
  await writeAtomic(filePath, data);
  return true;
});

ipcMain.handle('paperwing:save-as', async (e, suggestedName, data) => {
  if (!senderIsApp(e)) return null;
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(app.getPath('documents'), suggestedName),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return null;
  await writeAtomic(filePath, data);
  knownPaths.add(pathKey(filePath));
  return { path: filePath, name: path.basename(filePath) };
});

ipcMain.handle('paperwing:open-dialog', async (e) => {
  if (!senderIsApp(e)) return [];
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled) return [];
  return Promise.all(
    filePaths.map(async (p) => {
      knownPaths.add(pathKey(p));
      return { path: p, name: path.basename(p), data: await fsp.readFile(p) };
    })
  );
});

/* ------------------------------------------------------------------ */
/* Menu                                                                */
/* ------------------------------------------------------------------ */

function buildMenu() {
  if (!IS_MAC) {
    // Windows/Linux: no menu bar; the app handles every shortcut itself
    Menu.setApplicationMenu(null);
    return;
  }
  // macOS: menu accelerators win over page key handling, so each item
  // forwards its command to the app instead of acting on the page.
  const send = (command) => () => {
    if (mainWindow && rendererReady) {
      mainWindow.webContents.send('paperwing:menu', command);
    } else {
      // No window (app still running on macOS): open one, then run it
      pendingCommands.push(command);
      if (!mainWindow) createWindow();
    }
  };
  const item = (label, accelerator, command) => ({
    label,
    accelerator,
    click: send(command),
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          item('About Paperwing', undefined, 'about'),
          { type: 'separator' },
          item('Preferences…', 'Cmd+,', 'prefs'),
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' }, // Cmd+H, so Read Mode uses Shift+Cmd+H
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'File',
        submenu: [
          item('Open…', 'Cmd+O', 'open'),
          item('Create PDF…', 'Cmd+N', 'create'),
          item('Reopen Closed Document', 'Shift+Cmd+T', 'reopen'),
          { type: 'separator' },
          item('Save', 'Cmd+S', 'save'),
          item('Save As…', 'Shift+Cmd+S', 'saveAs'),
          item('Print…', 'Cmd+P', 'print'),
          item('Document Properties…', 'Cmd+D', 'properties'),
          { type: 'separator' },
          item('Close Document', 'Cmd+W', 'close'),
          item('Close All', 'Alt+Cmd+W', 'closeAll'),
        ],
      },
      {
        label: 'Edit',
        submenu: [
          item('Undo', 'Cmd+Z', 'undo'),
          item('Redo', 'Shift+Cmd+Z', 'redo'),
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
          { type: 'separator' },
          item('Find', 'Cmd+F', 'find'),
          item('Find Next', 'Cmd+G', 'findNext'),
          item('Find Previous', 'Shift+Cmd+G', 'findPrev'),
          item('Search Tools & Commands…', 'Shift+Cmd+P', 'palette'),
        ],
      },
      {
        label: 'View',
        submenu: [
          item('Zoom In', 'Cmd+=', 'zoomIn'),
          item('Zoom Out', 'Cmd+-', 'zoomOut'),
          item('Zoom To…', 'Cmd+Y', 'zoomTo'),
          item('Actual Size', 'Cmd+1', 'actualSize'),
          item('Fit Page', 'Cmd+0', 'fitPage'),
          item('Fit Width', 'Cmd+2', 'fitWidth'),
          { type: 'separator' },
          item('Rotate Clockwise', 'Shift+Cmd+=', 'rotateCw'),
          item('Rotate Counterclockwise', 'Shift+Cmd+-', 'rotateCcw'),
          { type: 'separator' },
          item('Read Mode', 'Shift+Cmd+H', 'readMode'),
          item('Full Screen', 'Cmd+L', 'fullScreen'),
          item('Page Thumbnails', 'F4', 'navPane'),
          item('Tools Panel', 'Shift+F4', 'toolsPane'),
        ],
      },
      {
        label: 'Window',
        submenu: [
          { role: 'minimize' },
          { role: 'zoom' },
          { type: 'separator' },
          item('Next Document', 'Ctrl+Tab', 'nextTab'),
          item('Previous Document', 'Ctrl+Shift+Tab', 'prevTab'),
          { type: 'separator' },
          { role: 'front' },
        ],
      },
      {
        role: 'help',
        submenu: [
          item('Keyboard Shortcuts', undefined, 'shortcuts'),
          {
            label: 'Paperwing on GitHub',
            click: () =>
              shell.openExternal(
                `https://github.com/${pkg.paperwing.repository}`
              ),
          },
        ],
      },
    ])
  );
}

/* ------------------------------------------------------------------ */
/* Startup                                                             */
/* ------------------------------------------------------------------ */

app.whenReady().then(() => {
  trace('electron ready');
  registerProtocol();
  buildMenu();

  // Exports that aren't PDFs (images, Word, ZIP...) ask where to save
  session.defaultSession.on('will-download', (_e, item) => {
    item.setSaveDialogOptions({
      defaultPath: path.join(app.getPath('downloads'), item.getFilename()),
    });
  });

  // PAPERWING_TRACE=1 also lists every request that leaves the machine
  if (process.env.PAPERWING_TRACE) {
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (details, callback) => {
        trace(`network ${details.method} ${details.url}`);
        callback({});
      }
    );
  }

  // Nothing in Paperwing needs the camera, location, notifications etc.
  const allowed = new Set([
    'fullscreen',
    'clipboard-read',
    'clipboard-sanitized-write',
  ]);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(allowed.has(permission))
  );

  createWindow();
  setTimeout(() => pruneOldEngines().catch(() => {}), 10000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// macOS: the window's close is checked for unsaved work first; once it has
// closed, finish quitting
app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => {
  if (!IS_MAC) app.quit();
});
