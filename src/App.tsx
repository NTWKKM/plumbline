/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Grid, ImagePlus, ZoomIn, ZoomOut } from 'lucide-react';
import {
  CanvasViewMode,
  StudioCanvas,
  renderPhotoToFramedCanvas,
} from './components/StudioCanvas';
import { InspectorSidebar } from './components/InspectorSidebar';
import {
  SUPPORTED_IMAGE_ACCEPT,
  extractEmbeddedJpegCandidatesFromRawBuffer,
  injectApp1ExifIntoJpegBlob,
  isSupportedImageOrRawFileName,
  parseExifFromArrayBuffer,
  verifyDecodableImageBlob,
} from './utils/exifParser';
import {
  AspectRatioPreset,
  AutoCorrectAnalysis,
  CropRect,
  DEFAULT_AUTO_CORRECT_ANALYSIS,
  DEFAULT_LEVELING_ANALYSIS,
  FrameLayout,
  LevelingAnalysis,
  PipelineConfig,
  PipelineTelemetryUpdate,
  clamp,
  formatSignedDegrees,
} from './utils/geometry';
import { INITIAL_SAMPLE_PHOTOS, StudioPhotoItem } from './utils/samplePhotos';

const CONFIG_STORAGE_KEY = 'plumbline.pipelineConfig.v1';
const VIEW_STORAGE_KEY = 'plumbline.viewState.v1';
const VALID_ASPECT_PRESETS: AspectRatioPreset[] = ['1:1', '4:5', '16:9', '3:2', 'original'];
const VALID_VIEW_MODES: CanvasViewMode[] = ['framed', 'split', 'geometry', 'original'];

const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  autoLevelEnabled: true,
  maxAutoAngleDeg: 15.0,
  manualAngleOffsetDeg: 0,
  keystoneWarpEnabled: true,
  manualKeystoneDeg: 0,
  autoCropEnabled: true,
  preserveAspectRatioInCrop: true,
  autoCorrectEnabled: true,
  autoCorrectStrength: 75,
  wbProfile: 'ambient',
  aspectPreset: '1:1',
  paddingPercent: 10,
  backgroundColor: '#FFFFFF',
  preserveExifMetadata: true,
  renderExifCaption: true,
  jpegQuality: 95,
};

function loadPersistedConfig(): PipelineConfig {
  try {
    const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
    if (!raw) return DEFAULT_PIPELINE_CONFIG;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return DEFAULT_PIPELINE_CONFIG;
    const obj = parsed as Record<string, unknown>;
    return {
      autoLevelEnabled:
        typeof obj.autoLevelEnabled === 'boolean'
          ? obj.autoLevelEnabled
          : DEFAULT_PIPELINE_CONFIG.autoLevelEnabled,
      maxAutoAngleDeg:
        typeof obj.maxAutoAngleDeg === 'number' && Number.isFinite(obj.maxAutoAngleDeg)
          ? clamp(obj.maxAutoAngleDeg, 1, 15)
          : DEFAULT_PIPELINE_CONFIG.maxAutoAngleDeg,
      manualAngleOffsetDeg:
        typeof obj.manualAngleOffsetDeg === 'number' && Number.isFinite(obj.manualAngleOffsetDeg)
          ? clamp(obj.manualAngleOffsetDeg, -15, 15)
          : DEFAULT_PIPELINE_CONFIG.manualAngleOffsetDeg,
      keystoneWarpEnabled:
        typeof obj.keystoneWarpEnabled === 'boolean'
          ? obj.keystoneWarpEnabled
          : DEFAULT_PIPELINE_CONFIG.keystoneWarpEnabled,
      manualKeystoneDeg:
        typeof obj.manualKeystoneDeg === 'number' && Number.isFinite(obj.manualKeystoneDeg)
          ? clamp(obj.manualKeystoneDeg, -12, 12)
          : DEFAULT_PIPELINE_CONFIG.manualKeystoneDeg,
      autoCropEnabled:
        typeof obj.autoCropEnabled === 'boolean'
          ? obj.autoCropEnabled
          : DEFAULT_PIPELINE_CONFIG.autoCropEnabled,
      preserveAspectRatioInCrop:
        typeof obj.preserveAspectRatioInCrop === 'boolean'
          ? obj.preserveAspectRatioInCrop
          : DEFAULT_PIPELINE_CONFIG.preserveAspectRatioInCrop,
      autoCorrectEnabled:
        typeof obj.autoCorrectEnabled === 'boolean'
          ? obj.autoCorrectEnabled
          : DEFAULT_PIPELINE_CONFIG.autoCorrectEnabled,
      autoCorrectStrength:
        typeof obj.autoCorrectStrength === 'number' && Number.isFinite(obj.autoCorrectStrength)
          ? clamp(Math.round(obj.autoCorrectStrength), 0, 100)
          : DEFAULT_PIPELINE_CONFIG.autoCorrectStrength,
      wbProfile:
        obj.wbProfile === 'ambient' || obj.wbProfile === 'neutral'
          ? obj.wbProfile
          : DEFAULT_PIPELINE_CONFIG.wbProfile,
      aspectPreset:
        typeof obj.aspectPreset === 'string' &&
        VALID_ASPECT_PRESETS.includes(obj.aspectPreset as AspectRatioPreset)
          ? (obj.aspectPreset as AspectRatioPreset)
          : DEFAULT_PIPELINE_CONFIG.aspectPreset,
      paddingPercent:
        typeof obj.paddingPercent === 'number' && Number.isFinite(obj.paddingPercent)
          ? clamp(Math.round(obj.paddingPercent), 0, 30)
          : DEFAULT_PIPELINE_CONFIG.paddingPercent,
      backgroundColor:
        typeof obj.backgroundColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(obj.backgroundColor)
          ? obj.backgroundColor
          : DEFAULT_PIPELINE_CONFIG.backgroundColor,
      preserveExifMetadata:
        typeof obj.preserveExifMetadata === 'boolean'
          ? obj.preserveExifMetadata
          : DEFAULT_PIPELINE_CONFIG.preserveExifMetadata,
      renderExifCaption:
        typeof obj.renderExifCaption === 'boolean'
          ? obj.renderExifCaption
          : DEFAULT_PIPELINE_CONFIG.renderExifCaption,
      jpegQuality:
        typeof obj.jpegQuality === 'number' && Number.isFinite(obj.jpegQuality)
          ? clamp(Math.round(obj.jpegQuality), 70, 100)
          : DEFAULT_PIPELINE_CONFIG.jpegQuality,
    };
  } catch {
    return DEFAULT_PIPELINE_CONFIG;
  }
}

function loadPersistedViewState(): {
  viewMode: CanvasViewMode;
  showHorizonGrid: boolean;
  tiltOverrides: Record<string, number>;
} {
  const fallback = {
    viewMode: 'framed' as CanvasViewMode,
    showHorizonGrid: false,
    tiltOverrides: {} as Record<string, number>,
  };
  try {
    const raw = localStorage.getItem(VIEW_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return fallback;
    const obj = parsed as Record<string, unknown>;
    const tiltOverrides: Record<string, number> = {};
    if (obj.tiltOverrides && typeof obj.tiltOverrides === 'object') {
      for (const [k, v] of Object.entries(obj.tiltOverrides as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v)) {
          tiltOverrides[k] = clamp(v, -12, 12);
        }
      }
    }
    return {
      viewMode:
        typeof obj.viewMode === 'string' &&
        VALID_VIEW_MODES.includes(obj.viewMode as CanvasViewMode)
          ? (obj.viewMode as CanvasViewMode)
          : fallback.viewMode,
      showHorizonGrid:
        typeof obj.showHorizonGrid === 'boolean' ? obj.showHorizonGrid : fallback.showHorizonGrid,
      tiltOverrides,
    };
  } catch {
    return fallback;
  }
}

function getInitialPhotos(tiltOverrides: Record<string, number>): StudioPhotoItem[] {
  return INITIAL_SAMPLE_PHOTOS.map((item) =>
    typeof tiltOverrides[item.id] === 'number'
      ? { ...item, simulatedSensorTiltDeg: tiltOverrides[item.id] }
      : item
  );
}

export default function App() {
  const initialView = useRef(loadPersistedViewState()).current;
  const [photos, setPhotos] = useState<StudioPhotoItem[]>(() =>
    getInitialPhotos(initialView.tiltOverrides)
  );
  const [selectedId, setSelectedId] = useState<string>(INITIAL_SAMPLE_PHOTOS[0].id);
  const [config, setConfig] = useState<PipelineConfig>(() => loadPersistedConfig());
  const [viewMode, setViewMode] = useState<CanvasViewMode>(initialView.viewMode);
  const [mobileTab, setMobileTab] = useState<'canvas' | 'adjust' | 'queue'>('canvas');
  const [splitPercent, setSplitPercent] = useState<number>(50);
  const [showHorizonGrid, setShowHorizonGrid] = useState<boolean>(initialView.showHorizonGrid);
  const [zoomLevel, setZoomLevel] = useState<number>(1);
  const [panOffset, setPanOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDraggingFiles, setIsDraggingFiles] = useState<boolean>(false);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [isBatchExporting, setIsBatchExporting] = useState<boolean>(false);
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
  const dragDepthRef = useRef<number>(0);

  const activePhoto = photos.find((p) => p.id === selectedId) || photos[0];

  // Persist pipeline config and workspace preferences locally
  useEffect(() => {
    try {
      localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
    } catch {
      // Ignore quota or storage restriction errors
    }
  }, [config]);

  useEffect(() => {
    try {
      const tiltOverrides: Record<string, number> = {};
      for (const item of photos) {
        if (!item.id.startsWith('imported-')) {
          tiltOverrides[item.id] = item.simulatedSensorTiltDeg;
        }
      }
      localStorage.setItem(
        VIEW_STORAGE_KEY,
        JSON.stringify({ viewMode, showHorizonGrid, tiltOverrides })
      );
    } catch {
      // Ignore quota or storage restriction errors
    }
  }, [viewMode, showHorizonGrid, photos]);

  // Reset pan offset when switching photos or returning zoom to 1x
  useEffect(() => {
    setPanOffset({ x: 0, y: 0 });
  }, [selectedId]);

  const handleZoomChange = useCallback((nextZoom: number) => {
    const clamped = clamp(Number(nextZoom.toFixed(2)), 1, 4);
    setZoomLevel(clamped);
    if (clamped <= 1) {
      setPanOffset({ x: 0, y: 0 });
    }
  }, []);

  const handleAnalysisUpdate = useCallback((telemetry: PipelineTelemetryUpdate) => {
    setAnalysis(telemetry.analysis);
    setCropRect(telemetry.crop);
    setFrameLayout(telemetry.layout);
    setSourceSize(telemetry.sourceSize);
    setAutoCorrect(telemetry.autoCorrect);
  }, []);

  const handleChangeSimulatedTilt = useCallback(
    (deg: number) => {
      setPhotos((prev) =>
        prev.map((item) =>
          item.id === activePhoto.id ? { ...item, simulatedSensorTiltDeg: deg } : item
        )
      );
    },
    [activePhoto.id]
  );

  const handleResetAll = useCallback(() => {
    setConfig(DEFAULT_PIPELINE_CONFIG);
    setSplitPercent(50);
    setZoomLevel(1);
    setPanOffset({ x: 0, y: 0 });
    handleChangeSimulatedTilt(0);
  }, [handleChangeSimulatedTilt]);

  const importFiles = useCallback(async (files: File[]) => {
    const imageFiles = files.filter((file) =>
      isSupportedImageOrRawFileName(file.name) ||
      file.type.startsWith('image/')
    );
    if (imageFiles.length === 0) return;

    const importedItems: StudioPhotoItem[] = [];
    const failedFiles: string[] = [];

    for (const file of imageFiles) {
      let objectUrl: string | null = null;
      try {
        const buffer = await file.arrayBuffer();
        const parsed = parseExifFromArrayBuffer(buffer, file.name);

        let displayBlob: Blob | null = null;
        if (parsed.isRawContainer) {
          const candidates = extractEmbeddedJpegCandidatesFromRawBuffer(buffer);
          for (const candidate of candidates) {
            if (await verifyDecodableImageBlob(candidate)) {
              displayBlob = candidate;
              break;
            }
          }
          if (!displayBlob) {
            failedFiles.push(`${file.name} (no decodable embedded JPEG preview found in RAW file)`);
            continue;
          }
        } else {
          if (!(await verifyDecodableImageBlob(file))) {
            failedFiles.push(`${file.name} (unsupported or corrupt image data)`);
            continue;
          }
          displayBlob = file;
        }

        objectUrl = URL.createObjectURL(displayBlob);

        const uniqueSuffix =
          typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

        importedItems.push({
          id: `imported-${Date.now()}-${uniqueSuffix}`,
          title: file.name.replace(/\.[^.]+$/, ''),
          fileName: file.name,
          src: objectUrl,
          isRaw: parsed.isRawContainer,
          simulatedSensorTiltDeg: 0,
          exif: parsed.exif,
          rawApp1Segment: parsed.isRawContainer ? null : parsed.rawApp1Segment,
        });
      } catch (err) {
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl);
        }
        const reason = err instanceof Error ? err.message : 'unreadable file';
        failedFiles.push(`${file.name} (${reason})`);
      }
    }

    if (importedItems.length > 0) {
      setPhotos((prev) => [...importedItems, ...prev]);
      setSelectedId(importedItems[0].id);
      setMobileTab('canvas');
    }

    if (failedFiles.length > 0) {
      setExportError(`Unable to import ${failedFiles.join('; ')}`);
    } else if (importedItems.length > 0) {
      setExportError(null);
    }
  }, []);

  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    await importFiles(files);
    e.target.value = '';
  };

  // Global keyboard shortcuts for studio navigation and inspection
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      if (e.key === ' ' && target && (target.tagName === 'BUTTON' || target.tagName === 'SUMMARY' || target.tagName === 'A')) {
        return;
      }

      if (e.key === 'g' || e.key === 'G') {
        e.preventDefault();
        setShowHorizonGrid((prev) => !prev);
      } else if (e.key === 'b' || e.key === 'B' || e.key === ' ') {
        e.preventDefault();
        setViewMode((prev) => (prev === 'split' ? 'framed' : 'split'));
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        handleResetAll();
      } else if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        handleZoomChange(zoomLevel + 0.25);
      } else if (e.key === '-') {
        e.preventDefault();
        handleZoomChange(zoomLevel - 0.25);
      } else if (e.key === '0') {
        e.preventDefault();
        handleZoomChange(1);
      } else if (e.key === '[' || e.key === 'ArrowUp') {
        e.preventDefault();
        const idx = photos.findIndex((p) => p.id === activePhoto.id);
        if (idx > 0) setSelectedId(photos[idx - 1].id);
      } else if (e.key === ']' || e.key === 'ArrowDown') {
        e.preventDefault();
        const idx = photos.findIndex((p) => p.id === activePhoto.id);
        if (idx >= 0 && idx < photos.length - 1) setSelectedId(photos[idx + 1].id);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activePhoto.id, handleResetAll, handleZoomChange, photos, zoomLevel]);

  const encodeAndDownloadFramedCanvas = async (
    canvas: HTMLCanvasElement,
    photoItem: StudioPhotoItem,
    photoSourceSize: { width: number; height: number }
  ): Promise<{ outName: string; exifPreserved: boolean }> => {
    const quality = Math.max(0.7, Math.min(1.0, config.jpegQuality / 100));
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', quality)
    );

    if (!blob) {
      throw new Error('Failed to encode canvas to JPEG format.');
    }

    let finalBlob = blob;
    let exifPreserved = false;

    if (config.preserveExifMetadata) {
      const injectResult = await injectApp1ExifIntoJpegBlob(
        blob,
        photoItem.rawApp1Segment,
        {
          width: canvas.width,
          height: canvas.height,
          sourceWidth: photoSourceSize.width,
          sourceHeight: photoSourceSize.height,
        }
      );
      finalBlob = injectResult.blob;
      exifPreserved = injectResult.exifPreserved;
    }

    const url = URL.createObjectURL(finalBlob);
    const a = document.createElement('a');
    const baseName = photoItem.fileName.replace(/\.[^.]+$/, '');
    const outName = `${baseName}_whiteborder_${config.aspectPreset.replace(':', 'x')}.jpg`;
    a.href = url;
    a.download = outName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    return { outName, exifPreserved };
  };

  const handleExportJpeg = async () => {
    setIsExporting(true);
    setExportBanner(null);
    setExportError(null);

    try {
      const canvas = exportCanvasRef.current ? exportCanvasRef.current() : canvasRef.current;
      if (!canvas) {
        setExportError('Darkroom canvas is not ready for export.');
        return;
      }

      const { outName, exifPreserved } = await encodeAndDownloadFramedCanvas(
        canvas,
        activePhoto,
        sourceSize
      );

      setExportBanner(
        `Exported ${outName} (${canvas.width} × ${canvas.height} px, ${
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

  const handleBatchExportAll = async () => {
    if (photos.length === 0) return;
    setIsBatchExporting(true);
    setExportBanner(null);
    setExportError(null);

    let exportedCount = 0;
    try {
      for (let i = 0; i < photos.length; i++) {
        const item = photos[i];
        setExportBanner(`Batch exporting ${i + 1} of ${photos.length}: ${item.title}…`);
        const { canvas, sourceSize: itemSourceSize } = await renderPhotoToFramedCanvas(item, config);
        await encodeAndDownloadFramedCanvas(canvas, item, itemSourceSize);
        exportedCount += 1;
      }
      setExportBanner(
        `Triggered ${exportedCount} framed JPEG download ${exportedCount === 1 ? 'request' : 'requests'} (${config.aspectPreset}). Your browser may prompt for or block additional downloads.`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setExportBanner(null);
      setExportError(`Batch export stopped after ${exportedCount} of ${photos.length}: ${msg}`);
    } finally {
      setIsBatchExporting(false);
    }
  };

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepthRef.current += 1;
    if (e.dataTransfer.types.includes('Files')) {
      setIsDraggingFiles(true);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDraggingFiles(false);
    }
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepthRef.current = 0;
    setIsDraggingFiles(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    await importFiles(files);
  };

  return (
    <div
      className="relative flex h-[100dvh] overflow-hidden flex-col bg-paper text-ink"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <a className="skip" href="#workspace">
        Skip to workspace
      </a>

      {/* Hidden File Input for Supported Image Formats */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={SUPPORTED_IMAGE_ACCEPT}
        onChange={handleFileImport}
        className="hidden"
        aria-label="Upload photo"
      />

      {/* Drag-and-Drop Overlay Indicator */}
      {isDraggingFiles && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed inset-0 z-modal flex items-center justify-center bg-paper/85 p-6"
        >
          <div className="atelier-stock max-w-md px-8 py-6 text-center">
            <p className="font-display text-lg text-ink">
              Drop photos to add to the studio queue
            </p>
            <p className="mt-1 text-sm text-muted">
              Supports JPEG, PNG, WebP, and RAW containers with local EXIF parsing.
            </p>
          </div>
        </div>
      )}

      {/* 3-Zone Responsive Header */}
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 sm:gap-6 border-b border-rule bg-paper-2 px-3 sm:px-6 py-2 sm:py-3 shrink-0">
        {/* Zone 1: Wordmark & Studio label */}
        <div className="flex items-center gap-2.5 shrink-0">
          <h1 className="font-display text-base sm:text-xl font-normal tracking-tight text-ink leading-none">
            <a
              href="#workspace"
              onClick={(e) => {
                e.preventDefault();
                setViewMode('framed');
                setMobileTab('canvas');
              }}
              className="whitespace-nowrap no-underline hover:text-accent transition-colors"
            >
              Plumb_Line
            </a>
          </h1>
          <span className="hidden sm:inline-block rounded-pill px-2 py-0.5 text-xs font-medium text-muted border border-rule bg-paper">
            Darkroom
          </span>
        </div>

        {/* Zone 2: Active Photo Telemetry (Desktop) / Section Switcher Tabs (Mobile < 1024px) */}
        <div className="hidden lg:flex items-center gap-3 text-xs text-muted min-w-0">
          <span className="font-medium text-ink truncate max-w-xs">{activePhoto.title}</span>
          <span className="border-l border-rule pl-3 font-mono tabular-nums whitespace-nowrap">
            {sourceSize.width} × {sourceSize.height} px
          </span>
          <span className="border-l border-rule pl-3 whitespace-nowrap text-muted">
            Keys: B split, G grid, R reset
          </span>
        </div>

        {/* Mobile View Switcher Tabs (Only visible on screens < 1024px) */}
        <div className="flex lg:hidden items-center rounded-pill bg-paper p-0.5 border border-rule text-xs shrink min-w-0">
          <button
            type="button"
            onClick={() => setMobileTab('canvas')}
            className={`min-h-[32px] rounded-pill px-2.5 py-1 font-medium transition-colors whitespace-nowrap ${
              mobileTab === 'canvas' ? 'bg-ink text-paper' : 'text-muted hover:text-ink'
            }`}
          >
            Canvas
          </button>
          <button
            type="button"
            onClick={() => setMobileTab('adjust')}
            className={`min-h-[32px] rounded-pill px-2.5 py-1 font-medium transition-colors whitespace-nowrap ${
              mobileTab === 'adjust' ? 'bg-ink text-paper' : 'text-muted hover:text-ink'
            }`}
          >
            Adjust
          </button>
          <button
            type="button"
            onClick={() => setMobileTab('queue')}
            className={`min-h-[32px] rounded-pill px-2.5 py-1 font-medium transition-colors whitespace-nowrap ${
              mobileTab === 'queue' ? 'bg-ink text-paper' : 'text-muted hover:text-ink'
            }`}
          >
            Queue ({photos.length})
          </button>
        </div>

        {/* Zone 3: Primary Import Action (quiet hairline button in masthead; filled primary lives on Export) */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="btn btn--quiet btn--sm shrink-0"
          >
            <ImagePlus className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">Import Photo</span>
            <span className="sm:hidden">Import</span>
          </button>
        </div>
      </header>

      {/* Shared Export & Import Status Notices (visible across Canvas, Adjust, and Queue tabs) */}
      {exportError && (
        <div
          role="alert"
          className="flex items-start sm:items-center justify-between gap-3 border-b border-error bg-paper px-5 py-2 text-xs text-error shrink-0"
        >
          <span className="min-w-0 flex-1 break-words">Export error: {exportError}</span>
          <button
            type="button"
            onClick={() => setExportError(null)}
            className="font-medium underline underline-offset-2 hover:text-ink shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {exportBanner && (
        <div
          role="status"
          aria-live="polite"
          className={`flex items-start sm:items-center justify-between gap-3 border-b border-rule bg-paper-2 px-5 py-2 text-xs shrink-0 ${
            exportBanner.startsWith('Export failed.')
              ? 'text-error'
              : 'text-ink'
          }`}
        >
          <span className="min-w-0 flex-1 break-words">{exportBanner}</span>
          <button
            type="button"
            onClick={() => setExportBanner(null)}
            className="font-medium text-muted underline underline-offset-2 hover:text-ink shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Main Studio Layout */}
      <main id="workspace" tabIndex={-1} className="flex flex-1 flex-col lg:flex-row overflow-hidden min-h-0 outline-none">
        {/* Left Filmstrip Queue */}
        <aside
          aria-label="Photo Filmstrip Queue"
          className={`w-full lg:w-[258px] shrink-0 flex-col border-b lg:border-b-0 lg:border-r border-rule bg-paper-2 ${
            mobileTab === 'queue' ? 'flex flex-1 overflow-y-auto' : 'hidden lg:flex'
          }`}
        >
          <div className="flex items-center justify-between border-b border-rule px-4 py-3 shrink-0">
            <h2 className="font-display text-sm font-normal text-ink">
              Filmstrip Queue ({photos.length})
            </h2>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="text-xs font-medium text-accent underline underline-offset-4 hover:text-ink whitespace-nowrap shrink-0"
            >
              Add file
            </button>
          </div>

          <div className="flex lg:flex-col gap-2.5 overflow-x-auto lg:overflow-y-auto p-3 flex-1 min-h-0">
            {photos.map((item) => {
              const isSelected = item.id === activePhoto.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => {
                    setSelectedId(item.id);
                    if (mobileTab === 'queue') setMobileTab('canvas');
                  }}
                  className={`flex w-56 lg:w-full shrink-0 flex-col p-2 text-left transition-colors min-w-0 ${
                    isSelected
                      ? 'atelier-stock border-ink text-ink'
                      : 'border border-rule bg-paper hover:bg-paper-3 hover:border-ink-2 text-ink-2'
                  }`}
                >
                  <div className="relative h-28 w-full overflow-hidden bg-paper-3 border border-rule">
                    <img
                      src={item.src}
                      alt={item.title}
                      width={320}
                      height={180}
                      referrerPolicy="no-referrer"
                      className="h-full w-full object-cover"
                    />
                  </div>
                  <div className="mt-2 min-w-0 w-full">
                    <div className="truncate text-xs font-medium text-ink">
                      {item.title}
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted font-mono tabular-nums">
                      <span className="truncate min-w-0">{item.fileName}</span>
                      <span className="shrink-0 text-ink-2">
                        {formatSignedDegrees(item.simulatedSensorTiltDeg, 1)}
                      </span>
                    </div>
                  </div>
                </button>
              );
            })}

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="hidden lg:flex w-full shrink-0 items-center justify-center border border-dashed border-rule bg-paper px-3 py-3 text-center text-xs text-muted whitespace-nowrap transition-colors hover:border-ink-2 hover:text-ink"
            >
              Drop or browse files
            </button>
          </div>
        </aside>

        {/* Center Interactive Darkroom Viewport */}
        <section
          aria-label="Darkroom Canvas Workspace"
          className={`flex flex-1 min-w-0 min-h-0 flex-col bg-paper-3 ${
            mobileTab === 'canvas' ? 'flex' : 'hidden lg:flex'
          }`}
        >
          {/* Workspace Secondary Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rule bg-paper px-4 py-2 min-w-0">
            {/* View Mode Segmented Control */}
            <div
              className="flex max-w-full overflow-x-auto items-center gap-0.5 rounded-pill bg-paper-2 p-0.5 border border-rule"
              role="group"
              aria-label="Canvas Inspection Mode"
            >
              <button
                type="button"
                aria-pressed={viewMode === 'framed'}
                onClick={() => setViewMode('framed')}
                className={`min-h-[32px] rounded-pill px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  viewMode === 'framed'
                    ? 'bg-ink text-paper'
                    : 'text-muted hover:text-ink'
                }`}
              >
                Framed Output
              </button>
              <button
                type="button"
                aria-pressed={viewMode === 'split'}
                onClick={() => setViewMode('split')}
                className={`min-h-[32px] rounded-pill px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  viewMode === 'split'
                    ? 'bg-accent text-accent-ink'
                    : 'text-muted hover:text-ink'
                }`}
              >
                Before / After Split
              </button>
              <button
                type="button"
                aria-pressed={viewMode === 'geometry'}
                onClick={() => setViewMode('geometry')}
                className={`min-h-[32px] rounded-pill px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  viewMode === 'geometry'
                    ? 'bg-ink text-paper'
                    : 'text-muted hover:text-ink'
                }`}
              >
                Inscribed Crop Box
              </button>
              <button
                type="button"
                aria-pressed={viewMode === 'original'}
                onClick={() => setViewMode('original')}
                className={`min-h-[32px] rounded-pill px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  viewMode === 'original'
                    ? 'bg-ink text-paper'
                    : 'text-muted hover:text-ink'
                }`}
              >
                Original Sensor
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {/* Interactive Split Position Slider when in Before/After Split mode */}
              {viewMode === 'split' && (
                <div className="flex items-center gap-2 rounded-pill border border-rule bg-paper-2 px-2.5 py-1 shrink-0">
                  <label
                    htmlFor="slider-split-position"
                    className="text-xs text-ink-2 whitespace-nowrap shrink-0"
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
                    className="h-1.5 w-16 sm:w-20 cursor-pointer rounded-pill bg-paper-3 accent-accent"
                  />
                  <span
                    className="font-mono text-xs text-accent tabular-nums whitespace-nowrap shrink-0"
                    data-testid="split-percent-val"
                  >
                    {Math.round(splitPercent)}%
                  </span>
                </div>
              )}

              {/* Zoom Controls */}
              <div
                className="flex items-center rounded-pill border border-rule bg-paper-2 p-0.5 shrink-0"
                role="group"
                aria-label="Canvas Zoom"
              >
                <button
                  type="button"
                  aria-label="Zoom out"
                  onClick={() => handleZoomChange(zoomLevel - 0.25)}
                  disabled={zoomLevel <= 1}
                  className="hit-target-expand flex min-h-[28px] min-w-[28px] items-center justify-center rounded-pill text-ink-2 hover:bg-paper-3 hover:text-ink disabled:opacity-45"
                >
                  <ZoomOut className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => handleZoomChange(1)}
                  title="Reset zoom to 100%"
                  className="min-h-[28px] px-2 font-mono text-xs text-ink tabular-nums hover:text-accent whitespace-nowrap"
                >
                  {Math.round(zoomLevel * 100)}%
                </button>
                <button
                  type="button"
                  aria-label="Zoom in"
                  onClick={() => handleZoomChange(zoomLevel + 0.25)}
                  disabled={zoomLevel >= 4}
                  className="hit-target-expand flex min-h-[28px] min-w-[28px] items-center justify-center rounded-pill text-ink-2 hover:bg-paper-3 hover:text-ink disabled:opacity-45"
                >
                  <ZoomIn className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>

              <button
                type="button"
                aria-pressed={showHorizonGrid}
                onClick={() => setShowHorizonGrid((prev) => !prev)}
                className={`flex min-h-[32px] items-center gap-1.5 rounded-pill border px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  showHorizonGrid
                    ? 'border-accent bg-accent text-accent-ink'
                    : 'border-rule bg-paper-2 text-ink hover:border-ink-2'
                }`}
              >
                <Grid className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="hidden sm:inline">Horizon Grid</span>
                <span className="sm:hidden">Grid</span>
              </button>
            </div>
          </div>

          {/* Canvas Stage */}
          <div className="flex-1 min-h-0 flex items-center justify-center overflow-hidden p-2 sm:p-4">
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
              zoomLevel={zoomLevel}
              panOffset={panOffset}
              onPanOffsetChange={setPanOffset}
              onZoomLevelChange={handleZoomChange}
            />
          </div>

          {/* Quiet Unboxed Metadata Footer Bar (hairline-parted, tabular numerals) */}
          <footer className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-t border-rule bg-paper-2 px-4 sm:px-6 py-2 text-xs text-muted font-mono tabular-nums">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
              <span className="text-ink font-medium truncate max-w-[160px] sm:max-w-xs">
                {activePhoto.fileName}
              </span>
              {activePhoto.exif.cameraModel && (
                <span className="border-l border-rule pl-3 truncate max-w-[140px] sm:max-w-none">
                  {activePhoto.exif.cameraModel}
                </span>
              )}
              {activePhoto.exif.lensModel && (
                <span className="border-l border-rule pl-3 truncate max-w-[180px] hidden sm:inline">
                  {activePhoto.exif.lensModel}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>
                Horizon Tilt: {formatSignedDegrees(analysis.detectedTiltDeg, 2)}
              </span>
              <span className="border-l border-rule pl-3">
                Inscribed Crop: {cropRect.width}×{cropRect.height} ({cropRect.areaRetainedPercent}%)
              </span>
              <span className="border-l border-rule pl-3">
                Frame: {frameLayout.canvasWidth}×{frameLayout.canvasHeight} ({config.aspectPreset})
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
          onBatchExportAll={handleBatchExportAll}
          isExporting={isExporting}
          isBatchExporting={isBatchExporting}
          queueCount={photos.length}
          isImageLoaded={isImageLoaded}
          className={`w-full lg:w-[364px] shrink-0 border-t lg:border-t-0 lg:border-l border-rule bg-paper-2 ${
            mobileTab === 'adjust' ? 'flex flex-1 overflow-y-auto' : 'hidden lg:flex'
          }`}
        />
      </main>
    </div>
  );
}
