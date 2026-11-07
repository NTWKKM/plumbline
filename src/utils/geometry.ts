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
  autoCorrectEnabled?: boolean;
  autoCorrectStrength?: number; // 0 to 100
  aspectPreset: AspectRatioPreset;
  paddingPercent: number; // 0 to 35
  backgroundColor: string; // Hex color e.g. #FFFFFF
  preserveExifMetadata: boolean;
  renderExifCaption: boolean;
  jpegQuality: number; // 70 to 100
  pixelAreaBudget?: number; // Optional reduced-resolution budget in square pixels
}

export interface LevelingAnalysis {
  detectedTiltDeg: number;
  appliedRotationDeg: number;
  confidence: number; // 0.0 to 1.0
  strongEdgeCount: number;
}

export interface AutoCorrectAnalysis {
  exposureEv: number; // -1.2 to +1.2 EV
  contrast: number; // 0 to 35
  shadows: number; // 0 to 45
  highlights: number; // -45 to 0
  wbTempShift: number; // -25 to +25 (warm/cool neutralization)
  wbTintShift: number; // -20 to +20 (green/magenta neutralization)
  blackPoint: number; // 0 to 255
  whitePoint: number; // 0 to 255
  dynamicRangeStops: number;
}

export interface PipelineTelemetryUpdate {
  analysis: LevelingAnalysis;
  crop: CropRect;
  layout: FrameLayout;
  sourceSize: { width: number; height: number };
  autoCorrect: AutoCorrectAnalysis;
}

export const DEFAULT_LEVELING_ANALYSIS: LevelingAnalysis = {
  detectedTiltDeg: 0,
  appliedRotationDeg: 0,
  confidence: 0,
  strongEdgeCount: 0,
};

export const DEFAULT_AUTO_CORRECT_ANALYSIS: AutoCorrectAnalysis = {
  exposureEv: 0,
  contrast: 10,
  shadows: 0,
  highlights: 0,
  wbTempShift: 0,
  wbTintShift: 0,
  blackPoint: 0,
  whitePoint: 255,
  dynamicRangeStops: 8.0,
};

export const MAX_AUTO_ANGLE_LIMIT_DEG = 15.0;

/**
 * Formats a signed degree value with an explicit '+' for positive numbers.
 */
export function formatSignedDegrees(deg: number, decimals = 2): string {
  const fixed = deg.toFixed(decimals);
  return deg > 0 ? `+${fixed}°` : `${fixed}°`;
}

/**
 * Clamp a number between min and max.
 */
export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

/**
 * Computes the Largest Axis-Aligned Inscribed Rectangle inside an image of size (width x height)
 * rotated by `angleDeg` degrees, eliminating all empty corner triangles.
 * Supports preserving the source aspect ratio, unconstrained maximum-area rectangle,
 * or an explicit target aspect ratio, with center-parity alignment to prevent 0.5px corner bleed.
 */
export function computeInscribedCrop(
  width: number,
  height: number,
  angleDeg: number,
  preserveAspect = true,
  targetAspectRatio?: number
): CropRect {
  if (width <= 0 || height <= 0) {
    return { x: 0, y: 0, width: 0, height: 0, scaleFactor: 1, areaRetainedPercent: 100 };
  }

  const safeW = Math.round(width);
  const safeH = Math.round(height);
  const rad = (Math.abs(angleDeg) * Math.PI) / 180;
  const sinA = Math.sin(rad);
  const cosA = Math.cos(rad);

  const hasCustomRatio =
    typeof targetAspectRatio === 'number' &&
    Number.isFinite(targetAspectRatio) &&
    targetAspectRatio > 0;

  if (rad < 1e-5 && !hasCustomRatio) {
    return {
      x: 0,
      y: 0,
      width: safeW,
      height: safeH,
      scaleFactor: 1,
      areaRetainedPercent: 100,
    };
  }

  let cropW: number;
  let cropH: number;

  if (hasCustomRatio) {
    const ratio = targetAspectRatio!;
    const maxHFromW = safeW / (ratio * cosA + sinA);
    const maxHFromH = safeH / (ratio * sinA + cosA);
    const maxH = Math.min(maxHFromW, maxHFromH);
    cropW = Math.max(1, Math.floor(maxH * ratio));
    cropH = Math.max(1, Math.floor(maxH));
  } else if (preserveAspect) {
    // Tightest scale factor `s` such that (s*W, s*H) fits inside rotated (W, H)
    const sWidth = safeW / (safeW * cosA + safeH * sinA);
    const sHeight = safeH / (safeW * sinA + safeH * cosA);
    const s = Math.min(sWidth, sHeight);
    cropW = Math.max(1, Math.floor(safeW * s));
    cropH = Math.max(1, Math.floor(safeH * s));
  } else {
    // Maximum-area axis-aligned inscribed rectangle (non-fixed aspect ratio)
    const shortSide = Math.min(safeW, safeH);
    const longSide = Math.max(safeW, safeH);
    if (shortSide <= 2 * sinA * cosA * longSide || Math.abs(cosA * cosA - sinA * sinA) < 1e-5) {
      const halfAngle = 0.5 * shortSide;
      if (safeW >= safeH) {
        cropW = Math.max(1, Math.floor(halfAngle / sinA));
        cropH = Math.max(1, Math.floor(halfAngle / cosA));
      } else {
        cropW = Math.max(1, Math.floor(halfAngle / cosA));
        cropH = Math.max(1, Math.floor(halfAngle / sinA));
      }
    } else {
      const cos2A = cosA * cosA - sinA * sinA;
      cropW = Math.max(1, Math.floor((safeW * cosA - safeH * sinA) / cos2A));
      cropH = Math.max(1, Math.floor((safeH * cosA - safeW * sinA) / cos2A));
    }
  }

  // Enforce symmetric center parity when rotated so (safeW - cropW) and (safeH - cropH) are even integers,
  // preventing 0.5px off-center drift and anti-aliased corner bleed
  if (rad >= 1e-5) {
    if (cropW > 4 && (safeW - cropW) % 2 !== 0) cropW -= 1;
    if (cropH > 4 && (safeH - cropH) % 2 !== 0) cropH -= 1;
  }

  const scaleFactor = Number(Math.min(cropW / safeW, cropH / safeH).toFixed(4));
  const areaRetainedPercent = Number((((cropW * cropH) / (safeW * safeH)) * 100).toFixed(1));

  return {
    x: Math.floor((safeW - cropW) / 2),
    y: Math.floor((safeH - cropH) / 2),
    width: cropW,
    height: cropH,
    scaleFactor,
    areaRetainedPercent,
  };
}

/**
 * Detects dominant horizon and vertical architectural tilt using:
 * 1. Rotationally invariant 3x3 Scharr gradient extraction.
 * 2. Per-Column (horizontal horizon) and Per-Row (vertical facade) Top-2 Non-Maximum Suppression (NMS)
 *    with 1D parabolic sub-pixel ridge localization and gradient polarity separation.
 * 3. Bilinearly splatted Radon / Hough colinearity accumulator with 2-stage coarse-to-fine
 *    (0.1° -> 0.01°) angular refinement and spatial coherency gating.
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

  // Rotationally invariant 3x3 Scharr operator normalized by 1/4 to match Sobel scale
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

      gxBuf[rowCurr + x] = (-3 * p00 + 3 * p02 - 10 * p10 + 10 * p12 - 3 * p20 + 3 * p22) * 0.25;
      gyBuf[rowCurr + x] = (-3 * p00 - 10 * p01 - 3 * p02 + 3 * p20 + 10 * p21 + 3 * p22) * 0.25;
    }
  }

  interface EdgePoint {
    dx: number;
    dy: number;
    weight: number;
    polarity: 1 | -1;
    isHorizontal: boolean;
  }

  const cx = (width - 1) * 0.5;
  const cy = (height - 1) * 0.5;
  const edges: EdgePoint[] = [];
  const magThreshold = 40.0;

  // Shared 1D parabolic sub-pixel ridge interpolator
  const refineSubPixelOffset = (mPrev: number, mCurr: number, mNext: number): number => {
    const denom = 2 * (2 * mCurr - mPrev - mNext);
    return denom > 1e-5 ? clamp((mNext - mPrev) / denom, -0.5, 0.5) : 0;
  };

  // Per-Column Top-2 vertical gradient ridges (for horizontal/tilted horizon lines)
  const yMin = Math.max(2, Math.floor(height * 0.08));
  const yMax = Math.min(height - 3, Math.ceil(height * 0.92));

  const refineSubPixelY = (x: number, y: number): number =>
    y +
    refineSubPixelOffset(
      Math.abs(gyBuf[(y - 1) * width + x]),
      Math.abs(gyBuf[y * width + x]),
      Math.abs(gyBuf[(y + 1) * width + x])
    );

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
      const subY1 = refineSubPixelY(x, bestY1);
      edges.push({
        dx: x - cx,
        dy: subY1 - cy,
        weight: Math.min(bestVal1, 140.0),
        polarity: gyBuf[bestY1 * width + x] >= 0 ? 1 : -1,
        isHorizontal: true,
      });
    }
    if (bestY2 >= 0) {
      const subY2 = refineSubPixelY(x, bestY2);
      edges.push({
        dx: x - cx,
        dy: subY2 - cy,
        weight: Math.min(bestVal2, 110.0) * 0.7,
        polarity: gyBuf[bestY2 * width + x] >= 0 ? 1 : -1,
        isHorizontal: true,
      });
    }
  }

  // Per-Row Top-2 horizontal gradient ridges (for vertical architectural lines)
  const xMin = Math.max(2, Math.floor(width * 0.08));
  const xMax = Math.min(width - 3, Math.ceil(width * 0.92));

  const refineSubPixelX = (x: number, y: number): number =>
    x +
    refineSubPixelOffset(
      Math.abs(gxBuf[y * width + (x - 1)]),
      Math.abs(gxBuf[y * width + x]),
      Math.abs(gxBuf[y * width + (x + 1)])
    );

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
      const subX1 = refineSubPixelX(bestX1, y);
      edges.push({
        dx: subX1 - cx,
        dy: y - cy,
        weight: Math.min(bestVal1, 140.0) * 0.85,
        polarity: gxBuf[y * width + bestX1] >= 0 ? 1 : -1,
        isHorizontal: false,
      });
    }
    if (bestX2 >= 0) {
      const subX2 = refineSubPixelX(bestX2, y);
      edges.push({
        dx: subX2 - cx,
        dy: y - cy,
        weight: Math.min(bestVal2, 110.0) * 0.6,
        polarity: gxBuf[y * width + bestX2] >= 0 ? 1 : -1,
        isHorizontal: false,
      });
    }
  }

  const strongEdgeCount = edges.length;
  if (strongEdgeCount < 10) {
    return { detectedTiltDeg: 0, appliedRotationDeg: 0, confidence: 0, strongEdgeCount };
  }

  // Use 0.5-pixel oversampled rho bins with 3-bin sliding sum so line energy is phase-invariant
  const rhoScale = 2;
  const diag = (Math.ceil(Math.hypot(width, height)) + 6) * rhoScale;
  const rhoOffset = diag >> 1;
  const hAccPos = new Float64Array(diag);
  const hAccNeg = new Float64Array(diag);
  const vAccPos = new Float64Array(diag);
  const vAccNeg = new Float64Array(diag);

  interface AngleEvalResult {
    energy: number;
    maxSupport: number;
    bestHorizRho: number;
    bestHorizPolarity: 1 | -1;
    bestHorizSupport: number;
    bestVertRho: number;
    bestVertPolarity: 1 | -1;
    bestVertSupport: number;
  }

  const evaluateAngle = (angleDeg: number): AngleEvalResult => {
    const rad = (angleDeg * Math.PI) / 180;
    const sinA = Math.sin(rad);
    const cosA = Math.cos(rad);

    hAccPos.fill(0);
    hAccNeg.fill(0);
    vAccPos.fill(0);
    vAccNeg.fill(0);

    for (let i = 0; i < edges.length; i++) {
      const pt = edges[i];
      const rho =
        (pt.isHorizontal ? pt.dy * cosA - pt.dx * sinA : pt.dx * cosA + pt.dy * sinA) * rhoScale +
        rhoOffset;
      const r0 = Math.floor(rho);
      if (r0 >= 0 && r0 + 1 < diag) {
        const frac = rho - r0;
        const w0 = pt.weight * (1 - frac);
        const w1 = pt.weight * frac;
        if (pt.isHorizontal) {
          if (pt.polarity > 0) {
            hAccPos[r0] += w0;
            hAccPos[r0 + 1] += w1;
          } else {
            hAccNeg[r0] += w0;
            hAccNeg[r0 + 1] += w1;
          }
        } else {
          if (pt.polarity > 0) {
            vAccPos[r0] += w0;
            vAccPos[r0 + 1] += w1;
          } else {
            vAccNeg[r0] += w0;
            vAccNeg[r0 + 1] += w1;
          }
        }
      }
    }

    let energy = 0;
    let bestHorizSupport = 0;
    let bestHorizRho = 0;
    let bestHorizPolarity: 1 | -1 = 1;
    let bestVertSupport = 0;
    let bestVertRho = 0;
    let bestVertPolarity: 1 | -1 = 1;

    const kernel4 = (acc: Float64Array, r: number): number =>
      0.5 * (acc[r - 1] + acc[r + 2]) + (acc[r] + acc[r + 1]);

    for (let r = 1; r < diag - 2; r++) {
      // Phase-invariant 2-pixel (4 half-bin) kernel
      const hp = kernel4(hAccPos, r);
      const hn = kernel4(hAccNeg, r);
      const vp = kernel4(vAccPos, r);
      const vn = kernel4(vAccNeg, r);
      const rhoVal = (r + 0.5 - rhoOffset) / rhoScale;

      if (hp > 0) {
        energy += hp * hp * hp;
        if (hp > bestHorizSupport) {
          bestHorizSupport = hp;
          bestHorizRho = rhoVal;
          bestHorizPolarity = 1;
        }
      }
      if (hn > 0) {
        energy += hn * hn * hn;
        if (hn > bestHorizSupport) {
          bestHorizSupport = hn;
          bestHorizRho = rhoVal;
          bestHorizPolarity = -1;
        }
      }
      if (vp > 0) {
        energy += vp * vp * vp;
        if (vp > bestVertSupport) {
          bestVertSupport = vp;
          bestVertRho = rhoVal;
          bestVertPolarity = 1;
        }
      }
      if (vn > 0) {
        energy += vn * vn * vn;
        if (vn > bestVertSupport) {
          bestVertSupport = vn;
          bestVertRho = rhoVal;
          bestVertPolarity = -1;
        }
      }
    }

    return {
      energy,
      maxSupport: Math.max(bestHorizSupport, bestVertSupport),
      bestHorizRho,
      bestHorizPolarity,
      bestHorizSupport,
      bestVertRho,
      bestVertPolarity,
      bestVertSupport,
    };
  };

  // Stage 1: Coarse scan at 0.1° resolution across [-limit, +limit]
  const binStep = 0.1;
  const halfBins = Math.round(limit / binStep);
  const numBins = halfBins * 2 + 1;
  const energyByAngle = new Float64Array(numBins);

  let maxEnergy = -1;
  let totalEnergy = 0;
  let bestBin = halfBins;
  let bestSupport = 0;

  for (let b = 0; b < numBins; b++) {
    const angleDeg = b * binStep - limit;
    const res = evaluateAngle(angleDeg);
    energyByAngle[b] = res.energy;
    totalEnergy += res.energy;
    if (res.energy > maxEnergy) {
      maxEnergy = res.energy;
      bestBin = b;
      bestSupport = res.maxSupport;
    }
  }

  // Stage 2: Fine sub-degree scan at 0.02° resolution around the coarse winner
  const coarseWinnerDeg = bestBin * binStep - limit;
  const fineStep = 0.02;
  const fineRadiusBins = 12; // ±0.24°
  const fineCount = fineRadiusBins * 2 + 1;
  const fineEnergies = new Float64Array(fineCount);
  let bestFineIdx = fineRadiusBins;
  let bestFineEnergy = -1;
  let bestEval = evaluateAngle(coarseWinnerDeg);

  for (let f = 0; f < fineCount; f++) {
    const candDeg = clamp(coarseWinnerDeg + (f - fineRadiusBins) * fineStep, -limit, limit);
    const res = evaluateAngle(candDeg);
    fineEnergies[f] = res.energy;
    if (res.energy > bestFineEnergy) {
      bestFineEnergy = res.energy;
      bestFineIdx = f;
      bestEval = res;
      if (res.maxSupport > bestSupport) bestSupport = res.maxSupport;
    }
  }

  let refinedFineIdx = bestFineIdx;
  if (bestFineIdx > 0 && bestFineIdx < fineCount - 1) {
    const yLeft = fineEnergies[bestFineIdx - 1];
    const yMid = fineEnergies[bestFineIdx];
    const yRight = fineEnergies[bestFineIdx + 1];
    const denom = 2 * (2 * yMid - yLeft - yRight);
    if (Math.abs(denom) > 1e-6) {
      refinedFineIdx += clamp((yRight - yLeft) / denom, -0.5, 0.5);
    }
  }

  let rawDetectedDeg = clamp(
    coarseWinnerDeg + (refinedFineIdx - fineRadiusBins) * fineStep,
    -limit,
    limit
  );

  // Stage 3: Huber Iteratively Reweighted Least Squares (IRLS) refinement on dominant line inliers
  const rad0 = (rawDetectedDeg * Math.PI) / 180;
  const sin0 = Math.sin(rad0);
  const cos0 = Math.cos(rad0);
  const useHoriz = bestEval.bestHorizSupport >= bestEval.bestVertSupport;
  const targetRho = useHoriz ? bestEval.bestHorizRho : bestEval.bestVertRho;
  const targetPol = useHoriz ? bestEval.bestHorizPolarity : bestEval.bestVertPolarity;

  const inliers: EdgePoint[] = [];
  for (let i = 0; i < edges.length; i++) {
    const pt = edges[i];
    if (pt.isHorizontal !== useHoriz || pt.polarity !== targetPol) continue;
    const rho = useHoriz ? pt.dy * cos0 - pt.dx * sin0 : pt.dx * cos0 + pt.dy * sin0;
    if (Math.abs(rho - targetRho) <= 2.2) {
      inliers.push(pt);
    }
  }

  if (inliers.length >= 12) {
    let slope = Math.tan(rad0);
    // Horizontal: dy*cos0 - dx*sin0 = targetRho -> v = tan(rad0)*u + targetRho/cos0
    // Vertical:   dx*cos0 + dy*sin0 = targetRho (with u=dy, v=-dx) -> v = tan(rad0)*u - targetRho/cos0
    let intercept = (useHoriz ? targetRho : -targetRho) / Math.max(0.5, cos0);

    for (let iter = 0; iter < 3; iter++) {
      let sumW = 0;
      let sumX = 0;
      let sumY = 0;
      for (let i = 0; i < inliers.length; i++) {
        const pt = inliers[i];
        const u = useHoriz ? pt.dx : pt.dy;
        const v = useHoriz ? pt.dy : -pt.dx;
        const resid = Math.abs(v - (slope * u + intercept));
        const huberW = resid <= 0.75 ? pt.weight : pt.weight * (0.75 / resid);
        sumW += huberW;
        sumX += huberW * u;
        sumY += huberW * v;
      }
      if (sumW <= 1e-5) break;
      const meanX = sumX / sumW;
      const meanY = sumY / sumW;

      let sXX = 0;
      let sXY = 0;
      for (let i = 0; i < inliers.length; i++) {
        const pt = inliers[i];
        const u = useHoriz ? pt.dx : pt.dy;
        const v = useHoriz ? pt.dy : -pt.dx;
        const resid = Math.abs(v - (slope * u + intercept));
        const huberW = resid <= 0.75 ? pt.weight : pt.weight * (0.75 / resid);
        const du = u - meanX;
        const dv = v - meanY;
        sXX += huberW * du * du;
        sXY += huberW * du * dv;
      }

      if (sXX > 100) {
        slope = sXY / sXX;
        intercept = meanY - slope * meanX;
      }
    }

    const irlsDeg = (Math.atan(slope) * 180) / Math.PI;
    if (Math.abs(irlsDeg - rawDetectedDeg) <= 0.45) {
      rawDetectedDeg = clamp(irlsDeg, -limit, limit);
    }
  }

  const detectedTiltDeg = Math.abs(rawDetectedDeg) < 0.02 ? 0 : Number(rawDetectedDeg.toFixed(2));

  const meanEnergy = totalEnergy / numBins;
  const peakRatio = maxEnergy > 0 ? (maxEnergy - meanEnergy) / maxEnergy : 0;
  const minCoherentSupport = Math.max(12, Math.min(width, height) * 0.16) * 80.0;
  const coherency = clamp(bestSupport / minCoherentSupport, 0.0, 1.0);
  const confidence = clamp(Number((peakRatio * coherency).toFixed(2)), 0.0, 0.99);

  // Confidence threshold: suppress erratic rotation on low-contrast/textured scenes
  const MIN_CONFIDENCE_THRESHOLD = 0.35;
  const appliedRotationDeg =
    confidence >= MIN_CONFIDENCE_THRESHOLD ? Number((-detectedTiltDeg).toFixed(2)) : 0;

  return {
    detectedTiltDeg,
    appliedRotationDeg,
    confidence,
    strongEdgeCount,
  };
}

export const MAX_CANVAS_DIMENSION = 16384;
export const MAX_CANVAS_AREA = 67108864; // 8192 x 8192 px: WebKit / iOS Safari maximum canvas area limit

/**
 * Computes the White Border frame canvas dimensions and centered inner photo coordinates
 * following the `com.vector123.whiteborder` no-crop framing model.
 */
export function computeFrameLayout(
  sourceWidth: number,
  sourceHeight: number,
  aspectPreset: AspectRatioPreset,
  paddingPercent: number,
  renderExifCaption = false,
  pixelAreaBudget?: number
): FrameLayout {
  const safeW = Math.max(1, Math.round(sourceWidth));
  const safeH = Math.max(1, Math.round(sourceHeight));
  const padRatio = clamp(paddingPercent, 0, 40) / 100;

  let targetRatio = safeW / safeH;
  if (aspectPreset === '1:1') targetRatio = 1.0;
  else if (aspectPreset === '4:5') targetRatio = 4 / 5;
  else if (aspectPreset === '16:9') targetRatio = 16 / 9;
  else if (aspectPreset === '3:2') targetRatio = 3 / 2;

  // Account for padding margins and bottom EXIF caption reserve
  const footerRatio = renderExifCaption ? 0.045 : 0;
  const hFraction = Math.max(0.2, 1 - 2 * padRatio);
  const vFraction = Math.max(0.2, 1 - 2 * padRatio - footerRatio);

  // Binding canvas dimensions: ensure neither width nor height constraints cause downscaling of source image
  const reqCanvasW_from_W = safeW / hFraction;
  const reqCanvasH_from_W = reqCanvasW_from_W / targetRatio;

  const reqCanvasH_from_H = safeH / vFraction;
  const reqCanvasW_from_H = reqCanvasH_from_H * targetRatio;

  let canvasWidth: number;
  let canvasHeight: number;

  if (reqCanvasW_from_W >= reqCanvasW_from_H) {
    canvasWidth = Math.ceil(reqCanvasW_from_W);
    canvasHeight = Math.ceil(canvasWidth / targetRatio);
  } else {
    canvasHeight = Math.ceil(reqCanvasH_from_H);
    canvasWidth = Math.ceil(canvasHeight * targetRatio);
  }

  let wasCapped = false;

  // Cap computed frame dimensions at maximum supported canvas limit before allocation
  if (canvasWidth > MAX_CANVAS_DIMENSION) {
    canvasWidth = MAX_CANVAS_DIMENSION;
    canvasHeight = Math.max(1, Math.round(canvasWidth / targetRatio));
    wasCapped = true;
  }
  if (canvasHeight > MAX_CANVAS_DIMENSION) {
    canvasHeight = MAX_CANVAS_DIMENSION;
    canvasWidth = Math.max(1, Math.round(canvasHeight * targetRatio));
    wasCapped = true;
  }

  // Cap computed frame area at maximum supported browser canvas area limit (e.g. WebKit / iOS Safari) or opt-in budget
  const effectiveMaxArea =
    typeof pixelAreaBudget === 'number' && Number.isFinite(pixelAreaBudget) && pixelAreaBudget >= 1
      ? Math.min(MAX_CANVAS_AREA, pixelAreaBudget)
      : MAX_CANVAS_AREA;

  if (canvasWidth * canvasHeight > effectiveMaxArea) {
    const areaScale = Math.sqrt(effectiveMaxArea / (canvasWidth * canvasHeight));
    canvasWidth = Math.max(1, Math.floor(canvasWidth * areaScale));
    canvasHeight = Math.max(1, Math.floor(canvasWidth / targetRatio));
    while (canvasWidth * canvasHeight > effectiveMaxArea && (canvasWidth > 1 || canvasHeight > 1)) {
      if (canvasWidth > 1 && (canvasHeight <= 1 || canvasWidth / targetRatio >= canvasHeight)) {
        canvasWidth--;
      } else if (canvasHeight > 1) {
        canvasHeight--;
      } else {
        break;
      }
    }
    wasCapped = true;
  }

  // Reserve extra bottom margin if EXIF caption stamp is enabled
  const exifFooterReserve = renderExifCaption ? Math.floor(canvasHeight * 0.045) : 0;

  // Round margins down so available drawing area is at least as large as the source image
  let minMarginX = Math.floor(canvasWidth * padRatio);
  let minMarginY = Math.floor(canvasHeight * padRatio);

  // If not capped at maximum canvas dimension or area, ensure available area does not fall below source size due to rounding
  if (!wasCapped) {
    if (canvasWidth - minMarginX * 2 < safeW) {
      canvasWidth = safeW + minMarginX * 2;
      canvasHeight = Math.max(canvasHeight, Math.ceil(canvasWidth / targetRatio));
      minMarginX = Math.floor(canvasWidth * padRatio);
      minMarginY = Math.floor(canvasHeight * padRatio);
    }
    if (canvasHeight - minMarginY * 2 - exifFooterReserve < safeH) {
      canvasHeight = safeH + minMarginY * 2 + exifFooterReserve;
      canvasWidth = Math.max(canvasWidth, Math.ceil(canvasHeight * targetRatio));
      minMarginX = Math.floor(canvasWidth * padRatio);
      minMarginY = Math.floor(canvasHeight * padRatio);
    }
  }

  const availW = Math.max(1, canvasWidth - minMarginX * 2);
  const availH = Math.max(1, canvasHeight - minMarginY * 2 - exifFooterReserve);

  const scale = Math.min(1.0, availW / safeW, availH / safeH);
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

/**
 * Computes a uniform scale factor to fit an image of dimensions (width x height)
 * within an opt-in pixel area budget (width * height <= pixelAreaBudget).
 * Validates any supplied pixel-area budget as positive and finite.
 * Returns 1.0 (full resolution) when budget is omitted, non-positive, or non-finite.
 */
export function computePixelAreaScale(
  width: number,
  height: number,
  pixelAreaBudget?: number
): number {
  if (width <= 0 || height <= 0) return 1.0;
  if (
    typeof pixelAreaBudget !== 'number' ||
    !Number.isFinite(pixelAreaBudget) ||
    pixelAreaBudget <= 0
  ) {
    return 1.0;
  }
  const currentArea = width * height;
  if (currentArea <= pixelAreaBudget) {
    return 1.0;
  }
  return Math.sqrt(pixelAreaBudget / currentArea);
}

/**
 * Applies a uniform scale to fit dimensions within the pixel-area budget.
 * Validates any supplied pixel-area budget as positive and finite, using an effective
 * budget with a minimum of one pixel for its early return, scaling calculation, and area-reduction loop.
 * Rounds scaled dimensions and ensures their resulting area stays strictly within the budget.
 * Sub-pixel budgets produce a 1×1 result. Full resolution is preserved when budget is omitted or invalid.
 */
export function getScaledDimensionsWithinBudget(
  width: number,
  height: number,
  pixelAreaBudget?: number
): { width: number; height: number; scale: number } {
  const safeW = Math.max(1, Math.round(width));
  const safeH = Math.max(1, Math.round(height));

  if (
    typeof pixelAreaBudget !== 'number' ||
    !Number.isFinite(pixelAreaBudget) ||
    pixelAreaBudget <= 0
  ) {
    return { width: safeW, height: safeH, scale: 1.0 };
  }

  const effectiveBudget = Math.max(1, pixelAreaBudget);
  const currentArea = safeW * safeH;
  if (currentArea <= effectiveBudget) {
    return { width: safeW, height: safeH, scale: 1.0 };
  }

  let scale = Math.sqrt(effectiveBudget / currentArea);
  let scaledW = Math.max(1, Math.round(safeW * scale));
  let scaledH = Math.max(1, Math.round(safeH * scale));

  while (scaledW * scaledH > effectiveBudget && (scaledW > 1 || scaledH > 1)) {
    if (scaledW / safeW >= scaledH / safeH && scaledW > 1) {
      scaledW--;
    } else if (scaledH > 1) {
      scaledH--;
    } else {
      break;
    }
  }
  scale = Math.min(scaledW / safeW, scaledH / safeH);

  return { width: scaledW, height: scaledH, scale };
}

/**
 * Analyzes an RGBA image buffer to compute optimal darkroom Auto-Correct parameters:
 * - Percentile histogram black/white anchor points (0.5% and 99.5%)
 * - Exposure compensation (EV) targeting perceptual midtone balance with highlight headroom protection
 * - Adaptive shadow recovery and highlight roll-off
 * - Sigmoidal micro-contrast boost
 * - Midtone-weighted Gray-World white balance neutralization
 */
export function analyzeAutoCorrection(
  rgbaData: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number
): AutoCorrectAnalysis {
  const totalPixels = Math.max(0, Math.min(width * height, Math.floor(rgbaData.length / 4)));
  if (totalPixels < 4 || width <= 0 || height <= 0) {
    return {
      exposureEv: 0,
      contrast: 0,
      shadows: 0,
      highlights: 0,
      wbTempShift: 0,
      wbTintShift: 0,
      blackPoint: 0,
      whitePoint: 255,
      dynamicRangeStops: 8.0,
    };
  }

  const lumaHist = new Uint32Array(256);
  const stride = Math.max(1, Math.floor(totalPixels / 16384));
  let sampleCount = 0;

  let midR = 0;
  let midG = 0;
  let midB = 0;
  let midCount = 0;

  for (let p = 0; p < totalPixels; p += stride) {
    const idx = p * 4;
    const r = rgbaData[idx];
    const g = rgbaData[idx + 1];
    const b = rgbaData[idx + 2];

    // Rec. 709 luma
    const y = clamp(Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b), 0, 255);
    lumaHist[y]++;
    sampleCount++;

    // Sample non-clipped, moderate-saturation midtones for illuminant chromaticity estimation
    if (y >= 32 && y <= 220) {
      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      if (maxC - minC < 110) {
        midR += r;
        midG += g;
        midB += b;
        midCount++;
      }
    }
  }

  const findPercentile = (fraction: number): number => {
    const target = Math.max(1, Math.round(sampleCount * fraction));
    let acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += lumaHist[i];
      if (acc >= target) return i;
    }
    return 255;
  };

  const p005 = findPercentile(0.005);
  const p15 = findPercentile(0.15);
  const p50 = findPercentile(0.5);
  const p85 = findPercentile(0.85);
  const p995 = findPercentile(0.995);

  const blackPoint = clamp(p005, 0, 38);
  const whitePoint = clamp(p995, 210, 255);
  const span = Math.max(16, whitePoint - blackPoint);

  const normMedian = clamp((p50 - blackPoint) / span, 0.08, 0.92);
  let rawEv = Math.log2(0.48 / normMedian) * 0.45;
  if (rawEv > 0 && p85 > 210) {
    rawEv *= clamp((245 - p85) / 35, 0.15, 1.0);
  }
  const exposureEv = Number(clamp(rawEv, -0.85, 0.85).toFixed(2));

  const contrast =
    span < 215 ? clamp(Math.round((235 - span) * 0.24 + 8), 8, 32) : 10;

  const shadows = p15 < 58 ? clamp(Math.round((58 - p15) * 0.65), 0, 38) : 0;
  const highlights = p85 > 198 ? -clamp(Math.round((p85 - 198) * 0.65), 0, 38) : 0;

  let wbTempShift = 0;
  let wbTintShift = 0;
  if (midCount >= 16) {
    const avgR = midR / midCount;
    const avgG = midG / midCount;
    const avgB = midB / midCount;
    const avgGray = (avgR + avgG + avgB) / 3;
    // Damped correction to neutralize unwanted cast while preserving intentional scene mood
    wbTempShift = clamp(Math.round((avgB - avgR) * 0.35), -18, 18);
    wbTintShift = clamp(Math.round((avgGray - avgG) * 0.35), -14, 14);
  }

  const dynamicRangeStops = Number(
    clamp(Math.log2(Math.max(2, p995 - p005 + 1)) * 1.42, 1.0, 11.5).toFixed(1)
  );

  return {
    exposureEv,
    contrast,
    shadows,
    highlights,
    wbTempShift,
    wbTintShift,
    blackPoint,
    whitePoint,
    dynamicRangeStops,
  };
}

/**
 * Applies darkroom Auto-Correct luminance-preserving filmic tone curve, shadow/highlight recovery,
 * micro-contrast S-curve, and midtone-weighted white balance neutralization in-place.
 */
export function applyAutoCorrectionToRgba(
  rgbaData: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  analysis: AutoCorrectAnalysis,
  strengthPercent = 75
): void {
  const strength = clamp(strengthPercent, 0, 100) / 100;
  const totalPixels = Math.max(0, Math.min(width * height, Math.floor(rgbaData.length / 4)));
  if (strength <= 0.001 || totalPixels === 0) return;

  const toneLut = new Float32Array(256);
  const midWeightLut = new Float32Array(256);

  const bp = analysis.blackPoint * 0.65;
  const wp = 255 - (255 - analysis.whitePoint) * 0.65;
  const range = Math.max(1, wp - bp);
  const gamma = Math.pow(2, -analysis.exposureEv * 0.55);
  const shadowFactor = (analysis.shadows / 100) * 0.26;
  const highlightFactor = (analysis.highlights / 100) * 0.24;
  const contrastFactor = (analysis.contrast / 100) * 0.52;

  const rShift = (analysis.wbTempShift * 1.25 - analysis.wbTintShift * 0.35) * strength;
  const gShift = analysis.wbTintShift * 0.85 * strength;
  const bShift = (-analysis.wbTempShift * 1.25 - analysis.wbTintShift * 0.35) * strength;

  for (let v = 0; v < 256; v++) {
    // 1. Percentile black/white point stretch
    let x = clamp((v - bp) / range, 0, 1);

    // 2. Exposure EV gamma
    x = Math.pow(x, gamma);

    // 3. Shadow lift & highlight roll-off
    const sLift = shadowFactor * (1 - x) * (1 - x) * Math.sqrt(x);
    const hComp = highlightFactor * x * x * (1 - x * 0.5);
    x = clamp(x + sLift + hComp, 0, 1);

    // 4. Smooth sigmoidal micro-contrast S-curve
    x = clamp(x - (contrastFactor * Math.sin(2 * Math.PI * x)) / (2 * Math.PI), 0, 1);

    toneLut[v] = v + (x * 255 - v) * strength;
    const normV = v / 255;
    midWeightLut[v] = 4 * normV * (1 - normV);
  }

  const end = totalPixels * 4;
  for (let i = 0; i < end; i += 4) {
    const r = rgbaData[i];
    const g = rgbaData[i + 1];
    const b = rgbaData[i + 2];

    const y = (54 * r + 183 * g + 19 * b) >> 8;
    const targetY = toneLut[y];
    const mw = midWeightLut[y];

    // Apply midtone-weighted white balance neutralization
    const rw = r + rShift * mw;
    const gw = g + gShift * mw;
    const bw = b + bShift * mw;
    const yw = 0.2126 * rw + 0.7152 * gw + 0.0722 * bw;

    // Luminance-preserving tone mapping with bounded chroma scaling
    const chromaScale = yw > 1 ? clamp(targetY / yw, 0.65, 1.25) : 1.0;

    rgbaData[i] = clamp(Math.round(targetY + (rw - yw) * chromaScale), 0, 255);
    rgbaData[i + 1] = clamp(Math.round(targetY + (gw - yw) * chromaScale), 0, 255);
    rgbaData[i + 2] = clamp(Math.round(targetY + (bw - yw) * chromaScale), 0, 255);
  }
}


