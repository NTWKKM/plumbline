/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useRef, useState } from 'react';
import { Grid, ImagePlus } from 'lucide-react';
import { CanvasViewMode, StudioCanvas } from './components/StudioCanvas';
import { InspectorSidebar } from './components/InspectorSidebar';
import {
  injectApp1ExifIntoJpegBlob,
  parseExifFromArrayBuffer,
} from './utils/exifParser';
import {
  AutoCorrectAnalysis,
  CropRect,
  DEFAULT_AUTO_CORRECT_ANALYSIS,
  DEFAULT_LEVELING_ANALYSIS,
  FrameLayout,
  LevelingAnalysis,
  PipelineConfig,
  PipelineTelemetryUpdate,
  formatSignedDegrees,
} from './utils/geometry';
import { INITIAL_SAMPLE_PHOTOS, StudioPhotoItem } from './utils/samplePhotos';

const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  autoLevelEnabled: true,
  maxAutoAngleDeg: 15.0,
  manualAngleOffsetDeg: 0,
  autoCropEnabled: true,
  preserveAspectRatioInCrop: true,
  autoCorrectEnabled: true,
  autoCorrectStrength: 75,
  aspectPreset: '1:1',
  paddingPercent: 10,
  backgroundColor: '#FFFFFF',
  preserveExifMetadata: true,
  renderExifCaption: true,
  jpegQuality: 95,
};

export default function App() {
  const [photos, setPhotos] = useState<StudioPhotoItem[]>(INITIAL_SAMPLE_PHOTOS);
  const [selectedId, setSelectedId] = useState<string>(INITIAL_SAMPLE_PHOTOS[0].id);
  const [config, setConfig] = useState<PipelineConfig>(DEFAULT_PIPELINE_CONFIG);
  const [viewMode, setViewMode] = useState<CanvasViewMode>('framed');
  const [mobileTab, setMobileTab] = useState<'canvas' | 'adjust' | 'queue'>('canvas');
  const [splitPercent, setSplitPercent] = useState<number>(50);
  const [showHorizonGrid, setShowHorizonGrid] = useState<boolean>(false);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [isImageLoaded, setIsImageLoaded] = useState<boolean>(false);
  const [exportBanner, setExportBanner] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const [analysis, setAnalysis] = useState<LevelingAnalysis>(DEFAULT_LEVELING_ANALYSIS);
  const [autoCorrect, setAutoCorrect] = useState<AutoCorrectAnalysis>(
    DEFAULT_AUTO_CORRECT_ANALYSIS
  );
  const [cropRect, setCropRect] = useState<CropRect>({
    x: 0,
    y: 0,
    width: 1600,
    height: 900,
    scaleFactor: 1,
    areaRetainedPercent: 100,
  });
  const [frameLayout, setFrameLayout] = useState<FrameLayout>({
    canvasWidth: 1800,
    canvasHeight: 1800,
    imageX: 180,
    imageY: 450,
    imageWidth: 1440,
    imageHeight: 900,
    borderTop: 450,
    borderBottom: 450,
    borderLeft: 180,
    borderRight: 180,
  });
  const [sourceSize, setSourceSize] = useState<{ width: number; height: number }>({
    width: 1600,
    height: 900,
  });

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const exportCanvasRef = useRef<(() => HTMLCanvasElement | null) | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const activePhoto = photos.find((p) => p.id === selectedId) || photos[0];

  const handleAnalysisUpdate = useCallback((telemetry: PipelineTelemetryUpdate) => {
    setAnalysis(telemetry.analysis);
    setCropRect(telemetry.crop);
    setFrameLayout(telemetry.layout);
    setSourceSize(telemetry.sourceSize);
    setAutoCorrect(telemetry.autoCorrect);
  }, []);

  const handleChangeSimulatedTilt = (deg: number) => {
    setPhotos((prev) =>
      prev.map((item) =>
        item.id === activePhoto.id ? { ...item, simulatedSensorTiltDeg: deg } : item
      )
    );
  };

  const handleResetAll = () => {
    setConfig(DEFAULT_PIPELINE_CONFIG);
    setSplitPercent(50);
    handleChangeSimulatedTilt(0);
  };

  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const buffer = await file.arrayBuffer();
    const parsed = parseExifFromArrayBuffer(buffer, file.name);
    const objectUrl = URL.createObjectURL(file);

    const uniqueSuffix =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const newItem: StudioPhotoItem = {
      id: `imported-${Date.now()}-${uniqueSuffix}`,
      title: file.name.replace(/\.[^.]+$/, ''),
      fileName: file.name,
      src: objectUrl,
      isRaw: parsed.isRawContainer,
      simulatedSensorTiltDeg: 0,
      exif: parsed.exif,
      rawApp1Segment: parsed.rawApp1Segment,
    };

    setPhotos((prev) => [newItem, ...prev]);
    setSelectedId(newItem.id);
    e.target.value = '';
  };

  const handleExportJpeg = async () => {
    setIsExporting(true);
    setExportBanner(null);
    setExportError(null);

    try {
      const canvas = exportCanvasRef.current ? exportCanvasRef.current() : canvasRef.current;
      if (!canvas) {
        setExportError('Canvas is not ready for export.');
        return;
      }

      const quality = Math.max(0.7, Math.min(1.0, config.jpegQuality / 100));
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), 'image/jpeg', quality)
      );

      if (!blob) {
        setExportError('Failed to encode canvas to JPEG format.');
        return;
      }

      let finalBlob = blob;
      let exifPreserved = false;

      if (config.preserveExifMetadata) {
        const injectResult = await injectApp1ExifIntoJpegBlob(
          blob,
          activePhoto.rawApp1Segment,
          {
            width: canvas.width,
            height: canvas.height,
            sourceWidth: sourceSize.width,
            sourceHeight: sourceSize.height,
          }
        );
        finalBlob = injectResult.blob;
        exifPreserved = injectResult.exifPreserved;
      }

      const url = URL.createObjectURL(finalBlob);
      const a = document.createElement('a');
      const baseName = activePhoto.fileName.replace(/\.[^.]+$/, '');
      const outName = `${baseName}_whiteborder_${config.aspectPreset.replace(':', 'x')}.jpg`;
      a.href = url;
      a.download = outName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setExportBanner(
        `Exported ${outName} (${canvas.width} × ${canvas.height} px · ${
          exifPreserved ? 'EXIF Preserved' : 'EXIF Stripped'
        })`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setExportBanner(`Export failed. ${msg}`);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="flex h-[100dvh] overflow-hidden flex-col bg-[#09090b] text-zinc-100">
      <input
        ref={fileInputRef}
        type="file"
        accept=".jpg,.jpeg,.png,.webp"
        onChange={handleFileImport}
        className="hidden"
        aria-label="Upload photo"
      />

      {/* 3-Zone Minimal Header */}
      <header className="flex h-11 sm:h-12 items-center justify-between gap-2 sm:gap-6 border-b border-zinc-800/80 bg-[#0d0d10] px-3 sm:px-6 shrink-0">
        {/* Zone 1: Single Clean Brand Wordmark */}
        <a
          href="#workspace"
          onClick={(e) => {
            e.preventDefault();
            setViewMode('framed');
            setMobileTab('canvas');
          }}
          className="font-display text-sm sm:text-base font-semibold tracking-tight text-zinc-100 whitespace-nowrap shrink-0"
        >
          Plumb Line
        </a>

        {/* Zone 2: Active Photo Telemetry (Desktop) / Section Switcher Tabs (Mobile < 1024px) */}
        <div className="hidden lg:flex items-center gap-2 text-xs text-zinc-400 min-w-0 overflow-hidden">
          <span className="font-medium text-zinc-200 truncate">{activePhoto.title}</span>
          <span aria-hidden="true" className="text-zinc-600 shrink-0">·</span>
          <span className="font-mono text-zinc-400 tabular-nums whitespace-nowrap shrink-0">
            {sourceSize.width} × {sourceSize.height} px
          </span>
        </div>

        {/* Mobile View Switcher Tabs */}
        <div className="flex lg:hidden items-center rounded-md bg-zinc-900 p-0.5 border border-zinc-800/80 text-[11px] sm:text-xs shrink-0">
          <button
            type="button"
            onClick={() => setMobileTab('canvas')}
            className={`rounded px-2 py-0.5 sm:px-2.5 sm:py-1 font-medium transition-colors whitespace-nowrap shrink-0 ${
              mobileTab === 'canvas' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Canvas
          </button>
          <button
            type="button"
            onClick={() => setMobileTab('adjust')}
            className={`rounded px-2 py-0.5 sm:px-2.5 sm:py-1 font-medium transition-colors whitespace-nowrap shrink-0 ${
              mobileTab === 'adjust' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Adjust
          </button>
          <button
            type="button"
            onClick={() => setMobileTab('queue')}
            className={`rounded px-2 py-0.5 sm:px-2.5 sm:py-1 font-medium transition-colors whitespace-nowrap shrink-0 ${
              mobileTab === 'queue' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Photos
          </button>
        </div>

        {/* Zone 3: Primary Action */}
        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1.5 rounded-md bg-zinc-100 hover:bg-white text-zinc-950 px-2.5 py-1 sm:px-3 sm:py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0"
          >
            <ImagePlus className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Import Photo</span>
            <span className="sm:hidden">Import</span>
          </button>
        </div>
      </header>

      {/* Main Studio Workspace */}
      <main className="flex flex-1 flex-col lg:flex-row overflow-hidden min-h-0">
        {/* Left Photo Queue */}
        <aside
          aria-label="Photo Queue"
          className={`w-full lg:w-[224px] shrink-0 flex-col border-b lg:border-b-0 lg:border-r border-zinc-800/80 bg-[#0d0d10] ${
            mobileTab === 'queue' ? 'flex flex-1 overflow-y-auto' : 'hidden lg:flex'
          }`}
        >
          <div className="flex items-center justify-between border-b border-zinc-800/70 px-4 py-3 shrink-0">
            <span className="font-display text-xs font-semibold text-zinc-300 truncate">
              Photos ({photos.length})
            </span>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="text-xs font-medium text-zinc-400 hover:text-zinc-100 transition-colors whitespace-nowrap shrink-0"
            >
              + Add
            </button>
          </div>

          <div className="flex lg:flex-col gap-2 overflow-x-auto lg:overflow-y-auto p-3 flex-1 min-h-0">
            {photos.map((item) => {
              const isSelected = item.id === activePhoto.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(item.id);
                    if (mobileTab === 'queue') setMobileTab('canvas');
                  }}
                  className={`group flex w-48 lg:w-full shrink-0 flex-col rounded-md border p-2 text-left transition-colors min-w-0 ${
                    isSelected
                      ? 'border-zinc-500 bg-zinc-900 text-white'
                      : 'border-zinc-800/60 bg-zinc-950/40 hover:border-zinc-700'
                  }`}
                >
                  <div className="relative h-24 w-full overflow-hidden rounded-sm bg-zinc-950">
                    <img
                      src={item.src}
                      alt={item.title}
                      referrerPolicy="no-referrer"
                      className="h-full w-full object-cover transition-transform duration-150 group-hover:scale-[1.02]"
                    />
                  </div>
                  <div className="mt-2 min-w-0 w-full">
                    <div className="truncate text-xs font-medium text-zinc-100">
                      {item.title}
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-1 text-[11px] font-mono text-zinc-500 tabular-nums">
                      <span className="truncate min-w-0">{item.fileName}</span>
                      <span className="shrink-0">
                        {formatSignedDegrees(item.simulatedSensorTiltDeg, 1)}
                      </span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        {/* Center Interactive Viewport */}
        <section
          aria-label="Canvas Workspace"
          className={`flex flex-1 min-w-0 min-h-0 flex-col bg-[#09090b] ${
            mobileTab === 'canvas' ? 'flex' : 'hidden lg:flex'
          }`}
        >
          {/* Minimal Secondary Toolbar */}
          <div className="flex items-center justify-between gap-2 border-b border-zinc-800/80 bg-[#0d0d10]/80 px-3 sm:px-5 py-2 min-w-0 shrink-0">
            <div
              className="flex items-center gap-0.5 rounded-md bg-zinc-900 p-0.5 border border-zinc-800/80 min-w-0"
              role="group"
              aria-label="Canvas View Mode"
            >
              <button
                type="button"
                onClick={() => setViewMode('framed')}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  viewMode === 'framed'
                    ? 'bg-zinc-800 text-white'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Framed
              </button>
              <button
                type="button"
                onClick={() => setViewMode('split')}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  viewMode === 'split'
                    ? 'bg-zinc-800 text-white'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Split
              </button>
              <button
                type="button"
                onClick={() => setViewMode('geometry')}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  viewMode === 'geometry'
                    ? 'bg-zinc-800 text-white'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Crop
              </button>
              <button
                type="button"
                onClick={() => setViewMode('original')}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  viewMode === 'original'
                    ? 'bg-zinc-800 text-white'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Original
              </button>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {viewMode === 'split' && (
                <div className="hidden sm:flex items-center gap-2 rounded-md border border-zinc-800/80 bg-zinc-900 px-2.5 py-1 shrink-0">
                  <label
                    htmlFor="slider-split-position"
                    className="text-xs text-zinc-400 whitespace-nowrap shrink-0"
                  >
                    Split
                  </label>
                  <input
                    id="slider-split-position"
                    type="range"
                    aria-label="Before/After Split Position"
                    min={5}
                    max={95}
                    step={1}
                    value={splitPercent}
                    onChange={(e) => setSplitPercent(parseFloat(e.target.value))}
                    className="h-1 w-16 cursor-pointer appearance-none rounded-lg bg-zinc-700 accent-zinc-200"
                  />
                  <span
                    className="font-mono text-xs text-zinc-200 tabular-nums whitespace-nowrap shrink-0"
                    data-testid="split-percent-val"
                  >
                    {Math.round(splitPercent)}%
                  </span>
                </div>
              )}

              <button
                type="button"
                onClick={() => setShowHorizonGrid((prev) => !prev)}
                className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  showHorizonGrid
                    ? 'border-zinc-500 bg-zinc-800 text-white'
                    : 'border-zinc-800/80 bg-zinc-900 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
                }`}
              >
                <Grid className="h-3.5 w-3.5" />
                <span>Grid</span>
              </button>
            </div>
          </div>

          {/* Export Error Alert Banner */}
          {exportError && (
            <div className="flex items-center justify-between border-b border-rose-900/60 bg-rose-950/40 px-4 py-2 text-xs text-rose-300 shrink-0">
              <span className="truncate">Export error: {exportError}</span>
              <button
                type="button"
                onClick={() => setExportError(null)}
                className="text-rose-400 hover:text-rose-200 shrink-0 ml-2 whitespace-nowrap"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Export Confirmation Toast Banner */}
          {exportBanner && (
            <div
              className={`flex items-center justify-between border-b px-4 py-2 text-xs shrink-0 ${
                exportBanner.startsWith('Export failed.')
                  ? 'border-amber-900/60 bg-amber-950/40 text-amber-300'
                  : 'border-emerald-900/60 bg-emerald-950/40 text-emerald-300'
              }`}
            >
              <span className="truncate">{exportBanner}</span>
              <button
                type="button"
                onClick={() => setExportBanner(null)}
                className={`shrink-0 ml-2 whitespace-nowrap ${
                  exportBanner.startsWith('Export failed.')
                    ? 'text-amber-400 hover:text-amber-200'
                    : 'text-emerald-400 hover:text-emerald-200'
                }`}
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Canvas Stage */}
          <div className="flex-1 min-h-0 flex items-center justify-center overflow-hidden p-3 sm:p-6">
            <StudioCanvas
              key={activePhoto.id}
              photo={activePhoto}
              config={config}
              viewMode={viewMode}
              splitPercent={splitPercent}
              onSplitPercentChange={setSplitPercent}
              showHorizonGrid={showHorizonGrid}
              onAnalysisUpdate={handleAnalysisUpdate}
              canvasRef={canvasRef}
              onImageLoaded={setIsImageLoaded}
              exportCanvasRef={exportCanvasRef}
            />
          </div>

          {/* Minimal Single-Row Unboxed Metadata Footer */}
          <footer className="flex h-9 items-center justify-between gap-4 border-t border-zinc-800/80 bg-[#0d0d10] px-4 sm:px-6 text-[11px] text-zinc-400 tabular-nums shrink-0 overflow-hidden">
            <div className="flex items-center gap-2 min-w-0 overflow-hidden">
              <span className="font-mono text-zinc-200 truncate">{activePhoto.fileName}</span>
              {activePhoto.exif.cameraModel && (
                <>
                  <span aria-hidden="true" className="text-zinc-600 shrink-0">·</span>
                  <span className="truncate text-zinc-400">{activePhoto.exif.cameraModel}</span>
                </>
              )}
              {activePhoto.exif.lensModel && (
                <>
                  <span aria-hidden="true" className="text-zinc-600 hidden md:inline shrink-0">·</span>
                  <span className="truncate hidden md:inline text-zinc-500">
                    {activePhoto.exif.lensModel}
                  </span>
                </>
              )}
            </div>
            <div className="flex items-center gap-2 font-mono text-zinc-400 shrink-0 whitespace-nowrap">
              <span>Tilt {formatSignedDegrees(analysis.detectedTiltDeg, 2)}</span>
              <span aria-hidden="true" className="text-zinc-600 hidden sm:inline">·</span>
              <span className="hidden sm:inline">
                Crop {cropRect.width}×{cropRect.height} ({cropRect.areaRetainedPercent}%)
              </span>
              <span aria-hidden="true" className="text-zinc-600 hidden xl:inline">·</span>
              <span className="hidden xl:inline">
                Frame {frameLayout.canvasWidth}×{frameLayout.canvasHeight} ({config.aspectPreset})
              </span>
            </div>
          </footer>
        </section>

        {/* Right Inspector Sidebar */}
        <InspectorSidebar
          config={config}
          onChangeConfig={setConfig}
          analysis={analysis}
          autoCorrect={autoCorrect}
          cropRect={cropRect}
          frameLayout={frameLayout}
          sourceSize={sourceSize}
          exif={activePhoto.exif}
          simulatedTiltDeg={activePhoto.simulatedSensorTiltDeg}
          onChangeSimulatedTilt={handleChangeSimulatedTilt}
          onResetAll={handleResetAll}
          onExportJpeg={handleExportJpeg}
          isExporting={isExporting}
          isImageLoaded={isImageLoaded}
          className={`w-full lg:w-[320px] shrink-0 border-t lg:border-t-0 lg:border-l border-zinc-800/80 bg-[#0d0d10] ${
            mobileTab === 'adjust' ? 'flex flex-1 overflow-y-auto' : 'hidden lg:flex'
          }`}
        />
      </main>
    </div>
  );
}
