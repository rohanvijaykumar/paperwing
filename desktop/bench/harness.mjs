/**
 * Launches the desktop app (unpackaged, serving ../dist) with a throwaway
 * profile and connects to its window, for the performance benchmarks.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
/** The app to measure (BENCH_DESKTOP: another checkout's desktop folder) */
export const DESKTOP = process.env.BENCH_DESKTOP || resolve(here, '..');
const ELECTRON = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Profiles and Chromium temp files go here (BENCH_TMP overrides the OS temp dir) */
const TMP_ROOT = process.env.BENCH_TMP || tmpdir();

let port = Number(process.env.BENCH_PORT) || 0;

/** A port nothing is listening on. Fixed ports collided when tests ran back
 *  to back: the previous app could still hold one, and the next app then
 *  never showed its window */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port: free } = server.address();
      server.close(() => resolve(free));
    });
  });
}

/**
 * Starts the app. Resolves once the main window is visible, with the
 * main-process trace timings (ms since the process started) and a
 * puppeteer page for the workspace.
 */
export async function launch({
  profile,
  args = [],
  env = {},
  waitFor = 'main window shown',
} = {}) {
  const userData = profile ?? mkdtempSync(join(TMP_ROOT, 'pw-bench-'));
  const debugPort = port ? ++port : await freePort();
  // Keep rendering even if the window ends up behind others while measuring
  const flags = [
    '--disable-features=CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ];
  const child = spawn(
    ELECTRON,
    ['.', `--remote-debugging-port=${debugPort}`, ...flags, ...args],
    {
      cwd: DESKTOP,
      env: {
        ...process.env,
        ...env,
        PAPERWING_TRACE: '1',
        PAPERWING_USER_DATA: userData,
        TEMP: TMP_ROOT,
        TMP: TMP_ROOT,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  const marks = {};
  let resolveSeen;
  const seen = new Promise((r) => (resolveSeen = r));
  child.stdout.on('data', (buf) => {
    for (const line of String(buf).split(/\r?\n/)) {
      const m = /\[paperwing\]\s+(\d+) ms\s+(.+)$/.exec(line);
      if (!m) continue;
      const mark = m[2].trim();
      marks[mark] ??= Number(m[1]);
      // A slow first start (a fresh build) is shown by main.cjs's safety net:
      // "main window shown (timeout)"
      if (mark === waitFor || mark.startsWith(`${waitFor} (`)) resolveSeen();
    }
  });
  child.stderr.on('data', () => {});
  await Promise.race([
    seen,
    sleep(30000).then(() => {
      throw new Error(`timed out waiting for "${waitFor}"`);
    }),
  ]);

  let browser;
  for (let i = 0; i < 50 && !browser; i++) {
    try {
      browser = await puppeteer.connect({
        browserURL: `http://127.0.0.1:${debugPort}`,
        defaultViewport: null,
        protocolTimeout: 120000,
      });
    } catch {
      await sleep(100);
    }
  }
  const pages = await browser.pages();
  const page = pages.find((p) => p.url().startsWith('app://paperwing'));

  async function close({ keepProfile = false } = {}) {
    // Quit like a user would (so storage is flushed), killing it if it hangs
    const exited = new Promise((r) => child.once('exit', r));
    try {
      await page.evaluate(() => window.paperwing?.requestClose());
    } catch {}
    try {
      browser.disconnect();
    } catch {}
    const timer = setTimeout(() => child.kill(), 8000);
    await exited;
    clearTimeout(timer);
    if (!profile && !keepProfile) {
      try {
        rmSync(userData, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 200,
        });
      } catch {
        /* a helper process still holds a file; the OS temp cleaner gets it */
      }
    }
  }
  /** Opens a file the way Explorer/Finder does while the app is running */
  function openFile(file) {
    const second = spawn(ELECTRON, ['.', file], {
      cwd: DESKTOP,
      env: {
        ...process.env,
        PAPERWING_USER_DATA: userData,
        TEMP: TMP_ROOT,
        TMP: TMP_ROOT,
      },
      stdio: 'ignore',
    });
    return new Promise((r) => second.once('exit', r));
  }
  return { marks, page, browser, child, userData, close, openFile };
}

export function stats(values) {
  const v = [...values].sort((a, b) => a - b);
  const median = v[Math.floor(v.length / 2)];
  const mean = v.reduce((n, x) => n + x, 0) / v.length;
  return {
    median: Math.round(median),
    mean: Math.round(mean),
    min: Math.round(v[0]),
    max: Math.round(v[v.length - 1]),
  };
}

export { sleep };
