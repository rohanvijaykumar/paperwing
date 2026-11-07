/**
 * The desktop app's words where BentoPDF's tool pages speak as a website,
 * done at build time for the desktop build only (PAPERWING_DESKTOP=1, set
 * by desktop/scripts/build-web.mjs). In the desktop app nothing is uploaded
 * or downloaded and there's no browser: a tool takes the open document or a
 * file you choose, and its result opens in a new tab (a PDF) or is saved
 * where you say (anything else). So:
 *
 *   Upload …            -> Choose …   ("Upload certificate" -> "Choose
 *                                       certificate file")
 *   Download …          -> Save …     ("Save & Download" -> "Save")
 *   … downloaded        -> … created  (a PDF result isn't on disk yet)
 *   in your browser     -> on your computer
 *   your device         -> your computer
 *
 * What's true in the desktop app as well is left alone: "never uploaded",
 * "no uploads", other tools that "upload your files to a server", and the
 * real downloads (the conversion engine, fonts). The browser build keeps
 * BentoPDF's wording.
 *
 * Applied to: the English interface strings (values, not keys), the tool
 * pages' text and tooltips (not their markup), and the string literals in
 * BentoPDF's code (not identifiers, imports or selectors). See
 * docs/UPSTREAM-PATCHES.md.
 */
import ts from 'typescript';

/** Patterns: a space matches any run of whitespace (pages wrap lines
 *  mid-phrase) */
const r = (src) => new RegExp(src.replace(/ /g, '\\s+'), 'gi');

/** True statements in the desktop app too: left exactly as they are */
const KEEP = [
  // (longest first: what one masks, the next can't see)
  r('\\bno upload or download step\\b'),
  r('\\bfrom upload to download\\b'),
  // Questions about uploading ("Is my PDF uploaded?": no, it isn't)
  r('[^.!?]*\\bupload[^.!?]*\\?'),
  r('\\bnever (?:be |get |gets )?upload(?:ed|s)?\\b'),
  r('\\bnothing (?:is |gets |was |will be )?uploaded\\b'),
  r('\\b(?:no|any|an) uploads?\\b'),
  r('\\bnot (?:be )?uploaded\\b'),
  // Other things that are downloads: links in emails, Gmail's menu item
  r('\\bdownload links?\\b'),
  r('\\bdownload message\\b'),
  r('\\buploaded to (?:a|any) servers?\\b'),
  r('\\bupload(?:s|ing)? (?:your |their )?files to (?:a|any) servers?\\b'),
  // The engines really are downloaded (the first time a tool needs one)
  r('\\bdownload[^.!?]*?\\bengines?\\b'),
  r('\\bengines?\\b[^.!?]*?\\bdownload(?:s|ed|ing)?\\b'),
  // Upload limits of websites and portals (compress to 200 KB…)
  r('\\bupload (?:limits?|caps?|sizes?|portals?|forms?)\\b'),
  r('\\bfonts?\\b[^.!?]*?\\bdownload(?:ed|ing)?\\b'),
];

/**
 * [pattern, replacement] in order. A replacement takes the case of what it
 * replaces (Upload -> Choose, upload -> choose). `$1` etc. work as usual.
 * Words only, never inside identifiers, paths or names (download-btn,
 * ./download-node, a.download, coherentpdf.browser.js).
 * @type {[RegExp, string][]}
 */
const W = (word) => `(?<![\\w\\-/.#@])(?<!=["'])${word}(?![\\w\\-/]|\\.\\w)`;
export const RULES = [
  // Results: saved, not downloaded
  [r(W('save (?:&amp;|&|and) download')), 'save'],
  [r(`,? and the download has started`), ''],
  [r(`\\s*(?:your |the )?download has started\\.?`), ''],
  [r(`\\s*(?:ZIP )?download started\\.?`), ''],
  [r(`${W('downloads started for all files')}`), 'all files are ready'],
  [r(`${W('preparing download')}`), 'preparing the file'],
  [r(`\\s+and downloaded(?![\\w\\-/])`), ''],
  [r(W('downloaded')), 'created'],
  [r(W('downloading')), 'saving'],
  [r(W('download')), 'save'],
  // Files you choose, not upload
  [
    r(`${W('or upload (your|a) signature')}`),
    'or use an image of $1 signature',
  ],
  [r(`${W('upload certificate')} \\(`), 'choose certificate file ('],
  [r(W('file uploader')), 'file picker'],
  [r(W('back to upload')), 'back to choosing a file'],
  [r(W('(on|after|before|during) upload')), '$1 opening'],
  [r(`${W('(the|your) uploaded')}`), '$1'],
  [r(W('uploaded')), 'added'],
  [r(W('uploading')), 'choosing'],
  [r(W('upload')), 'choose'],
  // A desktop app, not a browser
  [r(W('in your browser memory')), 'in memory'],
  [r(W('(?:in|inside) your (?:web )?browser(?: tab)?')), 'on your computer'],
  [r(W('your (?:web )?browser')), 'your computer'],
  [r(W('in the browser')), 'in Paperwing'],
  [r(W('the browser ran out of memory')), 'Paperwing ran out of memory'],
  [r(W('browser-based processing')), 'local processing'],
  [r(W('your device')), 'your computer'],
];

/** `to` in the case of `from`: Upload -> Choose, UPLOAD -> CHOOSE */
function matchCase(from, to) {
  if (!to) return to;
  const letters = from.replace(/[^a-z]/gi, '');
  if (letters.length > 1 && letters === letters.toUpperCase())
    return to.toUpperCase();
  const first = /[a-z]/i.exec(from)?.[0];
  return first && first === first.toUpperCase()
    ? to[0].toUpperCase() + to.slice(1)
    : to;
}

/** A quick test before the rules run (most text has none of these) */
const ANY = /upload|download|browser|device/i;

/**
 * `text` (prose) in the desktop app's words
 * @param {string} text
 * @returns {string}
 */
export function desktopWords(text) {
  if (!ANY.test(text)) return text;
  // Put what stays aside (placeholders can't match any rule)
  const kept = [];
  let out = text;
  for (const k of KEEP)
    out = out.replace(k, (m) => `${kept.push(m) - 1}`);
  for (const [pattern, to] of RULES)
    out = out.replace(pattern, (m, ...groups) => {
      // (groups ends with offset, input: the captures come first)
      const caps = groups.slice(0, -2);
      const filled = to.replace(/\$(\d)/g, (_x, i) => caps[i - 1] ?? '');
      return matchCase(m.trim() ? m.replace(/^[\s,]+/, '') : m, filled);
    });
  return out.replace(/(\d+)/g, (_m, i) => kept[Number(i)]);
}

/** Attributes whose text is shown (tooltips, placeholders, names) */
const SHOWN_ATTRS =
  /\b(title|placeholder|aria-label|alt|data-tip)(\s*=\s*)(["'])(.*?)\3/gi;

/**
 * A tool page: its text and the attributes that show, not its markup,
 * scripts or styles
 * @param {string} html
 * @returns {string}
 */
export function desktopHtml(html) {
  if (!ANY.test(html)) return html;
  let inRaw = false;
  return html
    .split(/(<[^>]*>)/)
    .map((part) => {
      if (part.startsWith('<')) {
        const tag = /^<\/?\s*([a-z0-9-]+)/i.exec(part)?.[1]?.toLowerCase();
        if (tag === 'script' || tag === 'style') inRaw = !part.startsWith('</');
        return part.replace(
          SHOWN_ATTRS,
          (_m, name, eq, q, value) =>
            `${name}${eq}${q}${desktopWords(value)}${q}`
        );
      }
      return inRaw ? part : desktopWords(part);
    })
    .join('');
}

/**
 * An interface string file (JSON): every string value. Keys stay: they're
 * what the code looks up (the English ui.json is never loaded)
 * @param {unknown} json
 * @returns {unknown}
 */
export function desktopStrings(json) {
  /** @type {(v: unknown) => unknown} */
  const walk = (v) =>
    typeof v === 'string'
      ? desktopWords(v)
      : Array.isArray(v)
        ? v.map(walk)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
          : v;
  return walk(json);
}

/** Calls whose string arguments are code, not text (selectors, imports…) */
const CODE_ARGS =
  /^(?:import|require|querySelector(?:All)?|closest|matches|getElementById|getElementsByClassName|getAttribute|setAttribute|hasAttribute|removeAttribute|addEventListener|removeEventListener|createElement|t|i18next\.t|getItem|setItem|removeItem|postMessage|startsWith|endsWith|includes)$/;

/**
 * BentoPDF's code: the text in its string literals. Not module names,
 * selectors, attribute names, translation keys, object keys or anything
 * compared against (those are code, and must match what they look for)
 * @param {string} code
 * @param {string} [fileName]
 * @returns {string}
 */
export function desktopCode(code, fileName = 'code.js') {
  if (!ANY.test(code)) return code;
  const source = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.Latest,
    true,
    /\.tsx?$/.test(fileName) ? ts.ScriptKind.TS : ts.ScriptKind.JS
  );
  /** @type {[number, number, string][]} */
  const edits = [];
  const isCodeString = (node) => {
    const p = node.parent;
    if (!p) return true;
    if (
      ts.isImportDeclaration(p) ||
      ts.isExportDeclaration(p) ||
      ts.isImportTypeNode?.(p) ||
      ts.isLiteralTypeNode(p) ||
      (ts.isPropertyAssignment(p) && p.name === node) ||
      ts.isPropertyAccessExpression(p) ||
      (ts.isElementAccessExpression(p) && p.argumentExpression === node) ||
      ts.isCaseClause(p) ||
      ts.isEnumMember(p)
    )
      return true;
    if (ts.isBinaryExpression(p)) {
      const op = p.operatorToken.kind;
      return (
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken ||
        op === ts.SyntaxKind.InKeyword
      );
    }
    if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
      const callee = p.expression.getText(source);
      const last = callee.split('.').pop() ?? '';
      return (
        p.expression.kind === ts.SyntaxKind.ImportKeyword ||
        CODE_ARGS.test(callee) ||
        CODE_ARGS.test(last)
      );
    }
    return false;
  };
  const visit = (node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      // (a template's parts: judged by the whole template's place)
      const owner = ts.isTemplateHead(node)
        ? node.parent
        : ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
          ? node.parent.parent
          : node;
      const raw = code.slice(node.getStart(source), node.end);
      // Text has a space or starts with a capital (a label); a translation
      // key, a class or an id doesn't
      if (ANY.test(raw) && /\s|^.[A-Z]/.test(raw) && !isCodeString(owner)) {
        // (markup in a string: its text and tooltips, not its tags)
        const changed = /<[a-z!/]/i.test(raw)
          ? desktopHtml(raw)
          : desktopWords(raw);
        if (changed !== raw)
          edits.push([node.getStart(source), node.end, changed]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  let out = code;
  for (const [start, end, text] of edits.sort((a, b) => b[0] - a[0]))
    out = out.slice(0, start) + text + out.slice(end);
  return out;
}

/** Whether this build is the desktop app's */
export const isDesktopBuild = () => process.env.PAPERWING_DESKTOP === '1';
