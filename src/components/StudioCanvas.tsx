import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, RotateCcw } from 'lucide-react';
import {
  AutoCorrectAnalysis,
  CropRect,
  DEFAULT_AUTO_CORRECT_ANALYSIS,
  DEFAULT_LEVELING_ANALYSIS,
  LevelingAnalysis,
  PipelineConfig,
  PipelineTelemetryUpdate,
  clamp,
  computeSplitDividerX,
  formatSignedDegrees,
} from '../utils/geometry';
import {
  ProcessedFramePipeline,
  SaliencyBuffer,
  buildProcessedFramePipeline,
  buildSensorAndAnalysis,
  reanalyzeTone,
} from '../utils/framePipeline';
import {
  CropHandle,
  adjustCrop,
  hitCropHandle,
  normalizeCrop,
  rotationToStraighten,
} from '../utils/canvasTools';
import { GuidePath, GuideStyle, buildCompositionGuides } from '../utils/compositionGuides';
import { NormalizedCrop } from '../utils/edits';
import { createLatestRunner } from '../utils/pool';
import { StudioPhotoItem } from '../utils/samplePhotos';

export type CanvasViewMode = 'framed' | 'split' | 'geometry' | 'original';

const ATELIER_CANVAS_INK = '#2b231d';
const ATELIER_CANVAS_SCRIM = 'rgba(43, 35, 29, 0.86)';
const ATELIER_CANVAS_DIM = 'rgba(43, 35, 29, 0.58)';
const ATELIER_CANVAS_PAPER = '#f5f2eb';
const ATELIER_CANVAS_ACCENT = '#3b5878';
const ATELIER_CANVAS_ACCENT_SOFT = '#93b4d4';
const ATELIER_CANVAS_MAT = '#e6e1d7';

interface StudioCanvasProps {
  photo: StudioPhotoItem;
  config: PipelineConfig;
  viewMode: CanvasViewMode;
  splitPercent: number;
  onSplitPercentChange: (pct: number) => void;
  showHorizonGrid: boolean;
  /** Which composition guide the grid toggle shows, and which of its placements. */
  gridStyle?: GuideStyle;
  gridOrientation?: number;
  onAnalysisUpdate: (telemetry: PipelineTelemetryUpdate) => void;
  onImageLoaded?: (loaded: boolean) => void;
  zoomLevel?: number;
  panOffset?: { x: number; y: number };
  onPanOffsetChange?: (offset: { x: number; y: number }) => void;
  onZoomLevelChange?: (zoom: number) => void;
  /** Crop box view: drag the box or its handles; commits a hand crop on release. */
  onCropChange?: (crop: NormalizedCrop) => void;
  /** Straighten tool: draw along something level or plumb; reports the rotation that fixes it. */
  straightenActive?: boolean;
  onStraighten?: (rotationDeg: number) => void;
}

type Pointer = { x: number; y: number };

/** Every gesture belongs to the pointer that started it; other pointers are ignored until it ends. */
type Gesture = { pointerId: number } & (
  | { kind: 'split' }
  | { kind: 'pan'; clientX: number; clientY: number; offsetX: number; offsetY: number }
  | { kind: 'crop'; handle: CropHandle; start: Pointer; origin: NormalizedCrop }
  | { kind: 'line'; start: Pointer }
);

const sameCrop = (a: NormalizedCrop, b: NormalizedCrop) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

const CROP_CURSORS: Record<CropHandle, string> = {
  move: 'move',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
};

export const StudioCanvas: React.FC<StudioCanvasProps> = ({
  photo,
  config,
  viewMode,
  splitPercent,
  onSplitPercentChange,
  showHorizonGrid,
  gridStyle = 'thirds',
  gridOrientation = 0,
  onAnalysisUpdate,
  onImageLoaded,
  zoomLevel = 1,
  panOffset = { x: 0, y: 0 },
  onPanOffsetChange,
  onZoomLevelChange,
  onCropChange,
  straightenActive = false,
  onStraighten,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [sensorCanvas, setSensorCanvas] = useState<HTMLCanvasElement | null>(null);
  const [analysis, setAnalysis] = useState<LevelingAnalysis>(DEFAULT_LEVELING_ANALYSIS);
  const [autoCorrect, setAutoCorrect] = useState<AutoCorrectAnalysis>(DEFAULT_AUTO_CORRECT_ANALYSIS);
  const [pipeline, setPipeline] = useState<ProcessedFramePipeline | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draftCrop, setDraftCropState] = useState<NormalizedCrop | null>(null);
  const [draftLine, setDraftLineState] = useState<{ a: Pointer; b: Pointer } | null>(null);
  // Mirrors of the drafts: pointer events can arrive faster than React re-renders
  const draftCropRef = useRef<NormalizedCrop | null>(null);
  const draftLineRef = useRef<{ a: Pointer; b: Pointer } | null>(null);
  const setDraftCrop = (v: NormalizedCrop | null) => {
    draftCropRef.current = v;
    setDraftCropState(v);
  };
  const setDraftLine = (v: { a: Pointer; b: Pointer } | null) => {
    draftLineRef.current = v;
    setDraftLineState(v);
  };
  const [hoverCursor, setHoverCursor] = useState<string | undefined>(undefined);
  const [isPanning, setIsPanning] = useState(false);

  const stageContainerRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const saliencyRef = useRef<SaliencyBuffer | null>(null);
  const callbackRef = useRef(onAnalysisUpdate);
  callbackRef.current = onAnalysisUpdate;
  const loadedRef = useRef(onImageLoaded);
  loadedRef.current = onImageLoaded;

  const tiltDeg = photo.simulatedSensorTiltDeg || 0;
  const effectiveView: CanvasViewMode = straightenActive ? 'original' : viewMode;

  // Step 1: decode the photo, simulate tilt, and analyse horizon and tone in the worker
  useEffect(() => {
    let cancelled = false;
    setSensorCanvas(null);
    setPipeline(null);
    setLoadError(null);
    loadedRef.current?.(false);

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.onload = async () => {
      if (cancelled) return;
      try {
        const result = await buildSensorAndAnalysis(
          img,
          tiltDeg,
          config.maxAutoAngleDeg,
          config.pixelAreaBudget,
          config.wbProfile ?? 'ambient'
        );
        if (cancelled || !result) return;
        saliencyRef.current = result.saliency;
        setAnalysis(result.analysis);
        setAutoCorrect(result.autoCorrect);
        setSensorCanvas(result.sensorCanvas);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Analysis failed.');
      }
    };
    img.onerror = () => {
      if (!cancelled) setLoadError('Unable to decode image buffer.');
    };
    img.src = photo.src;
    return () => {
      cancelled = true;
    };
    // wbProfile is read once here; later changes re-run only the tone analysis below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo.id, photo.src, tiltDeg, config.maxAutoAngleDeg, config.pixelAreaBudget]);

  // A white-balance profile change re-runs only the tone analysis
  const wbProfile = config.wbProfile ?? 'ambient';
  useEffect(() => {
    const sal = saliencyRef.current;
    if (!sal || !sensorCanvas || (autoCorrect.wbProfile ?? 'ambient') === wbProfile) return;
    let cancelled = false;
    reanalyzeTone(sal, wbProfile).then(
      (next) => {
        if (!cancelled) setAutoCorrect(next);
      },
      (err) => {
        // Superseded requests are ignored; for the current one, show the failure instead of
        // a preview built for the other profile. Choosing a profile again retries.
        if (cancelled) return;
        setIsProcessing(false);
        setLoadError(err instanceof Error ? `Tone analysis failed: ${err.message}` : 'Tone analysis failed.');
      }
    );
    return () => {
      cancelled = true;
    };
  }, [wbProfile, sensorCanvas, autoCorrect.wbProfile]);

  // Step 2: build the framed output. Only the latest request runs, so a slider drag stays responsive.
  const generationRef = useRef(0);
  const runPipeline = useMemo(
    () =>
      createLatestRunner<{
        generation: number;
        sensor: HTMLCanvasElement;
        photo: StudioPhotoItem;
        config: PipelineConfig;
        analysis: LevelingAnalysis;
        autoCorrect: AutoCorrectAnalysis;
      }>(async (job) => {
        try {
          const result = await buildProcessedFramePipeline(
            job.sensor,
            job.photo,
            job.config,
            job.analysis,
            job.autoCorrect,
            saliencyRef.current
          );
          if (!result || job.generation !== generationRef.current) return;
          setPipeline(result);
          setIsProcessing(false);
          setLoadError(null); // a successful render recovers from an earlier render failure
          callbackRef.current({
            analysis: job.analysis,
            crop: result.crop,
            layout: result.layout,
            sourceSize: { width: job.sensor.width, height: job.sensor.height },
            autoCorrect: job.autoCorrect,
          });
        } catch (err) {
          if (job.generation === generationRef.current) {
            setIsProcessing(false);
            setLoadError(err instanceof Error ? err.message : 'Rendering failed.');
          }
        }
      }),
    []
  );

  useEffect(() => {
    if (!sensorCanvas) return;
    if ((autoCorrect.wbProfile ?? 'ambient') !== wbProfile) return; // wait for the tone re-analysis
    generationRef.current += 1;
    setIsProcessing(true);
    runPipeline({
      generation: generationRef.current,
      sensor: sensorCanvas,
      photo,
      config,
      analysis,
      autoCorrect,
    });
    return () => {
      // Inputs changed or the canvas unmounted: the job in flight may no longer publish.
      // The next run (if any) sets processing again; without one nothing is left pending.
      generationRef.current += 1;
      setIsProcessing(false);
    };
  }, [sensorCanvas, photo, config, analysis, autoCorrect, wbProfile, runPipeline]);

  useEffect(() => {
    loadedRef.current?.(!!pipeline);
  }, [pipeline]);

  // Step 3: draw the active view. Cheap, so it runs on every view, split, grid or draft change.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !sensorCanvas || !pipeline) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const srcW = sensorCanvas.width;
    const srcH = sensorCanvas.height;
    const { layout, rotCanvas, processedFrameCanvas, totalRotDeg } = pipeline;
    const crop: CropRect = draftCrop
      ? { ...pipeline.crop, ...denormalize(draftCrop, srcW, srcH) }
      : pipeline.crop;
    const viewMode = effectiveView;

    if (viewMode === 'original') {
      canvas.width = srcW;
      canvas.height = srcH;
      ctx.drawImage(sensorCanvas, 0, 0);
    } else if (viewMode === 'geometry') {
      // Show rotated buffer + dimmed corner wedges + bright inscribed rectangle box
      canvas.width = srcW;
      canvas.height = srcH;
      ctx.fillStyle = config.backgroundColor;
      ctx.fillRect(0, 0, srcW, srcH);
      ctx.drawImage(rotCanvas, 0, 0);

      // Dim outside the inscribed crop rectangle
      ctx.fillStyle = ATELIER_CANVAS_DIM;
      ctx.fillRect(0, 0, srcW, crop.y);
      ctx.fillRect(0, crop.y + crop.height, srcW, srcH - (crop.y + crop.height));
      ctx.fillRect(0, crop.y, crop.x, crop.height);
      ctx.fillRect(crop.x + crop.width, crop.y, srcW - (crop.x + crop.width), crop.height);

      // Draw inscribed rectangle outline
      ctx.strokeStyle = ATELIER_CANVAS_ACCENT;
      ctx.lineWidth = Math.max(2, Math.round(srcW * 0.0025));
      ctx.strokeRect(crop.x, crop.y, crop.width, crop.height);
    } else if (viewMode === 'split') {
      // Before / After Split-Screen Comparison Mode
      canvas.width = layout.canvasWidth;
      canvas.height = layout.canvasHeight;

      const { splitX } = computeSplitDividerX(layout.canvasWidth, splitPercent);

      // Right Side (After: Auto-Leveled + Inscribed-Cropped + Framed Output)
      ctx.save();
      ctx.beginPath();
      ctx.rect(splitX, 0, layout.canvasWidth - splitX, layout.canvasHeight);
      ctx.clip();
      ctx.drawImage(processedFrameCanvas, 0, 0);
      ctx.restore();

      // Left Side (Before: Un-leveled Original Sensor aligned to the inner photo frame)
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, splitX, layout.canvasHeight);
      ctx.clip();

      // Subtle warm mat background so unframed vs framed border is clearly distinguishable
      ctx.fillStyle = ATELIER_CANVAS_MAT;
      ctx.fillRect(0, 0, layout.canvasWidth, layout.canvasHeight);

      // Draw dashed boundary where the White Border inner image sits
      ctx.strokeStyle = 'rgba(43, 35, 29, 0.25)';
      ctx.lineWidth = Math.max(1, Math.round(layout.canvasWidth * 0.0012));
      ctx.strokeRect(layout.imageX, layout.imageY, layout.imageWidth, layout.imageHeight);

      // Draw the un-leveled original sensor image at the exact same inner region for 1:1 horizon comparison
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(
        sensorCanvas,
        0,
        0,
        srcW,
        srcH,
        layout.imageX,
        layout.imageY,
        layout.imageWidth,
        layout.imageHeight
      );
      ctx.restore();

      // Draw crisp vertical split divider line & central grab handle
      ctx.save();
      ctx.strokeStyle = ATELIER_CANVAS_ACCENT;
      ctx.lineWidth = Math.max(2, Math.round(layout.canvasWidth * 0.0022));
      ctx.beginPath();
      ctx.moveTo(splitX, 0);
      ctx.lineTo(splitX, layout.canvasHeight);
      ctx.stroke();

      // Central circular handle
      const handleRadius = Math.max(14, Math.round(layout.canvasWidth * 0.016));
      const centerY = layout.imageY + layout.imageHeight / 2;
      ctx.fillStyle = ATELIER_CANVAS_INK;
      ctx.beginPath();
      ctx.arc(splitX, centerY, handleRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = Math.max(2, Math.round(layout.canvasWidth * 0.002));
      ctx.strokeStyle = ATELIER_CANVAS_ACCENT;
      ctx.stroke();

      // Left/Right arrows inside handle
      const arrowOffset = Math.round(handleRadius * 0.42);
      const arrowSize = Math.round(handleRadius * 0.26);
      ctx.strokeStyle = ATELIER_CANVAS_PAPER;
      ctx.lineWidth = Math.max(1.5, Math.round(layout.canvasWidth * 0.0015));
      ctx.beginPath();
      // Left chevron
      ctx.moveTo(splitX - arrowOffset + arrowSize, centerY - arrowSize);
      ctx.lineTo(splitX - arrowOffset, centerY);
      ctx.lineTo(splitX - arrowOffset + arrowSize, centerY + arrowSize);
      // Right chevron
      ctx.moveTo(splitX + arrowOffset - arrowSize, centerY - arrowSize);
      ctx.lineTo(splitX + arrowOffset, centerY);
      ctx.lineTo(splitX + arrowOffset - arrowSize, centerY + arrowSize);
      ctx.stroke();

      // Corner comparison labels (Measured warm scrim + crisp monospace text)
      const labelFontSize = Math.max(13, Math.round(layout.canvasWidth * 0.013));
      ctx.font = `600 ${labelFontSize}px "JetBrains Mono", monospace`;
      const padX = Math.round(labelFontSize * 0.85);
      const padY = Math.round(labelFontSize * 0.55);
      const sideMargin = Math.max(18, Math.round(layout.canvasWidth * 0.022));
      const badgeY = Math.max(18, Math.round(layout.canvasHeight * 0.025));

      const isCompactBadge = layout.canvasWidth < 800;
      const beforeText = isCompactBadge
        ? `BEFORE (${formatSignedDegrees(analysis.detectedTiltDeg, 1)})`
        : `BEFORE: UN-LEVELED (${formatSignedDegrees(analysis.detectedTiltDeg, 2)})`;
      const afterText = isCompactBadge
        ? `AFTER (${formatSignedDegrees(totalRotDeg, 1)})`
        : `AFTER: LEVELED & FRAMED (${formatSignedDegrees(totalRotDeg, 2)})`;

      const beforeW = ctx.measureText(beforeText).width + padX * 2;
      const afterW = ctx.measureText(afterText).width + padX * 2;
      const boxH = labelFontSize + padY * 2;

      // Left badge
      ctx.fillStyle = ATELIER_CANVAS_SCRIM;
      ctx.fillRect(sideMargin, badgeY, beforeW, boxH);
      ctx.fillStyle = ATELIER_CANVAS_PAPER;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(beforeText, sideMargin + padX, badgeY + boxH / 2);

      // Right label
      const rightX = layout.canvasWidth - sideMargin - afterW;
      ctx.fillStyle = ATELIER_CANVAS_SCRIM;
      ctx.fillRect(rightX, badgeY, afterW, boxH);
      ctx.fillStyle = ATELIER_CANVAS_ACCENT_SOFT;
      ctx.textAlign = 'left';
      ctx.fillText(afterText, rightX + padX, badgeY + boxH / 2);

      ctx.restore();
    } else {
      // Standard Framed White Border output
      canvas.width = layout.canvasWidth;
      canvas.height = layout.canvasHeight;
      ctx.drawImage(processedFrameCanvas, 0, 0);
    }

    // Optional composition guide, laid over the picture itself: the crop box while cropping,
    // the photo inside the mat when framed, the whole sensor frame for the original
    if (showHorizonGrid) {
      const target =
        viewMode === 'original'
          ? { x: 0, y: 0, width: canvas.width, height: canvas.height }
          : viewMode === 'geometry'
            ? crop
            : { x: layout.imageX, y: layout.imageY, width: layout.imageWidth, height: layout.imageHeight };
      drawCompositionGuide(ctx, buildCompositionGuides(gridStyle, gridOrientation, target.width, target.height), target, canvas.width);
    }


    if (viewMode === 'geometry' && onCropChange) {
      drawCropHandles(ctx, crop, srcW);
    }

    if (straightenActive && draftLine) {
      ctx.save();
      ctx.strokeStyle = ATELIER_CANVAS_ACCENT_SOFT;
      ctx.lineWidth = Math.max(2, Math.round(srcW * 0.003));
      ctx.setLineDash([Math.max(6, srcW * 0.01), Math.max(4, srcW * 0.006)]);
      ctx.beginPath();
      ctx.moveTo(draftLine.a.x, draftLine.a.y);
      ctx.lineTo(draftLine.b.x, draftLine.b.y);
      ctx.stroke();
      ctx.restore();
    }
  }, [
    sensorCanvas,
    pipeline,
    analysis,
    effectiveView,
    splitPercent,
    showHorizonGrid,
    gridStyle,
    gridOrientation,
    draftCrop,
    draftLine,
    straightenActive,
    onCropChange,
    config.backgroundColor,
  ]);

  useEffect(() => {
    const container = stageContainerRef.current;
    if (!container || !onZoomLevelChange) return;
    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const nextZoom = clamp(Number((zoomLevel - e.deltaY * 0.005).toFixed(2)), 1, 4);
      onZoomLevelChange(nextZoom);
      if (nextZoom <= 1) onPanOffsetChange?.({ x: 0, y: 0 });
    };
    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [zoomLevel, onZoomLevelChange, onPanOffsetChange]);

  /** Client point → canvas pixel (the canvas backing store is in source pixels for these views). */
  const toCanvasPoint = (clientX: number, clientY: number): Pointer | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: ((clientX - rect.left) / rect.width) * canvas.width,
      y: ((clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const cropTool = effectiveView === 'geometry' && !!onCropChange && !!pipeline && !!sensorCanvas;

  const cropHandleAt = (clientX: number, clientY: number): CropHandle | null => {
    if (!cropTool || !sensorCanvas || !pipeline) return null;
    const pt = toCanvasPoint(clientX, clientY);
    const canvas = canvasRef.current;
    if (!pt || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const crop = normalizeCrop(pipeline.crop, sensorCanvas.width, sensorCanvas.height);
    // About 12 CSS px of grab tolerance whatever the zoom
    return hitCropHandle(
      crop,
      pt.x / canvas.width,
      pt.y / canvas.height,
      12 / (rect.width || 1),
      12 / (rect.height || 1)
    );
  };

  const updateSplitFromClientX = (clientX: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0) return;
    const relX = ((clientX - rect.left) / rect.width) * 100;
    const { clampedPercent } = computeSplitDividerX(1000, relX);
    onSplitPercentChange(clampedPercent);
  };

  const computeMaxPan = useCallback((): { maxPanX: number; maxPanY: number } => {
    const canvas = canvasRef.current;
    const stage = stageContainerRef.current;
    if (!canvas || zoomLevel <= 1) return { maxPanX: 0, maxPanY: 0 };
    const baseW = canvas.offsetWidth;
    const baseH = canvas.offsetHeight;
    const stageW = stage && stage.clientWidth > 0 ? stage.clientWidth : baseW;
    const stageH = stage && stage.clientHeight > 0 ? stage.clientHeight : baseH;
    return {
      maxPanX: Math.max(0, Math.round((baseW * zoomLevel - stageW) / 2)),
      maxPanY: Math.max(0, Math.round((baseH * zoomLevel - stageH) / 2)),
    };
  }, [zoomLevel]);

  const nudgePan = useCallback(
    (dx: number, dy: number) => {
      if (!onPanOffsetChange) return;
      const { maxPanX, maxPanY } = computeMaxPan();
      onPanOffsetChange({
        x: clamp(Math.round(panOffset.x + dx), -maxPanX, maxPanX),
        y: clamp(Math.round(panOffset.y + dy), -maxPanY, maxPanY),
      });
    },
    [computeMaxPan, onPanOffsetChange, panOffset.x, panOffset.y]
  );

  useEffect(() => {
    if (!onPanOffsetChange) return;
    const clampPanToBounds = () => {
      const { maxPanX, maxPanY } = computeMaxPan();
      const x = clamp(panOffset.x, -maxPanX, maxPanX);
      const y = clamp(panOffset.y, -maxPanY, maxPanY);
      if (x !== panOffset.x || y !== panOffset.y) onPanOffsetChange({ x, y });
    };
    clampPanToBounds();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(clampPanToBounds);
    if (canvasRef.current) observer.observe(canvasRef.current);
    if (stageContainerRef.current) observer.observe(stageContainerRef.current);
    return () => observer.disconnect();
  }, [zoomLevel, panOffset.x, panOffset.y, computeMaxPan, onPanOffsetChange]);

  const capture = (e: React.PointerEvent<HTMLCanvasElement>) => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Pointer capture can fail for synthetic events; the gesture still works without it
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    if (gestureRef.current) return; // a second finger never replaces the active gesture
    const pointerId = e.pointerId;
    if (straightenActive && onStraighten) {
      const pt = toCanvasPoint(e.clientX, e.clientY);
      if (!pt) return;
      capture(e);
      gestureRef.current = { pointerId, kind: 'line', start: pt };
      setDraftLine({ a: pt, b: pt });
      return;
    }
    if (effectiveView === 'split') {
      capture(e);
      gestureRef.current = { pointerId, kind: 'split' };
      updateSplitFromClientX(e.clientX);
      return;
    }
    const handle = cropHandleAt(e.clientX, e.clientY);
    if (handle && sensorCanvas && pipeline) {
      const pt = toCanvasPoint(e.clientX, e.clientY);
      if (!pt) return;
      capture(e);
      const origin = normalizeCrop(pipeline.crop, sensorCanvas.width, sensorCanvas.height);
      gestureRef.current = { pointerId, kind: 'crop', handle, start: pt, origin };
      setDraftCrop(origin);
      return;
    }
    if (zoomLevel > 1 && onPanOffsetChange) {
      capture(e);
      gestureRef.current = {
        pointerId,
        kind: 'pan',
        clientX: e.clientX,
        clientY: e.clientY,
        offsetX: panOffset.x,
        offsetY: panOffset.y,
      };
      setIsPanning(true);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = gestureRef.current;
    if (g && g.pointerId !== e.pointerId) return;
    if (!g) {
      if (cropTool) {
        const handle = cropHandleAt(e.clientX, e.clientY);
        setHoverCursor(handle ? CROP_CURSORS[handle] : undefined);
      }
      return;
    }
    if (g.kind === 'split') {
      updateSplitFromClientX(e.clientX);
    } else if (g.kind === 'line') {
      const pt = toCanvasPoint(e.clientX, e.clientY);
      if (pt) setDraftLine({ a: g.start, b: pt });
    } else if (g.kind === 'crop') {
      const pt = toCanvasPoint(e.clientX, e.clientY);
      const canvas = canvasRef.current;
      if (!pt || !canvas) return;
      const dx = (pt.x - g.start.x) / canvas.width;
      const dy = (pt.y - g.start.y) / canvas.height;
      setDraftCrop(adjustCrop(g.origin, g.handle, dx, dy));
    } else if (g.kind === 'pan' && onPanOffsetChange) {
      const { maxPanX, maxPanY } = computeMaxPan();
      onPanOffsetChange({
        x: Math.round(clamp(g.offsetX + (e.clientX - g.clientX), -maxPanX, maxPanX)),
        y: Math.round(clamp(g.offsetY + (e.clientY - g.clientY), -maxPanY, maxPanY)),
      });
    }
  };

  const endGesture = (pointerId: number, commit: boolean) => {
    const g = gestureRef.current;
    if (!g || g.pointerId !== pointerId) return;
    gestureRef.current = null;
    setIsPanning(false);
    const crop = draftCropRef.current;
    const line = draftLineRef.current;
    if (g?.kind === 'crop') {
      // A tap leaves the box where it was; only a real change becomes a hand crop
      if (commit && crop && !sameCrop(crop, g.origin)) onCropChange?.(crop);
      setDraftCrop(null);
    } else if (g?.kind === 'line') {
      // Leaving straighten mode mid-drag (Esc) discards the line
      if (commit && line && straightenActive) {
        const rotation = rotationToStraighten(line.a.x, line.a.y, line.b.x, line.b.y);
        if (rotation !== null) onStraighten?.(rotation);
      }
      setDraftLine(null);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    endGesture(e.pointerId, true);
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    endGesture(e.pointerId, false);
  };

  const handleDoubleClick = () => {
    if (zoomLevel > 1 || panOffset.x !== 0 || panOffset.y !== 0) {
      onZoomLevelChange?.(1);
      onPanOffsetChange?.({ x: 0, y: 0 });
    }
  };

  if (loadError) {
    return (
      <div className="flex h-full w-full items-center justify-center border border-rule bg-paper-2 p-8 text-center text-sm text-error">
        {loadError}
      </div>
    );
  }

  const isTransformActive = zoomLevel !== 1 || panOffset.x !== 0 || panOffset.y !== 0;
  const cursor = straightenActive
    ? 'crosshair'
    : effectiveView === 'split'
      ? 'ew-resize'
      : hoverCursor ?? (zoomLevel > 1 ? (isPanning ? 'grabbing' : 'grab') : undefined);
  const interactive = straightenActive || effectiveView === 'split' || cropTool || zoomLevel > 1;

  return (
    <div
      ref={stageContainerRef}
      className="relative flex h-full w-full items-center justify-center overflow-hidden p-2 sm:p-4"
      data-state={pipeline ? (isProcessing ? 'processing' : 'ready') : 'loading'}
      data-view-mode={effectiveView}
    >
      {!pipeline && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted"
        >
          Analysing horizon and tone…
        </div>
      )}
      <canvas
        ref={canvasRef}
        data-testid="studio-canvas"
        aria-label={
          straightenActive
            ? `Straighten ${photo.title}: drag along a line that should be level or upright`
            : cropTool
              ? `Crop ${photo.title}: drag the box or its edges`
              : `Framed preview of ${photo.title}`
        }
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={(e) => endGesture(e.pointerId, false)}
        onDoubleClick={handleDoubleClick}
        style={{
          cursor,
          transform: isTransformActive
            ? `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoomLevel})`
            : undefined,
        }}
        className={`max-h-full max-w-full object-contain shadow-card ring-1 ring-rule transition-opacity duration-150 motion-reduce:transition-none ${
          interactive ? 'select-none touch-none' : ''
        } ${isProcessing && pipeline ? 'opacity-90' : ''}`}
      />
      {zoomLevel > 1 && onPanOffsetChange && (
        <div
          role="group"
          aria-label="Pan zoomed canvas"
          className="absolute bottom-3 right-3 z-raised grid grid-cols-3 gap-1 rounded-pill border border-rule bg-paper-2 p-1 shadow-card"
        >
          <span aria-hidden="true" />
          <button
            type="button"
            data-testid="pan-up-btn"
            aria-label="Pan up"
            onClick={() => nudgePan(0, 48)}
            className="hit-target-expand flex min-h-[28px] min-w-[28px] items-center justify-center rounded-pill border border-rule bg-paper text-ink hover:bg-paper-3"
          >
            <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <span aria-hidden="true" />
          <button
            type="button"
            data-testid="pan-left-btn"
            aria-label="Pan left"
            onClick={() => nudgePan(48, 0)}
            className="hit-target-expand flex min-h-[28px] min-w-[28px] items-center justify-center rounded-pill border border-rule bg-paper text-ink hover:bg-paper-3"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            data-testid="pan-reset-btn"
            aria-label="Center pan"
            onClick={() => onPanOffsetChange({ x: 0, y: 0 })}
            disabled={panOffset.x === 0 && panOffset.y === 0}
            className="hit-target-expand flex min-h-[28px] min-w-[28px] items-center justify-center rounded-pill border border-rule bg-paper text-ink hover:bg-paper-3 disabled:opacity-45"
          >
            <RotateCcw className="h-3 w-3" aria-hidden="true" />
          </button>
          <button
            type="button"
            data-testid="pan-right-btn"
            aria-label="Pan right"
            onClick={() => nudgePan(-48, 0)}
            className="hit-target-expand flex min-h-[28px] min-w-[28px] items-center justify-center rounded-pill border border-rule bg-paper text-ink hover:bg-paper-3"
          >
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <span aria-hidden="true" />
          <button
            type="button"
            data-testid="pan-down-btn"
            aria-label="Pan down"
            onClick={() => nudgePan(0, -48)}
            className="hit-target-expand flex min-h-[28px] min-w-[28px] items-center justify-center rounded-pill border border-rule bg-paper text-ink hover:bg-paper-3"
          >
            <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <span aria-hidden="true" />
        </div>
      )}
    </div>
  );
};

function denormalize(crop: NormalizedCrop, srcW: number, srcH: number) {
  return {
    x: Math.round(crop.x * srcW),
    y: Math.round(crop.y * srcH),
    width: Math.round(crop.width * srcW),
    height: Math.round(crop.height * srcH),
  };
}

/** Corner and edge handles for the crop box, sized to read at any source resolution. */
function drawCropHandles(ctx: CanvasRenderingContext2D, crop: CropRect, srcW: number) {
  const size = Math.max(10, Math.round(srcW * 0.014));
  const half = size / 2;
  const xs = [crop.x, crop.x + crop.width / 2, crop.x + crop.width];
  const ys = [crop.y, crop.y + crop.height / 2, crop.y + crop.height];
  ctx.save();
  ctx.fillStyle = ATELIER_CANVAS_PAPER;
  ctx.strokeStyle = ATELIER_CANVAS_ACCENT;
  ctx.lineWidth = Math.max(1.5, Math.round(srcW * 0.0015));
  for (const [i, x] of xs.entries()) {
    for (const [j, y] of ys.entries()) {
      if (i === 1 && j === 1) continue;
      ctx.fillRect(x - half, y - half, size, size);
      ctx.strokeRect(x - half, y - half, size, size);
    }
  }
  ctx.restore();
}

/**
 * Strokes a composition guide over `rect`. Each path gets a light halo under a dark core,
 * so the lines read over both bright skies and deep shadows.
 */
function drawCompositionGuide(
  ctx: CanvasRenderingContext2D,
  paths: GuidePath[],
  rect: { x: number; y: number; width: number; height: number },
  canvasWidth: number
) {
  const base = Math.max(1, Math.round(canvasWidth * 0.0012));
  const trace = (emphasis: GuidePath['emphasis']) => {
    ctx.beginPath();
    for (const p of paths) {
      if (p.emphasis !== emphasis) continue;
      p.points.forEach(([nx, ny], i) => {
        const x = rect.x + nx * rect.width;
        const y = rect.y + ny * rect.height;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
    }
  };
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const [emphasis, halo, core, width] of [
    ['minor', 'rgba(244, 240, 232, 0.28)', 'rgba(43, 35, 29, 0.38)', base],
    ['major', 'rgba(244, 240, 232, 0.55)', 'rgba(59, 88, 120, 0.9)', base * 1.5],
  ] as const) {
    trace(emphasis);
    ctx.strokeStyle = halo;
    ctx.lineWidth = width * 2.5;
    ctx.stroke();
    ctx.strokeStyle = core;
    ctx.lineWidth = width;
    ctx.stroke();
  }
  ctx.restore();
}
