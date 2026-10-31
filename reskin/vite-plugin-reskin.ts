/**
 * Acrobat-style desktop shell for BentoPDF.
 *
 * - Adds `app.html` (the Acrobat-style shell, code in src/acro/) as a build
 *   entry, so upstream's hardcoded page list doesn't need editing.
 * - Injects the light theme + embed helper (src/reskin/) into every upstream
 *   tool page, so they look native when the shell hosts them in a frame.
 *
 * No upstream page files are edited.
 */
import type { Plugin } from 'vite';
import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
// (shared with desktop/scripts/build-web.mjs)
import { rebrand, rebrandCode, rebrandStrings } from './brand.mjs';

const APP_ENTRY = 'app.html';

/** Tool pages whose file input takes several files (for batch runs) */
function multiFilePages(root: string): string[] {
  const dir = resolve(root, 'src', 'pages');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.html'))
    .filter((f) => {
      const html = readFileSync(resolve(dir, f), 'utf8');
      const input = /<input[^>]*id="file-input"[^>]*>/s.exec(html)?.[0];
      return !!input && /\bmultiple\b/.test(input);
    });
}

/**
 * Fixes for the EmbedPDF viewer (bentopdf-viewer), applied to its bundle at
 * build time. Each patch checks that the code it replaces is there exactly as
 * expected; if a viewer update has changed it, that patch is skipped with a
 * warning and the viewer works as upstream ships it.
 */
interface ViewerPatch {
  name: string;
  edits: [from: string, to: string, count: number][];
}

const VIEWER_PATCHES: ViewerPatch[] = [
  {
    // Its store copied the whole state on every getState() call, and plugins
    // call it constantly (once per listener on every change): while scrolling
    // that used half of the main thread. Now one snapshot is built per state
    // change and shared until the next.
    name: 'state snapshot',
    edits: [
      [
        'return{core:{...this.state.core},plugins:{...this.state.plugins}}}',
        'return this.__pwSnap??={core:{...this.state.core},plugins:{...this.state.plugins}}}',
        1,
      ],
      // The state changes only in these places
      [
        'finally{this.isDispatching=!1}',
        'finally{this.isDispatching=!1,this.__pwSnap=null}',
        3,
      ],
      [
        'addPluginReducer(e,t,n){',
        'addPluginReducer(e,t,n){this.__pwSnap=null,',
        1,
      ],
      [
        'this.state.plugins={},this.state.core={...this.initialCoreState}',
        'this.state.plugins={},this.state.core={...this.initialCoreState},this.__pwSnap=null',
        1,
      ],
    ],
  },
  {
    // Ctrl+wheel zoom scaled by (1 - deltaY/100), tuned for trackpad pinches.
    // A mouse wheel notch is deltaY 100, so zooming out went straight to the
    // minimum and zooming in doubled per notch. Now: about 15% per notch,
    // same in both directions, pinches still follow the fingers exactly, and
    // the page eases to each new scale instead of jumping.
    name: 'wheel zoom',
    edits: [
      [
        'F=e=>{if(!e.ctrlKey&&!e.metaKey)return;e.preventDefault(),null===g?(d=c().currentZoomLevel,p=1,_(e.clientX,e.clientY)):clearTimeout(g);const t=1-.01*e.deltaY;p*=t,p=Math.max(.1,Math.min(10,p)),T(p),g=setTimeout(()=>{g=null,N(),p=1},150)}',
        'F=(()=>{let __pwRaf=0;const __pwEase=()=>{const k=u+(p-u)*.4;Math.abs(p-k)<.001?(T(p),__pwRaf=0):(T(k),__pwRaf=requestAnimationFrame(__pwEase))};return e=>{if(!e.ctrlKey&&!e.metaKey)return;e.preventDefault(),null===g?(d=c().currentZoomLevel,p=1,_(e.clientX,e.clientY)):clearTimeout(g);const __pwDy=1===e.deltaMode?40*e.deltaY:2===e.deltaMode?800*e.deltaY:e.deltaY,t=Number.isInteger(__pwDy)?Math.exp(-.0015*__pwDy):Math.exp(-__pwDy/100);p*=t,p=Math.max(.1,Math.min(10,p)),__pwRaf||(__pwRaf=requestAnimationFrame(__pwEase)),g=setTimeout(()=>{cancelAnimationFrame(__pwRaf),__pwRaf=0,T(p),g=null,N(),p=1},200)}})()',
        1,
      ],
    ],
  },
  {
    // A font a PDF uses without embedding it is drawn with a fallback, and
    // the viewer picked the fallback by script only: Times, Helvetica,
    // Courier (PDF's built-in fonts), Arial, Calibri… all came out in one
    // sans-serif face, letters squeezed or spread to the widths the PDF
    // expects. Latin text now gets a font chosen by name, with the same
    // widths (Liberation Serif/Sans/Mono, Carlito, Caladea: fontConfig.faces,
    // set in src/acro/viewer.ts), and bold or italic by name too. Worker
    // engine source: no quotes, backslashes or regular expressions.
    name: 'font faces',
    edits: [
      [
        'const result = this.findBestFontMatch(charset, weight, italic);',
        'const result = this.pwFaceMatch(charset, pitchFamily, face, weight, italic) || this.findBestFontMatch(charset, weight, italic);',
        1,
      ],
      [
        '  findBestFontMatch(charset, requestedWeight, requestedItalic) {',
        '  pwFaceMatch(charset, pitchFamily, face, weight, italic) {\\n' +
          '    const faces = this.fontConfig.faces;\\n' +
          '    if (!faces || (charset !== 0 && charset !== 1)) return null;\\n' +
          '    let n = String(face || "").toLowerCase();\\n' +
          '    if (n.indexOf("+") === 6) n = n.slice(7);\\n' +
          '    for (const c of [" ", "-", ",", "_"]) n = n.split(c).join("");\\n' +
          '    const has = (words) => words.some((w) => n.indexOf(w) >= 0);\\n' +
          '    if (has(["bold", "black", "heavy", "semibold", "demi"])) weight = Math.max(weight, 700);\\n' +
          '    if (has(["italic", "oblique"])) italic = true;\\n' +
          '    let key = null;\\n' +
          '    if (has(["calibri"])) key = "calibri";\\n' +
          '    else if (has(["cambria"])) key = "cambria";\\n' +
          '    else if (has(["courier", "consolas", "lucidaconsole", "monospace", "sansmono", "menlo", "monaco"])) key = "mono";\\n' +
          '    else if (has(["sansserif", "arial", "helvetica", "verdana", "tahoma", "segoe", "trebuchet", "liberationsans", "arimo"])) key = "sans";\\n' +
          '    else if (has(["times", "georgia", "garamond", "palatino", "bookantiqua", "century", "liberationserif", "tinos", "serif", "roman"])) key = "serif";\\n' +
          '    else if (pitchFamily & 1) key = "mono";\\n' +
          '    else if ((pitchFamily & 240) === 16) key = "serif";\\n' +
          '    if (!key || !faces[key]) return null;\\n' +
          '    const best = this.selectBestVariant(faces[key], weight, italic);\\n' +
          '    return { url: best.url, matchedWeight: best.weight, matchedItalic: best.italic };\\n' +
          '  }\\n' +
          '  findBestFontMatch(charset, requestedWeight, requestedItalic) {',
        1,
      ],
    ],
  },
  {
    // Some PDFs map their space character to a tab (wkhtmltopdf does). This
    // PDFium build keeps the tab, where browsers' viewers and PDF.js read a
    // space: copied text came out full of tabs, and a search for a phrase
    // with spaces found nothing. Tabs now read as spaces (same length, so
    // character positions don't move), and a phrase search on such a page
    // also matches the words joined by tabs. Lives in the worker engine,
    // whose source is a single-quoted string: hence no quotes or
    // backslashes in the replacements, and "\\n" for newlines.
    name: 'tab spaces',
    edits: [
      [
        'return text.replace(PdfUnwantedTextRegex, "");',
        'return text.replace(PdfUnwantedTextRegex, "").split(String.fromCharCode(9)).join(" ");',
        1,
      ],
      [
        'searchAllInPage(doc, ctx, page, keywordPtr, flag) {\\n    return ctx.borrowPage(',
        'searchAllInPage(doc, ctx, page, keywordPtr, flag) {\\n' +
          '    const results = this.pwSearchPage(doc, ctx, page, keywordPtr, flag);\\n' +
          '    const keyword = this.pdfiumModule.pdfium.UTF16ToString(keywordPtr);\\n' +
          '    if (!this.pwTabbed || keyword.indexOf(" ") < 0) return results;\\n' +
          '    const alt = keyword.split(" ").join(String.fromCharCode(9));\\n' +
          '    const length = 2 * (alt.length + 1);\\n' +
          '    const altPtr = this.memoryManager.malloc(length);\\n' +
          '    this.pdfiumModule.pdfium.stringToUTF16(alt, altPtr, length);\\n' +
          '    try {\\n' +
          '      const seen = new Set(results.map((r) => r.charIndex));\\n' +
          '      for (const r of this.pwSearchPage(doc, ctx, page, altPtr, flag)) if (!seen.has(r.charIndex)) results.push(r);\\n' +
          '    } finally {\\n' +
          '      this.memoryManager.free(altPtr);\\n' +
          '    }\\n' +
          '    return results.sort((a, b) => a.charIndex - b.charIndex);\\n' +
          '  }\\n' +
          '  pwSearchPage(doc, ctx, page, keywordPtr, flag) {\\n    return ctx.borrowPage(',
        1,
      ],
      [
        'const fullText = this.pdfiumModule.pdfium.UTF16ToString(bufPtr);\\n      this.memoryManager.free(bufPtr);\\n      const pageResults = [];',
        'const fullText = this.pdfiumModule.pdfium.UTF16ToString(bufPtr);\\n      this.memoryManager.free(bufPtr);\\n' +
          '      const pwText = fullText.split(String.fromCharCode(9)).join(" ");\\n' +
          '      this.pwTabbed = pwText !== fullText;\\n      const pageResults = [];',
        1,
      ],
      [
        'const context = this.buildContext(fullText, charIndex, charCount);',
        'const context = this.buildContext(pwText, charIndex, charCount);',
        1,
      ],
    ],
  },
];

/**
 * Fixes for other dependencies, applied the same way (checked, or skipped
 * with a warning).
 */
const SIGNER_PATCHES: ViewerPatch[] = [
  {
    // zgapdfsigner (timestamps, digital signatures) decides whether it runs
    // in a browser with `this === globalThis.self` inside a plain function,
    // which is never true once bundled into a module (`this` is undefined).
    // Thinking it's elsewhere, it doesn't use fetch and refuses timestamp
    // servers whose address isn't http(s), as through the desktop app's
    // relay. In a page, `self` with a fetch is the browser.
    name: 'signer browser check',
    edits: [
      [
        'z.isBrowser = function(){return this === globalThis.self;}();',
        'z.isBrowser = typeof globalThis.self !== "undefined" && typeof globalThis.self.fetch === "function";',
        1,
      ],
    ],
  },
];

function patchViewer(
  code: string,
  id: string,
  patches: ViewerPatch[] = VIEWER_PATCHES
): string | null {
  // PAPERWING_VIEWER_PATCHES=0 builds the viewer exactly as upstream ships it
  if (process.env.PAPERWING_VIEWER_PATCHES === '0') return null;
  let out = code;
  let applied = 0;
  // PAPERWING_VIEWER_SKIP="name,name" leaves out individual patches
  const skip = (process.env.PAPERWING_VIEWER_SKIP ?? '').split(',');
  for (const patch of patches) {
    if (skip.includes(patch.name)) continue;
    const fits = patch.edits.every(
      ([from, , count]) => out.split(from).length - 1 === count
    );
    if (!fits) {
      // Only the bundle chunk that holds the viewer has these
      if (patch.edits.some(([from]) => out.includes(from)))
        console.warn(
          `[reskin] viewer changed: "${patch.name}" patch skipped (${id})`
        );
      continue;
    }
    out = patch.edits.reduce((c, [from, to]) => c.split(from).join(to), out);
    applied++;
  }
  return applied ? out : null;
}

/** The interface strings the pages import (English, bundled): Paperwing's
 * name, before they become code (brand.mjs) */
const brandStringsPlugin: Plugin = {
  name: 'paperwing-name-in-strings',
  enforce: 'pre',
  transform(code, id) {
    const file = id.replace(/\\/g, '/').split('?')[0];
    if (!/\/locales\/.+\.json$/.test(file) || !code.includes('BentoPDF'))
      return;
    return {
      code: JSON.stringify(rebrandStrings(JSON.parse(code))),
      map: null,
    };
  },
};

export function reskinPlugin(): Plugin[] {
  return [brandStringsPlugin, pagesPlugin()];
}

function pagesPlugin(): Plugin {
  // Inlined into each tool page's <head> so it runs before the first paint
  // (see src/reskin/boot.js)
  let bootScript = '';
  return {
    name: 'acrobat-reskin',

    config(config) {
      const root = config.root || process.cwd();
      bootScript = readFileSync(
        resolve(root, 'src', 'reskin', 'boot.js'),
        'utf8'
      ).trim();
      const { version } = JSON.parse(
        readFileSync(resolve(root, 'package.json'), 'utf8')
      );
      const input = config.build?.rollupOptions?.input;
      if (input && typeof input === 'object' && !Array.isArray(input)) {
        (input as Record<string, string>).app = resolve(root, APP_ENTRY);
      }
      const desktopPkg = JSON.parse(
        readFileSync(resolve(root, 'desktop', 'package.json'), 'utf8')
      );
      return {
        define: {
          __APP_VERSION__: JSON.stringify(version),
          __PAPERWING_VERSION__: JSON.stringify(desktopPkg.version),
          __PAPERWING_REPO__: JSON.stringify(desktopPkg.paperwing.repository),
          __PAPERWING_MULTI_FILE_PAGES__: JSON.stringify(multiFilePages(root)),
        },
      };
    },

    transform(code, id) {
      const file = id.replace(/\\/g, '/');
      // BentoPDF's own code: Paperwing's name where it shows its own (brand.mjs)
      if (/\/src\/js\/.*\.[jt]s$/.test(file.split('?')[0])) {
        const branded = rebrandCode(code);
        return branded === code ? undefined : { code: branded, map: null };
      }
      const patches = file.includes('/bentopdf-viewer/dist/')
        ? VIEWER_PATCHES
        : file.includes('/zgapdfsigner/lib/zgafetch.js')
          ? SIGNER_PATCHES
          : null;
      if (!patches) return;
      const patched = patchViewer(code, id, patches);
      return patched ? { code: patched, map: null } : undefined;
    },

    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        if (ctx.filename.replace(/\\/g, '/').endsWith('/' + APP_ENTRY)) {
          return html;
        }
        return rebrand(html)
          .replace(
            '</head>',
            // (a function, so "$" in the script isn't read as a pattern)
            () =>
              '  <link rel="stylesheet" href="/src/reskin/reskin.css" />\n' +
              `  <script>\n${bootScript}\n  </script>\n  </head>`
          )
          .replace(/<body([^>]*)>/, (_m, attrs: string) =>
            /\bclass\s*=\s*"/.test(attrs)
              ? `<body${attrs.replace(/\bclass\s*=\s*"/, 'class="rs-theme ')}>`
              : `<body${attrs} class="rs-theme">`
          )
          .replace(
            '</body>',
            '  <script type="module" src="/src/reskin/reskin.ts"></script>\n  </body>'
          );
      },
    },
  };
}
