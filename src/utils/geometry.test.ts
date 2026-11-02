import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeInscribedCrop,
  detectHorizonTiltFromGrayscale,
  computeFrameLayout,
  formatExifSummaryLine,
  computeSplitDividerX,
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

