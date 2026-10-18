/**
 * Unit tests for the Paperwing desktop shell (src/acro, src/reskin).
 * End-to-end UI tests live in desktop/tests.
 */
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

(globalThis as any).__PAPERWING_VERSION__ = '1.2.0';
(globalThis as any).__PAPERWING_REPO__ = 'owner/paperwing';

import {
  findShortcut,
  formatCombo,
  keysFor,
  matchesCombo,
  SHORTCUTS,
  type KeyInput,
} from '../acro/keymap';
import { isNewer } from '../acro/updates';
import {
  allToolGroups,
  convertTools,
  editTools,
  getTool,
  groups,
  quickTools,
  recommendedTools,
  signTools,
  toolForFile,
} from '../acro/catalog';
import { getPrefs, noteToolUsed, setPrefs, togglePinned } from '../acro/prefs';
import { getThemePref, isThemePref, setThemePref } from '../reskin/theme';
import {
  SHELL_ORIGIN,
  TOOLS_ORIGIN,
  shellOrigin,
  toolsOrigin,
} from '../reskin/origins';

const key = (k: Partial<KeyInput> & { key: string }): KeyInput => ({
  code: '',
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...k,
});

describe('keymap', () => {
  it('matches Ctrl combos on Windows and Cmd combos on macOS', () => {
    const ctrlS = key({ key: 's', code: 'KeyS', ctrlKey: true });
    const cmdS = key({ key: 's', code: 'KeyS', metaKey: true });
    expect(matchesCombo(ctrlS, 'Ctrl+S', false)).toBe(true);
    expect(matchesCombo(cmdS, 'Ctrl+S', false)).toBe(false);
    expect(matchesCombo(cmdS, 'Ctrl+S', true)).toBe(true);
    expect(matchesCombo(ctrlS, 'Ctrl+S', true)).toBe(false);
  });

  it('distinguishes Save from Save As', () => {
    const e = key({ key: 'S', code: 'KeyS', ctrlKey: true, shiftKey: true });
    expect(findShortcut(e, false, true)?.id).toBe('saveAs');
  });

  it('maps Acrobat zoom and rotate keys', () => {
    expect(
      findShortcut(key({ key: '=', code: 'Equal', ctrlKey: true }), false, true)
        ?.id
    ).toBe('zoomIn');
    expect(
      findShortcut(key({ key: '-', code: 'Minus', ctrlKey: true }), false, true)
        ?.id
    ).toBe('zoomOut');
    expect(
      findShortcut(
        key({ key: '0', code: 'Digit0', ctrlKey: true }),
        false,
        true
      )?.id
    ).toBe('fitPage');
    expect(
      findShortcut(
        key({ key: '1', code: 'Digit1', ctrlKey: true }),
        false,
        true
      )?.id
    ).toBe('actualSize');
    expect(
      findShortcut(
        key({ key: '+', code: 'Equal', ctrlKey: true, shiftKey: true }),
        false,
        true
      )?.id
    ).toBe('rotateCw');
    expect(findShortcut(key({ key: 'F4', code: 'F4' }), false, true)?.id).toBe(
      'navPane'
    );
    expect(
      findShortcut(key({ key: 'F3', code: 'F3', shiftKey: true }), false, true)
        ?.id
    ).toBe('findPrev');
  });

  it('uses Control (not Command) for tab switching on macOS', () => {
    const e = key({ key: 'Tab', code: 'Tab', ctrlKey: true });
    expect(findShortcut(e, true, true)?.id).toBe('nextTab');
  });

  it('honours the single-key accelerator preference', () => {
    const u = key({ key: 'u', code: 'KeyU' });
    expect(findShortcut(u, false, true)?.id).toBe('toolHighlight');
    expect(findShortcut(u, false, false)).toBeUndefined();
    // Modifier shortcuts still work with single keys off
    expect(
      findShortcut(key({ key: 'o', code: 'KeyO', ctrlKey: true }), false, false)
        ?.id
    ).toBe('open');
  });

  it('has no duplicate shortcut ids or conflicting combos', () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const mac of [false, true]) {
      const combos = SHORTCUTS.flatMap((s) => keysFor(s, mac));
      expect(new Set(combos).size).toBe(combos.length);
    }
  });

  it('moves Read mode off ⌘H (Hide) on macOS', () => {
    const readMode = SHORTCUTS.find((s) => s.id === 'readMode')!;
    expect(keysFor(readMode, false)).toEqual(['Ctrl+H']);
    expect(keysFor(readMode, true)).toEqual(['Shift+Ctrl+H']);
    const h = { key: 'h', code: 'KeyH' };
    expect(findShortcut(key({ ...h, ctrlKey: true }), false, true)?.id).toBe(
      'readMode'
    );
    expect(
      findShortcut(key({ ...h, metaKey: true }), true, true)
    ).toBeUndefined();
    expect(
      findShortcut(key({ ...h, metaKey: true, shiftKey: true }), true, true)?.id
    ).toBe('readMode');
    // Shortcuts without a macOS override use the same combos everywhere
    const save = SHORTCUTS.find((s) => s.id === 'save')!;
    expect(keysFor(save, true)).toBe(save.keys);
  });

  it('formats combos per platform', () => {
    expect(formatCombo('Shift+Ctrl+S', false)).toBe('Shift+Ctrl+S');
    expect(formatCombo('Shift+Ctrl+S', true)).toBe('⇧⌘S');
    expect(formatCombo('Ctrl+Plus', true)).toBe('⌘+');
  });
});

describe('update check', () => {
  it('compares semantic versions', () => {
    expect(isNewer('v1.2.1', '1.2.0')).toBe(true);
    expect(isNewer('v1.10.0', '1.9.9')).toBe(true);
    expect(isNewer('v1.2.0', '1.2.0')).toBe(false);
    expect(isNewer('1.1.9', '1.2.0')).toBe(false);
    expect(isNewer('v2.0.0-beta.1', '1.9.0')).toBe(true);
  });
});

describe('tool catalogue', () => {
  const pages = new Set(
    readdirSync(resolve(__dirname, '..', 'pages')).map((f) =>
      f.replace(/\.html$/, '')
    )
  );

  it('links every tool to an existing page', () => {
    for (const g of groups) {
      for (const t of g.tools) {
        expect(t.href, t.id).toBeTruthy();
        expect(pages.has(t.id), `${t.id} has a page`).toBe(true);
      }
    }
  });

  it('builds every panel list from real tools', () => {
    const lists = [
      { name: 'quick', tools: quickTools() },
      { name: 'recommended', tools: recommendedTools() },
      ...editTools(),
      ...convertTools(),
      ...signTools(),
      ...allToolGroups(),
    ];
    for (const list of lists) {
      expect(list.tools.length, list.name).toBeGreaterThan(0);
      for (const t of list.tools) {
        expect(t, `${list.name} entry`).toBeTruthy();
        expect(t.href || t.action, t.id).toBeTruthy();
      }
    }
  });

  it('provides viewer-based tools', () => {
    expect(getTool('comment')?.action).toBe('comment');
    expect(getTool('redact')?.action).toBe('redact');
  });

  it('routes dropped files to the right converter', () => {
    const f = (name: string) => new File(['x'], name);
    expect(toolForFile(f('scan.JPG'))?.id).toBe('jpg-to-pdf');
    expect(toolForFile(f('letter.docx'))?.id).toBe('word-to-pdf');
    expect(toolForFile(f('sheet.xlsx'))?.id).toBe('excel-to-pdf');
    expect(toolForFile(f('notes.md'))?.id).toBe('markdown-to-pdf');
    expect(toolForFile(f('archive.zip'))).toBeUndefined();
  });
});

describe('preferences', () => {
  beforeEach(() => {
    localStorage.clear();
    setPrefs({ pinnedTools: [], recentTools: [] });
  });

  it('pins and unpins tools', () => {
    expect(togglePinned('merge-pdf')).toBe(true);
    expect(getPrefs().pinnedTools).toEqual(['merge-pdf']);
    expect(togglePinned('merge-pdf')).toBe(false);
    expect(getPrefs().pinnedTools).toEqual([]);
  });

  it('keeps the five most recently used tools, newest first', () => {
    ['a', 'b', 'c', 'd', 'e', 'f', 'b'].forEach((id) =>
      noteToolUsed(id, id.toUpperCase())
    );
    expect(getPrefs().recentTools).toEqual(['b', 'f', 'e', 'd', 'c']);
  });

  it('remembers the name each recent tool was opened under', () => {
    setPrefs({ recentTools: [], recentToolNames: {} });
    noteToolUsed('pdf-multi-tool', 'Organize pages');
    noteToolUsed('form-creator', 'Prepare a form');
    noteToolUsed('pdf-multi-tool', 'PDF Multi Tool');
    expect(getPrefs().recentToolNames).toEqual({
      'pdf-multi-tool': 'PDF Multi Tool',
      'form-creator': 'Prepare a form',
    });
    // Names of tools that fall off the list are dropped
    ['a', 'b', 'c', 'd', 'e'].forEach((id) => noteToolUsed(id, id));
    expect(Object.keys(getPrefs().recentToolNames)).toEqual([
      'e',
      'd',
      'c',
      'b',
      'a',
    ]);
  });

  it('persists to localStorage', () => {
    setPrefs({ singleKey: false });
    expect(JSON.parse(localStorage.getItem('paperwing:prefs')!).singleKey).toBe(
      false
    );
  });
});

describe('theme preference', () => {
  it('defaults to the system setting and can be overridden', () => {
    localStorage.clear();
    setThemePref('system');
    expect(getThemePref()).toBe('system');
    expect(document.documentElement.dataset.theme).toBeUndefined();
    setThemePref('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    setThemePref('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    setThemePref('system');
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('only accepts known preferences from messages and URLs', () => {
    expect(['system', 'light', 'dark'].every(isThemePref)).toBe(true);
    expect(isThemePref('blue')).toBe(false);
    expect(isThemePref(null)).toBe(false);
    expect(isThemePref({ toString: () => 'dark' })).toBe(false);
  });
});

describe('origins', () => {
  it('keeps the workspace and tool pages on separate desktop origins', () => {
    expect(SHELL_ORIGIN).not.toBe(TOOLS_ORIGIN);
    expect(new URL(TOOLS_ORIGIN).protocol).toBe(new URL(SHELL_ORIGIN).protocol);
  });

  it('loads tools from the same origin when served from a web server', () => {
    expect(location.origin).not.toBe(SHELL_ORIGIN);
    expect(toolsOrigin()).toBe(location.origin);
  });

  it('has no shell to talk to when not embedded', () => {
    expect(window.self).toBe(window.top);
    expect(shellOrigin()).toBeNull();
  });
});
