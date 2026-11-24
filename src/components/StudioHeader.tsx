import React from 'react';
import { ImagePlus, Keyboard, Redo2, Undo2 } from 'lucide-react';

interface StudioHeaderProps {
  /** Inert until the saved session is restored. */
  inert?: boolean;
  title: string;
  /** Null while the active photo is still being analysed. */
  sourceSize: { width: number; height: number } | null;
  onHome: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onShowShortcuts: () => void;
  onImport: () => void;
}

/** One row at every width: wordmark, the active photo (desktop), history and import. */
export const StudioHeader: React.FC<StudioHeaderProps> = ({
  inert,
  title,
  sourceSize,
  onHome,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onShowShortcuts,
  onImport,
}) => (
  <header inert={inert} className="flex items-center justify-between gap-3 sm:gap-6 border-b border-rule bg-paper-2 px-3 sm:px-6 py-2 sm:py-3 shrink-0">
    <h1 className="font-display text-lg sm:text-xl font-normal tracking-tight text-ink leading-none shrink-0">
      <a
        href="#workspace"
        onClick={(e) => {
          e.preventDefault();
          onHome();
        }}
        className="whitespace-nowrap no-underline hover:text-accent transition-colors"
      >
        Plumb_Line
      </a>
    </h1>

    <div className="hidden lg:flex items-center gap-3 text-xs text-muted min-w-0">
      <span className="font-medium text-ink truncate max-w-xs">{title}</span>
      <span className="border-l border-rule pl-3 font-mono tabular-nums whitespace-nowrap">
        {sourceSize ? `${sourceSize.width} × ${sourceSize.height} px` : 'Analysing…'}
      </span>
    </div>

    <div className="flex items-center gap-2 shrink-0">
      <div className="flex items-center rounded-pill border border-rule bg-paper p-0.5" role="group" aria-label="History">
        <button type="button" onClick={onUndo} disabled={!canUndo} aria-label="Undo" title="Undo" className="icon-btn">
          <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <button type="button" onClick={onRedo} disabled={!canRedo} aria-label="Redo" title="Redo" className="icon-btn">
          <Redo2 className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      {/* Wrapper carries the breakpoint: unlayered .btn display would beat a layered `hidden` utility */}
      <span className="hidden md:contents">
        <button
          type="button"
          onClick={onShowShortcuts}
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts (?)"
          className="icon-btn border border-rule bg-paper"
        >
          <Keyboard className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </span>
      <button type="button" onClick={onImport} className="btn btn--quiet btn--sm shrink-0">
        <ImagePlus className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="hidden sm:inline">Import photos</span>
        <span className="sm:hidden">Import</span>
      </button>
    </div>
  </header>
);
