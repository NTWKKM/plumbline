/**
 * Core Data Structures & Pure Image Geometry Pipeline
 * Follows Karpathy's Data-First & Concrete Procedural Guidelines.
 */

export type AspectRatioPreset = '1:1' | '4:5' | '16:9' | '3:2' | 'original';

export interface ExifData {
  cameraModel: string;
  lensModel: string;
  focalLength: string;
  aperture: string;
  shutterSpeed: string;
  iso: string;
  dateTimeOriginal: string;
  colorSpace: string;
  rawFormat?: string;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
  areaRetainedPercent: number;
}

export interface FrameLayout {
  canvasWidth: number;
  canvasHeight: number;
  imageX: number;
  imageY: number;
  imageWidth: number;
  imageHeight: number;
  borderTop: number;
  borderBottom: number;
  borderLeft: number;
  borderRight: number;
}

export interface PipelineConfig {
  autoLevelEnabled: boolean;
  maxAutoAngleDeg: number; // Clamped e.g. 15 degrees
  manualAngleOffsetDeg: number;
  autoCropEnabled: boolean;
  preserveAspectRatioInCrop: boolean;
  aspectPreset: AspectRatioPreset;
  paddingPercent: number; // 0 to 35
  backgroundColor: string; // Hex color e.g. #FFFFFF
  preserveExifMetadata: boolean;
  renderExifCaption: boolean;
  jpegQuality: number; // 70 to 100
}

export interface LevelingAnalysis {
  detectedTiltDeg: number;
  appliedRotationDeg: number;
  confidence: number; // 0.0 to 1.0
  strongEdgeCount: number;
}

export const MAX_AUTO_ANGLE_LIMIT_DEG = 15.0;

/**
 * Clamp a number between min and max.
 */
export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

/**
 * Computes the Largest Axis-Aligned Inscribed Rectangle inside an image of size (width x height)
 * rotated by `angleDeg` degrees, eliminating all empty corner triangles.
 */
export function computeInscribedCrop(
  width: number,
  height: number,
  angleDeg: number,
  preserveAspect = true
): CropRect {
  if (width <= 0 || height <= 0) {
    return { x: 0, y: 0, width: 0, height: 0, scaleFactor: 1, areaRetainedPercent: 100 };
  }

  const rad = (Math.abs(angleDeg) * Math.PI) / 180;
  const sinA = Math.sin(rad);
  const cosA = Math.cos(rad);

  if (rad < 1e-5) {
    return {
      x: 0,
      y: 0,
      width: Math.round(width),
      height: Math.round(height),
      scaleFactor: 1,
      areaRetainedPercent: 100,
    };
  }

  let cropW: number;
  let cropH: number;

  if (preserveAspect) {
    // Tightest scale factor `s` such that (s*W, s*H) fits inside rotated (W, H)
    const sWidth = width / (width * cosA + height * sinA);
    const sHeight = height / (width * sinA + height * cosA);
    const s = Math.min(sWidth, sHeight);
    cropW = Math.max(1, Math.floor(width * s));
    cropH = Math.max(1, Math.floor(height * s));
  } else {
    // Maximum-area axis-aligned inscribed rectangle (non-fixed aspect ratio)
    const shortSide = Math.min(width, height);
    const longSide = Math.max(width, height);
    if (shortSide <= 2 * sinA * cosA * longSide || Math.abs(cosA * cosA - sinA * sinA) < 1e-5) {
      const halfAngle = 0.5 * shortSide;
      if (width >= height) {
        cropW = Math.max(1, Math.floor(halfAngle / sinA));
        cropH = Math.max(1, Math.floor(halfAngle / cosA));
      } else {
        cropW = Math.max(1, Math.floor(halfAngle / cosA));
        cropH = Math.max(1, Math.floor(halfAngle / sinA));
      }
    } else {
      const cos2A = cosA * cosA - sinA * sinA;
      cropW = Math.max(1, Math.floor((width * cosA - height * sinA) / cos2A));
      cropH = Math.max(1, Math.floor((height * cosA - width * sinA) / cos2A));
    }
  }

  const scaleFactor = Number((cropW / width).toFixed(4));
  const areaRetainedPercent = Number((((cropW * cropH) / (width * height)) * 100).toFixed(1));

  return {
    x: Math.floor((width - cropW) / 2),
    y: Math.floor((height - cropH) / 2),
    width: cropW,
    height: cropH,
    scaleFactor,
    areaRetainedPercent,
  };
}

/**
 * Detects dominant horizon and vertical architectural tilt using:
 * 1. 3x3 Sobel gradient extraction.
 * 2. Per-Column (horizontal horizon) and Per-Row (vertical facade) Top-2 Non-Maximum Suppression (NMS)
 *    with clamped weights so high-contrast rocky/foliage texture cannot overwhelm a crisp straight horizon.
 * 3. Radon / Hough colinearity accumulator energy maximization over [-maxAngleDeg, +maxAngleDeg] at 0.1° resolution.
 */
export function detectHorizonTiltFromGrayscale(
  gray: Uint8Array | Float32Array,
  width: number,
  height: number,
  maxAngleDeg = 15.0
): LevelingAnalysis {
  const limit = clamp(maxAngleDeg, 1.0, MAX_AUTO_ANGLE_LIMIT_DEG);
  if (width < 12 || height < 12 || gray.length < width * height) {
    return { detectedTiltDeg: 0, appliedRotationDeg: 0, confidence: 0, strongEdgeCount: 0 };
  }

  const gxBuf = new Float32Array(width * height);
  const gyBuf = new Float32Array(width * height);

  for (let y = 1; y < height - 1; y++) {
    const rowPrev = (y - 1) * width;
    const rowCurr = y * width;
    const rowNext = (y + 1) * width;
    for (let x = 1; x < width - 1; x++) {
      const p00 = gray[rowPrev + x - 1];
      const p01 = gray[rowPrev + x];
      const p02 = gray[rowPrev + x + 1];
      const p10 = gray[rowCurr + x - 1];
      const p12 = gray[rowCurr + x + 1];
      const p20 = gray[rowNext + x - 1];
      const p21 = gray[rowNext + x];
      const p22 = gray[rowNext + x + 1];

      gxBuf[rowCurr + x] = -p00 + p02 - 2 * p10 + 2 * p12 - p20 + p22;
      gyBuf[rowCurr + x] = -p00 - 2 * p01 - p02 + p20 + 2 * p21 + p22;
    }
  }

  interface EdgePoint {
    dx: number;
    dy: number;
    weight: number;
    isHorizontal: boolean;
  }

  const cx = width * 0.5;
  const cy = height * 0.5;
  const edges: EdgePoint[] = [];
  const magThreshold = 40.0;

  // Per-Column Top-2 vertical gradient ridges (for horizontal/tilted horizon lines)
  const yMin = Math.max(2, Math.floor(height * 0.08));
  const yMax = Math.min(height - 3, Math.ceil(height * 0.92));

  for (let x = 2; x < width - 2; x++) {
    let bestY1 = -1;
    let bestVal1 = 0;
    let bestY2 = -1;
    let bestVal2 = 0;

    for (let y = yMin; y <= yMax; y++) {
      const idx = y * width + x;
      const absGy = Math.abs(gyBuf[idx]);
      const absGx = Math.abs(gxBuf[idx]);
      // Require predominantly horizontal edge (|gy| > 2.2 * |gx|) and local vertical NMS peak
      if (absGy < magThreshold || absGy < absGx * 2.2) continue;
      if (absGy < Math.abs(gyBuf[idx - width]) || absGy < Math.abs(gyBuf[idx + width])) continue;

      if (absGy > bestVal1) {
        bestVal2 = bestVal1;
        bestY2 = bestY1;
        bestVal1 = absGy;
        bestY1 = y;
      } else if (absGy > bestVal2 && Math.abs(y - bestY1) > 6) {
        bestVal2 = absGy;
        bestY2 = y;
      }
    }

    if (bestY1 >= 0) {
      edges.push({
        dx: x - cx,
        dy: bestY1 - cy,
        weight: Math.min(bestVal1, 140.0),
        isHorizontal: true,
      });
    }
    if (bestY2 >= 0) {
      edges.push({
        dx: x - cx,
        dy: bestY2 - cy,
        weight: Math.min(bestVal2, 110.0) * 0.7,
        isHorizontal: true,
      });
    }
  }

  // Per-Row Top-2 horizontal gradient ridges (for vertical architectural lines)
  const xMin = Math.max(2, Math.floor(width * 0.08));
  const xMax = Math.min(width - 3, Math.ceil(width * 0.92));

  for (let y = 2; y < height - 2; y++) {
    let bestX1 = -1;
    let bestVal1 = 0;
    let bestX2 = -1;
    let bestVal2 = 0;

    for (let x = xMin; x <= xMax; x++) {
      const idx = y * width + x;
      const absGx = Math.abs(gxBuf[idx]);
      const absGy = Math.abs(gyBuf[idx]);
      if (absGx < magThreshold || absGx < absGy * 2.2) continue;
      if (absGx < Math.abs(gxBuf[idx - 1]) || absGx < Math.abs(gxBuf[idx + 1])) continue;

      if (absGx > bestVal1) {
        bestVal2 = bestVal1;
        bestX2 = bestX1;
        bestVal1 = absGx;
        bestX1 = x;
      } else if (absGx > bestVal2 && Math.abs(x - bestX1) > 6) {
        bestVal2 = absGx;
        bestX2 = x;
      }
    }

    if (bestX1 >= 0) {
      edges.push({
        dx: bestX1 - cx,
        dy: y - cy,
        weight: Math.min(bestVal1, 140.0) * 0.85,
        isHorizontal: false,
      });
    }
    if (bestX2 >= 0) {
      edges.push({
        dx: bestX2 - cx,
        dy: y - cy,
        weight: Math.min(bestVal2, 110.0) * 0.6,
        isHorizontal: false,
      });
    }
  }

  const strongEdgeCount = edges.length;
  if (strongEdgeCount < 10) {
    return { detectedTiltDeg: 0, appliedRotationDeg: 0, confidence: 0, strongEdgeCount };
  }

  const binStep = 0.1;
  const halfBins = Math.round(limit / binStep);
  const numBins = halfBins * 2 + 1;
  const energyByAngle = new Float64Array(numBins);

  const diag = Math.ceil(Math.hypot(width, height)) + 4;
  const rhoOffset = diag >> 1;
  const hAcc = new Float64Array(diag);
  const vAcc = new Float64Array(diag);

  let maxEnergy = -1;
  let totalEnergy = 0;
  let bestBin = halfBins;

  for (let b = 0; b < numBins; b++) {
    const angleDeg = b * binStep - limit;
    const rad = (angleDeg * Math.PI) / 180;
    const sinA = Math.sin(rad);
    const cosA = Math.cos(rad);

    hAcc.fill(0);
    vAcc.fill(0);

    for (let i = 0; i < edges.length; i++) {
      const pt = edges[i];
      if (pt.isHorizontal) {
        const rho = Math.round(pt.dy * cosA - pt.dx * sinA) + rhoOffset;
        if (rho >= 0 && rho < diag) {
          hAcc[rho] += pt.weight;
        }
      } else {
        const rho = Math.round(pt.dx * cosA + pt.dy * sinA) + rhoOffset;
        if (rho >= 0 && rho < diag) {
          vAcc[rho] += pt.weight;
        }
      }
    }

    // Colinearity energy: sum of cubic-weighted peaks rewards single long straight lines
    let energy = 0;
    for (let r = 1; r < diag - 1; r++) {
      const hv = hAcc[r] + 0.25 * (hAcc[r - 1] + hAcc[r + 1]);
      const vv = vAcc[r] + 0.25 * (vAcc[r - 1] + vAcc[r + 1]);
      if (hv > 0) energy += hv * hv * hv;
      if (vv > 0) energy += vv * vv * vv;
    }

    energyByAngle[b] = energy;
    totalEnergy += energy;
    if (energy > maxEnergy) {
      maxEnergy = energy;
      bestBin = b;
    }
  }

  let refinedBin = bestBin;
  if (bestBin > 0 && bestBin < numBins - 1) {
    const yLeft = energyByAngle[bestBin - 1];
    const yMid = energyByAngle[bestBin];
    const yRight = energyByAngle[bestBin + 1];
    const denom = 2 * (2 * yMid - yLeft - yRight);
    if (Math.abs(denom) > 1e-6) {
      refinedBin += clamp((yRight - yLeft) / denom, -0.5, 0.5);
    }
  }

  const detectedTiltDeg = Number((refinedBin * binStep - limit).toFixed(2));
  const appliedRotationDeg = Number((-detectedTiltDeg).toFixed(2));
  const meanEnergy = totalEnergy / numBins;
  const peakRatio = maxEnergy > 0 ? (maxEnergy - meanEnergy) / maxEnergy : 0;
  const confidence = clamp(Number(peakRatio.toFixed(2)), 0.25, 0.99);

  return {
    detectedTiltDeg,
    appliedRotationDeg,
    confidence,
    strongEdgeCount,
  };
}

/**
 * Computes the White Border frame canvas dimensions and centered inner photo coordinates
 * following the `com.vector123.whiteborder` no-crop framing model.
 */
export function computeFrameLayout(
  sourceWidth: number,
  sourceHeight: number,
  aspectPreset: AspectRatioPreset,
  paddingPercent: number,
  renderExifCaption = false
): FrameLayout {
  const safeW = Math.max(1, Math.round(sourceWidth));
  const safeH = Math.max(1, Math.round(sourceHeight));
  const padRatio = clamp(paddingPercent, 0, 40) / 100;

  let targetRatio = safeW / safeH;
  if (aspectPreset === '1:1') targetRatio = 1.0;
  else if (aspectPreset === '4:5') targetRatio = 4 / 5;
  else if (aspectPreset === '16:9') targetRatio = 16 / 9;
  else if (aspectPreset === '3:2') targetRatio = 3 / 2;

  // Base longest side on the source image so resolution is never degraded
  const baseLongSide = Math.max(safeW, safeH);
  let canvasWidth: number;
  let canvasHeight: number;

  if (targetRatio >= 1) {
    canvasWidth = Math.round(baseLongSide / (1 - Math.min(0.7, padRatio * 1.6)));
    canvasHeight = Math.round(canvasWidth / targetRatio);
  } else {
    canvasHeight = Math.round(baseLongSide / (1 - Math.min(0.7, padRatio * 1.6)));
    canvasWidth = Math.round(canvasHeight * targetRatio);
  }

  // Reserve extra bottom margin if EXIF caption stamp is enabled
  const exifFooterReserve = renderExifCaption ? Math.round(canvasHeight * 0.045) : 0;
  const minMarginX = Math.round(canvasWidth * padRatio);
  const minMarginY = Math.round(canvasHeight * padRatio);

  const availW = Math.max(1, canvasWidth - minMarginX * 2);
  const availH = Math.max(1, canvasHeight - minMarginY * 2 - exifFooterReserve);

  const scale = Math.min(availW / safeW, availH / safeH);
  const imageWidth = Math.max(1, Math.round(safeW * scale));
  const imageHeight = Math.max(1, Math.round(safeH * scale));

  const imageX = Math.round((canvasWidth - imageWidth) / 2);
  const imageY = Math.round((canvasHeight - exifFooterReserve - imageHeight) / 2);

  return {
    canvasWidth,
    canvasHeight,
    imageX,
    imageY,
    imageWidth,
    imageHeight,
    borderTop: imageY,
    borderBottom: canvasHeight - (imageY + imageHeight),
    borderLeft: imageX,
    borderRight: canvasWidth - (imageX + imageWidth),
  };
}

/**
 * Formats EXIF metadata into a single clean typographic line for darkroom/gallery borders.
 */
export function formatExifSummaryLine(exif: ExifData): string {
  const parts = [
    exif.cameraModel,
    exif.lensModel,
    exif.focalLength,
    exif.aperture,
    exif.shutterSpeed,
    exif.iso ? `ISO ${exif.iso.replace(/^ISO\s*/i, '')}` : '',
  ].filter((p) => p && p.trim().length > 0);

  return parts.join('  ·  ');
}

/**
 * Computes the pixel X coordinate and clamped percentage for the Before/After split screen divider.
 */
export function computeSplitDividerX(
  canvasWidth: number,
  splitPercent: number
): { splitX: number; clampedPercent: number } {
  const safeWidth = Math.max(1, Math.round(canvasWidth));
  const clampedPercent = Number(clamp(splitPercent, 5, 95).toFixed(1));
  const splitX = Math.round((safeWidth * clampedPercent) / 100);
  return { splitX, clampedPercent };
}

