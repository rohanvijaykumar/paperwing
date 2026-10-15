/**
 * Self-update, everything short of installing: against a local test feed
 * announcing version 9.9.9, the app finds the update, downloads it, checks
 * its SHA-512 and offers a restart; Help ▸ Check for updates reports it.
 * In this test mode (PAPERWING_UPDATE_TEST_FEED) nothing is ever installed.
 *   node bench/check-update.mjs
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, sleep } from './harness.mjs';

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures++;
};

// The feed: latest.yml and a stand-in installer
const installer = randomBytes(256 * 1024);
const sha512 = createHash('sha512').update(installer).digest('base64');
const name = 'Paperwing-Setup-9.9.9-x64.exe';
const latest = `version: 9.9.9
files:
  - url: ${name}
    sha512: ${sha512}
    size: ${installer.length}
path: ${name}
sha512: ${sha512}
releaseDate: '2026-10-14T00:00:00.000Z'
`;
const served = [];
const server = createServer((req, res) => {
  served.push(req.url);
  if (req.url.startsWith('/latest.yml')) {
    res.writeHead(200, { 'Content-Type': 'text/yaml' });
    res.end(latest);
  } else if (req.url.startsWith(`/${name}`)) {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': installer.length,
    });
    res.end(installer);
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const feed = `http://127.0.0.1:${server.address().port}/`;

// The updater's download folder (LOCALAPPDATA) goes to a temp folder too
const cache = mkdtempSync(
  join(process.env.BENCH_TMP || tmpdir(), 'pw-updater-')
);
const app = await launch({
  env: { PAPERWING_UPDATE_TEST_FEED: feed, LOCALAPPDATA: cache },
});
const { page } = app;
const updaterLog = [];
const keep = (b) =>
  String(b)
    .split(String.fromCharCode(10))
    .filter((l) => /update/i.test(l))
    .forEach((l) => updaterLog.push(l.trim()));
app.child.stdout.on('data', keep);
app.child.stderr.on('data', keep);

// The daily check runs a few seconds after startup on a fresh profile
let toast = '';
for (let i = 0; i < 120 && !toast; i++) {
  await sleep(250);
  toast = await page.evaluate(
    () => document.querySelector('#update-toast')?.textContent ?? ''
  );
}
check(
  served.some((u) => u.startsWith('/latest.yml')),
  'checked the feed'
);
check(
  served.some((u) => u.startsWith(`/${name}`)),
  'downloaded the update'
);
check(
  /Paperwing 9\.9\.9 is ready to install/.test(toast),
  `restart offered: "${toast}"`
);

// Help ▸ Check for updates now reports it
await page.evaluate(() => document.querySelector('#update-toast')?.remove());
await page.evaluate(() => {
  document.querySelector('#help-btn').click();
});
await sleep(300);
await page.evaluate(() =>
  [...document.querySelectorAll('.menu-item')]
    .find((b) => /Check for updates/.test(b.textContent))
    ?.click()
);
let manual = '';
for (let i = 0; i < 40 && !manual; i++) {
  await sleep(250);
  manual = await page.evaluate(() =>
    [...document.querySelectorAll('#toasts .toast')]
      .map((t) => t.textContent)
      .join(' | ')
  );
}
check(
  /9\.9\.9 is ready to install/.test(manual),
  `manual check offers the restart again: "${manual}"`
);

if (failures || process.env.VERBOSE) {
  console.log('served:', served.join(' '));
  console.log('updater:', updaterLog.join(' || '));
}
await app.close();
server.close();
try {
  rmSync(cache, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
} catch {}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
