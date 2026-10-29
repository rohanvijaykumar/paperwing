/**
 * Bridge to the Electron shell (desktop/preload.cjs). Undefined when the app
 * runs in a normal browser, where the File System Access API is used instead.
 */

export interface DesktopFile {
  path: string;
  name: string;
  data: Uint8Array;
}

export interface Printer {
  name: string;
  displayName: string;
  isDefault: boolean;
}

export type PrintRequest =
  | {
      destination: 'printer';
      printer: string;
      copies: number;
      color: boolean;
      duplex: 'simplex' | 'longEdge' | 'shortEdge';
    }
  | { destination: 'pdf'; name: string };

export interface PrintResult {
  ok: boolean;
  /** Save as PDF: the user closed the save dialog */
  cancelled?: boolean;
  error?: 'busy' | 'no-printers' | 'printer-missing' | 'invalid' | 'failed';
  message?: string;
}

export interface DesktopBridge {
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
  /** SHA-256 (hex) of an open file as it is on disk now; null if it's gone */
  fileHash?(path: string): Promise<string | null>;
  /** The open files to watch for changes made by other apps */
  watchFiles?(paths: string[]): Promise<void>;
  /** A watched file changed on disk */
  onFileChanged?(callback: (path: string) => void): () => void;
  /** Clears the OS's recent documents (jump list, Dock, Open Recent) */
  clearRecentDocuments?(): Promise<void>;
  /** Self-updating install (Windows installer): auto is false otherwise.
   *  Only checks: nothing downloads until downloadUpdate */
  checkUpdate?(): Promise<{
    auto: boolean;
    available?: boolean;
    /** Downloaded already (the restart notice is shown again) */
    ready?: boolean;
    /** Being downloaded (the user chose Update) */
    downloading?: boolean;
    version?: string | null;
    error?: string;
    /** When auto is false: what to download (see updates.ts) */
    platform?: string;
    arch?: string;
    portable?: boolean;
  }>;
  /** The user chose Update: download it (self-updating builds) */
  downloadUpdate?(): Promise<{ ok: boolean; error?: string }>;
  /** Download progress of an update the user chose */
  onUpdateProgress?(
    callback: (info: { percent: number | null }) => void
  ): () => void;
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
  /** Printers to print to, and the one to preselect (the last one used,
   *  else the system default) */
  printers?(): Promise<{ printers: Printer[]; selected: string | null }>;
  /** Print a document (one at a time), or save it as a PDF file */
  printPages?(data: Uint8Array, request: PrintRequest): Promise<PrintResult>;
  /** A complete HTML document, styled for print, made into a PDF by the
   *  print engine (scripts don't run) */
  htmlToPdf?(html: string): Promise<{
    ok: boolean;
    data?: Uint8Array;
    error?: string;
    message?: string;
  }>;
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
