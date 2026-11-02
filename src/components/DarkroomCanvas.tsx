import React, { useEffect, useRef, useState } from 'react';
import {
  CropRect,
  FrameLayout,
  LevelingAnalysis,
  PipelineConfig,
  computeFrameLayout,
  computeInscribedCrop,
  computeSplitDividerX,
  detectHorizonTiltFromGrayscale,
  formatExifSummaryLine,
} from '../utils/geometry';
import { StudioPhotoItem } from '../utils/samplePhotos';

export type CanvasViewMode = 'framed' | 'split' | 'geometry' | 'original';

interface DarkroomCanvasProps {
  photo: StudioPhotoItem;
  config: PipelineConfig;
  viewMode: CanvasViewMode;
  splitPercent: number;
  onSplitPercentChange: (pct: number) => void;
  showHorizonGrid: boolean;
  onAnalysisUpdate: (
    analysis: LevelingAnalysis,
    crop: CropRect,
    layout: FrameLayout,
    sourceSize: { width: number; height: number }
  ) => void;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  onImageLoaded?: (loaded: boolean) => void;
  exportCanvasRef?: React.MutableRefObject<(() => HTMLCanvasElement | null) | null>;
}

export const DarkroomCanvas: React.FC<DarkroomCanvasProps> = ({
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
}) => {
  const [sensorCanvas, setSensorCanvas] = useState<HTMLCanvasElement | null>(null);
  const [analysis, setAnalysis] = useState<LevelingAnalysis>({
    detectedTiltDeg: 0,
    appliedRotationDeg: 0,
    confidence: 0,
    strongEdgeCount: 0,
  });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isDraggingSplit, setIsDraggingSplit] = useState<boolean>(false);

  const callbackRef = useRef(onAnalysisUpdate);
  callbackRef.current = onAnalysisUpdate;

  // Step 1: Load source photo, apply simulated camera sensor tilt if configured, and run Sobel/Radon Horizon Detection
  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    onImageLoaded?.(false);

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';

    img.onload = () => {
      if (cancelled) return;

      const rawW = img.naturalWidth || 1600;
      const rawH = img.naturalHeight || 1200;

      // Create the tilted sensor frame if simulatedSensorTiltDeg != 0
      const tiltDeg = photo.simulatedSensorTiltDeg || 0;
      const baseCrop = computeInscribedCrop(rawW, rawH, tiltDeg, true);

      const offscreen = document.createElement('canvas');
      offscreen.width = baseCrop.width;
      offscreen.height = baseCrop.height;
      const ctx = offscreen.getContext('2d');
      if (!ctx) return;

      ctx.save();
      ctx.translate(offscreen.width / 2, offscreen.height / 2);
      ctx.rotate((tiltDeg * Math.PI) / 180);
      ctx.drawImage(img, -rawW / 2, -rawH / 2, rawW, rawH);
      ctx.restore();

      // Downscale to <= 480px on longest side for fast, deterministic horizon detection
      const detectScale = Math.min(1, 480 / Math.max(offscreen.width, offscreen.height));
      const dw = Math.max(16, Math.round(offscreen.width * detectScale));
      const dh = Math.max(16, Math.round(offscreen.height * detectScale));

      const detectCanvas = document.createElement('canvas');
      detectCanvas.width = dw;
      detectCanvas.height = dh;
      const dCtx = detectCanvas.getContext('2d');
      let detected: LevelingAnalysis = {
        detectedTiltDeg: 0,
        appliedRotationDeg: 0,
        confidence: 0,
        strongEdgeCount: 0,
      };

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
        detected = detectHorizonTiltFromGrayscale(gray, dw, dh, config.maxAutoAngleDeg);
      }

      setSensorCanvas(offscreen);
      setAnalysis(detected);
      onImageLoaded?.(true);
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
    };
  }, [photo.id, photo.src, photo.simulatedSensorTiltDeg, config.maxAutoAngleDeg, onImageLoaded]);

  // Step 2: Render the active pipeline stage onto the visible darkroom canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !sensorCanvas) return;

    const srcW = sensorCanvas.width;
    const srcH = sensorCanvas.height;

    const autoRot = config.autoLevelEnabled ? analysis.appliedRotationDeg : 0;
    const totalRotDeg = Number((autoRot + config.manualAngleOffsetDeg).toFixed(2));

    const crop = config.autoCropEnabled
      ? computeInscribedCrop(srcW, srcH, totalRotDeg, config.preserveAspectRatioInCrop)
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
      config.renderExifCaption
    );

    callbackRef.current(analysis, crop, layout, { width: srcW, height: srcH });

    // Create rotated intermediate canvas
    const rotCanvas = document.createElement('canvas');
    rotCanvas.width = srcW;
    rotCanvas.height = srcH;
    const rCtx = rotCanvas.getContext('2d');
    if (!rCtx) return;

    rCtx.fillStyle = config.backgroundColor;
    rCtx.fillRect(0, 0, srcW, srcH);
    rCtx.save();
    rCtx.translate(srcW / 2, srcH / 2);
    rCtx.rotate((totalRotDeg * Math.PI) / 180);
    rCtx.drawImage(sensorCanvas, -srcW / 2, -srcH / 2);
    rCtx.restore();

    const drawProcessedFrame = (targetCtx: CanvasRenderingContext2D) => {
      // 1. Fill border background
      targetCtx.fillStyle = config.backgroundColor;
      targetCtx.fillRect(0, 0, layout.canvasWidth, layout.canvasHeight);

      // 2. Draw cropped inner photograph
      targetCtx.imageSmoothingEnabled = true;
      targetCtx.imageSmoothingQuality = 'high';
      targetCtx.drawImage(
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

      // 3. Optional EXIF typographic caption in bottom border
      if (config.renderExifCaption) {
        const captionText = formatExifSummaryLine(photo.exif);
        if (captionText) {
          const isDarkBg = isHexColorDark(config.backgroundColor);
          targetCtx.fillStyle = isDarkBg ? '#a1a1aa' : '#3f3f46';
          let fontSize = Math.max(12, Math.round(layout.canvasHeight * 0.0145));
          targetCtx.font = `500 ${fontSize}px "JetBrains Mono", monospace`;
          targetCtx.textAlign = 'center';
          targetCtx.textBaseline = 'middle';

          // Measure caption and ensure rendered width fits within canvas boundaries
          const maxCaptionWidth = Math.max(
            10,
            layout.canvasWidth - Math.max(32, Math.round(layout.canvasWidth * 0.08))
          );
          let textWidth = targetCtx.measureText(captionText).width;

          if (textWidth > maxCaptionWidth) {
            const scaledFontSize = Math.max(
              9,
              Math.floor(fontSize * (maxCaptionWidth / textWidth))
            );
            if (scaledFontSize < fontSize) {
              fontSize = scaledFontSize;
              targetCtx.font = `500 ${fontSize}px "JetBrains Mono", monospace`;
              textWidth = targetCtx.measureText(captionText).width;
            }
          }

          let finalCaption = captionText;
          if (textWidth > maxCaptionWidth) {
            while (
              finalCaption.length > 3 &&
              targetCtx.measureText(finalCaption + '…').width > maxCaptionWidth
            ) {
              finalCaption = finalCaption.slice(0, -1);
            }
            finalCaption += '…';
          }

          const captionY = layout.imageY + layout.imageHeight + layout.borderBottom * 0.52;
          targetCtx.fillText(finalCaption, layout.canvasWidth / 2, captionY);
        }
      }
    };

    // Expose offscreen framed canvas generator for clean export without inspection overlays
    if (exportCanvasRef) {
      exportCanvasRef.current = () => {
        const offscreen = document.createElement('canvas');
        offscreen.width = layout.canvasWidth;
        offscreen.height = layout.canvasHeight;
        const oCtx = offscreen.getContext('2d');
        if (!oCtx) return null;
        drawProcessedFrame(oCtx);
        return offscreen;
      };
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (viewMode === 'original') {
      canvas.width = srcW;
      canvas.height = srcH;
      ctx.drawImage(sensorCanvas, 0, 0);
    } else if (viewMode === 'geometry') {
      // Show rotated buffer + dimmed corner wedges + bright inscribed rectangle box
      canvas.width = srcW;
      canvas.height = srcH;
      ctx.drawImage(rotCanvas, 0, 0);

      // Dim outside the inscribed crop rectangle
      ctx.fillStyle = 'rgba(9, 9, 11, 0.68)';
      ctx.fillRect(0, 0, srcW, crop.y);
      ctx.fillRect(0, crop.y + crop.height, srcW, srcH - (crop.y + crop.height));
      ctx.fillRect(0, crop.y, crop.x, crop.height);
      ctx.fillRect(crop.x + crop.width, crop.y, srcW - (crop.x + crop.width), crop.height);

      // Draw inscribed rectangle outline
      ctx.strokeStyle = '#3b82f6';
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
      drawProcessedFrame(ctx);
      ctx.restore();

      // Left Side (Before: Un-leveled Original Sensor aligned to the inner photo frame)
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, splitX, layout.canvasHeight);
      ctx.clip();

      // Subtle darkroom matte background so unframed vs framed border is clearly distinguishable
      ctx.fillStyle = '#141418';
      ctx.fillRect(0, 0, layout.canvasWidth, layout.canvasHeight);

      // Draw dashed boundary where the White Border inner image sits
      ctx.strokeStyle = 'rgba(161, 161, 170, 0.28)';
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
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = Math.max(2, Math.round(layout.canvasWidth * 0.0022));
      ctx.beginPath();
      ctx.moveTo(splitX, 0);
      ctx.lineTo(splitX, layout.canvasHeight);
      ctx.stroke();

      // Central circular handle
      const handleRadius = Math.max(16, Math.round(layout.canvasWidth * 0.018));
      const centerY = layout.imageY + layout.imageHeight / 2;
      ctx.fillStyle = '#18181b';
      ctx.beginPath();
      ctx.arc(splitX, centerY, handleRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = Math.max(2, Math.round(layout.canvasWidth * 0.002));
      ctx.strokeStyle = '#3b82f6';
      ctx.stroke();

      // Left/Right arrows inside handle
      const arrowOffset = Math.round(handleRadius * 0.42);
      const arrowSize = Math.round(handleRadius * 0.26);
      ctx.strokeStyle = '#f4f4f6';
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

      // Corner comparison labels (Measured dark scrim + crisp monospace text)
      const labelFontSize = Math.max(13, Math.round(layout.canvasWidth * 0.013));
      ctx.font = `600 ${labelFontSize}px "JetBrains Mono", monospace`;
      const padX = Math.round(labelFontSize * 0.85);
      const padY = Math.round(labelFontSize * 0.55);
      const sideMargin = Math.max(18, Math.round(layout.canvasWidth * 0.022));
      const badgeY = Math.max(18, Math.round(layout.canvasHeight * 0.025));

      const beforeText = `BEFORE · UN-LEVELED (${
        analysis.detectedTiltDeg > 0
          ? `+${analysis.detectedTiltDeg.toFixed(2)}°`
          : `${analysis.detectedTiltDeg.toFixed(2)}°`
      })`;
      const afterText = `AFTER · LEVELED & FRAMED (${
        totalRotDeg > 0 ? `+${totalRotDeg.toFixed(2)}°` : `${totalRotDeg.toFixed(2)}°`
      })`;

      const beforeW = ctx.measureText(beforeText).width + padX * 2;
      const afterW = ctx.measureText(afterText).width + padX * 2;
      const boxH = labelFontSize + padY * 2;

      // Left badge
      ctx.fillStyle = 'rgba(15, 15, 18, 0.88)';
      ctx.fillRect(sideMargin, badgeY, beforeW, boxH);
      ctx.fillStyle = '#e4e4e7';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(beforeText, sideMargin + padX, badgeY + boxH / 2);

      // Right badge
      const rightX = layout.canvasWidth - sideMargin - afterW;
      ctx.fillStyle = 'rgba(15, 15, 18, 0.88)';
      ctx.fillRect(rightX, badgeY, afterW, boxH);
      ctx.fillStyle = '#60a5fa';
      ctx.textAlign = 'left';
      ctx.fillText(afterText, rightX + padX, badgeY + boxH / 2);

      ctx.restore();
    } else {
      // Standard Framed White Border output
      canvas.width = layout.canvasWidth;
      canvas.height = layout.canvasHeight;
      drawProcessedFrame(ctx);
    }

    // Optional alignment grid overlay
    if (showHorizonGrid) {
      const w = canvas.width;
      const h = canvas.height;
      ctx.save();
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.55)';
      ctx.lineWidth = Math.max(1, Math.round(w * 0.0012));

      // Center horizontal & vertical reference lines
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.moveTo(w / 2, 0);
      ctx.lineTo(w / 2, h);
      ctx.stroke();

      // Rule of thirds
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
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
  }, [
    sensorCanvas,
    analysis,
    config,
    viewMode,
    splitPercent,
    showHorizonGrid,
    photo.exif,
    canvasRef,
  ]);

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
    if (viewMode !== 'split' || e.button !== 0) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore if pointer capture fails
    }
    setIsDraggingSplit(true);
    updateSplitFromClientX(e.clientX);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (viewMode !== 'split' || !isDraggingSplit) return;
    updateSplitFromClientX(e.clientX);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDraggingSplit) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setIsDraggingSplit(false);
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setIsDraggingSplit(false);
  };

  const handleLostPointerCapture = () => {
    setIsDraggingSplit(false);
  };

  if (loadError) {
    return (
      <div className="flex h-full w-full items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900/50 p-8 text-center text-sm text-zinc-400">
        {loadError}
      </div>
    );
  }

  return (
    <div
      className="relative flex h-full w-full items-center justify-center overflow-hidden p-4"
      data-state={sensorCanvas ? 'ready' : 'loading'}
      data-view-mode={viewMode}
    >
      <canvas
        ref={canvasRef}
        data-testid="darkroom-canvas"
        aria-label={`Framed preview of ${photo.title}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={handleLostPointerCapture}
        className={`max-h-full max-w-full object-contain shadow-2xl transition-opacity duration-150 ${
          viewMode === 'split' ? 'cursor-ew-resize select-none touch-none' : ''
        }`}
      />
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
