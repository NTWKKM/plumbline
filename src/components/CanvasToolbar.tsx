import React from 'react';
import { Grid, ZoomIn, ZoomOut } from 'lucide-react';
import { CanvasViewMode } from './StudioCanvas';

const VIEW_MODE_OPTIONS: { value: CanvasViewMode; label: string; short: string }[] = [
  { value: 'framed', label: 'Framed', short: 'Framed' },
  { value: 'split', label: 'Before and after', short: 'Split' },
  { value: 'geometry', label: 'Crop box', short: 'Crop' },
  { value: 'original', label: 'Original', short: 'Original' },
];

interface CanvasToolbarProps {
  viewMode: CanvasViewMode;
  onViewModeChange: (mode: CanvasViewMode) => void;
  splitPercent: number;
  onSplitPercentChange: (pct: number) => void;
  zoomLevel: number;
  onZoomChange: (zoom: number) => void;
  showHorizonGrid: boolean;
  onToggleGrid: () => void;
}

export const CanvasToolbar: React.FC<CanvasToolbarProps> = ({
  viewMode,
  onViewModeChange,
  splitPercent,
  onSplitPercentChange,
  zoomLevel,
  onZoomChange,
  showHorizonGrid,
  onToggleGrid,
}) => (
  <div className="flex items-center justify-between gap-2 border-b border-rule bg-paper px-3 sm:px-4 py-2 min-w-0">
    <div
      className="flex max-w-full overflow-x-auto items-center gap-0.5 rounded-pill bg-paper-2 p-0.5 border border-rule"
      role="group"
      aria-label="Canvas view mode"
    >
      {VIEW_MODE_OPTIONS.map((opt) => {
        const active = viewMode === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onViewModeChange(opt.value)}
            className={`min-h-[32px] rounded-pill px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
              active ? 'bg-ink text-paper' : 'text-muted hover:text-ink'
            }`}
          >
            <span className="hidden xl:inline">{opt.label}</span>
            <span className="xl:hidden">{opt.short}</span>
          </button>
        );
      })}
    </div>

    <div className="flex items-center gap-2 shrink-0">
      {viewMode === 'split' && (
        // Shown at every width so the divider stays keyboard-operable on phones too
        <div className="flex items-center gap-2 rounded-pill border border-rule bg-paper-2 px-2 sm:px-2.5 py-1 shrink-0">
          <label htmlFor="slider-split-position" className="hidden sm:inline text-xs text-ink-2 whitespace-nowrap shrink-0">
            Split
          </label>
          <input
            id="slider-split-position"
            type="range"
            min={5}
            max={95}
            step={1}
            value={splitPercent}
            aria-label="Split position"
            aria-valuetext={`${Math.round(splitPercent)} percent`}
            onChange={(e) => onSplitPercentChange(parseFloat(e.target.value))}
            className="h-1.5 w-14 sm:w-20 cursor-pointer rounded-pill bg-paper-3 accent-accent"
          />
        </div>
      )}

      {/* Zoom needs a pointer to pan with; on phones the canvas already fills the screen */}
      <div
        className="hidden sm:flex items-center rounded-pill border border-rule bg-paper-2 p-0.5 shrink-0"
        role="group"
        aria-label="Canvas zoom"
      >
        <button
          type="button"
          aria-label="Zoom out"
          onClick={() => onZoomChange(zoomLevel - 0.25)}
          disabled={zoomLevel <= 1}
          className="icon-btn"
        >
          <ZoomOut className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => onZoomChange(1)}
          aria-label={`Zoom ${Math.round(zoomLevel * 100)}%, reset to fit`}
          title="Reset zoom"
          className="min-h-[28px] px-2 font-mono text-xs text-ink tabular-nums hover:text-accent whitespace-nowrap"
        >
          {Math.round(zoomLevel * 100)}%
        </button>
        <button
          type="button"
          aria-label="Zoom in"
          onClick={() => onZoomChange(zoomLevel + 0.25)}
          disabled={zoomLevel >= 4}
          className="icon-btn"
        >
          <ZoomIn className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>

      <button
        type="button"
        aria-pressed={showHorizonGrid}
        aria-label="Horizon grid"
        title="Horizon grid (G)"
        onClick={onToggleGrid}
        className={`flex min-h-[32px] items-center gap-1.5 rounded-pill border px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
          showHorizonGrid ? 'border-accent bg-accent text-accent-ink' : 'border-rule bg-paper-2 text-ink hover:border-ink-2'
        }`}
      >
        <Grid className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="hidden xl:inline">Grid</span>
      </button>
    </div>
  </div>
);
