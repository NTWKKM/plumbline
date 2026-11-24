import { useEffect, useRef, useState } from 'react';
import { EditSession, migrateLegacyConfig } from '../utils/edits';
import { StoredSession, loadPhotos, loadSession, saveSession } from '../utils/persist';
import { StudioPhotoItem } from '../utils/samplePhotos';

const LEGACY_CONFIG_KEY = 'plumbline.pipelineConfig.v1';
const LEGACY_VIEW_KEY = 'plumbline.viewState.v1';
const SAVE_DELAY_MS = 400;

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
    for (const [id, t] of Object.entries(tilts)) {
      if (typeof t === 'number' && Number.isFinite(t)) edits[id] = { ...edit, tiltDeg: t };
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

/**
 * Restores the studio once on mount, then saves the session shortly after each change.
 * Nothing is saved before the restore finishes, so a slow disk never overwrites saved work.
 */
export function usePersistence(
  snapshot: StoredSession,
  onRestore: (restored: RestoredStudio & { legacy: Partial<StoredSession> | null }) => void
): boolean {
  const [hydrated, setHydrated] = useState(false);
  const onRestoreRef = useRef(onRestore);
  onRestoreRef.current = onRestore;

  useEffect(() => {
    let cancelled = false;
    void Promise.all([loadPhotos(), loadSession()]).then(([stored, session]) => {
      if (cancelled) return;
      const imported: StudioPhotoItem[] = stored.map((p) => ({
        id: p.id,
        title: p.title,
        fileName: p.fileName,
        src: URL.createObjectURL(p.blob),
        isRaw: p.isRaw,
        simulatedSensorTiltDeg: 0,
        exif: p.exif,
        rawApp1Segment: p.rawApp1Segment,
      }));
      onRestoreRef.current({ imported, session, legacy: session ? null : readLegacySession() });
      setHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const timer = setTimeout(() => {
      void saveSession(snapshot).then(() => {
        try {
          localStorage.removeItem(LEGACY_CONFIG_KEY);
          localStorage.removeItem(LEGACY_VIEW_KEY);
        } catch {
          // Storage may be unavailable; the legacy keys are harmless
        }
      });
    }, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [hydrated, snapshot]);

  return hydrated;
}
