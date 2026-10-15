/**
 * Bridge to the Electron shell (desktop/preload.cjs). Undefined when the app
 * runs in a normal browser, where the File System Access API is used instead.
 */

export interface DesktopFile {
  path: string;
  name: string;
  data: Uint8Array;
}

interface DesktopBridge {
  platform: string;
  ready(): Promise<void>;
  setTheme(pref: 'system' | 'light' | 'dark'): Promise<void>;
  openDialog(): Promise<DesktopFile[]>;
  readFile(path: string): Promise<Uint8Array | null>;
  /** Read a recent file for its Home preview (doesn't allow writing it) */
  readPreview?(path: string): Promise<Uint8Array | null>;
  /** Path on disk of a dropped file ('' if it has none) */
  pathForFile?(file: File): string;
  /** Let "Save" write back to a dropped file */
  allowPath?(path: string): Promise<boolean>;
  /** Show a file in File Explorer / Finder */
  showInFolder?(path: string): Promise<void>;
  /** Self-updating install (Windows installer): auto is false otherwise */
  checkUpdate?(): Promise<{
    auto: boolean;
    available?: boolean;
    /** Downloaded already (the restart notice is shown again) */
    ready?: boolean;
    version?: string | null;
    error?: string;
  }>;
  /** Quit and install the downloaded update, then restart */
  installUpdate?(): Promise<boolean>;
  /** A downloaded update is ready to install */
  onUpdateReady?(callback: (info: { version: string }) => void): () => void;
  /** Recovery copies of unsaved documents (see main.cjs) */
  recovery?: {
    save(id: string, name: string, data: Uint8Array): Promise<boolean>;
    list(): Promise<{ id: string; name: string; savedAt: number }[]>;
    read(id: string): Promise<Uint8Array | null>;
    delete(id: string): Promise<void>;
  };
  writeFile(path: string, data: Uint8Array): Promise<boolean>;
  saveAs(
    name: string,
    data: Uint8Array
  ): Promise<{ path: string; name: string } | null>;
  onOpenFile(callback: (file: DesktopFile) => void): () => void;
  /** The window is about to close; call confirmClose() to let it */
  onCloseRequested?(callback: () => void): () => void;
  confirmClose(): Promise<void>;
  /** Close the window as if its close button was clicked */
  requestClose(): Promise<void>;
  /** Application-menu commands (macOS menu bar) */
  onMenuCommand?(callback: (command: string) => void): () => void;
  /** First-use download of the Office conversion engine */
  onEngineProgress?(
    callback: (progress: { percent?: number; error?: boolean }) => void
  ): () => void;
}

export const desktop: DesktopBridge | undefined = (window as any).paperwing;

export const isMac = desktop
  ? desktop.platform === 'darwin'
  : /Mac|iPhone|iPad/.test(navigator.platform);

/** Shortcut label helpers: "Ctrl+S" on Windows, "⌘S" on macOS */
export const key = (combo: string) =>
  isMac
    ? combo
        .replace(/Shift\+/g, '⇧')
        .replace(/Ctrl\+/g, '⌘')
        .replace(/Alt\+/g, '⌥')
    : combo;

export function toFile(f: DesktopFile): File {
  return new File([new Uint8Array(f.data)], f.name, {
    type: 'application/pdf',
  });
}
