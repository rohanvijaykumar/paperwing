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
  screen,
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
const { createPrinting } = require('./print.cjs');

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

/** A file the user opened (or saved) through Paperwing: it may be written
 *  back to, and it goes on the OS's recent documents (the taskbar jump list
 *  on Windows, the Dock menu and File ▸ Open Recent on macOS) */
function openedPath(filePath) {
  knownPaths.add(pathKey(filePath));
  if (process.platform === 'win32') rememberRecent(filePath);
  else if (IS_MAC) app.addRecentDocument(filePath);
}

/* Recent files in the taskbar jump list (Windows) --------------------- */

// Windows' own recent documents keep one shortcut per file *name*, so files
// that share one (versions of a document kept in different folders, say)
// replaced each other and the jump list
// showed just the last. Paperwing keeps its own list instead, and names
// same-named files by their folder, as its tabs do.

const RECENT_MAX = 10;
const recentFile = () =>
  path.join(app.getPath('userData'), 'recent-files.json');

function readRecent() {
  try {
    const list = JSON.parse(fs.readFileSync(recentFile(), 'utf8'));
    return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

function rememberRecent(filePath) {
  const key = pathKey(filePath);
  const list = [
    filePath,
    ...readRecent().filter((p) => pathKey(p) !== key),
  ].slice(0, 30);
  try {
    fs.writeFileSync(recentFile(), JSON.stringify(list));
  } catch {
    /* read-only profile: the jump list just doesn't change */
  }
  updateJumpList(list);
}

/** For files that share a name: the fewest trailing folders that tell each
 *  apart ("Acme Corp", "Globex › Product Manager"); '' for unique names */
function folderHints(paths) {
  const hints = paths.map(() => '');
  const groups = new Map();
  paths.forEach((p, i) => {
    const name = path.basename(p).toLowerCase();
    groups.set(name, [...(groups.get(name) ?? []), i]);
  });
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const dirs = group.map((i) =>
      path
        .dirname(paths[i])
        .split(/[\\/]+/)
        .filter(Boolean)
    );
    // Folders all of them end with say nothing: leave them out
    let common = 0;
    while (
      dirs.every((d) => d.length > common) &&
      dirs.every(
        (d) =>
          d[d.length - 1 - common].toLowerCase() ===
          dirs[0][dirs[0].length - 1 - common].toLowerCase()
      )
    )
      common++;
    const trimmed = dirs.map((d) => d.slice(0, d.length - common));
    const tail = (d, n) => d.slice(-n).join(' › ').toLowerCase();
    group.forEach((i, g) => {
      const d = trimmed[g];
      let n = 1;
      while (
        n < d.length &&
        trimmed.some((o, h) => h !== g && tail(o, n) === tail(d, n))
      )
        n++;
      hints[i] = d.slice(-n).join(' › ');
    });
  }
  return hints;
}

function updateJumpList(list = readRecent()) {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  // Entries the user removed from the jump list must stay out of it
  // (Windows refuses the whole list otherwise)
  const removed = new Set(
    (app.getJumpListSettings().removedItems ?? []).map((item) => item.args)
  );
  const files = list
    .filter((p) => isPdfPath(p))
    .map((p) => ({ p, args: `"${p}"` }))
    .filter(({ args }) => !removed.has(args))
    .slice(0, RECENT_MAX);
  const hints = folderHints(files.map(({ p }) => p));
  const items = files.map(({ p, args }, i) => ({
    type: 'task',
    title:
      path.basename(p, path.extname(p)) + (hints[i] ? ` (${hints[i]})` : ''),
    description: p,
    program: process.execPath,
    args,
    iconPath: process.execPath,
    iconIndex: 0,
  }));
  try {
    // Never null: that brings back Windows' own list, the one we replace
    app.setJumpList(
      items.length ? [{ type: 'custom', name: 'Recent', items }] : []
    );
  } catch {
    /* the jump list is a nicety */
  }
}

function clearRecent() {
  try {
    fs.rmSync(recentFile(), { force: true });
  } catch {
    /* nothing to clear */
  }
  app.clearRecentDocuments();
  updateJumpList([]);
}

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
    openedPath(filePath);
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
  // Python packages of the bundled PyMuPDF engine
  '.whl': 'application/zip',
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
/* Relay for timestamp and certificate servers                         */
/* ------------------------------------------------------------------ */

/**
 * Timestamping and digital signatures contact timestamp authorities and the
 * servers that publish certificates. Those don't allow requests from web
 * pages (no CORS), so in a browser BentoPDF goes through a proxy configured
 * at build time (VITE_CORS_PROXY_URL). Here the app is that proxy: tool
 * pages ask app://tools/__relay?url=… and the request goes out from the
 * main process. Only tool pages can reach it (it's on their origin, inside
 * the app), only for http(s), GET or POST, and size- and time-limited.
 */
const RELAY_PATH = '/__relay';
const RELAY_MAX_BYTES = 4 * 1024 * 1024;
const RELAY_TIMEOUT_MS = 30000;

function isRelayRequest(url) {
  try {
    const u = new URL(url);
    return u.host === TOOLS_HOST && u.pathname === RELAY_PATH;
  } catch {
    return false;
  }
}

async function relay(request) {
  const deny = (status, text) =>
    new Response(text, {
      status,
      headers: { 'Content-Type': 'text/plain', ...SECURITY_HEADERS },
    });
  let target;
  try {
    target = new URL(new URL(request.url).searchParams.get('url') || '');
  } catch {
    return deny(400, 'Bad URL');
  }
  if (!/^https?:$/.test(target.protocol)) return deny(400, 'Bad URL');
  if (request.method !== 'GET' && request.method !== 'POST')
    return deny(405, 'Method not allowed');
  const body =
    request.method === 'POST' ? Buffer.from(await request.arrayBuffer()) : null;
  if (body && body.length > RELAY_MAX_BYTES) return deny(413, 'Too large');
  trace(`relay ${request.method} ${target.href}`);
  try {
    const res = await net.fetch(target.href, {
      method: request.method,
      headers: request.headers.get('Content-Type')
        ? { 'Content-Type': request.headers.get('Content-Type') }
        : {},
      body,
      redirect: 'follow',
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > RELAY_MAX_BYTES) return deny(502, 'Response too large');
    return new Response(data, {
      status: res.status,
      headers: {
        'Content-Type':
          res.headers.get('Content-Type') || 'application/octet-stream',
        ...SECURITY_HEADERS,
      },
    });
  } catch (err) {
    return deny(502, `Relay failed: ${err?.message ?? err}`);
  }
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
    if (isRelayRequest(request.url)) return relay(request);
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
  // Maximized last time: maximizing shows it, already filling the screen
  if (startMaximized) mainWindow.maximize();
  else mainWindow.show();
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

/* Window size and place, remembered between runs ------------------- */

const windowStateFile = () =>
  path.join(app.getPath('userData'), 'window-state.json');
/** Set from the saved state; revealMainWindow maximizes instead of showing */
let startMaximized = false;

/** Where the window was last time, if that's still on a connected screen */
function savedWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(windowStateFile(), 'utf8'));
    const { x, y, width, height } = s.bounds ?? {};
    if (![x, y, width, height].every(Number.isFinite)) return null;
    // Enough of its top edge on some screen to grab it (screens change:
    // a laptop away from its monitor)
    const reachable = screen.getAllDisplays().some(({ workArea: a }) => {
      const left = Math.max(x, a.x);
      const right = Math.min(x + width, a.x + a.width);
      return right - left >= 120 && y >= a.y - 8 && y + 40 <= a.y + a.height;
    });
    if (!reachable) return null;
    return {
      bounds: {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.max(Math.round(width), 960),
        height: Math.max(Math.round(height), 620),
      },
      maximized: !!s.maximized,
    };
  } catch {
    return null; // first run, or an unreadable file
  }
}

/** Saves the window's place after it moves or resizes, and when it closes */
function rememberWindowState(win) {
  let timer = null;
  let maximized = win.isMaximized();
  const save = () => {
    clearTimeout(timer);
    if (win.isDestroyed()) return;
    // Minimized says nothing about how it should come back
    if (!win.isMinimized()) maximized = win.isMaximized() || win.isFullScreen();
    try {
      fs.writeFileSync(
        windowStateFile(),
        JSON.stringify({ bounds: win.getNormalBounds(), maximized })
      );
    } catch {
      /* read-only profile: start at the default size next time */
    }
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 500);
  };
  for (const event of [
    'resize',
    'move',
    'maximize',
    'unmaximize',
    'enter-full-screen',
    'leave-full-screen',
  ])
    win.on(event, later);
  win.on('close', save);
}

/** Windows at fractional scaling (125%) sizes a hidden-title-bar window a
 *  few pixels larger than asked, so the window grew a little on every
 *  restart: take the difference off */
function placeWindow(win, bounds) {
  win.setBounds(bounds);
  const got = win.getBounds();
  const dw = got.width - bounds.width;
  const dh = got.height - bounds.height;
  if (dw || dh)
    win.setBounds({
      ...bounds,
      width: bounds.width - dw,
      height: bounds.height - dh,
    });
}

function createWindow() {
  const saved = savedWindowState();
  startMaximized = !!saved?.maximized;
  mainWindow = new BrowserWindow({
    ...(saved ? saved.bounds : { width: 1400, height: 900 }),
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
    // Packaged apps use the executable's icon
    icon: app.isPackaged
      ? undefined
      : path.join(
          __dirname,
          'build',
          process.platform === 'win32'
            ? 'icon.ico'
            : process.platform === 'linux'
              ? 'icon-linux.png'
              : 'icon.png'
        ),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  if (saved) placeWindow(mainWindow, saved.bounds);
  rememberWindowState(mainWindow);
  // Let the app ask about unsaved documents before the window closes
  mainWindow.on('close', (e) => {
    if (allowClose || !rendererReady) return;
    e.preventDefault();
    mainWindow.webContents.send('paperwing:close-requested');
  });
  mainWindow.on('closed', () => {
    watchFiles([]);
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
    if (startMaximized) win.maximize();
    else win.show();
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
  openedPath(filePath);
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
  openedPath(filePath);
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
      openedPath(p);
      return { path: p, name: path.basename(p), data: await fsp.readFile(p) };
    })
  );
});

// Printing (see print.cjs): the page's print dialog lists the printers,
// then sends the prepared document to a printer or to a PDF file
let printing = null;
const getPrinting = () =>
  (printing ??= createPrinting({
    BrowserWindow,
    dialog,
    settingsFile: path.join(app.getPath('userData'), 'print-settings.json'),
    documentsDir: app.getPath('documents'),
    writeFile: writeAtomic,
  }));

ipcMain.handle('paperwing:printers', (e) => {
  if (!senderIsApp(e)) return { printers: [], selected: null };
  return getPrinting().printers(e.sender);
});

ipcMain.handle('paperwing:print-pages', (e, data, request) => {
  if (!senderIsApp(e)) return { ok: false, error: 'invalid' };
  return getPrinting().run(e.sender, mainWindow, data, request);
});

// Home ▸ Clear recent also clears the OS's list
ipcMain.handle('paperwing:clear-recent-documents', (e) => {
  if (senderIsApp(e)) clearRecent();
});

// Recent files' "Show in File Explorer / Finder"
ipcMain.handle('paperwing:show-in-folder', (e, filePath) => {
  if (!senderIsApp(e) || !isPdfPath(filePath)) return;
  shell.showItemInFolder(filePath);
});

/* Files changed by other apps --------------------------------------- */

/** SHA-256 of a file's contents (the page fingerprints what it shows the
 *  same way), read in chunks so a large PDF never sits in memory twice */
function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

// Has another app changed an open file? null if it's gone
ipcMain.handle('paperwing:file-hash', async (e, filePath) => {
  if (!senderIsApp(e) || typeof filePath !== 'string') return null;
  if (!knownPaths.has(pathKey(filePath))) return null;
  return hashFile(filePath).catch(() => null);
});

/**
 * Open files are watched, so a document another app saves while it's open
 * here gets a notice. Their folders are watched rather than the files: apps
 * often save by writing a new file and renaming it over the old one, which
 * ends a watch on the file itself. One watcher per folder.
 */
const nameKey = (name) =>
  process.platform === 'linux' ? name : name.toLowerCase();
/** folder key -> { watcher, names: Map<file name key, path the page uses> } */
const watchers = new Map();
const changeTimers = new Map();

function watchFiles(paths) {
  const want = new Map();
  for (const p of paths) {
    if (typeof p !== 'string' || !knownPaths.has(pathKey(p))) continue;
    const dir = path.dirname(p);
    const key = pathKey(dir);
    if (!want.has(key)) want.set(key, { dir, names: new Map() });
    want.get(key).names.set(nameKey(path.basename(p)), p);
  }
  for (const [key, w] of watchers) {
    if (want.has(key)) continue;
    w.watcher.close();
    watchers.delete(key);
  }
  for (const [key, w] of want) {
    const current = watchers.get(key);
    if (current) {
      current.names = w.names;
      continue;
    }
    try {
      const watcher = fs.watch(w.dir, { persistent: false }, (_event, name) => {
        const entry = watchers.get(key);
        const filePath = name && entry?.names.get(nameKey(String(name)));
        if (!filePath) return;
        // Apps write in several steps: report once it has settled
        clearTimeout(changeTimers.get(filePath));
        changeTimers.set(
          filePath,
          setTimeout(() => {
            changeTimers.delete(filePath);
            mainWindow?.webContents.send('paperwing:file-changed', filePath);
          }, 700)
        );
      });
      watcher.on('error', () => {
        watcher.close();
        watchers.delete(key);
      });
      watchers.set(key, { watcher, names: w.names });
    } catch {
      /* folder gone, or not watchable (some network drives) */
    }
  }
}

ipcMain.handle('paperwing:watch-files', (e, paths) => {
  if (!senderIsApp(e) || !Array.isArray(paths)) return;
  watchFiles(paths.slice(0, 500));
});

// Files dropped onto the window: the page gets their real path (webUtils in
// preload.cjs) and registers it, so "Save" can write back to the file, as
// for files opened with the dialog
ipcMain.handle('paperwing:allow-path', (e, filePath) => {
  if (!senderIsApp(e) || !isPdfPath(filePath)) return false;
  openedPath(filePath);
  return true;
});

/* Unsaved documents (tool results not saved yet) ------------------------
 * While such a document is open, a recovery copy is kept in the Unsaved
 * folder of the user data, so it survives a crash. The copy is deleted as
 * soon as the document is saved or discarded; anything left behind is
 * reopened at the next launch, and removed after RECOVERY_MAX_AGE.
 */
const RECOVERY_DIR = () => path.join(app.getPath('userData'), 'Unsaved');
const RECOVERY_MAX_AGE = 14 * 24 * 60 * 60 * 1000;
const isRecoveryId = (id) =>
  typeof id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(id);
const recoveryFile = (id, ext) => path.join(RECOVERY_DIR(), `${id}.${ext}`);

ipcMain.handle('paperwing:recovery-save', async (e, id, name, data) => {
  if (!senderIsApp(e) || !isRecoveryId(id) || typeof name !== 'string')
    return false;
  await fsp.mkdir(RECOVERY_DIR(), { recursive: true });
  await writeAtomic(recoveryFile(id, 'pdf'), data);
  await fsp.writeFile(
    recoveryFile(id, 'json'),
    JSON.stringify({ name: name.slice(0, 255), savedAt: Date.now() })
  );
  return true;
});

ipcMain.handle('paperwing:recovery-list', async (e) => {
  if (!senderIsApp(e)) return [];
  const names = await fsp.readdir(RECOVERY_DIR()).catch(() => []);
  const found = [];
  for (const file of names) {
    const id = file.replace(/\.json$/, '');
    if (id === file || !isRecoveryId(id)) continue;
    try {
      const meta = JSON.parse(
        await fsp.readFile(recoveryFile(id, 'json'), 'utf8')
      );
      await fsp.access(recoveryFile(id, 'pdf'));
      found.push({
        id,
        name: String(meta.name || 'Untitled.pdf'),
        savedAt: Number(meta.savedAt) || 0,
      });
    } catch {
      /* incomplete copy */
    }
  }
  return found.sort((a, b) => a.savedAt - b.savedAt);
});

ipcMain.handle('paperwing:recovery-read', async (e, id) => {
  if (!senderIsApp(e) || !isRecoveryId(id)) return null;
  return fsp.readFile(recoveryFile(id, 'pdf')).catch(() => null);
});

ipcMain.handle('paperwing:recovery-delete', async (e, id) => {
  if (!senderIsApp(e) || !isRecoveryId(id)) return;
  await Promise.all(
    ['pdf', 'json'].map((ext) => fsp.rm(recoveryFile(id, ext), { force: true }))
  );
});

/** Removes recovery copies nobody came back for */
async function pruneRecovery() {
  const dir = RECOVERY_DIR();
  const names = await fsp.readdir(dir).catch(() => []);
  const now = Date.now();
  await Promise.all(
    names.map(async (file) => {
      const full = path.join(dir, file);
      const { mtimeMs } = await fsp.stat(full).catch(() => ({ mtimeMs: now }));
      if (now - mtimeMs > RECOVERY_MAX_AGE) await fsp.rm(full, { force: true });
    })
  );
}

/* ------------------------------------------------------------------ */
/* Updates                                                             */
/* ------------------------------------------------------------------ */

/**
 * The Windows installer updates itself (electron-updater, from this
 * project's GitHub Releases): a new version downloads in the background and
 * installs when the user restarts from the notice, or quits. The portable
 * build and macOS (which only allows this for signed apps) get the page's
 * "new version available" notice instead (src/acro/updates.ts).
 */
// Development: PAPERWING_UPDATE_TEST_FEED points the updater at a local test
// feed (bench/check-update.mjs); it never installs anything in that mode
const updateTestFeed =
  !app.isPackaged && process.env.PAPERWING_UPDATE_TEST_FEED;
const canAutoUpdate =
  (app.isPackaged && process.platform === 'win32' && !portableDir) ||
  !!updateTestFeed;
let updater = null;
let updateReady = null;

function getUpdater() {
  if (updater) return updater;
  ({ autoUpdater: updater } = require('electron-updater'));
  // Nothing downloads until the user chooses Update (paperwing:update-download);
  // once they have, the update also installs if they quit instead of restarting
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  if (updateTestFeed) {
    // Stands in for the app-update.yml a packaged app has
    const config = path.join(app.getPath('userData'), 'dev-app-update.yml');
    fs.writeFileSync(
      config,
      `provider: generic
url: ${updateTestFeed}
updaterCacheDirName: paperwing-updater-test
`
    );
    updater.updateConfigPath = config;
    updater.forceDevUpdateConfig = true;
    updater.autoInstallOnAppQuit = false;
  }
  updater.logger = {
    info: (m) => trace(`update: ${m}`),
    warn: (m) => console.warn('[update]', m),
    error: (m) => console.error('[update]', m),
    debug: () => {},
  };
  updater.on('update-downloaded', (info) => {
    updateReady = { version: info.version };
    mainWindow?.webContents.send('paperwing:update-ready', updateReady);
  });
  updater.on('download-progress', (p) =>
    mainWindow?.webContents.send('paperwing:update-progress', {
      percent: p?.percent ?? null,
    })
  );
  updater.on('error', (err) => console.warn('[update]', err?.message ?? err));
  return updater;
}
let updateDownloading = false;

// The page checks on every launch, every two hours and from Help ▸ Check for updates
ipcMain.handle('paperwing:update-check', async (e) => {
  if (!senderIsApp(e)) return { auto: false };
  // Builds that don't update themselves download the file for their
  // platform and chip (an x64 build under Rosetta gets the Apple silicon one)
  if (!canAutoUpdate)
    return {
      auto: false,
      platform: process.platform,
      arch: app.runningUnderARM64Translation ? 'arm64' : process.arch,
      portable: !!portableDir,
    };
  if (updateReady) {
    // Already downloaded: offer the restart again
    mainWindow?.webContents.send('paperwing:update-ready', updateReady);
    return { auto: true, available: true, ready: true, ...updateReady };
  }
  try {
    const result = await getUpdater().checkForUpdates();
    const version = result?.updateInfo?.version ?? null;
    return {
      auto: true,
      available: !!result?.isUpdateAvailable,
      version,
      downloading: updateDownloading,
    };
  } catch (err) {
    return { auto: true, error: String(err?.message ?? err) };
  }
});

// The user chose Update: download it (progress and the "ready" notice
// follow as events)
ipcMain.handle('paperwing:update-download', async (e) => {
  if (!senderIsApp(e) || !canAutoUpdate) return { ok: false };
  if (updateReady) {
    mainWindow?.webContents.send('paperwing:update-ready', updateReady);
    return { ok: true };
  }
  if (updateDownloading) return { ok: true };
  updateDownloading = true;
  try {
    // (a check first: after a restart the updater doesn't know the version)
    const result = await getUpdater().checkForUpdates();
    if (!result?.isUpdateAvailable) return { ok: false, error: 'No update' };
    await updater.downloadUpdate();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  } finally {
    updateDownloading = false;
  }
});

// "Restart now" (the page has dealt with unsaved documents first)
ipcMain.handle('paperwing:update-install', (e) => {
  if (!senderIsApp(e) || !updater || !updateReady || updateTestFeed)
    return false;
  allowClose = true;
  // Silent install, then start the new version
  updater.quitAndInstall(true, true);
  return true;
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
          {
            role: 'recentDocuments',
            submenu: [{ role: 'clearRecentDocuments' }],
          },
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
            label: 'Paperwing Website',
            click: () => shell.openExternal(pkg.homepage),
          },
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
  // Recent files that were moved or deleted since leave the jump list (not
  // while the window is starting up)
  setTimeout(() => updateJumpList(), 5000);

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
  // Installed fonts (Edit a PDF's "System fonts") only for Paperwing's own
  // pages.
  const allowed = new Set([
    'fullscreen',
    'clipboard-read',
    'clipboard-sanitized-write',
  ]);
  const ownPage = (url) => /^app:\/\/(paperwing|tools)(\/|$)/.test(url || '');
  session.defaultSession.setPermissionRequestHandler(
    (_wc, permission, cb, details) => {
      trace(`permission request ${permission} from ${details?.requestingUrl}`);
      cb(
        allowed.has(permission) ||
          (permission === 'local-fonts' && ownPage(details?.requestingUrl))
      );
    }
  );

  createWindow();
  setTimeout(() => {
    pruneOldEngines().catch(() => {});
    pruneRecovery().catch(() => {});
  }, 10000);

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
