/**
 * Running the Windows scanner helpers from tests (win-scanner*.test.mjs).
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Where the helpers are: PAPERWING_SCANNER_DIR, or the build output */
export const helperDir =
  process.env.PAPERWING_SCANNER_DIR ||
  join(here, '..', 'native', 'win-scanner', 'out');

/**
 * Runs a helper; resolves with its exit code, its JSON lines, stderr and the
 * time taken. onLine(msg, child) sees each message as it arrives.
 */
export function runHelper(exe, args, { onLine, env, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(exe, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    const lines = [];
    let buffer = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${args[0]} didn't finish in ${timeout} ms`));
    }, timeout);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        // Drivers may print text of their own; the protocol's lines are JSON
        if (!line.startsWith('{')) continue;
        const msg = JSON.parse(line);
        lines.push(msg);
        onLine?.(msg, child);
      }
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, lines, stderr, ms: Date.now() - started });
    });
  });
}
