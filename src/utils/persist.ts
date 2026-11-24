/**
 * Keeps the studio across reloads: imported photos (their decodable blob and metadata)
 * and the session (edits, output, queue order, presets) live in IndexedDB.
 * Every call fails soft: private browsing or a full disk loses persistence, never the session.
 */
import { ExifData } from './geometry';
import { EditSession, Preset, sanitizeOutput, sanitizePhotoEdit, sanitizePresets } from './edits';

const DB_NAME = 'plumbline';
const DB_VERSION = 1;
const PHOTOS = 'photos';
const META = 'meta';
const SESSION_KEY = 'session';

export interface StoredPhoto {
  id: string;
  title: string;
  fileName: string;
  isRaw: boolean;
  exif: ExifData;
  rawApp1Segment: Uint8Array | null;
  blob: Blob;
}

export interface StoredSession extends EditSession {
  order: string[];
  selectedId: string;
  presets: Preset[];
  viewMode?: string;
  showHorizonGrid?: boolean;
  gridStyle?: string;
  gridOrientation?: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  const pending: Promise<IDBDatabase | null> = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(PHOTOS)) db.createObjectStore(PHOTOS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      };
      req.onsuccess = () => {
        const db = req.result;
        // A closed connection (browser eviction, another tab upgrading) is reopened on next use
        const forget = () => {
          if (dbPromise === pending) dbPromise = null;
        };
        db.onclose = forget;
        db.onversionchange = () => {
          db.close();
          forget();
        };
        resolve(db);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  dbPromise = pending;
  return pending;
}

/** `ok` is false when storage is unavailable or the transaction failed, never for an empty read. */
type TxResult<T> = { ok: true; value: T | undefined } | { ok: false };

async function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T> | void
): Promise<TxResult<T>> {
  const db = await openDb();
  if (!db) return { ok: false };
  return new Promise((resolve) => {
    try {
      const t = db.transaction(store, mode);
      const req = run(t.objectStore(store));
      t.oncomplete = () => resolve({ ok: true, value: req ? req.result : undefined });
      t.onerror = () => resolve({ ok: false });
      t.onabort = () => resolve({ ok: false });
    } catch {
      resolve({ ok: false });
    }
  });
}

/** Each write resolves to whether its transaction committed. */
export const savePhoto = async (photo: StoredPhoto) => (await tx(PHOTOS, 'readwrite', (s) => s.put(photo))).ok;

export const deletePhoto = async (id: string) => (await tx(PHOTOS, 'readwrite', (s) => s.delete(id))).ok;

/** Stored photos, or null when the read failed (as opposed to an empty store). */
export async function loadPhotos(): Promise<StoredPhoto[] | null> {
  const res = await tx<StoredPhoto[]>(PHOTOS, 'readonly', (s) => s.getAll());
  if (!res.ok) return null;
  return (res.value ?? []).filter((p) => p && typeof p.id === 'string' && p.blob instanceof Blob);
}

export const saveSession = async (session: StoredSession) =>
  (await tx(META, 'readwrite', (s) => s.put(session, SESSION_KEY))).ok;

/** `ok: false` means the read failed; `session: null` with `ok: true` means nothing was saved yet. */
export async function loadSession(): Promise<{ ok: boolean; session: StoredSession | null }> {
  const res = await tx<unknown>(META, 'readonly', (s) => s.get(SESSION_KEY));
  if (!res.ok) return { ok: false, session: null };
  return { ok: true, session: parseStoredSession(res.value) };
}

/** Validates a stored session; anything malformed falls back to defaults field by field. */
export function parseStoredSession(raw: unknown): StoredSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const edits: EditSession['edits'] = {};
  if (o.edits && typeof o.edits === 'object') {
    for (const [id, edit] of Object.entries(o.edits as Record<string, unknown>)) {
      edits[id] = sanitizePhotoEdit(edit);
    }
  }
  const order = Array.isArray(o.order) ? o.order.filter((x): x is string => typeof x === 'string') : [];
  return {
    edits,
    output: sanitizeOutput(o.output),
    order,
    selectedId: typeof o.selectedId === 'string' ? o.selectedId : order[0] ?? '',
    presets: sanitizePresets(o.presets),
    viewMode: typeof o.viewMode === 'string' ? o.viewMode : undefined,
    showHorizonGrid: typeof o.showHorizonGrid === 'boolean' ? o.showHorizonGrid : undefined,
    gridStyle: typeof o.gridStyle === 'string' ? o.gridStyle : undefined,
    gridOrientation:
      typeof o.gridOrientation === 'number' && Number.isInteger(o.gridOrientation) ? o.gridOrientation : undefined,
  };
}
