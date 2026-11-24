import React, { useEffect, useRef } from 'react';

interface ShortcutsDialogProps {
  open: boolean;
  onClose: () => void;
}

const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = IS_MAC ? '⌘' : 'Ctrl';

const SHORTCUT_GROUPS: { title: string; rows: { keys: string[]; label: string }[] }[] = [
  {
    title: 'Inspect',
    rows: [
      { keys: ['B'], label: 'Toggle before and after split' },
      { keys: ['\\'], label: 'Hold to peek at the original' },
      { keys: ['G'], label: 'Toggle horizon grid' },
      { keys: ['+', '−'], label: 'Zoom in and out' },
      { keys: ['0'], label: 'Fit to view' },
    ],
  },
  {
    title: 'Edit',
    rows: [
      { keys: [MOD, 'Z'], label: 'Undo' },
      { keys: [MOD, '⇧', 'Z'], label: 'Redo' },
      { keys: ['R'], label: 'Reset this photo' },
      { keys: ['Esc'], label: 'Leave the straighten tool' },
    ],
  },
  {
    title: 'Queue',
    rows: [
      { keys: ['['], label: 'Previous photo' },
      { keys: [']'], label: 'Next photo' },
      { keys: [MOD, 'V'], label: 'Paste an image from the clipboard' },
      { keys: ['?'], label: 'Show this list' },
    ],
  },
];

export const ShortcutsDialog: React.FC<ShortcutsDialogProps> = ({ open, onClose }) => {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="shortcuts-title"
      className="atelier-dialog atelier-stock"
      onClose={onClose}
      onClick={(e) => {
        // Click on the backdrop (outside the inner panel) closes the dialog
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="p-6">
        <div className="flex items-baseline justify-between gap-4">
          <h2 id="shortcuts-title" className="font-display text-xl text-ink">
            Keyboard shortcuts
          </h2>
          <button type="button" onClick={onClose} className="btn btn--quiet btn--sm">
            Close
          </button>
        </div>

        <div className="mt-5 grid gap-6 sm:grid-cols-3">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.title} className="min-w-0">
              <h3 className="text-sm text-muted font-body font-medium">{group.title}</h3>
              <dl className="mt-2 divide-y divide-rule border-y border-rule">
                {group.rows.map((row) => (
                  <div key={row.label} className="flex items-center justify-between gap-3 py-2">
                    <dt className="text-sm text-ink min-w-0">{row.label}</dt>
                    <dd className="flex shrink-0 gap-1">
                      {row.keys.map((k) => (
                        <kbd key={k} className="kbd">
                          {k}
                        </kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </dialog>
  );
};
