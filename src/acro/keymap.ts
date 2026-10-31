/**
 * Keyboard shortcuts, mirroring Adobe Acrobat's defaults (Windows; ⌘ replaces
 * Ctrl on macOS). The same table drives key handling and the cheat sheet.
 */

export interface Shortcut {
  id: string;
  group: string;
  label: string;
  /** e.g. "Ctrl+Shift+S", "F3", "Ctrl+Plus", single keys like "U" */
  keys: string[];
  /** Used instead of `keys` on macOS, where a combo clashes with the system */
  macKeys?: string[];
  /** Single-key tool accelerators (can be turned off in Preferences) */
  singleKey?: boolean;
}

export const SHORTCUTS: Shortcut[] = [
  // File
  { id: 'open', group: 'File', label: 'Open a file', keys: ['Ctrl+O'] },
  { id: 'create', group: 'File', label: 'Create a PDF', keys: ['Ctrl+N'] },
  { id: 'save', group: 'File', label: 'Save', keys: ['Ctrl+S'] },
  { id: 'saveAs', group: 'File', label: 'Save as', keys: ['Shift+Ctrl+S'] },
  { id: 'print', group: 'File', label: 'Print', keys: ['Ctrl+P'] },
  {
    id: 'close',
    group: 'File',
    label: 'Close document',
    keys: ['Ctrl+W', 'Ctrl+F4'],
  },
  {
    id: 'closeAll',
    group: 'File',
    label: 'Close all documents',
    keys: ['Shift+Ctrl+W', 'Alt+Ctrl+W'],
  },
  {
    id: 'reopen',
    group: 'File',
    label: 'Reopen closed document',
    keys: ['Shift+Ctrl+T'],
  },
  {
    id: 'properties',
    group: 'File',
    label: 'Document properties',
    keys: ['Ctrl+D'],
  },
  {
    id: 'prefs',
    group: 'File',
    label: 'Preferences',
    keys: ['Ctrl+K', 'Ctrl+Comma'],
  },
  { id: 'quit', group: 'File', label: 'Quit', keys: ['Ctrl+Q'] },
  // Edit
  { id: 'undo', group: 'Edit', label: 'Undo', keys: ['Ctrl+Z'] },
  { id: 'redo', group: 'Edit', label: 'Redo', keys: ['Shift+Ctrl+Z'] },
  // Find
  { id: 'find', group: 'Find', label: 'Find text', keys: ['Ctrl+F'] },
  {
    id: 'findAdvanced',
    group: 'Find',
    label: 'Advanced search',
    keys: ['Shift+Ctrl+F'],
  },
  { id: 'findNext', group: 'Find', label: 'Find next', keys: ['F3', 'Ctrl+G'] },
  {
    id: 'findPrev',
    group: 'Find',
    label: 'Find previous',
    keys: ['Shift+F3', 'Shift+Ctrl+G'],
  },
  {
    id: 'palette',
    group: 'Find',
    label: 'Search tools & commands',
    keys: ['Shift+Ctrl+P'],
  },
  // Navigation
  {
    id: 'nextPage',
    group: 'Navigation',
    label: 'Next page',
    keys: ['Right', 'Ctrl+PageDown'],
  },
  {
    id: 'prevPage',
    group: 'Navigation',
    label: 'Previous page',
    keys: ['Left', 'Ctrl+PageUp'],
  },
  {
    id: 'firstPage',
    group: 'Navigation',
    label: 'First page',
    keys: ['Home', 'Shift+Ctrl+Up'],
  },
  {
    id: 'lastPage',
    group: 'Navigation',
    label: 'Last page',
    keys: ['End', 'Shift+Ctrl+Down'],
  },
  {
    id: 'goToPage',
    group: 'Navigation',
    label: 'Go to page',
    keys: ['Shift+Ctrl+N'],
  },
  {
    id: 'nextTab',
    group: 'Navigation',
    label: 'Next document',
    keys: ['Ctrl+Tab', 'Ctrl+F6'],
  },
  {
    id: 'prevTab',
    group: 'Navigation',
    label: 'Previous document',
    keys: ['Shift+Ctrl+Tab', 'Shift+Ctrl+F6'],
  },
  // View
  { id: 'zoomIn', group: 'View', label: 'Zoom in', keys: ['Ctrl+Plus'] },
  { id: 'zoomOut', group: 'View', label: 'Zoom out', keys: ['Ctrl+Minus'] },
  { id: 'zoomTo', group: 'View', label: 'Zoom to…', keys: ['Ctrl+Y'] },
  { id: 'actualSize', group: 'View', label: 'Actual size', keys: ['Ctrl+1'] },
  { id: 'fitPage', group: 'View', label: 'Fit page', keys: ['Ctrl+0'] },
  { id: 'fitWidth', group: 'View', label: 'Fit width', keys: ['Ctrl+2'] },
  { id: 'fitVisible', group: 'View', label: 'Fit visible', keys: ['Ctrl+3'] },
  {
    id: 'rotateCw',
    group: 'View',
    label: 'Rotate view clockwise',
    keys: ['Shift+Ctrl+Plus'],
  },
  {
    id: 'rotateCcw',
    group: 'View',
    label: 'Rotate view counterclockwise',
    keys: ['Shift+Ctrl+Minus'],
  },
  { id: 'fullScreen', group: 'View', label: 'Full screen', keys: ['Ctrl+L'] },
  {
    id: 'readMode',
    group: 'View',
    label: 'Read mode',
    keys: ['Ctrl+H'],
    // ⌘H hides the app on macOS
    macKeys: ['Shift+Ctrl+H'],
  },
  {
    id: 'navPane',
    group: 'View',
    label: 'Show/hide page thumbnails',
    keys: ['F4'],
  },
  {
    id: 'toolsPane',
    group: 'View',
    label: 'Show/hide tools panel',
    keys: ['Shift+F4'],
  },
  // Single-key tool accelerators
  {
    id: 'toolHand',
    group: 'Tools',
    label: 'Hand tool',
    keys: ['H'],
    singleKey: true,
  },
  {
    id: 'toolSelect',
    group: 'Tools',
    label: 'Select tool',
    keys: ['V'],
    singleKey: true,
  },
  {
    id: 'toolZoom',
    group: 'Tools',
    label: 'Marquee zoom',
    keys: ['Z'],
    singleKey: true,
  },
  {
    id: 'toolNote',
    group: 'Tools',
    label: 'Add a comment (sticky note)',
    keys: ['S'],
    singleKey: true,
  },
  {
    id: 'toolHighlight',
    group: 'Tools',
    label: 'Highlight text',
    keys: ['U'],
    singleKey: true,
  },
  {
    id: 'toolMarkup',
    group: 'Tools',
    label: 'Cycle underline / strikethrough',
    keys: ['Shift+U'],
    singleKey: true,
  },
  {
    id: 'toolText',
    group: 'Tools',
    label: 'Add text box',
    keys: ['X'],
    singleKey: true,
  },
  {
    id: 'toolDraw',
    group: 'Tools',
    label: 'Draw freehand',
    keys: ['D'],
    singleKey: true,
  },
  {
    id: 'toolShapes',
    group: 'Tools',
    label: 'Cycle shapes',
    keys: ['Shift+D'],
    singleKey: true,
  },
  {
    id: 'toolStamp',
    group: 'Tools',
    label: 'Stamp',
    keys: ['K'],
    singleKey: true,
  },
  {
    id: 'toolLink',
    group: 'Tools',
    label: 'Add a link',
    keys: ['L'],
    singleKey: true,
  },
  {
    id: 'toolRedact',
    group: 'Tools',
    label: 'Redact',
    keys: ['Shift+Y'],
    singleKey: true,
  },
  {
    id: 'toolEditText',
    group: 'Tools',
    label: 'Edit text & images',
    keys: ['T'],
    singleKey: true,
  },
  {
    id: 'toolCrop',
    group: 'Tools',
    label: 'Crop pages',
    keys: ['C'],
    singleKey: true,
  },
];

export interface KeyInput {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/*
 * Shortcuts follow the keyboard layout: Ctrl+Z is the key marked Z on
 * Colemak, Dvorak, AZERTY or QWERTZ too, as in browsers and Acrobat. Only
 * when a key doesn't type a Latin character does its place on a US keyboard
 * count instead: layouts for other scripts (Russian, Greek, Hebrew, Hindi...),
 * digits that need Shift (AZERTY), and ⌥ on macOS, which changes the
 * character. AltGr (Ctrl+Alt on Windows and Linux) types characters such as
 * Polish ą or German @: those are typing, never shortcuts.
 */

/** A printable ASCII character */
const latin = (e: KeyInput) => /^[!-~]$/.test(e.key);

/** A character typed with AltGr */
const altGr = (e: KeyInput, mac: boolean) =>
  !mac && e.ctrlKey && e.altKey && [...e.key].length === 1;

/** May the key's place on a US keyboard count */
const byPlace = (e: KeyInput, mac: boolean) =>
  e.key !== 'Dead' && !altGr(e, mac);

const KEY_ALIASES: Record<string, (e: KeyInput, mac: boolean) => boolean> = {
  Plus: (e, mac) =>
    e.key === '+' ||
    e.key === '=' ||
    (!latin(e) &&
      byPlace(e, mac) &&
      (e.code === 'Equal' || e.code === 'NumpadAdd')),
  Minus: (e, mac) =>
    e.key === '-' ||
    e.key === '_' ||
    (!latin(e) &&
      byPlace(e, mac) &&
      (e.code === 'Minus' || e.code === 'NumpadSubtract')),
  Comma: (e, mac) =>
    e.key === ',' || (!latin(e) && byPlace(e, mac) && e.code === 'Comma'),
  Right: (e) => e.key === 'ArrowRight',
  Left: (e) => e.key === 'ArrowLeft',
  Up: (e) => e.key === 'ArrowUp',
  Down: (e) => e.key === 'ArrowDown',
};

/** Does a key event match a combo like "Shift+Ctrl+S"? */
export function matchesCombo(
  e: KeyInput,
  combo: string,
  mac: boolean
): boolean {
  const parts = combo.split('+');
  const key = parts.pop()!;
  const want = new Set(parts);
  // "Ctrl" means ⌘ on macOS, except for tab switching which uses Control there too
  const ctrlPressed = mac ? (key === 'Tab' ? e.ctrlKey : e.metaKey) : e.ctrlKey;
  if (want.has('Ctrl') !== ctrlPressed) return false;
  if (want.has('Shift') !== e.shiftKey) return false;
  if (want.has('Alt') !== e.altKey) return false;
  if (!mac && e.metaKey) return false;

  const alias = KEY_ALIASES[key];
  if (alias) return alias(e, mac);
  if (/^\d$/.test(key))
    return /^\d$/.test(e.key)
      ? e.key === key
      : byPlace(e, mac) &&
          (e.code === `Digit${key}` || e.code === `Numpad${key}`);
  if (/^[A-Z]$/.test(key))
    return /^[a-z]$/i.test(e.key)
      ? e.key.toUpperCase() === key
      : !latin(e) && byPlace(e, mac) && e.code === `Key${key}`;
  return e.key === key;
}

/** The combos that trigger a shortcut on this platform */
export function keysFor(s: Shortcut, mac: boolean): string[] {
  return (mac && s.macKeys) || s.keys;
}

export function findShortcut(
  e: KeyInput,
  mac: boolean,
  singleKeyEnabled: boolean
): Shortcut | undefined {
  return SHORTCUTS.find(
    (s) =>
      (singleKeyEnabled || !s.singleKey) &&
      keysFor(s, mac).some((k) => matchesCombo(e, k, mac))
  );
}

/** Human-readable combo for menus and the cheat sheet */
export function formatCombo(combo: string, mac: boolean): string {
  let nice = combo
    .replace('Plus', '+')
    .replace('Minus', '−')
    .replace('Comma', ',')
    .replace('PageDown', 'Page Down')
    .replace('PageUp', 'Page Up');
  if (!mac) return nice;
  // Document switching uses the Control key on macOS too
  if (nice.endsWith('Tab')) nice = nice.replace(/Ctrl\+/g, '⌃');
  return nice
    .replace(/Shift\+/g, '⇧')
    .replace(/Alt\+/g, '⌥')
    .replace(/Ctrl\+/g, '⌘');
}
