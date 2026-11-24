import { useCallback, useEffect, useRef, useState } from 'react';
import {
  HistoryState,
  canRedo,
  canUndo,
  createHistory,
  pushHistory,
  redoHistory,
  undoHistory,
} from '../utils/history';

/**
 * Undo history for any snapshot type. While a slider is being dragged, edits merge by gesture
 * (pauses stay one step, a new drag starts a new step); keyboard nudges use the timed merge.
 */
export function useEditHistory<T>(initial: () => T) {
  const [history, setHistory] = useState<HistoryState<T>>(() => createHistory(initial()));
  const gestureRef = useRef({ id: 0, active: false });

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (t instanceof HTMLInputElement && t.type === 'range') {
        gestureRef.current = { id: gestureRef.current.id + 1, active: true };
      }
    };
    const onEnd = () => {
      if (gestureRef.current.active) gestureRef.current = { ...gestureRef.current, active: false };
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', onEnd, true);
    window.addEventListener('pointercancel', onEnd, true);
    window.addEventListener('blur', onEnd);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', onEnd, true);
      window.removeEventListener('pointercancel', onEnd, true);
      window.removeEventListener('blur', onEnd);
    };
  }, []);

  /** Applies an edit; `key` names what changed so repeated edits of one thing merge. */
  const commit = useCallback((update: (present: T) => T, key?: string) => {
    setHistory((h) => {
      const next = update(h.present);
      if (next === h.present) return h;
      const g = gestureRef.current;
      const options = key
        ? g.active
          ? { key: `${key}:gesture-${g.id}`, coalesceMs: Number.POSITIVE_INFINITY }
          : { key }
        : undefined;
      return pushHistory(h, next, options);
    });
  }, []);

  /** Replaces the timeline, for restoring a saved session. */
  const reset = useCallback((present: T) => setHistory(createHistory(present)), []);
  const undo = useCallback(() => setHistory((h) => undoHistory(h)), []);
  const redo = useCallback(() => setHistory((h) => redoHistory(h)), []);

  return {
    present: history.present,
    commit,
    reset,
    undo,
    redo,
    canUndo: canUndo(history),
    canRedo: canRedo(history),
  };
}
