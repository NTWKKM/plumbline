/**
 * Bounded undo/redo history for studio edit state.
 *
 * Pure and immutable so it can be unit-tested without React. Consecutive
 * pushes inside `coalesceMs` with the same `key` are merged into one entry,
 * so dragging a slider produces a single undo step instead of hundreds.
 */

export interface HistoryState<T> {
  past: T[];
  present: T;
  future: T[];
  lastKey: string | null;
  lastAt: number;
}

export const DEFAULT_HISTORY_LIMIT = 100;
export const DEFAULT_COALESCE_MS = 600;

export function createHistory<T>(initial: T): HistoryState<T> {
  return { past: [], present: initial, future: [], lastKey: null, lastAt: 0 };
}

export interface PushOptions {
  /** Edits sharing a key within `coalesceMs` collapse into one undo step. */
  key?: string;
  now?: number;
  coalesceMs?: number;
  limit?: number;
}

export function pushHistory<T>(
  state: HistoryState<T>,
  next: T,
  options: PushOptions = {}
): HistoryState<T> {
  if (Object.is(next, state.present)) return state;

  const now = options.now ?? Date.now();
  const coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;
  const limit = Math.max(1, options.limit ?? DEFAULT_HISTORY_LIMIT);
  const key = options.key ?? null;

  const canCoalesce =
    key !== null &&
    key === state.lastKey &&
    now - state.lastAt <= coalesceMs &&
    state.past.length > 0;

  const past = canCoalesce ? state.past : [...state.past, state.present];
  const trimmed = past.length > limit ? past.slice(past.length - limit) : past;

  return { past: trimmed, present: next, future: [], lastKey: key, lastAt: now };
}

export function undoHistory<T>(state: HistoryState<T>): HistoryState<T> {
  if (state.past.length === 0) return state;
  const previous = state.past[state.past.length - 1];
  return {
    past: state.past.slice(0, -1),
    present: previous,
    future: [state.present, ...state.future],
    lastKey: null,
    lastAt: 0,
  };
}

export function redoHistory<T>(state: HistoryState<T>): HistoryState<T> {
  if (state.future.length === 0) return state;
  const [next, ...rest] = state.future;
  return {
    past: [...state.past, state.present],
    present: next,
    future: rest,
    lastKey: null,
    lastAt: 0,
  };
}

export function canUndo<T>(state: HistoryState<T>): boolean {
  return state.past.length > 0;
}

export function canRedo<T>(state: HistoryState<T>): boolean {
  return state.future.length > 0;
}
