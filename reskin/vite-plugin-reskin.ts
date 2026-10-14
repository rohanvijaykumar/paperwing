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
import { readFileSync } from 'fs';
import { resolve } from 'path';

const APP_ENTRY = 'app.html';

/**
 * Performance fix for the EmbedPDF viewer (bentopdf-viewer): its store copies
 * the whole state on every getState() call, and plugins call it constantly,
 * once per listener on every state change. While scrolling a document that
 * used half of the main thread's time. The snapshot is now built once per
 * state change and shared until the next one. Returns the code unchanged
 * (with a warning) if a viewer update has changed the store.
 */
function patchViewerStore(code: string, id: string): string | null {
  const getState =
    'return{core:{...this.state.core},plugins:{...this.state.plugins}}}';
  if (!code.includes(getState)) return null;
  const edits: [string, string, number][] = [
    // Reuse one snapshot until the state changes...
    [
      getState,
      `return this.__pwSnap??={core:{...this.state.core},plugins:{...this.state.plugins}}}`,
      1,
    ],
    // ...which happens only in these places
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
  ];
  for (const [from, , count] of edits) {
    if (code.split(from).length - 1 !== count) {
      console.warn(
        `[reskin] viewer store changed, performance patch skipped (${id})`
      );
      return null;
    }
  }
  return edits.reduce((c, [from, to]) => c.split(from).join(to), code);
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
        },
      };
    },

    transform(code, id) {
      if (!id.replace(/\\/g, '/').includes('/bentopdf-viewer/dist/')) return;
      const patched = patchViewerStore(code, id);
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
