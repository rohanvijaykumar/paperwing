/** User preferences (stored locally; there is no account or cloud sync). */

export interface Prefs {
  /** Acrobat's single-key tool accelerators (H, V, S, U, D, X...) */
  singleKey: boolean;
  /** Reopen the documents that were open when the app was closed */
  restoreSession: boolean;
  /** Reopen documents at the page and zoom they were left at */
  restoreView: boolean;
  /** Look for new releases once a day */
  checkUpdates: boolean;
  /** Tint form fields on the page (Acrobat's "Highlight existing fields") */
  highlightFields: boolean;
  /** Run forms' scripts (calculations, formatting, checks), sandboxed */
  runScripts: boolean;
  /** Tool ids pinned to the top of the tools panel */
  pinnedTools: string[];
  /** Most recently used tool ids, newest first */
  recentTools: string[];
  /** The name each recent tool was opened under ("Organize pages" rather
   *  than the tool page's own "PDF Multi Tool") */
  recentToolNames: Record<string, string>;
  /** Zoom new documents open at */
  defaultZoom: 'automatic' | 'fit-width' | 'fit-page' | '100';
  /** Where the floating quick toolbar was left */
  quickbarPos: { x: number; y: number } | null;
  /** The tool each quick toolbar button was last set to (button -> tool) */
  quickbarTools: Record<string, string>;
}

const KEY = 'paperwing:prefs';

const DEFAULTS: Prefs = {
  singleKey: true,
  restoreSession: true,
  restoreView: true,
  checkUpdates: true,
  highlightFields: true,
  runScripts: true,
  pinnedTools: [],
  recentTools: [],
  recentToolNames: {},
  quickbarPos: null,
  quickbarTools: {},
  defaultZoom: 'automatic',
};

let cache: Prefs | null = null;

/** Tools BentoPDF has renamed (old page id → new): pinned and recently
 *  used tools saved under the old name follow them */
const RENAMED_TOOLS: Record<string, string> = {
  'pdf-to-docx': 'pdf-to-word',
  'encrypt-pdf': 'protect-pdf',
  'decrypt-pdf': 'unlock-pdf',
};

function renameTools(prefs: Prefs): Prefs {
  const ids = (list: string[]) => [
    ...new Set(list.map((id) => RENAMED_TOOLS[id] ?? id)),
  ];
  const keys = <T>(map: Record<string, T>) =>
    Object.fromEntries(
      Object.entries(map).map(([id, v]) => [RENAMED_TOOLS[id] ?? id, v])
    );
  return {
    ...prefs,
    pinnedTools: ids(prefs.pinnedTools),
    recentTools: ids(prefs.recentTools),
    recentToolNames: keys(prefs.recentToolNames),
  };
}

export function getPrefs(): Prefs {
  if (cache) return cache;
  try {
    cache = renameTools({
      ...DEFAULTS,
      ...JSON.parse(localStorage.getItem(KEY) || '{}'),
    });
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache!;
}

export function setPrefs(patch: Partial<Prefs>): Prefs {
  cache = { ...getPrefs(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* storage unavailable: keep for this session */
  }
  return cache;
}

export function togglePinned(toolId: string): boolean {
  const pinned = getPrefs().pinnedTools;
  const on = !pinned.includes(toolId);
  setPrefs({
    pinnedTools: on
      ? [...pinned, toolId]
      : pinned.filter((id) => id !== toolId),
  });
  return on;
}

export function noteToolUsed(toolId: string, name: string) {
  const recent = [
    toolId,
    ...getPrefs().recentTools.filter((id) => id !== toolId),
  ].slice(0, 5);
  const names = { ...getPrefs().recentToolNames, [toolId]: name };
  setPrefs({
    recentTools: recent,
    recentToolNames: Object.fromEntries(
      recent.filter((id) => names[id]).map((id) => [id, names[id]])
    ),
  });
}
