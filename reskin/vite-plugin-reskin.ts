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
];

function patchViewer(code: string, id: string): string | null {
  // PAPERWING_VIEWER_PATCHES=0 builds the viewer exactly as upstream ships it
  if (process.env.PAPERWING_VIEWER_PATCHES === '0') return null;
  let out = code;
  let applied = 0;
  // PAPERWING_VIEWER_SKIP="name,name" leaves out individual patches
  const skip = (process.env.PAPERWING_VIEWER_SKIP ?? '').split(',');
  for (const patch of VIEWER_PATCHES) {
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

export function reskinPlugin(): Plugin {
  return {
    name: 'acrobat-reskin',

    config(config) {
      const root = config.root || process.cwd();
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
      if (!id.replace(/\\/g, '/').includes('/bentopdf-viewer/dist/')) return;
      const patched = patchViewer(code, id);
      return patched ? { code: patched, map: null } : undefined;
    },

    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        if (ctx.filename.replace(/\\/g, '/').endsWith('/' + APP_ENTRY)) {
          return html;
        }
        return html
          .replace(
            '</head>',
            '  <link rel="stylesheet" href="/src/reskin/reskin.css" />\n  </head>'
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
