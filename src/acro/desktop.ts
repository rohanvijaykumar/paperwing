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
      /** The paper the sheets were laid out for, in points (portrait) */
      paper?: { width: number; height: number };
      /** Every sheet is landscape */
      landscape?: boolean;
    }
  | { destination: 'pdf'; name: string };

export interface PrintResult {
  ok: boolean;
  /** Save as PDF: the user closed the save dialog */
  cancelled?: boolean;
  error?: 'busy' | 'no-printers' | 'printer-missing' | 'invalid' | 'failed';
  message?: string;
}

/** A certificate the certificate helper found (Windows store, smart card,
 *  Keychain); see desktop/certs.cjs */
export interface InstalledCert {
  id: string;
  source: 'windows-store' | 'smart-card' | 'keychain' | 'token';
  provider: string;
  /** base64 DER */
  certDer: string;
  chainDer: string[];
  hasPrivateKey: boolean;
  keyAlg: 'rsa' | 'ec' | null;
  keyBits: number;
  curve: 'P-256' | 'P-384' | 'P-521' | null;
}

export type CertError =
  | 'cancelled'
  | 'wrong-pin'
  | 'pin-blocked'
  | 'card-removed'
  | 'key-unusable'
  | 'failed'
  | 'timeout'
  | 'no-helper';

export interface CertsBridge {
  list(): Promise<{ ok: boolean; error?: CertError; certs: InstalledCert[] }>;
  /** Signs a digest (base64) with the certificate's key */
  sign(
    id: string,
    hash: string,
    alg: 'sha256' | 'sha384'
  ): Promise<{ ok: boolean; sig?: string; error?: CertError }>;
  /** The system's trusted root certificates (base64 DER) */
  roots(): Promise<{ ok: boolean; certs: string[] }>;
  /** A request to a timestamp or certificate server */
  fetch(
    url: string,
    init: { method: 'GET' | 'POST'; contentType?: string; body?: Uint8Array }
  ): Promise<{
    status: number;
    contentType?: string;
    body?: Uint8Array;
    error?: string;
  }>;
  /** Save a new Digital ID file (.pfx) where the user chooses */
  saveId?(name: string, data: Uint8Array): Promise<boolean>;
}

/** How a scanner is reached (desktop/scan.cjs) */
export type ScanDriver = 'twain' | 'wia' | 'escl' | 'twain32' | 'wia1' | 'ica';

/** One way to reach a scanner (Options ▸ Driver) */
export interface ScanDevice {
  /** "<driver>:<the helper's id>" */
  id: string;
  driver: ScanDriver;
  label: string;
  name: string;
}

/** One physical scanner, however many drivers reach it (best first) */
export interface Scanner {
  key: string;
  name: string;
  make: string;
  model: string;
  connection: 'usb' | 'network' | 'unknown';
  devices: ScanDevice[];
}

export interface ScanRange {
  min: number;
  max: number;
  step: number;
  default: number;
}

/** What a scanner's flatbed or document feeder can do (sizes in inches) */
export interface ScanSource {
  id: 'flatbed' | 'feeder';
  /** Both sides in one pass (a feeder) */
  duplex: boolean;
  resolutions: number[];
  /** Set when any resolution in a range works (a custom value) */
  resolutionRange: ScanRange | null;
  colors: ('color' | 'gray' | 'bw')[];
  maxWidth: number;
  maxHeight: number;
  minWidth: number;
  minHeight: number;
  canPreview: boolean;
  paperSizes: { name: string; width: number; height: number }[];
  autoSize: boolean;
  autoDeskew: boolean;
  autoCrop: boolean;
  blankPageSkip: boolean;
  doubleFeed: boolean;
  invert: boolean;
  brightness: ScanRange | null;
  contrast: ScanRange | null;
  threshold: ScanRange | null;
  /** The scanner's own sharpening (network scanners) */
  sharpen: ScanRange | null;
  feederLoaded: boolean | null;
}

export interface ScanCaps {
  driver: ScanDriver;
  /** It has a window of its own (TWAIN, WIA) */
  nativeUi: boolean;
  sources: ScanSource[];
}

/** What the scanner is asked for (the contract's scan options; absent:
 *  the scanner's default) */
export interface ScanRequest {
  source: 'flatbed' | 'feeder';
  duplex: boolean;
  color: 'color' | 'gray' | 'bw';
  dpi: number;
  area?: { x: number; y: number; width: number; height: number };
  paper?: { width: number; height: number } | 'auto';
  brightness?: number;
  contrast?: number;
  threshold?: number;
  sharpen?: number;
  autoDeskew?: boolean;
  blankPageSkip?: boolean;
  doubleFeedStop?: boolean;
  invert?: boolean;
  nativeUi?: boolean;
  transfer?: 'native' | 'memory';
  /** Seconds a slow network scanner gets */
  timeout?: number;
}

export type ScanError =
  | 'no-scanner'
  | 'offline'
  | 'busy'
  | 'paper-jam'
  | 'feeder-empty'
  | 'double-feed'
  | 'cover-open'
  | 'unsupported'
  | 'blocked'
  | 'invalid'
  | 'failed';

export interface ScanResult {
  ok: boolean;
  pages?: number;
  /** Stopped by Cancel (the pages before it came) */
  cancelled?: boolean;
  error?: ScanError;
  message?: string;
}

/** A page as the scanner sent it */
export interface ScanPageInfo {
  index: number;
  dpi: number;
  /** Pixels */
  width?: number;
  height?: number;
  side: 'front' | 'back';
  mime: string;
}

/** A file a scanner's own app saved in the watched folder */
export interface ScanImport {
  name: string;
  path: string;
  data: Uint8Array;
  mime: string;
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
  /** Save As, starting in the folder of `near` (the document's own file)
   *  or else the last folder used */
  saveAs(
    name: string,
    data: Uint8Array,
    near?: string
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
  /** Certificates installed on this computer (Windows and macOS) */
  certs?: CertsBridge;
  /** The scanners connected or on the network, one entry each */
  scanners?(): Promise<{
    ok: boolean;
    scanners: Scanner[];
    error?: ScanError;
    message?: string;
  }>;
  /** A network scanner that doesn't announce itself, by its address */
  addScanner?(address: string): Promise<{
    ok: boolean;
    scanner?: Scanner;
    error?: ScanError;
    message?: string;
  }>;
  /** What one device (ScanDevice.id) can do */
  scannerCaps?(id: string): Promise<{
    ok: boolean;
    caps?: ScanCaps;
    error?: ScanError;
    message?: string;
  }>;
  /** A quick low-resolution scan of the whole glass */
  scanPreview?(
    id: string,
    request: ScanRequest
  ): Promise<ScanResult & { page?: ScanPageInfo & { data: Uint8Array } }>;
  /** Scans; each page arrives through onScanPage as it's scanned */
  scan?(id: string, request: ScanRequest): Promise<ScanResult>;
  /** Stops the scan after the page being scanned, and lets the scanner go */
  cancelScan?(): Promise<boolean>;
  onScanPage?(
    callback: (data: Uint8Array, info: ScanPageInfo) => void
  ): () => void;
  onScanStatus?(callback: (message: string) => void): () => void;
  /** Watches a chosen folder for scans a scanner's own app saves (null
   *  stops) */
  watchScanFolder?(
    dir: string | null
  ): Promise<{ ok: boolean; error?: string; message?: string }>;
  onScanImport?(callback: (file: ScanImport) => void): () => void;
  /** Asks for a folder; new files may then be saved into it */
  chooseFolder?(title?: string): Promise<{ path: string; name: string } | null>;
  /** Saves new PDFs into a chosen folder (never over a file) */
  saveFiles?(
    dir: string,
    files: { name: string; data: Uint8Array }[]
  ): Promise<{ path: string; name: string }[] | null>;
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
