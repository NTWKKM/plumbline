import { useEffect, useRef, useState } from 'react';
import { EditSession, migrateLegacyConfig } from '../utils/edits';
import { StoredSession, loadPhotos, loadSession, saveSession } from '../utils/persist';
import { INITIAL_SAMPLE_PHOTOS, StudioPhotoItem } from '../utils/samplePhotos';

const LEGACY_CONFIG_KEY = 'plumbline.pipelineConfig.v1';
const LEGACY_VIEW_KEY = 'plumbline.viewState.v1';
const SAVE_DELAY_MS = 400;
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 30000;

export interface RestoredStudio {
  /** Imported photos found in storage, with fresh object URLs. */
  imported: StudioPhotoItem[];
  session: StoredSession | null;
}

/** Older builds kept one global config and sample tilts in localStorage; fold them in once. */
function readLegacySession(): Partial<StoredSession> | null {
  try {
    const rawConfig = localStorage.getItem(LEGACY_CONFIG_KEY);
    const rawView = localStorage.getItem(LEGACY_VIEW_KEY);
    if (!rawConfig && !rawView) return null;
    const { output, edit } = migrateLegacyConfig(rawConfig ? JSON.parse(rawConfig) : {});
    const view = rawView ? (JSON.parse(rawView) as Record<string, unknown>) : {};
    const edits: EditSession['edits'] = {};
    const tilts = (view.tiltOverrides ?? {}) as Record<string, unknown>;
    // Every sample gets the migrated corrections; its tilt is the saved one, else its own baseline
    for (const sample of INITIAL_SAMPLE_PHOTOS) {
      const t = tilts[sample.id];
      edits[sample.id] = {
        ...edit,
        tiltDeg: typeof t === 'number' && Number.isFinite(t) ? t : sample.simulatedSensorTiltDeg,
      };
    }
    return {
      output,
      edits,
      viewMode: typeof view.viewMode === 'string' ? view.viewMode : undefined,
      showHorizonGrid: typeof view.showHorizonGrid === 'boolean' ? view.showHorizonGrid : undefined,
    };
  } catch {
    return null;
  }
}

export interface PersistenceState {
  /** The restore has run; the studio may take edits. */
  hydrated: boolean;
  /** Saving is on: false after a failed restore read, so a partial restore never overwrites saved work. */
  canSave: boolean;
}

export interface PersistenceStatus extends PersistenceState {
  /** The last save did not commit; it is being retried with the latest snapshot. */
  saveFailed: boolean;
}

/**
 * Restores the studio once on mount, then saves the session shortly after each change.
 * Nothing is saved before the restore finishes, so a slow disk never overwrites saved work,
 * and nothing is saved after a failed read until a later visit restores in full.
 */
export function usePersistence(
  snapshot: StoredSession,
  onRestore: (
    restored: RestoredStudio & { legacy: Partial<StoredSession> | null; readFailed: boolean }
  ) => void
): PersistenceStatus {
  const [state, setState] = useState<PersistenceState>({ hydrated: false, canSave: false });
  // Consecutive failed saves; each one re-runs the save effect after a growing delay
  const [failures, setFailures] = useState(0);
  const onRestoreRef = useRef(onRestore);
  onRestoreRef.current = onRestore;

  useEffect(() => {
    let cancelled = false;
    void Promise.all([loadPhotos(), loadSession()]).then(([stored, loaded]) => {
      if (cancelled) return;
      const readFailed = stored === null || !loaded.ok;
      const imported: StudioPhotoItem[] = (stored ?? []).map((p) => ({
        id: p.id,
        title: p.title,
        fileName: p.fileName,
        src: URL.createObjectURL(p.blob),
        isRaw: p.isRaw,
        simulatedSensorTiltDeg: 0,
        exif: p.exif,
        rawApp1Segment: p.rawApp1Segment,
      }));
      const session = loaded.session;
      onRestoreRef.current({
        imported,
        session,
        legacy: session || readFailed ? null : readLegacySession(),
        readFailed,
      });
      setState({ hydrated: true, canSave: !readFailed });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!state.canSave) return;
    let superseded = false;
    const delay = failures === 0 ? SAVE_DELAY_MS : Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (failures - 1));
    const timer = setTimeout(() => {
      void saveSession(snapshot).then((committed) => {
        // A newer snapshot is already queued; its own save reports the outcome
        if (superseded) return;
        if (!committed) {
          // Retried even if nothing else changes; the legacy keys stay until a save lands
          setFailures((n) => n + 1);
          return;
        }
        setFailures(0);
        try {
          localStorage.removeItem(LEGACY_CONFIG_KEY);
          localStorage.removeItem(LEGACY_VIEW_KEY);
        } catch {
          // Storage may be unavailable; the legacy keys are harmless
        }
      });
    }, delay);
    return () => {
      superseded = true;
      clearTimeout(timer);
    };
  }, [state.canSave, snapshot, failures]);

  return { ...state, saveFailed: failures > 0 };
}
