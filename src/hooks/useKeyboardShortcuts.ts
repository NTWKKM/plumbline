import { useEffect, useRef } from 'react';

export interface ShortcutHandlers {
  undo: () => void;
  redo: () => void;
  showShortcuts: () => void;
  toggleGrid: () => void;
  toggleSplit: () => void;
  reset: () => void;
  zoomBy: (delta: number) => void;
  zoomReset: () => void;
  previousPhoto: () => void;
  nextPhoto: () => void;
  peek: (on: boolean) => void;
  escape: () => void;
}

const TEXT_INPUT_TYPES = ['text', 'search', 'email', 'url', 'number', 'password'];

function isTextEntry(t: HTMLElement | null): boolean {
  if (!t) return false;
  if (t.tagName === 'TEXTAREA' || t.isContentEditable) return true;
  return t.tagName === 'INPUT' && TEXT_INPUT_TYPES.includes((t as HTMLInputElement).type);
}

function isFormControl(t: HTMLElement | null): boolean {
  return !!t && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable);
}

/**
 * Global studio shortcuts. Handlers are read through a ref, so the listeners are bound once
 * and never go stale. `enabled` is false while a dialog owns the keyboard.
 */
export function useKeyboardShortcuts(handlers: ShortcutHandlers, enabled: boolean) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (!enabled) return;
    // Hold backslash to peek; the release is matched by `code`, since `key` can differ on keyup
    let peekCode: string | null = null;

    const onKeyDown = (e: KeyboardEvent) => {
      const h = ref.current;
      const target = e.target as HTMLElement | null;

      if ((e.metaKey || e.ctrlKey) && !e.altKey && !isTextEntry(target)) {
        const key = e.key.toLowerCase();
        if (key === 'z' && !e.shiftKey) {
          e.preventDefault();
          h.undo();
          return;
        }
        if ((key === 'z' && e.shiftKey) || key === 'y') {
          e.preventDefault();
          h.redo();
          return;
        }
      }
      if (e.key === 'Escape') {
        h.escape();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || isFormControl(target)) return;
      if (e.key === ' ' && target && ['BUTTON', 'SUMMARY', 'A'].includes(target.tagName)) return;

      if (e.key === '\\') {
        e.preventDefault();
        if (!e.repeat && peekCode === null) {
          peekCode = e.code;
          h.peek(true);
        }
        return;
      }

      const actions: Record<string, () => void> = {
        '?': h.showShortcuts,
        g: h.toggleGrid,
        b: h.toggleSplit,
        ' ': h.toggleSplit,
        r: h.reset,
        '=': () => h.zoomBy(0.25),
        '+': () => h.zoomBy(0.25),
        '-': () => h.zoomBy(-0.25),
        '0': h.zoomReset,
        '[': h.previousPhoto,
        ArrowUp: h.previousPhoto,
        ']': h.nextPhoto,
        ArrowDown: h.nextPhoto,
      };
      const action = actions[e.key.length === 1 ? e.key.toLowerCase() : e.key];
      if (action) {
        e.preventDefault();
        action();
      }
    };
    const endPeek = () => {
      if (peekCode !== null) {
        peekCode = null;
        ref.current.peek(false);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (peekCode !== null && e.code === peekCode) endPeek();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', endPeek);
    return () => {
      endPeek();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', endPeek);
    };
  }, [enabled]);
}
