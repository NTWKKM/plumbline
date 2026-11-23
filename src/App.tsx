/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Grid, ImagePlus, Keyboard, Redo2, Undo2, X, ZoomIn, ZoomOut } from 'lucide-react';
import { ShortcutsDialog } from './components/ShortcutsDialog';
import {
  HistoryState,
  PushOptions,
  canRedo,
  canUndo,
  createHistory,
  pushHistory,
  redoHistory,
  undoHistory,
} from './utils/history';
import {
  CanvasViewMode,
  StudioCanvas,
  renderPhotoToFramedCanvas,
} from './components/StudioCanvas';
import { InspectorSidebar } from './components/InspectorSidebar';
import {
  SUPPORTED_IMAGE_ACCEPT,
  extractDecodableEmbeddedJpegFromRawBuffer,
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
const VIEW_MODE_OPTIONS: { value: CanvasViewMode; label: string; short: string }[] = [
  { value: 'framed', label: 'Framed output', short: 'Framed' },
  { value: 'split', label: 'Before and after', short: 'Split' },
  { value: 'geometry', label: 'Crop box', short: 'Crop' },
  { value: 'original', label: 'Original', short: 'Original' },
];

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

/** One undoable step: the global pipeline config plus per-photo sensor tilt. */
interface EditSnapshot {
  config: PipelineConfig;
  tilts: Record<string, number>;
}

/** Names of the config fields that differ, used to coalesce slider drags into one undo step. */
function diffConfigKeys(a: PipelineConfig, b: PipelineConfig): string {
  return (Object.keys(b) as (keyof PipelineConfig)[])
    .filter((k) => !Object.is(a[k], b[k]))
    .sort()
    .join(',');
}

type DirectoryHandle = {
  getFileHandle: (
    name: string,
    options?: { create?: boolean }
  ) => Promise<{ createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void> }> }>;
};

async function directoryHasFile(directory: DirectoryHandle, name: string): Promise<boolean> {
  try {
    await directory.getFileHandle(name);
    return true;
  } catch (err) {
    if (err instanceof DOMException) {
      if (err.name === 'NotFoundError') return false;
      // A folder with that name exists, so the name is taken
      if (err.name === 'TypeMismatchError') return true;
    }
    // NotAllowedError and anything else: rethrow so the batch stops and reports it
    // instead of probing suffixes forever
    throw err;
  }
}

function supportsDirectoryPicker(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/**
 * Keeps `name` when free, otherwise the first `stem-N.ext` that is neither allocated earlier in
 * this batch nor (when `isTaken` is given) already present in the destination.
 */
async function uniqueFileName(
  name: string,
  used: Set<string>,
  isTaken?: (candidate: string) => Promise<boolean>
): Promise<string> {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let candidate = name;
  let n = 1;
  while (used.has(candidate) || (isTaken && (await isTaken(candidate)))) {
    n += 1;
    candidate = `${stem}-${n}${ext}`;
  }
  used.add(candidate);
  return candidate;
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function App() {
  const initialView = useRef(loadPersistedViewState()).current;
  const [photos, setPhotos] = useState<StudioPhotoItem[]>(() =>
    getInitialPhotos(initialView.tiltOverrides)
  );
  const [selectedId, setSelectedId] = useState<string>(INITIAL_SAMPLE_PHOTOS[0].id);
  const [history, setHistory] = useState<HistoryState<EditSnapshot>>(() =>
    createHistory<EditSnapshot>({
      config: loadPersistedConfig(),
      tilts: Object.fromEntries(
        getInitialPhotos(initialView.tiltOverrides).map((p) => [p.id, p.simulatedSensorTiltDeg])
      ),
    })
  );
  const config = history.present.config;
  const historyTilts = history.present.tilts;
  // Initial tilts captured once on mount; imported photos have no entry and default to 0°
  const baselineTiltsRef = useRef<Record<string, number>>(history.present.tilts);
  // Pointer gestures on range sliders: one gesture is one undo step, however long it pauses
  const sliderGestureRef = useRef<{ id: number; active: boolean }>({ id: 0, active: false });
  const [viewMode, setViewMode] = useState<CanvasViewMode>(initialView.viewMode);
  const [isPeekingOriginal, setIsPeekingOriginal] = useState<boolean>(false);
  const [isShortcutsOpen, setIsShortcutsOpen] = useState<boolean>(false);
  // 'exported' = written and closed in a chosen folder; 'requested' = a browser download was triggered
  const [exportStatus, setExportStatus] = useState<Record<string, 'exported' | 'requested'>>({});
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
  const [errorNotice, setErrorNotice] = useState<string | null>(null);

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
  const effectiveViewMode: CanvasViewMode = isPeekingOriginal ? 'original' : viewMode;

  // During a slider drag, edits merge by gesture id with no time window, so pauses stay one step
  // and a new drag always starts a new step. Keyboard nudges fall back to the timed merge.
  const historyPushOptions = (key: string): PushOptions => {
    const gesture = sliderGestureRef.current;
    return gesture.active
      ? { key: `${key}:gesture-${gesture.id}`, coalesceMs: Number.POSITIVE_INFINITY }
      : { key };
  };

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (t instanceof HTMLInputElement && t.type === 'range') {
        sliderGestureRef.current = { id: sliderGestureRef.current.id + 1, active: true };
      }
    };
    const onPointerEnd = () => {
      if (sliderGestureRef.current.active) {
        sliderGestureRef.current = { ...sliderGestureRef.current, active: false };
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointerup', onPointerEnd, true);
    window.addEventListener('pointercancel', onPointerEnd, true);
    window.addEventListener('blur', onPointerEnd);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pointerup', onPointerEnd, true);
      window.removeEventListener('pointercancel', onPointerEnd, true);
      window.removeEventListener('blur', onPointerEnd);
    };
  }, []);

  // Config edits go through the undo history; same-field edits in quick succession coalesce.
  const setConfig = useCallback(
    (updater: PipelineConfig | ((prev: PipelineConfig) => PipelineConfig)) => {
      setHistory((h) => {
        const prev = h.present.config;
        const next = typeof updater === 'function' ? updater(prev) : updater;
        const key = diffConfigKeys(prev, next);
        if (!key) return h;
        return pushHistory(h, { ...h.present, config: next }, historyPushOptions(`config:${key}`));
      });
    },
    []
  );

  // Photos follow the tilt values held in history, so undo/redo restores tilt too.
  useEffect(() => {
    setPhotos((prev) => {
      let changed = false;
      const next = prev.map((item) => {
        // No entry means the photo is at its immutable baseline: 0° for imports, the initial tilt for samples
        const t = historyTilts[item.id] ?? baselineTiltsRef.current[item.id] ?? 0;
        if (t !== item.simulatedSensorTiltDeg) {
          changed = true;
          return { ...item, simulatedSensorTiltDeg: t };
        }
        return item;
      });
      return changed ? next : prev;
    });
  }, [historyTilts]);

  const handleUndo = useCallback(() => setHistory((h) => undoHistory(h)), []);
  const handleRedo = useCallback(() => setHistory((h) => redoHistory(h)), []);
  const undoAvailable = canUndo(history);
  const redoAvailable = canRedo(history);

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
      const id = activePhoto.id;
      setHistory((h) => {
        if (h.present.tilts[id] === deg) return h;
        return pushHistory(
          h,
          { ...h.present, tilts: { ...h.present.tilts, [id]: deg } },
          historyPushOptions(`tilt:${id}`)
        );
      });
    },
    [activePhoto.id]
  );

  // Reset is one undo step (config and the active photo's tilt together), so R is never destructive.
  const handleResetAll = useCallback(() => {
    const id = activePhoto.id;
    setHistory((h) => {
      const alreadyDefault =
        diffConfigKeys(h.present.config, DEFAULT_PIPELINE_CONFIG) === '' &&
        (h.present.tilts[id] ?? baselineTiltsRef.current[id] ?? 0) === 0;
      if (alreadyDefault) return h;
      return pushHistory(h, {
        config: DEFAULT_PIPELINE_CONFIG,
        tilts: { ...h.present.tilts, [id]: 0 },
      });
    });
    setSplitPercent(50);
    setZoomLevel(1);
    setPanOffset({ x: 0, y: 0 });
  }, [activePhoto.id]);

  const handleRemovePhoto = useCallback(
    (id: string) => {
      // The batch iterates a snapshot of the queue; revoking a URL mid-batch would break its render
      if (isBatchExporting || photos.length <= 1) return;
      const idx = photos.findIndex((p) => p.id === id);
      if (idx < 0) return;
      const removed = photos[idx];
      const next = photos.filter((p) => p.id !== id);
      if (id === activePhoto.id) {
        setSelectedId(next[Math.min(idx, next.length - 1)].id);
      }
      setPhotos(next);
      if (removed.id.startsWith('imported-') && removed.src.startsWith('blob:')) {
        URL.revokeObjectURL(removed.src);
      }
      setExportStatus((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
    },
    [activePhoto.id, isBatchExporting, photos]
  );

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
          displayBlob = await extractDecodableEmbeddedJpegFromRawBuffer(buffer);
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
      setErrorNotice(`Import error: unable to import ${failedFiles.join('; ')}`);
    } else if (importedItems.length > 0) {
      setErrorNotice(null);
    }
  }, []);

  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    await importFiles(files);
    e.target.value = '';
  };

  // Paste images straight from the clipboard into the queue
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length === 0) return;
      e.preventDefault();
      void importFiles(files);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [importFiles]);

  // Hold backslash to peek at the untouched original; release to return.
  // The release is matched by KeyboardEvent.code, since `key` can differ on keyup (layout, modifiers).
  const peekCodeRef = useRef<string | null>(null);
  useEffect(() => {
    const isPeekKey = (e: KeyboardEvent) => e.key === '\\' && !e.metaKey && !e.ctrlKey && !e.altKey;
    const endPeek = () => {
      peekCodeRef.current = null;
      setIsPeekingOriginal(false);
    };
    const onDown = (e: KeyboardEvent) => {
      if (isShortcutsOpen) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (isPeekKey(e)) {
        e.preventDefault();
        if (!e.repeat && peekCodeRef.current === null) {
          peekCodeRef.current = e.code;
          setIsPeekingOriginal(true);
        }
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (peekCodeRef.current !== null && e.code === peekCodeRef.current) endPeek();
    };
    const onBlur = endPeek;
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [isShortcutsOpen]);

  // Global keyboard shortcuts for studio navigation and inspection
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // While the shortcuts dialog is open, no workspace action (undo included) may run behind it
      if (isShortcutsOpen) return;
      const target = e.target as HTMLElement | null;
      const isTextEntry =
        !!target &&
        (target.tagName === 'TEXTAREA' ||
          target.isContentEditable ||
          (target.tagName === 'INPUT' &&
            ['text', 'search', 'email', 'url', 'number', 'password'].includes(
              (target as HTMLInputElement).type
            )));

      // Undo / redo work from anywhere except text entry, including while a slider has focus
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !isTextEntry) {
        const key = e.key.toLowerCase();
        if (key === 'z' && !e.shiftKey) {
          e.preventDefault();
          handleUndo();
          return;
        }
        if ((key === 'z' && e.shiftKey) || key === 'y') {
          e.preventDefault();
          handleRedo();
          return;
        }
      }

      if (e.metaKey || e.ctrlKey || e.altKey) return;
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

      if (e.key === '?') {
        e.preventDefault();
        setIsShortcutsOpen(true);
      } else if (e.key === 'g' || e.key === 'G') {
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
  }, [
    activePhoto.id,
    handleRedo,
    handleResetAll,
    handleUndo,
    handleZoomChange,
    isShortcutsOpen,
    photos,
    zoomLevel,
  ]);

  const markExportStatus = useCallback((id: string, status: 'exported' | 'requested') => {
    setExportStatus((prev) => {
      // A confirmed folder write is never downgraded by a later download request
      if (prev[id] === status || (prev[id] === 'exported' && status === 'requested')) return prev;
      return { ...prev, [id]: status };
    });
  }, []);

  const encodeFramedCanvas = async (
    canvas: HTMLCanvasElement,
    photoItem: StudioPhotoItem,
    photoSourceSize: { width: number; height: number }
  ): Promise<{ blob: Blob; outName: string; exifPreserved: boolean }> => {
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

    const baseName = photoItem.fileName.replace(/\.[^.]+$/, '');
    const outName = `${baseName}_whiteborder_${config.aspectPreset.replace(':', 'x')}.jpg`;

    return { blob: finalBlob, outName, exifPreserved };
  };

  const handleExportJpeg = async () => {
    setIsExporting(true);
    setExportBanner(null);
    setErrorNotice(null);

    try {
      const canvas = exportCanvasRef.current ? exportCanvasRef.current() : canvasRef.current;
      if (!canvas) {
        setErrorNotice('Export error: darkroom canvas is not ready for export.');
        return;
      }

      const { blob, outName, exifPreserved } = await encodeFramedCanvas(
        canvas,
        activePhoto,
        sourceSize
      );
      downloadBlob(blob, outName);
      markExportStatus(activePhoto.id, 'requested');

      setExportBanner(
        `Download requested for ${outName} (${canvas.width} × ${canvas.height} px, ${
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
    if (photos.length === 0 || isBatchExporting) return;
    // Lock the queue (removal disabled) from the moment the folder picker opens
    setIsBatchExporting(true);

    // Where the browser allows it, write the whole queue into one chosen folder
    // instead of firing a download per photo (which browsers throttle or block).
    let directory: DirectoryHandle | null = null;
    if (supportsDirectoryPicker()) {
      try {
        directory = await (
          window as unknown as {
            showDirectoryPicker: (o: { mode: 'readwrite'; id?: string }) => Promise<DirectoryHandle>;
          }
        ).showDirectoryPicker({ mode: 'readwrite', id: 'plumbline-export' });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          setIsBatchExporting(false);
          return;
        }
        directory = null;
      }
    }

    setExportBanner(null);
    setErrorNotice(null);

    let exportedCount = 0;
    const usedNames = new Set<string>();
    try {
      for (let i = 0; i < photos.length; i++) {
        const item = photos[i];
        setExportBanner(`Exporting ${i + 1} of ${photos.length}: ${item.title}…`);
        const { canvas, sourceSize: itemSourceSize } = await renderPhotoToFramedCanvas(item, config);
        const { blob, outName } = await encodeFramedCanvas(canvas, item, itemSourceSize);
        if (directory) {
          const dir = directory;
          const fileName = await uniqueFileName(outName, usedNames, (c) => directoryHasFile(dir, c));
          const handle = await dir.getFileHandle(fileName, { create: true });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          markExportStatus(item.id, 'exported');
        } else {
          downloadBlob(blob, await uniqueFileName(outName, usedNames));
          markExportStatus(item.id, 'requested');
        }
        exportedCount += 1;
      }
      setExportBanner(
        directory
          ? `Saved ${exportedCount} framed ${exportedCount === 1 ? 'JPEG' : 'JPEGs'} (${config.aspectPreset}) to the chosen folder.`
          : `Triggered ${exportedCount} framed JPEG download ${exportedCount === 1 ? 'request' : 'requests'} (${config.aspectPreset}). Your browser may prompt for or block additional downloads.`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setExportBanner(null);
      setErrorNotice(`Export error: batch export stopped after ${exportedCount} of ${photos.length}: ${msg}`);
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
          <div className="flex items-center rounded-pill border border-rule bg-paper p-0.5" role="group" aria-label="History">
            <button
              type="button"
              onClick={handleUndo}
              disabled={!undoAvailable}
              aria-label="Undo"
              title="Undo"
              className="icon-btn"
            >
              <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={handleRedo}
              disabled={!redoAvailable}
              aria-label="Redo"
              title="Redo"
              className="icon-btn"
            >
              <Redo2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
          {/* Wrapper carries the breakpoint: unlayered .btn display would beat a layered `hidden` utility */}
          <span className="hidden md:contents">
            <button
              type="button"
              onClick={() => setIsShortcutsOpen(true)}
              aria-label="Keyboard shortcuts"
              title="Keyboard shortcuts (?)"
              className="btn btn--quiet btn--sm shrink-0"
            >
              <Keyboard className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="hidden xl:inline">Shortcuts</span>
            </button>
          </span>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="btn btn--quiet btn--sm shrink-0"
          >
            <ImagePlus className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">Import photos</span>
            <span className="sm:hidden">Import</span>
          </button>
        </div>
      </header>

      {/* Shared Export & Import Status Notices (visible across Canvas, Adjust, and Queue tabs) */}
      {errorNotice && (
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
            {errorNotice}
          </span>
          <button
            type="button"
            onClick={() => setErrorNotice(null)}
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
              Filmstrip queue ({photos.length})
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
              const status = exportStatus[item.id];
              return (
                <div key={item.id} className="filmstrip-item relative w-56 lg:w-full shrink-0 min-w-0">
                <button
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => {
                    setSelectedId(item.id);
                    if (mobileTab === 'queue') setMobileTab('canvas');
                  }}
                  className={`flex w-full flex-col p-2 text-left transition-colors min-w-0 ${
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
                    <div className="flex items-baseline justify-between gap-2 min-w-0">
                      <span className="truncate text-xs font-medium text-ink min-w-0">
                        {item.title}
                      </span>
                      {status && (
                        <span className={`shrink-0 text-xs ${status === 'exported' ? 'text-success' : 'text-muted'}`}>
                          {status === 'exported' ? 'Exported' : 'Download requested'}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted font-mono tabular-nums">
                      <span className="truncate min-w-0">{item.fileName}</span>
                      <span className="shrink-0 text-ink-2">
                        {formatSignedDegrees(item.simulatedSensorTiltDeg, 1)}
                      </span>
                    </div>
                  </div>
                </button>
                {photos.length > 1 && (
                  <button
                    type="button"
                    onClick={() => handleRemovePhoto(item.id)}
                    disabled={isBatchExporting}
                    aria-label={`Remove ${item.title} from the queue`}
                    title="Remove from queue"
                    className="filmstrip-remove icon-btn absolute right-3.5 top-3.5 z-raised border border-rule bg-paper"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                )}
                </div>
              );
            })}

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="hidden lg:flex w-full shrink-0 flex-col items-center justify-center gap-0.5 border border-dashed border-rule bg-paper px-3 py-3 text-center text-xs text-muted transition-colors hover:border-ink-2 hover:text-ink"
            >
              <span>Drop or browse files</span>
              <span className="text-muted">or paste an image</span>
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
              {VIEW_MODE_OPTIONS.map((opt) => {
                const active = viewMode === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setViewMode(opt.value)}
                    className={`min-h-[32px] rounded-pill px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                      active
                        ? opt.value === 'split'
                          ? 'bg-accent text-accent-ink'
                          : 'bg-ink text-paper'
                        : 'text-muted hover:text-ink'
                    }`}
                  >
                    <span className="hidden md:inline">{opt.label}</span>
                    <span className="md:hidden">{opt.short}</span>
                  </button>
                );
              })}
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
                <span className="hidden sm:inline">Horizon grid</span>
                <span className="sm:hidden">Grid</span>
              </button>
            </div>
          </div>

          {/* Canvas Stage */}
          <div className="relative flex-1 min-h-0 flex items-center justify-center overflow-hidden p-2 sm:p-4">
            {isPeekingOriginal && (
              <p role="status" className="peek-note">
                Original, release \ to return
              </p>
            )}
            <StudioCanvas
              key={activePhoto.id}
              photo={activePhoto}
              config={config}
              viewMode={effectiveViewMode}
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
            <div className="grid grid-cols-1 sm:flex sm:flex-wrap sm:items-center gap-x-3 gap-y-1">
              <span>
                Tilt {formatSignedDegrees(analysis.detectedTiltDeg, 2)}
              </span>
              <span className="sm:border-l sm:border-rule sm:pl-3">
                Crop {cropRect.width} × {cropRect.height} ({cropRect.areaRetainedPercent}%)
              </span>
              <span className="sm:border-l sm:border-rule sm:pl-3">
                Frame {frameLayout.canvasWidth} × {frameLayout.canvasHeight} ({config.aspectPreset})
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
          canSaveToFolder={supportsDirectoryPicker()}
          className={`w-full lg:w-[364px] shrink-0 border-t lg:border-t-0 lg:border-l border-rule bg-paper-2 ${
            mobileTab === 'adjust' ? 'flex flex-1 overflow-y-auto' : 'hidden lg:flex'
          }`}
        />
      </main>

      <ShortcutsDialog open={isShortcutsOpen} onClose={() => setIsShortcutsOpen(false)} />
    </div>
  );
}
