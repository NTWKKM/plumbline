import React from 'react';
import {
  Compass,
  Crop,
  Download,
  FileCheck,
  Frame,
  Layers,
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
  clamp,
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
  onBatchExportAll?: () => void;
  isExporting: boolean;
  isBatchExporting?: boolean;
  queueCount?: number;
  isImageLoaded?: boolean;
  canSaveToFolder?: boolean;
  className?: string;
}

const ASPECT_PRESETS: { value: AspectRatioPreset; label: string }[] = [
  { value: '1:1', label: '1:1' },
  { value: '4:5', label: '4:5' },
  { value: '16:9', label: '16:9' },
  { value: '3:2', label: '3:2' },
  { value: 'original', label: 'Original' },
];

const ANGLE_NUDGE_STEPS = [-1.0, -0.1, 0, 0.1, 1.0] as const;
const SWITCH_ATTR = { switch: '' } as React.InputHTMLAttributes<HTMLInputElement>;

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
  onBatchExportAll,
  isExporting,
  isBatchExporting = false,
  queueCount = 1,
  isImageLoaded = true,
  canSaveToFolder = false,
  className = '',
}) => {
  const totalRotationDeg = Number(
    (
      (config.autoLevelEnabled ? analysis.appliedRotationDeg : 0) +
      config.manualAngleOffsetDeg
    ).toFixed(2)
  );
  const keystoneEnabled = config.keystoneWarpEnabled ?? true;
  const manualKeystoneDeg = config.manualKeystoneDeg ?? 0;
  const totalKeystoneDeg = Number(
    (
      (keystoneEnabled ? (analysis.appliedKeystoneDeg ?? 0) : 0) +
      manualKeystoneDeg
    ).toFixed(2)
  );
  const autoCorrectEnabled = config.autoCorrectEnabled ?? true;
  const autoCorrectStrength = config.autoCorrectStrength ?? 75;
  const wbProfile = config.wbProfile ?? 'ambient';
  const histogram = autoCorrect?.lumaHistogram ?? [];

  const handleNudgeManualAngle = (delta: number) => {
    onChangeConfig((prev) => ({
      ...prev,
      manualAngleOffsetDeg:
        delta === 0
          ? 0
          : Number(clamp(prev.manualAngleOffsetDeg + delta, -15, 15).toFixed(2)),
    }));
  };

  return (
    <aside
      aria-label="Image Processing Inspector"
      className={`flex shrink-0 flex-col border-t lg:border-t-0 lg:border-l border-rule bg-paper-2 text-ink select-none overflow-y-auto ${className || 'w-full lg:w-[364px]'}`}
    >
      {/* Luminance Waveform & Tonal Readout */}
      <section className="border-b border-rule px-4 py-3.5">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="font-display text-sm font-normal text-ink">
            Luminance histogram
          </h2>
          {autoCorrect && (
            <span className="font-mono text-xs text-muted tabular-nums">
              DR {autoCorrect.dynamicRangeStops} EV
            </span>
          )}
        </div>

        <div className="atelier-stock mt-2.5 p-2.5">
          <svg
            viewBox="0 0 256 64"
            className="h-14 w-full text-ink"
            role="img"
            aria-label="Luminance distribution histogram across shadows, midtones, and highlights"
          >
            {/* Subtle zone hairlines at 25%, 50%, 75% */}
            <line x1="64" y1="0" x2="64" y2="64" stroke="var(--color-rule)" strokeWidth="1" />
            <line x1="128" y1="0" x2="128" y2="64" stroke="var(--color-rule)" strokeWidth="1" />
            <line x1="192" y1="0" x2="192" y2="64" stroke="var(--color-rule)" strokeWidth="1" />
            {histogram.length > 0 ? (
              histogram.map((normVal, idx) => {
                const barH = Math.max(1, Math.round(normVal * 58));
                return (
                  <rect
                    key={idx}
                    x={idx * 4}
                    y={62 - barH}
                    width="3"
                    height={barH}
                    fill="currentColor"
                    opacity={0.78}
                  />
                );
              })
            ) : (
              <line x1="0" y1="62" x2="256" y2="62" stroke="var(--color-rule)" strokeWidth="1" />
            )}
          </svg>
          <div className="mt-1.5 flex items-center justify-between text-xs text-muted font-mono tabular-nums">
            <span>Black {autoCorrect?.blackPoint ?? 0}</span>
            <span>Midtones</span>
            <span>White {autoCorrect?.whitePoint ?? 255}</span>
          </div>
        </div>
      </section>

      {/* Section 1: Auto-Leveling, Inscribed Auto-Crop & Smart Auto-Correct */}
      <section className="border-b border-rule px-4 py-3.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Compass className="h-4 w-4 text-accent shrink-0" aria-hidden="true" />
            <h2 className="font-display text-sm font-normal text-ink truncate">
              Auto-level, crop and correct
            </h2>
          </div>
          <button
            type="button"
            onClick={onResetAll}
            className="btn btn--quiet btn--sm shrink-0"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            Reset
          </button>
        </div>

        {/* Live Telemetry Readout (Ruled table style, tabular-nums) */}
        <div className="mt-2.5 grid grid-cols-3 divide-x divide-rule border-y border-rule py-2 text-xs">
          <div className="min-w-0 pr-2">
            <div className="text-muted truncate">Detected tilt</div>
            <div className="mt-0.5 font-mono font-medium text-ink tabular-nums truncate" data-testid="detected-tilt-val">
              {formatSignedDegrees(analysis.detectedTiltDeg, 2)}
            </div>
          </div>
          <div className="min-w-0 px-2">
            <div className="text-muted truncate">Correction</div>
            <div className="mt-0.5 font-mono font-medium text-accent tabular-nums truncate" data-testid="applied-rotation-val">
              {formatSignedDegrees(totalRotationDeg, 2)}
            </div>
          </div>
          <div className="min-w-0 pl-2">
            <div className="text-muted truncate">Confidence</div>
            <div className="mt-0.5 font-mono font-medium text-ink-2 tabular-nums truncate">
              {Math.round(analysis.confidence * 100)}%
            </div>
          </div>
        </div>

        <details open className="atelier-disclosure mt-2.5">
          <summary className="py-1 text-xs font-medium text-ink-2">
            Geometry & tonal controls
          </summary>

          <div className="pt-2 space-y-3">
            {/* Scharr + Sub-Pixel Radon + IRLS Auto-Level Toggle */}
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="toggle-auto-level" className="text-xs font-medium text-ink cursor-pointer truncate">
                Auto-level the horizon
              </label>
              <input
                id="toggle-auto-level"
                type="checkbox"
                {...SWITCH_ATTR}
                checked={config.autoLevelEnabled}
                onChange={(e) =>
                  onChangeConfig((prev) => ({ ...prev, autoLevelEnabled: e.target.checked }))
                }
                className="h-4 w-4 rounded cursor-pointer shrink-0"
              />
            </div>

            {/* Simulated Camera Tilt Input */}
            <div>
              <div className="flex items-center justify-between text-xs">
                <label htmlFor="slider-sensor-tilt" className="text-muted">
                  Test sensor tilt
                </label>
                <span className="font-mono text-ink tabular-nums">
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
                className="mt-1.5 h-1.5 w-full cursor-pointer rounded-pill bg-paper-3 accent-accent"
              />
            </div>

            {/* Fine Manual Rotation Offset + Precision Nudge Buttons */}
            <div>
              <div className="flex items-center justify-between text-xs">
                <label htmlFor="slider-manual-angle" className="text-muted">
                  Fine-tune angle
                </label>
                <span className="font-mono text-ink tabular-nums">
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
                className="mt-1.5 h-1.5 w-full cursor-pointer rounded-pill bg-paper-3 accent-accent"
              />
              <div className="mt-2 grid grid-cols-5 gap-1" role="group" aria-label="Precision angle nudge">
                {ANGLE_NUDGE_STEPS.map((step) => (
                  <button
                    key={step}
                    type="button"
                    onClick={() => handleNudgeManualAngle(step)}
                    className="hit-target-expand min-h-[32px] rounded-pill border border-rule bg-paper px-1.5 py-1 text-xs font-mono text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink tabular-nums"
                  >
                    {step === 0 ? '0°' : formatSignedDegrees(step, 1)}
                  </button>
                ))}
              </div>
            </div>

            {/* Keystone correction */}
            <div className="pt-2.5 border-t border-rule">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="toggle-keystone-warp" className="text-xs font-medium text-ink cursor-pointer truncate">
                  Keystone correction
                </label>
                <input
                  id="toggle-keystone-warp"
                  type="checkbox"
                  {...SWITCH_ATTR}
                  checked={keystoneEnabled}
                  onChange={(e) =>
                    onChangeConfig((prev) => ({
                      ...prev,
                      keystoneWarpEnabled: e.target.checked,
                    }))
                  }
                  className="h-4 w-4 rounded cursor-pointer shrink-0"
                />
              </div>

              <div className="mt-2">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <label htmlFor="slider-manual-keystone" className="text-muted">
                    Vertical keystone
                  </label>
                  <div className="flex items-center gap-2 shrink-0">
                    {manualKeystoneDeg !== 0 && (
                      <button
                        type="button"
                        onClick={() =>
                          onChangeConfig((prev) => ({ ...prev, manualKeystoneDeg: 0 }))
                        }
                        className="btn btn--quiet btn--sm font-mono text-xs"
                      >
                        Reset 0°
                      </button>
                    )}
                    <span
                      className="font-mono text-ink tabular-nums"
                      data-testid="keystone-angle-val"
                    >
                      {formatSignedDegrees(totalKeystoneDeg, 2)}
                    </span>
                  </div>
                </div>
                <input
                  id="slider-manual-keystone"
                  type="range"
                  min={-12}
                  max={12}
                  step={0.1}
                  value={manualKeystoneDeg}
                  onChange={(e) =>
                    onChangeConfig((prev) => ({
                      ...prev,
                      manualKeystoneDeg: parseFloat(e.target.value),
                    }))
                  }
                  className="mt-1.5 h-1.5 w-full cursor-pointer rounded-pill bg-paper-3 accent-accent"
                />
              </div>
            </div>

            {/* Inscribed Auto-Crop Controls */}
            <div className="pt-2.5 border-t border-rule">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="toggle-auto-crop" className="flex items-center gap-1.5 text-xs font-medium text-ink cursor-pointer min-w-0">
                  <Crop className="h-3.5 w-3.5 text-accent shrink-0" aria-hidden="true" />
                  <span className="truncate">Auto-crop the largest clean rectangle</span>
                </label>
                <input
                  id="toggle-auto-crop"
                  type="checkbox"
                  {...SWITCH_ATTR}
                  checked={config.autoCropEnabled}
                  onChange={(e) =>
                    onChangeConfig((prev) => ({ ...prev, autoCropEnabled: e.target.checked }))
                  }
                  className="h-4 w-4 rounded cursor-pointer shrink-0"
                />
              </div>

              {config.autoCropEnabled && (
                <div className="mt-2 flex items-center justify-between gap-2">
                  <label htmlFor="toggle-preserve-crop-aspect" className="text-xs text-muted cursor-pointer truncate">
                    Keep source aspect ratio
                  </label>
                  <input
                    id="toggle-preserve-crop-aspect"
                    type="checkbox"
                    {...SWITCH_ATTR}
                    checked={config.preserveAspectRatioInCrop}
                    onChange={(e) =>
                      onChangeConfig((prev) => ({
                        ...prev,
                        preserveAspectRatioInCrop: e.target.checked,
                      }))
                    }
                    className="h-4 w-4 rounded cursor-pointer shrink-0"
                  />
                </div>
              )}

              <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted">
                <span className="shrink-0">Crop size</span>
                <span className="font-mono text-ink tabular-nums truncate text-right" data-testid="crop-dimensions-val">
                  {cropRect.width} × {cropRect.height} px ({cropRect.areaRetainedPercent}% area)
                </span>
              </div>
            </div>

            {/* Smart Filmic Auto-Correct (Tone, Contrast & White Balance) */}
            <div className="pt-2.5 border-t border-rule">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="toggle-auto-correct" className="flex items-center gap-1.5 text-xs font-medium text-ink cursor-pointer min-w-0">
                  <Sparkles className="h-3.5 w-3.5 text-accent shrink-0" aria-hidden="true" />
                  <span className="truncate">Auto-correct tone and white balance</span>
                </label>
                <input
                  id="toggle-auto-correct"
                  type="checkbox"
                  {...SWITCH_ATTR}
                  checked={autoCorrectEnabled}
                  onChange={(e) =>
                    onChangeConfig((prev) => ({ ...prev, autoCorrectEnabled: e.target.checked }))
                  }
                  className="h-4 w-4 rounded cursor-pointer shrink-0"
                />
              </div>

              {autoCorrectEnabled && (
                <div className="mt-2 space-y-2.5">
                  <div
                    className="grid grid-cols-2 divide-x divide-rule border border-rule bg-paper"
                    role="group"
                    aria-label="White Balance Profile"
                  >
                    <button
                      type="button"
                      data-testid="wb-profile-ambient"
                      aria-pressed={wbProfile === 'ambient'}
                      onClick={() =>
                        onChangeConfig((prev) => ({ ...prev, wbProfile: 'ambient' }))
                      }
                      className={`min-h-[32px] px-2 py-1 text-xs font-medium transition-colors whitespace-nowrap truncate ${
                        wbProfile === 'ambient'
                          ? 'bg-ink text-paper'
                          : 'bg-paper text-ink-2 hover:bg-paper-3 hover:text-ink'
                      }`}
                    >
                      Golden Hour
                    </button>
                    <button
                      type="button"
                      data-testid="wb-profile-neutral"
                      aria-pressed={wbProfile === 'neutral'}
                      onClick={() =>
                        onChangeConfig((prev) => ({ ...prev, wbProfile: 'neutral' }))
                      }
                      className={`min-h-[32px] px-2 py-1 text-xs font-medium transition-colors whitespace-nowrap truncate ${
                        wbProfile === 'neutral'
                          ? 'bg-ink text-paper'
                          : 'bg-paper text-ink-2 hover:bg-paper-3 hover:text-ink'
                      }`}
                    >
                      Studio Neutral
                    </button>
                  </div>

                  <div>
                    <div className="flex items-center justify-between text-xs">
                      <label htmlFor="slider-auto-correct-strength" className="text-muted">
                        Strength
                      </label>
                      <span className="font-mono text-ink tabular-nums" data-testid="auto-correct-strength-val">
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
                      className="mt-1.5 h-1.5 w-full cursor-pointer rounded-pill bg-paper-3 accent-accent"
                    />
                  </div>

                  {autoCorrect && (
                    <div className="grid grid-cols-2 divide-x divide-y divide-rule border border-rule bg-paper text-center text-xs text-muted font-mono tabular-nums">
                      <span className="truncate px-1.5 py-1">
                        EV {autoCorrect.exposureEv >= 0 ? `+${autoCorrect.exposureEv.toFixed(2)}` : autoCorrect.exposureEv.toFixed(2)}
                      </span>
                      <span className="truncate px-1.5 py-1 border-t-0">
                        Contrast +{autoCorrect.contrast}
                      </span>
                      <span className="truncate px-1.5 py-1 border-l-0" data-testid="wb-kelvin-val">
                        Est. {autoCorrect.estimatedKelvin ?? 5500}K ({autoCorrect.wbTempShift >= 0 ? `+${autoCorrect.wbTempShift}` : autoCorrect.wbTempShift})
                      </span>
                      <span className="truncate px-1.5 py-1" data-testid="wb-ambient-val">
                        {wbProfile === 'ambient'
                          ? `${autoCorrect.ambientWarmthRetainedPercent ?? 35}% ambient retained`
                          : '0% ambient retained'}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </details>
      </section>

      {/* Section 2: White Border & Aspect Ratio Framing */}
      <section className="border-b border-rule px-4 py-3.5">
        <div className="flex items-center gap-2">
          <Frame className="h-4 w-4 text-accent shrink-0" aria-hidden="true" />
          <h2 className="font-display text-sm font-normal text-ink">
            White border and frame
          </h2>
        </div>

        <details open className="atelier-disclosure mt-2.5">
          <summary className="py-1 text-xs font-medium text-ink-2">
            Mat proportions & paper border
          </summary>

          <div className="pt-2 space-y-3">
            {/* Aspect Ratio Selector */}
            <div>
              <div className="text-xs text-muted mb-1.5">Aspect ratio</div>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3" role="group" aria-label="Target Aspect Ratio">
                {ASPECT_PRESETS.map((preset, index) => {
                  const active = config.aspectPreset === preset.value;
                  const isLastOdd = index === ASPECT_PRESETS.length - 1;
                  return (
                    <button
                      key={preset.value}
                      type="button"
                      aria-pressed={active}
                      onClick={() =>
                        onChangeConfig((prev) => ({ ...prev, aspectPreset: preset.value }))
                      }
                      className={`min-h-[32px] rounded-pill px-2 py-1.5 text-xs font-medium transition-colors text-center truncate border ${
                        isLastOdd ? 'col-span-2 sm:col-span-1' : ''
                      } ${
                        active
                          ? 'bg-ink text-paper border-ink'
                          : 'bg-paper text-ink-2 border-rule hover:border-ink-2 hover:text-ink'
                      }`}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Border Padding Slider */}
            <div>
              <div className="flex items-center justify-between text-xs">
                <label htmlFor="slider-border-padding" className="text-ink-2 font-medium">
                  Border width
                </label>
                <span className="font-mono text-ink tabular-nums" data-testid="padding-percent-val">
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
                className="mt-1.5 h-1.5 w-full cursor-pointer rounded-pill bg-paper-3 accent-accent"
              />
              <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-muted">
                <span className="shrink-0">Output size</span>
                <span className="font-mono text-ink tabular-nums truncate text-right" data-testid="output-canvas-size">
                  {frameLayout.canvasWidth} × {frameLayout.canvasHeight} px
                </span>
              </div>
            </div>

            {/* Background / Border Color Picker */}
            <div>
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span className="text-ink-2 font-medium">Border color</span>
                <span className="font-mono text-muted tabular-nums">
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
                      aria-pressed={isSelected}
                      onClick={() =>
                        onChangeConfig((prev) => ({ ...prev, backgroundColor: swatch.hex }))
                      }
                      style={{ backgroundColor: swatch.hex }}
                      className={`hit-target-expand h-7 w-7 rounded-pill border transition-transform motion-reduce:transition-none ${
                        isSelected
                          ? 'scale-105 border-accent ring-2 ring-focus'
                          : 'border-rule hover:border-ink-2'
                      }`}
                    />
                  );
                })}

                <label
                  htmlFor="custom-bg-color"
                  className="ml-auto flex min-h-[32px] cursor-pointer items-center gap-1.5 rounded-pill border border-rule bg-paper px-2.5 py-1 text-xs text-ink hover:border-ink-2 whitespace-nowrap shrink-0"
                >
                  <span>Custom</span>
                  <input
                    id="custom-bg-color"
                    type="color"
                    aria-label="Custom Border color"
                    value={config.backgroundColor}
                    onChange={(e) =>
                      onChangeConfig((prev) => ({ ...prev, backgroundColor: e.target.value }))
                    }
                    className="h-4 w-4 cursor-pointer border-0 bg-transparent p-0"
                  />
                </label>
              </div>
            </div>
          </div>
        </details>
      </section>

      {/* Section 3: EXIF Preservation & Native Export */}
      <section className="flex-1 px-4 py-3.5 flex flex-col justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <FileCheck className="h-4 w-4 text-accent shrink-0" aria-hidden="true" />
            <h2 className="font-display text-sm font-normal text-ink">
              EXIF and export
            </h2>
          </div>

          <div className="mt-2.5 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="toggle-preserve-exif" className="text-xs font-medium text-ink cursor-pointer">
                Keep original EXIF
              </label>
              <input
                id="toggle-preserve-exif"
                type="checkbox"
                {...SWITCH_ATTR}
                checked={config.preserveExifMetadata}
                onChange={(e) =>
                  onChangeConfig((prev) => ({
                    ...prev,
                    preserveExifMetadata: e.target.checked,
                  }))
                }
                className="h-4 w-4 rounded cursor-pointer shrink-0"
              />
            </div>

            <div className="flex items-center justify-between gap-2">
              <label htmlFor="toggle-exif-caption" className="text-xs font-medium text-ink cursor-pointer">
                Print EXIF caption on the border
              </label>
              <input
                id="toggle-exif-caption"
                type="checkbox"
                {...SWITCH_ATTR}
                checked={config.renderExifCaption}
                onChange={(e) =>
                  onChangeConfig((prev) => ({
                    ...prev,
                    renderExifCaption: e.target.checked,
                  }))
                }
                className="h-4 w-4 rounded cursor-pointer shrink-0"
              />
            </div>

            <div>
              <div className="flex items-center justify-between text-xs">
                <label htmlFor="slider-jpeg-quality" className="text-muted">
                  JPEG quality
                </label>
                <span className="font-mono text-ink tabular-nums" data-testid="jpeg-quality-val">
                  {config.jpegQuality}
                </span>
              </div>
              <input
                id="slider-jpeg-quality"
                type="range"
                min={70}
                max={100}
                step={1}
                value={config.jpegQuality}
                onChange={(e) =>
                  onChangeConfig((prev) => ({
                    ...prev,
                    jpegQuality: parseInt(e.target.value, 10),
                  }))
                }
                className="mt-1.5 h-1.5 w-full cursor-pointer rounded-pill bg-paper-3 accent-accent"
              />
            </div>
          </div>

          {/* Clean Ruled EXIF Metadata List */}
          <dl className="mt-3 divide-y divide-rule border-y border-rule text-xs">
            {(exif.cameraModel || exif.rawFormat) && (
              <div className="flex items-center justify-between gap-2 py-1.5">
                <dt className="text-muted shrink-0">Camera and format</dt>
                <dd className="text-ink font-medium truncate text-right max-w-[65%]">
                  {[exif.cameraModel, exif.rawFormat || 'JPEG'].filter(Boolean).join(', ')}
                </dd>
              </div>
            )}
            {exif.lensModel && (
              <div className="flex items-center justify-between gap-2 py-1.5">
                <dt className="text-muted shrink-0">Lens</dt>
                <dd className="text-ink font-medium truncate text-right max-w-[65%]">
                  {exif.lensModel}
                </dd>
              </div>
            )}
            {[
              exif.focalLength,
              exif.aperture,
              exif.shutterSpeed,
              exif.iso ? `ISO ${exif.iso.replace(/^ISO\s*/i, '')}` : '',
            ].some(Boolean) && (
              <div className="flex items-center justify-between gap-2 py-1.5">
                <dt className="text-muted shrink-0">Exposure</dt>
                <dd className="font-mono text-ink tabular-nums truncate text-right max-w-[65%]">
                  {[
                    exif.focalLength,
                    exif.aperture,
                    exif.shutterSpeed,
                    exif.iso ? `ISO ${exif.iso.replace(/^ISO\s*/i, '')}` : '',
                  ]
                    .filter(Boolean)
                    .join(', ')}
                </dd>
              </div>
            )}
            <div className="flex items-center justify-between gap-2 py-1.5">
              <dt className="text-muted shrink-0">Source size</dt>
              <dd className="font-mono text-ink-2 tabular-nums truncate text-right">
                {sourceSize.width} × {sourceSize.height} px
              </dd>
            </div>
          </dl>
        </div>

      </section>

      {/* Export actions stay pinned to the bottom of the inspector so the primary action is always in view */}
      <div className="inspector-export">
        <p className="mb-2 flex items-baseline justify-between gap-2 text-xs text-muted">
          <span>Output</span>
          <span className="font-mono tabular-nums text-ink-2" data-testid="export-summary">
            {frameLayout.canvasWidth} × {frameLayout.canvasHeight} px, JPEG {config.jpegQuality}
          </span>
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onExportJpeg}
            disabled={isExporting || isBatchExporting || !isImageLoaded}
            aria-busy={isExporting}
            className="btn flex-1 min-h-[40px]"
          >
            <Download className="h-4 w-4" aria-hidden="true" />
            {isExporting ? 'Encoding…' : 'Export JPEG'}
          </button>

          {onBatchExportAll && (
            <button
              type="button"
              onClick={onBatchExportAll}
              disabled={isExporting || isBatchExporting || queueCount === 0}
              aria-busy={isBatchExporting}
              title={
                canSaveToFolder
                  ? 'Choose a folder and save every photo in the queue into it'
                  : 'Download every photo in the queue'
              }
              className="btn btn--quiet min-h-[40px] shrink-0"
            >
              <Layers className="h-4 w-4" aria-hidden="true" />
              {isBatchExporting
                ? 'Exporting…'
                : canSaveToFolder
                  ? `All to folder (${queueCount})`
                  : `Export all (${queueCount})`}
            </button>
          )}
        </div>
      </div>
    </aside>
  );
};
