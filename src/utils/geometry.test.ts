import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeInscribedCrop,
  detectHorizonTiltFromGrayscale,
  computeFrameLayout,
  formatExifSummaryLine,
  computeSplitDividerX,
  computePixelAreaScale,
  getScaledDimensionsWithinBudget,
  analyzeAutoCorrection,
  applyAutoCorrectionToRgba,
} from './geometry';

test('computeInscribedCrop returns full image dimensions when rotation angle is 0', () => {
  const res = computeInscribedCrop(4000, 3000, 0, true);
  assert.equal(res.width, 4000);
  assert.equal(res.height, 3000);
  assert.equal(res.x, 0);
  assert.equal(res.y, 0);
  assert.equal(res.scaleFactor, 1);
  assert.equal(res.areaRetainedPercent, 100);
});

test('computeInscribedCrop shrinks bounds symmetrically and preserves aspect ratio when rotated', () => {
  const res = computeInscribedCrop(2000, 1000, 5.0, true);
  assert.ok(res.width < 2000 && res.width > 1600);
  assert.ok(res.height < 1000 && res.height > 800);
  // Aspect ratio 2:1 preserved
  assert.ok(Math.abs(res.width / res.height - 2.0) < 0.01);
  // Symmetric for +5 deg and -5 deg
  const negRes = computeInscribedCrop(2000, 1000, -5.0, true);
  assert.equal(res.width, negRes.width);
  assert.equal(res.height, negRes.height);
});

test('detectHorizonTiltFromGrayscale accurately recovers a synthetic tilted horizon line', () => {
  const w = 180;
  const h = 120;
  const gray = new Uint8Array(w * h);
  const trueTiltDeg = 3.5;
  const slope = Math.tan((trueTiltDeg * Math.PI) / 180);

  // Render a sharp sky-to-sea horizon with a 3.5° tilt across the center
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const horizonY = h / 2 + (x - w / 2) * slope;
      gray[y * w + x] = y < horizonY ? 225 : 40;
    }
  }

  const analysis = detectHorizonTiltFromGrayscale(gray, w, h, 15.0);
  // Detected tilt should be within 0.4 degrees of +3.5°, and correction rotation ~ -3.5°
  assert.ok(
    Math.abs(analysis.detectedTiltDeg - trueTiltDeg) <= 0.4,
    `Expected ~${trueTiltDeg}°, got ${analysis.detectedTiltDeg}°`
  );
  assert.equal(analysis.appliedRotationDeg, Number((-analysis.detectedTiltDeg).toFixed(2)));
  assert.ok(analysis.strongEdgeCount > 100);
  assert.ok(analysis.confidence > 0.35);
});

test('detectHorizonTiltFromGrayscale sets appliedRotationDeg to 0 when confidence is below minimum threshold on random noise', () => {
  const w = 180;
  const h = 120;
  const gray = new Uint8Array(w * h);
  // Fill with deterministic pseudo-random noise without any dominant linear edge
  let s = 12345;
  for (let i = 0; i < gray.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    gray[i] = s % 256;
  }

  const analysis = detectHorizonTiltFromGrayscale(gray, w, h, 15.0);
  assert.equal(analysis.appliedRotationDeg, 0);
  assert.ok(analysis.confidence < 0.35);
});

test('computeFrameLayout creates 1:1 square frame with symmetric white borders', () => {
  const layout = computeFrameLayout(1600, 1200, '1:1', 10, false);
  assert.equal(layout.canvasWidth, layout.canvasHeight);
  assert.ok(layout.borderLeft >= Math.floor(layout.canvasWidth * 0.1));
  assert.equal(layout.borderLeft + layout.imageWidth + layout.borderRight, layout.canvasWidth);
  assert.equal(layout.borderTop + layout.imageHeight + layout.borderBottom, layout.canvasHeight);
});

test('computeFrameLayout retains full source width for 4000x3000 landscape in 4:5 preset at 10% padding', () => {
  const layout = computeFrameLayout(4000, 3000, '4:5', 10, false);
  assert.equal(layout.imageWidth, 4000);
  assert.equal(layout.imageHeight, 3000);
});

test('computeFrameLayout caps dimensions at MAX_CANVAS_DIMENSION and MAX_CANVAS_AREA', () => {
  const layout = computeFrameLayout(20000, 15000, '1:1', 10, false);
  assert.ok(layout.canvasWidth <= 16384);
  assert.ok(layout.canvasHeight <= 16384);
  assert.ok(layout.canvasWidth * layout.canvasHeight <= 67108864);
  assert.equal(layout.canvasWidth, 8192);
  assert.equal(layout.canvasHeight, 8192);

  const layout169 = computeFrameLayout(20000, 11250, '16:9', 10, false);
  assert.ok(layout169.canvasWidth <= 16384);
  assert.ok(layout169.canvasHeight <= 16384);
  assert.ok(layout169.canvasWidth * layout169.canvasHeight <= 67108864);
  assert.ok(Math.abs(layout169.canvasWidth / layout169.canvasHeight - 16 / 9) < 0.01);
});

test('computeFrameLayout does not downscale source for odd dimensions with padding', () => {
  const layout = computeFrameLayout(1337, 889, '3:2', 12, true);
  assert.equal(layout.imageWidth, 1337);
  assert.equal(layout.imageHeight, 889);
});

test('formatExifSummaryLine joins non-empty EXIF fields cleanly', () => {
  const line = formatExifSummaryLine({
    cameraModel: 'Leica M11',
    lensModel: 'Summilux-M 35mm f/1.4 ASPH',
    focalLength: '35mm',
    aperture: 'f/2.8',
    shutterSpeed: '1/1000s',
    iso: '64',
    dateTimeOriginal: '2026:10:14 17:42:10',
    colorSpace: 'sRGB',
  });
  assert.equal(line, 'Leica M11  ·  Summilux-M 35mm f/1.4 ASPH  ·  35mm  ·  f/2.8  ·  1/1000s  ·  ISO 64');
});

test('computeSplitDividerX clamps split percentage to [5, 95] and computes exact pixel X', () => {
  const mid = computeSplitDividerX(1200, 50);
  assert.equal(mid.clampedPercent, 50);
  assert.equal(mid.splitX, 600);

  const low = computeSplitDividerX(1000, 0);
  assert.equal(low.clampedPercent, 5);
  assert.equal(low.splitX, 50);

  const high = computeSplitDividerX(1000, 99);
  assert.equal(high.clampedPercent, 95);
  assert.equal(high.splitX, 950);
});

test('computePixelAreaScale validates positive finite budget and returns full scale for valid budgets', () => {
  // Invalid budgets return 1.0
  assert.equal(computePixelAreaScale(4000, 3000, undefined), 1.0);
  assert.equal(computePixelAreaScale(4000, 3000, -100), 1.0);
  assert.equal(computePixelAreaScale(4000, 3000, 0), 1.0);
  assert.equal(computePixelAreaScale(4000, 3000, NaN), 1.0);
  assert.equal(computePixelAreaScale(4000, 3000, Infinity), 1.0);

  // When area <= budget, return 1.0
  assert.equal(computePixelAreaScale(1000, 1000, 2000000), 1.0);

  // When area > budget, return Math.sqrt(budget / area)
  const scale = computePixelAreaScale(2000, 2000, 1000000);
  assert.ok(Math.abs(scale - 0.5) < 1e-6);
});

test('getScaledDimensionsWithinBudget uniformly scales and bounds dimensions within budget', () => {
  const unscaled = getScaledDimensionsWithinBudget(4000, 3000);
  assert.equal(unscaled.width, 4000);
  assert.equal(unscaled.height, 3000);
  assert.equal(unscaled.scale, 1.0);

  // Scaling 4000x3000 (12M px) down to 3M px budget
  const scaled = getScaledDimensionsWithinBudget(4000, 3000, 3000000);
  assert.ok(scaled.width * scaled.height <= 3000000);
  assert.ok(Math.abs(scaled.width / scaled.height - 4000 / 3000) < 0.01);
  assert.ok(scaled.scale <= 0.501);

  // Scaling with odd dimensions and tight budget guarantees resulting area <= budget
  const tight = getScaledDimensionsWithinBudget(1920, 1080, 500000);
  assert.ok(tight.width * tight.height <= 500000);

  // Sub-pixel budgets produce a 1x1 result using the effective 1-pixel minimum
  const subPixel = getScaledDimensionsWithinBudget(4000, 3000, 0.5);
  assert.equal(subPixel.width, 1);
  assert.equal(subPixel.height, 1);
  assert.equal(subPixel.width * subPixel.height, 1);
});

test('computeFrameLayout respects opt-in pixelAreaBudget while preserving MAX_CANVAS_AREA by default', () => {
  // Budget smaller than MAX_CANVAS_AREA caps canvas size within budget
  const budgeted = computeFrameLayout(4000, 3000, '1:1', 10, false, 1000000);
  assert.ok(budgeted.canvasWidth * budgeted.canvasHeight <= 1000000);

  // Sub-pixel budgets (< 1 pixel) follow fallback behavior and preserve MAX_CANVAS_AREA
  const subPixelLayout = computeFrameLayout(20000, 15000, '1:1', 10, false, 0.5);
  assert.equal(subPixelLayout.canvasWidth, 8192);
  assert.equal(subPixelLayout.canvasHeight, 8192);

  // Tight budget shrinks width even when height reaches 1 px
  const tightWide = computeFrameLayout(1000, 100, 'original', 0, false, 5);
  assert.ok(tightWide.canvasWidth * tightWide.canvasHeight <= 5);
  assert.equal(tightWide.canvasHeight, 1);
  assert.equal(tightWide.canvasWidth, 5);

  // When budget is omitted or invalid, MAX_CANVAS_AREA is preserved
  const defaultLayout = computeFrameLayout(20000, 15000, '1:1', 10, false, undefined);
  assert.equal(defaultLayout.canvasWidth, 8192);
  assert.equal(defaultLayout.canvasHeight, 8192);
});

test('detectHorizonTiltFromGrayscale recovers sub-degree vertical architectural tilt and subtle negative horizon tilt', () => {
  const w = 240;
  const h = 180;
  const gray = new Float32Array(w * h);
  const trueTiltDeg = -2.35;
  const slope = Math.tan((trueTiltDeg * Math.PI) / 180);

  // Smooth anti-aliased horizon at -2.35°
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const horizonY = h * 0.45 + (x - w * 0.5) * slope;
      const dist = y - horizonY;
      const blend = Math.max(0, Math.min(1, 0.5 + dist * 0.8));
      gray[y * w + x] = 230 * (1 - blend) + 35 * blend;
    }
  }

  const analysis = detectHorizonTiltFromGrayscale(gray, w, h, 15.0);
  assert.ok(
    Math.abs(analysis.detectedTiltDeg - trueTiltDeg) <= 0.08,
    `Expected ${trueTiltDeg}°, got ${analysis.detectedTiltDeg}°`
  );
  assert.equal(analysis.appliedRotationDeg, Number((-analysis.detectedTiltDeg).toFixed(2)));
  assert.ok(analysis.confidence >= 0.75);

  // Off-center vertical architectural facade edge tilted at +1.85°
  const vertGray = new Float32Array(w * h);
  const trueVertTiltDeg = 1.85;
  const vertSlope = Math.tan((trueVertTiltDeg * Math.PI) / 180);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Off-center vertical line at x ≈ 0.30 * w where dx = x0 - (y - cy) * tan(theta)
      const wallX = w * 0.30 - (y - h * 0.5) * vertSlope;
      const dist = x - wallX;
      const blend = Math.max(0, Math.min(1, 0.5 + dist * 0.8));
      vertGray[y * w + x] = 220 * (1 - blend) + 40 * blend;
    }
  }

  const vertAnalysis = detectHorizonTiltFromGrayscale(vertGray, w, h, 15.0);
  assert.ok(
    Math.abs(vertAnalysis.detectedTiltDeg - trueVertTiltDeg) <= 0.08,
    `Expected vertical tilt ${trueVertTiltDeg}°, got ${vertAnalysis.detectedTiltDeg}°`
  );
  assert.ok(vertAnalysis.confidence >= 0.7);
});

test('computeInscribedCrop enforces symmetric center parity and supports targetAspectRatio override', () => {
  const res = computeInscribedCrop(2000, 1400, 3.2, true);
  // Left margin must equal right margin exactly (zero 0.5px drift)
  assert.equal(res.x, 2000 - (res.x + res.width));
  assert.equal(res.y, 1400 - (res.y + res.height));

  // Target 1:1 square inscribed crop inside rotated 2000x1400
  const sq = computeInscribedCrop(2000, 1400, 4.0, true, 1.0);
  assert.equal(sq.width, sq.height);
  assert.ok(sq.width > 1100 && sq.width < 1400);
});

test('analyzeAutoCorrection and applyAutoCorrectionToRgba optimize underexposed low-contrast image with color cast', () => {
  const w = 64;
  const h = 64;
  const rgba = new Uint8ClampedArray(w * h * 4);

  // Create a dim, low-contrast image with a cool blue cast (R < G < B)
  for (let i = 0; i < w * h; i++) {
    const t = (i % w) / (w - 1);
    const base = Math.round(35 + t * 90); // Luma range ~[35, 125] (underexposed & compressed)
    rgba[i * 4] = Math.max(0, base - 12);     // R (cool deficit)
    rgba[i * 4 + 1] = base;                   // G
    rgba[i * 4 + 2] = Math.min(255, base + 14); // B (blue cast)
    rgba[i * 4 + 3] = 255;
  }

  const corr = analyzeAutoCorrection(rgba, w, h);
  assert.ok(corr.exposureEv > 0.1, `Expected positive EV boost, got ${corr.exposureEv}`);
  assert.ok(corr.contrast >= 12, `Expected contrast boost >= 12, got ${corr.contrast}`);
  assert.ok(corr.wbTempShift > 0, `Expected warm WB shift to neutralize blue cast, got ${corr.wbTempShift}`);

  const beforeMidR = rgba[(32 * w + 32) * 4];
  const beforeMidB = rgba[(32 * w + 32) * 4 + 2];

  applyAutoCorrectionToRgba(rgba, w, h, corr, 100);

  const afterMidR = rgba[(32 * w + 32) * 4];
  const afterMidB = rgba[(32 * w + 32) * 4 + 2];

  // Midtones should be brightened and the R-to-B cast gap reduced
  assert.ok(afterMidR > beforeMidR);
  assert.ok(Math.abs(afterMidB - afterMidR) < Math.abs(beforeMidB - beforeMidR));
});


