import { desktop } from './desktop';

/**
 * Recent / starred files, kept in IndexedDB on this machine only.
 * Files opened through the File System Access API are remembered by handle
 * (reopened from disk); others keep a copy of their bytes if small enough.
 */

export interface RecentFile {
  id: string;
  name: string;
  size: number;
  openedAt: number;
  starred: boolean;
  handle?: FileSystemFileHandle;
  /** Path on disk (desktop app) */
  path?: string;
  data?: Blob;
  /** First-page preview for Home (see thumbnails.ts) and when it was made */
  thumb?: Blob;
  thumbAt?: number;
  /** Where the document was left: page and zoom (1 = 100%) */
  view?: { page: number; zoom: number };
}

const DB_NAME = 'bentopdf-desktop';
const STORE = 'recent';
const MAX_ENTRIES = 50;
const MAX_COPY_BYTES = 40 * 1024 * 1024;

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () =>
      req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const store = (await db()).transaction(STORE, mode).objectStore(STORE);
  return new Promise((resolve, reject) => {
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listRecent(): Promise<RecentFile[]> {
  try {
    const all = await tx<RecentFile[]>('readonly', (s) => s.getAll());
    return all.sort((a, b) => b.openedAt - a.openedAt);
  } catch {
    return [];
  }
}

/** Record that a file was opened; returns the entry id */
export async function rememberFile(
  file: File,
  source: { handle?: FileSystemFileHandle; path?: string } = {}
): Promise<string | undefined> {
  const { handle, path } = source;
  try {
    const all = await listRecent();
    let existing: RecentFile | undefined;
    for (const r of all) {
      if (path && r.path === path) {
        existing = r;
        break;
      }
      if (handle && r.handle && (await r.handle.isSameEntry(handle))) {
        existing = r;
        break;
      }
      if (
        !handle &&
        !path &&
        !r.handle &&
        !r.path &&
        r.name === file.name &&
        r.size === file.size
      ) {
        existing = r;
        break;
      }
    }
    const entry: RecentFile = {
      id: existing?.id ?? crypto.randomUUID(),
      name: file.name,
      size: file.size,
      openedAt: Date.now(),
      starred: existing?.starred ?? false,
      handle,
      path,
      data: !handle && !path && file.size <= MAX_COPY_BYTES ? file : undefined,
      thumb: existing?.thumb,
      thumbAt: existing?.thumbAt,
      view: existing?.view,
    };
    await tx('readwrite', (s) => s.put(entry));

    // Trim the oldest unstarred entries
    const extra = (await listRecent())
      .filter((r) => !r.starred)
      .slice(MAX_ENTRIES);
    for (const r of extra) await tx('readwrite', (s) => s.delete(r.id));
    return entry.id;
  } catch {
    return undefined;
  }
}

export async function updateRecent(
  id: string,
  patch: Partial<Omit<RecentFile, 'id'>>
): Promise<void> {
  try {
    const entry = await tx<RecentFile>('readonly', (s) => s.get(id));
    if (entry) await tx('readwrite', (s) => s.put({ ...entry, ...patch }));
  } catch {
    /* ignore */
  }
}

export async function forgetRecent(id: string): Promise<void> {
  try {
    await tx('readwrite', (s) => s.delete(id));
  } catch {
    /* ignore */
  }
}

/** Get the file back from disk (asks for permission) or from the stored copy */
export async function reopenRecent(entry: RecentFile): Promise<{
  file: File;
  handle?: FileSystemFileHandle;
  path?: string;
} | null> {
  if (entry.path && desktop) {
    const data = await desktop.readFile(entry.path);
    if (data) {
      return {
        file: new File([new Uint8Array(data)], entry.name, {
          type: 'application/pdf',
        }),
        path: entry.path,
      };
    }
  }
  if (entry.handle) {
    try {
      const h = entry.handle as FileSystemFileHandle & {
        queryPermission(o: object): Promise<PermissionState>;
        requestPermission(o: object): Promise<PermissionState>;
      };
      let perm = await h.queryPermission({ mode: 'read' });
      if (perm !== 'granted')
        perm = await h.requestPermission({ mode: 'read' });
      if (perm === 'granted') return { file: await h.getFile(), handle: h };
    } catch {
      /* file moved or deleted */
    }
  }
  if (entry.data) {
    return {
      file: new File([entry.data], entry.name, { type: 'application/pdf' }),
    };
  }
  return null;
}

/** Store a first-page preview for an entry */
export async function saveThumbnail(
  id: string,
  thumb: Blob,
  thumbAt = Date.now()
): Promise<void> {
  await updateRecent(id, { thumb, thumbAt });
}

/** Forget an entry's preview (the file has changed) */
export async function clearThumbnail(id: string): Promise<void> {
  await updateRecent(id, { thumb: undefined, thumbAt: undefined });
}

/** Forget every recent file except starred ones; returns how many went */
export async function clearRecent(): Promise<number> {
  const gone = (await listRecent()).filter((r) => !r.starred);
  for (const r of gone) await forgetRecent(r.id);
  return gone.length;
}
