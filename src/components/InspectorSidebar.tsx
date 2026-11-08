import React from 'react';
import { Download, RotateCcw } from 'lucide-react';
import {
  AspectRatioPreset,
  AutoCorrectAnalysis,
  CropRect,
  ExifData,
  FrameLayout,
  LevelingAnalysis,
  PipelineConfig,
  formatSignedDegrees,
} from '../utils/geometry';
import { BACKGROUND_COLOR_PRESETS } from '../utils/samplePhotos';

interface InspectorSidebarProps {
  config: PipelineConfig;
  onChangeConfig: (updater: (prev: PipelineConfig) => PipelineConfig) => void;
  analysis: LevelingAnalysis;
  autoCorrect?: AutoCorrectAnalysis;
  cropRect: CropRect;
  frameLayout: FrameLayout;
  sourceSize: { width: number; height: number };
  exif: ExifData;
  simulatedTiltDeg: number;
  onChangeSimulatedTilt: (deg: number) => void;
  onResetAll: () => void;
  onExportJpeg: () => void;
  isExporting: boolean;
  isImageLoaded?: boolean;
  className?: string;
}

const ASPECT_PRESETS: { value: AspectRatioPreset; label: string }[] = [
  { value: '1:1', label: '1:1' },
  { value: '4:5', label: '4:5' },
  { value: '16:9', label: '16:9' },
  { value: '3:2', label: '3:2' },
  { value: 'original', label: 'Original' },
];

export const InspectorSidebar: React.FC<InspectorSidebarProps> = ({
  config,
  onChangeConfig,
  analysis,
  autoCorrect,
  cropRect,
  frameLayout,
  sourceSize,
  exif,
  simulatedTiltDeg,
  onChangeSimulatedTilt,
  onResetAll,
  onExportJpeg,
  isExporting,
  isImageLoaded = true,
  className = '',
}) => {
  const totalRotationDeg = Number(
    (
      (config.autoLevelEnabled ? analysis.appliedRotationDeg : 0) +
      config.manualAngleOffsetDeg
    ).toFixed(2)
  );
  const autoCorrectEnabled = config.autoCorrectEnabled ?? true;
  const autoCorrectStrength = config.autoCorrectStrength ?? 75;

  return (
    <aside
      aria-label="Image Processing Inspector"
      className={`flex shrink-0 flex-col border-t lg:border-t-0 lg:border-l border-zinc-800/80 bg-[#0d0d10] text-zinc-100 select-none overflow-hidden ${
        className || 'w-full lg:w-[320px]'
      }`}
    >
      <div className="flex-1 overflow-y-auto min-h-0">
        {/* Section 1: Horizon & Geometry */}
        <section className="border-b border-zinc-800/70 px-4 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-display text-xs font-semibold tracking-tight text-zinc-200">
              Horizon & Geometry
            </h2>
            <button
              type="button"
              onClick={onResetAll}
              className="flex items-center gap-1 text-xs text-zinc-400 transition-colors hover:text-zinc-100 whitespace-nowrap shrink-0"
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </button>
          </div>

          {/* Auto-Level Toggle */}
          <div className="mt-2 flex items-center justify-between gap-3">
            <label
              htmlFor="toggle-auto-level"
              className="text-xs text-zinc-300 cursor-pointer min-w-0"
            >
              Auto-Level Horizon
            </label>
            <input
              id="toggle-auto-level"
              type="checkbox"
              checked={config.autoLevelEnabled}
              onChange={(e) =>
                onChangeConfig((prev) => ({ ...prev, autoLevelEnabled: e.target.checked }))
              }
              className="h-3.5 w-3.5 accent-zinc-200 rounded cursor-pointer shrink-0"
            />
          </div>

          {/* Clean Unboxed Telemetry Readout */}
          <div className="mt-2 grid grid-cols-3 gap-2 border-y border-zinc-800/60 py-1.5 text-xs">
            <div className="min-w-0">
              <div className="text-[11px] text-zinc-500">Tilt</div>
              <div
                className="mt-0.5 font-mono text-zinc-200 tabular-nums"
                data-testid="detected-tilt-val"
              >
                {formatSignedDegrees(analysis.detectedTiltDeg, 2)}
              </div>
            </div>
            <div className="min-w-0">
              <div className="text-[11px] text-zinc-500">Applied</div>
              <div
                className="mt-0.5 font-mono text-zinc-100 tabular-nums"
                data-testid="applied-rotation-val"
              >
                {formatSignedDegrees(totalRotationDeg, 2)}
              </div>
            </div>
            <div className="min-w-0">
              <div className="text-[11px] text-zinc-500">Confidence</div>
              <div className="mt-0.5 font-mono text-zinc-300 tabular-nums">
                {Math.round(analysis.confidence * 100)}%
              </div>
            </div>
          </div>

          {/* Simulated Camera Tilt Input */}
          <div className="mt-2">
            <div className="flex items-center justify-between gap-2 text-xs">
              <label htmlFor="slider-sensor-tilt" className="text-zinc-400">
                Sensor Tilt
              </label>
              <span className="font-mono text-zinc-200 tabular-nums shrink-0">
                {formatSignedDegrees(simulatedTiltDeg, 1)}
              </span>
            </div>
            <input
              id="slider-sensor-tilt"
              type="range"
              min={-12}
              max={12}
              step={0.2}
              value={simulatedTiltDeg}
              onChange={(e) => onChangeSimulatedTilt(parseFloat(e.target.value))}
              className="mt-1 h-1 w-full cursor-pointer appearance-none rounded-lg bg-zinc-800 accent-zinc-200"
            />
          </div>

          {/* Fine Manual Rotation Offset */}
          <div className="mt-2">
            <div className="flex items-center justify-between gap-2 text-xs">
              <label htmlFor="slider-manual-angle" className="text-zinc-400">
                Manual Angle
              </label>
              <span className="font-mono text-zinc-200 tabular-nums shrink-0">
                {formatSignedDegrees(config.manualAngleOffsetDeg, 2)}
              </span>
            </div>
            <input
              id="slider-manual-angle"
              type="range"
              min={-15}
              max={15}
              step={0.05}
              value={config.manualAngleOffsetDeg}
              onChange={(e) =>
                onChangeConfig((prev) => ({
                  ...prev,
                  manualAngleOffsetDeg: parseFloat(e.target.value),
                }))
              }
              className="mt-1 h-1 w-full cursor-pointer appearance-none rounded-lg bg-zinc-800 accent-zinc-200"
            />
          </div>

          {/* Inscribed Auto-Crop Controls */}
          <div className="mt-2 pt-2 border-t border-zinc-800/60 space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <label
                htmlFor="toggle-auto-crop"
                className="text-xs text-zinc-300 cursor-pointer min-w-0"
              >
                Auto-Crop Inscribed
              </label>
              <input
                id="toggle-auto-crop"
                type="checkbox"
                checked={config.autoCropEnabled}
                onChange={(e) =>
                  onChangeConfig((prev) => ({ ...prev, autoCropEnabled: e.target.checked }))
                }
                className="h-3.5 w-3.5 accent-zinc-200 rounded cursor-pointer shrink-0"
              />
            </div>

            {config.autoCropEnabled && (
              <div className="flex items-center justify-between gap-3">
                <label
                  htmlFor="toggle-preserve-crop-aspect"
                  className="text-xs text-zinc-400 cursor-pointer min-w-0"
                >
                  Keep Aspect Ratio
                </label>
                <input
                  id="toggle-preserve-crop-aspect"
                  type="checkbox"
                  checked={config.preserveAspectRatioInCrop}
                  onChange={(e) =>
                    onChangeConfig((prev) => ({
                      ...prev,
                      preserveAspectRatioInCrop: e.target.checked,
                    }))
                  }
                  className="h-3.5 w-3.5 accent-zinc-200 rounded cursor-pointer shrink-0"
                />
              </div>
            )}

            <div className="flex items-center justify-between gap-2 text-xs text-zinc-500">
              <span className="shrink-0">Crop Bounds</span>
              <span
                className="font-mono text-zinc-300 tabular-nums text-right"
                data-testid="crop-dimensions-val"
              >
                {cropRect.width}×{cropRect.height} · {cropRect.areaRetainedPercent}%
              </span>
            </div>
          </div>

          {/* Auto-Correct Tone & White Balance */}
          <div className="mt-2 pt-2 border-t border-zinc-800/60">
            <div className="flex items-center justify-between gap-3">
              <label
                htmlFor="toggle-auto-correct"
                className="text-xs text-zinc-300 cursor-pointer min-w-0"
              >
                Auto Tone & Balance
              </label>
              <input
                id="toggle-auto-correct"
                type="checkbox"
                checked={autoCorrectEnabled}
                onChange={(e) =>
                  onChangeConfig((prev) => ({ ...prev, autoCorrectEnabled: e.target.checked }))
                }
                className="h-3.5 w-3.5 accent-zinc-200 rounded cursor-pointer shrink-0"
              />
            </div>

            {autoCorrectEnabled && (
              <div className="mt-1.5">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <label htmlFor="slider-auto-correct-strength" className="text-zinc-400">
                    Intensity
                  </label>
                  <span
                    className="font-mono text-zinc-200 tabular-nums shrink-0"
                    data-testid="auto-correct-strength-val"
                  >
                    {autoCorrectStrength}%
                  </span>
                </div>
                <input
                  id="slider-auto-correct-strength"
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={autoCorrectStrength}
                  onChange={(e) =>
                    onChangeConfig((prev) => ({
                      ...prev,
                      autoCorrectStrength: parseInt(e.target.value, 10),
                    }))
                  }
                  className="mt-1 h-1 w-full cursor-pointer appearance-none rounded-lg bg-zinc-800 accent-zinc-200"
                />
                {autoCorrect && (
                  <div className="mt-1 flex items-center justify-between gap-1 text-[11px] font-mono text-zinc-500 tabular-nums">
                    <span>
                      EV{' '}
                      {autoCorrect.exposureEv >= 0
                        ? `+${autoCorrect.exposureEv.toFixed(2)}`
                        : autoCorrect.exposureEv.toFixed(2)}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>Contrast +{autoCorrect.contrast}</span>
                    <span aria-hidden="true">·</span>
                    <span>DR {autoCorrect.dynamicRangeStops}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Section 2: Frame & Border */}
        <section className="border-b border-zinc-800/70 px-4 py-2.5">
          <h2 className="font-display text-xs font-semibold tracking-tight text-zinc-200">
            Frame & Border
          </h2>

          {/* Aspect Ratio Selector */}
          <div className="mt-2">
            <div className="text-xs text-zinc-400 mb-1.5">Aspect Ratio</div>
            <div
              className="flex items-center gap-1"
              role="group"
              aria-label="Target Aspect Ratio"
            >
              {ASPECT_PRESETS.map((preset) => {
                const active = config.aspectPreset === preset.value;
                return (
                  <button
                    key={preset.value}
                    type="button"
                    onClick={() =>
                      onChangeConfig((prev) => ({ ...prev, aspectPreset: preset.value }))
                    }
                    className={`flex-1 rounded px-2 py-1 text-xs font-medium transition-colors text-center whitespace-nowrap ${
                      active
                        ? 'bg-zinc-100 text-zinc-950 font-semibold'
                        : 'bg-zinc-900 text-zinc-400 border border-zinc-800/80 hover:border-zinc-700 hover:text-zinc-200'
                    }`}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Border Padding Slider */}
          <div className="mt-2">
            <div className="flex items-center justify-between gap-2 text-xs">
              <label htmlFor="slider-border-padding" className="text-zinc-400">
                Border Padding
              </label>
              <span
                className="font-mono text-zinc-200 tabular-nums shrink-0"
                data-testid="padding-percent-val"
              >
                {config.paddingPercent}%
              </span>
            </div>
            <input
              id="slider-border-padding"
              type="range"
              min={0}
              max={30}
              step={1}
              value={config.paddingPercent}
              onChange={(e) =>
                onChangeConfig((prev) => ({
                  ...prev,
                  paddingPercent: parseInt(e.target.value, 10),
                }))
              }
              className="mt-1 h-1 w-full cursor-pointer appearance-none rounded-lg bg-zinc-800 accent-zinc-200"
            />
            <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-zinc-500">
              <span className="shrink-0">Output Size</span>
              <span
                className="font-mono text-zinc-300 tabular-nums text-right"
                data-testid="output-canvas-size"
              >
                {frameLayout.canvasWidth} × {frameLayout.canvasHeight} px
              </span>
            </div>
          </div>

          {/* Background / Border Color Picker */}
          <div className="mt-2">
            <div className="flex items-center justify-between gap-2 text-xs mb-1.5">
              <span className="text-zinc-400">Border Color</span>
              <span className="font-mono text-zinc-500 uppercase tabular-nums shrink-0">
                {config.backgroundColor}
              </span>
            </div>

            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {BACKGROUND_COLOR_PRESETS.map((swatch) => {
                  const isSelected =
                    config.backgroundColor.toLowerCase() === swatch.hex.toLowerCase();
                  return (
                    <button
                      key={swatch.id}
                      type="button"
                      aria-label={`Select ${swatch.label} background`}
                      onClick={() =>
                        onChangeConfig((prev) => ({ ...prev, backgroundColor: swatch.hex }))
                      }
                      style={{ backgroundColor: swatch.hex }}
                      className={`h-5 w-5 rounded border transition-transform ${
                        isSelected
                          ? 'scale-110 border-zinc-100 ring-1 ring-zinc-100/50'
                          : 'border-zinc-700 hover:scale-105'
                      }`}
                    />
                  );
                })}
              </div>

              <label
                htmlFor="custom-bg-color"
                className="flex cursor-pointer items-center gap-1.5 rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-300 hover:border-zinc-700 whitespace-nowrap shrink-0"
              >
                <span>Custom</span>
                <input
                  id="custom-bg-color"
                  type="color"
                  aria-label="Custom Frame Background Color"
                  value={config.backgroundColor}
                  onChange={(e) =>
                    onChangeConfig((prev) => ({ ...prev, backgroundColor: e.target.value }))
                  }
                  className="h-3.5 w-3.5 cursor-pointer border-0 bg-transparent p-0"
                />
              </label>
            </div>
          </div>
        </section>

        {/* Section 3: Metadata */}
        <section className="px-4 py-2.5">
          <h2 className="font-display text-xs font-semibold tracking-tight text-zinc-200">
            Metadata & Export
          </h2>

          <div className="mt-2 space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <label
                htmlFor="toggle-preserve-exif"
                className="text-xs text-zinc-300 cursor-pointer min-w-0"
              >
                Preserve EXIF Metadata
              </label>
              <input
                id="toggle-preserve-exif"
                type="checkbox"
                checked={config.preserveExifMetadata}
                onChange={(e) =>
                  onChangeConfig((prev) => ({
                    ...prev,
                    preserveExifMetadata: e.target.checked,
                  }))
                }
                className="h-3.5 w-3.5 accent-zinc-200 rounded cursor-pointer shrink-0"
              />
            </div>

            <div className="flex items-center justify-between gap-3">
              <label
                htmlFor="toggle-exif-caption"
                className="text-xs text-zinc-300 cursor-pointer min-w-0"
              >
                EXIF Border Caption
              </label>
              <input
                id="toggle-exif-caption"
                type="checkbox"
                checked={config.renderExifCaption}
                onChange={(e) =>
                  onChangeConfig((prev) => ({
                    ...prev,
                    renderExifCaption: e.target.checked,
                  }))
                }
                className="h-3.5 w-3.5 accent-zinc-200 rounded cursor-pointer shrink-0"
              />
            </div>
          </div>

          {/* Clean Unboxed EXIF Readout */}
          <div className="mt-2 space-y-1 border-t border-zinc-800/60 pt-2 text-xs text-zinc-500">
            {(exif.cameraModel || exif.rawFormat) && (
              <div className="flex items-center justify-between gap-3 min-w-0">
                <span className="shrink-0">Camera</span>
                <span className="text-zinc-300 truncate text-right">
                  {[exif.cameraModel, exif.rawFormat || 'JPEG'].filter(Boolean).join(' · ')}
                </span>
              </div>
            )}
            {exif.lensModel && (
              <div className="flex items-center justify-between gap-3 min-w-0">
                <span className="shrink-0">Lens</span>
                <span className="text-zinc-300 truncate text-right">{exif.lensModel}</span>
              </div>
            )}
            {[
              exif.focalLength,
              exif.aperture,
              exif.shutterSpeed,
              exif.iso ? `ISO ${exif.iso.replace(/^ISO\s*/i, '')}` : '',
            ].some(Boolean) && (
              <div className="flex items-center justify-between gap-3 min-w-0">
                <span className="shrink-0">Exposure</span>
                <span className="font-mono text-zinc-300 tabular-nums truncate text-right">
                  {[
                    exif.focalLength,
                    exif.aperture,
                    exif.shutterSpeed,
                    exif.iso ? `ISO ${exif.iso.replace(/^ISO\s*/i, '')}` : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between gap-3 min-w-0">
              <span className="shrink-0">Source</span>
              <span className="font-mono text-zinc-400 tabular-nums text-right">
                {sourceSize.width} × {sourceSize.height} px
              </span>
            </div>
          </div>
        </section>
      </div>

      {/* Pinned Export Footer CTA */}
      <div className="shrink-0 border-t border-zinc-800/80 bg-[#0d0d10] px-4 py-3">
        <button
          type="button"
          onClick={onExportJpeg}
          disabled={isExporting || !isImageLoaded}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-zinc-100 hover:bg-white text-zinc-950 px-4 py-2 text-xs font-medium transition-colors disabled:opacity-40 whitespace-nowrap shrink-0"
        >
          <Download className="h-3.5 w-3.5" />
          {isExporting ? 'Exporting...' : 'Export JPEG'}
        </button>
      </div>
    </aside>
  );
};
