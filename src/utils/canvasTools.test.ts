import test from 'node:test';
import assert from 'node:assert/strict';
import { adjustCrop, hitCropHandle, normalizeCrop, rotationToStraighten } from './canvasTools';
import { applyHorizontalKeystoneWarpToRgba } from './geometry';

test('rotationToStraighten levels a sloped horizon either way it is drawn', () => {
  // 5° clockwise slope (y grows to the right) needs a -5° turn
  const dy = Math.tan((5 * Math.PI) / 180) * 100;
  assert.equal(rotationToStraighten(0, 0, 100, dy), -5);
  assert.equal(rotationToStraighten(100, dy, 0, 0), -5);
});

test('rotationToStraighten plumbs a near-vertical line', () => {
  const dx = Math.tan((3 * Math.PI) / 180) * 100;
  // A vertical that leans 3° off plumb needs a 3° turn back
  const r = rotationToStraighten(0, 100, dx, 0);
  assert.ok(r !== null && Math.abs(Math.abs(r) - 3) < 0.01);
});

test('rotationToStraighten ignores a tap', () => {
  assert.equal(rotationToStraighten(10, 10, 12, 11), null);
});

test('adjustCrop moves inside bounds and resizes with a minimum size', () => {
  const crop = { x: 0.2, y: 0.2, width: 0.5, height: 0.5 };
  assert.deepEqual(adjustCrop(crop, 'move', 0.9, -0.9), { x: 0.5, y: 0, width: 0.5, height: 0.5 });
  const shrunk = adjustCrop(crop, 'se', -0.9, -0.9);
  assert.ok(Math.abs(shrunk.width - 0.05) < 1e-9);
  assert.ok(Math.abs(shrunk.height - 0.05) < 1e-9);
  const grown = adjustCrop(crop, 'nw', -1, -1);
  assert.deepEqual(grown, { x: 0, y: 0, width: 0.7, height: 0.7 });
});

test('hitCropHandle finds corners, edges, and the inside', () => {
  const crop = { x: 0.2, y: 0.2, width: 0.6, height: 0.6 };
  assert.equal(hitCropHandle(crop, 0.2, 0.2, 0.02, 0.02), 'nw');
  assert.equal(hitCropHandle(crop, 0.8, 0.5, 0.02, 0.02), 'e');
  assert.equal(hitCropHandle(crop, 0.5, 0.5, 0.02, 0.02), 'move');
  assert.equal(hitCropHandle(crop, 0.05, 0.05, 0.02, 0.02), null);
});

test('hitCropHandle picks the nearer edge when hit zones overlap', () => {
  const thin = { x: 0.5, y: 0.2, width: 0.03, height: 0.6 };
  assert.equal(hitCropHandle(thin, 0.505, 0.5, 0.02, 0.02), 'w');
  assert.equal(hitCropHandle(thin, 0.525, 0.5, 0.02, 0.02), 'e');
  const flat = { x: 0.2, y: 0.5, width: 0.6, height: 0.03 };
  assert.equal(hitCropHandle(flat, 0.5, 0.526, 0.02, 0.02), 's');
});

test('normalizeCrop divides by the source size', () => {
  assert.deepEqual(normalizeCrop({ x: 50, y: 25, width: 100, height: 50 }, 200, 100), {
    x: 0.25,
    y: 0.25,
    width: 0.5,
    height: 0.5,
  });
});

test('horizontal keystone leaves the centre column and keeps the buffer size', () => {
  const w = 8;
  const h = 6;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = (i % w) * 30;
    data[i * 4 + 3] = 255;
  }
  const before = data.slice();
  applyHorizontalKeystoneWarpToRgba(data, w, h, 8);
  assert.equal(data.length, before.length);
  assert.notDeepEqual(data, before);
  applyHorizontalKeystoneWarpToRgba(before, w, h, 0);
  assert.equal(before[0], 0);
});
