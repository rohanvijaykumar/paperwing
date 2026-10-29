/**
 * Paperwing: a desktop PDF workspace (Home plus tabbed documents and tool
 * workspaces, each with a tools sidebar) around BentoPDF's viewer and tool
 * pages, which do the PDF work.
 */
import '@phosphor-icons/web/duotone';
import { icon, toolIcon, type IconName } from './icons';
import {
  deletePages,
  extractPages,
  insertBlankPage,
  insertPagesFrom,
  movePage,
  movePages,
  pageCount,
  rotatePages,
} from './pages';
import {
  allToolGroups,
  convertTools,
  editTools,
  getTool,
  quickTools,
  recommendedTools,
  signTools,
  toolForFile,
  groups as catalogGroups,
  type AppTool,
  type ToolGroup,
} from './catalog';
import {
  OpenCancelled,
  Viewer,
  type DocView,
  type PageInfo,
  type ViewMode,
} from './viewer';
import { Thumbnails, thumbUrl } from './thumbnails';
import { desktop, isMac, key, toFile } from './desktop';
import {
  inspectPdf,
  setFieldValues,
  type FieldValues,
  type FormInfo,
} from './forms';
import { showPrintDialog, type PrintBridge } from './print';
import {
  type AvailableUpdate,
  checkForUpdates,
  knownUpdate,
  isRemindLater,
  onUpdateAvailable,
  remindLater,
  scheduleUpdateCheck,
} from './updates';
import {
  findShortcut,
  formatCombo,
  keysFor,
  SHORTCUTS,
  type KeyInput,
} from './keymap';
import {
  getPrefs,
  noteToolUsed,
  setPrefs,
  togglePinned,
  type Prefs,
} from './prefs';
import {
  applyTheme,
  getThemePref,
  onThemeChange,
  setThemePref,
  type ThemePref,
} from '../reskin/theme';
import { toolsOrigin } from '../reskin/origins';
import { initTooltips } from '../reskin/tooltip';
import {
  clearRecent,
  forgetRecent,
  listRecent,
  rememberFile,
  reopenRecent,
  updateRecent,
  type RecentFile,
} from './recent';

const REPO_URL = `https://github.com/${__PAPERWING_REPO__}`;
const WEBSITE_URL = 'https://paperwingapp.com';

/* ------------------------------------------------------------------ */
/* DOM helpers                                                         */
/* ------------------------------------------------------------------ */

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, any> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function')
      el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') (el as any)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

function hydrateIcons(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => {
    if (el.querySelector(':scope > .ic')) return;
    el.prepend(icon(el.dataset.icon as IconName));
  });
  root.querySelectorAll<HTMLElement>('[data-icon-after]').forEach((el) => {
    if (el.querySelector(':scope > .ic')) return;
    el.append(icon(el.dataset.iconAfter as IconName, 16));
  });
}

function iconBtn(
  name: IconName,
  title: string,
  onClick: (e: MouseEvent) => void,
  cls = 'tb-btn'
) {
  return h(
    'button',
    { type: 'button', class: cls, title, 'aria-label': title, onClick },
    icon(name)
  );
}

function formatBytes(n: number) {
  if (!n) return '0 KB';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 3);
  return `${(n / 1024 ** i).toFixed(i ? (n / 1024 ** i < 10 ? 1 : 0) : 0)} ${units[i]}`;
}

function formatOpened(ts: number) {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return `Today, ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  return d.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
}

const isPdf = (f: { name: string; type?: string }) =>
  f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

/* ------------------------------------------------------------------ */
/* Popovers & toasts                                                   */
/* ------------------------------------------------------------------ */

interface MenuItem {
  label?: string;
  shortcut?: string;
  icon?: Node;
  disabled?: boolean;
  divider?: boolean;
  /** The current choice among the items (shown ticked) */
  checked?: boolean;
  onClick?: () => void;
}

let closePopover: (() => void) | null = null;

function showPopover(
  anchor: HTMLElement,
  content: HTMLElement,
  placement: 'below' | 'right' | 'left' = 'below'
) {
  closePopover?.();
  const layer = $('#popover-layer');
  const pop = h('div', { class: 'popover' }, content);
  layer.append(pop);
  const r = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  let left =
    placement === 'below'
      ? r.left
      : placement === 'left'
        ? r.left - pr.width - 6
        : r.right + 6;
  let top = placement === 'below' ? r.bottom + 4 : r.top;
  left = Math.max(8, Math.min(left, innerWidth - pr.width - 8));
  top = Math.max(8, Math.min(top, innerHeight - pr.height - 8));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  anchor.classList.add('is-open');

  const onDown = (e: Event) => {
    if (!pop.contains(e.target as Node) && !anchor.contains(e.target as Node))
      close();
  };
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
  const close = () => {
    pop.remove();
    anchor.classList.remove('is-open');
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', close);
    if (closePopover === close) closePopover = null;
  };
  // Escape works at once, even pressed right after opening; outside clicks
  // count from the next tick, so the click that opened it doesn't close it
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => {
    if (closePopover !== close) return; // already closed
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('blur', close);
  });
  closePopover = close;
  return pop;
}

function showMenu(
  anchor: HTMLElement,
  items: MenuItem[],
  placement?: 'below' | 'right' | 'left',
  /** Shown above the items (e.g. an input) */
  header?: HTMLElement
) {
  const list = h('div', { class: 'menu', role: 'menu' }, header);
  const choice = items.some((it) => it.checked !== undefined);
  for (const it of items) {
    if (it.divider) {
      list.append(h('div', { class: 'menu-div' }));
      continue;
    }
    list.append(
      h(
        'button',
        {
          type: 'button',
          class: `menu-item${it.checked ? ' is-checked' : ''}`,
          role: choice ? 'menuitemradio' : 'menuitem',
          'aria-checked': choice ? String(!!it.checked) : undefined,
          disabled: it.disabled,
          onClick: () => {
            closePopover?.();
            it.onClick?.();
          },
        },
        h('span', { class: 'mi-icon' }, it.icon),
        h('span', { class: 'mi-label' }, it.label),
        it.shortcut && h('span', { class: 'mi-key' }, it.shortcut),
        choice &&
          h('span', { class: 'mi-check' }, it.checked && icon('check', 14))
      )
    );
  }
  // Up/Down (and Home/End) move between items, as in any menu
  const entries = () =>
    [...list.querySelectorAll<HTMLButtonElement>('.menu-item')].filter(
      (b) => !b.disabled
    );
  list.addEventListener('keydown', (e) => {
    const all = entries();
    if (!all.length) return;
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === 'ArrowDown'
        ? all[(i + 1) % all.length]
        : e.key === 'ArrowUp'
          ? all[(i - 1 + all.length) % all.length]
          : e.key === 'Home'
            ? all[0]
            : e.key === 'End'
              ? all[all.length - 1]
              : null;
    if (next) {
      e.preventDefault();
      next.focus();
    }
  });
  const pop = showPopover(anchor, list, placement);
  const focusCurrent = () => {
    const all = entries();
    (all.find((b) => b.classList.contains('is-checked')) ?? all[0])?.focus();
  };
  // Opened from the keyboard: focus the current (or first) item
  if (anchor.matches(':focus-visible')) focusCurrent();
  // Opened with the mouse, the arrow keys still reach the items
  const fromAnchor = (e: KeyboardEvent) => {
    if (!pop.isConnected)
      return anchor.removeEventListener('keydown', fromAnchor);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      focusCurrent();
    }
  };
  anchor.addEventListener('keydown', fromAnchor);
  return pop;
}

function toast(
  message: string,
  action?: { label: string; onClick: () => void }
) {
  const el = h(
    'div',
    { class: 'toast', role: 'status' },
    h('span', {}, message),
    action &&
      h(
        'button',
        {
          type: 'button',
          onClick: () => {
            action.onClick();
            el.remove();
          },
        },
        action.label
      )
  );
  $('#toasts').append(el);
  setTimeout(() => el.classList.add('is-leaving'), 4200);
  setTimeout(() => el.remove(), 4600);
}

/** A downloaded update: stays until the user restarts or puts it off */
function updateReadyToast(version: string) {
  document.getElementById('update-toast')?.remove();
  const el = h(
    'div',
    { class: 'toast', role: 'status', id: 'update-toast' },
    h('span', {}, `Paperwing ${version} is ready to install`),
    h(
      'button',
      {
        type: 'button',
        onClick: async () => {
          el.remove();
          if (await prepareToQuit()) void desktop?.installUpdate?.();
        },
      },
      'Restart now'
    ),
    h('button', { type: 'button', onClick: () => el.remove() }, 'Later')
  );
  $('#toasts').append(el);
}

/** A newer version for a build that doesn't update itself (macOS, the
 *  portable build): stays until the user downloads it or puts it off */
function updateAvailableToast(update: AvailableUpdate) {
  document.getElementById('update-toast')?.remove();
  const el = h(
    'div',
    { class: 'toast', role: 'status', id: 'update-toast' },
    h('span', {}, `Paperwing ${update.version} is available`),
    h(
      'button',
      {
        type: 'button',
        onClick: () => {
          el.remove();
          getUpdate(update);
        },
      },
      update.auto ? 'Update' : 'Download'
    ),
    h(
      'button',
      {
        type: 'button',
        onClick: () => {
          el.remove();
          remindLater(update.version);
        },
      },
      'Later'
    )
  );
  $('#toasts').append(el);
}

/** The user agreed to update: the self-updating build downloads it (with
 *  progress, then the restart notice); others download the file */
function getUpdate(update: AvailableUpdate) {
  if (update.auto) void startUpdate(update);
  else downloadUpdate(update);
}

/** Download progress of the update the user chose */
let updateProgress: ReturnType<typeof statusToast> | null = null;

async function startUpdate(update: AvailableUpdate) {
  if (!desktop?.downloadUpdate || updateProgress) return;
  updateProgress = statusToast(`Downloading Paperwing ${update.version}…`);
  const stop = desktop.onUpdateProgress?.(({ percent }) => {
    if (percent != null)
      updateProgress?.update(
        `Downloading Paperwing ${update.version}… ${Math.floor(percent)}%`
      );
  });
  const result = await desktop.downloadUpdate().catch((err: unknown) => ({
    ok: false,
    error: String(err),
  }));
  stop?.();
  updateProgress?.close();
  updateProgress = null;
  // (when it worked, the "ready to install" notice is showing)
  if (!result.ok)
    toast(
      "Couldn't download the update. Try again from Help ▸ Check for updates."
    );
}

/** Fetches the new version's file for this platform (the browser saves it),
 *  or opens the release page when there isn't one */
function downloadUpdate(update: AvailableUpdate) {
  window.open(update.download ?? update.page, '_blank', 'noopener');
  if (!update.download) return;
  toast(
    /\.dmg$/i.test(update.download)
      ? `Downloading Paperwing ${update.version}. Open it and drag Paperwing to Applications, replacing the old one.`
      : `Downloading Paperwing ${update.version}. Unzip it and copy your Paperwing Data folder into it.`
  );
}

/** Until this build is updated, Help shows a dot and an Update/Download
 *  entry */
function showUpdateMarker(update: AvailableUpdate) {
  const help = $('#help-btn');
  help.classList.add('has-update');
  const label = `Help · Paperwing ${update.version} is available`;
  help.setAttribute('aria-label', label);
  // (the tooltip takes its text from title, or data-tip once it has moved it)
  help.setAttribute(help.hasAttribute('title') ? 'title' : 'data-tip', label);
}

/** A toast that stays until closed, with text that can change in place */
function statusToast(message: string) {
  const text = h('span', {}, message);
  const el = h('div', { class: 'toast', role: 'status' }, text);
  $('#toasts').append(el);
  return {
    update: (m: string) => (text.textContent = m),
    close: () => {
      el.classList.add('is-leaving');
      setTimeout(() => el.remove(), 400);
    },
  };
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

type PanelKind = 'all' | 'edit' | 'convert' | 'sign';

interface FrameTool {
  tool: AppTool;
  frame: HTMLIFrameElement;
  el: HTMLElement;
  files: File[];
  /** id of the tab the tool belongs to */
  owner: string;
  /** Shows the tool once it's ready, or after a while regardless */
  reveal: () => void;
  /** A full-page tool has work that hasn't come back as a result yet */
  dirty?: boolean;
}

interface Tab {
  id: string;
  name: string;
  /** Workspace without a document yet (a tool opened from Home, Create…) */
  blank: boolean;
  /** Search text in the All tools sidebar */
  toolQuery: string;
  handle?: FileSystemFileHandle;
  /** File path on disk (desktop app) */
  path?: string;
  recentId?: string;
  starred: boolean;
  loading: boolean;
  panel: PanelKind;
  panelOpen: boolean;
  /** container inside #left-panel */
  panelEl: HTMLElement;
  panelTool?: FrameTool;
  fullTool?: FrameTool;
  page: PageInfo;
  activeAnnot: string | null;
  /** Incremented on every edit; compared with savedVersion for "unsaved" */
  version: number;
  savedVersion: number;
  /** Restored from the last session: the document loads when first shown */
  pending?: RecentFile;
  /** Not saved to disk yet (a tool's result): its recovery copy, kept until
   *  it's saved or discarded (see main.cjs) */
  recoveryId?: string;
  /** Where the document is: page and zoom are remembered from here on */
  tracksView?: boolean;
  /** Workspace running a tool on several files at once: each result opens
   *  in a tab of its own and the tool stays */
  batch?: boolean;
  /** Earlier and undone versions of the pages (thumbnails panel changes) */
  pageUndo?: ArrayBuffer[];
  pageRedo?: ArrayBuffer[];
  /** A page change is being applied */
  pageBusy?: boolean;
  /** Pages selected in the thumbnails (0-based), when more than one */
  pageSel?: Set<number>;
  /** Where a Shift+click range starts */
  pageAnchor?: number;
  /** Fingerprint of the file on disk as this tab last read or wrote it.
   *  Opening the file again compares it with the file now (refreshIfChanged) */
  diskHash?: Promise<string | undefined>;
  /** Another app saved the file since: the fingerprint of that version (the
   *  disk bar offers it), and the version whose notice was dismissed */
  diskChanged?: string;
  diskDismissed?: string;
  /** The shown version's form fields (null: none), see inspectDoc */
  form?: FormInfo | null;
  /** The form fields panel is open */
  formOpen?: boolean;
  /** The document has scripts Paperwing doesn't run; the notice about
   *  them was dismissed */
  scripted?: boolean;
  scriptDismissed?: boolean;
}

const isDirty = (t: Tab) => t.version !== t.savedVersion;

const tabs: Tab[] = [];
let activeId = 'home';
let tabSeq = 0;

const viewer = new Viewer($('#viewer-host'));
/** Home's previews of recent files; made in the background only on Home */
const thumbs = new Thumbnails(
  () => activeId === 'home' && !document.hidden,
  (id, url) => {
    const cell = document.querySelector(
      `#recent-list [data-id="${CSS.escape(id)}"] .rr-file`
    );
    cell?.replaceChildren(thumbImg(url));
  }
);
const activeTab = () => tabs.find((t) => t.id === activeId);
/** The active tab if it holds a document (not an empty workspace) */
const activeDoc = () => {
  const t = activeTab();
  return t && !t.blank ? t : undefined;
};

/* ------------------------------------------------------------------ */
/* Title bar & tabs                                                    */
/* ------------------------------------------------------------------ */

/**
 * Files with the same name in different folders ("Resume.pdf" from two job
 * folders) look alike. For each item, the end of its folder path that tells it
 * apart from the others with its name ("Globex", "Acme › Product Manager"),
 * leaving out folders they all share; '' for names that are unique.
 */
function folderHints(items: { name: string; path?: string }[]): string[] {
  const hints = items.map(() => '');
  const groups = new Map<string, number[]>();
  items.forEach((it, i) => {
    if (!it.path) return;
    const k = it.name.toLowerCase();
    groups.set(k, [...(groups.get(k) ?? []), i]);
  });
  for (const group of groups.values()) {
    const dirs = group.map((i) => items[i].path!.split(/[\\/]/).slice(0, -1));
    const keys = dirs.map((d) => d.map((s) => s.toLowerCase()));
    if (new Set(keys.map((k) => k.join('/'))).size < 2) continue;
    // Folders at the end of every path ("…\Product Manager") don't help
    let common = 0;
    while (
      keys.every((k) => k.length > common) &&
      keys.every(
        (k) => k[k.length - 1 - common] === keys[0][keys[0].length - 1 - common]
      )
    )
      common++;
    dirs.forEach((d, j) => {
      const own = d.slice(0, d.length - common);
      const ownKey = keys[j].slice(0, keys[j].length - common);
      // The fewest folders (from the end) that no other file shares
      let n = 1;
      while (
        n < own.length &&
        keys.some(
          (k, o) =>
            o !== j &&
            k
              .slice(0, k.length - common)
              .slice(-n)
              .join('/') === ownKey.slice(-n).join('/')
        )
      )
        n++;
      hints[group[j]] = own.slice(-n).join(' › ');
    });
  }
  return hints;
}

function renderTabs() {
  const strip = $('#tabs');
  const hints = folderHints(
    tabs.map((t) => ({ name: t.name, path: t.blank ? undefined : t.path }))
  );
  strip.replaceChildren(
    ...tabs.map((t, i) => {
      const where = t.path ?? t.name;
      const el = h(
        'div',
        {
          class: `tab${t.id === activeId ? ' is-active' : ''}${isDirty(t) ? ' is-dirty' : ''}`,
          role: 'tab',
          'aria-selected': String(t.id === activeId),
          title: !isDirty(t)
            ? where
            : t.blank || t.path || t.handle
              ? `${where} (unsaved changes)`
              : `${t.name} (not saved yet)`,
          draggable: 'true',
          onDragstart: (e: DragEvent) => {
            e.dataTransfer!.setData('application/x-paperwing-tab', t.id);
            e.dataTransfer!.effectAllowed = 'move';
          },
          onDragover: (e: DragEvent) => {
            if (e.dataTransfer?.types.includes('application/x-paperwing-tab')) {
              e.preventDefault();
            }
          },
          onDrop: (e: DragEvent) => {
            const from = e.dataTransfer?.getData('application/x-paperwing-tab');
            if (!from || from === t.id) return;
            e.preventDefault();
            e.stopPropagation();
            const fromIdx = tabs.findIndex((x) => x.id === from);
            const toIdx = tabs.findIndex((x) => x.id === t.id);
            const [item] = tabs.splice(fromIdx, 1);
            tabs.splice(toIdx, 0, item);
            renderTabs();
            persistSession();
          },
          onMousedown: (e: MouseEvent) => {
            if (e.button === 1) {
              e.preventDefault();
              void requestCloseTab(t.id);
            }
          },
          onContextmenu: (e: MouseEvent) => tabMenu(t, e),
          onClick: () => activate(t.id),
        },
        !t.blank
          ? h(
              'button',
              {
                type: 'button',
                class: `tab-star${t.starred ? ' is-on' : ''}`,
                title: t.starred ? 'Unstar' : 'Star',
                'aria-label': 'Star',
                onClick: (e: MouseEvent) => {
                  e.stopPropagation();
                  toggleStar(t);
                },
              },
              icon('star', 14)
            )
          : h(
              'span',
              { class: 'tab-glyph' },
              t.panelTool || t.fullTool
                ? toolIcon(
                    (t.panelTool ?? t.fullTool)!.tool.icon,
                    (t.panelTool ?? t.fullTool)!.tool.color,
                    14
                  )
                : icon('grid', 14)
            ),
        h('span', { class: 'tab-label' }, t.name),
        hints[i] && h('span', { class: 'tab-hint' }, hints[i]),
        iconBtn(
          'close',
          'Close tab',
          (e) => {
            e.stopPropagation();
            void requestCloseTab(t.id);
          },
          'tab-close'
        )
      );
      return el;
    })
  );
  $('#home-btn').classList.toggle('is-active', activeId === 'home');
  strip
    .querySelector('.tab.is-active')
    ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  syncWatchedFiles();
}

function activate(id: string) {
  closePopover?.();
  activeId = id;
  const tab = activeTab();

  document
    .querySelectorAll<HTMLElement>('.view')
    .forEach((v) => v.classList.remove('is-active'));
  const viewId = id === 'home' ? 'view-home' : 'view-doc';
  $(`#${viewId}`).classList.add('is-active');

  // Per-tab frames stay in the DOM (detaching an iframe reloads it)
  document.querySelectorAll<HTMLElement>('[data-owner]').forEach((el) => {
    el.hidden = el.dataset.owner !== id;
  });

  if (id === 'home') refreshRecent();
  if (tab) {
    if (tab.pending) void loadPending(tab);
    else if (!tab.blank) void viewer.activate(tab.id);
    renderDocChrome(tab);
  }
  renderTabs();
  document.title = tab ? `${tab.name} - Paperwing` : 'Paperwing';
}

/** Recently closed documents (recent-file ids), for Ctrl+Shift+T */
const closedDocs: string[] = [];

/** Close a tab, asking first if it has unsaved changes */
async function requestCloseTab(id: string): Promise<boolean> {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return true;
  if (!(await mayDiscardTool(tab))) return false;
  if (isDirty(tab)) {
    activate(id);
    const choice = await confirmUnsaved([tab]);
    if (choice === 'cancel') return false;
    if (choice === 'save' && !(await saveDoc(tab))) return false;
  }
  closeTab(id);
  return true;
}

function closeTab(id: string) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const tab = tabs[i];
  tabs.splice(i, 1);
  if (tab.recentId) {
    closedDocs.push(tab.recentId);
    if (closedDocs.length > 20) closedDocs.shift();
  }
  document
    .querySelectorAll(`[data-owner="${CSS.escape(id)}"]`)
    .forEach((el) => el.remove());
  void flushView(tab); // reads the viewer, so before it closes the document
  cancelRecoveryCopy(tab);
  viewer.close(tab.id);
  if (tab.recoveryId) void desktop?.recovery?.delete(tab.recoveryId);
  if (activeId === id) {
    const next = tabs[Math.min(i, tabs.length - 1)];
    activate(next ? next.id : 'home');
  } else {
    renderTabs();
  }
  persistSession();
}

/** Right-click menu of a tab */
function tabMenu(tab: Tab, e: MouseEvent) {
  e.preventDefault();
  const others = tabs.filter((t) => t !== tab);
  const right = tabs.slice(tabs.indexOf(tab) + 1);
  const items: MenuItem[] = [
    {
      label: 'Close',
      shortcut: shortcutLabel('close'),
      onClick: () => void requestCloseTab(tab.id),
    },
    {
      label: 'Close other tabs',
      disabled: !others.length,
      onClick: () => void closeTabs(others),
    },
    {
      label: 'Close tabs to the right',
      disabled: !right.length,
      onClick: () => void closeTabs(right),
    },
  ];
  if (tab.path && desktop?.showInFolder) {
    items.push(
      { divider: true },
      {
        label: isMac ? 'Show in Finder' : 'Show in File Explorer',
        onClick: () => void desktop!.showInFolder!(tab.path!),
      },
      {
        label: 'Copy path',
        onClick: () => void navigator.clipboard.writeText(tab.path!),
      }
    );
  }
  items.push(
    { divider: true },
    {
      label: 'Reopen closed document',
      shortcut: shortcutLabel('reopen'),
      disabled: !closedDocs.length,
      onClick: () => void reopenClosedTab(),
    }
  );
  showMenu(menuPoint(e.clientX, e.clientY), items, 'below');
}

async function reopenClosedTab() {
  const recentId = closedDocs.pop();
  if (!recentId) return toast('No recently closed documents');
  const entry = (await listRecent()).find((r) => r.id === recentId);
  if (entry) await openRecent(entry);
}

async function toggleStar(tab: Tab) {
  tab.starred = !tab.starred;
  if (tab.recentId) await updateRecent(tab.recentId, { starred: tab.starred });
  renderTabs();
}

/* ------------------------------------------------------------------ */
/* Opening files                                                       */
/* ------------------------------------------------------------------ */

interface FileSource {
  handle?: FileSystemFileHandle;
  path?: string;
}

async function pickFiles(): Promise<({ file: File } & FileSource)[]> {
  if (desktop) {
    const picked = await desktop.openDialog();
    return picked.map((f) => ({ file: toFile(f), path: f.path }));
  }
  const picker = (window as any).showOpenFilePicker;
  if (picker) {
    try {
      const handles: FileSystemFileHandle[] = await picker({
        multiple: true,
        types: [
          { description: 'PDF files', accept: { 'application/pdf': ['.pdf'] } },
        ],
      });
      return Promise.all(
        handles.map(async (handle) => ({
          file: await handle.getFile(),
          handle,
        }))
      );
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return [];
    }
  }
  const input = $<HTMLInputElement>('#open-input');
  input.value = '';
  return new Promise((resolve) => {
    input.onchange = () =>
      resolve(Array.from(input.files ?? []).map((file) => ({ file })));
    input.click();
  });
}

async function openFromDialog() {
  // The first file fills an empty workspace if that's where we are
  let into = activeTab()?.blank ? activeTab() : undefined;
  for (const { file, ...source } of await pickFiles()) {
    await openDocument(file, source, undefined, into);
    into = undefined;
  }
}

/** An already-open tab for the same file on disk, if any */
async function findOpenTab(
  source: FileSource,
  except?: Tab
): Promise<Tab | undefined> {
  for (const t of tabs) {
    if (t === except) continue;
    if (source.path && t.path === source.path) return t;
    if (
      source.handle &&
      t.handle &&
      (await t.handle.isSameEntry(source.handle))
    )
      return t;
  }
  return undefined;
}

/** Create a tab (document or empty workspace) and its tools panel */
function createTab(name: string, blank: boolean): Tab {
  const id = `doc-${++tabSeq}`;
  const panelEl = h('div', { class: 'lp', dataset: { owner: id } });
  $('#left-panel').append(panelEl);
  const tab: Tab = {
    id,
    name,
    blank,
    toolQuery: '',
    starred: false,
    loading: !blank,
    panel: 'all',
    panelOpen: true,
    panelEl,
    page: { current: 1, total: 0 },
    activeAnnot: null,
    version: 0,
    savedVersion: 0,
  };
  tabs.push(tab);
  return tab;
}

/** An empty workspace tab with the tools sidebar */
function newWorkspace(name = 'Tools'): Tab {
  const tab = createTab(name, true);
  activate(tab.id);
  return tab;
}

async function openDocument(
  file: File,
  source: FileSource = {},
  recentId?: string,
  /** Load into this empty workspace (or restored tab) instead of a new tab */
  into?: Tab,
  /** Not on disk (a tool's result, a file dragged from a browser): it opens
   *  unsaved, stays out of Recent, and keeps a recovery copy until it's
   *  saved or discarded. recoveryId: reopening an existing copy */
  unsaved?: { recoveryId?: string }
): Promise<Tab | undefined> {
  const existing = await findOpenTab(source, into);
  if (existing) {
    activate(existing.id);
    await refreshIfChanged(existing, file);
    return existing;
  }
  let tab: Tab;
  if (into && (into.blank || into.loading) && tabs.includes(into)) {
    tab = into;
    tab.blank = false;
    tab.loading = true;
    tab.name = file.name;
  } else {
    tab = createTab(file.name, false);
  }
  tab.handle = source.handle;
  tab.path = source.path;
  tab.recentId = recentId;
  tab.recoveryId = unsaved?.recoveryId;
  const id = tab.id;
  activate(id);

  try {
    performance.mark('pw:open-start');
    const view = unsaved ? undefined : await lastView(source, recentId);
    await viewer.open(id, await file.arrayBuffer(), view);
    performance.mark('pw:doc-opened');
  } catch (err) {
    if (tabs.includes(tab)) {
      if (!(err instanceof OpenCancelled)) {
        console.error(err);
        toast(`Couldn't open ${file.name}`);
      }
      closeTab(id);
    }
    return undefined;
  }
  // Closed while it was loading
  if (!tabs.includes(tab)) return undefined;
  if (!unsaved && (source.path || source.handle)) {
    tab.diskHash = fingerprint(file);
    syncWatchedFiles();
  }
  tab.loading = false;
  tab.page = viewer.pageInfo(id) ?? tab.page;
  if (activeId === id) renderDocChrome(tab);
  else renderTabs();
  void inspectDoc(tab, file.arrayBuffer(), true);

  if (unsaved) {
    tab.savedVersion = -1; // shows as unsaved; closing asks first
    renderTabs();
    tab.recoveryId ??= await keepRecoveryCopy(file);
    return tab;
  }

  tab.recentId = (await rememberFile(file, source)) ?? recentId;
  persistSession();
  // Remember the page and zoom from here on (after the view has settled, so
  // the first layout doesn't overwrite where it was left)
  setTimeout(() => (tab.tracksView = true), 1500);
  const entry = (await listRecent()).find((r) => r.id === tab.recentId);
  if (entry?.starred) {
    tab.starred = true;
    renderTabs();
  }
  return tab;
}

/** SHA-256 of a file's contents; undefined if it can't be read */
async function fingerprint(
  data: Blob | Uint8Array<ArrayBuffer>
): Promise<string | undefined> {
  try {
    const bytes = data instanceof Blob ? await data.arrayBuffer() : data;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return undefined;
  }
}

/**
 * A file that's already open was opened again (from Explorer or Finder, Open
 * or Recent). If it changed on disk since this tab read or saved it (another
 * app saved it again, like a resume regenerated under the same name), show
 * the new version: straight away if nothing here is unsaved, else after asking.
 */
async function refreshIfChanged(tab: Tab, file: File): Promise<void> {
  // A restored tab reads the file when it's first shown; a loading one is
  // reading it now
  if (tab.pending || tab.loading || tab.pageBusy || !tab.diskHash) return;
  const [was, now] = await Promise.all([tab.diskHash, fingerprint(file)]);
  if (!was || !now || was === now || !tabs.includes(tab)) return;

  if (isDirty(tab) || tab.fullTool?.dirty) {
    if (activeId !== tab.id) activate(tab.id);
    const reload = await askDialog(
      `${tab.name} has changed`,
      'The file was changed on disk since you opened it here. Load the new version? Your unsaved changes in Paperwing will be lost.',
      [
        { label: 'Keep my version', value: false, kind: 'secondary' },
        { label: 'Load new version', value: true, kind: 'primary' },
      ],
      false
    );
    if (!reload || !tabs.includes(tab) || tab.pageBusy) {
      // Decided: no notice about this version
      tab.diskDismissed = now;
      renderDiskBar();
      return;
    }
  }

  const panel = viewer.activePanel(tab.id);
  const zoom = viewer.zoom(tab.id) ?? 1;
  const panelTool = tab.panelTool?.tool;
  const fullTool = tab.fullTool?.tool;
  tab.pageBusy = true;
  try {
    await viewer.replace(tab.id, await file.arrayBuffer(), {
      page: tab.page.current || 1,
      zoom,
    });
  } catch (err) {
    console.error(err);
    toast(`Couldn't load the new version of ${tab.name}`);
    return;
  } finally {
    tab.pageBusy = false;
  }
  if (!tabs.includes(tab)) return;
  void inspectDoc(tab, file.arrayBuffer());
  if (panel) viewer.toggleSidebar(tab.id, panel.id, panel.tab);
  tab.diskHash = Promise.resolve(now);
  tab.diskChanged = tab.diskDismissed = undefined;
  renderDiskBar();
  tab.page = viewer.pageInfo(tab.id) ?? tab.page;
  // What's shown is what's on disk: nothing to save, nothing to undo
  tab.savedVersion = tab.version;
  tab.pageUndo = [];
  tab.pageRedo = [];
  setPageSelection(tab, null);
  cancelRecoveryCopy(tab);
  if (tab.recoveryId) {
    void desktop?.recovery?.delete(tab.recoveryId);
    tab.recoveryId = undefined;
  }
  if (tab.recentId) void thumbs.invalidate(tab.recentId);
  renderTabs();
  if (activeId === tab.id) renderDocChrome(tab);
  toast(`Loaded the latest version of ${tab.name}`);
  // Tools took a copy of the old version when they opened: reopen them on
  // the new one
  if (fullTool) {
    disposeFrameTool(tab.fullTool);
    tab.fullTool = undefined;
  }
  if (panelTool) await openToolOnDoc(tab, panelTool);
  if (fullTool) await openToolOnDoc(tab, fullTool);
}

/* Files changed by other apps while open ------------------------------ */

/** Tell the desktop shell which files are open, so it reports changes */
let watchedKey = '';
function syncWatchedFiles() {
  if (!desktop?.watchFiles) return;
  const paths = [
    ...new Set(
      tabs.filter((t) => t.path && !t.blank && !t.pending).map((t) => t.path!)
    ),
  ];
  const key = paths.join('\n');
  if (key === watchedKey) return;
  watchedKey = key;
  void desktop.watchFiles(paths);
}

/** A watched file changed: if it's no longer what its tab shows, say so */
async function noticeDiskChange(path: string): Promise<void> {
  const open = tabs.filter(
    (t) => t.path === path && t.diskHash && !t.pending && !t.loading
  );
  if (!open.length || !desktop?.fileHash) return;
  const now = await desktop.fileHash(path).catch((): null => null);
  for (const tab of open) {
    const was = await tab.diskHash;
    if (!tabs.includes(tab)) continue;
    // Gone (deleted, or mid-save): nothing to offer
    tab.diskChanged = now && was && now !== was ? now : undefined;
  }
  renderDiskBar();
}

/** The notice over the active document when another app saved its file */
function renderDiskBar(): void {
  const tab = activeTab();
  const show =
    !!tab?.diskChanged && tab.diskChanged !== tab.diskDismissed && !tab.loading;
  let bar = document.getElementById('disk-bar');
  if (!show) {
    bar?.remove();
    return;
  }
  if (!bar) {
    bar = h('div', { id: 'disk-bar', role: 'status' });
    $('#doc-stage').append(bar);
  }
  bar.replaceChildren(
    h('span', { class: 'db-text' }, `${tab.name} was changed by another app.`),
    h(
      'button',
      {
        type: 'button',
        class: 'accent-btn db-reload',
        onClick: (): void => void reloadFromDisk(tab),
      },
      'Reload'
    ),
    iconBtn(
      'close',
      'Dismiss',
      () => {
        tab.diskDismissed = tab.diskChanged;
        renderDiskBar();
      },
      'db-close'
    )
  );
}

/* Form fields and scripts ------------------------------------------------ */

/** The latest inspection of each tab (an older one finishing late is
 *  ignored) */
const inspections = new WeakMap<Tab, number>();

/** Reads what the shown version of a document holds beside its pages: form
 *  fields to fill in, and scripts Paperwing doesn't run */
async function inspectDoc(
  tab: Tab,
  bytes: ArrayBuffer | Promise<ArrayBuffer>,
  opened = false
): Promise<void> {
  const seq = (inspections.get(tab) ?? 0) + 1;
  inspections.set(tab, seq);
  let info: Awaited<ReturnType<typeof inspectPdf>>;
  try {
    info = await inspectPdf(await bytes);
  } catch (err) {
    console.warn(`Couldn't read the form of ${tab.name}`, err);
    info = { form: null, scripted: false };
  }
  if (inspections.get(tab) !== seq || !tabs.includes(tab)) return;
  tab.form = info.form;
  tab.scripted = info.scripted;
  if (!tab.form) tab.formOpen = false;
  if (activeId === tab.id) {
    renderRightRail(tab);
    renderScriptBar();
    renderFormPanel();
  }
  if (opened && !tab.formOpen && tab.form?.fields.some((f) => !f.readOnly))
    toast(`${tab.name} has form fields you can fill in`, {
      label: 'Fill in',
      onClick: () => toggleFormPanel(tab, true),
    });
}

/** The notice over a document with scripts (document JavaScript, actions
 *  when it opens, field or page actions): none of them run here */
function renderScriptBar(): void {
  const tab = activeTab();
  const show =
    !!tab?.scripted && !tab.scriptDismissed && !tab.loading && !tab.blank;
  let bar = document.getElementById('script-bar');
  if (!show) {
    bar?.remove();
    return;
  }
  if (!bar) {
    bar = h('div', { id: 'script-bar', role: 'status' });
    $('#doc-stage').append(bar);
  }
  bar.replaceChildren(
    h(
      'span',
      {
        class: 'db-text',
        title:
          'Calculations, checks, pop-ups or other actions its author added will not happen.',
      },
      'This document has scripted instructions that Paperwing does not run.'
    ),
    iconBtn(
      'close',
      'Dismiss',
      () => {
        tab.scriptDismissed = true;
        renderScriptBar();
      },
      'db-close'
    )
  );
}

function toggleFormPanel(tab: Tab, open = !tab.formOpen) {
  tab.formOpen = open && !!tab.form;
  if (activeId !== tab.id) return;
  renderFormPanel();
  renderRightRail(tab);
  // The panel narrows the document: zoom out if its page no longer fits
  const zoom = viewer.zoom(tab.id);
  const pageWidth = viewer.docInfo(tab.id)?.width;
  const room = $('#viewer-host').clientWidth - 96;
  if (tab.formOpen && zoom && pageWidth && room > 0 && pageWidth * zoom > room)
    viewer.setZoom(tab.id, room / pageWidth);
}

/** The form fields panel beside the document: what's typed (or ticked) is
 *  written into the document when the field is left */
function renderFormPanel(): void {
  const tab = activeTab();
  const form = tab?.form;
  const show = !!form && !!tab?.formOpen && !tab.loading && !tab.blank;
  $('#doc-stage').classList.toggle('has-form-panel', show);
  let panel = document.getElementById('form-panel');
  if (!show) {
    panel?.remove();
    return;
  }
  // The same fields: only update the values (rebuilding would take the
  // focus away from the field being filled in)
  const key = [tab.id, form.locked, ...form.fields.map((f) => f.name)].join(
    '\n'
  );
  if (panel?.dataset.key === key) {
    for (const f of form.fields) {
      const input = panel.querySelector<HTMLInputElement>(
        `[data-field="${CSS.escape(f.name)}"]`
      );
      if (!input || input === document.activeElement) continue;
      if (f.kind === 'checkbox') input.checked = f.value === true;
      else input.value = String(f.value);
    }
    return;
  }
  const rows = form.fields.map((f, i) => {
    const id = `fp-field-${i}`;
    const disabled = f.readOnly || form.locked;
    const readOnly = f.readOnly ? h('small', {}, ' (read-only)') : null;
    const page = f.page
      ? h(
          'button',
          {
            type: 'button',
            class: 'fp-page',
            // Tab goes from field to field
            tabindex: '-1',
            title: `Go to page ${f.page}`,
            onClick: () => viewer.goToPage(tab.id, f.page),
          },
          `p. ${f.page}`
        )
      : null;
    if (f.kind === 'checkbox') {
      const input = h('input', {
        type: 'checkbox',
        id,
        checked: f.value === true,
        disabled,
        'data-field': f.name,
      });
      input.addEventListener('change', () =>
        fillFields(tab, { [f.name]: input.checked })
      );
      return h(
        'div',
        { class: 'fp-field is-check' },
        input,
        h('label', { for: id }, f.label, readOnly),
        page
      );
    }
    const input = h(f.multiline ? 'textarea' : 'input', {
      class: 'dlg-input',
      id,
      disabled,
      maxlength: f.maxLength,
      rows: f.multiline ? 3 : undefined,
      'data-field': f.name,
    });
    input.value = String(f.value);
    input.addEventListener('change', () =>
      fillFields(tab, { [f.name]: input.value })
    );
    return h(
      'div',
      { class: 'fp-field' },
      h('label', { for: id }, f.label, readOnly),
      page,
      input
    );
  });
  const next = h(
    'aside',
    { id: 'form-panel', 'aria-label': 'Form fields' },
    h(
      'div',
      { class: 'fp-head' },
      h('h2', {}, 'Form fields'),
      iconBtn('close', 'Close', () => toggleFormPanel(tab, false))
    ),
    h(
      'div',
      { class: 'fp-body' },
      form.locked &&
        h(
          'p',
          { class: 'muted' },
          "This document is protected, so its form can't be filled in here."
        ),
      ...rows,
      !form.locked &&
        form.other > 0 &&
        h(
          'p',
          { class: 'muted' },
          form.other === 1
            ? "1 other field (a choice, radio button or signature) can't be filled in here."
            : `${form.other} other fields (choices, radio buttons, signatures) can't be filled in here.`
        )
    )
  );
  next.dataset.key = key;
  if (panel) panel.replaceWith(next);
  else $('#doc-stage').append(next);
}

/** Form writes waiting their turn, per tab */
const formWrites = new WeakMap<Tab, Promise<void>>();

/** Writes form values into the document (see forms.ts), one change after
 *  another. The tab reopens on the result, unsaved, and Ctrl+Z takes it
 *  back as for page changes. */
function fillFields(tab: Tab, values: FieldValues) {
  const write = async () => {
    const failed = (message: string) => {
      toast(`Couldn't fill in the form: ${message}`);
      // Show what the document holds again
      if (activeId === tab.id) {
        document.getElementById('form-panel')?.remove();
        renderFormPanel();
      }
    };
    if (!tabs.includes(tab)) return;
    if (tab.loading || tab.blank || tab.fullTool || tab.pageBusy) {
      failed('the document is busy, try again');
      return;
    }
    tab.pageBusy = true;
    try {
      const before = await viewer.exportBytes(tab.id);
      if (!before) throw new Error('the document is still loading');
      const after = await setFieldValues(before, values);
      await showPageVersion(
        tab,
        after,
        tab.page.current || 1,
        viewer.scrollPos(tab.id)
      );
      tab.pageUndo = [...(tab.pageUndo ?? []), before].slice(-PAGE_UNDO_LIMIT);
      tab.pageRedo = [];
    } catch (err) {
      console.error(err);
      failed((err as Error).message ?? String(err));
    } finally {
      tab.pageBusy = false;
    }
  };
  formWrites.set(tab, (formWrites.get(tab) ?? Promise.resolve()).then(write));
}

/** Show the version of a tab's file that's on disk now (asks first if there
 *  are unsaved changes; see refreshIfChanged) */
async function reloadFromDisk(tab: Tab): Promise<void> {
  if (!tab.path || !desktop) return;
  const data = await desktop.readFile(tab.path).catch((): null => null);
  if (!data) {
    toast(`${tab.name} is no longer available`);
    tab.diskChanged = undefined;
    renderDiskBar();
    return;
  }
  const file = new File([new Uint8Array(data)], tab.name, {
    type: 'application/pdf',
  });
  await refreshIfChanged(tab, file);
}

/** Before saving over a tab's file: if another app saved it since this tab
 *  read it, saving would lose that version, so ask */
async function confirmOverwrite(tab: Tab): Promise<'save' | 'copy' | 'cancel'> {
  const was = await tab.diskHash;
  let now: string | null | undefined;
  try {
    now = tab.path
      ? await desktop?.fileHash?.(tab.path)
      : tab.handle
        ? await fingerprint(await tab.handle.getFile())
        : undefined;
  } catch {
    now = undefined;
  }
  if (!was || !now || was === now) return 'save';
  if (activeId !== tab.id) activate(tab.id);
  return askDialog<'save' | 'copy' | 'cancel'>(
    `A newer version of ${tab.name} is on disk`,
    'Another app saved this file after you opened it here. Saving now replaces that version with yours.',
    [
      { label: 'Cancel', value: 'cancel', kind: 'quiet' },
      { label: 'Save as a copy…', value: 'copy', kind: 'secondary' },
      { label: 'Replace it', value: 'save', kind: 'primary' },
    ],
    'cancel'
  );
}

/** Where a file was left last time, if that's wanted */
async function lastView(
  source: FileSource,
  recentId?: string
): Promise<DocView | undefined> {
  if (!getPrefs().restoreView || (!source.path && !recentId)) return undefined;
  const entry = (await listRecent()).find((r) =>
    source.path ? r.path === source.path : r.id === recentId
  );
  return entry?.view;
}

/** Saves where a document is (page, zoom) after it changes: at most every
 *  800 ms while scrolling, and straight away when its tab closes or the app
 *  quits (see flushView) */
const viewTimers = new Map<string, ReturnType<typeof setTimeout>>();
function noteView(tab: Tab) {
  if (!tab.tracksView || !tab.recentId || viewTimers.has(tab.id)) return;
  viewTimers.set(
    tab.id,
    setTimeout(() => {
      viewTimers.delete(tab.id);
      void saveView(tab);
    }, 800)
  );
}

function saveView(tab: Tab): Promise<void> | undefined {
  const zoom = viewer.zoom(tab.id);
  const page = viewer.pageInfo(tab.id)?.current;
  if (!tab.tracksView || !tab.recentId || !zoom || !page) return undefined;
  return updateRecent(tab.recentId, { view: { page, zoom } });
}

/** Save a pending view change now (before the document goes away) */
function flushView(tab: Tab): Promise<void> | undefined {
  if (!viewTimers.has(tab.id)) return undefined;
  clearTimeout(viewTimers.get(tab.id));
  viewTimers.delete(tab.id);
  return saveView(tab);
}

/** Recovery copy of a document that isn't on disk yet; returns its id */
async function keepRecoveryCopy(file: File): Promise<string | undefined> {
  const recovery = desktop?.recovery;
  if (!recovery) return undefined;
  try {
    const id = crypto.randomUUID();
    const data = new Uint8Array(await file.arrayBuffer());
    return (await recovery.save(id, file.name, data)) ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Unsaved edits (annotations, form fields, page changes…) are copied to the
 * recovery folder a few seconds after the latest change, so a crash can't
 * lose them: recoverUnsaved reopens them at the next launch. Saving or
 * discarding the document deletes its copy (saveDoc, closeTab).
 */
const RECOVERY_DELAY_MS = 4000;
const recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleRecoveryCopy(tab: Tab) {
  if (!desktop?.recovery || tab.blank || !isDirty(tab)) return;
  clearTimeout(recoveryTimers.get(tab.id));
  recoveryTimers.set(
    tab.id,
    setTimeout(() => void writeRecoveryCopy(tab), RECOVERY_DELAY_MS)
  );
}

function cancelRecoveryCopy(tab: Tab) {
  clearTimeout(recoveryTimers.get(tab.id));
  recoveryTimers.delete(tab.id);
}

/** "Report.pdf" -> "Report (Recovered).pdf" */
const recoveredName = (name: string) =>
  name.replace(/(\.pdf)?$/i, ' (Recovered)$1');

async function writeRecoveryCopy(tab: Tab) {
  recoveryTimers.delete(tab.id);
  const recovery = desktop?.recovery;
  if (!recovery || !tabs.includes(tab) || !isDirty(tab)) return;
  // Busy: try again shortly
  if (tab.loading || tab.pageBusy) return scheduleRecoveryCopy(tab);
  const bytes = await viewer.exportBytes(tab.id).catch((): null => null);
  if (!bytes || !tabs.includes(tab) || !isDirty(tab)) return;
  const id = (tab.recoveryId ??= crypto.randomUUID());
  // A file from disk comes back beside the original, not over it
  const name = tab.path || tab.handle ? recoveredName(tab.name) : tab.name;
  await recovery.save(id, name, new Uint8Array(bytes)).catch(() => false);
  // Saved or closed while it was being copied: the copy isn't wanted
  if (!tabs.includes(tab) || tab.recoveryId !== id || !isDirty(tab))
    void recovery.delete(id);
}

/** Unsaved documents left by a crash: reopen them, still unsaved */
async function recoverUnsaved() {
  const recovery = desktop?.recovery;
  if (!recovery) return;
  const found = await recovery
    .list()
    .catch((): { id: string; name: string }[] => []);
  let reopened = 0;
  for (const r of found) {
    const data = await recovery.read(r.id).catch((): null => null);
    if (!data) {
      void recovery.delete(r.id);
      continue;
    }
    const file = new File([new Uint8Array(data)], r.name, {
      type: 'application/pdf',
    });
    const tab = await openDocument(file, {}, undefined, undefined, {
      recoveryId: r.id,
    });
    if (tab) reopened++;
  }
  if (reopened)
    toast(
      reopened === 1
        ? 'Recovered 1 document with unsaved changes'
        : `Recovered ${reopened} documents with unsaved changes`
    );
}

async function openFiles(files: File[]) {
  const pdfs = files.filter(isPdf);
  const others = files.filter((f) => !isPdf(f));
  for (const f of pdfs) await openDocument(f);
  if (others.length) {
    const tool = toolForFile(others[0]) ?? getTool('image-to-pdf');
    if (tool) void openToolOnDoc(newWorkspace(tool.name), tool, others);
  }
}

/* ------------------------------------------------------------------ */
/* Tool frames                                                         */
/* ------------------------------------------------------------------ */

const frameTools = new Set<FrameTool>();
/** Tool pages run on their own origin in the desktop app (see origins.ts) */
const TOOLS_ORIGIN = toolsOrigin();

/** The tool frame a message came from, if it really came from one */
function frameToolFor(e: MessageEvent): FrameTool | undefined {
  if (e.origin !== TOOLS_ORIGIN || !e.source) return undefined;
  return [...frameTools].find((t) => t.frame.contentWindow === e.source);
}

function postToFrame(ft: FrameTool, message: unknown) {
  ft.frame.contentWindow?.postMessage(message, TOOLS_ORIGIN);
}

function createFrameTool(
  tool: AppTool,
  files: File[],
  owner: string
): FrameTool {
  const src = new URL(
    tool.href!,
    TOOLS_ORIGIN === location.origin ? location.href : `${TOOLS_ORIGIN}/`
  );
  // Whether it's in the side panel or the document area, the theme, and
  // whether a document is on its way (so the page lays out for it at once)
  src.searchParams.set('embed', tool.full ? 'full' : 'panel');
  src.searchParams.set('theme', getThemePref());
  if (files.length) src.searchParams.set('doc', '1');
  const frame = h('iframe', {
    class: 'tool-frame',
    src: src.href,
    title: tool.name,
    // A cross-origin frame needs these delegated: cross-origin isolation
    // (SharedArrayBuffer for the multi-threaded engines), clipboard, full
    // screen, and the installed fonts (Edit a PDF's "System fonts")
    allow:
      'cross-origin-isolated; clipboard-read; clipboard-write; fullscreen; local-fonts',
  });
  // Until the tool is ready (and has the document it was opened with), it
  // stays hidden behind a loading message: otherwise its page would show,
  // for a frame or two, before it's styled or while its upload box is
  // still empty
  const body = h(
    'div',
    { class: 'frame-body is-loading' },
    frame,
    h(
      'div',
      { class: 'frame-loading', role: 'status' },
      `Opening ${tool.name}…`
    )
  );
  const reveal = () => {
    clearTimeout(timer);
    body.classList.remove('is-loading');
  };
  const timer = setTimeout(reveal, REVEAL_TIMEOUT_MS);
  const ft: FrameTool = {
    tool,
    frame,
    files,
    owner,
    reveal,
    el: h('div', { class: 'frame-wrap' }, body),
  };
  ft.el.dataset.owner = owner;
  frameTools.add(ft);
  return ft;
}

/** Longest a tool stays hidden waiting to say it's ready */
const REVEAL_TIMEOUT_MS = 8000;

function disposeFrameTool(ft?: FrameTool) {
  if (!ft) return;
  frameTools.delete(ft);
  ft.el.remove();
}

window.addEventListener('message', async (e: MessageEvent) => {
  const ft = frameToolFor(e);
  if (!ft) return;
  if (e.data?.type === 'acro:ready') {
    // The theme may have changed since the frame's URL was made
    postToFrame(ft, { type: 'acro:theme', pref: getThemePref() });
    if (ft.files.length)
      postToFrame(ft, { type: 'acro:load-files', files: ft.files });
    else ft.reveal();
  } else if (e.data?.type === 'acro:files-loaded') {
    ft.reveal();
  } else if (e.data?.type === 'acro:dirty') {
    ft.dirty = !!e.data.dirty;
  } else if (e.data?.type === 'acro:download' && e.data.blob instanceof Blob) {
    const blob = e.data.blob;
    const name = uniqueTabName(String(e.data.name || 'download'));
    if (isPdf({ name, type: blob.type })) {
      const file = new File([blob], name, { type: 'application/pdf' });
      const owner = tabs.find((t) => t.id === ft.owner);
      if (owner?.blank && !owner.batch) {
        // A workspace tool (Combine, Create PDF…) made its first document:
        // show it right there, with the tools sidebar.
        disposeFrameTool(owner.panelTool);
        disposeFrameTool(owner.fullTool);
        owner.panelTool = owner.fullTool = undefined;
        const tab = await openDocument(file, {}, undefined, owner, {});
        if (tab) savePrompt(tab, `Created ${name}. It isn't saved yet`);
        return;
      }
      const tab = await openDocument(file, {}, undefined, undefined, {});
      if (tab)
        savePrompt(tab, `Opened ${name} in a new tab. It isn't saved yet`);
    } else {
      saveBlob(blob, name);
      toast(`Saved ${name}`);
    }
  }
});

/** Toast for a new document that isn't on disk yet, with a Save button */
function savePrompt(tab: Tab, message: string) {
  toast(message, {
    label: 'Save',
    onClick: () => {
      if (tabs.includes(tab)) void saveDoc(tab);
    },
  });
}

/** "report.pdf" -> "report (1).pdf" if a tab already uses that name */
function uniqueTabName(name: string) {
  const taken = new Set(tabs.map((t) => t.name));
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const [base, ext] =
    dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let i = 1; ; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** "Create PDF from…" converters take other file types, never the open PDF */
const isCreateTool = (tool: AppTool) =>
  !!catalogGroups
    .find((g) => g.name === 'Create a PDF')
    ?.tools.some((t) => t.id === tool.id);

/** Tools that can start without a PDF (they pick their own files) */
const STARTS_EMPTY = new Set([
  'merge-pdf',
  'alternate-merge',
  'overlay-pdf',
  'compare-pdfs',
  'pdf-to-zip',
  'pdf-workflow',
  'form-creator',
  'pdf-multi-tool',
  'wasm-settings',
]);
const startsEmpty = (tool: AppTool) =>
  isCreateTool(tool) || STARTS_EMPTY.has(tool.id);

declare const __PAPERWING_MULTI_FILE_PAGES__: string[];
const MULTI_FILE_PAGES = new Set(__PAPERWING_MULTI_FILE_PAGES__);

/** A tool that works on several PDFs in one go (not the full-page editors) */
const acceptsMany = (tool: AppTool) =>
  !!tool.href &&
  !tool.full &&
  MULTI_FILE_PAGES.has(tool.href.split('/').pop() || '');

/** Ask for PDFs, open the first into the workspace, then run the tool on it.
 *  Picking several for a tool that takes many runs it on all of them. */
async function pickThenRun(tab: Tab, tool: AppTool): Promise<boolean> {
  const picked = await pickFiles();
  if (!picked.length) return false;
  // Several PDFs for a tool that takes many: run it on all of them at once
  if (picked.length > 1 && acceptsMany(tool) && tab.blank) {
    tab.batch = true;
    mountTool(
      tab,
      tool,
      picked.map((p) => p.file)
    );
    return true;
  }
  const [first, ...rest] = picked;
  await openDocument(
    first.file,
    { handle: first.handle, path: first.path },
    undefined,
    tab
  );
  for (const r of rest)
    await openDocument(r.file, { handle: r.handle, path: r.path });
  const target = tab.blank ? activeDoc() : tab;
  if (target) {
    activate(target.id);
    await openToolOnDoc(target, tool);
  }
  return true;
}

/** Show a tool in a tab: options in the side panel, or the document area
 *  for tools that need a full canvas (the tools sidebar stays put). */
function mountTool(tab: Tab, tool: AppTool, files: File[]) {
  if (tool.full) {
    disposeFrameTool(tab.fullTool);
    const ft = createFrameTool(tool, files, tab.id);
    const head = h(
      'div',
      { class: 'full-head' },
      toolIcon(tool.icon, tool.color, 20),
      h('span', { class: 'fh-title' }, tool.name),
      h('span', { class: 'fh-file' }, tab.blank ? '' : tab.name),
      h(
        'button',
        {
          type: 'button',
          class: 'pill-btn',
          onClick: (): void => void closeFullTool(tab),
        },
        'Close'
      )
    );
    ft.el.prepend(head);
    $('#tool-full').append(ft.el);
    tab.fullTool = ft;
  } else {
    disposeFrameTool(tab.panelTool);
    tab.panelTool = createFrameTool(tool, files, tab.id);
    tab.panelTool.el.removeAttribute('data-owner');
    tab.panelOpen = true;
  }
  if (tab.blank) tab.name = tool.name;
  renderTabs();
  renderDocChrome(tab);
}

/** Run a tool in a tab. With a document open it works on that document;
 *  in an empty workspace it either starts empty or asks for a PDF first. */
async function openToolOnDoc(tab: Tab, tool: AppTool, files: File[] = []) {
  noteToolUsed(tool.id, tool.name);
  if (!tool.href && !tool.action) return;

  if (tab.blank) {
    if (tool.href && startsEmpty(tool)) return mountTool(tab, tool, files);
    await pickThenRun(tab, tool);
    return;
  }
  // Converters from other formats get their own workspace
  if (isCreateTool(tool)) {
    return void openToolOnDoc(newWorkspace(tool.name), tool, files);
  }
  if (tool.action) return runViewerAction(tab, tool);
  if (tab.loading) return toast('The document is still loading…');

  // Another full-page tool replaces the open one
  if (tool.full && !(await mayDiscardTool(tab))) return;
  const bytes = await viewer.exportBytes(tab.id);
  const docFiles = bytes
    ? [new File([bytes], tab.name, { type: 'application/pdf' })]
    : [];
  mountTool(tab, tool, docFiles);
}

/** From Home, menus or the palette: use the open document, else a workspace */
async function runTool(tool: AppTool) {
  const current = activeTab();
  if (current) {
    await openToolOnDoc(current, tool);
    return;
  }
  const ws = newWorkspace(tool.name);
  await openToolOnDoc(ws, tool);
  // Picker cancelled: don't leave an empty tab behind
  if (ws.blank && !ws.panelTool && !ws.fullTool) closeTab(ws.id);
}

/** Open the searchable All tools sidebar (in a workspace if on Home) */
function showToolsSidebar(query = '') {
  const tab = activeTab() ?? newWorkspace('Tools');
  disposeFrameTool(tab.panelTool);
  tab.panelTool = undefined;
  tab.panel = 'all';
  tab.panelOpen = true;
  tab.toolQuery = query;
  renderDocChrome(tab);
  const input = tab.panelEl.querySelector<HTMLInputElement>('.lp-search input');
  input?.focus();
  input?.select();
}

/** A full-page tool with unsaved work: may it go? */
async function mayDiscardTool(tab: Tab): Promise<boolean> {
  const ft = tab.fullTool;
  if (!ft?.dirty) return true;
  if (activeId !== tab.id) activate(tab.id);
  return askDialog(
    `Discard changes in ${ft.tool.name}?`,
    `${ft.tool.name} has changes that haven't been saved yet. They'll be lost if you close it.`,
    [
      { label: 'Keep working', value: false, kind: 'secondary' },
      { label: 'Discard changes', value: true, kind: 'primary' },
    ],
    false
  );
}

async function closeFullTool(tab: Tab): Promise<boolean> {
  if (!(await mayDiscardTool(tab))) return false;
  disposeFrameTool(tab.fullTool);
  tab.fullTool = undefined;
  renderDocChrome(tab);
  return true;
}

async function runViewerAction(tab: Tab, tool: AppTool) {
  // Commenting and redacting happen in the viewer: leave a full-page tool
  // first (as picking another tool would), or they'd act out of sight
  if (tab.fullTool && !(await closeFullTool(tab))) return;
  if (tool.action === 'comment') {
    viewer.toggleSidebar(tab.id, 'comment-panel');
    if (tab.activeAnnot !== 'comment') useQuickTool(tab, 'comment', 'note');
  } else if (tool.action === 'redact') {
    viewer.command(tab.id, 'redaction:redact');
    viewer.toggleSidebar(tab.id, 'redaction-panel');
  }
}

/* ------------------------------------------------------------------ */
/* Document view                                                       */
/* ------------------------------------------------------------------ */

function panelGroups(kind: PanelKind): ToolGroup[] {
  switch (kind) {
    case 'edit':
      return editTools();
    case 'convert':
      return convertTools();
    case 'sign':
      return signTools();
    default:
      return [{ name: 'All tools', tools: quickTools() }];
  }
}

const PANEL_TITLES: Record<PanelKind, string> = {
  all: 'All tools',
  edit: 'Edit',
  convert: 'Convert',
  sign: 'E-Sign',
};

function renderLeftPanel(tab: Tab) {
  const el = tab.panelEl;
  $('#left-panel').classList.toggle('is-closed', !tab.panelOpen);
  $('#left-panel').classList.toggle('has-tool', !!tab.panelTool);

  if (tab.panelTool) {
    const t = tab.panelTool.tool;
    const head = h(
      'div',
      { class: 'lp-head lp-head-tool' },
      iconBtn('arrowLeft', 'Back to tools', () => {
        disposeFrameTool(tab.panelTool);
        tab.panelTool = undefined;
        renderLeftPanel(tab);
      }),
      h('span', { class: 'lp-title' }, t.name),
      iconBtn('expand', 'Open in full view', () => {
        disposeFrameTool(tab.panelTool);
        tab.panelTool = undefined;
        void openToolOnDoc(tab, { ...t, full: true });
      })
    );
    if (!el.contains(tab.panelTool.el)) {
      el.replaceChildren(head, tab.panelTool.el);
    } else {
      el.firstElementChild?.replaceWith(head);
    }
    return;
  }

  const head = h(
    'div',
    { class: 'lp-head' },
    h('span', { class: 'lp-title' }, PANEL_TITLES[tab.panel]),
    iconBtn('close', 'Close panel', () => {
      tab.panelOpen = false;
      renderDocChrome(tab);
    })
  );
  const body = h('div', { class: 'lp-body' });
  const list = h('div', { class: 'lp-list' });
  if (tab.panel === 'all') {
    const search = h('input', {
      type: 'search',
      placeholder: 'Find a tool',
      value: tab.toolQuery,
      'aria-label': 'Find a tool',
    });
    search.addEventListener('input', () => {
      tab.toolQuery = search.value;
      renderToolList(tab, list);
    });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter')
        list.querySelector<HTMLButtonElement>('.lp-tool')?.click();
      if (e.key === 'Escape' && search.value) {
        e.stopPropagation();
        search.value = '';
        tab.toolQuery = '';
        renderToolList(tab, list);
      }
    });
    body.append(h('label', { class: 'lp-search' }, icon('search', 16), search));
  }
  body.append(list);
  renderToolList(tab, list);
  el.replaceChildren(head, body);
}

/** Sidebar groups that are expanded (shared by all tabs) */
const openToolGroups = new Set<string>(['Popular']);

function toolRow(tab: Tab, tool: AppTool, redraw: () => void) {
  const isPinned = getPrefs().pinnedTools.includes(tool.id);
  const pin = h(
    'span',
    {
      class: `lp-pin${isPinned ? ' is-on' : ''}`,
      role: 'button',
      tabindex: '-1',
      title: isPinned ? 'Unpin' : 'Pin to top',
      'aria-label': isPinned ? 'Unpin' : 'Pin to top',
      onClick: (e: MouseEvent) => {
        e.stopPropagation();
        const on = togglePinned(tool.id);
        toast(on ? `Pinned ${tool.name}` : `Unpinned ${tool.name}`);
        redraw();
      },
    },
    icon('pin', 14)
  );
  return h(
    'button',
    {
      type: 'button',
      class: 'lp-tool',
      title: tool.desc,
      onClick: () => {
        // "Export a PDF" lists every export format, like Acrobat
        if (
          tab.panel === 'all' &&
          tool.id === 'pdf-to-word' &&
          tool.name === 'Export a PDF' &&
          !tab.blank
        ) {
          tab.panel = 'convert';
          return renderDocChrome(tab);
        }
        void openToolOnDoc(tab, tool);
      },
    },
    toolIcon(tool.icon, tool.color, 20),
    h('span', {}, tool.name),
    pin
  );
}

function renderToolList(tab: Tab, list: HTMLElement) {
  const redraw = () => renderToolList(tab, list);
  const q = tab.toolQuery.trim();
  const out: Node[] = [];

  if (tab.panel !== 'all') {
    const lists = panelGroups(tab.panel);
    for (const g of lists) {
      if (lists.length > 1) out.push(h('div', { class: 'lp-group' }, g.name));
      g.tools.forEach((t) => out.push(toolRow(tab, t, redraw)));
    }
    list.replaceChildren(...out);
    return;
  }

  if (q) {
    const results = searchTools(q);
    results.forEach((t) => out.push(toolRow(tab, t, redraw)));
    if (!results.length)
      out.push(h('div', { class: 'lp-empty' }, `No tools match “${q}”`));
    list.replaceChildren(...out);
    return;
  }

  const prefs = getPrefs();
  const pick = (ids: string[]) =>
    ids.map((id) => getTool(id)).filter((t): t is AppTool => !!t);
  const pinned = pick(prefs.pinnedTools);
  // Under the name they were opened with
  const recentUsed = pick(prefs.recentTools)
    .filter((t) => !prefs.pinnedTools.includes(t.id))
    .slice(0, 3)
    .map((t) => {
      const name = prefs.recentToolNames[t.id];
      return name ? { ...t, name } : t;
    });
  const flat = (name: string, tools: AppTool[]) => {
    if (!tools.length) return;
    out.push(h('div', { class: 'lp-group' }, name));
    tools.forEach((t) => out.push(toolRow(tab, t, redraw)));
  };
  flat('Pinned', pinned);
  flat('Recently used', recentUsed);

  const sections: ToolGroup[] = [
    { name: 'Popular', tools: quickTools() },
    ...catalogGroups,
    ...signTools(),
  ];
  for (const g of sections) {
    const open = openToolGroups.has(g.name);
    out.push(
      h(
        'button',
        {
          type: 'button',
          class: `lp-section${open ? ' is-open' : ''}`,
          'aria-expanded': String(open),
          onClick: () => {
            if (open) openToolGroups.delete(g.name);
            else openToolGroups.add(g.name);
            redraw();
          },
        },
        icon('chevronRight', 14),
        h('span', {}, g.name),
        h('span', { class: 'lp-count' }, String(g.tools.length))
      )
    );
    if (open) g.tools.forEach((t) => out.push(toolRow(tab, t, redraw)));
  }
  list.replaceChildren(...out);
}

function renderDocChrome(tab: Tab) {
  if (activeId !== tab.id) return;
  document
    .querySelectorAll<HTMLButtonElement>('#gb-tabs button')
    .forEach((b) =>
      b.classList.toggle(
        'is-active',
        tab.panelOpen && b.dataset.panel === tab.panel
      )
    );
  renderLeftPanel(tab);
  $('#doc-stage').classList.toggle('has-full-tool', !!tab.fullTool);
  // (the rail drives the viewer, which a full-page tool covers)
  $('#view-doc').classList.toggle('has-full-tool', !!tab.fullTool);
  $('#doc-stage').classList.toggle('is-loading', tab.loading);
  renderDiskBar();
  renderScriptBar();
  renderFormPanel();
  $('#doc-stage').classList.toggle('is-blank', tab.blank);
  $('#view-doc').classList.toggle('is-workspace', tab.blank);
  for (const id of ['#save-btn', '#print-btn', '#download-btn']) {
    $<HTMLButtonElement>(id).disabled = tab.blank;
  }
  renderQuickbar(tab);
  renderRightRail(tab);
}

$('#gb-tabs').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(
    'button[data-panel]'
  );
  const tab = activeTab();
  if (!btn || !tab) return;
  const kind = btn.dataset.panel as PanelKind;
  if (tab.panelOpen && tab.panel === kind && !tab.panelTool) {
    tab.panelOpen = false;
  } else {
    tab.panel = kind;
    tab.panelOpen = true;
    disposeFrameTool(tab.panelTool);
    tab.panelTool = undefined;
  }
  renderDocChrome(tab);
});

/* Quick action toolbar ------------------------------------------------ */

/** A tool on the quick toolbar */
interface QuickTool {
  id: string;
  label: string;
  icon: IconName;
  /** Viewer command that starts it */
  command?: string;
  /** Mouse mode it switches to (the Select button's tools) */
  mode?: ViewMode;
  /** Its keyboard shortcut (keymap id), shown in tooltips and menus */
  shortcut?: string;
}

/**
 * The quick toolbar's buttons. As in Acrobat, a button with several tools
 * has a small arrow: it (or a right-click, or pressing and holding the
 * button) opens the button's tools, and the one picked becomes the
 * button's tool until another is picked (remembered in prefs).
 */
const QUICK_GROUPS: { id: string; tools: QuickTool[] }[] = [
  {
    id: 'select',
    tools: [
      {
        id: 'select',
        label: 'Select',
        icon: 'select',
        mode: 'select',
        shortcut: 'toolSelect',
      },
      {
        id: 'hand',
        label: 'Hand',
        icon: 'hand',
        mode: 'hand',
        shortcut: 'toolHand',
      },
      {
        id: 'marquee',
        label: 'Marquee zoom',
        icon: 'marqueeZoom',
        mode: 'marquee',
        shortcut: 'toolZoom',
      },
    ],
  },
  {
    id: 'comment',
    tools: [
      {
        id: 'note',
        label: 'Add a comment',
        icon: 'comment',
        command: 'annotation:add-comment',
        shortcut: 'toolNote',
      },
      {
        id: 'stamp',
        label: 'Stamp',
        icon: 'stamp',
        command: 'annotation:add-stamp',
        shortcut: 'toolStamp',
      },
    ],
  },
  {
    id: 'highlight',
    tools: [
      {
        id: 'highlight',
        label: 'Highlight text',
        icon: 'highlight',
        command: 'annotation:add-highlight',
        shortcut: 'toolHighlight',
      },
      {
        id: 'underline',
        label: 'Underline text',
        icon: 'underline',
        command: 'annotation:add-underline',
      },
      {
        id: 'strikeout',
        label: 'Strikethrough text',
        icon: 'strikethrough',
        command: 'annotation:add-strikeout',
      },
      {
        id: 'squiggly',
        label: 'Squiggly underline',
        icon: 'squiggly',
        command: 'annotation:add-squiggly',
      },
      {
        id: 'marker',
        label: 'Highlighter pen',
        icon: 'marker',
        command: 'annotation:add-ink-highlighter',
      },
    ],
  },
  {
    id: 'ink',
    tools: [
      {
        id: 'ink',
        label: 'Draw freehand',
        icon: 'draw',
        command: 'annotation:add-ink',
        shortcut: 'toolDraw',
      },
      {
        id: 'line',
        label: 'Line',
        icon: 'line',
        command: 'annotation:add-line',
      },
      {
        id: 'arrow',
        label: 'Arrow',
        icon: 'arrow',
        command: 'annotation:add-arrow',
      },
      {
        id: 'rectangle',
        label: 'Rectangle',
        icon: 'rectangle',
        command: 'annotation:add-rectangle',
      },
      {
        id: 'oval',
        label: 'Oval',
        icon: 'oval',
        command: 'annotation:add-circle',
      },
      {
        id: 'polygon',
        label: 'Polygon',
        icon: 'polygon',
        command: 'annotation:add-polygon',
      },
    ],
  },
  {
    id: 'text',
    tools: [
      {
        id: 'text',
        label: 'Add text',
        icon: 'text',
        command: 'annotation:add-text',
        shortcut: 'toolText',
      },
      {
        id: 'callout',
        label: 'Text callout',
        icon: 'callout',
        command: 'annotation:add-callout',
      },
    ],
  },
  {
    id: 'sign',
    tools: [{ id: 'sign', label: 'Fill & Sign', icon: 'sign' }],
  },
];

const quickGroup = (id: string) => QUICK_GROUPS.find((g) => g.id === id)!;

/** The tool a button stands for now (the last one picked from its menu) */
function quickTool(groupId: string): QuickTool {
  const g = quickGroup(groupId);
  const picked = getPrefs().quickbarTools[groupId];
  return g.tools.find((t) => t.id === picked) ?? g.tools[0];
}

/** viewer annotation tool id -> quick toolbar button that activated it */
const buttonForTool = new Map<string, string>();
let pendingButton: string | null = null;

function runAnnotCommand(tab: Tab, button: string, command: string) {
  pendingButton = button;
  viewer.command(tab.id, command);
}

/** Press a toolbar button (its current tool), or pick `toolId` from its
 *  menu (which also makes it the button's tool) */
function useQuickTool(tab: Tab, groupId: string, toolId?: string) {
  const g = quickGroup(groupId);
  if (toolId && g.tools.length > 1) {
    setPrefs({
      quickbarTools: { ...getPrefs().quickbarTools, [groupId]: toolId },
    });
  }
  const t = toolId
    ? (g.tools.find((x) => x.id === toolId) ?? quickTool(groupId))
    : quickTool(groupId);
  if (groupId === 'sign') {
    const tool = getTool('sign-pdf');
    if (tool) void openToolOnDoc(tab, { ...tool, name: 'Fill & Sign' });
    return;
  }
  if (t.mode) {
    // Selecting, the hand or marquee zoom: leave any annotation tool
    if (tab.activeAnnot) viewer.setTool(tab.id, null);
    viewer.setMode(tab.id, t.mode);
  } else if (tab.activeAnnot === groupId && !toolId) {
    // Pressing the active button again goes back to selecting
    viewer.setTool(tab.id, null);
  } else if (t.command) {
    if (viewer.mode(tab.id) !== 'select') viewer.setMode(tab.id, 'select');
    runAnnotCommand(tab, groupId, t.command);
  }
  renderQuickbar(tab);
}

/** Back to selecting (Escape), or press a button */
function setAnnot(tab: Tab, groupId: string) {
  if (groupId !== 'select') return useQuickTool(tab, groupId);
  if (tab.activeAnnot) viewer.setTool(tab.id, null);
  viewer.setMode(tab.id, 'select');
  renderQuickbar(tab);
}

viewer.onActiveTool((tabId, toolId) => {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return;
  if (toolId && pendingButton) buttonForTool.set(toolId, pendingButton);
  pendingButton = null;
  tab.activeAnnot = toolId ? (buttonForTool.get(toolId) ?? 'more') : null;
  if (activeId === tabId) renderQuickbar(tab);
});

viewer.onMode((tabId) => {
  if (activeId === tabId) {
    const tab = tabs.find((t) => t.id === tabId);
    if (tab) renderQuickbar(tab);
  }
});

/** "Highlight text (U)" */
const withShortcut = (t: QuickTool) =>
  t.shortcut ? `${t.label} (${shortcutLabel(t.shortcut)})` : t.label;

function quickMenu(tab: Tab, groupId: string, anchor: HTMLElement) {
  const current = quickTool(groupId).id;
  showMenu(
    anchor,
    quickGroup(groupId).tools.map((t) => ({
      label: t.label,
      icon: icon(t.icon, 16),
      shortcut: t.shortcut ? shortcutLabel(t.shortcut) : undefined,
      checked: t.id === current,
      onClick: () => useQuickTool(tab, groupId, t.id),
    })),
    'right'
  );
}

function renderQuickbar(tab: Tab) {
  const bar = $('#quickbar');
  const grip = h('div', { class: 'qb-grip', title: 'Drag to move' });
  const mode = tab.loading || tab.blank ? 'select' : viewer.mode(tab.id);
  const buttons = QUICK_GROUPS.map((g) => {
    const t = quickTool(g.id);
    const active =
      g.id === 'select' ? !tab.activeAnnot : tab.activeAnnot === g.id;
    const shown =
      g.id === 'select' && active
        ? (g.tools.find((x) => x.mode === mode) ?? t)
        : t;
    const btn = h(
      'button',
      {
        type: 'button',
        class: `qb-btn${active ? ' is-active' : ''}`,
        title: withShortcut(shown),
        'aria-label': shown.label,
        'aria-pressed': String(active),
        onClick: () => useQuickTool(tab, g.id),
      },
      icon(shown.icon, 18)
    );
    if (g.tools.length < 2) return h('div', { class: 'qb-item' }, btn);
    const more = h(
      'button',
      {
        type: 'button',
        class: 'qb-arrow',
        title: `More ${g.id === 'select' ? 'selection' : 'related'} tools`,
        'aria-label': `More tools like ${shown.label}`,
        'aria-haspopup': 'menu',
        onClick: (e: MouseEvent) => {
          e.stopPropagation();
          quickMenu(tab, g.id, btn);
        },
      },
      icon('chevronDown', 10, 2.4)
    );
    // Right-click, or press and hold, opens the menu too (as in Acrobat)
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      quickMenu(tab, g.id, btn);
    });
    let hold = 0;
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      hold = window.setTimeout(() => {
        hold = -1;
        quickMenu(tab, g.id, btn);
      }, 450);
    });
    const endHold = () => {
      if (hold > 0) clearTimeout(hold);
    };
    btn.addEventListener('pointerup', endHold);
    btn.addEventListener('pointerleave', endHold);
    btn.addEventListener(
      'click',
      (e) => {
        // The press that opened the menu isn't also a click on the button
        if (hold === -1) {
          hold = 0;
          e.stopImmediatePropagation();
        }
      },
      true
    );
    return h('div', { class: 'qb-item has-menu' }, btn, more);
  });
  const more = h(
    'button',
    {
      type: 'button',
      class: `qb-btn${tab.activeAnnot === 'more' ? ' is-active' : ''}`,
      title: 'More tools',
      'aria-label': 'More tools',
      'aria-haspopup': 'menu',
    },
    icon('more', 18)
  );
  more.addEventListener('click', () =>
    showMenu(
      more,
      [
        {
          label: 'Add a link',
          shortcut: shortcutLabel('toolLink'),
          icon: icon('link', 16),
          onClick: () => runAnnotCommand(tab, 'more', 'annotation:add-link'),
        },
        { divider: true },
        {
          label: 'Undo',
          shortcut: key('Ctrl+Z'),
          icon: icon('undo', 16),
          onClick: () => stepEdit(tab, 'undo'),
        },
        {
          label: 'Redo',
          shortcut: key('Shift+Ctrl+Z'),
          icon: icon('redo', 16),
          onClick: () => stepEdit(tab, 'redo'),
        },
        {
          label: 'Delete selected',
          shortcut: 'Del',
          icon: icon('trash', 16),
          onClick: () => viewer.command(tab.id, 'annotation:delete-selected'),
        },
      ],
      'right'
    )
  );
  bar.replaceChildren(grip, ...buttons, h('div', { class: 'qb-item' }, more));
  makeDraggable(bar, grip);
  const pos = getPrefs().quickbarPos;
  if (pos) {
    const stage = $('#doc-stage');
    bar.style.left = `${Math.max(4, Math.min(pos.x, stage.clientWidth - 48))}px`;
    bar.style.top = `${Math.max(4, Math.min(pos.y, stage.clientHeight - 60))}px`;
  }
}

function makeDraggable(el: HTMLElement, handle: HTMLElement) {
  handle.onpointerdown = (e) => {
    const stage = el.parentElement!.getBoundingClientRect();
    const start = el.getBoundingClientRect();
    const dx = e.clientX - start.left;
    const dy = e.clientY - start.top;
    handle.setPointerCapture(e.pointerId);
    handle.onpointermove = (m) => {
      const x = Math.max(
        4,
        Math.min(m.clientX - dx - stage.left, stage.width - start.width - 4)
      );
      const y = Math.max(
        4,
        Math.min(m.clientY - dy - stage.top, stage.height - start.height - 4)
      );
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    };
    handle.onpointerup = () => {
      handle.onpointermove = null;
      handle.onpointerup = null;
      setPrefs({ quickbarPos: { x: el.offsetLeft, y: el.offsetTop } });
    };
  };
  // Double-click the grip to put the toolbar back
  handle.ondblclick = () => {
    el.style.left = '';
    el.style.top = '';
    setPrefs({ quickbarPos: null });
  };
}

/* Page thumbnails: right-click for page actions, drag to reorder ------ */

/** Undo steps kept for page changes, per document */
const PAGE_UNDO_LIMIT = 20;

/**
 * Changes a document's pages (see pages.ts): its current bytes, with any
 * annotations, go through `change` and the tab reopens on the result at
 * `page` (1-based). The previous version is kept for Ctrl+Z.
 */
async function changePages(
  tab: Tab,
  change: (bytes: ArrayBuffer) => Promise<ArrayBuffer>,
  page: number,
  done?: string,
  keepSelection = false
): Promise<boolean> {
  if (tab.loading || tab.blank || tab.fullTool || tab.pageBusy) return false;
  tab.pageBusy = true;
  try {
    const before = await viewer.exportBytes(tab.id);
    if (!before) throw new Error('the document is still loading');
    const after = await change(before);
    // Pages that moved or went away: the selection no longer fits them
    if (!keepSelection) setPageSelection(tab, null);
    await showPageVersion(tab, after, page);
    tab.pageUndo = [...(tab.pageUndo ?? []), before].slice(-PAGE_UNDO_LIMIT);
    tab.pageRedo = [];
    if (done)
      toast(done, {
        label: 'Undo',
        onClick: () => void stepPages(tab, 'undo'),
      });
    return true;
  } catch (err) {
    console.error(err);
    toast(
      /encrypt/i.test(String(err))
        ? "Pages of a password-protected PDF can't be changed here. Remove its password first (Protect ▸ Remove password)."
        : `Couldn't change the pages: ${(err as Error).message ?? err}`
    );
    return false;
  } finally {
    tab.pageBusy = false;
  }
}

/** Shows another version of the document's pages, keeping the zoom and
 *  the open panel, and marks it changed */
async function showPageVersion(
  tab: Tab,
  bytes: ArrayBuffer,
  page: number,
  /** Keep this scroll position (the pages didn't move) */
  scroll?: DocView['scroll']
) {
  const panel = viewer.activePanel(tab.id);
  const zoom = viewer.zoom(tab.id) ?? undefined;
  // (a copy: the viewer may take the buffer)
  const shown = bytes.slice(0);
  await viewer.replace(tab.id, bytes, { page, zoom: zoom ?? 1, scroll });
  if (!tabs.includes(tab)) return;
  void inspectDoc(tab, shown);
  if (panel) viewer.toggleSidebar(tab.id, panel.id, panel.tab);
  tab.page = viewer.pageInfo(tab.id) ?? tab.page;
  tab.version++;
  renderTabs();
  if (activeId === tab.id) renderDocChrome(tab);
  scheduleRecoveryCopy(tab);
}

/** Ctrl+Z / Ctrl+Shift+Z for page changes (after the viewer's own edits) */
async function stepPages(tab: Tab, action: 'undo' | 'redo') {
  const from = action === 'undo' ? tab.pageUndo : tab.pageRedo;
  if (!from?.length || tab.pageBusy) return false;
  tab.pageBusy = true;
  try {
    const current = await viewer.exportBytes(tab.id);
    const target = from.pop()!;
    setPageSelection(tab, null);
    await showPageVersion(tab, target, tab.page.current || 1);
    if (current) {
      const to = action === 'undo' ? 'pageRedo' : 'pageUndo';
      tab[to] = [...(tab[to] ?? []), current].slice(-PAGE_UNDO_LIMIT);
    }
    return true;
  } finally {
    tab.pageBusy = false;
  }
}

/** Undo (or redo) the latest edit: the viewer's first, then page changes */
function stepEdit(tab: Tab, action: 'undo' | 'redo') {
  if (!viewer.history(tab.id, action)) void stepPages(tab, action);
}

/** Is this one of the viewer's page thumbnails: a box labelled with its
 *  page number, holding the page image */
function isThumb(n: unknown): n is HTMLElement {
  // Cheapest tests first: this runs over the viewer's elements
  return (
    n instanceof HTMLElement &&
    n.style.position === 'absolute' &&
    !!n.querySelector(':scope > div > img, :scope > div > canvas') &&
    /^\d+$/.test(n.textContent?.trim() ?? '')
  );
}

/** The thumbnail an event is on, in the viewer's page thumbnails panel */
function thumbFor(e: Event): { item: HTMLElement; page: number } | null {
  for (const n of e.composedPath()) {
    if (!(n instanceof HTMLElement) || n.id === 'viewer-host') break;
    if (isThumb(n)) {
      thumbRoot = n.getRootNode();
      return { item: n, page: parseInt(n.textContent!.trim(), 10) - 1 };
    }
  }
  return null;
}

/** The thumbnails list an event is over (on a thumbnail or between them) */
function thumbListFor(
  e: Event
): { list: HTMLElement; scroller: HTMLElement } | null {
  const hit = thumbFor(e);
  const parent = hit?.item.parentElement;
  if (parent?.parentElement)
    return { list: parent, scroller: parent.parentElement };
  for (const n of e.composedPath()) {
    if (!(n instanceof HTMLElement) || n.id === 'viewer-host') break;
    const list = n.firstElementChild;
    if (
      n.style.overflowY === 'auto' &&
      list instanceof HTMLElement &&
      [...list.children].some(isThumb)
    ) {
      thumbRoot = n.getRootNode();
      return { list, scroller: n };
    }
  }
  return null;
}

/** Where something dropped at height `y` would go in the thumbnails list:
 *  before page `before` (0-based; the page count for the end), and where to
 *  draw the line that shows it */
function dropSpot(
  list: HTMLElement,
  scroller: HTMLElement,
  y: number
): { before: number; top: number; left: number; width: number } | null {
  let best: { el: HTMLElement; page: number } | null = null;
  let dist = Infinity;
  for (const el of list.children) {
    if (!isThumb(el)) continue;
    const r = el.getBoundingClientRect();
    const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    if (d < dist) {
      dist = d;
      best = { el, page: parseInt(el.textContent!.trim(), 10) - 1 };
    }
  }
  if (!best) return null;
  const r = best.el.getBoundingClientRect();
  const after = y > r.top + r.height / 2;
  const sr = scroller.getBoundingClientRect();
  return {
    before: best.page + (after ? 1 : 0),
    top: Math.round(after ? r.bottom + 4 : r.top - 6),
    left: sr.left + 8,
    width: sr.width - 16,
  };
}

/* Several pages selected: Ctrl/Cmd+click adds or removes one, Shift+click a
   range. Page actions and dragging then apply to all of them. */

/** The thumbnails panel's root (the viewer draws it in a shadow root) */
let thumbRoot: Node | null = null;
let selectionObserver: MutationObserver | null = null;

/** The pages an action on `page` applies to: the selection if `page` is in
 *  it, otherwise just that page */
function actionPages(tab: Tab, page: number): number[] {
  return tab.pageSel?.has(page) && tab.pageSel.size > 1
    ? [...tab.pageSel].sort((a, b) => a - b)
    : [page];
}

function setPageSelection(tab: Tab, pages: Iterable<number> | null) {
  const next = new Set(pages ?? []);
  tab.pageSel = next.size ? next : undefined;
  paintPageSelection();
}

/** Marks the selected thumbnails; the viewer redraws the list as it
 *  scrolls, so this runs again whenever it does */
function paintPageSelection() {
  const root = thumbRoot as (ShadowRoot | Document) | null;
  if (!root?.querySelectorAll) return;
  const sel = activeDoc()?.pageSel;
  const marked = root.querySelectorAll('[data-pw-selected]');
  if (!sel) {
    // Nothing selected: unmark, and stop following the list
    for (const el of marked) el.removeAttribute('data-pw-selected');
    selectionObserver?.disconnect();
    selectionObserver = null;
    return;
  }
  if (!root.querySelector('#pw-page-selection')) {
    const style = document.createElement('style');
    style.id = 'pw-page-selection';
    style.textContent = `
      [data-pw-selected] > div:first-child {
        outline: 3px solid var(--ep-accent-primary, #3b63fb);
        outline-offset: 2px;
      }
      [data-pw-selected] span { font-weight: 700; }`;
    (root instanceof Document ? root.head : root).append(style);
  }
  for (const el of root.querySelectorAll('div[style*="position: absolute"]')) {
    if (!isThumb(el)) continue;
    const page = parseInt(el.textContent!.trim(), 10) - 1;
    const on = sel.has(page);
    if (on !== el.hasAttribute('data-pw-selected'))
      el.toggleAttribute('data-pw-selected', on);
  }
  if (!selectionObserver) {
    let queued = false;
    selectionObserver = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        paintPageSelection();
      });
    });
    selectionObserver.observe(root, { childList: true, subtree: true });
  }
}

/** Ctrl/Cmd+click and Shift+click on a thumbnail */
function selectWithClick(tab: Tab, page: number, e: PointerEvent) {
  const current = (tab.page.current || 1) - 1;
  const sel = new Set(tab.pageSel ?? [current]);
  if (e.shiftKey) {
    const from = tab.pageAnchor ?? current;
    const [a, b] = from < page ? [from, page] : [page, from];
    if (!(e.ctrlKey || e.metaKey)) sel.clear();
    for (let i = a; i <= b; i++) sel.add(i);
  } else {
    if (sel.has(page) && sel.size > 1) sel.delete(page);
    else sel.add(page);
    tab.pageAnchor = page;
  }
  setPageSelection(tab, sel);
}

/** The right-click menu for a page thumbnail (or the selected pages) */
function pageMenu(tab: Tab, page: number, x: number, y: number) {
  const total = tab.page.total || viewer.pageInfo(tab.id)?.total || 1;
  const pages = actionPages(tab, page);
  if (pages.length === 1 && tab.pageSel) setPageSelection(tab, null);
  const go = (
    change: (b: ArrayBuffer) => Promise<ArrayBuffer>,
    at: number,
    done?: string,
    keepSelection = false
  ): void => void changePages(tab, change, at, done, keepSelection);
  if (pages.length > 1) {
    const count = `${pages.length} pages`;
    const first = pages[0] + 1;
    return showMenu(menuPoint(x, y), [
      {
        label: `Rotate ${count} clockwise`,
        icon: icon('rotate', 16),
        onClick: () =>
          go((b) => rotatePages(b, pages, 90), first, undefined, true),
      },
      {
        label: `Rotate ${count} counterclockwise`,
        icon: icon('rotateCcw', 16),
        onClick: () =>
          go((b) => rotatePages(b, pages, -90), first, undefined, true),
      },
      { divider: true },
      {
        label: `Extract ${count}`,
        icon: icon('fileOut', 16),
        onClick: () => void extractToTab(tab, pages),
      },
      { divider: true },
      {
        label: `Delete ${count}`,
        icon: icon('trash', 16),
        disabled: pages.length >= total,
        onClick: () =>
          go(
            (b) => deletePages(b, pages),
            Math.min(first, total - pages.length),
            `Deleted ${count}`
          ),
      },
    ]);
  }
  const n = page + 1;
  showMenu(menuPoint(x, y), [
    {
      label: 'Rotate clockwise',
      icon: icon('rotate', 16),
      onClick: () => go((b) => rotatePages(b, [page], 90), n),
    },
    {
      label: 'Rotate counterclockwise',
      icon: icon('rotateCcw', 16),
      onClick: () => go((b) => rotatePages(b, [page], -90), n),
    },
    { divider: true },
    {
      label: 'Insert blank page after',
      icon: icon('filePlus', 16),
      onClick: () => go((b) => insertBlankPage(b, page), n + 1),
    },
    {
      label: 'Insert pages from a file…',
      icon: icon('folder', 16),
      onClick: async () => {
        const picked = (await pickFiles()).find((p) => isPdf(p.file));
        if (!picked) return;
        const other = await picked.file.arrayBuffer();
        go(
          (b) => insertPagesFrom(b, page, other),
          n + 1,
          `Inserted ${picked.file.name} after page ${n}`
        );
      },
    },
    {
      label: 'Extract page',
      icon: icon('fileOut', 16),
      onClick: () => void extractToTab(tab, [page]),
    },
    { divider: true },
    {
      label: 'Move up',
      icon: icon('chevronUp', 16),
      disabled: page === 0,
      onClick: () => go((b) => movePage(b, page, page - 1), n - 1),
    },
    {
      label: 'Move down',
      icon: icon('chevronDown', 16),
      disabled: page >= total - 1,
      onClick: () => go((b) => movePage(b, page, page + 1), n + 1),
    },
    { divider: true },
    {
      label: 'Delete page',
      icon: icon('trash', 16),
      disabled: total <= 1,
      onClick: () =>
        go(
          (b) => deletePages(b, [page]),
          Math.min(n, total - 1),
          `Deleted page ${n}`
        ),
    },
  ]);
}

/** Copies pages into a new, unsaved tab */
async function extractToTab(tab: Tab, pages: number[]) {
  const bytes = await viewer.exportBytes(tab.id);
  if (!bytes) return;
  const out = await extractPages(bytes, pages);
  const base = tab.name.replace(/\.pdf$/i, '');
  const what =
    pages.length === 1 ? `page ${pages[0] + 1}` : `${pages.length} pages`;
  const name = uniqueTabName(`${base} (${what}).pdf`);
  const file = new File([out], name, { type: 'application/pdf' });
  const t = await openDocument(file, {}, undefined, undefined, {});
  if (t) savePrompt(t, `Extracted ${what} to a new tab. It isn't saved yet`);
}

/** Dragging a thumbnail moves its page, or all the selected pages (a line
 *  shows where they'll go). A press without a drag on one of several
 *  selected pages selects just that one. */
function dragPage(
  tab: Tab,
  start: PointerEvent,
  from: { item: HTMLElement; page: number }
) {
  const list = from.item.parentElement;
  const scroller = list?.parentElement;
  if (!list || !scroller) return;
  const pages = actionPages(tab, from.page);
  let dragging = false;
  let target = -1; // the page index they'd be placed before
  let raf = 0;
  let lastY = start.clientY;
  const line = h('div', { class: 'page-drop-line', 'aria-hidden': 'true' });
  const ghost = h('div', { class: 'page-drag-ghost', 'aria-hidden': 'true' });
  const update = (y: number) => {
    const spot = dropSpot(list, scroller, y);
    if (!spot) return;
    target = spot.before;
    line.style.left = `${spot.left}px`;
    line.style.width = `${spot.width}px`;
    line.style.top = `${spot.top}px`;
  };
  // Near the panel's top or bottom edge, the list scrolls
  const scroll = () => {
    const sr = scroller.getBoundingClientRect();
    const edge = 48;
    const v =
      lastY < sr.top + edge
        ? -Math.ceil((sr.top + edge - lastY) / 4)
        : lastY > sr.bottom - edge
          ? Math.ceil((lastY - (sr.bottom - edge)) / 4)
          : 0;
    if (v) {
      scroller.scrollTop += v;
      update(lastY);
    }
    raf = requestAnimationFrame(scroll);
  };
  const move = (e: PointerEvent) => {
    lastY = e.clientY;
    if (!dragging) {
      if (
        Math.abs(e.clientY - start.clientY) +
          Math.abs(e.clientX - start.clientX) <
        6
      )
        return;
      dragging = true;
      ghost.textContent =
        pages.length > 1 ? `${pages.length} pages` : `Page ${from.page + 1}`;
      $('#popover-layer').append(line, ghost);
      document.body.classList.add('is-dragging-page');
      raf = requestAnimationFrame(scroll);
    }
    ghost.style.left = `${e.clientX + 12}px`;
    ghost.style.top = `${e.clientY + 12}px`;
    update(e.clientY);
  };
  const finish = (drop: boolean) => {
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', cancel, true);
    window.removeEventListener('blur', cancel);
    window.removeEventListener('keydown', key, true);
    cancelAnimationFrame(raf);
    line.remove();
    ghost.remove();
    document.body.classList.remove('is-dragging-page');
    if (!dragging) {
      // A plain click: the viewer goes to the page, which is now the only
      // one selected
      if (drop && tab.pageSel) setPageSelection(tab, null);
      tab.pageAnchor = from.page;
      return;
    }
    if (!drop || target < 0) return;
    if (pages.length === 1) {
      // Placed before `target`; with the page itself taken out first
      const to = target > from.page ? target - 1 : target;
      if (to === from.page) return;
      void changePages(tab, (b) => movePage(b, from.page, to), to + 1);
      return;
    }
    // Where the first of them ends up, with the moved pages taken out
    const at = target - pages.filter((p) => p < target).length;
    void changePages(tab, (b) => movePages(b, pages, target), at + 1);
  };
  const up = () => finish(true);
  // Interrupted (e.g. the window lost focus): nothing moves
  const cancel = () => finish(false);
  const key = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    finish(false);
  };
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', cancel, true);
  window.addEventListener('blur', cancel);
  window.addEventListener('keydown', key, true);
}

$('#viewer-host').addEventListener('contextmenu', (e) => {
  const tab = activeDoc();
  const hit = tab && thumbFor(e);
  if (!tab || !hit) return;
  e.preventDefault();
  pageMenu(tab, hit.page, e.clientX, e.clientY);
});

// A thumbnail's image would start the browser's own drag, which cancels
// the pointer events the page drag follows
$('#viewer-host').addEventListener(
  'dragstart',
  (e) => {
    if (thumbFor(e)) e.preventDefault();
  },
  true
);

// A Ctrl/Cmd or Shift click selects instead of going to the page
let swallowClick = false;
$('#viewer-host').addEventListener(
  'click',
  (e) => {
    if (!swallowClick) return;
    swallowClick = false;
    e.preventDefault();
    e.stopPropagation();
  },
  true
);

// (capture: the thumbnails handle the press themselves)
$('#viewer-host').addEventListener(
  'pointerdown',
  (e) => {
    if (e.button !== 0) return;
    const tab = activeDoc();
    const hit = tab && thumbFor(e);
    if (!tab || !hit) return;
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      swallowClick = true;
      selectWithClick(tab, hit.page, e);
      return;
    }
    dragPage(tab, e, hit);
  },
  true
);

window.addEventListener('keydown', (e) => {
  const tab = activeDoc();
  if (e.key === 'Escape' && tab?.pageSel) setPageSelection(tab, null);
});

/* Dropping PDFs onto the thumbnails inserts their pages there */

/** Drops the window's handler leaves to the thumbnails */
const droppedOnPages = new WeakSet<Event>();
const pageDropLine = h('div', {
  class: 'page-drop-line',
  'aria-hidden': 'true',
});

function endPageDrop() {
  pageDropLine.remove();
  document.body.classList.remove('is-dropping-pages');
}

$('#viewer-host').addEventListener('dragover', (e) => {
  const tab = activeDoc();
  const at = tab && e.dataTransfer?.types.includes('Files') && thumbListFor(e);
  const spot = at && dropSpot(at.list, at.scroller, e.clientY);
  if (!tab || !spot || tab.loading || tab.fullTool) return endPageDrop();
  e.preventDefault();
  e.dataTransfer!.dropEffect = 'copy';
  pageDropLine.style.left = `${spot.left}px`;
  pageDropLine.style.width = `${spot.width}px`;
  pageDropLine.style.top = `${spot.top}px`;
  if (!pageDropLine.isConnected) $('#popover-layer').append(pageDropLine);
  document.body.classList.add('is-dropping-pages');
});
$('#viewer-host').addEventListener('dragleave', (e) => {
  if (!thumbListFor(e)) endPageDrop();
});
window.addEventListener('dragend', endPageDrop);

$('#viewer-host').addEventListener('drop', (e) => {
  const tab = activeDoc();
  const at = tab && thumbListFor(e);
  const spot = at && dropSpot(at.list, at.scroller, e.clientY);
  endPageDrop();
  if (!tab || !spot || tab.loading || tab.fullTool) return;
  const pdfs = Array.from(e.dataTransfer?.files ?? []).filter(isPdf);
  if (!pdfs.length) return;
  e.preventDefault();
  droppedOnPages.add(e);
  void (async () => {
    const others = await Promise.all(pdfs.map((f) => f.arrayBuffer()));
    const names = pdfs.length === 1 ? pdfs[0].name : `${pdfs.length} files`;
    const where =
      spot.before === 0 ? 'at the start' : `after page ${spot.before}`;
    await changePages(
      tab,
      async (b) => {
        // In the order dropped, each after the last
        let out = b;
        let after = spot.before - 1;
        for (const other of others) {
          const before = await pageCount(out);
          out = await insertPagesFrom(out, after, other);
          after += (await pageCount(out)) - before;
        }
        return out;
      },
      spot.before + 1,
      `Inserted ${names} ${where}`
    );
  })();
});

/* Right rail ----------------------------------------------------------- */

function renderRightRail(tab: Tab) {
  const rail = $('#right-rail');
  /** A rail button that opens a panel ("panel" or "panel:tab") */
  const panelBtn = (
    name: IconName,
    label: string,
    panel: string,
    open: () => void
  ) => {
    const btn = iconBtn(name, label, open, 'rr-btn');
    btn.dataset.panel = panel;
    return btn;
  };
  const top = h(
    'div',
    { class: 'rr-top' },
    iconBtn(
      'panelClose',
      'Hide panel',
      () => viewer.closePanel(tab.id),
      'rr-btn rr-collapse'
    ),
    panelBtn('comments', 'Comments', 'comment-panel', () =>
      viewer.toggleSidebar(tab.id, 'comment-panel')
    ),
    panelBtn('bookmark', 'Bookmarks', 'sidebar-panel:outline', () =>
      viewer.toggleSidebar(tab.id, 'sidebar-panel', 'outline')
    ),
    panelBtn('thumbnails', 'Page thumbnails', 'sidebar-panel:thumbnails', () =>
      viewer.toggleSidebar(tab.id, 'sidebar-panel', 'thumbnails')
    ),
    panelBtn('style', 'Annotation style', 'annotation-panel', () =>
      viewer.toggleStyles(tab.id)
    ),
    panelBtn('search', 'Find text', 'search-panel', () =>
      viewer.command(tab.id, 'panel:toggle-search')
    ),
    tab.form &&
      h(
        'button',
        {
          type: 'button',
          class: `rr-btn${tab.formOpen ? ' is-on' : ''}`,
          title: 'Form fields',
          'aria-label': 'Form fields',
          'aria-pressed': String(!!tab.formOpen),
          onClick: () => toggleFormPanel(tab),
        },
        icon('form')
      )
  );
  const pageInput = h('input', {
    class: 'rr-page',
    value: String(tab.page.current || 1),
    'aria-label': 'Page number',
    inputmode: 'numeric',
  });
  pageInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const n = parseInt(pageInput.value, 10);
    if (n >= 1 && n <= tab.page.total) viewer.goToPage(tab.id, n);
    pageInput.blur();
  });
  const zoomBtn = h(
    'button',
    {
      type: 'button',
      class: 'rr-zoom',
      title: `Zoom level (${key('Ctrl+Y')})`,
      'aria-label': 'Zoom level',
      onClick: (e: MouseEvent) =>
        showZoomMenu(tab, e.currentTarget as HTMLElement),
    },
    zoomLabel(tab)
  );
  const bottom = h(
    'div',
    { class: 'rr-bottom' },
    pageInput,
    h('div', { class: 'rr-total' }, String(tab.page.total || '–')),
    iconBtn(
      'chevronUp',
      'Previous page',
      () => viewer.command(tab.id, 'scroll:previous-page'),
      'rr-btn'
    ),
    iconBtn(
      'chevronDown',
      'Next page',
      () => viewer.command(tab.id, 'scroll:next-page'),
      'rr-btn'
    ),
    h('div', { class: 'rr-div' }),
    iconBtn(
      'rotate',
      'Rotate view',
      () => viewer.command(tab.id, 'rotate:clockwise'),
      'rr-btn'
    ),
    iconBtn(
      'zoomIn',
      'Zoom in',
      () => viewer.command(tab.id, 'zoom:in'),
      'rr-btn'
    ),
    zoomBtn,
    iconBtn(
      'zoomOut',
      'Zoom out',
      () => viewer.command(tab.id, 'zoom:out'),
      'rr-btn'
    )
  );
  rail.replaceChildren(top, bottom);
  updateRailPanels(tab);
}

const zoomLabel = (tab: Tab) => {
  const z = viewer.zoom(tab.id);
  return z ? `${Math.round(z * 100)}%` : '–';
};

/** Highlight the rail button of the open panel (pressing it again closes
 *  the panel), and show "Hide panel" while one is open */
function updateRailPanels(tab: Tab) {
  const open = viewer.activePanel(tab.id);
  const keyOf = open && (open.tab ? `${open.id}:${open.tab}` : open.id);
  document
    .querySelectorAll<HTMLElement>('#right-rail [data-panel]')
    .forEach((b) => {
      const on =
        !!open && (b.dataset.panel === keyOf || b.dataset.panel === open.id);
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  const collapse = document.querySelector<HTMLElement>(
    '#right-rail .rr-collapse'
  );
  if (collapse) collapse.hidden = !open;
}

viewer.onZoom((tabId) => {
  const tab = tabs.find((t) => t.id === tabId);
  if (tab) noteView(tab);
});

viewer.onPanel((tabId) => {
  const tab = activeTab();
  if (tab?.id === tabId) updateRailPanels(tab);
});

viewer.onZoom((tabId) => {
  const tab = activeTab();
  const label = document.querySelector('#right-rail .rr-zoom');
  if (tab?.id === tabId && label) label.textContent = zoomLabel(tab);
});

viewer.onPage((tabId, info) => {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return;
  tab.page = info;
  noteView(tab);
  if (activeId === tabId) {
    const input = $<HTMLInputElement>('#right-rail .rr-page');
    if (input && document.activeElement !== input)
      input.value = String(info.current);
    const total = $('#right-rail .rr-total');
    if (total) total.textContent = String(info.total);
  }
});

/* Save / print / download / find -------------------------------------- */

async function docBlob(tab: Tab): Promise<Blob | null> {
  const bytes = await viewer.exportBytes(tab.id);
  return bytes ? new Blob([bytes], { type: 'application/pdf' }) : null;
}

/** Save a document; resolves true if it was written somewhere */
async function saveDoc(tab: Tab, saveAs = false): Promise<boolean> {
  // Saving over a file another app has saved since: ask first
  if (!saveAs && (tab.path || tab.handle)) {
    const choice = await confirmOverwrite(tab);
    if (choice === 'cancel') return false;
    if (choice === 'copy') return saveDoc(tab, true);
  }
  const version = tab.version;
  const blob = await docBlob(tab);
  if (!blob) return false;
  const done = (name: string) => {
    tab.savedVersion = version;
    tab.name = name;
    // What's on disk is what's shown now
    tab.diskChanged = tab.diskDismissed = undefined;
    renderDiskBar();
    renderTabs();
    persistSession();
    toast(`Saved ${name}`);
    // The first page may have changed: Home makes a new preview
    if (tab.recentId) void thumbs.invalidate(tab.recentId);
    // It's on disk now
    cancelRecoveryCopy(tab);
    if (tab.recoveryId) {
      void desktop?.recovery?.delete(tab.recoveryId);
      tab.recoveryId = undefined;
    }
    return true;
  };

  if (desktop && !tab.handle) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const hash = fingerprint(bytes);
    try {
      if (!saveAs && tab.path && (await desktop.writeFile(tab.path, bytes))) {
        tab.diskHash = hash;
        return done(tab.name);
      }
      const saved = await desktop.saveAs(tab.name, bytes);
      if (!saved) return false;
      tab.path = saved.path;
      tab.diskHash = hash;
      tab.recentId =
        (await rememberFile(new File([blob], saved.name), {
          path: saved.path,
        })) ?? tab.recentId;
      return done(saved.name);
    } catch (e) {
      console.error(e);
      toast(`Couldn't save ${tab.name}`);
      return false;
    }
  }

  let handle = saveAs ? undefined : tab.handle;
  const savePicker = (window as any).showSaveFilePicker;
  try {
    if (!handle && savePicker) {
      handle = await savePicker({
        suggestedName: tab.name,
        types: [
          { description: 'PDF file', accept: { 'application/pdf': ['.pdf'] } },
        ],
      });
    }
    if (handle) {
      const h2 = handle as any;
      if ((await h2.queryPermission?.({ mode: 'readwrite' })) !== 'granted') {
        await h2.requestPermission?.({ mode: 'readwrite' });
      }
      const w = await h2.createWritable();
      await w.write(blob);
      await w.close();
      tab.handle = handle;
      tab.diskHash = fingerprint(blob);
      return done(handle.name);
    }
  } catch (e) {
    if ((e as DOMException)?.name === 'AbortError') return false;
    console.error(e);
  }
  // No file system access (plain browser): download a copy instead
  saveBlob(blob, tab.name);
  tab.savedVersion = version;
  renderTabs();
  return true;
}

$('#save-btn').addEventListener('click', () => {
  const t = activeDoc();
  if (t) void saveDoc(t);
});
// Desktop app: the document the viewer's print dialog prepares (pages,
// annotations) goes to Paperwing's, which prints it through the desktop
// shell (the viewer's own way prints nothing there)
if (desktop?.printers && desktop.printPages) {
  const bridge = desktop as PrintBridge;
  viewer.printTo = (tabId, pdf) => {
    const tab = tabs.find((t) => t.id === tabId);
    void showPrintDialog(bridge, pdf, tab?.name ?? 'Document.pdf', toast);
  };
}
$('#print-btn').addEventListener('click', () => {
  const t = activeDoc();
  if (t) viewer.command(t.id, 'document:print');
});
$('#download-btn').addEventListener('click', async () => {
  const t = activeDoc();
  const blob = t && (await docBlob(t));
  if (t && blob) saveBlob(blob, t.name);
});

function searchTools(q: string): AppTool[] {
  const query = q.trim().toLowerCase();
  const seen = new Set<string>();
  const out: AppTool[] = [];
  for (const g of allToolGroups()) {
    for (const t of g.tools) {
      if (seen.has(t.id)) continue;
      if (!query || `${t.name} ${t.desc}`.toLowerCase().includes(query)) {
        seen.add(t.id);
        out.push(t);
      }
    }
  }
  return out;
}

$('#find-btn').addEventListener('click', (e) =>
  openPalette(e.currentTarget as HTMLElement)
);

/* ------------------------------------------------------------------ */
/* Home view                                                           */
/* ------------------------------------------------------------------ */

let homeTab: 'recent' | 'starred' = 'recent';
let homeLayout: 'list' | 'grid' = 'list';

function renderRecommended() {
  $('#rec-tools').replaceChildren(
    ...recommendedTools().map((t) =>
      h(
        'button',
        {
          type: 'button',
          class: 'rec-card',
          onClick: (): void => void runTool(t),
        },
        h(
          'span',
          { class: 'rec-ic', style: `--c:${t.color}` },
          toolIcon(t.icon, t.color, 26)
        ),
        h('span', { class: 'rec-name' }, t.name),
        h('span', { class: 'rec-desc' }, t.desc),
        h('span', { class: 'rec-use' }, 'Use now')
      )
    )
  );
}

async function openRecent(entry: RecentFile): Promise<Tab | undefined> {
  const got = await reopenRecent(entry);
  if (!got) {
    toast(`${entry.name} is no longer available`, {
      label: 'Remove',
      onClick: async () => {
        await forgetRecent(entry.id);
        void refreshRecent();
      },
    });
    return undefined;
  }
  return openDocument(
    got.file,
    { handle: got.handle, path: got.path },
    entry.id
  );
}

async function setStarred(entry: RecentFile, starred: boolean) {
  await updateRecent(entry.id, { starred });
  tabs.forEach((t) => {
    if (t.recentId === entry.id) t.starred = starred;
  });
  renderTabs();
  void refreshRecent();
}

/** Right-click menu of a recent file (also the Menu key / Shift+F10) */
function recentMenu(entry: RecentFile, e: MouseEvent) {
  e.preventDefault();
  // From the keyboard the event has no position: open it under the row
  const row = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const fromKeyboard = e.clientX === 0 && e.clientY === 0;
  const x = fromKeyboard ? row.left + 48 : e.clientX;
  const y = fromKeyboard ? row.bottom : e.clientY;
  const onDisk = !!(desktop?.showInFolder && entry.path);
  const items: MenuItem[] = [
    { label: 'Open', onClick: () => void openRecent(entry) },
  ];
  if (onDisk) {
    items.push(
      {
        label: isMac ? 'Show in Finder' : 'Show in File Explorer',
        onClick: () => void desktop!.showInFolder!(entry.path!),
      },
      {
        label: 'Copy path',
        onClick: () => void navigator.clipboard.writeText(entry.path!),
      }
    );
  }
  items.push(
    { divider: true },
    {
      label: 'Compress…',
      onClick: () => void recentWithTool(entry, 'compress-pdf'),
    },
    {
      label: 'Combine with other files…',
      onClick: () => void combineRecent(entry),
    },
    { divider: true },
    {
      label: entry.starred ? 'Unstar' : 'Star',
      onClick: () => void setStarred(entry, !entry.starred),
    },
    {
      label: 'Remove from Recent',
      onClick: async () => {
        await forgetRecent(entry.id);
        void refreshRecent();
      },
    }
  );
  showMenu(menuPoint(x, y), items, 'below');
}

/** Open a recent file and run a tool on it */
async function recentWithTool(entry: RecentFile, toolId: string) {
  const tool = getTool(toolId);
  const tab = await openRecent(entry);
  if (!tab || !tool) return;
  // Already open but still loading (e.g. restored from the last session)
  for (let i = 0; i < 200 && tab.loading && tabs.includes(tab); i++)
    await new Promise((r) => setTimeout(r, 50));
  if (tabs.includes(tab) && !tab.loading) await openToolOnDoc(tab, tool);
}

/** Combine: a workspace with the file already added; add the others there */
async function combineRecent(entry: RecentFile) {
  const tool = getTool('merge-pdf');
  const got = await reopenRecent(entry);
  if (!tool || !got) {
    if (!got) toast(`${entry.name} is no longer available`);
    return;
  }
  await openToolOnDoc(newWorkspace(tool.name), tool, [got.file]);
}

/** A point on screen to anchor a menu at (right-click menus) */
function menuPoint(x: number, y: number): HTMLElement {
  let el = document.getElementById('menu-point');
  if (!el) {
    el = h('div', { id: 'menu-point', 'aria-hidden': 'true' });
    document.body.append(el);
  }
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  return el;
}

/** A recent file's first-page preview, or the PDF glyph until there is one */
function fileThumb(entry: RecentFile): HTMLElement {
  const url = thumbUrl(entry);
  return url ? thumbImg(url) : h('span', { class: 'pdf-glyph' }, 'PDF');
}

function thumbImg(url: string): HTMLElement {
  return h('img', { class: 'rr-thumb', src: url, alt: '', draggable: 'false' });
}

async function refreshRecent() {
  const q = $<HTMLInputElement>('#home-search').value.trim().toLowerCase();
  let items = await listRecent();
  if (homeTab === 'starred') items = items.filter((r) => r.starred);
  if (q) items = items.filter((r) => r.name.toLowerCase().includes(q));

  const list = $('#recent-list');
  list.classList.toggle('is-grid', homeLayout === 'grid');
  // Starred files are kept, so there's only something to clear on Recent
  $('#clear-recent').hidden =
    homeTab !== 'recent' || !items.some((r) => !r.starred) || !!q;
  if (!items.length) {
    list.replaceChildren(
      h(
        'div',
        { class: 'recent-empty' },
        homeTab === 'starred'
          ? 'Star a file from its tab to see it here.'
          : q
            ? 'No files match your search.'
            : 'Files you open will show up here.'
      )
    );
    return;
  }

  const hints = folderHints(items);
  const rows = items.map((r, i) => {
    const star = iconBtn(
      'star',
      r.starred ? 'Unstar' : 'Star',
      (e) => {
        e.stopPropagation();
        void setStarred(r, !r.starred);
      },
      `row-star${r.starred ? ' is-on' : ''}`
    );
    const remove = iconBtn(
      'close',
      'Remove from recent',
      async (e) => {
        e.stopPropagation();
        await forgetRecent(r.id);
        void refreshRecent();
      },
      'row-remove'
    );
    return h(
      'div',
      {
        class: 'recent-row',
        role: 'button',
        tabindex: '0',
        title: r.path,
        dataset: { id: r.id },
        onClick: () => openRecent(r),
        onKeydown: (e: KeyboardEvent) => e.key === 'Enter' && openRecent(r),
        onContextmenu: (e: MouseEvent) => recentMenu(r, e),
      },
      h('span', { class: 'rr-file' }, fileThumb(r)),
      h(
        'span',
        { class: 'rr-name' },
        h('span', { class: 'rr-title' }, r.name),
        h('span', { class: 'rr-kind' }, hints[i] ? `PDF · ${hints[i]}` : 'PDF')
      ),
      h('span', { class: 'rr-opened' }, formatOpened(r.openedAt)),
      h('span', { class: 'rr-size' }, formatBytes(r.size)),
      h('span', { class: 'rr-acts' }, star, remove)
    );
  });

  thumbs.fill(items);
  list.replaceChildren(
    h(
      'div',
      { class: 'recent-row recent-header' },
      h('span', {}),
      h('span', {}, 'NAME'),
      h('span', {}, 'OPENED'),
      h('span', {}, 'SIZE'),
      h('span', {})
    ),
    ...rows
  );
}

document.querySelectorAll<HTMLButtonElement>('[data-home-tab]').forEach((b) =>
  b.addEventListener('click', () => {
    homeTab = b.dataset.homeTab as typeof homeTab;
    document.querySelectorAll('[data-home-tab]').forEach((x) => {
      x.classList.toggle('is-active', x === b);
      x.setAttribute('aria-selected', String(x === b));
    });
    void refreshRecent();
  })
);
document.querySelectorAll<HTMLButtonElement>('[data-layout]').forEach((b) =>
  b.addEventListener('click', () => {
    homeLayout = b.dataset.layout as typeof homeLayout;
    document
      .querySelectorAll('[data-layout]')
      .forEach((x) => x.classList.toggle('is-active', x === b));
    void refreshRecent();
  })
);
$('#home-search').addEventListener('input', () => void refreshRecent());
$('#clear-recent').addEventListener('click', async () => {
  const choice = await askDialog(
    'Clear recent files?',
    "They're removed from this list only, not from your computer. Starred files stay.",
    [
      { label: 'Cancel', value: false, kind: 'quiet' },
      { label: 'Clear', value: true, kind: 'primary' },
    ],
    false
  );
  if (!choice) return;
  const n = await clearRecent();
  void desktop?.clearRecentDocuments?.();
  void refreshRecent();
  toast(n === 1 ? 'Cleared 1 recent file' : `Cleared ${n} recent files`);
});
$('#home-select').addEventListener('click', openFromDialog);
$('#doc-empty-open').addEventListener('click', openFromDialog);
$('#see-all-tools').addEventListener('click', () => showToolsSidebar());

/* ------------------------------------------------------------------ */
/* Title bar menus                                                     */
/* ------------------------------------------------------------------ */

function createMenuItems(): MenuItem[] {
  const ids = [
    'image-to-pdf',
    'word-to-pdf',
    'excel-to-pdf',
    'powerpoint-to-pdf',
    'txt-to-pdf',
    'markdown-to-pdf',
    'email-to-pdf',
  ];
  const labels: Record<string, string> = {
    'image-to-pdf': 'From images',
    'word-to-pdf': 'From Word',
    'excel-to-pdf': 'From Excel',
    'powerpoint-to-pdf': 'From PowerPoint',
    'txt-to-pdf': 'From text',
    'markdown-to-pdf': 'From Markdown',
    'email-to-pdf': 'From email',
  };
  return [
    ...ids.map((id) => {
      const t = getTool(id)!;
      return {
        label: labels[id],
        icon: toolIcon(t.icon, t.color, 18),
        onClick: (): void => void runTool(t),
      };
    }),
    { divider: true },
    {
      label: 'More formats…',
      onClick: () => showToolsSidebar('to PDF'),
    },
  ];
}

$('#create-btn').addEventListener('click', (e) =>
  showMenu(e.currentTarget as HTMLElement, createMenuItems())
);

/** First combo of a shortcut, formatted for this platform */
const shortcutLabel = (id: string) =>
  formatCombo(keysFor(SHORTCUTS.find((x) => x.id === id)!, isMac)[0], isMac);

$('#menu-btn').addEventListener('click', (e) => {
  const doc = activeDoc();
  const sc = shortcutLabel;
  showMenu(e.currentTarget as HTMLElement, [
    {
      label: 'Open…',
      shortcut: sc('open'),
      icon: icon('folder', 16),
      onClick: openFromDialog,
    },
    {
      label: 'Create PDF',
      shortcut: sc('create'),
      icon: icon('plus', 16),
      onClick: () => showMenu($('#create-btn'), createMenuItems()),
    },
    {
      label: 'Reopen closed document',
      shortcut: sc('reopen'),
      disabled: !closedDocs.length,
      onClick: () => void reopenClosedTab(),
    },
    { divider: true },
    {
      label: 'Save',
      shortcut: sc('save'),
      icon: icon('save', 16),
      disabled: !doc,
      onClick: () => doc && void saveDoc(doc),
    },
    {
      label: 'Save as…',
      shortcut: sc('saveAs'),
      disabled: !doc,
      onClick: () => doc && void saveDoc(doc, true),
    },
    {
      label: 'Download a copy',
      icon: icon('download', 16),
      disabled: !doc,
      onClick: () => $('#download-btn').click(),
    },
    {
      label: 'Print…',
      shortcut: sc('print'),
      icon: icon('print', 16),
      disabled: !doc,
      onClick: () => doc && viewer.command(doc.id, 'document:print'),
    },
    {
      label: 'Document properties',
      shortcut: sc('properties'),
      disabled: !doc,
      onClick: () => doc && showProperties(doc),
    },
    { divider: true },
    {
      label: 'Read mode',
      shortcut: sc('readMode'),
      disabled: !doc,
      onClick: () => setReadMode(true),
    },
    {
      label: 'Full screen',
      shortcut: sc('fullScreen'),
      disabled: !doc,
      onClick: () => void toggleFullScreen(),
    },
    { divider: true },
    {
      label: 'Close tab',
      shortcut: sc('close'),
      disabled: activeId === 'home',
      onClick: () => void requestCloseTab(activeId),
    },
    {
      label: 'Close all tabs',
      disabled: !tabs.length,
      onClick: () => void closeAllTabs(),
    },
    { divider: true },
    {
      label: 'Preferences…',
      shortcut: sc('prefs'),
      icon: icon('settings', 16),
      onClick: showPreferences,
    },
    {
      label: 'Appearance',
      icon: icon('theme', 16),
      onClick: () => showThemeMenu($('#menu-btn')),
    },
    {
      label: 'All tools',
      icon: icon('grid', 16),
      onClick: () => showToolsSidebar(),
    },
    { label: 'About Paperwing', onClick: showAbout },
  ]);
});

$('#help-btn').addEventListener('click', (e) => {
  const update = knownUpdate();
  showMenu(e.currentTarget as HTMLElement, [
    ...(update
      ? [
          {
            label: update.auto
              ? `Update to Paperwing ${update.version}`
              : `Download Paperwing ${update.version}`,
            icon: icon('download', 16),
            onClick: () => getUpdate(update),
          },
          { divider: true },
        ]
      : []),
    { label: 'Keyboard shortcuts', onClick: showShortcuts },
    {
      label: 'Search tools & commands',
      shortcut: formatCombo('Shift+Ctrl+P', isMac),
      onClick: () => openPalette(),
    },
    {
      label: 'Paperwing website',
      onClick: () => window.open(WEBSITE_URL, '_blank', 'noopener'),
    },
    {
      label: 'Paperwing on GitHub',
      onClick: () => window.open(REPO_URL, '_blank', 'noopener'),
    },
    {
      label: 'Check for updates…',
      onClick: () => void checkForUpdates(toast, true),
    },
    { divider: true },
    { label: 'About Paperwing', onClick: showAbout },
  ]);
});

function showThemeMenu(anchor: HTMLElement) {
  const current = getThemePref();
  const opt = (pref: ThemePref, label: string): MenuItem => ({
    label,
    icon: pref === current ? icon('check', 16) : undefined,
    onClick: () => setThemePref(pref),
  });
  showMenu(anchor, [
    opt('system', 'Use system setting'),
    opt('light', 'Light'),
    opt('dark', 'Dark'),
  ]);
}

/** Modal with a close button; Escape or a click outside closes it too */
function dialog(
  title: string,
  body: Node,
  /** Extra class for the dialog box (its own look, like About) */
  className?: string
): () => void {
  const backdrop = h('div', { class: 'dlg-backdrop' });
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  backdrop.append(
    h(
      'div',
      {
        class: className ? `dlg ${className}` : 'dlg',
        role: 'dialog',
        'aria-label': title,
      },
      h(
        'div',
        { class: 'dlg-head' },
        h('h2', {}, title),
        iconBtn('close', 'Close', close)
      ),
      body
    )
  );
  backdrop.addEventListener(
    'pointerdown',
    (e) => e.target === backdrop && close()
  );
  document.body.append(backdrop);
  return close;
}

function showAbout() {
  const link = (href: string, text: string) =>
    h('a', { href, target: '_blank', rel: 'noopener' }, text);
  // The launch-screen look: the flight path and a faint wing behind the text
  const art = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  art.setAttribute('class', 'about-art');
  art.setAttribute('viewBox', '0 0 560 360');
  art.setAttribute('preserveAspectRatio', 'none');
  art.setAttribute('aria-hidden', 'true');
  art.innerHTML = `
    <path d="M-20 300 C 120 250, 260 330, 400 210 S 600 80, 620 60" fill="none"
      stroke="rgb(255 255 255 / 0.22)" stroke-width="2" stroke-dasharray="2 10" stroke-linecap="round" />
    <path d="M-20 340 C 160 300, 300 360, 440 250 S 600 140, 620 120" fill="none"
      stroke="rgb(255 255 255 / 0.12)" stroke-width="2" stroke-dasharray="2 10" stroke-linecap="round" />
    <g transform="translate(330 40) scale(0.36)" opacity="0.16">
      <polygon points="322,248 452,248 452,806 322,740" fill="#fff" />
      <polygon points="452,248 772,398 452,414" fill="#fff" />
      <polygon points="452,414 772,398 452,586" fill="#fff" />
    </g>`;
  dialog(
    'About Paperwing',
    h(
      'div',
      { class: 'dlg-body about' },
      art,
      h(
        'div',
        { class: 'about-brand' },
        h('span', { class: 'app-logo about-logo' }),
        h(
          'div',
          {},
          h('div', { class: 'about-name' }, 'Paperwing'),
          h(
            'div',
            { class: 'about-version' },
            `Version ${__PAPERWING_VERSION__}`
          )
        )
      ),
      h(
        'p',
        {},
        'A free, open-source PDF editor. Everything runs locally on this computer — your files are never uploaded.'
      ),
      h(
        'p',
        {},
        'Built on ',
        link('https://github.com/alam00000/bentopdf', 'BentoPDF'),
        ` ${__APP_VERSION__}: every tool and all PDF processing come from BentoPDF, using the EmbedPDF viewer, PDFium, pdf-lib, PDF.js, qpdf, LibreOffice and other open-source projects. Paperwing adds this interface and the desktop app.`
      ),
      h(
        'p',
        { class: 'about-legal' },
        link(WEBSITE_URL, 'paperwingapp.com'),
        ' · Licensed under the GNU AGPL-3.0. ',
        link(REPO_URL, 'Source code'),
        ' · ',
        link(`${REPO_URL}/blob/main/NOTICE.md`, 'Third-party notices')
      )
    ),
    'dlg-about'
  );
}

function showShortcuts() {
  const groups = new Map<string, typeof SHORTCUTS>();
  for (const sc of SHORTCUTS) {
    if (!groups.has(sc.group)) groups.set(sc.group, []);
    groups.get(sc.group)!.push(sc);
  }
  const body = h('div', { class: 'dlg-body shortcuts' });
  for (const [group, list] of groups) {
    body.append(
      h('div', { class: 'pref-group' }, group),
      h(
        'table',
        { class: 'kbd-table' },
        ...list.map((sc) =>
          h(
            'tr',
            {},
            h('td', {}, sc.label),
            h(
              'td',
              {},
              ...keysFor(sc, isMac).flatMap((k, i) => [
                i ? ' ' : '',
                h('kbd', {}, formatCombo(k, isMac)),
              ])
            )
          )
        )
      )
    );
  }
  if (!getPrefs().singleKey) {
    body.append(
      h(
        'p',
        { class: 'muted' },
        'Single-key tool accelerators are turned off in Preferences.'
      )
    );
  }
  dialog('Keyboard shortcuts', body);
}

/* ------------------------------------------------------------------ */
/* Keyboard, drag & drop, startup                                      */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Dialogs, preferences, session, view modes                           */
/* ------------------------------------------------------------------ */

interface DialogButton<T> {
  label: string;
  value: T;
  kind?: 'primary' | 'secondary' | 'quiet';
}

/** Modal with buttons; resolves with the clicked button's value */
function askDialog<T>(
  title: string,
  message: string,
  buttons: DialogButton<T>[],
  cancelValue: T
): Promise<T> {
  return new Promise((resolve) => {
    const backdrop = h('div', { class: 'dlg-backdrop' });
    const finish = (v: T) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(cancelValue);
      }
    };
    document.addEventListener('keydown', onKey, true);
    const actions = h(
      'div',
      { class: 'dlg-actions' },
      ...buttons.map((b) =>
        h(
          'button',
          {
            type: 'button',
            class:
              b.kind === 'primary'
                ? 'accent-btn'
                : b.kind === 'quiet'
                  ? 'quiet-btn'
                  : 'pill-btn',
            onClick: () => finish(b.value),
          },
          b.label
        )
      )
    );
    backdrop.append(
      h(
        'div',
        { class: 'dlg', role: 'alertdialog', 'aria-label': title },
        h('div', { class: 'dlg-head' }, h('h2', {}, title)),
        h('div', { class: 'dlg-body' }, h('p', {}, message), actions)
      )
    );
    document.body.append(backdrop);
    actions.querySelector<HTMLButtonElement>('.accent-btn')?.focus();
  });
}

/** Password prompt for protected PDFs; resolves null if cancelled */
function passwordDialog(name: string, wrong: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    const backdrop = h('div', { class: 'dlg-backdrop' });
    const input = h('input', {
      type: 'password',
      class: 'dlg-input',
      autocomplete: 'off',
      'aria-label': 'Password',
    }) as HTMLInputElement;
    const finish = (v: string | null) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
      } else if (e.key === 'Enter' && input.value) {
        e.preventDefault();
        finish(input.value);
      }
    };
    document.addEventListener('keydown', onKey, true);
    backdrop.append(
      h(
        'div',
        { class: 'dlg', role: 'dialog', 'aria-label': 'Password' },
        h('div', { class: 'dlg-head' }, h('h2', {}, 'Password')),
        h(
          'div',
          { class: 'dlg-body' },
          h(
            'p',
            {},
            wrong
              ? 'That password is incorrect. Try again.'
              : `“${name}” is protected. Enter the password to open it.`
          ),
          input,
          h(
            'div',
            { class: 'dlg-actions' },
            h(
              'button',
              {
                type: 'button',
                class: 'pill-btn',
                onClick: () => finish(null),
              },
              'Cancel'
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'accent-btn',
                onClick: () => input.value && finish(input.value),
              },
              'Open'
            )
          )
        )
      )
    );
    document.body.append(backdrop);
    input.focus();
  });
}

viewer.passwordPrompt = (tabId, wrong) =>
  passwordDialog(
    tabs.find((t) => t.id === tabId)?.name ?? 'This document',
    wrong
  );

type UnsavedChoice = 'save' | 'discard' | 'cancel';

function confirmUnsaved(docs: Tab[]): Promise<UnsavedChoice> {
  const many = docs.length > 1;
  return askDialog<UnsavedChoice>(
    many ? 'Save changes?' : `Save changes to “${docs[0].name}”?`,
    many
      ? `${docs.length} documents have unsaved changes. Your changes will be lost if you don't save them.`
      : "Your changes will be lost if you don't save them.",
    [
      { label: "Don't save", value: 'discard', kind: 'quiet' },
      { label: 'Cancel', value: 'cancel', kind: 'secondary' },
      { label: many ? 'Save all' : 'Save', value: 'save', kind: 'primary' },
    ],
    'cancel'
  );
}

/** Ask about unsaved documents (saving them if wanted); false = cancelled */
/** Unsaved work in `list` (all tabs by default): ask once, and save if asked */
async function settleUnsaved(list: Tab[] = tabs): Promise<boolean> {
  for (const t of list.filter((t) => t.fullTool?.dirty))
    if (!(await mayDiscardTool(t))) return false;
  const dirty = list.filter(isDirty);
  if (!dirty.length) return true;
  const choice = await confirmUnsaved(dirty);
  if (choice === 'cancel') return false;
  if (choice === 'save') {
    for (const d of dirty) {
      activate(d.id);
      if (!(await saveDoc(d))) return false;
    }
  }
  return true;
}

async function closeAllTabs(): Promise<boolean> {
  return closeTabs([...tabs]);
}

/** Close several tabs, asking once about unsaved work among them */
async function closeTabs(list: Tab[]): Promise<boolean> {
  if (!(await settleUnsaved(list))) return false;
  list.forEach((t) => tabs.includes(t) && closeTab(t.id));
  return true;
}

viewer.onChange((tabId) => {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return;
  const wasDirty = isDirty(tab);
  tab.version++;
  if (!wasDirty) renderTabs();
  scheduleRecoveryCopy(tab);
});

// Closing the app window with unsaved work
window.addEventListener('beforeunload', (e) => {
  if (!desktop && tabs.some(isDirty)) e.preventDefault();
});
/** Before quitting (closing the window, or restarting for an update): deal
 *  with unsaved documents, then save the session and where each document
 *  is. False if the user cancelled. The tabs stay open so the saved session
 *  can reopen them. */
async function prepareToQuit(): Promise<boolean> {
  if (!(await settleUnsaved())) return false;
  // No background copy may land after the cleanup below
  tabs.forEach(cancelRecoveryCopy);
  persistSession();
  await Promise.all(tabs.map(flushView));
  // Saved documents dropped their recovery copies already; any left belong
  // to documents the user chose not to save
  await Promise.all(
    tabs
      .filter((t) => t.recoveryId)
      .map((t) => desktop!.recovery?.delete(t.recoveryId!))
  );
  return true;
}

desktop?.onCloseRequested?.(async () => {
  if (await prepareToQuit()) void desktop!.confirmClose();
});

/* Session restore ------------------------------------------------------ */

const SESSION_KEY = 'paperwing:session';
let restoring = false;
/** A file the OS asked us to open during the restore; it stays in front */
let launchPath: string | undefined;

function persistSession() {
  if (restoring) return;
  const docs = tabs.filter((t) => !!t.recentId).map((t) => t.recentId!);
  const active = activeDoc()?.recentId ?? null;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ docs, active }));
  } catch {
    /* storage unavailable */
  }
}

async function restoreSession() {
  if (!getPrefs().restoreSession) return;
  let saved: { docs: string[]; active: string | null } | null = null;
  try {
    saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
  } catch {
    saved = null;
  }
  if (!saved?.docs?.length) return;
  // Tabs come back at once; only the one in front loads its document now,
  // the rest when they're first shown (see loadPending)
  restoring = true;
  const restored: Tab[] = [];
  try {
    const recent = await listRecent();
    for (const id of saved.docs) {
      const entry = recent.find((r) => r.id === id);
      // Files remembered only by browser handle need a click to re-grant access
      if (!entry || (!entry.path && !entry.data)) continue;
      // Already opened meanwhile (the file the OS launched us with)
      if (entry.path && tabs.some((t) => t.path === entry.path)) continue;
      const tab = createTab(entry.name, false);
      tab.pending = entry;
      tab.path = entry.path;
      tab.recentId = entry.id;
      tab.starred = entry.starred;
      restored.push(tab);
    }
  } finally {
    restoring = false;
  }
  // The file the OS asked for stays in front; otherwise the last active one
  const front = launchPath
    ? tabs.find((t) => t.path === launchPath)
    : (restored.find((t) => t.recentId === saved!.active) ?? restored.at(-1));
  launchPath = undefined;
  if (front && (activeId === 'home' || front.id !== activeId))
    activate(front.id);
  else renderTabs();
  persistSession();
}

/** A tab restored from the last session loads its document on first view */
async function loadPending(tab: Tab) {
  const entry = tab.pending;
  if (!entry) return;
  tab.pending = undefined;
  const got = await reopenRecent(entry).catch((): null => null);
  if (!tabs.includes(tab)) return;
  if (!got) {
    toast(`${entry.name} is no longer available`);
    closeTab(tab.id);
    return;
  }
  await openDocument(
    got.file,
    { handle: got.handle, path: got.path },
    entry.id,
    tab
  );
}

/* Read mode & full screen -------------------------------------------- */

function setReadMode(on: boolean) {
  document.body.classList.toggle('is-reading', on);
  if (on)
    toast(`Read mode — press Esc or ${shortcutLabel('readMode')} to exit`);
  if (!on && document.fullscreenElement) void document.exitFullscreen();
}

async function toggleFullScreen() {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
    setReadMode(false);
  } else {
    setReadMode(true);
    await document.documentElement.requestFullscreen().catch(() => {});
  }
}
document.addEventListener('fullscreenchange', () => {
  if (
    !document.fullscreenElement &&
    document.body.classList.contains('is-reading')
  ) {
    setReadMode(false);
  }
});

/* Zoom to (Ctrl+Y) --------------------------------------------------- */

function showZoomMenu(
  doc: Tab,
  anchor: HTMLElement = $('#right-rail .rr-zoom') ?? $('#find-btn')
) {
  const level = (label: string, zoom: number | string): MenuItem => ({
    label,
    onClick: () => viewer.setZoom(doc.id, zoom),
  });
  // Or type any percentage
  const current = viewer.zoom(doc.id);
  const input = h('input', {
    type: 'text',
    inputmode: 'numeric',
    value: current ? String(Math.round(current * 100)) : '',
    'aria-label': 'Zoom percentage',
    spellcheck: 'false',
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const pct = parseFloat(input.value.replace('%', ''));
    if (!Number.isFinite(pct)) return;
    closePopover?.();
    viewer.setZoom(doc.id, Math.min(6000, Math.max(20, pct)) / 100);
  });
  showMenu(
    anchor,
    [
      level('Fit page', 'fit-page'),
      level('Fit width', 'fit-width'),
      { divider: true },
      level('50%', 0.5),
      level('75%', 0.75),
      level('100% (actual size)', 1),
      level('125%', 1.25),
      level('150%', 1.5),
      level('200%', 2),
      level('300%', 3),
      level('400%', 4),
    ],
    anchor.closest('#right-rail') ? 'left' : 'below',
    h(
      'label',
      { class: 'zoom-custom' },
      h('span', {}, 'Zoom'),
      input,
      h('span', {}, '%')
    )
  );
  input.focus();
  input.select();
}

/* Document properties (Ctrl+D) ----------------------------------------- */

function showProperties(doc: Tab) {
  const info = viewer.docInfo(doc.id);
  const inches = (pt: number) => (pt / 72).toFixed(2);
  const mm = (pt: number) => Math.round((pt / 72) * 25.4);
  const rows: [string, string][] = [
    ['File name', doc.name],
    [
      'Location',
      doc.path ?? (doc.handle ? 'On this computer' : 'Not saved yet'),
    ],
    ['Pages', info ? String(info.pages) : '—'],
    [
      'Page size',
      info && info.width
        ? `${inches(info.width)} × ${inches(info.height)} in (${mm(info.width)} × ${mm(info.height)} mm)`
        : '—',
    ],
    ['Unsaved changes', isDirty(doc) ? 'Yes' : 'No'],
  ];
  const editMeta = getTool('edit-metadata');
  const close = dialog(
    'Document properties',
    h(
      'div',
      { class: 'dlg-body' },
      h(
        'table',
        { class: 'props-table' },
        ...rows.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v)))
      ),
      editMeta &&
        h(
          'div',
          { class: 'dlg-actions' },
          h(
            'button',
            {
              type: 'button',
              class: 'pill-btn',
              onClick: () => {
                close();
                void openToolOnDoc(doc, editMeta);
              },
            },
            'Edit metadata…'
          )
        )
    )
  );
}

/* Preferences (Ctrl+K) --------------------------------------------------- */

function showPreferences() {
  const prefs = getPrefs();
  const toggle = (
    label: string,
    hint: string,
    checked: boolean,
    onChange: (v: boolean) => void
  ) => {
    const input = h('input', { type: 'checkbox', checked });
    input.addEventListener('change', () => onChange(input.checked));
    return h(
      'label',
      { class: 'pref-row' },
      input,
      h('span', {}, h('b', {}, label), h('small', {}, hint))
    );
  };
  const themeSelect = h(
    'select',
    { class: 'pref-select', 'aria-label': 'Appearance' },
    h('option', { value: 'system' }, 'Use system setting'),
    h('option', { value: 'light' }, 'Light'),
    h('option', { value: 'dark' }, 'Dark')
  );
  themeSelect.value = getThemePref();
  themeSelect.addEventListener('change', () =>
    setThemePref(themeSelect.value as ThemePref)
  );
  const close = dialog(
    'Preferences',
    h(
      'div',
      { class: 'dlg-body prefs' },
      h('div', { class: 'pref-group' }, 'Appearance'),
      h(
        'label',
        { class: 'pref-row' },
        h('span', {}, h('b', {}, 'Theme')),
        themeSelect
      ),
      h('div', { class: 'pref-group' }, 'Documents'),
      (() => {
        const sel = h(
          'select',
          { class: 'pref-select', 'aria-label': 'Default zoom' },
          h('option', { value: 'automatic' }, 'Automatic'),
          h('option', { value: 'fit-width' }, 'Fit width'),
          h('option', { value: 'fit-page' }, 'Fit page'),
          h('option', { value: '100' }, '100%')
        );
        sel.value = getPrefs().defaultZoom;
        sel.addEventListener('change', () =>
          setPrefs({ defaultZoom: sel.value as Prefs['defaultZoom'] })
        );
        return h(
          'label',
          { class: 'pref-row' },
          h(
            'span',
            {},
            h('b', {}, 'Default zoom'),
            h('small', {}, 'How new documents open.')
          ),
          sel
        );
      })(),
      h('div', { class: 'pref-group' }, 'Keyboard'),
      toggle(
        'Single-key accelerators',
        'Press H, V, S, U, D, X… to pick tools, like Acrobat.',
        prefs.singleKey,
        (v) => setPrefs({ singleKey: v })
      ),
      h('div', { class: 'pref-group' }, 'Startup'),
      toggle(
        'Reopen documents from last session',
        'Restores your open tabs when Paperwing starts.',
        prefs.restoreSession,
        (v) => setPrefs({ restoreSession: v })
      ),
      toggle(
        'Reopen documents where I left off',
        'Each document opens at the page and zoom it was last viewed at.',
        prefs.restoreView,
        (v) => setPrefs({ restoreView: v })
      ),
      toggle(
        'Check for updates',
        'Looks for new versions on GitHub when Paperwing starts and every two hours. Nothing else is sent.',
        prefs.checkUpdates,
        (v) => setPrefs({ checkUpdates: v })
      ),
      h('div', { class: 'pref-group' }, 'Advanced'),
      h(
        'div',
        { class: 'pref-row' },
        h(
          'span',
          {},
          h('b', {}, 'Engine settings'),
          h(
            'small',
            {},
            'Where PyMuPDF, Ghostscript and CoherentPDF are loaded from (for offline or custom setups).'
          )
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'pill-btn',
            onClick: () => {
              close();
              void runTool({
                id: 'wasm-settings',
                name: 'Engine settings',
                icon: 'gear-six',
                color: '#6e6e6e',
                desc: '',
                href: `${import.meta.env.BASE_URL}wasm-settings.html`,
              });
            },
          },
          'Open'
        )
      )
    )
  );
}

/* Command palette (Shift+Ctrl+P) ----------------------------------------- */

interface PaletteItem {
  label: string;
  hint?: string;
  icon: Node;
  run: () => void;
}

function paletteCommands(): PaletteItem[] {
  const doc = activeDoc();
  const items: PaletteItem[] = [];
  for (const s of SHORTCUTS) {
    if (s.singleKey) continue;
    if (
      !doc &&
      ![
        'open',
        'create',
        'prefs',
        'reopen',
        'closeAll',
        'nextTab',
        'prevTab',
      ].includes(s.id)
    ) {
      continue;
    }
    items.push({
      label: s.label,
      hint: formatCombo(keysFor(s, isMac)[0], isMac),
      icon: icon('chevronRight', 16),
      run: () => runShortcut(s.id),
    });
  }
  items.push(
    {
      label: 'Appearance: Light',
      icon: icon('theme', 16),
      run: () => setThemePref('light'),
    },
    {
      label: 'Appearance: Dark',
      icon: icon('theme', 16),
      run: () => setThemePref('dark'),
    },
    {
      label: 'Appearance: Use system setting',
      icon: icon('theme', 16),
      run: () => setThemePref('system'),
    },
    { label: 'Keyboard shortcuts', icon: icon('help', 16), run: showShortcuts },
    ...(knownUpdate()
      ? [
          {
            label: knownUpdate()!.auto
              ? `Update to Paperwing ${knownUpdate()!.version}`
              : `Download Paperwing ${knownUpdate()!.version}`,
            icon: icon('download', 16),
            run: () => getUpdate(knownUpdate()!),
          },
        ]
      : []),
    {
      label: 'Check for updates',
      icon: icon('download', 16),
      run: () => void checkForUpdates(toast, true),
    }
  );
  return items;
}

function openPalette(anchor?: HTMLElement) {
  const doc = activeDoc();
  const input = h('input', {
    type: 'search',
    class: 'find-input',
    placeholder: doc
      ? 'Find text, tools or commands'
      : 'Find tools or commands',
  });
  const results = h('div', { class: 'find-results' });
  const row = (label: string, iconNode: Node, run: () => void, hint?: string) =>
    h(
      'button',
      {
        type: 'button',
        class: 'menu-item',
        onClick: () => {
          closePopover?.();
          run();
        },
      },
      h('span', { class: 'mi-icon' }, iconNode),
      h('span', { class: 'mi-label' }, label),
      hint && h('span', { class: 'mi-key' }, hint)
    );
  const render = () => {
    const q = input.value.trim().toLowerCase();
    const out: HTMLElement[] = [];
    if (doc && q) {
      out.push(
        row(
          `Find “${input.value.trim()}” in document`,
          icon('search', 16),
          () => viewer.command(doc.id, 'panel:toggle-search')
        )
      );
    }
    const tools = searchTools(q).slice(0, q ? 8 : 5);
    if (tools.length) {
      out.push(h('div', { class: 'find-head' }, 'Tools'));
      tools.forEach((t) =>
        out.push(
          row(
            t.name,
            toolIcon(t.icon, t.color, 18),
            (): void => void runTool(t)
          )
        )
      );
    }
    const cmds = paletteCommands().filter(
      (c) => !q || c.label.toLowerCase().includes(q)
    );
    if (cmds.length) {
      out.push(h('div', { class: 'find-head' }, 'Commands'));
      cmds
        .slice(0, q ? 8 : 6)
        .forEach((c) => out.push(row(c.label, c.icon, c.run, c.hint)));
    }
    if (!out.length) out.push(h('div', { class: 'find-empty' }, 'No matches'));
    results.replaceChildren(...out);
  };
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    const items = [
      ...results.querySelectorAll<HTMLButtonElement>('.menu-item'),
    ];
    if (e.key === 'Enter') items[0]?.click();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[0]?.focus();
    }
  });
  results.addEventListener('keydown', (e) => {
    const items = [
      ...results.querySelectorAll<HTMLButtonElement>('.menu-item'),
    ];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[Math.min(i + 1, items.length - 1)]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (i <= 0) input.focus();
      else items[i - 1].focus();
    }
  });
  render();
  const target = anchor ?? (doc ? $('#find-btn') : $('#tabs'));
  showPopover(target, h('div', { class: 'find-pop' }, input, results));
  input.focus();
}

/* ------------------------------------------------------------------ */
/* Keyboard shortcuts (Acrobat-compatible, see keymap.ts)              */
/* ------------------------------------------------------------------ */

// Shift+D and Shift+U step through these (quick toolbar tool ids)
const SHAPES = ['rectangle', 'oval', 'line', 'arrow', 'polygon'];
const MARKUPS = ['underline', 'strikeout', 'squiggly'];
let shapeIdx = -1;
let markupIdx = -1;

function goPage(doc: Tab, which: 'first' | 'last') {
  const info = viewer.pageInfo(doc.id);
  if (info) viewer.goToPage(doc.id, which === 'first' ? 1 : info.total);
}

function switchTab(dir: 1 | -1) {
  const ids = ['home', ...tabs.map((t) => t.id)];
  const i = ids.indexOf(activeId);
  activate(ids[(i + dir + ids.length) % ids.length]);
}

/** Returns false if the action doesn't apply right now (key passes through) */
function runShortcut(id: string): boolean {
  const doc = activeDoc();
  const needDoc = (fn: (d: Tab) => void) => {
    if (!doc) return false;
    fn(doc);
    return true;
  };
  // Actions on the document viewer. A full-page tool (Organize pages, Edit
  // a PDF…) covers the viewer and has its own controls: acting on the
  // hidden viewer then would only change things out of sight.
  const onViewer = (fn: (d: Tab) => void) =>
    !!doc && !doc.fullTool && needDoc(fn);
  const cmd = (command: string) =>
    onViewer((d) => viewer.command(d.id, command));
  const annot = (button: string, command: string) =>
    onViewer((d) => runAnnotCommand(d, button, command));
  // A tool from the quick toolbar (which then shows it on its button)
  const quick = (group: string, toolId: string) =>
    onViewer((d) => useQuickTool(d, group, toolId));
  const tool = (toolId: string, name?: string) =>
    needDoc((d) => {
      const t = getTool(toolId);
      if (t) void openToolOnDoc(d, name ? { ...t, name } : t);
    });

  switch (id) {
    case 'open':
      void openFromDialog();
      return true;
    case 'create':
      showMenu($('#create-btn'), createMenuItems());
      return true;
    case 'save':
      return needDoc((d) => void saveDoc(d));
    case 'saveAs':
      return needDoc((d) => void saveDoc(d, true));
    case 'print':
      return cmd('document:print');
    case 'close':
      if (activeId === 'home') return false;
      void requestCloseTab(activeId);
      return true;
    case 'closeAll':
      void closeAllTabs();
      return true;
    case 'reopen':
      void reopenClosedTab();
      return true;
    case 'properties':
      return needDoc(showProperties);
    case 'prefs':
      showPreferences();
      return true;
    case 'quit':
      if (desktop) void desktop.requestClose();
      else window.close();
      return true;
    case 'undo':
      return onViewer((d) => stepEdit(d, 'undo'));
    case 'redo':
      return onViewer((d) => stepEdit(d, 'redo'));
    case 'find':
    case 'findAdvanced':
      return cmd('panel:toggle-search');
    case 'findNext':
      return onViewer((d) => viewer.searchStep(d.id, 1));
    case 'findPrev':
      return onViewer((d) => viewer.searchStep(d.id, -1));
    case 'palette':
      openPalette();
      return true;
    case 'nextPage':
      return cmd('scroll:next-page');
    case 'prevPage':
      return cmd('scroll:previous-page');
    case 'firstPage':
      return onViewer((d) => goPage(d, 'first'));
    case 'lastPage':
      return onViewer((d) => goPage(d, 'last'));
    case 'goToPage':
      return onViewer(() => {
        const input = $<HTMLInputElement>('#right-rail .rr-page');
        input?.focus();
        input?.select();
      });
    case 'nextTab':
      switchTab(1);
      return true;
    case 'prevTab':
      switchTab(-1);
      return true;
    case 'zoomIn':
      return cmd('zoom:in');
    case 'zoomOut':
      return cmd('zoom:out');
    case 'zoomTo':
      return onViewer((d) => showZoomMenu(d));
    case 'actualSize':
      return cmd('zoom:100');
    case 'fitPage':
      return cmd('zoom:fit-page');
    case 'fitWidth':
    case 'fitVisible':
      return cmd('zoom:fit-width');
    case 'rotateCw':
      return cmd('rotate:clockwise');
    case 'rotateCcw':
      return cmd('rotate:counter-clockwise');
    case 'fullScreen':
      return needDoc(() => void toggleFullScreen());
    case 'readMode':
      return needDoc(() =>
        setReadMode(!document.body.classList.contains('is-reading'))
      );
    case 'navPane':
      return onViewer((d) =>
        viewer.toggleSidebar(d.id, 'sidebar-panel', 'thumbnails')
      );
    case 'toolsPane':
      return needDoc((d) => {
        d.panelOpen = !d.panelOpen;
        renderDocChrome(d);
      });
    case 'toolHand':
      return quick('select', 'hand');
    case 'toolSelect':
      return quick('select', 'select');
    case 'toolZoom':
      return quick('select', 'marquee');
    case 'toolNote':
      return quick('comment', 'note');
    case 'toolHighlight':
      return quick('highlight', 'highlight');
    case 'toolMarkup':
      markupIdx = (markupIdx + 1) % MARKUPS.length;
      return quick('highlight', MARKUPS[markupIdx]);
    case 'toolText':
      return quick('text', 'text');
    case 'toolDraw':
      return quick('ink', 'ink');
    case 'toolShapes':
      shapeIdx = (shapeIdx + 1) % SHAPES.length;
      return quick('ink', SHAPES[shapeIdx]);
    case 'toolStamp':
      return quick('comment', 'stamp');
    case 'toolLink':
      return annot('more', 'annotation:add-link');
    case 'toolRedact':
      return onViewer((d) => runViewerAction(d, getTool('redact')!));
    case 'toolEditText':
      return tool('edit-pdf-text', 'Edit text & images');
    case 'toolCrop':
      return tool('crop-pdf');
  }
  return false;
}

/** The element that really has focus, looking inside shadow roots */
function deepTarget(e: Event): HTMLElement | null {
  return (e.composedPath()[0] as HTMLElement) ?? null;
}

const isEditable = (el: HTMLElement | null) =>
  !!el &&
  (el.isContentEditable ||
    /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) ||
    !!el.closest?.('[contenteditable="true"]'));

/** Shared by the shell and by keys forwarded from tool frames */
function handleKey(e: KeyInput, editing: boolean, fromFrame = false): boolean {
  const hasMod = e.ctrlKey || e.metaKey || e.altKey;
  // Leave typing alone: plain keys and text-editing combos in fields
  if (editing && (!hasMod || /^[zyxcva]$/i.test(e.key))) return false;
  // Arrow/Home/End navigate menus while one is open
  if (!hasMod && closePopover && /^(Arrow|Home|End)/.test(e.key)) return false;
  const shortcut = findShortcut(e, isMac, getPrefs().singleKey);
  if (!shortcut) return false;
  // Inside a tool, undo/find/tool keys belong to the tool, not the document
  if (
    fromFrame &&
    (shortcut.singleKey ||
      /^(undo|redo|find|findAdvanced|findNext|findPrev|nextPage|prevPage|firstPage|lastPage)$/.test(
        shortcut.id
      ))
  ) {
    return false;
  }
  return runShortcut(shortcut.id);
}

window.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Escape') {
      if (document.body.classList.contains('is-reading')) {
        setReadMode(false);
        e.preventDefault();
        return;
      }
      const doc = activeDoc();
      if (doc?.activeAnnot && !closePopover && !isEditable(deepTarget(e))) {
        setAnnot(doc, 'select');
        return;
      }
    }
    if (document.querySelector('.dlg-backdrop')) return;
    if (handleKey(e, isEditable(deepTarget(e)))) {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true
);

// Tool frames forward shortcut keys they don't use (see reskin.ts)
window.addEventListener('message', (e: MessageEvent) => {
  if (e.data?.type !== 'acro:key' || !frameToolFor(e)) return;
  if (document.querySelector('.dlg-backdrop')) return;
  const k = e.data.key;
  if (typeof k?.key !== 'string') return;
  const input: KeyInput = {
    key: k.key,
    code: String(k.code ?? ''),
    ctrlKey: !!k.ctrlKey,
    metaKey: !!k.metaKey,
    shiftKey: !!k.shiftKey,
    altKey: !!k.altKey,
  };
  handleKey(input, !!e.data.editing, true);
});

let dragDepth = 0;
const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  document.body.classList.add('is-dragging');
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('is-dragging');
  }
});
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('is-dragging');
  // Dropped onto the page thumbnails: inserted there instead
  if (droppedOnPages.has(e)) return;
  const items = Array.from(e.dataTransfer!.items);
  const getHandle = (
    it: DataTransferItem
  ): Promise<FileSystemHandle | null> | undefined =>
    (it as any).getAsFileSystemHandle?.();
  const handles = await Promise.all(
    items.map(
      (it): Promise<FileSystemHandle | null> | null =>
        getHandle(it)?.catch((): null => null) ?? null
    )
  );
  const files = Array.from(e.dataTransfer!.files);
  const pdfs = files.filter(isPdf);
  let into = activeTab()?.blank ? activeTab() : undefined;
  for (const f of pdfs) {
    if (desktop) {
      // A file on disk opens like one from the dialog; one dragged from a
      // browser or an email has no path, so it opens unsaved
      const path = desktop.pathForFile?.(f) || undefined;
      if (path && !(await desktop.allowPath?.(path))) continue;
      await openDocument(f, { path }, undefined, into, path ? undefined : {});
    } else {
      const handle = handles.find(
        (hd): hd is FileSystemFileHandle =>
          hd?.kind === 'file' && hd.name === f.name
      );
      await openDocument(f, { handle }, undefined, into);
    }
    into = undefined;
  }
  const others = files.filter((f) => !isPdf(f));
  if (others.length) await openFiles(others);
});

$('#home-btn').addEventListener('click', () => activate('home'));

// Theme the page, and tell the Electron shell so native chrome matches and
// the tool frames (which can't see this page's storage) follow along
applyTheme();
onThemeChange(() => {
  const pref = getThemePref();
  void desktop?.setTheme(pref);
  frameTools.forEach((ft) => postToFrame(ft, { type: 'acro:theme', pref }));
});
void desktop?.setTheme(getThemePref());

// Desktop app (Electron): native title bar buttons are drawn by the OS over
// the right (Windows) or left (macOS) end of our title bar.
if (desktop) {
  document.body.classList.add('is-desktop', isMac ? 'is-mac' : 'is-win');
  desktop.onFileChanged?.((path) => void noticeDiskChange(path));
  desktop.onOpenFile((f) => {
    performance.mark('pw:file-received');
    if (restoring) launchPath = f.path;
    void openDocument(toFile(f), { path: f.path });
  });
  desktop.onMenuCommand?.((command) => {
    // Like shortcut keys, menu commands wait while a dialog is open
    if (document.querySelector('.dlg-backdrop')) return;
    if (command === 'about') return showAbout();
    if (command === 'shortcuts') return showShortcuts();
    if (command === 'undo' || command === 'redo') {
      // Inside a tool, undo belongs to the tool (as with forwarded keys):
      // it undoes typing in the focused field
      const focused = document.activeElement as HTMLElement | null;
      const ft = [...frameTools].find((t) => t.frame === focused);
      if (ft) {
        postToFrame(ft, { type: 'acro:edit', command });
        return;
      }
      // Text fields get normal text undo
      if (isEditable(focused)) {
        document.execCommand(command);
        return;
      }
    }
    runShortcut(command);
  });
  // First Office → PDF conversion downloads LibreOffice; main reports errors
  let engineStatus: ReturnType<typeof statusToast> | null = null;
  desktop.onEngineProgress?.(({ percent, error }) => {
    if (error || (percent ?? 0) >= 100) {
      engineStatus?.close();
      engineStatus = null;
      return;
    }
    const pct = percent == null ? '' : ` ${Math.floor(percent)}%`;
    const msg = `Downloading the Office conversion engine (one time)…${pct}`;
    if (engineStatus) engineStatus.update(msg);
    else engineStatus = statusToast(msg);
  });
  // A newer version: a notice when it's found (until "Later"), and the
  // Help marker until this build is updated
  onUpdateAvailable((update, fresh) => {
    showUpdateMarker(update);
    if (fresh && !isRemindLater(update.version) && !updateProgress)
      updateAvailableToast(update);
  });
  if (getPrefs().checkUpdates) scheduleUpdateCheck(toast);
  // The Windows installer downloaded an update: offer to restart into it
  // (it also installs on the next quit)
  desktop.onUpdateReady?.(({ version }) => updateReadyToast(version));
}

declare const __APP_VERSION__: string;
declare const __PAPERWING_VERSION__: string;
declare const __PAPERWING_REPO__: string;

// Inspection hook for the end-to-end tests (desktop/tests)
(window as any).__acro = { viewer };

hydrateIcons();
initTooltips();
renderRecommended();
activate('home');
document.documentElement.dataset.ready = '';
// The first screen is drawn: the desktop shell can show the window now, and
// hands over any file the OS asked it to open
void desktop?.ready();
void restoreSession().then(recoverUnsaved);
// Start the PDF engine straight away (it compiles in a worker), so the first
// document doesn't wait for it
void viewer.warmUp();
