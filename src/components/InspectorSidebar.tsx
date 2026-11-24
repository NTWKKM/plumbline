import React, { useState } from 'react';
import {
  ClipboardCopy,
  ClipboardPaste,
  CopyCheck,
  Download,
  Layers,
  RotateCcw,
  Ruler,
  Trash2,
} from 'lucide-react';
import {
  AspectRatioPreset,
  AutoCorrectAnalysis,
  CropRect,
  ExifData,
  FrameLayout,
  LevelingAnalysis,
  clamp,
  formatSignedDegrees,
} from '../utils/geometry';
import { OutputSettings, PhotoEdit, Preset } from '../utils/edits';
import { BACKGROUND_COLOR_PRESETS } from '../utils/samplePhotos';

type Updater<T> = (updater: (prev: T) => T) => void;

interface InspectorSidebarProps {
  edit: PhotoEdit;
  onChangeEdit: Updater<PhotoEdit>;
  output: OutputSettings;
  onChangeOutput: Updater<OutputSettings>;
  analysis: LevelingAnalysis;
  autoCorrect?: AutoCorrectAnalysis;
  cropRect: CropRect;
  frameLayout: FrameLayout;
  exif: ExifData;
  /** Sample photos expose the simulated tilt slider; real imports never do. */
  isSample: boolean;
  onResetPhoto: () => void;
  onCopyEdit: () => void;
  onPasteEdit: () => void;
  canPaste: boolean;
  onApplyToAll: () => void;
  straightenActive: boolean;
  onToggleStraighten: () => void;
  presets: Preset[];
  onApplyPreset: (id: string) => void;
  onSavePreset: (name: string) => void;
  onDeletePreset: (id: string) => void;
  onExportJpeg: () => void;
  onBatchExportAll: () => void;
  isExporting: boolean;
  isBatchExporting: boolean;
  queueCount: number;
  isImageLoaded: boolean;
  canSaveToFolder: boolean;
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
const RANGE_CLASS = 'mt-1.5 h-1.5 w-full cursor-pointer rounded-pill bg-paper-3 accent-accent';

function Toggle({
  id,
  label,
  checked,
  onChange,
  quiet = false,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  quiet?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <label
        htmlFor={id}
        className={`text-xs cursor-pointer truncate ${quiet ? 'text-muted' : 'font-medium text-ink'}`}
      >
        {label}
      </label>
      <input
        id={id}
        type="checkbox"
        {...SWITCH_ATTR}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded cursor-pointer shrink-0"
      />
    </div>
  );
}

/** A labelled slider whose visible readout and spoken value come from one formatter. */
function RangeField({
  id,
  label,
  value,
  min,
  max,
  step,
  format,
  spoken,
  onChange,
  testId,
  extra,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  spoken?: (v: number) => string;
  onChange: (v: number) => void;
  testId?: string;
  extra?: React.ReactNode;
}) {
  const shown = format(value);
  return (
    <div>
      <div className="flex items-center justify-between gap-2 text-xs">
        <label htmlFor={id} className="text-muted">
          {label}
        </label>
        <div className="flex items-center gap-2 shrink-0">
          {extra}
          <span className="font-mono text-ink tabular-nums" data-testid={testId}>
            {shown}
          </span>
        </div>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={spoken ? spoken(value) : `${label} ${shown}`}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className={RANGE_CLASS}
      />
    </div>
  );
}

function SectionHead({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h2 className="font-display text-sm font-normal text-ink truncate">{title}</h2>
      {children}
    </div>
  );
}

const degrees = (decimals: number) => (v: number) => formatSignedDegrees(v, decimals);

export const InspectorSidebar: React.FC<InspectorSidebarProps> = ({
  edit,
  onChangeEdit,
  output,
  onChangeOutput,
  analysis,
  autoCorrect,
  cropRect,
  frameLayout,
  exif,
  isSample,
  onResetPhoto,
  onCopyEdit,
  onPasteEdit,
  canPaste,
  onApplyToAll,
  straightenActive,
  onToggleStraighten,
  presets,
  onApplyPreset,
  onSavePreset,
  onDeletePreset,
  onExportJpeg,
  onBatchExportAll,
  isExporting,
  isBatchExporting,
  queueCount,
  isImageLoaded,
  canSaveToFolder,
  className = '',
}) => {
  const [presetName, setPresetName] = useState('');
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const setEdit = <K extends keyof PhotoEdit>(key: K, value: PhotoEdit[K]) =>
    onChangeEdit((prev) => ({ ...prev, [key]: value }));
  const setOutput = <K extends keyof OutputSettings>(key: K, value: OutputSettings[K]) =>
    onChangeOutput((prev) => ({ ...prev, [key]: value }));

  const totalRotationDeg = Number(
    ((edit.autoLevelEnabled ? analysis.appliedRotationDeg : 0) + edit.manualAngleOffsetDeg).toFixed(2)
  );
  const totalKeystoneDeg = Number(
    (
      (edit.keystoneWarpEnabled ? (analysis.appliedKeystoneDeg ?? 0) : 0) + edit.manualKeystoneDeg
    ).toFixed(2)
  );
  const histogram = autoCorrect?.lumaHistogram ?? [];
  const busy = isExporting || isBatchExporting;

  const nudgeAngle = (delta: number) =>
    onChangeEdit((prev) => ({
      ...prev,
      manualAngleOffsetDeg:
        delta === 0 ? 0 : Number(clamp(prev.manualAngleOffsetDeg + delta, -15, 15).toFixed(2)),
    }));

  const savePreset = (e: React.FormEvent) => {
    e.preventDefault();
    const name = presetName.trim();
    if (!name) return;
    onSavePreset(name);
    setPresetName('');
  };

  return (
    <aside
      aria-label="Image inspector"
      className={`flex shrink-0 flex-col border-t lg:border-t-0 lg:border-l border-rule bg-paper-2 text-ink select-none ${className}`}
    >
      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* Histogram */}
        <section className="border-b border-rule px-4 py-3">
          <SectionHead title="Histogram">
            {autoCorrect && (
              <span className="font-mono text-xs text-muted tabular-nums">
                DR {autoCorrect.dynamicRangeStops} EV
              </span>
            )}
          </SectionHead>
          <div className="atelier-stock mt-2 p-2">
            <svg
              viewBox="0 0 256 64"
              className="h-12 w-full text-ink"
              role="img"
              aria-label="Luminance distribution histogram across shadows, midtones, and highlights"
            >
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
          </div>
        </section>

        {/* ── This photo ── */}
        <section className="border-b border-rule px-4 py-3.5" aria-labelledby="this-photo-title">
          <div className="flex items-center justify-between gap-2">
            <h2 id="this-photo-title" className="font-display text-base font-normal text-ink">
              This photo
            </h2>
            <button type="button" onClick={onResetPhoto} className="btn btn--quiet btn--sm shrink-0">
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              Reset
            </button>
          </div>

          <div className="mt-2 grid grid-cols-3 gap-1.5" role="group" aria-label="Photo settings">
            <button type="button" onClick={onCopyEdit} className="btn btn--quiet btn--sm justify-center">
              <ClipboardCopy className="h-3.5 w-3.5" aria-hidden="true" />
              Copy
            </button>
            <button
              type="button"
              onClick={onPasteEdit}
              disabled={!canPaste}
              className="btn btn--quiet btn--sm justify-center"
            >
              <ClipboardPaste className="h-3.5 w-3.5" aria-hidden="true" />
              Paste
            </button>
            <button
              type="button"
              onClick={onApplyToAll}
              disabled={queueCount < 2}
              title="Apply this photo's straighten, crop and tone settings to every photo"
              className="btn btn--quiet btn--sm justify-center"
            >
              <CopyCheck className="h-3.5 w-3.5" aria-hidden="true" />
              To all
            </button>
          </div>

          {/* Straighten */}
          <div className="mt-3.5 space-y-3">
            <h3 className="text-xs font-medium text-ink-2">Straighten</h3>
            <div className="grid grid-cols-3 divide-x divide-rule border-y border-rule py-2 text-xs">
              <div className="min-w-0 pr-2">
                <div className="text-muted truncate">Detected</div>
                <div className="mt-0.5 font-mono text-ink tabular-nums truncate" data-testid="detected-tilt-val">
                  {formatSignedDegrees(analysis.detectedTiltDeg, 2)}
                </div>
              </div>
              <div className="min-w-0 px-2">
                <div className="text-muted truncate">Applied</div>
                <div className="mt-0.5 font-mono text-accent tabular-nums truncate" data-testid="applied-rotation-val">
                  {formatSignedDegrees(totalRotationDeg, 2)}
                </div>
              </div>
              <div className="min-w-0 pl-2">
                <div className="text-muted truncate">Confidence</div>
                <div className="mt-0.5 font-mono text-ink-2 tabular-nums truncate">
                  {Math.round(analysis.confidence * 100)}%
                </div>
              </div>
            </div>

            <Toggle
              id="toggle-auto-level"
              label="Auto-level the horizon"
              checked={edit.autoLevelEnabled}
              onChange={(v) => setEdit('autoLevelEnabled', v)}
            />

            <button
              type="button"
              aria-pressed={straightenActive}
              onClick={onToggleStraighten}
              className={`btn btn--sm w-full justify-center ${straightenActive ? '' : 'btn--quiet'}`}
            >
              <Ruler className="h-3.5 w-3.5" aria-hidden="true" />
              {straightenActive ? 'Drag along a level line, or press Esc' : 'Draw a level line'}
            </button>

            <RangeField
              id="slider-manual-angle"
              label="Fine-tune angle"
              value={edit.manualAngleOffsetDeg}
              min={-15}
              max={15}
              step={0.05}
              format={degrees(2)}
              spoken={(v) => `${formatSignedDegrees(v, 2)} rotation`}
              onChange={(v) => setEdit('manualAngleOffsetDeg', v)}
            />
            <div className="grid grid-cols-5 gap-1" role="group" aria-label="Precision angle nudge">
              {ANGLE_NUDGE_STEPS.map((step) => (
                <button
                  key={step}
                  type="button"
                  onClick={() => nudgeAngle(step)}
                  className="hit-target-expand min-h-[32px] rounded-pill border border-rule bg-paper px-1.5 py-1 text-xs font-mono text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink tabular-nums"
                >
                  {step === 0 ? '0°' : formatSignedDegrees(step, 1)}
                </button>
              ))}
            </div>

            {isSample && (
              <RangeField
                id="slider-sensor-tilt"
                label="Demo tilt (sample photos)"
                value={edit.tiltDeg}
                min={-12}
                max={12}
                step={0.2}
                format={degrees(1)}
                spoken={(v) => `${formatSignedDegrees(v, 1)} simulated tilt`}
                onChange={(v) => setEdit('tiltDeg', v)}
              />
            )}
          </div>

          {/* Crop */}
          <div className="mt-4 space-y-2.5 border-t border-rule pt-3">
            <h3 className="text-xs font-medium text-ink-2">Crop</h3>
            {edit.cropOverride ? (
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="text-muted">Hand crop, set in Crop box view</span>
                <button
                  type="button"
                  onClick={() => setEdit('cropOverride', null)}
                  className="btn btn--quiet btn--sm shrink-0"
                >
                  Back to auto
                </button>
              </div>
            ) : (
              <>
                <Toggle
                  id="toggle-auto-crop"
                  label="Auto-crop the largest clean rectangle"
                  checked={edit.autoCropEnabled}
                  onChange={(v) => setEdit('autoCropEnabled', v)}
                />
                {edit.autoCropEnabled && (
                  <Toggle
                    id="toggle-preserve-crop-aspect"
                    label="Keep source aspect ratio"
                    quiet
                    checked={edit.preserveAspectRatioInCrop}
                    onChange={(v) => setEdit('preserveAspectRatioInCrop', v)}
                  />
                )}
              </>
            )}
            <div className="flex items-center justify-between gap-2 text-xs text-muted">
              <span className="shrink-0">Size</span>
              <span className="font-mono text-ink tabular-nums truncate text-right" data-testid="crop-dimensions-val">
                {cropRect.width} × {cropRect.height} px ({cropRect.areaRetainedPercent}%)
              </span>
            </div>
          </div>

          {/* Tone */}
          <div className="mt-4 space-y-2.5 border-t border-rule pt-3">
            <h3 className="text-xs font-medium text-ink-2">Tone</h3>
            <Toggle
              id="toggle-auto-correct"
              label="Auto-correct tone and white balance"
              checked={edit.autoCorrectEnabled}
              onChange={(v) => setEdit('autoCorrectEnabled', v)}
            />
            {edit.autoCorrectEnabled && (
              <>
                <div
                  className="grid grid-cols-2 divide-x divide-rule border border-rule bg-paper"
                  role="group"
                  aria-label="White balance profile"
                >
                  {(
                    [
                      ['ambient', 'Keep warmth'],
                      ['neutral', 'Neutral'],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      data-testid={`wb-profile-${value}`}
                      aria-pressed={edit.wbProfile === value}
                      onClick={() => setEdit('wbProfile', value)}
                      className={`min-h-[32px] px-2 py-1 text-xs font-medium transition-colors whitespace-nowrap truncate ${
                        edit.wbProfile === value
                          ? 'bg-ink text-paper'
                          : 'bg-paper text-ink-2 hover:bg-paper-3 hover:text-ink'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <RangeField
                  id="slider-auto-correct-strength"
                  label="Strength"
                  value={edit.autoCorrectStrength}
                  min={0}
                  max={100}
                  step={5}
                  format={(v) => `${v}%`}
                  testId="auto-correct-strength-val"
                  onChange={(v) => setEdit('autoCorrectStrength', Math.round(v))}
                />
              </>
            )}
          </div>

          {/* Perspective: the least-used controls stay folded */}
          <details className="atelier-disclosure mt-4 border-t border-rule pt-2">
            <summary className="py-1 text-xs font-medium text-ink-2">
              Perspective
              {totalKeystoneDeg !== 0 || edit.manualKeystoneHDeg !== 0 ? (
                <span className="ml-2 font-mono text-muted tabular-nums">
                  {formatSignedDegrees(totalKeystoneDeg, 1)}, {formatSignedDegrees(edit.manualKeystoneHDeg, 1)}
                </span>
              ) : null}
            </summary>
            <div className="space-y-3 pt-2">
              <Toggle
                id="toggle-keystone-warp"
                label="Auto vertical keystone"
                checked={edit.keystoneWarpEnabled}
                onChange={(v) => setEdit('keystoneWarpEnabled', v)}
              />
              <RangeField
                id="slider-manual-keystone"
                label="Vertical"
                value={edit.manualKeystoneDeg}
                min={-12}
                max={12}
                step={0.1}
                format={() => formatSignedDegrees(totalKeystoneDeg, 2)}
                spoken={() => `${formatSignedDegrees(totalKeystoneDeg, 2)} vertical keystone`}
                testId="keystone-angle-val"
                onChange={(v) => setEdit('manualKeystoneDeg', v)}
              />
              <RangeField
                id="slider-manual-keystone-h"
                label="Horizontal"
                value={edit.manualKeystoneHDeg}
                min={-12}
                max={12}
                step={0.1}
                format={degrees(2)}
                spoken={(v) => `${formatSignedDegrees(v, 2)} horizontal keystone`}
                onChange={(v) => setEdit('manualKeystoneHDeg', v)}
              />
            </div>
          </details>
        </section>

        {/* ── Output, shared by the whole queue ── */}
        <section className="px-4 py-3.5" aria-labelledby="output-title">
          <div className="flex items-baseline justify-between gap-2">
            <h2 id="output-title" className="font-display text-base font-normal text-ink">
              Output
            </h2>
            <span className="text-xs text-muted">All {queueCount} photos</span>
          </div>

          <div className="mt-3 space-y-3.5">
            <div>
              <div className="text-xs text-muted mb-1.5">Aspect ratio</div>
              <div className="grid grid-cols-5 gap-1" role="group" aria-label="Target aspect ratio">
                {ASPECT_PRESETS.map((preset) => {
                  const active = output.aspectPreset === preset.value;
                  return (
                    <button
                      key={preset.value}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setOutput('aspectPreset', preset.value)}
                      className={`min-h-[32px] rounded-pill px-1 py-1.5 text-xs font-medium transition-colors text-center truncate border ${
                        active
                          ? 'bg-ink text-paper border-ink'
                          : 'bg-paper text-ink-2 border-rule hover:border-ink-2 hover:text-ink'
                      }`}
                    >
                      {preset.value === 'original' ? 'Orig.' : preset.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <RangeField
              id="slider-border-padding"
              label="Border width"
              value={output.paddingPercent}
              min={0}
              max={30}
              step={1}
              format={(v) => `${v}%`}
              testId="padding-percent-val"
              onChange={(v) => setOutput('paddingPercent', Math.round(v))}
            />

            <div>
              <div className="text-xs text-muted mb-1.5">Border colour</div>
              <div className="flex flex-wrap items-center gap-2">
                {BACKGROUND_COLOR_PRESETS.map((swatch) => {
                  const isSelected = output.backgroundColor.toLowerCase() === swatch.hex.toLowerCase();
                  return (
                    <button
                      key={swatch.id}
                      type="button"
                      aria-label={`${swatch.label} border`}
                      aria-pressed={isSelected}
                      onClick={() => setOutput('backgroundColor', swatch.hex)}
                      style={{ backgroundColor: swatch.hex }}
                      className={`hit-target-expand h-7 w-7 rounded-pill border transition-transform motion-reduce:transition-none ${
                        isSelected ? 'scale-105 border-accent ring-2 ring-focus' : 'border-rule hover:border-ink-2'
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
                    value={output.backgroundColor}
                    onChange={(e) => setOutput('backgroundColor', e.target.value)}
                    className="h-4 w-4 cursor-pointer border-0 bg-transparent p-0"
                  />
                </label>
              </div>
            </div>

            <Toggle
              id="toggle-exif-caption"
              label="Print EXIF caption on the border"
              checked={output.renderExifCaption}
              onChange={(v) => setOutput('renderExifCaption', v)}
            />

            <details className="atelier-disclosure border-t border-rule pt-2">
              <summary className="py-1 text-xs font-medium text-ink-2">File and metadata</summary>
              <div className="space-y-3 pt-2">
                <Toggle
                  id="toggle-preserve-exif"
                  label="Keep original EXIF in the file"
                  checked={output.preserveExifMetadata}
                  onChange={(v) => setOutput('preserveExifMetadata', v)}
                />
                <RangeField
                  id="slider-jpeg-quality"
                  label="JPEG quality"
                  value={output.jpegQuality}
                  min={70}
                  max={100}
                  step={1}
                  format={(v) => String(v)}
                  testId="jpeg-quality-val"
                  onChange={(v) => setOutput('jpegQuality', Math.round(v))}
                />
                <dl className="divide-y divide-rule border-y border-rule text-xs">
                  {[
                    ['Camera', [exif.cameraModel, exif.rawFormat].filter(Boolean).join(', ')],
                    ['Lens', exif.lensModel],
                    [
                      'Exposure',
                      [exif.focalLength, exif.aperture, exif.shutterSpeed, exif.iso ? `ISO ${exif.iso.replace(/^ISO\s*/i, '')}` : '']
                        .filter(Boolean)
                        .join(', '),
                    ],
                  ]
                    .filter(([, v]) => v)
                    .map(([k, v]) => (
                      <div key={k} className="flex items-center justify-between gap-2 py-1.5">
                        <dt className="text-muted shrink-0">{k}</dt>
                        <dd className="text-ink truncate text-right max-w-[70%]">{v}</dd>
                      </div>
                    ))}
                </dl>
              </div>
            </details>

            {/* Presets: a saved straighten/crop/tone + output combination */}
            <details className="atelier-disclosure border-t border-rule pt-2">
              <summary className="py-1 text-xs font-medium text-ink-2">
                Presets{presets.length > 0 ? ` (${presets.length})` : ''}
              </summary>
              <div className="space-y-2 pt-2">
                {presets.length > 0 && (
                  <div className="flex items-center gap-1.5">
                    <label htmlFor="preset-select" className="visually-hidden">
                      Preset
                    </label>
                    <select
                      id="preset-select"
                      value={selectedPresetId}
                      onChange={(e) => setSelectedPresetId(e.target.value)}
                      className="min-h-[32px] min-w-0 flex-1 rounded-pill border border-muted bg-paper px-2 text-xs text-ink"
                    >
                      <option value="">Choose a preset</option>
                      {presets.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={!selectedPresetId}
                      onClick={() => onApplyPreset(selectedPresetId)}
                      className="btn btn--quiet btn--sm shrink-0"
                    >
                      Apply
                    </button>
                    <button
                      type="button"
                      disabled={!selectedPresetId}
                      onClick={() => {
                        onDeletePreset(selectedPresetId);
                        setSelectedPresetId('');
                      }}
                      aria-label="Delete preset"
                      title="Delete preset"
                      className="icon-btn shrink-0"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                )}
                <form onSubmit={savePreset} className="flex items-center gap-1.5">
                  <label htmlFor="preset-name" className="visually-hidden">
                    New preset name
                  </label>
                  <input
                    id="preset-name"
                    type="text"
                    value={presetName}
                    maxLength={60}
                    onChange={(e) => setPresetName(e.target.value)}
                    placeholder="Name this look"
                    className="min-h-[32px] min-w-0 flex-1 rounded-pill border border-muted bg-paper px-2.5 text-xs text-ink placeholder:text-muted"
                  />
                  <button type="submit" disabled={!presetName.trim()} className="btn btn--quiet btn--sm shrink-0">
                    Save
                  </button>
                </form>
              </div>
            </details>
          </div>
        </section>
      </div>

      {/* Export stays pinned so the primary action is always in view */}
      <div className="inspector-export">
        <p className="mb-2 flex items-baseline justify-between gap-2 text-xs text-muted">
          <span>Output</span>
          <span className="font-mono tabular-nums text-ink-2" data-testid="export-summary">
            {frameLayout.canvasWidth} × {frameLayout.canvasHeight} px, JPEG {output.jpegQuality}
          </span>
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onExportJpeg}
            disabled={busy || !isImageLoaded}
            aria-busy={isExporting}
            className="btn flex-1 min-h-[40px]"
          >
            <Download className="h-4 w-4" aria-hidden="true" />
            {isExporting ? 'Encoding…' : 'Export JPEG'}
          </button>
          <button
            type="button"
            onClick={onBatchExportAll}
            disabled={busy || queueCount === 0}
            aria-busy={isBatchExporting}
            title={
              canSaveToFolder
                ? 'Choose a folder and save every photo in the queue into it'
                : 'Download every photo in the queue'
            }
            className="btn btn--quiet min-h-[40px] shrink-0"
          >
            <Layers className="h-4 w-4" aria-hidden="true" />
            {isBatchExporting ? 'Exporting…' : canSaveToFolder ? `All to folder (${queueCount})` : `Export all (${queueCount})`}
          </button>
        </div>
      </div>
    </aside>
  );
};
