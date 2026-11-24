import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, RotateCcw } from 'lucide-react';
import {
  AutoCorrectAnalysis,
  CropRect,
  DEFAULT_AUTO_CORRECT_ANALYSIS,
  DEFAULT_LEVELING_ANALYSIS,
  FrameLayout,
  LevelingAnalysis,
  PipelineConfig,
  PipelineTelemetryUpdate,
  analyzeAutoCorrection,
  applyAutoCorrectionToRgba,
  applyProjectiveKeystoneWarpToRgba,
  clamp,
  computeFrameLayout,
  computeInscribedCrop,
  computeSmartInscribedCrop,
  computeSplitDividerX,
  detectHorizonTiltFromGrayscale,
  formatExifSummaryLine,
  formatSignedDegrees,
  getScaledDimensionsWithinBudget,
} from '../utils/geometry';
import { StudioPhotoItem } from '../utils/samplePhotos';

export type CanvasViewMode = 'framed' | 'split' | 'geometry' | 'original';

const ATELIER_CANVAS_INK = '#2b231d';
const ATELIER_CANVAS_SCRIM = 'rgba(43, 35, 29, 0.86)';
const ATELIER_CANVAS_DIM = 'rgba(43, 35, 29, 0.58)';
const ATELIER_CANVAS_PAPER = '#f5f2eb';
const ATELIER_CANVAS_ACCENT = '#3b5878';
const ATELIER_CANVAS_ACCENT_SOFT = '#93b4d4';
const ATELIER_CANVAS_MAT = '#e6e1d7';

interface SaliencyBuffer {
  gray: Uint8Array;
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
}

interface SensorAnalysisResult {
  sensorCanvas: HTMLCanvasElement;
  analysis: LevelingAnalysis;
  autoCorrect: AutoCorrectAnalysis;
  saliency: SaliencyBuffer | null;
}

interface ProcessedFramePipeline {
  crop: CropRect;
  layout: FrameLayout;
  totalRotDeg: number;
  rotCanvas: HTMLCanvasElement;
  processedFrameCanvas: HTMLCanvasElement;
}

function buildSensorAndAnalysis(
  img: HTMLImageElement,
  photo: StudioPhotoItem,
  maxAutoAngleDeg: number,
  pixelAreaBudget?: number,
  wbProfile: PipelineConfig['wbProfile'] = 'ambient'
): SensorAnalysisResult | null {
  const rawW = img.naturalWidth || 1600;
  const rawH = img.naturalHeight || 1200;

  const { width: scaledW, height: scaledH } = getScaledDimensionsWithinBudget(
    rawW,
    rawH,
    pixelAreaBudget
  );

  const tiltDeg = photo.simulatedSensorTiltDeg || 0;
  const baseCrop = computeInscribedCrop(scaledW, scaledH, tiltDeg, true);

  const offscreen = document.createElement('canvas');
  offscreen.width = baseCrop.width;
  offscreen.height = baseCrop.height;
  const ctx = offscreen.getContext('2d');
  if (!ctx) return null;

  ctx.save();
  ctx.translate(offscreen.width / 2, offscreen.height / 2);
  ctx.rotate((tiltDeg * Math.PI) / 180);
  ctx.drawImage(img, -scaledW / 2, -scaledH / 2, scaledW, scaledH);
  ctx.restore();

  const detectScale = Math.min(1, 640 / Math.max(offscreen.width, offscreen.height));
  const dw = Math.max(16, Math.round(offscreen.width * detectScale));
  const dh = Math.max(16, Math.round(offscreen.height * detectScale));

  const detectCanvas = document.createElement('canvas');
  detectCanvas.width = dw;
  detectCanvas.height = dh;
  const dCtx = detectCanvas.getContext('2d');
  let detected: LevelingAnalysis = DEFAULT_LEVELING_ANALYSIS;
  let autoCorr: AutoCorrectAnalysis = DEFAULT_AUTO_CORRECT_ANALYSIS;
  let saliency: SaliencyBuffer | null = null;

  if (dCtx) {
    dCtx.drawImage(offscreen, 0, 0, dw, dh);
    const imgData = dCtx.getImageData(0, 0, dw, dh).data;
    const gray = new Uint8Array(dw * dh);
    for (let i = 0; i < dw * dh; i++) {
      const idx = i * 4;
      gray[i] = Math.round(
        0.299 * imgData[idx] + 0.587 * imgData[idx + 1] + 0.114 * imgData[idx + 2]
      );
    }
    saliency = { gray, rgba: imgData, width: dw, height: dh };
    detected = detectHorizonTiltFromGrayscale(gray, dw, dh, maxAutoAngleDeg);
    autoCorr = analyzeAutoCorrection(imgData, dw, dh, wbProfile);
  }

  return { sensorCanvas: offscreen, analysis: detected, autoCorrect: autoCorr, saliency };
}

function buildProcessedFramePipeline(
  sensorCanvas: HTMLCanvasElement,
  photo: StudioPhotoItem,
  config: PipelineConfig,
  analysis: LevelingAnalysis,
  autoCorrect: AutoCorrectAnalysis,
  saliency?: { gray: Uint8Array; width: number; height: number } | null
): ProcessedFramePipeline | null {
  const srcW = sensorCanvas.width;
  const srcH = sensorCanvas.height;

  const autoRot = config.autoLevelEnabled ? analysis.appliedRotationDeg : 0;
  const totalRotDeg = Number((autoRot + config.manualAngleOffsetDeg).toFixed(2));
  const autoKeystone =
    (config.keystoneWarpEnabled ?? true) ? (analysis.appliedKeystoneDeg ?? 0) : 0;
  const totalKeystoneDeg = Number(
    (autoKeystone + (config.manualKeystoneDeg ?? 0)).toFixed(2)
  );
  const corrEnabled = config.autoCorrectEnabled ?? true;
  const corrStrength = config.autoCorrectStrength ?? 75;

  const crop = config.autoCropEnabled
    ? computeSmartInscribedCrop(
        srcW,
        srcH,
        totalRotDeg,
        config.preserveAspectRatioInCrop,
        undefined,
        saliency?.gray,
        saliency?.width,
        saliency?.height
      )
    : {
        x: 0,
        y: 0,
        width: srcW,
        height: srcH,
        scaleFactor: 1,
        areaRetainedPercent: 100,
      };

  const layout = computeFrameLayout(
    crop.width,
    crop.height,
    config.aspectPreset,
    config.paddingPercent,
    config.renderExifCaption,
    config.pixelAreaBudget
  );

  const rotCanvas = document.createElement('canvas');
  rotCanvas.width = srcW;
  rotCanvas.height = srcH;
  const rCtx = rotCanvas.getContext('2d');
  if (!rCtx) return null;

  rCtx.save();
  rCtx.imageSmoothingEnabled = true;
  rCtx.imageSmoothingQuality = 'high';
  rCtx.translate(srcW / 2, srcH / 2);
  rCtx.rotate((totalRotDeg * Math.PI) / 180);
  rCtx.drawImage(sensorCanvas, -srcW / 2, -srcH / 2);
  rCtx.restore();

  const needsKeystone = Math.abs(totalKeystoneDeg) >= 0.02;
  const needsAutoCorr = corrEnabled && corrStrength > 0;
  if ((needsKeystone || needsAutoCorr) && crop.width > 0 && crop.height > 0) {
    const croppedData = rCtx.getImageData(crop.x, crop.y, crop.width, crop.height);
    if (needsKeystone) {
      applyProjectiveKeystoneWarpToRgba(
        croppedData.data,
        crop.width,
        crop.height,
        totalKeystoneDeg
      );
    }
    if (needsAutoCorr) {
      applyAutoCorrectionToRgba(
        croppedData.data,
        crop.width,
        crop.height,
        autoCorrect,
        corrStrength
      );
    }
    rCtx.putImageData(croppedData, crop.x, crop.y);
  }

  const processedFrameCanvas = document.createElement('canvas');
  processedFrameCanvas.width = layout.canvasWidth;
  processedFrameCanvas.height = layout.canvasHeight;
  const pCtx = processedFrameCanvas.getContext('2d');
  if (!pCtx) return null;

  pCtx.fillStyle = config.backgroundColor;
  pCtx.fillRect(0, 0, layout.canvasWidth, layout.canvasHeight);

  pCtx.imageSmoothingEnabled = true;
  pCtx.imageSmoothingQuality = 'high';
  pCtx.drawImage(
    rotCanvas,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    layout.imageX,
    layout.imageY,
    layout.imageWidth,
    layout.imageHeight
  );

  if (config.renderExifCaption) {
    const captionText = formatExifSummaryLine(photo.exif);
    if (captionText) {
      let fontSize = Math.max(12, Math.round(layout.canvasHeight * 0.0145));
      if (layout.borderBottom >= fontSize) {
        const isDarkBg = isHexColorDark(config.backgroundColor);
        pCtx.fillStyle = isDarkBg ? '#b3ada3' : '#4a433c';
        pCtx.font = `500 ${fontSize}px "JetBrains Mono", monospace`;
        pCtx.textAlign = 'center';
        pCtx.textBaseline = 'middle';

        const maxCaptionWidth = Math.max(
          10,
          layout.canvasWidth - Math.max(32, Math.round(layout.canvasWidth * 0.08))
        );
        let textWidth = pCtx.measureText(captionText).width;

        if (textWidth > maxCaptionWidth) {
          const scaledFontSize = Math.max(
            9,
            Math.floor(fontSize * (maxCaptionWidth / textWidth))
          );
          if (scaledFontSize < fontSize) {
            fontSize = scaledFontSize;
            pCtx.font = `500 ${fontSize}px "JetBrains Mono", monospace`;
            textWidth = pCtx.measureText(captionText).width;
          }
        }

        let finalCaption = captionText;
        if (textWidth > maxCaptionWidth) {
          while (
            finalCaption.length > 3 &&
            pCtx.measureText(finalCaption + '…').width > maxCaptionWidth
          ) {
            finalCaption = finalCaption.slice(0, -1);
          }
          finalCaption += '…';
        }

        const captionY = layout.imageY + layout.imageHeight + layout.borderBottom * 0.52;
        pCtx.fillText(finalCaption, layout.canvasWidth / 2, captionY);
      }
    }
  }

  return {
    crop,
    layout,
    totalRotDeg,
    rotCanvas,
    processedFrameCanvas,
  };
}

/**
 * Renders a queued photo offscreen through the full leveling, keystone warp, smart inscribed-crop,
 * tone-correction, and framing pipeline for batch JPEG export.
 */
export async function renderPhotoToFramedCanvas(
  photo: StudioPhotoItem,
  config: PipelineConfig
): Promise<{ canvas: HTMLCanvasElement; sourceSize: { width: number; height: number } }> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const loader = new Image();
    loader.crossOrigin = 'anonymous';
    loader.referrerPolicy = 'no-referrer';
    loader.onload = () => resolve(loader);
    loader.onerror = () => reject(new Error(`Unable to decode ${photo.fileName}`));
    loader.src = photo.src;
  });

  const sensorResult = buildSensorAndAnalysis(
    img,
    photo,
    config.maxAutoAngleDeg,
    config.pixelAreaBudget,
    config.wbProfile ?? 'ambient'
  );
  if (!sensorResult) {
    throw new Error(`Canvas context unavailable for ${photo.fileName}`);
  }

  const pipeline = buildProcessedFramePipeline(
    sensorResult.sensorCanvas,
    photo,
    config,
    sensorResult.analysis,
    sensorResult.autoCorrect,
    sensorResult.saliency
  );
  if (!pipeline) {
    throw new Error(`Unable to render framed output for ${photo.fileName}`);
  }

  return {
    canvas: pipeline.processedFrameCanvas,
    sourceSize: {
      width: sensorResult.sensorCanvas.width,
      height: sensorResult.sensorCanvas.height,
    },
  };
}

interface StudioCanvasProps {
  photo: StudioPhotoItem;
  config: PipelineConfig;
  viewMode: CanvasViewMode;
  splitPercent: number;
  onSplitPercentChange: (pct: number) => void;
  showHorizonGrid: boolean;
  onAnalysisUpdate: (telemetry: PipelineTelemetryUpdate) => void;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  onImageLoaded?: (loaded: boolean) => void;
  exportCanvasRef?: React.MutableRefObject<(() => HTMLCanvasElement | null) | null>;
  zoomLevel?: number;
  panOffset?: { x: number; y: number };
  onPanOffsetChange?: (offset: { x: number; y: number }) => void;
  onZoomLevelChange?: (zoom: number) => void;
}

export const StudioCanvas: React.FC<StudioCanvasProps> = ({
  photo,
  config,
  viewMode,
  splitPercent,
  onSplitPercentChange,
  showHorizonGrid,
  onAnalysisUpdate,
  canvasRef,
  onImageLoaded,
  exportCanvasRef,
  zoomLevel = 1,
  panOffset = { x: 0, y: 0 },
  onPanOffsetChange,
  onZoomLevelChange,
}) => {
  const [sensorCanvas, setSensorCanvas] = useState<HTMLCanvasElement | null>(null);
  const [analysis, setAnalysis] = useState<LevelingAnalysis>(DEFAULT_LEVELING_ANALYSIS);
  const [autoCorrect, setAutoCorrect] = useState<AutoCorrectAnalysis>(
    DEFAULT_AUTO_CORRECT_ANALYSIS
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isDraggingSplit, setIsDraggingSplit] = useState<boolean>(false);
  const [isPanning, setIsPanning] = useState<boolean>(false);

  const stageContainerRef = useRef<HTMLDivElement | null>(null);
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ clientX: 0, clientY: 0, offsetX: 0, offsetY: 0 });
  const callbackRef = useRef(onAnalysisUpdate);
  callbackRef.current = onAnalysisUpdate;

  const saliencyBufferRef = useRef<{
    gray: Uint8Array;
    rgba: Uint8ClampedArray;
    width: number;
    height: number;
  } | null>(null);

  // Cache processed full-resolution rotCanvas and framed output across interactive split drags
  const pipelineCacheRef = useRef<{
    sensorCanvas: HTMLCanvasElement;
    cacheKey: string;
    crop: CropRect;
    layout: FrameLayout;
    totalRotDeg: number;
    rotCanvas: HTMLCanvasElement;
    processedFrameCanvas: HTMLCanvasElement;
  } | null>(null);

  // Step 1: Load source photo, apply simulated camera sensor tilt if configured, and run Scharr/Radon Horizon Detection
  useEffect(() => {
    let cancelled = false;
    setSensorCanvas(null);
    setLoadError(null);
    if (exportCanvasRef) exportCanvasRef.current = null;
    const initialCanvas = canvasRef.current;
    if (initialCanvas) {
      const initCtx = initialCanvas.getContext('2d');
      initCtx?.clearRect(0, 0, initialCanvas.width, initialCanvas.height);
    }
    onImageLoaded?.(false);

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';

    img.onload = () => {
      if (cancelled) return;
      const result = buildSensorAndAnalysis(
        img,
        photo,
        config.maxAutoAngleDeg,
        config.pixelAreaBudget
      );
      if (!result) return;
      saliencyBufferRef.current = result.saliency;
      setSensorCanvas(result.sensorCanvas);
      setAnalysis(result.analysis);
      setAutoCorrect(result.autoCorrect);
    };

    img.onerror = () => {
      if (!cancelled) {
        setLoadError('Unable to decode image buffer.');
        onImageLoaded?.(false);
      }
    };

    img.src = photo.src;

    return () => {
      cancelled = true;
      if (exportCanvasRef) exportCanvasRef.current = null;
      if (canvasRef.current) {
        const c = canvasRef.current;
        const cCtx = c.getContext('2d');
        cCtx?.clearRect(0, 0, c.width, c.height);
      }
    };
  }, [
    photo.id,
    photo.src,
    photo.simulatedSensorTiltDeg,
    config.maxAutoAngleDeg,
    config.pixelAreaBudget,
    onImageLoaded,
  ]);

  // Step 2: Render the active pipeline stage onto the visible studio canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !sensorCanvas) {
      if (exportCanvasRef) exportCanvasRef.current = null;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx?.clearRect(0, 0, canvas.width, canvas.height);
      }
      onImageLoaded?.(false);
      return;
    }

    const srcW = sensorCanvas.width;
    const srcH = sensorCanvas.height;

    const autoRot = config.autoLevelEnabled ? analysis.appliedRotationDeg : 0;
    const totalRotDeg = Number((autoRot + config.manualAngleOffsetDeg).toFixed(2));
    const autoKeystone =
      (config.keystoneWarpEnabled ?? true) ? (analysis.appliedKeystoneDeg ?? 0) : 0;
    const totalKeystoneDeg = Number(
      (autoKeystone + (config.manualKeystoneDeg ?? 0)).toFixed(2)
    );
    const corrEnabled = config.autoCorrectEnabled ?? true;
    const corrStrength = config.autoCorrectStrength ?? 75;
    const activeWbProfile = config.wbProfile ?? 'ambient';

    const sal = saliencyBufferRef.current;
    const activeAutoCorrect =
      sal && (autoCorrect.wbProfile ?? 'ambient') !== activeWbProfile
        ? analyzeAutoCorrection(sal.rgba, sal.width, sal.height, activeWbProfile)
        : autoCorrect;

    if (activeAutoCorrect !== autoCorrect) {
      setAutoCorrect(activeAutoCorrect);
    }

    const pipelineKey = [
      photo.id,
      `${srcW}x${srcH}`,
      totalRotDeg,
      totalKeystoneDeg,
      config.autoCropEnabled,
      config.preserveAspectRatioInCrop,
      config.aspectPreset,
      config.paddingPercent,
      config.renderExifCaption,
      config.pixelAreaBudget,
      config.backgroundColor,
      corrEnabled,
      corrStrength,
      activeWbProfile,
      activeAutoCorrect.exposureEv,
      activeAutoCorrect.contrast,
      activeAutoCorrect.shadows,
      activeAutoCorrect.highlights,
      activeAutoCorrect.wbTempShift,
      activeAutoCorrect.wbTintShift,
      photo.exif.cameraModel,
      photo.exif.lensModel,
      photo.exif.focalLength,
    ].join('|');

    if (
      !pipelineCacheRef.current ||
      pipelineCacheRef.current.sensorCanvas !== sensorCanvas ||
      pipelineCacheRef.current.cacheKey !== pipelineKey
    ) {
      const pipeline = buildProcessedFramePipeline(
        sensorCanvas,
        photo,
        config,
        analysis,
        activeAutoCorrect,
        sal
      );
      if (!pipeline) {
        if (exportCanvasRef) exportCanvasRef.current = null;
        onImageLoaded?.(false);
        return;
      }
      pipelineCacheRef.current = {
        sensorCanvas,
        cacheKey: pipelineKey,
        crop: pipeline.crop,
        layout: pipeline.layout,
        totalRotDeg: pipeline.totalRotDeg,
        rotCanvas: pipeline.rotCanvas,
        processedFrameCanvas: pipeline.processedFrameCanvas,
      };

      callbackRef.current({
        analysis,
        crop: pipeline.crop,
        layout: pipeline.layout,
        sourceSize: { width: srcW, height: srcH },
        autoCorrect: activeAutoCorrect,
      });
    }

    if (exportCanvasRef) {
      exportCanvasRef.current = () => pipelineCacheRef.current?.processedFrameCanvas ?? null;
    }

    const { crop, layout, rotCanvas, processedFrameCanvas } = pipelineCacheRef.current;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      if (exportCanvasRef) exportCanvasRef.current = null;
      onImageLoaded?.(false);
      return;
    }

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

    // Optional alignment grid overlay
    if (showHorizonGrid) {
      const w = canvas.width;
      const h = canvas.height;
      ctx.save();
      ctx.strokeStyle = 'rgba(59, 88, 120, 0.65)';
      ctx.lineWidth = Math.max(1, Math.round(w * 0.0012));

      // Center horizontal & vertical reference lines
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.moveTo(w / 2, 0);
      ctx.lineTo(w / 2, h);
      ctx.stroke();

      // Rule of thirds
      ctx.strokeStyle = 'rgba(43, 35, 29, 0.22)';
      ctx.beginPath();
      ctx.moveTo(0, h / 3);
      ctx.lineTo(w, h / 3);
      ctx.moveTo(0, (2 * h) / 3);
      ctx.lineTo(w, (2 * h) / 3);
      ctx.moveTo(w / 3, 0);
      ctx.lineTo(w / 3, h);
      ctx.moveTo((2 * w) / 3, 0);
      ctx.lineTo((2 * w) / 3, h);
      ctx.stroke();
      ctx.restore();
    }

    onImageLoaded?.(true);

    return () => {
      if (exportCanvasRef) exportCanvasRef.current = null;
      onImageLoaded?.(false);
    };
  }, [
    sensorCanvas,
    analysis,
    autoCorrect,
    config,
    viewMode,
    splitPercent,
    showHorizonGrid,
    photo.exif,
    canvasRef,
    exportCanvasRef,
    onImageLoaded,
  ]);

  useEffect(() => {
    const container = stageContainerRef.current;
    if (!container || !onZoomLevelChange) return;

    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const nextZoom = clamp(Number((zoomLevel - e.deltaY * 0.005).toFixed(2)), 1, 4);
      onZoomLevelChange(nextZoom);
      if (nextZoom <= 1) {
        onPanOffsetChange?.({ x: 0, y: 0 });
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [zoomLevel, onZoomLevelChange, onPanOffsetChange]);

  const updateSplitFromClientX = (clientX: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0) return;
    const relX = ((clientX - rect.left) / rect.width) * 100;
    const { clampedPercent } = computeSplitDividerX(1000, relX);
    onSplitPercentChange(clampedPercent);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    if (viewMode === 'split') {
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Ignore if pointer capture fails
      }
      setIsDraggingSplit(true);
      updateSplitFromClientX(e.clientX);
      return;
    }

    if (zoomLevel > 1 && onPanOffsetChange) {
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Ignore if pointer capture fails
      }
      isPanningRef.current = true;
      setIsPanning(true);
      panStartRef.current = {
        clientX: e.clientX,
        clientY: e.clientY,
        offsetX: panOffset.x,
        offsetY: panOffset.y,
      };
    }
  };

  const computeMaxPan = useCallback((): { maxPanX: number; maxPanY: number } => {
    const canvas = canvasRef.current;
    const stage = stageContainerRef.current;
    if (!canvas || zoomLevel <= 1) {
      return { maxPanX: 0, maxPanY: 0 };
    }
    const baseW = canvas.offsetWidth;
    const baseH = canvas.offsetHeight;
    const scaledW = baseW * zoomLevel;
    const scaledH = baseH * zoomLevel;
    const stageW = stage && stage.clientWidth > 0 ? stage.clientWidth : baseW;
    const stageH = stage && stage.clientHeight > 0 ? stage.clientHeight : baseH;
    return {
      maxPanX: Math.max(0, Math.round((scaledW - stageW) / 2)),
      maxPanY: Math.max(0, Math.round((scaledH - stageH) / 2)),
    };
  }, [canvasRef, zoomLevel]);

  const nudgePan = useCallback(
    (dx: number, dy: number) => {
      if (!onPanOffsetChange) return;
      const { maxPanX, maxPanY } = computeMaxPan();
      const nextX = clamp(Math.round(panOffset.x + dx), -maxPanX, maxPanX);
      const nextY = clamp(Math.round(panOffset.y + dy), -maxPanY, maxPanY);
      onPanOffsetChange({ x: nextX, y: nextY });
    },
    [computeMaxPan, onPanOffsetChange, panOffset.x, panOffset.y]
  );

  useEffect(() => {
    if (!onPanOffsetChange) return;

    const clampPanToBounds = () => {
      const { maxPanX, maxPanY } = computeMaxPan();
      const clampedX = clamp(panOffset.x, -maxPanX, maxPanX);
      const clampedY = clamp(panOffset.y, -maxPanY, maxPanY);
      if (clampedX !== panOffset.x || clampedY !== panOffset.y) {
        onPanOffsetChange({ x: clampedX, y: clampedY });
      }
    };

    clampPanToBounds();

    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => {
      clampPanToBounds();
    });
    if (canvasRef.current) observer.observe(canvasRef.current);
    if (stageContainerRef.current) observer.observe(stageContainerRef.current);

    return () => {
      observer.disconnect();
    };
  }, [zoomLevel, panOffset.x, panOffset.y, computeMaxPan, onPanOffsetChange, canvasRef]);

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (viewMode === 'split' && isDraggingSplit) {
      updateSplitFromClientX(e.clientX);
      return;
    }

    if (isPanningRef.current && onPanOffsetChange) {
      const { maxPanX, maxPanY } = computeMaxPan();
      const nextX = clamp(
        panStartRef.current.offsetX + (e.clientX - panStartRef.current.clientX),
        -maxPanX,
        maxPanX
      );
      const nextY = clamp(
        panStartRef.current.offsetY + (e.clientY - panStartRef.current.clientY),
        -maxPanY,
        maxPanY
      );
      onPanOffsetChange({ x: Math.round(nextX), y: Math.round(nextY) });
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDraggingSplit && !isPanningRef.current) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setIsDraggingSplit(false);
    isPanningRef.current = false;
    setIsPanning(false);
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setIsDraggingSplit(false);
    isPanningRef.current = false;
    setIsPanning(false);
  };

  const handleLostPointerCapture = () => {
    setIsDraggingSplit(false);
    isPanningRef.current = false;
    setIsPanning(false);
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

  return (
    <div
      ref={stageContainerRef}
      className="relative flex h-full w-full items-center justify-center overflow-hidden p-2 sm:p-4"
      data-state={sensorCanvas ? 'ready' : 'loading'}
      data-view-mode={viewMode}
    >
      {!sensorCanvas && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted"
        >
          Analyzing horizon and tonal curves…
        </div>
      )}
      <canvas
        ref={canvasRef}
        data-testid="studio-canvas"
        aria-label={`Framed preview of ${photo.title}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={handleLostPointerCapture}
        onDoubleClick={handleDoubleClick}
        style={
          isTransformActive
            ? {
                transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoomLevel})`,
              }
            : undefined
        }
        className={`max-h-full max-w-full object-contain shadow-card ring-1 ring-rule transition-opacity duration-150 motion-reduce:transition-none ${
          viewMode === 'split'
            ? 'cursor-ew-resize select-none touch-none'
            : zoomLevel > 1
              ? `${isPanning ? 'cursor-grabbing' : 'cursor-grab'} select-none touch-none`
              : ''
        }`}
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


function isHexColorDark(hex: string): boolean {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return false;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  return luma < 128;
}
