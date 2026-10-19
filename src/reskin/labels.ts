/**
 * Icon-only buttons in the tool pages often have no title or aria-label,
 * so they get no tooltip and screen readers announce nothing. This names
 * them: first by id where a page's button needs a specific name, then by
 * the icon they show. Buttons that already say what they do are left as
 * they are.
 */

/** Names for particular buttons, by id */
const BY_ID: Record<string, string> = {
  // Organize pages
  'bulk-rotate-left-btn': 'Rotate selected pages counterclockwise',
  'bulk-rotate-btn': 'Rotate selected pages clockwise',
  'bulk-duplicate-btn': 'Duplicate selected pages',
  'bulk-split-btn': 'Split after selected pages',
  'bulk-delete-btn': 'Delete selected pages',
  'bulk-download-btn': 'Download selected pages',
  'export-pdf-btn': 'Export the PDF',
  // Prepare a form
  toggleGridBtn: 'Always show grid',
  prevPageBtn: 'Previous page',
  nextPageBtn: 'Next page',
  // Bookmarks, Watermark, Posterize
  'prev-page': 'Previous page',
  'next-page': 'Next page',
  'prev-page-btn': 'Previous page',
  'next-page-btn': 'Next page',
  'prev-preview-page': 'Previous page',
  'next-preview-page': 'Next page',
  // Rotate by custom degrees
  'batch-decrement': 'Rotate all pages −1°',
  'batch-increment': 'Rotate all pages +1°',
  // Markdown to PDF
  mdCloseSettings: 'Close',
};

/** Field names for inputs that only show a value */
const FIELDS: Record<string, string> = {
  gridVInput: 'Grid columns',
  gridHInput: 'Grid rows',
  'text-color-input': 'Text color',
};

/** Names by icon (Lucide or Phosphor icon name) */
const BY_ICON: Record<string, string> = {
  'trash-2': 'Remove',
  trash: 'Remove',
  x: 'Close',
  'x-circle': 'Remove',
  'chevron-left': 'Previous page',
  'chevron-right': 'Next page',
  'caret-left': 'Previous page',
  'caret-right': 'Next page',
  'rotate-ccw': 'Rotate counterclockwise',
  'rotate-cw': 'Rotate clockwise',
  'arrow-counter-clockwise': 'Rotate counterclockwise',
  'arrow-clockwise': 'Rotate clockwise',
  'copy-plus': 'Duplicate',
  copy: 'Duplicate',
  scissors: 'Split here',
  download: 'Download',
  'zoom-in': 'Zoom in',
  'zoom-out': 'Zoom out',
  'magnifying-glass-plus': 'Zoom in',
  'magnifying-glass-minus': 'Zoom out',
  undo: 'Undo',
  'undo-2': 'Undo',
  redo: 'Redo',
  'redo-2': 'Redo',
  'grip-vertical': 'Drag to reorder',
  settings: 'Settings',
  'gear-six': 'Settings',
};

function iconName(el: Element): string | null {
  const icon = el.querySelector(
    'svg[class*="lucide-"], [data-lucide], i[class*="ph-"]'
  );
  if (!icon) return null;
  const lucide = icon.getAttribute('data-lucide');
  if (lucide) return lucide;
  const cls = icon.getAttribute('class') ?? '';
  return (
    /\blucide-([a-z0-9-]+)/.exec(cls)?.[1] ??
    /\bph-(?!bold\b|fill\b)([a-z0-9-]+)/.exec(cls)?.[1] ??
    null
  );
}

function nameButton(b: Element) {
  if (
    b.hasAttribute('title') ||
    b.hasAttribute('aria-label') ||
    b.hasAttribute('data-tip')
  )
    return;
  if ((b.textContent ?? '').trim()) {
    // Labelled by visible text unless that text is hidden at this width
    // (e.g. "hidden xl:inline" labels): then the label becomes its name
    const shown = [...b.querySelectorAll('span')].some(
      (s) => s.offsetParent && (s.textContent ?? '').trim()
    );
    const label = (b.textContent ?? '').trim();
    if (shown || b.querySelectorAll('span').length === 0) return;
    b.setAttribute('title', BY_ID[b.id] ?? label);
    return;
  }
  const icon = iconName(b) ?? '';
  // An X on a file in a list removes that file; elsewhere it closes
  const inFileList = !!b.closest(
    '#file-display-area, #file-list, #fileList, [id$="-file-display"]'
  );
  const name =
    BY_ID[b.id] ?? (icon === 'x' && inFileList ? 'Remove' : BY_ICON[icon]);
  if (name) b.setAttribute('title', name);
}

function nameAll(root: ParentNode) {
  root.querySelectorAll('button, [role="button"]').forEach(nameButton);
  for (const [id, name] of Object.entries(FIELDS)) {
    const f = document.getElementById(id);
    if (f && !f.hasAttribute('aria-label')) f.setAttribute('aria-label', name);
  }
}

export function initLabels() {
  let queued = false;
  const run = () => {
    queued = false;
    nameAll(document);
  };
  const queue = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(run);
  };
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', run, { once: true });
  else run();
  new MutationObserver(queue).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}
