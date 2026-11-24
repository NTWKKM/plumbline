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
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(PHOTOS)) db.createObjectStore(PHOTOS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T> | void
): Promise<T | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const t = db.transaction(store, mode);
      const req = run(t.objectStore(store));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => resolve(undefined);
      t.onabort = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

export const savePhoto = (photo: StoredPhoto) => tx(PHOTOS, 'readwrite', (s) => s.put(photo));

export const deletePhoto = (id: string) => tx(PHOTOS, 'readwrite', (s) => s.delete(id));

export async function loadPhotos(): Promise<StoredPhoto[]> {
  const all = await tx<StoredPhoto[]>(PHOTOS, 'readonly', (s) => s.getAll());
  return (all ?? []).filter((p) => p && typeof p.id === 'string' && p.blob instanceof Blob);
}

export const saveSession = (session: StoredSession) =>
  tx(META, 'readwrite', (s) => s.put(session, SESSION_KEY));

export async function loadSession(): Promise<StoredSession | null> {
  const raw = await tx<unknown>(META, 'readonly', (s) => s.get(SESSION_KEY));
  return parseStoredSession(raw);
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
  };
}
