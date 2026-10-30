/**
 * Paperwing's name where BentoPDF's own pages and code show theirs to the
 * user, done at build time (vite-plugin-reskin.ts for pages and code,
 * desktop/scripts/build-web.mjs for the interface strings), so BentoPDF's
 * files stay as they are and new releases merge in cleanly.
 *
 * BentoPDF is credited where Paperwing credits it (README, NOTICE.md, the
 * About box) and its copyright notices are kept: a line with "©" or "All
 * rights reserved" is left alone. Web addresses and storage keys (always
 * lowercase) aren't touched, nor are longer names that merely start with
 * "BentoPDF".
 */

const NAME = /\bBentoPDF\b/g;
const COPYRIGHT = /©|all rights reserved/i;

/** Files BentoPDF's tools save under its name (whole names, so the
 * shortcuts' storage key, 'bentopdf_shortcuts', stays) */
const FILE_NAMES = [
  ['bentopdf-compare-export.pdf', 'paperwing-compare-export.pdf'],
  ['bentopdf_shortcuts.json', 'paperwing_shortcuts.json'],
];

/**
 * `text` with Paperwing's name, line by line (copyright lines kept)
 * @param {string} text
 * @returns {string}
 */
export function rebrand(text) {
  if (!text.includes('BentoPDF')) return text;
  return text
    .split('\n')
    .map((line) =>
      COPYRIGHT.test(line) ? line : line.replace(NAME, 'Paperwing')
    )
    .join('\n');
}

/**
 * Source code: its user-facing strings, and the files it names
 * @param {string} code
 * @returns {string}
 */
export function rebrandCode(code) {
  let out = rebrand(code);
  for (const [from, to] of FILE_NAMES) out = out.split(from).join(to);
  return out;
}

/**
 * A translation file (JSON): every string value, copyright lines kept
 * @param {unknown} json
 * @returns {unknown}
 */
export function rebrandStrings(json) {
  /** @type {(v: unknown) => unknown} */
  const walk = (v) =>
    typeof v === 'string'
      ? COPYRIGHT.test(v)
        ? v
        : v.replace(NAME, 'Paperwing')
      : Array.isArray(v)
        ? v.map(walk)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
          : v;
  return walk(json);
}
