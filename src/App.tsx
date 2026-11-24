/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ShortcutsDialog } from './components/ShortcutsDialog';
import { CanvasViewMode, StudioCanvas } from './components/StudioCanvas';
import { InspectorSidebar } from './components/InspectorSidebar';
import { StudioHeader } from './components/StudioHeader';
import { NoticeBar } from './components/NoticeBar';
import { FilmstripQueue } from './components/FilmstripQueue';
import { CanvasToolbar } from './components/CanvasToolbar';
import { MOBILE_PANEL_IDS, MobileTab, MobileTabBar } from './components/MobileTabBar';
import { useEditHistory } from './hooks/useEditHistory';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { usePersistence } from './hooks/usePersistence';
import { isSamplePhoto, usePhotoQueue } from './hooks/usePhotoQueue';
import { useExport } from './hooks/useExport';
import { SUPPORTED_IMAGE_ACCEPT } from './utils/exifParser';
import { supportsDirectoryPicker } from './utils/exportFiles';
import {
  DEFAULT_AUTO_CORRECT_ANALYSIS,
  DEFAULT_LEVELING_ANALYSIS,
  PipelineTelemetryUpdate,
  clamp,
} from './utils/geometry';
import {
  DEFAULT_OUTPUT,
  DEFAULT_PHOTO_EDIT,
  EditSession,
  OutputSettings,
  PhotoEdit,
  Preset,
  TransferableEdit,
  applyEditToPhotos,
  diffKeys,
  editFor,
  toPipelineConfig,
  transferable,
} from './utils/edits';
import { StoredSession } from './utils/persist';
import { INITIAL_SAMPLE_PHOTOS, StudioPhotoItem } from './utils/samplePhotos';

const VIEW_MODES: CanvasViewMode[] = ['framed', 'split', 'geometry', 'original'];

/** Sample photos start tilted so the leveller has something to do. */
const BASELINE_TILTS: Record<string, number> = Object.fromEntries(
  INITIAL_SAMPLE_PHOTOS.map((p) => [p.id, p.simulatedSensorTiltDeg])
);

const INITIAL_TELEMETRY: PipelineTelemetryUpdate = {
  analysis: DEFAULT_LEVELING_ANALYSIS,
  autoCorrect: DEFAULT_AUTO_CORRECT_ANALYSIS,
  crop: { x: 0, y: 0, width: 0, height: 0, scaleFactor: 1, areaRetainedPercent: 100 },
  layout: {
    canvasWidth: 0,
    canvasHeight: 0,
    imageX: 0,
    imageY: 0,
    imageWidth: 0,
    imageHeight: 0,
    borderTop: 0,
    borderBottom: 0,
    borderLeft: 0,
    borderRight: 0,
  },
  sourceSize: { width: 0, height: 0 },
};

export default function App() {
  // ---- Notices ----
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const notices = useMemo(() => ({ setStatus: setStatusNotice, setError: setErrorNotice }), []);

  // ---- Queue, history, export ----
  const queue = usePhotoQueue(notices);
  const { photos, activePhoto } = queue;
  const history = useEditHistory<EditSession>(() => ({ edits: {}, output: DEFAULT_OUTPUT }));
  const session = history.present;
  const exporter = useExport(notices);

  // ---- View state ----
  const [viewMode, setViewMode] = useState<CanvasViewMode>('framed');
  const [showHorizonGrid, setShowHorizonGrid] = useState(false);
  const [isPeekingOriginal, setIsPeekingOriginal] = useState(false);
  const [straightenActive, setStraightenActive] = useState(false);
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobileTab>('canvas');
  const [splitPercent, setSplitPercent] = useState(50);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [isImageLoaded, setIsImageLoaded] = useState(false);
  // Telemetry is tagged with the photo that produced it, so a switch never shows the last photo's numbers
  const [telemetryEntry, setTelemetryEntry] = useState<{ photoId: string; data: PipelineTelemetryUpdate } | null>(
    null
  );
  const [clipboard, setClipboard] = useState<TransferableEdit | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragDepthRef = useRef(0);

  // ---- Derived edit for the active photo ----
  // Memoised on the stored entry: an unedited photo's fallback edit must keep one identity,
  // or every render would hand the canvas a "new" config and restart its pipeline
  const storedEdit = session.edits[activePhoto.id];
  const edit = useMemo(
    () => storedEdit ?? { ...DEFAULT_PHOTO_EDIT, tiltDeg: BASELINE_TILTS[activePhoto.id] ?? 0 },
    [storedEdit, activePhoto.id]
  );
  const config = useMemo(() => toPipelineConfig(edit, session.output), [edit, session.output]);
  const canvasPhoto = useMemo(
    () => ({ ...activePhoto, simulatedSensorTiltDeg: edit.tiltDeg }),
    [activePhoto, edit.tiltDeg]
  );
  const editedIds = useMemo(
    () =>
      new Set(
        Object.entries(session.edits)
          .filter(([id, e]) => diffKeys(e, { ...DEFAULT_PHOTO_EDIT, tiltDeg: BASELINE_TILTS[id] ?? 0 }) !== '')
          .map(([id]) => id)
      ),
    [session.edits]
  );

  // ---- Persistence ----
  const snapshot = useMemo<StoredSession>(() => {
    const ids = new Set(photos.map((p) => p.id));
    return {
      edits: Object.fromEntries(Object.entries(session.edits).filter(([id]) => ids.has(id))),
      output: session.output,
      order: photos.map((p) => p.id),
      selectedId: activePhoto.id,
      presets,
      viewMode,
      showHorizonGrid,
    };
  }, [session, photos, activePhoto.id, presets, viewMode, showHorizonGrid]);

  const { hydrated } = usePersistence(snapshot, ({ imported, session: saved, legacy, readFailed }) => {
    if (readFailed) {
      setErrorNotice(
        "Couldn't read your saved work from this device. Changes in this visit won't be saved, so nothing stored is overwritten; reload to try again."
      );
    }
    const restored = saved ?? legacy;
    const byId = new Map<string, StudioPhotoItem>(
      [...imported, ...INITIAL_SAMPLE_PHOTOS].map((p) => [p.id, p])
    );
    let ordered = (saved?.order ?? []).map((id) => byId.get(id)).filter((p): p is StudioPhotoItem => !!p);
    const unordered = imported.filter((p) => !ordered.includes(p));
    ordered = [...unordered, ...ordered];
    if (!saved) ordered = [...imported, ...INITIAL_SAMPLE_PHOTOS];
    if (ordered.length === 0) ordered = INITIAL_SAMPLE_PHOTOS;
    queue.setPhotos(ordered);
    if (saved?.selectedId && byId.has(saved.selectedId)) queue.setSelectedId(saved.selectedId);
    else queue.setSelectedId(ordered[0].id);
    if (restored) {
      history.reset({ edits: restored.edits ?? {}, output: restored.output ?? DEFAULT_OUTPUT });
      if (restored.viewMode && VIEW_MODES.includes(restored.viewMode as CanvasViewMode)) {
        setViewMode(restored.viewMode as CanvasViewMode);
      }
      if (typeof restored.showHorizonGrid === 'boolean') setShowHorizonGrid(restored.showHorizonGrid);
      setPresets(restored.presets ?? []);
    }
  });

  const telemetry = telemetryEntry?.photoId === activePhoto.id ? telemetryEntry.data : null;
  const shownTelemetry = telemetry ?? INITIAL_TELEMETRY;
  const handleTelemetry = useCallback(
    (data: PipelineTelemetryUpdate) => setTelemetryEntry({ photoId: activePhoto.id, data }),
    [activePhoto.id]
  );

  // ---- Edit commands ----
  const changeEdit = useCallback(
    (updater: (prev: PhotoEdit) => PhotoEdit) => {
      const id = activePhoto.id;
      const base = BASELINE_TILTS[id] ?? 0;
      const current = editFor(history.present, id, base);
      const key = diffKeys(current, updater(current));
      if (!key) return;
      history.commit(
        (s) => ({ ...s, edits: { ...s.edits, [id]: updater(editFor(s, id, base)) } }),
        `edit:${id}:${key}`
      );
    },
    [activePhoto.id, history]
  );

  const changeOutput = useCallback(
    (updater: (prev: OutputSettings) => OutputSettings) => {
      const key = diffKeys(history.present.output, updater(history.present.output));
      if (!key) return;
      history.commit((s) => ({ ...s, output: updater(s.output) }), `output:${key}`);
    },
    [history]
  );

  const resetPhoto = useCallback(() => {
    const id = activePhoto.id;
    history.commit((s) => {
      const current = editFor(s, id, BASELINE_TILTS[id] ?? 0);
      if (diffKeys(current, DEFAULT_PHOTO_EDIT) === '') return s;
      return { ...s, edits: { ...s.edits, [id]: { ...DEFAULT_PHOTO_EDIT } } };
    });
    setSplitPercent(50);
    setZoomLevel(1);
    setPanOffset({ x: 0, y: 0 });
  }, [activePhoto.id, history]);

  const applyToPhotos = useCallback(
    (source: TransferableEdit, ids: string[]) =>
      history.commit((s) => applyEditToPhotos(s, source, ids, BASELINE_TILTS)),
    [history]
  );

  const handleCopyEdit = () => {
    setClipboard(transferable(edit));
    setStatusNotice(`Copied the settings of ${activePhoto.title}.`);
  };
  const handlePasteEdit = () => {
    if (clipboard) applyToPhotos(clipboard, [activePhoto.id]);
  };
  const handleApplyToAll = () => {
    const others = photos.filter((p) => p.id !== activePhoto.id).map((p) => p.id);
    applyToPhotos(transferable(edit), others);
    setStatusNotice(`Applied the settings of ${activePhoto.title} to ${others.length} other ${others.length === 1 ? 'photo' : 'photos'}. Undo reverts it.`);
  };

  const handleSavePreset = (name: string) => {
    const id =
      typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `preset-${Date.now()}`;
    setPresets((prev) => [...prev, { id, name, edit: transferable(edit), output: session.output }]);
    setStatusNotice(`Saved the preset "${name}".`);
  };
  const handleApplyPreset = (id: string) => {
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    const photoId = activePhoto.id;
    history.commit((s) => ({
      ...applyEditToPhotos(s, preset.edit, [photoId], BASELINE_TILTS),
      output: preset.output,
    }));
  };
  const handleDeletePreset = (id: string) => setPresets((prev) => prev.filter((p) => p.id !== id));

  const handleStraighten = (rotationDeg: number) => {
    changeEdit((prev) => ({
      ...prev,
      autoLevelEnabled: false,
      manualAngleOffsetDeg: clamp(rotationDeg, -15, 15),
    }));
    setStraightenActive(false);
  };

  const handleCropChange = (cropOverride: PhotoEdit['cropOverride']) =>
    changeEdit((prev) => ({ ...prev, cropOverride }));

  // ---- View commands ----
  const handleZoomChange = useCallback((next: number) => {
    const clamped = clamp(Number(next.toFixed(2)), 1, 4);
    setZoomLevel(clamped);
    if (clamped <= 1) setPanOffset({ x: 0, y: 0 });
  }, []);

  const selectPhoto = useCallback(
    (id: string) => {
      queue.setSelectedId(id);
      setPanOffset({ x: 0, y: 0 });
      setStraightenActive(false);
    },
    [queue]
  );

  /** Shortcut navigation: the same resets as a filmstrip click; a no-op at either end. */
  const selectRelative = (step: number) => {
    const idx = photos.findIndex((p) => p.id === activePhoto.id);
    const next = photos[idx + step];
    if (next) selectPhoto(next.id);
  };

  const openFilePicker = () => fileInputRef.current?.click();

  const importFiles = async (files: File[]) => {
    // Until the saved session is restored, an import would be overwritten by the restore
    if (!hydrated) return;
    const imported = await queue.importFiles(files);
    if (imported.length > 0) {
      setMobileTab('canvas');
      setPanOffset({ x: 0, y: 0 });
    }
  };

  useKeyboardShortcuts(
    {
      undo: history.undo,
      redo: history.redo,
      showShortcuts: () => setIsShortcutsOpen(true),
      toggleGrid: () => setShowHorizonGrid((v) => !v),
      toggleSplit: () => setViewMode((v) => (v === 'split' ? 'framed' : 'split')),
      reset: resetPhoto,
      zoomBy: (d) => handleZoomChange(zoomLevel + d),
      zoomReset: () => handleZoomChange(1),
      previousPhoto: () => selectRelative(-1),
      nextPhoto: () => selectRelative(1),
      peek: setIsPeekingOriginal,
      escape: () => setStraightenActive(false),
    },
    !isShortcutsOpen && hydrated
  );

  // Paste images straight from the clipboard into the queue
  const importFilesRef = useRef(importFiles);
  importFilesRef.current = importFiles;
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length === 0) return;
      e.preventDefault();
      void importFilesRef.current(files);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  // ---- Export ----
  const withEdit = (photo: StudioPhotoItem) => {
    const e = editFor(session, photo.id, BASELINE_TILTS[photo.id] ?? 0);
    return { photo: { ...photo, simulatedSensorTiltDeg: e.tiltDeg }, config: toPipelineConfig(e, session.output) };
  };
  const handleExportJpeg = () => void exporter.exportOne(canvasPhoto, config);
  const handleBatchExport = () => {
    const prepared = new Map(photos.map((p) => [p.id, withEdit(p)]));
    void exporter.exportAll(
      photos.map((p) => prepared.get(p.id)!.photo),
      (p) => prepared.get(p.id)!.config
    );
  };
  const handleRemovePhoto = async (id: string) => {
    if (exporter.isBatchExporting) return;
    if (await queue.removePhoto(id)) exporter.forget(id);
  };

  // ---- Drag and drop ----
  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepthRef.current += 1;
    if (hydrated && e.dataTransfer.types.includes('Files')) setIsDraggingFiles(true);
  };
  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDraggingFiles(false);
  };
  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepthRef.current = 0;
    setIsDraggingFiles(false);
    void importFiles(Array.from(e.dataTransfer.files ?? []));
  };

  const effectiveViewMode: CanvasViewMode = isPeekingOriginal ? 'original' : viewMode;
  const canvasHint = straightenActive
    ? 'Drag along a line that should be level or upright. Esc cancels.'
    : isPeekingOriginal
      ? 'Original, release \\ to return'
      : viewMode === 'geometry'
        ? 'Drag the box or its edges to crop by hand'
        : null;

  return (
    <div
      className="relative flex h-[100dvh] overflow-hidden flex-col bg-paper text-ink"
      aria-busy={!hydrated}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <a className="skip" href="#workspace">
        Skip to workspace
      </a>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={SUPPORTED_IMAGE_ACCEPT}
        onChange={async (e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length > 0) await importFiles(files);
        }}
        className="hidden"
        aria-label="Upload photo"
      />

      {isDraggingFiles && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed inset-0 z-modal flex items-center justify-center bg-paper/85 p-6"
        >
          <div className="atelier-stock max-w-md px-8 py-6 text-center">
            <p className="font-display text-lg text-ink">Drop photos to add them to the queue</p>
            <p className="mt-1 text-sm text-muted">JPEG, PNG, WebP and RAW, read on this device.</p>
          </div>
        </div>
      )}

      <StudioHeader
        inert={!hydrated}
        title={activePhoto.title}
        sourceSize={telemetry?.sourceSize ?? null}
        onHome={() => {
          setViewMode('framed');
          setMobileTab('canvas');
        }}
        onUndo={history.undo}
        onRedo={history.redo}
        canUndo={history.canUndo}
        canRedo={history.canRedo}
        onShowShortcuts={() => setIsShortcutsOpen(true)}
        onImport={openFilePicker}
      />

      <NoticeBar
        error={errorNotice}
        status={statusNotice ?? (exporter.isBatchExporting ? 'Exporting…' : null)}
        onDismissError={() => setErrorNotice(null)}
        onDismissStatus={() => setStatusNotice(null)}
        onCancel={exporter.isBatchExporting ? exporter.cancelBatch : undefined}
      />

      {/* Inert until the saved session is restored, so no edit can be lost to the restore */}
      <main id="workspace" tabIndex={-1} inert={!hydrated} className="flex flex-1 flex-col lg:flex-row overflow-hidden min-h-0 outline-none">
        <FilmstripQueue
          id={MOBILE_PANEL_IDS.queue}
          photos={photos}
          activeId={activePhoto.id}
          editedIds={editedIds}
          exportStatus={exporter.exportStatus}
          locked={exporter.isBatchExporting}
          onSelect={(id) => {
            selectPhoto(id);
            if (mobileTab === 'queue') setMobileTab('canvas');
          }}
          onRemove={(id) => void handleRemovePhoto(id)}
          onImport={openFilePicker}
          className={`w-full lg:w-[258px] shrink-0 lg:border-r ${
            mobileTab === 'queue' ? 'flex flex-1 min-h-0' : 'hidden lg:flex'
          }`}
        />

        <section
          id={MOBILE_PANEL_IDS.canvas}
          aria-label="Canvas workspace"
          className={`flex flex-1 min-w-0 min-h-0 flex-col bg-paper-3 ${mobileTab === 'canvas' ? 'flex' : 'hidden lg:flex'}`}
        >
          <CanvasToolbar
            viewMode={viewMode}
            onViewModeChange={(mode) => {
              setViewMode(mode);
              setStraightenActive(false);
            }}
            splitPercent={splitPercent}
            onSplitPercentChange={setSplitPercent}
            zoomLevel={zoomLevel}
            onZoomChange={handleZoomChange}
            showHorizonGrid={showHorizonGrid}
            onToggleGrid={() => setShowHorizonGrid((v) => !v)}
          />

          <div className="relative flex-1 min-h-0 flex items-center justify-center overflow-hidden p-2 sm:p-4">
            {canvasHint && (
              <p role="status" className="peek-note">
                {canvasHint}
              </p>
            )}
            <StudioCanvas
              key={activePhoto.id}
              photo={canvasPhoto}
              config={config}
              viewMode={effectiveViewMode}
              splitPercent={splitPercent}
              onSplitPercentChange={setSplitPercent}
              showHorizonGrid={showHorizonGrid}
              onAnalysisUpdate={handleTelemetry}
              onImageLoaded={setIsImageLoaded}
              zoomLevel={zoomLevel}
              panOffset={panOffset}
              onPanOffsetChange={setPanOffset}
              onZoomLevelChange={handleZoomChange}
              onCropChange={handleCropChange}
              straightenActive={straightenActive}
              onStraighten={handleStraighten}
            />
          </div>

          <footer className="hidden sm:flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-t border-rule bg-paper-2 px-4 sm:px-6 py-2 text-xs text-muted font-mono tabular-nums">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
              <span className="text-ink font-medium truncate max-w-xs">{activePhoto.fileName}</span>
              {activePhoto.exif.cameraModel && (
                <span className="border-l border-rule pl-3 truncate">{activePhoto.exif.cameraModel}</span>
              )}
            </div>
            {telemetry ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>Tilt {telemetry.analysis.detectedTiltDeg >= 0 ? '+' : ''}{telemetry.analysis.detectedTiltDeg.toFixed(2)}°</span>
                <span className="border-l border-rule pl-3">
                  Crop {telemetry.crop.width} × {telemetry.crop.height} ({telemetry.crop.areaRetainedPercent}%)
                </span>
                <span className="border-l border-rule pl-3">
                  Frame {telemetry.layout.canvasWidth} × {telemetry.layout.canvasHeight} ({session.output.aspectPreset})
                </span>
              </div>
            ) : (
              <span>Analysing…</span>
            )}
          </footer>
        </section>

        <InspectorSidebar
          id={MOBILE_PANEL_IDS.adjust}
          edit={edit}
          onChangeEdit={changeEdit}
          output={session.output}
          onChangeOutput={changeOutput}
          analysis={shownTelemetry.analysis}
          autoCorrect={telemetry?.autoCorrect}
          cropRect={shownTelemetry.crop}
          frameLayout={shownTelemetry.layout}
          exif={activePhoto.exif}
          isSample={isSamplePhoto(activePhoto.id)}
          onResetPhoto={resetPhoto}
          onCopyEdit={handleCopyEdit}
          onPasteEdit={handlePasteEdit}
          canPaste={!!clipboard}
          onApplyToAll={handleApplyToAll}
          straightenActive={straightenActive}
          onToggleStraighten={() => {
            setStraightenActive((v) => !v);
            setMobileTab('canvas');
          }}
          presets={presets}
          onApplyPreset={handleApplyPreset}
          onSavePreset={handleSavePreset}
          onDeletePreset={handleDeletePreset}
          onExportJpeg={handleExportJpeg}
          onBatchExportAll={handleBatchExport}
          isExporting={exporter.isExporting}
          isBatchExporting={exporter.isBatchExporting}
          queueCount={photos.length}
          isImageLoaded={isImageLoaded}
          canSaveToFolder={supportsDirectoryPicker()}
          className={`w-full lg:w-[364px] min-h-0 ${mobileTab === 'adjust' ? 'flex flex-1' : 'hidden lg:flex'}`}
        />
      </main>

      <MobileTabBar
        inert={!hydrated}
        tab={mobileTab}
        onTabChange={setMobileTab}
        queueCount={photos.length}
        onExport={handleExportJpeg}
        exportDisabled={exporter.isExporting || exporter.isBatchExporting || !isImageLoaded}
        isExporting={exporter.isExporting}
      />

      <ShortcutsDialog open={isShortcutsOpen} onClose={() => setIsShortcutsOpen(false)} />
    </div>
  );
}
