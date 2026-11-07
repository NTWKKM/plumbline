import React from 'react';
import {
  Compass,
  Crop,
  Download,
  FileCheck,
  Frame,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import {
  AspectRatioPreset,
  AutoCorrectAnalysis,
  CropRect,
  ExifData,
  FrameLayout,
  LevelingAnalysis,
  PipelineConfig,
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
  { value: '1:1', label: '1:1 Square' },
  { value: '4:5', label: '4:5 Portrait' },
  { value: '16:9', label: '16:9 Cinema' },
  { value: '3:2', label: '3:2 Classic' },
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
    ((config.autoLevelEnabled ? analysis.appliedRotationDeg : 0) + config.manualAngleOffsetDeg).toFixed(2)
  );
  const autoCorrectEnabled = config.autoCorrectEnabled ?? true;
  const autoCorrectStrength = config.autoCorrectStrength ?? 75;

  return (
    <aside
      aria-label="Image Processing Inspector"
      className={`flex shrink-0 flex-col border-t lg:border-t-0 lg:border-l border-zinc-800/90 bg-[#111114] text-zinc-100 select-none overflow-y-auto ${className || 'w-full lg:w-[356px]'}`}
    >
      {/* Section 1: Auto-Leveling, Inscribed Auto-Crop & Smart Auto-Correct */}
      <section className="border-b border-zinc-800/80 px-4 py-3.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Compass className="h-4 w-4 text-blue-400 shrink-0" />
            <h2 className="font-display text-sm font-semibold tracking-tight text-zinc-100 truncate">
              Auto-Level, Crop & Correct
            </h2>
          </div>
          <button
            type="button"
            onClick={onResetAll}
            className="flex items-center gap-1 text-xs text-zinc-400 transition-colors hover:text-zinc-100 whitespace-nowrap shrink-0"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset
          </button>
        </div>

        {/* Scharr + Sub-Pixel Radon + IRLS Auto-Level Toggle */}
        <div className="mt-2.5 flex items-center justify-between gap-2">
          <label htmlFor="toggle-auto-level" className="text-xs font-medium text-zinc-200 cursor-pointer truncate">
            Scharr Sub-Pixel Horizon Auto-Level
          </label>
          <input
            id="toggle-auto-level"
            type="checkbox"
            checked={config.autoLevelEnabled}
            onChange={(e) =>
              onChangeConfig((prev) => ({ ...prev, autoLevelEnabled: e.target.checked }))
            }
            className="h-4 w-4 accent-blue-600 rounded cursor-pointer shrink-0"
          />
        </div>

        {/* Live Telemetry Readout (Unboxed clean text + tabular-nums) */}
        <div className="mt-2 grid grid-cols-3 gap-2 border-y border-zinc-800/80 py-2 text-xs">
          <div className="min-w-0">
            <div className="text-zinc-400 truncate">Detected Tilt</div>
            <div className="mt-0.5 font-medium text-zinc-100 tabular-nums truncate" data-testid="detected-tilt-val">
              {analysis.detectedTiltDeg > 0 ? `+${analysis.detectedTiltDeg.toFixed(2)}°` : `${analysis.detectedTiltDeg.toFixed(2)}°`}
            </div>
          </div>
          <div className="min-w-0">
            <div className="text-zinc-400 truncate">Correction</div>
            <div className="mt-0.5 font-medium text-blue-400 tabular-nums truncate" data-testid="applied-rotation-val">
              {totalRotationDeg > 0 ? `+${totalRotationDeg.toFixed(2)}°` : `${totalRotationDeg.toFixed(2)}°`}
            </div>
          </div>
          <div className="min-w-0">
            <div className="text-zinc-400 truncate">Confidence</div>
            <div className="mt-0.5 font-medium text-zinc-200 tabular-nums truncate">
              {Math.round(analysis.confidence * 100)}%
            </div>
          </div>
        </div>

        {/* Simulated Camera Tilt Input (for testing horizon detector live) */}
        <div className="mt-2.5">
          <div className="flex items-center justify-between text-xs">
            <label htmlFor="slider-sensor-tilt" className="text-zinc-400">
              Test Camera Sensor Tilt
            </label>
            <span className="text-zinc-200 tabular-nums">
              {simulatedTiltDeg > 0 ? `+${simulatedTiltDeg.toFixed(1)}°` : `${simulatedTiltDeg.toFixed(1)}°`}
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
            className="mt-1 h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-zinc-800 accent-blue-500"
          />
        </div>

        {/* Fine Manual Rotation Offset */}
        <div className="mt-2">
          <div className="flex items-center justify-between text-xs">
            <label htmlFor="slider-manual-angle" className="text-zinc-400">
              Manual Fine-Tune Angle
            </label>
            <span className="text-zinc-200 tabular-nums">
              {config.manualAngleOffsetDeg > 0
                ? `+${config.manualAngleOffsetDeg.toFixed(2)}°`
                : `${config.manualAngleOffsetDeg.toFixed(2)}°`}
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
            className="mt-1 h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-zinc-800 accent-blue-500"
          />
        </div>

        {/* Inscribed Auto-Crop Controls */}
        <div className="mt-2.5 pt-2.5 border-t border-zinc-800/60">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="toggle-auto-crop" className="flex items-center gap-1.5 text-xs font-medium text-zinc-200 cursor-pointer min-w-0">
              <Crop className="h-3.5 w-3.5 text-blue-400 shrink-0" />
              <span className="truncate">Auto-Crop Largest Inscribed Rect</span>
            </label>
            <input
              id="toggle-auto-crop"
              type="checkbox"
              checked={config.autoCropEnabled}
              onChange={(e) =>
                onChangeConfig((prev) => ({ ...prev, autoCropEnabled: e.target.checked }))
              }
              className="h-4 w-4 accent-blue-600 rounded cursor-pointer shrink-0"
            />
          </div>

          <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-zinc-400">
            <span className="shrink-0">Inscribed Bounds</span>
            <span className="text-zinc-200 tabular-nums truncate text-right" data-testid="crop-dimensions-val">
              {cropRect.width} × {cropRect.height} px · {cropRect.areaRetainedPercent}% area
            </span>
          </div>
        </div>

        {/* Smart Filmic Auto-Correct (Tone, Contrast & White Balance) */}
        <div className="mt-2.5 pt-2.5 border-t border-zinc-800/60">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="toggle-auto-correct" className="flex items-center gap-1.5 text-xs font-medium text-zinc-200 cursor-pointer min-w-0">
              <Sparkles className="h-3.5 w-3.5 text-blue-400 shrink-0" />
              <span className="truncate">Auto-Correct Tone & White Balance</span>
            </label>
            <input
              id="toggle-auto-correct"
              type="checkbox"
              checked={autoCorrectEnabled}
              onChange={(e) =>
                onChangeConfig((prev) => ({ ...prev, autoCorrectEnabled: e.target.checked }))
              }
              className="h-4 w-4 accent-blue-600 rounded cursor-pointer shrink-0"
            />
          </div>

          {autoCorrectEnabled && (
            <div className="mt-2">
              <div className="flex items-center justify-between text-xs">
                <label htmlFor="slider-auto-correct-strength" className="text-zinc-400">
                  Correction Intensity
                </label>
                <span className="text-zinc-200 tabular-nums" data-testid="auto-correct-strength-val">
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
                className="mt-1 h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-zinc-800 accent-blue-500"
              />
              {autoCorrect && (
                <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-zinc-400 tabular-nums">
                  <span className="truncate">
                    EV {autoCorrect.exposureEv >= 0 ? `+${autoCorrect.exposureEv.toFixed(2)}` : autoCorrect.exposureEv.toFixed(2)}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="truncate">Contrast +{autoCorrect.contrast}</span>
                  <span aria-hidden="true">·</span>
                  <span className="truncate">DR {autoCorrect.dynamicRangeStops} EV</span>
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Section 2: White Border & Aspect Ratio Framing */}
      <section className="border-b border-zinc-800/80 px-4 py-3.5">
        <div className="flex items-center gap-2">
          <Frame className="h-4 w-4 text-blue-400" />
          <h2 className="font-display text-sm font-semibold tracking-tight text-zinc-100">
            White Border & Framing
          </h2>
        </div>

        {/* Aspect Ratio Selector */}
        <div className="mt-2.5">
          <div className="text-xs text-zinc-400 mb-1.5">Target Aspect Ratio</div>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3" role="group" aria-label="Target Aspect Ratio">
            {ASPECT_PRESETS.map((preset) => {
              const active = config.aspectPreset === preset.value;
              return (
                <button
                  key={preset.value}
                  type="button"
                  onClick={() =>
                    onChangeConfig((prev) => ({ ...prev, aspectPreset: preset.value }))
                  }
                  className={`rounded-lg px-2 py-1.5 text-xs font-medium transition-colors text-center truncate ${
                    active
                      ? 'bg-zinc-100 text-zinc-950 font-semibold'
                      : 'bg-zinc-900/90 text-zinc-300 border border-zinc-800 hover:border-zinc-700 hover:text-white'
                  }`}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Border Padding Slider */}
        <div className="mt-3">
          <div className="flex items-center justify-between text-xs">
            <label htmlFor="slider-border-padding" className="text-zinc-300 font-medium">
              Border Thickness (Padding)
            </label>
            <span className="text-zinc-100 tabular-nums" data-testid="padding-percent-val">
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
            className="mt-1 h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-zinc-800 accent-blue-500"
          />
          <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-zinc-400">
            <span className="shrink-0">Output Frame Size</span>
            <span className="text-zinc-200 tabular-nums truncate text-right" data-testid="output-canvas-size">
              {frameLayout.canvasWidth} × {frameLayout.canvasHeight} px
            </span>
          </div>
        </div>

        {/* Background / Border Color Picker */}
        <div className="mt-3">
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="text-zinc-300 font-medium">Frame Background Color</span>
            <span className="text-zinc-400 uppercase tabular-nums">
              {config.backgroundColor}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
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
                  className={`h-6 w-6 rounded-md border transition-transform ${
                    isSelected
                      ? 'scale-110 border-blue-500 ring-2 ring-blue-500/40'
                      : 'border-zinc-700 hover:scale-105'
                  }`}
                />
              );
            })}

            <label
              htmlFor="custom-bg-color"
              className="ml-auto flex cursor-pointer items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-200 hover:border-zinc-500 whitespace-nowrap shrink-0"
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
                className="h-4 w-4 cursor-pointer border-0 bg-transparent p-0"
              />
            </label>
          </div>
        </div>
      </section>

      {/* Section 3: EXIF Preservation & Native Export */}
      <section className="flex-1 px-4 py-3.5 flex flex-col justify-between">
        <div>
          <div className="flex items-center gap-2">
            <FileCheck className="h-4 w-4 text-blue-400" />
            <h2 className="font-display text-sm font-semibold tracking-tight text-zinc-100">
              EXIF & Export
            </h2>
          </div>

          <div className="mt-2.5 space-y-2">
            <div className="flex items-center justify-between">
              <label htmlFor="toggle-preserve-exif" className="text-xs font-medium text-zinc-200 cursor-pointer">
                Preserve Original EXIF (APP1 Segment)
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
                className="h-4 w-4 accent-blue-600 rounded cursor-pointer"
              />
            </div>

            <div className="flex items-center justify-between">
              <label htmlFor="toggle-exif-caption" className="text-xs font-medium text-zinc-200 cursor-pointer">
                Stamp EXIF Caption on Bottom Border
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
                className="h-4 w-4 accent-blue-600 rounded cursor-pointer"
              />
            </div>
          </div>

          {/* Clean Unboxed EXIF Readout with no overflow */}
          <div className="mt-2.5 space-y-1.5 border-t border-zinc-800/80 pt-2.5 text-xs text-zinc-400">
            {(exif.cameraModel || exif.rawFormat) && (
              <div className="flex items-center justify-between gap-2">
                <span className="shrink-0">Camera & Format</span>
                <span className="text-zinc-200 truncate text-right max-w-[65%]">
                  {[exif.cameraModel, exif.rawFormat || 'JPEG'].filter(Boolean).join(' · ')}
                </span>
              </div>
            )}
            {exif.lensModel && (
              <div className="flex items-center justify-between gap-2">
                <span className="shrink-0">Lens</span>
                <span className="text-zinc-200 truncate text-right max-w-[65%]">
                  {exif.lensModel}
                </span>
              </div>
            )}
            {[
              exif.focalLength,
              exif.aperture,
              exif.shutterSpeed,
              exif.iso ? `ISO ${exif.iso.replace(/^ISO\s*/i, '')}` : '',
            ].some(Boolean) && (
              <div className="flex items-center justify-between gap-2">
                <span className="shrink-0">Exposure</span>
                <span className="text-zinc-200 tabular-nums truncate text-right max-w-[65%]">
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
            <div className="flex items-center justify-between gap-2">
              <span className="shrink-0">Source Sensor</span>
              <span className="text-zinc-300 tabular-nums truncate text-right">
                {sourceSize.width} × {sourceSize.height} px
              </span>
            </div>
          </div>
        </div>

        {/* Export Button */}
        <div className="mt-3 pt-2.5 border-t border-zinc-800/80">
          <button
            type="button"
            onClick={onExportJpeg}
            disabled={isExporting || !isImageLoaded}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-zinc-100 hover:bg-white text-zinc-950 px-4 py-2 text-xs font-semibold transition-colors disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <Download className="h-4 w-4" />
            {isExporting ? 'Encoding JPEG & Injecting EXIF...' : 'Export Framed JPEG'}
          </button>
        </div>
      </section>
    </aside>
  );
};
