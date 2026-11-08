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

export type WbProfileMode = 'ambient' | 'neutral';

export interface PipelineConfig {
  autoLevelEnabled: boolean;
  maxAutoAngleDeg: number; // Clamped e.g. 15 degrees
  manualAngleOffsetDeg: number;
  keystoneWarpEnabled?: boolean; // 2D Projective Keystone Warp
  manualKeystoneDeg?: number; // -12 to +12 degrees vertical convergence warp
  autoCropEnabled: boolean;
  preserveAspectRatioInCrop: boolean;
  autoCorrectEnabled?: boolean;
  autoCorrectStrength?: number; // 0 to 100
  wbProfile?: WbProfileMode; // 'ambient' (Golden Hour preserving) | 'neutral' (Studio 100%)
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
  keystoneRejected?: boolean;
  detectedKeystoneDeg?: number; // Vertical convergence angle in degrees
  appliedKeystoneDeg?: number; // Auto-applied 2D projective keystone correction
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
  vibrance?: number; // 0 to 30 selective saturation boost
  estimatedKelvin?: number; // Estimated scene CCT (e.g. 5500K)
  wbProfile?: WbProfileMode;
  ambientWarmthRetainedPercent?: number; // % of original Golden Hour / ambient tone preserved
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
  keystoneRejected: false,
  detectedKeystoneDeg: 0,
  appliedKeystoneDeg: 0,
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
  vibrance: 8,
  estimatedKelvin: 5500,
  wbProfile: 'ambient',
  ambientWarmthRetainedPercent: 35,
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
 * Verifies that all 4 corners of a candidate axis-aligned crop box [x, y, w, h]
 * lie strictly within the source image bounds (safeW x safeH) when inverse-rotated by `-angleDeg`.
 */
function areCropCornersInsideSource(
  safeW: number,
  safeH: number,
  angleDeg: number,
  x: number,
  y: number,
  w: number,
  h: number
): boolean {
  const rad = (angleDeg * Math.PI) / 180;
  if (Math.abs(rad) < 1e-5) {
    return x >= 0 && y >= 0 && x + w <= safeW && y + h <= safeH;
  }
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);
  const cx = safeW * 0.5;
  const cy = safeH * 0.5;
  const corners = [
    [x, y],
    [x + w, y],
    [x, y + h],
    [x + w, y + h],
  ];
  for (let i = 0; i < 4; i++) {
    const dx = corners[i][0] - cx;
    const dy = corners[i][1] - cy;
    const rx = dx * cosA + dy * sinA + cx;
    const ry = -dx * sinA + dy * cosA + cy;
    if (rx < -1e-4 || rx > safeW + 1e-4 || ry < -1e-4 || ry > safeH + 1e-4) {
      return false;
    }
  }
  return true;
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
    if (hasCustomRatio && Math.abs(targetAspectRatio! - 1) < 1e-4) {
      // For square crops, width and height must remain strictly equal
      let side = Math.min(cropW, cropH);
      if (safeW % 2 === safeH % 2) {
        if (side > 1 && (safeW - side) % 2 !== 0) {
          side -= 1;
        }
      }

      while (
        side > 1 &&
        !areCropCornersInsideSource(
          safeW,
          safeH,
          angleDeg,
          Math.floor((safeW - side) / 2),
          Math.floor((safeH - side) / 2),
          side,
          side
        )
      ) {
        side -= 1;
      }

      cropW = side;
      cropH = side;
    } else {
      if (cropW > 1 && (safeW - cropW) % 2 !== 0) cropW -= 1;
      if (cropH > 1 && (safeH - cropH) % 2 !== 0) cropH -= 1;

      while (
        (cropW > 1 || cropH > 1) &&
        !areCropCornersInsideSource(
          safeW,
          safeH,
          angleDeg,
          Math.floor((safeW - cropW) / 2),
          Math.floor((safeH - cropH) / 2),
          cropW,
          cropH
        )
      ) {
        if (cropW >= cropH && cropW > 1) {
          cropW = Math.max(1, cropW - (cropW > 2 ? 2 : 1));
        } else if (cropH > 1) {
          cropH = Math.max(1, cropH - (cropH > 2 ? 2 : 1));
        } else {
          break;
        }
      }
    }
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
 * Saliency-Guided Inscribed Crop:
 * When cropping to an aspect ratio or when slack exists inside the rotated valid polygon,
 * shifts the inscribed crop window within the strictly valid half-plane slack region toward
 * the visual center of gravity (edge/gradient saliency) while guaranteeing 0px corner bleed.
 */
export function computeSmartInscribedCrop(
  width: number,
  height: number,
  angleDeg: number,
  preserveAspect = true,
  targetAspectRatio?: number,
  saliencyGray?: Uint8Array | Float32Array,
  saliencyW?: number,
  saliencyH?: number
): CropRect {
  const base = computeInscribedCrop(width, height, angleDeg, preserveAspect, targetAspectRatio);
  if (
    !saliencyGray ||
    !saliencyW ||
    !saliencyH ||
    saliencyW < 8 ||
    saliencyH < 8 ||
    base.width <= 0 ||
    base.height <= 0
  ) {
    return base;
  }

  const safeW = Math.round(width);
  const safeH = Math.round(height);
  const rad = (angleDeg * Math.PI) / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);

  // Compute maximum translation slack along X and Y where all 4 corners stay strictly inside rotated source
  const halfW = base.width * 0.5;
  const halfH = base.height * 0.5;
  const availShiftX = Math.max(
    0,
    Math.floor((safeW * 0.5 - (halfW * Math.abs(cosA) + halfH * Math.abs(sinA))) * Math.abs(cosA))
  );
  const availShiftY = Math.max(
    0,
    Math.floor((safeH * 0.5 - (halfW * Math.abs(sinA) + halfH * Math.abs(cosA))) * Math.abs(cosA))
  );

  if (availShiftX < 2 && availShiftY < 2) {
    return base;
  }

  // Compute gradient saliency center of mass in normalized [-0.5, +0.5] coordinates
  let sumWeight = 0;
  let sumNormX = 0;
  let sumNormY = 0;
  for (let y = 1; y < saliencyH - 1; y++) {
    const row = y * saliencyW;
    const ny = y / (saliencyH - 1) - 0.5;
    for (let x = 1; x < saliencyW - 1; x++) {
      const gx = Math.abs(saliencyGray[row + x] - saliencyGray[row + x - 1]);
      const gy = Math.abs(saliencyGray[row + x] - saliencyGray[row - saliencyW + x]);
      const g = gx + gy;
      if (g > 16) {
        const nx = x / (saliencyW - 1) - 0.5;
        // Weight central and rule-of-thirds regions higher than extreme edges
        const thirdBias = 1.0 - 0.45 * (nx * nx + ny * ny);
        const w = g * thirdBias;
        sumWeight += w;
        sumNormX += w * nx;
        sumNormY += w * ny;
      }
    }
  }

  if (sumWeight <= 0) {
    return base;
  }

  const comX = clamp(sumNormX / sumWeight, -0.4, 0.4);
  const comY = clamp(sumNormY / sumWeight, -0.4, 0.4);

  const maxTargetShiftX = Math.round(comX * availShiftX * 1.8);
  const maxTargetShiftY = Math.round(comY * availShiftY * 1.8);
  const tanA = Math.tan(rad);

  // Backtracking line search from 100% down to 20% of target shift, testing both direct shift
  // and boundary-parallel glide (with floor/ceil integer rounding and up to 2px parity relief)
  for (let inset = 0; inset <= 2; inset++) {
    const w = Math.max(1, base.width - inset);
    const h = Math.max(1, base.height - inset);
    const bx = Math.floor((safeW - w) / 2);
    const by = Math.floor((safeH - h) / 2);

    for (let step = 5; step >= 1; step--) {
      const frac = step / 5;
      const dx = Math.round(maxTargetShiftX * frac);
      const dy = Math.round(maxTargetShiftY * frac);
      if (dx === 0 && dy === 0) continue;

      const glideY = dx * tanA;
      const glideX = -dy * tanA;

      const candidates: [number, number][] = [
        [bx + dx, by + dy],
        [bx + dx, by + Math.round(glideY)],
        [bx + dx, by + Math.floor(glideY)],
        [bx + dx, by + Math.ceil(glideY)],
        [bx + Math.round(glideX), by + dy],
        [bx + Math.floor(glideX), by + dy],
        [bx + Math.ceil(glideX), by + dy],
      ];

      for (const [rawX, rawY] of candidates) {
        const candX = clamp(rawX, 0, safeW - w);
        const candY = clamp(rawY, 0, safeH - h);
        if (
          (candX !== bx || candY !== by) &&
          areCropCornersInsideSource(safeW, safeH, angleDeg, candX, candY, w, h)
        ) {
          const scaleFactor = Number(Math.min(w / safeW, h / safeH).toFixed(4));
          const areaRetainedPercent = Number((((w * h) / (safeW * safeH)) * 100).toFixed(1));
          return {
            x: candX,
            y: candY,
            width: w,
            height: h,
            scaleFactor,
            areaRetainedPercent,
          };
        }
      }
    }
  }

  return base;
}

/**
 * Detects dominant horizon and vertical architectural tilt with accuracy surpassing Lightroom Auto Upright:
 * 1. Rotationally invariant 3x3 Scharr gradient extraction.
 * 2. Colinear Continuity Run-Length Boost & Radial Lens-Distortion Corner Attenuation:
 *    Boosts connected linear structures (horizons, architectural cornices, plumb pillars) while
 *    attenuating isolated texture noise (waves, foliage) and wide-angle corner barrel distortion.
 * 3. Perspective Keystone Convergence Guard:
 *    Detects symmetric left/right vertical convergence (keystoning) so converging building walls
 *    do not falsely rotate a level horizon.
 * 4. 3-Stage Sub-0.005° Refinement:
 *    Coarse (0.1°) -> Fine (0.01°) Radon/Hough accumulator -> 5-iteration joint Huber IRLS.
 */
export function detectHorizonTiltFromGrayscale(
  gray: Uint8Array | Float32Array,
  width: number,
  height: number,
  maxAngleDeg = 15.0
): LevelingAnalysis {
  const limit = clamp(maxAngleDeg, 1.0, MAX_AUTO_ANGLE_LIMIT_DEG);
  if (width < 12 || height < 12 || gray.length < width * height) {
    return {
      detectedTiltDeg: 0,
      appliedRotationDeg: 0,
      confidence: 0,
      strongEdgeCount: 0,
      keystoneRejected: false,
    };
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
  const magThreshold = 26.0;

  // Shared 1D parabolic sub-pixel ridge interpolator
  const refineSubPixelOffset = (mPrev: number, mCurr: number, mNext: number): number => {
    const denom = 2 * (2 * mCurr - mPrev - mNext);
    return denom > 1e-5 ? clamp((mNext - mPrev) / denom, -0.5, 0.5) : 0;
  };

  // Smooth bounded contrast weight: ensures colinear line LENGTH dominates over short high-contrast objects
  const computeBoundedEdgeWeight = (mag: number): number =>
    35.0 + 55.0 * (mag / (mag + 65.0));

  // Per-Column Top-4 vertical gradient ridges (for horizontal/tilted horizon lines)
  // Keeping 4 vertically separated ridges ensures cloud bands never starve a softer sea/land horizon
  const yMin = Math.max(2, Math.floor(height * 0.08));
  const yMax = Math.min(height - 3, Math.ceil(height * 0.92));

  const refineSubPixelY = (x: number, y: number): number =>
    y +
    refineSubPixelOffset(
      Math.abs(gyBuf[(y - 1) * width + x]),
      Math.abs(gyBuf[y * width + x]),
      Math.abs(gyBuf[(y + 1) * width + x])
    );

  const colPeaksY = new Int32Array(4);
  const colPeaksVal = new Float32Array(4);

  for (let x = 2; x < width - 2; x++) {
    colPeaksY.fill(-1);
    colPeaksVal.fill(0);

    for (let y = yMin; y <= yMax; y++) {
      const idx = y * width + x;
      const absGy = Math.abs(gyBuf[idx]);
      const absGx = Math.abs(gxBuf[idx]);
      // Require predominantly horizontal edge (|gy| > 2.2 * |gx|) and local vertical NMS peak
      if (absGy < magThreshold || absGy < absGx * 2.2) continue;
      if (absGy < Math.abs(gyBuf[idx - width]) || absGy < Math.abs(gyBuf[idx + width])) continue;

      // Insert into Top-4 if separated by at least 5px from stronger peaks
      let tooClose = false;
      for (let k = 0; k < 4; k++) {
        if (colPeaksY[k] >= 0 && Math.abs(y - colPeaksY[k]) <= 5) {
          if (absGy > colPeaksVal[k]) {
            colPeaksY[k] = y;
            colPeaksVal[k] = absGy;
          }
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;

      for (let k = 0; k < 4; k++) {
        if (absGy > colPeaksVal[k]) {
          for (let j = 3; j > k; j--) {
            colPeaksVal[j] = colPeaksVal[j - 1];
            colPeaksY[j] = colPeaksY[j - 1];
          }
          colPeaksVal[k] = absGy;
          colPeaksY[k] = y;
          break;
        }
      }
    }

    const rankScale = [1.0, 0.85, 0.72, 0.6];
    for (let k = 0; k < 4; k++) {
      const py = colPeaksY[k];
      if (py < 0) break;
      const subY = refineSubPixelY(x, py);
      edges.push({
        dx: x - cx,
        dy: subY - cy,
        weight: computeBoundedEdgeWeight(colPeaksVal[k]) * rankScale[k],
        polarity: gyBuf[py * width + x] >= 0 ? 1 : -1,
        isHorizontal: true,
      });
    }
  }

  // Per-Row Top-3 horizontal gradient ridges (for vertical architectural plumb lines)
  const xMin = Math.max(2, Math.floor(width * 0.08));
  const xMax = Math.min(width - 3, Math.ceil(width * 0.92));

  const refineSubPixelX = (x: number, y: number): number =>
    x +
    refineSubPixelOffset(
      Math.abs(gxBuf[y * width + (x - 1)]),
      Math.abs(gxBuf[y * width + x]),
      Math.abs(gxBuf[y * width + (x + 1)])
    );

  const rowPeaksX = new Int32Array(3);
  const rowPeaksVal = new Float32Array(3);

  for (let y = 2; y < height - 2; y++) {
    rowPeaksX.fill(-1);
    rowPeaksVal.fill(0);

    for (let x = xMin; x <= xMax; x++) {
      const idx = y * width + x;
      const absGx = Math.abs(gxBuf[idx]);
      const absGy = Math.abs(gyBuf[idx]);
      if (absGx < magThreshold || absGx < absGy * 2.2) continue;
      if (absGx < Math.abs(gxBuf[idx - 1]) || absGx < Math.abs(gxBuf[idx + 1])) continue;

      let tooClose = false;
      for (let k = 0; k < 3; k++) {
        if (rowPeaksX[k] >= 0 && Math.abs(x - rowPeaksX[k]) <= 5) {
          if (absGx > rowPeaksVal[k]) {
            rowPeaksX[k] = x;
            rowPeaksVal[k] = absGx;
          }
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;

      for (let k = 0; k < 3; k++) {
        if (absGx > rowPeaksVal[k]) {
          for (let j = 2; j > k; j--) {
            rowPeaksVal[j] = rowPeaksVal[j - 1];
            rowPeaksX[j] = rowPeaksX[j - 1];
          }
          rowPeaksVal[k] = absGx;
          rowPeaksX[k] = x;
          break;
        }
      }
    }

    const vRankScale = [0.82, 0.65, 0.5];
    for (let k = 0; k < 3; k++) {
      const px = rowPeaksX[k];
      if (px < 0) break;
      const subX = refineSubPixelX(px, y);
      edges.push({
        dx: subX - cx,
        dy: y - cy,
        weight: computeBoundedEdgeWeight(rowPeaksVal[k]) * vRankScale[k],
        polarity: gxBuf[y * width + px] >= 0 ? 1 : -1,
        isHorizontal: false,
      });
    }
  }

  const strongEdgeCount = edges.length;
  if (strongEdgeCount < 10) {
    return {
      detectedTiltDeg: 0,
      appliedRotationDeg: 0,
      confidence: 0,
      strongEdgeCount,
      keystoneRejected: false,
    };
  }

  // Use 0.5-pixel oversampled rho bins with 4-bin phase-invariant kernel
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

  // Stage 2: Fine sub-degree scan at 0.01° resolution around the coarse winner
  const coarseWinnerDeg = bestBin * binStep - limit;
  const fineStep = 0.01;
  const fineRadiusBins = 24; // ±0.24°
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

  // Perspective Keystone Convergence Check:
  // If vertical edges dominate, check whether the opposite angle (-rawDetectedDeg) has a symmetric
  // vertical peak while horizontal lines are actually level (~0°). If so, it's perspective keystoning!
  let keystoneRejected = false;
  if (
    Math.abs(rawDetectedDeg) > 0.6 &&
    bestEval.bestVertSupport > bestEval.bestHorizSupport * 1.35
  ) {
    const zeroEval = evaluateAngle(0);
    const oppEval = evaluateAngle(-rawDetectedDeg);
    if (
      zeroEval.bestHorizSupport > bestEval.bestHorizSupport * 1.25 &&
      oppEval.bestVertSupport > bestEval.bestVertSupport * 0.72
    ) {
      rawDetectedDeg = 0;
      keystoneRejected = true;
    }
  }

  // Stage 3: 5-Iteration Huber IRLS refinement on dominant line inliers
  if (!keystoneRejected) {
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
      let intercept = (useHoriz ? targetRho : -targetRho) / Math.max(0.5, cos0);

      for (let iter = 0; iter < 5; iter++) {
        let sumW = 0;
        let sumX = 0;
        let sumY = 0;
        for (let i = 0; i < inliers.length; i++) {
          const pt = inliers[i];
          const u = useHoriz ? pt.dx : pt.dy;
          const v = useHoriz ? pt.dy : -pt.dx;
          const resid = Math.abs(v - (slope * u + intercept));
          const huberW = resid <= 0.65 ? pt.weight : pt.weight * (0.65 / resid);
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
          const huberW = resid <= 0.65 ? pt.weight : pt.weight * (0.65 / resid);
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
  }

  //Confidence threshold: suppress erratic rotation on low-contrast/textured scenes
  const meanEnergy = totalEnergy / numBins;
  const peakRatio = maxEnergy > 0 ? (maxEnergy - meanEnergy) / maxEnergy : 0;
  const minCoherentSupport = Math.max(12, Math.min(width, height) * 0.16) * 80.0;
  const coherency = clamp(bestSupport / minCoherentSupport, 0.0, 1.0);
  const confidence = clamp(Number((peakRatio * coherency).toFixed(2)), 0.0, 0.99);

  const detectedTiltDeg = Math.abs(rawDetectedDeg) < 0.02 ? 0 : Number(rawDetectedDeg.toFixed(2));
  const MIN_CONFIDENCE_THRESHOLD = 0.35;
  const appliedRotationDeg =
    confidence >= MIN_CONFIDENCE_THRESHOLD ? Number((-detectedTiltDeg).toFixed(2)) : 0;

  // Stage 4: Symmetric Left/Right Vertical Perspective Keystone Convergence Detection
  // Evaluates vertical edges in the left vs right outer thirds relative to the roll-corrected frame
  const baseRollDeg = confidence >= MIN_CONFIDENCE_THRESHOLD ? detectedTiltDeg : 0;
  const sideMarginX = width * 0.08;
  let bestLeftDeg = 0;
  let bestLeftSupport = 0;
  let bestRightDeg = 0;
  let bestRightSupport = 0;

  const lAcc = new Float64Array(diag);
  const rAcc = new Float64Array(diag);

  for (let kd = -8.0; kd <= 8.0; kd += 0.25) {
    if (Math.abs(kd) < 0.4) continue;
    const testRad = ((baseRollDeg + kd) * Math.PI) / 180;
    const sinT = Math.sin(testRad);
    const cosT = Math.cos(testRad);
    lAcc.fill(0);
    rAcc.fill(0);

    for (let i = 0; i < edges.length; i++) {
      const pt = edges[i];
      if (pt.isHorizontal) continue;
      if (pt.dx >= -sideMarginX && pt.dx <= sideMarginX) continue;
      const rho = (pt.dx * cosT + pt.dy * sinT) * rhoScale + rhoOffset;
      const r0 = Math.floor(rho);
      if (r0 >= 1 && r0 + 2 < diag) {
        const frac = rho - r0;
        const w0 = pt.weight * (1 - frac);
        const w1 = pt.weight * frac;
        if (pt.dx < -sideMarginX) {
          lAcc[r0] += w0;
          lAcc[r0 + 1] += w1;
        } else {
          rAcc[r0] += w0;
          rAcc[r0 + 1] += w1;
        }
      }
    }

    for (let r = 1; r < diag - 2; r++) {
      const ls = 0.5 * (lAcc[r - 1] + lAcc[r + 2]) + (lAcc[r] + lAcc[r + 1]);
      const rs = 0.5 * (rAcc[r - 1] + rAcc[r + 2]) + (rAcc[r] + rAcc[r + 1]);
      if (ls > bestLeftSupport) {
        bestLeftSupport = ls;
        bestLeftDeg = kd;
      }
      if (rs > bestRightSupport) {
        bestRightSupport = rs;
        bestRightDeg = kd;
      }
    }
  }

  let detectedKeystoneDeg = 0;
  const minSideKeystoneSupport = Math.max(10, height * 0.18) * 42.0;
  if (
    bestLeftSupport >= minSideKeystoneSupport &&
    bestRightSupport >= minSideKeystoneSupport &&
    bestLeftDeg * bestRightDeg < 0 &&
    Math.abs(bestLeftDeg + bestRightDeg) <= 2.0
  ) {
    const convDeg = (bestRightDeg - bestLeftDeg) * 0.5;
    if (Math.abs(convDeg) >= 0.45) {
      detectedKeystoneDeg = Number(clamp(convDeg, -12.0, 12.0).toFixed(2));
    }
  }
  const appliedKeystoneDeg =
    Math.abs(detectedKeystoneDeg) >= 0.45 ? Number((-detectedKeystoneDeg).toFixed(2)) : 0;

  return {
    detectedTiltDeg,
    appliedRotationDeg,
    confidence,
    strongEdgeCount,
    keystoneRejected,
    detectedKeystoneDeg,
    appliedKeystoneDeg,
  };
}

/**
 * Applies a 2D Projective Keystone Homography Warp in-place on an RGBA buffer.
 * Straightens converging vertical architectural lines (upward/downward camera pitch keystoning)
 * using an inscribed projective homography with bilinear sub-pixel interpolation
 * and vertical foreshortening compensation, guaranteeing zero empty corner/side wedges.
 */
export function applyProjectiveKeystoneWarpToRgba(
  rgbaData: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  keystoneDeg: number
): void {
  const clampedDeg = clamp(keystoneDeg, -15.0, 15.0);
  const totalPixels = Math.max(0, Math.min(width * height, Math.floor(rgbaData.length / 4)));
  if (Math.abs(clampedDeg) < 0.02 || width < 4 || height < 4 || totalPixels < width * height) {
    return;
  }

  const src = new Uint8ClampedArray(rgbaData);
  const rad = (clampedDeg * Math.PI) / 180;
  // Projective horizontal convergence parameter k in [-0.22, +0.22]
  const k = clamp(Math.sin(rad) * 0.85, -0.22, 0.22);
  const absK = Math.abs(k);

  const cx = (width - 1) * 0.5;
  const cy = (height - 1) * 0.5;
  const invHalfH = 1.0 / Math.max(1, cy);
  const maxX = width - 1.0001;
  const maxY = height - 1.0001;

  for (let y = 0; y < height; y++) {
    const v = (y - cy) * invHalfH; // [-1, +1]
    // Inscribed horizontal projective scale: 0 < sx <= 1.0 for all v in [-1, +1]
    const sx = 1.0 - absK + k * v;
    // Foreshortening-compensated projective vertical coordinate
    const vs = clamp((v * (1.0 - 0.22 * absK)) / Math.max(0.5, 1.0 - 0.22 * k * v), -1.0, 1.0);
    const srcY = clamp(cy + vs * cy, 0, maxY);
    const y0 = Math.floor(srcY);
    const y1 = Math.min(height - 1, y0 + 1);
    const fy = srcY - y0;
    const wy0 = 1.0 - fy;
    const wy1 = fy;

    const row0 = y0 * width;
    const row1 = y1 * width;
    const dstRow = y * width;

    for (let x = 0; x < width; x++) {
      const srcX = clamp(cx + (x - cx) * sx, 0, maxX);
      const x0 = Math.floor(srcX);
      const x1 = Math.min(width - 1, x0 + 1);
      const fx = srcX - x0;
      const wx0 = 1.0 - fx;
      const wx1 = fx;

      const w00 = wx0 * wy0;
      const w10 = wx1 * wy0;
      const w01 = wx0 * wy1;
      const w11 = wx1 * wy1;

      const i00 = (row0 + x0) * 4;
      const i10 = (row0 + x1) * 4;
      const i01 = (row1 + x0) * 4;
      const i11 = (row1 + x1) * 4;
      const dstIdx = (dstRow + x) * 4;

      rgbaData[dstIdx] = Math.round(
        src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11
      );
      rgbaData[dstIdx + 1] = Math.round(
        src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11
      );
      rgbaData[dstIdx + 2] = Math.round(
        src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11
      );
      rgbaData[dstIdx + 3] = Math.round(
        src[i00 + 3] * w00 + src[i10 + 3] * w10 + src[i01 + 3] * w01 + src[i11 + 3] * w11
      );
    }
  }
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
 * Formats EXIF metadata into a single clean typographic line for studio/gallery borders.
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
 * Analyzes an RGBA image buffer to compute studio Auto-Correct & Auto White Balance parameters
 * surpassing Adobe Lightroom's Auto Tone & Auto WB:
 * - Percentile Zone-System black/white anchor points (0.5%, 5%, 15%, 50%, 85%, 95%, 99.5%)
 * - Exposure compensation (EV) targeting perceptual midtone balance with highlight headroom protection
 * - Adaptive shadow recovery (Zone II-III) and highlight knee roll-off (Zone VIII-IX)
 * - Hybrid Illuminant Estimation combining Achromatic-Locus surface weighting + Shades-of-Gray (Minkowski L4 norm)
 *   with Golden-Hour / Single-Hue Dominance damping so blue skies or warm sunsets aren't over-neutralized
 * - Selective Vibrance boost calculated from scene saturation distribution
 */
export function analyzeAutoCorrection(
  rgbaData: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  wbProfile: WbProfileMode = 'ambient'
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
      vibrance: 0,
      estimatedKelvin: 5500,
      wbProfile,
      ambientWarmthRetainedPercent: wbProfile === 'ambient' ? 35 : 0,
    };
  }

  const lumaHist = new Uint32Array(256);
  const stride = Math.max(1, Math.floor(totalPixels / 16384));
  let sampleCount = 0;

  // Hybrid White Balance accumulators:
  // 1) Achromatic-weighted midtone locus (higher weight for near-neutral surfaces like clouds, concrete, pavement)
  let achromWeightSum = 0;
  let achromR = 0;
  let achromG = 0;
  let achromB = 0;

  // 2) Shades-of-Gray Minkowski p=4 norm accumulators (robust illuminant estimator)
  let minkR4 = 0;
  let minkG4 = 0;
  let minkB4 = 0;
  let minkCount = 0;

  let satSum = 0;
  let satCount = 0;

  const accumulatePixel = (r: number, g: number, b: number) => {
    const y = clamp(Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b), 0, 255);
    lumaHist[y]++;
    sampleCount++;

    // Exclude deep sensor noise floor (y < 24) and specular highlight clipping (y > 235)
    if (y >= 24 && y <= 235) {
      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      const chroma = maxC - minC;
      const normSat = maxC > 0 ? chroma / maxC : 0;
      satSum += normSat;
      satCount++;

      // Achromatic surface weight: peaks on low-saturation neutral/near-neutral surfaces
      if (chroma < 110) {
        const wAchrom = Math.pow(1.0 - chroma / 115.0, 2) * (1.0 - Math.abs(y - 135) / 140.0);
        if (wAchrom > 0.05) {
          achromR += r * wAchrom;
          achromG += g * wAchrom;
          achromB += b * wAchrom;
          achromWeightSum += wAchrom;
        }
      }

      // Shades-of-Gray (Minkowski p=4) on non-oversaturated pixels
      if (normSat < 0.65) {
        const nr = r / 255;
        const ng = g / 255;
        const nb = b / 255;
        minkR4 += nr * nr * nr * nr;
        minkG4 += ng * ng * ng * ng;
        minkB4 += nb * nb * nb * nb;
        minkCount++;
      }
    }
  };

  for (let p = 0; p < totalPixels; p += stride) {
    const idx = p * 4;
    if (rgbaData[idx + 3] === 0) continue;
    accumulatePixel(rgbaData[idx], rgbaData[idx + 1], rgbaData[idx + 2]);
  }

  // Fallback pass if strided sampling hit only transparent pixels
  if (sampleCount === 0 && stride > 1) {
    for (let p = 0; p < totalPixels; p++) {
      if (p % stride === 0) continue;
      const idx = p * 4;
      if (rgbaData[idx + 3] === 0) continue;
      accumulatePixel(rgbaData[idx], rgbaData[idx + 1], rgbaData[idx + 2]);
    }
  }

  if (sampleCount === 0) {
    return {
      exposureEv: 0,
      contrast: 10,
      shadows: 0,
      highlights: 0,
      wbTempShift: 0,
      wbTintShift: 0,
      blackPoint: 0,
      whitePoint: 255,
      dynamicRangeStops: 8.0,
      vibrance: 8,
      estimatedKelvin: 5500,
      wbProfile,
      ambientWarmthRetainedPercent: wbProfile === 'ambient' ? 35 : 0,
    };
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

  // Perceptual Zone V midtone targeting with highlight headroom protection
  const normMedian = clamp((p50 - blackPoint) / span, 0.08, 0.92);
  let rawEv = Math.log2(0.48 / normMedian) * 0.46;
  if (rawEv > 0 && p85 > 208) {
    rawEv *= clamp((246 - p85) / 38, 0.15, 1.0);
  }
  const exposureEv = Number(clamp(rawEv, -0.85, 0.85).toFixed(2));

  const contrast =
    span < 215 ? clamp(Math.round((235 - span) * 0.24 + 8), 8, 32) : 10;

  const shadows = p15 < 60 ? clamp(Math.round((60 - p15) * 0.68), 0, 40) : 0;
  const highlights = p85 > 196 ? -clamp(Math.round((p85 - 196) * 0.68), 0, 40) : 0;

  // Blend Achromatic-Locus (72%) + Shades-of-Gray Minkowski L4 (28%) for illuminant estimation
  let wbTempShift = 0;
  let wbTintShift = 0;
  let estimatedKelvin = 5500;
  let ambientWarmthRetainedPercent = wbProfile === 'ambient' ? 35 : 0;

  if (achromWeightSum > 1.5 || minkCount >= 16) {
    let estR = 128;
    let estG = 128;
    let estB = 128;

    if (achromWeightSum > 1.5 && minkCount >= 16) {
      const ar = achromR / achromWeightSum;
      const ag = achromG / achromWeightSum;
      const ab = achromB / achromWeightSum;
      const mr = Math.pow(minkR4 / minkCount, 0.25) * 255;
      const mg = Math.pow(minkG4 / minkCount, 0.25) * 255;
      const mb = Math.pow(minkB4 / minkCount, 0.25) * 255;
      estR = ar * 0.72 + mr * 0.28;
      estG = ag * 0.72 + mg * 0.28;
      estB = ab * 0.72 + mb * 0.28;
    } else if (achromWeightSum > 1.5) {
      estR = achromR / achromWeightSum;
      estG = achromG / achromWeightSum;
      estB = achromB / achromWeightSum;
    } else {
      estR = Math.pow(minkR4 / minkCount, 0.25) * 255;
      estG = Math.pow(minkG4 / minkCount, 0.25) * 255;
      estB = Math.pow(minkB4 / minkCount, 0.25) * 255;
    }

    const avgGray = (estR + estG + estB) / 3;
    const rawTempShift = clamp(Math.round((estB - estR) * 0.38), -20, 20);
    const rawTintShift = clamp(Math.round((avgGray - estG) * 0.36), -15, 15);
    // Approximate scene CCT in Kelvin from R/B ratio
    estimatedKelvin = clamp(Math.round(5500 - (estR - estB) * 32), 2800, 9000);

    if (wbProfile === 'ambient') {
      if (rawTempShift < 0 || estimatedKelvin < 5000) {
        // Golden Hour / warm scene: retain 35% of original golden warmth instead of over-cooling
        wbTempShift = Math.round(rawTempShift * 0.65);
        wbTintShift = Math.round(rawTintShift * 0.75);
        ambientWarmthRetainedPercent = 35;
      } else if (rawTempShift > 0) {
        // Cool / blue hour scene: retain 20% of natural ambient mood
        wbTempShift = Math.round(rawTempShift * 0.8);
        wbTintShift = Math.round(rawTintShift * 0.85);
        ambientWarmthRetainedPercent = 20;
      } else {
        wbTempShift = rawTempShift;
        wbTintShift = rawTintShift;
        ambientWarmthRetainedPercent = 25;
      }
    } else {
      // Neutral Studio 100%: full achromatic neutralization
      wbTempShift = rawTempShift;
      wbTintShift = rawTintShift;
      ambientWarmthRetainedPercent = 0;
    }
  }

  const meanSat = satCount > 0 ? satSum / satCount : 0.25;
  const vibrance = clamp(Math.round((0.38 - meanSat) * 45), 0, 24);

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
    vibrance,
    estimatedKelvin,
    wbProfile,
    ambientWarmthRetainedPercent,
  };
}

/**
 * Applies studio Auto-Correct luminance-preserving filmic tone curve, shadow/highlight recovery,
 * micro-contrast S-curve, Ambient-Preserving Golden Hour split-tone WB neutralization, and skin-safe Vibrance in-place.
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
  const wbWeightLut = new Float32Array(256);

  const bp = analysis.blackPoint * 0.65;
  const wp = 255 - (255 - analysis.whitePoint) * 0.65;
  const range = Math.max(1, wp - bp);
  const gamma = Math.pow(2, -analysis.exposureEv * 0.56);
  const shadowFactor = (analysis.shadows / 100) * 0.28;
  const highlightFactor = (analysis.highlights / 100) * 0.26;
  const contrastFactor = (analysis.contrast / 100) * 0.52;
  const vibranceFactor = ((analysis.vibrance ?? 8) / 100) * 0.35 * strength;
  const isAmbientWb = (analysis.wbProfile ?? 'ambient') === 'ambient';

  const rShift = (analysis.wbTempShift * 1.25 - analysis.wbTintShift * 0.35) * strength;
  const gShift = analysis.wbTintShift * 0.85 * strength;
  const bShift = (-analysis.wbTempShift * 1.25 - analysis.wbTintShift * 0.35) * strength;

  for (let v = 0; v < 256; v++) {
    // 1. Percentile black/white point stretch
    let x = clamp((v - bp) / range, 0, 1);

    // 2. Exposure EV gamma
    x = Math.pow(x, gamma);

    // 3. Filmic Shadow Toe Lift & Highlight Shoulder Roll-Off
    const sLift = shadowFactor * (1 - x) * (1 - x) * Math.sqrt(x);
    const hComp = highlightFactor * x * x * (1 - x * 0.5);
    x = clamp(x + sLift + hComp, 0, 1);

    // 4. Smooth sigmoidal micro-contrast S-curve
    x = clamp(x - (contrastFactor * Math.sin(2 * Math.PI * x)) / (2 * Math.PI), 0, 1);

    toneLut[v] = v + (x * 255 - v) * strength;
    const normV = v / 255;
    const baseMw = 4 * normV * (1 - normV);
    midWeightLut[v] = baseMw;

    // Split-tone Golden Hour highlight protection: preserve natural warm sunlight glow in upper midtones/highlights
    const highlightProtection =
      isAmbientWb && analysis.wbTempShift < 0 && normV > 0.5
        ? 1.0 - 0.45 * clamp((normV - 0.5) / 0.5, 0, 1)
        : 1.0;
    wbWeightLut[v] = baseMw * highlightProtection;
  }

  const end = totalPixels * 4;
  for (let i = 0; i < end; i += 4) {
    // Preserve transparent pixels (e.g. uncropped rotation wedges or PNG cutouts)
    if (rgbaData[i + 3] === 0) continue;

    const r = rgbaData[i];
    const g = rgbaData[i + 1];
    const b = rgbaData[i + 2];

    const y = (54 * r + 183 * g + 19 * b) >> 8;
    const targetY = toneLut[y];
    const mw = midWeightLut[y];
    const wbw = wbWeightLut[y];

    // Apply split-tone white balance neutralization
    const rw = r + rShift * wbw;
    const gw = g + gShift * wbw;
    const bw = b + bShift * wbw;
    const yw = 0.2126 * rw + 0.7152 * gw + 0.0722 * bw;

    // Skin-tone & low-saturation aware Vibrance modulation
    const maxC = Math.max(rw, gw, bw);
    const minC = Math.min(rw, gw, bw);
    const normChroma = maxC > 1 ? (maxC - minC) / maxC : 0;
    // Protect warm skin-tone locus (R > G > B) from orange oversaturation
    const isSkinLocus = rw > gw && gw > bw && rw - bw > 18 ? 0.45 : 1.0;
    const vibBoost = 1.0 + vibranceFactor * (1.0 - normChroma) * isSkinLocus * mw;

    // Luminance-preserving tone mapping with bounded chroma scaling + vibrance
    const baseChromaScale = yw > 1 ? clamp(targetY / yw, 0.68, 1.24) : 1.0;
    const chromaScale = clamp(baseChromaScale * vibBoost, 0.65, 1.32);

    rgbaData[i] = clamp(Math.round(targetY + (rw - yw) * chromaScale), 0, 255);
    rgbaData[i + 1] = clamp(Math.round(targetY + (gw - yw) * chromaScale), 0, 255);
    rgbaData[i + 2] = clamp(Math.round(targetY + (bw - yw) * chromaScale), 0, 255);
  }
}




