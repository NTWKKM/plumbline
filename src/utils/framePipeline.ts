/**
 * The framing pipeline: load, simulate tilt, analyse, rotate, crop, warp, correct, frame.
 * Pixel-heavy steps run in the pipeline worker; canvas drawing stays here on the main thread.
 */
import {
  AutoCorrectAnalysis,
  CropRect,
  DEFAULT_AUTO_CORRECT_ANALYSIS,
  DEFAULT_LEVELING_ANALYSIS,
  FrameLayout,
  LevelingAnalysis,
  PipelineConfig,
  WbProfileMode,
  clamp,
  computeFrameLayout,
  computeInscribedCrop,
  computeSmartInscribedCrop,
  formatExifSummaryLine,
  getScaledDimensionsWithinBudget,
} from './geometry';
import { analyzeInWorker, processInWorker } from './pipelineWorker';
import { StudioPhotoItem } from './samplePhotos';

export interface SaliencyBuffer {
  gray: Uint8Array;
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface SensorAnalysisResult {
  sensorCanvas: HTMLCanvasElement;
  analysis: LevelingAnalysis;
  autoCorrect: AutoCorrectAnalysis;
  saliency: SaliencyBuffer | null;
}

export interface ProcessedFramePipeline {
  crop: CropRect;
  layout: FrameLayout;
  totalRotDeg: number;
  rotCanvas: HTMLCanvasElement;
  processedFrameCanvas: HTMLCanvasElement;
}

export async function buildSensorAndAnalysis(
  img: HTMLImageElement,
  tiltDeg: number,
  maxAutoAngleDeg: number,
  pixelAreaBudget?: number,
  wbProfile: WbProfileMode = 'ambient'
): Promise<SensorAnalysisResult | null> {
  const rawW = img.naturalWidth || 1600;
  const rawH = img.naturalHeight || 1200;

  const { width: scaledW, height: scaledH } = getScaledDimensionsWithinBudget(
    rawW,
    rawH,
    pixelAreaBudget
  );

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
    // The worker takes a copy; the original stays here for a later white-balance re-analysis
    const result = await analyzeInWorker({
      rgba: imgData.slice(),
      width: dw,
      height: dh,
      maxAutoAngleDeg,
      wbProfile,
    });
    saliency = { gray: result.gray, rgba: imgData, width: dw, height: dh };
    detected = result.analysis ?? DEFAULT_LEVELING_ANALYSIS;
    autoCorr = result.autoCorrect;
  }

  return { sensorCanvas: offscreen, analysis: detected, autoCorrect: autoCorr, saliency };
}

/** Re-runs only the tone analysis, for a white-balance profile change. */
export async function reanalyzeTone(
  saliency: SaliencyBuffer,
  wbProfile: WbProfileMode
): Promise<AutoCorrectAnalysis> {
  const result = await analyzeInWorker({
    rgba: saliency.rgba.slice(),
    width: saliency.width,
    height: saliency.height,
    maxAutoAngleDeg: 0,
    wbProfile,
    toneOnly: true,
  });
  return result.autoCorrect;
}

/** Totals the automatic and manual corrections a config asks for. */
export function resolveCorrections(config: PipelineConfig, analysis: LevelingAnalysis) {
  const autoRot = config.autoLevelEnabled ? analysis.appliedRotationDeg : 0;
  const autoKeystone = (config.keystoneWarpEnabled ?? true) ? (analysis.appliedKeystoneDeg ?? 0) : 0;
  return {
    totalRotDeg: Number((autoRot + config.manualAngleOffsetDeg).toFixed(2)),
    totalKeystoneDeg: Number((autoKeystone + (config.manualKeystoneDeg ?? 0)).toFixed(2)),
    keystoneHDeg: Number((config.manualKeystoneHDeg ?? 0).toFixed(2)),
  };
}

function pixelCropFromOverride(
  o: NonNullable<PipelineConfig['cropOverride']>,
  srcW: number,
  srcH: number
): CropRect {
  const x = clamp(Math.round(o.x * srcW), 0, srcW - 1);
  const y = clamp(Math.round(o.y * srcH), 0, srcH - 1);
  const width = clamp(Math.round(o.width * srcW), 1, srcW - x);
  const height = clamp(Math.round(o.height * srcH), 1, srcH - y);
  return {
    x,
    y,
    width,
    height,
    scaleFactor: 1,
    areaRetainedPercent: Math.round(((width * height) / (srcW * srcH)) * 100),
  };
}

export async function buildProcessedFramePipeline(
  sensorCanvas: HTMLCanvasElement,
  photo: StudioPhotoItem,
  config: PipelineConfig,
  analysis: LevelingAnalysis,
  autoCorrect: AutoCorrectAnalysis,
  saliency?: { gray: Uint8Array; width: number; height: number } | null
): Promise<ProcessedFramePipeline | null> {
  const srcW = sensorCanvas.width;
  const srcH = sensorCanvas.height;

  const { totalRotDeg, totalKeystoneDeg, keystoneHDeg } = resolveCorrections(config, analysis);
  const corrEnabled = config.autoCorrectEnabled ?? true;
  const corrStrength = config.autoCorrectStrength ?? 75;

  const crop = config.cropOverride
    ? pixelCropFromOverride(config.cropOverride, srcW, srcH)
    : config.autoCropEnabled
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

  const needsKeystone = Math.abs(totalKeystoneDeg) >= 0.02 || Math.abs(keystoneHDeg) >= 0.02;
  const needsAutoCorr = corrEnabled && corrStrength > 0;
  if ((needsKeystone || needsAutoCorr) && crop.width > 0 && crop.height > 0) {
    const croppedData = rCtx.getImageData(crop.x, crop.y, crop.width, crop.height);
    const processed = await processInWorker({
      rgba: croppedData.data,
      width: crop.width,
      height: crop.height,
      keystoneDeg: totalKeystoneDeg,
      keystoneHDeg,
      autoCorrect: needsAutoCorr ? autoCorrect : null,
      strength: corrStrength,
    });
    rCtx.putImageData(new ImageData(processed as Uint8ClampedArray<ArrayBuffer>, crop.width, crop.height), crop.x, crop.y);
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

  const sensorResult = await buildSensorAndAnalysis(
    img,
    photo.simulatedSensorTiltDeg || 0,
    config.maxAutoAngleDeg,
    config.pixelAreaBudget,
    config.wbProfile ?? 'ambient'
  );
  if (!sensorResult) {
    throw new Error(`Canvas context unavailable for ${photo.fileName}`);
  }

  const pipeline = await buildProcessedFramePipeline(
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

export function isHexColorDark(hex: string): boolean {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return false;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  return luma < 128;
}

