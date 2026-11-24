import React from 'react';

interface NoticeBarProps {
  error: string | null;
  status: string | null;
  onDismissError: () => void;
  onDismissStatus: () => void;
  /** Shown while a batch export runs, in place of Dismiss. */
  onCancel?: () => void;
}

/** Errors are announced as alerts; progress and confirmations as polite status. */
export const NoticeBar: React.FC<NoticeBarProps> = ({
  error,
  status,
  onDismissError,
  onDismissStatus,
  onCancel,
}) => (
  <>
    {error && (
      <div
        role="alert"
        className="flex items-start sm:items-center justify-between gap-3 border-b border-error bg-paper px-5 py-2 text-xs text-error shrink-0"
      >
        <span
          role="region"
          aria-label="Error details"
          tabIndex={0}
          className="min-w-0 flex-1 max-h-[25vh] overflow-y-auto break-words"
        >
          {error}
        </span>
        <button
          type="button"
          onClick={onDismissError}
          className="font-medium underline underline-offset-2 hover:text-ink shrink-0"
        >
          Dismiss
        </button>
      </div>
    )}
    {status && (
      <div
        role="status"
        aria-live="polite"
        className="flex items-start sm:items-center justify-between gap-3 border-b border-rule bg-paper-2 px-5 py-2 text-xs text-ink shrink-0"
      >
        <span className="min-w-0 flex-1 break-words">{status}</span>
        <button
          type="button"
          onClick={onCancel ?? onDismissStatus}
          className="font-medium text-muted underline underline-offset-2 hover:text-ink shrink-0"
        >
          {onCancel ? 'Cancel' : 'Dismiss'}
        </button>
      </div>
    )}
  </>
);
