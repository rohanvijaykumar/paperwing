/**
 * Checks the built web app (dist/) for BentoPDF's name where Paperwing's
 * belongs (reskin/brand.mjs puts it there during the build):
 *   - the tool pages: their text and titles
 *   - the interface strings (dist/locales)
 *   - the code: its strings
 * BentoPDF stays where Paperwing credits it (the About box, which links to
 * BentoPDF) and in its copyright notices. check-tools.mjs checks what each
 * tool shows in the running app.
 *
 *   node bench/check-branding.mjs
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../../dist/', import.meta.url));
if (!existsSync(join(dist, 'app.html')))
  throw new Error('Build the web app first: npm run build:web');

const NAME = /\bBentoPDF\b/g;
/** Where BentoPDF's name belongs: credits and copyright notices */
const CREDIT =
  /©|all rights reserved|alam00000\/bentopdf|come from BentoPDF|built on BentoPDF/i;

const found = [];
const files = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });

for (const file of files(dist)) {
  if (!/\.(html|json|js|mjs)$/.test(file)) continue;
  const where = relative(dist, file).replace(/\\/g, '/');
  // (the bundled engines, the changelog and the service worker, which the
  // app doesn't use, aren't the interface)
  if (/^(engines|blog)\//.test(where) || where === 'sw.js') continue;
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(NAME)) {
    const around = text
      .slice(Math.max(0, m.index - 160), m.index + 160)
      .replace(/\s+/g, ' ');
    if (CREDIT.test(around)) continue;
    found.push(`${where}: …${around.slice(100, 220)}…`);
  }
}

for (const f of found.slice(0, 40)) console.log(f);
if (found.length) {
  console.log(
    `\nFAIL: BentoPDF's name in ${found.length} places outside the credits`
  );
  process.exit(1);
}
console.log("OK: BentoPDF's name only in the credits and copyright notices");
