/**
 * Theme integration for upstream tools that render their own UI (editors,
 * workflow builder, markdown editor...). See apps.css for the styles.
 */
import { getThemePref, isDark, onThemeChange } from './theme';

export function initApps(): void {
  const page = document.documentElement.dataset.page ?? '';

  syncColorSchemeMeta();
  onThemeChange(syncColorSchemeMeta);

  switch (page) {
    case 'edit-pdf':
      themeEmbedViewer();
      break;
    case 'pdf-workflow':
      themeWorkflow();
      break;
    case 'markdown-to-pdf':
      themeMarkdownEditor();
      break;
    case 'edit-pdf-text':
      showHistoryButtons();
      break;
  }
}

/** Edit a PDF shows Undo and Redo only on narrow screens; inside Paperwing
 *  they sit next to Export at every size (the editor's own [hidden] rule
 *  is !important, so the attribute itself goes) */
function showHistoryButtons() {
  if (window.self === window.top) return;
  const show = () => {
    for (const id of ['undo', 'redo']) {
      const b = document.getElementById(id);
      if (!b) continue;
      b.hidden = false;
      new MutationObserver(() => {
        if (b.hidden) b.hidden = false;
      }).observe(b, { attributes: true, attributeFilter: ['hidden'] });
    }
  };
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', show, { once: true });
  else show();
}

/** Pages like edit-pdf-text pin <meta name="color-scheme" content="dark">,
 * which makes native controls/scrollbars dark even in the light theme. */
function syncColorSchemeMeta() {
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[name="color-scheme"]'
  );
  if (meta) meta.content = isDark() ? 'dark' : 'light';
}

/** Run `fn` for every element matching `selector`, now and as they appear. */
function whenAdded<T extends Element>(
  selector: string,
  fn: (el: T) => void
): void {
  const seen = new WeakSet<Element>();
  const scan = () => {
    document.querySelectorAll<T>(selector).forEach((el) => {
      if (seen.has(el)) return;
      seen.add(el);
      fn(el);
    });
  };
  scan();
  new MutationObserver(scan).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

/* ------------------------------------------------------------------ */
/* edit-pdf: EmbedPDF viewer (shadow DOM) — same palette as Paperwing  */
/* ------------------------------------------------------------------ */

function viewerTheme() {
  return {
    preference: getThemePref(),
    light: {
      background: {
        app: '#f8f8f8',
        surface: '#ffffff',
        surfaceAlt: '#f5f5f5',
        elevated: '#ffffff',
        input: '#ffffff',
      },
      accent: {
        primary: '#3b63fb',
        primaryHover: '#274dea',
        primaryActive: '#1d3ecf',
        primaryLight: '#edf1ff',
        primaryForeground: '#ffffff',
      },
    },
    dark: {
      background: {
        app: '#141414',
        surface: '#222222',
        surfaceAlt: '#1c1c1c',
        elevated: '#2a2a2a',
        overlay: 'rgba(0,0,0,0.6)',
        input: '#1c1c1c',
      },
      foreground: {
        primary: '#ededed',
        secondary: '#c9c9c9',
        muted: '#9c9c9c',
        disabled: '#666666',
        onAccent: '#ffffff',
      },
      border: { default: '#333333', subtle: '#2a2a2a', strong: '#4a4a4a' },
      accent: {
        primary: '#5c7cff',
        primaryHover: '#7590ff',
        primaryActive: '#4a69ef',
        primaryLight: '#242a3d',
        primaryForeground: '#ffffff',
      },
      interactive: {
        hover: '#2f2f2f',
        active: '#3a3a3a',
        selected: '#2c3350',
        focus: '#5c7cff',
        focusRing: 'rgba(92,124,255,0.4)',
      },
      scrollbar: {
        track: 'transparent',
        thumb: '#4a4a4a',
        thumbHover: '#5e5e5e',
      },
    },
  };
}

type ThemedViewer = HTMLElement & { setTheme?: (theme: unknown) => void };

function themeEmbedViewer() {
  // EmbedPDF.init() sets the element's config before appending it, so
  // setTheme() works as soon as the element shows up in the DOM.
  const apply = (el: ThemedViewer) => el.setTheme?.(viewerTheme());
  whenAdded<ThemedViewer>('embedpdf-container', apply);
  onThemeChange(() =>
    document.querySelectorAll<ThemedViewer>('embedpdf-container').forEach(apply)
  );
}

/* ------------------------------------------------------------------ */
/* pdf-workflow: Rete connections live in shadow DOM                   */
/* ------------------------------------------------------------------ */

function themeWorkflow() {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(
    `path { stroke: var(--rs-text-3); stroke-width: 2px; }
     :host(:hover) path { stroke: var(--rs-accent); }`
  );
  const adopt = (el: Element) => {
    const sr = el.shadowRoot;
    if (sr && !sr.adoptedStyleSheets.includes(sheet)) {
      sr.adoptedStyleSheets = [...sr.adoptedStyleSheets, sheet];
    }
  };
  // <rete-connection-wrapper> renders <rete-connection> into its own shadow
  // root (asynchronously), and the path sits in the inner shadow root.
  whenAdded('rete-connection-wrapper', (wrapper) => {
    const scan = () =>
      wrapper.shadowRoot?.querySelectorAll('rete-connection').forEach(adopt);
    scan();
    if (wrapper.shadowRoot) {
      new MutationObserver(scan).observe(wrapper.shadowRoot, {
        childList: true,
        subtree: true,
      });
    }
  });

  // <wf-node> never re-renders on selection, so mirror Rete's selection
  // (click selects, ctrl-click accumulates, empty canvas clears) as a class.
  document.addEventListener(
    'pointerdown',
    (e) => {
      const target = e.target as Element | null;
      const container = target?.closest?.('#rete-container');
      if (!container || target?.closest('rete-ref, [data-wf-delete]')) return;
      const node = target?.closest('wf-node');
      if (!(e.ctrlKey || e.metaKey) || !node) {
        container
          .querySelectorAll('wf-node.rs-selected')
          .forEach((n) => n !== node && n.classList.remove('rs-selected'));
      }
      node?.classList.add('rs-selected');
    },
    true
  );
}

/* ------------------------------------------------------------------ */
/* markdown-to-pdf                                                     */
/* ------------------------------------------------------------------ */

function themeMarkdownEditor() {
  // The editor ships its own light/dark switch; drive it from the app theme
  // (apps.css hides the switch and styles both variants with --rs-* tokens).
  const sync = () =>
    document.querySelectorAll('.md-editor').forEach((el) => {
      el.classList.toggle('light-mode', !isDark());
      el.querySelector('.theme-toggle-slider')?.classList.toggle(
        'active',
        !isDark()
      );
    });
  whenAdded('.md-editor', sync);
  onThemeChange(sync);
}
