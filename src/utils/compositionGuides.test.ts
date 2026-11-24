import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GUIDE_STYLES,
  PHI,
  buildCompositionGuides,
  guideOrientations,
  isGuideStyle,
  nextGuideStyle,
} from './compositionGuides';

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('every guide stays inside its frame for landscape, portrait and square', () => {
  for (const style of GUIDE_STYLES) {
    for (const [w, h] of [
      [3000, 2000],
      [2000, 3000],
      [1000, 1000],
    ]) {
      for (let o = 0; o < guideOrientations(style); o++) {
        const paths = buildCompositionGuides(style, o, w, h);
        assert.ok(paths.length > 0, `${style} drew nothing`);
        for (const p of paths) {
          for (const [x, y] of p.points) {
            assert.ok(x >= -1e-9 && x <= 1 + 1e-9 && y >= -1e-9 && y <= 1 + 1e-9, `${style} leaves the frame`);
          }
        }
      }
    }
  }
});

test('phi grid splits each side 1 : 0.618 : 1', () => {
  const xs = buildCompositionGuides('phi', 0, 1500, 1000)
    .filter((p) => p.points[0][0] === p.points[1][0])
    .map((p) => p.points[0][0])
    .sort();
  close(xs[0], 1 / (1 + PHI));
  close((xs[1] - xs[0]) / xs[0], 1 / PHI);
});

test('golden triangle perpendiculars meet the diagonal at a right angle in pixels', () => {
  const W = 3000;
  const H = 2000;
  const [diag, ...perps] = buildCompositionGuides('triangles', 0, W, H);
  const dx = (diag.points[1][0] - diag.points[0][0]) * W;
  const dy = (diag.points[1][1] - diag.points[0][1]) * H;
  for (const p of perps) {
    const px = (p.points[1][0] - p.points[0][0]) * W;
    const py = (p.points[1][1] - p.points[0][1]) * H;
    close(dx * px + dy * py, 0, 1e-3);
  }
});

test('45° diagonals are 45° in pixels, not in normalized space', () => {
  const W = 3000;
  const H = 2000;
  for (const p of buildCompositionGuides('diagonals', 0, W, H)) {
    const px = Math.abs(p.points[1][0] - p.points[0][0]) * W;
    const py = Math.abs(p.points[1][1] - p.points[0][1]) * H;
    close(px, py, 1e-6);
  }
});

test('golden spiral is one continuous curve whose eye sits at the golden point', () => {
  const paths = buildCompositionGuides('spiral', 0, 1618, 1000);
  const spiral = paths.find((p) => p.emphasis === 'major')!;
  for (let i = 1; i < spiral.points.length; i++) {
    const [ax, ay] = spiral.points[i - 1];
    const [bx, by] = spiral.points[i];
    assert.ok(Math.hypot(bx - ax, by - ay) < 0.1, 'spiral has a gap');
  }
  // The eye converges on the main diagonal at φ²/(φ²+1) ≈ 0.724 of each side; flips mirror it
  const [ex, ey] = spiral.points[spiral.points.length - 1];
  close(ex, (PHI * PHI) / (PHI * PHI + 1), 0.01);
  close(ey, (PHI * PHI) / (PHI * PHI + 1), 0.01);
  const [fx, fy] = buildCompositionGuides('spiral', 2, 1618, 1000).find((p) => p.emphasis === 'major')!.points.at(-1)!;
  close(fx, 1 - ex);
  close(fy, 1 - ey);
});

test('orientation wraps and style cycling visits every style', () => {
  assert.deepEqual(buildCompositionGuides('spiral', 5, 300, 200), buildCompositionGuides('spiral', 1, 300, 200));
  assert.deepEqual(buildCompositionGuides('spiral', -1, 300, 200), buildCompositionGuides('spiral', 3, 300, 200));
  const seen = new Set<string>();
  let s = GUIDE_STYLES[0];
  for (let i = 0; i < GUIDE_STYLES.length; i++) {
    seen.add(s);
    s = nextGuideStyle(s);
  }
  assert.equal(seen.size, GUIDE_STYLES.length);
  assert.equal(isGuideStyle('phi'), true);
  assert.equal(isGuideStyle('nope'), false);
});
