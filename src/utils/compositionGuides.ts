/**
 * Composition guides drawn over the canvas: rule of thirds, phi grid, golden spiral,
 * golden triangles, 45° diagonals, dynamic symmetry and a fine leveling grid.
 * Every guide is built as polylines in normalized [0, 1] coordinates of its target rect,
 * so the canvas only scales points; angles (perpendiculars, 45°) are solved in pixel space first.
 */

export type GuideStyle = 'thirds' | 'phi' | 'spiral' | 'triangles' | 'diagonals' | 'dynamic' | 'level';

export interface GuideOption {
  value: GuideStyle;
  label: string;
  /** Distinct placements reachable with "rotate"; 1 means the guide is symmetric. */
  orientations: number;
}

export const GUIDE_OPTIONS: GuideOption[] = [
  { value: 'thirds', label: 'Rule of thirds', orientations: 1 },
  { value: 'phi', label: 'Phi grid', orientations: 1 },
  { value: 'spiral', label: 'Golden spiral', orientations: 4 },
  { value: 'triangles', label: 'Golden triangles', orientations: 2 },
  { value: 'diagonals', label: 'Diagonals 45°', orientations: 1 },
  { value: 'dynamic', label: 'Dynamic symmetry', orientations: 1 },
  { value: 'level', label: 'Leveling grid', orientations: 1 },
];

export const GUIDE_STYLES: GuideStyle[] = GUIDE_OPTIONS.map((o) => o.value);

export const PHI = (1 + Math.sqrt(5)) / 2;

export type GuidePoint = [number, number];

export interface GuidePath {
  points: GuidePoint[];
  /** Major paths carry the composition; minor ones are construction or reference lines. */
  emphasis: 'major' | 'minor';
}

export function isGuideStyle(v: unknown): v is GuideStyle {
  return typeof v === 'string' && (GUIDE_STYLES as string[]).includes(v);
}

export function guideOrientations(style: GuideStyle): number {
  return GUIDE_OPTIONS.find((o) => o.value === style)?.orientations ?? 1;
}

export function nextGuideStyle(style: GuideStyle): GuideStyle {
  const i = GUIDE_STYLES.indexOf(style);
  return GUIDE_STYLES[(i + 1) % GUIDE_STYLES.length];
}

const vLine = (x: number, emphasis: GuidePath['emphasis']): GuidePath => ({
  points: [
    [x, 0],
    [x, 1],
  ],
  emphasis,
});
const hLine = (y: number, emphasis: GuidePath['emphasis']): GuidePath => ({
  points: [
    [0, y],
    [1, y],
  ],
  emphasis,
});
const segment = (a: GuidePoint, b: GuidePoint, emphasis: GuidePath['emphasis']): GuidePath => ({
  points: [a, b],
  emphasis,
});

function gridAt(fractions: number[], emphasis: GuidePath['emphasis']): GuidePath[] {
  return fractions.flatMap((f) => [vLine(f, emphasis), hLine(f, emphasis)]);
}

/** Walks a ray from a corner of a W×H box until it leaves the box; returns the exit point. */
function clipRay(px: number, py: number, dx: number, dy: number, w: number, h: number): GuidePoint {
  const tx = dx > 0 ? (w - px) / dx : dx < 0 ? -px / dx : Infinity;
  const ty = dy > 0 ? (h - py) / dy : dy < 0 ? -py / dy : Infinity;
  const t = Math.min(tx, ty);
  return [px + dx * t, py + dy * t];
}

/**
 * Golden (Fibonacci) spiral in a landscape φ:1 rectangle, normalized to [0, 1].
 * Squares are cut left, top, right, bottom in turn; each square carries one quarter arc.
 */
function goldenSpiral(): GuidePath[] {
  const paths: GuidePath[] = [];
  const spiral: GuidePoint[] = [];
  let x = 0;
  let y = 0;
  let w = PHI;
  let h = 1;
  const ARC_STEPS = 24;
  const arc = (cx: number, cy: number, r: number, from: number, to: number) => {
    for (let i = spiral.length === 0 ? 0 : 1; i <= ARC_STEPS; i++) {
      const t = from + ((to - from) * i) / ARC_STEPS;
      spiral.push([(cx + r * Math.cos(t)) / PHI, cy + r * Math.sin(t)]);
    }
  };
  const cut = (a: GuidePoint, b: GuidePoint) =>
    paths.push(segment([a[0] / PHI, a[1]], [b[0] / PHI, b[1]], 'minor'));

  for (let step = 0; step < 12 && Math.min(w, h) > 1e-4; step++) {
    switch (step % 4) {
      case 0: {
        const s = h;
        arc(x + s, y + s, s, Math.PI, 1.5 * Math.PI);
        cut([x + s, y], [x + s, y + h]);
        x += s;
        w -= s;
        break;
      }
      case 1: {
        const s = w;
        arc(x, y + s, s, 1.5 * Math.PI, 2 * Math.PI);
        cut([x, y + s], [x + w, y + s]);
        y += s;
        h -= s;
        break;
      }
      case 2: {
        const s = h;
        arc(x + w - s, y, s, 0, 0.5 * Math.PI);
        cut([x + w - s, y], [x + w - s, y + h]);
        w -= s;
        break;
      }
      default: {
        const s = w;
        arc(x, y + h, s, 0, -0.5 * Math.PI);
        cut([x, y + h - s], [x + w, y + h - s]);
        h -= s;
        break;
      }
    }
  }
  paths.push({ points: spiral, emphasis: 'major' });
  return paths;
}

/** Main diagonal top-left → bottom-right with perpendiculars from the other two corners. */
function goldenTriangles(width: number, height: number): GuidePath[] {
  const d2 = width * width + height * height;
  // Feet of the perpendiculars, as a fraction t along the diagonal (normalized point is (t, t))
  const tFromTopRight = (width * width) / d2;
  const tFromBottomLeft = (height * height) / d2;
  return [
    segment([0, 0], [1, 1], 'major'),
    segment([1, 0], [tFromTopRight, tFromTopRight], 'major'),
    segment([0, 1], [tFromBottomLeft, tFromBottomLeft], 'major'),
  ];
}

/** 45° lines from every corner, as drawn in pixels, stopped at the frame edge. */
function diagonals45(width: number, height: number): GuidePath[] {
  const d = Math.min(width, height);
  const nx = d / width;
  const ny = d / height;
  return [
    segment([0, 0], [nx, ny], 'major'),
    segment([1, 0], [1 - nx, ny], 'major'),
    segment([0, 1], [nx, 1 - ny], 'major'),
    segment([1, 1], [1 - nx, 1 - ny], 'major'),
  ];
}

/** Both diagonals plus the four reciprocals: from each corner, perpendicular to the other diagonal. */
function dynamicSymmetry(width: number, height: number): GuidePath[] {
  const W = width;
  const H = height;
  const norm = ([px, py]: GuidePoint): GuidePoint => [px / W, py / H];
  const reciprocal = (px: number, py: number, dx: number, dy: number) =>
    segment(norm([px, py]), norm(clipRay(px, py, dx, dy, W, H)), 'minor');
  return [
    segment([0, 0], [1, 1], 'major'),
    segment([1, 0], [0, 1], 'major'),
    reciprocal(W, 0, -H, W),
    reciprocal(0, H, H, -W),
    reciprocal(0, 0, H, W),
    reciprocal(W, H, -H, -W),
  ];
}

/** Near-square cells, eight along the short side, with a stronger centre cross. */
function levelingGrid(width: number, height: number): GuidePath[] {
  const SHORT = 8;
  const cols = width >= height ? Math.max(1, Math.round((SHORT * width) / height)) : SHORT;
  const rows = width >= height ? SHORT : Math.max(1, Math.round((SHORT * height) / width));
  const paths: GuidePath[] = [];
  for (let i = 1; i < cols; i++) if (i * 2 !== cols) paths.push(vLine(i / cols, 'minor'));
  for (let j = 1; j < rows; j++) if (j * 2 !== rows) paths.push(hLine(j / rows, 'minor'));
  paths.push(vLine(0.5, 'major'), hLine(0.5, 'major'));
  return paths;
}

function transform(paths: GuidePath[], fn: (p: GuidePoint) => GuidePoint): GuidePath[] {
  return paths.map((p) => ({ ...p, points: p.points.map(fn) }));
}

/**
 * Builds the guide for a target rect of `width × height` pixels.
 * `orientation` picks one of the style's placements (wrapped, so any integer is safe).
 */
export function buildCompositionGuides(
  style: GuideStyle,
  orientation: number,
  width: number,
  height: number
): GuidePath[] {
  if (!(width > 0) || !(height > 0)) return [];
  const count = guideOrientations(style);
  const o = ((Math.trunc(orientation) % count) + count) % count;

  switch (style) {
    case 'thirds':
      return [...gridAt([0.5], 'minor'), ...gridAt([1 / 3, 2 / 3], 'major')];
    case 'phi': {
      const a = 1 / (1 + PHI); // ≈ 0.382: the phi grid splits each side 1 : 0.618 : 1
      return gridAt([a, 1 - a], 'major');
    }
    case 'spiral': {
      let paths = goldenSpiral();
      // A portrait frame gets the spiral laid along its long side
      if (height > width) paths = transform(paths, ([x, y]) => [y, x]);
      const flipX = o === 1 || o === 2;
      const flipY = o === 2 || o === 3;
      return transform(paths, ([x, y]) => [flipX ? 1 - x : x, flipY ? 1 - y : y]);
    }
    case 'triangles': {
      const paths = goldenTriangles(width, height);
      return o === 1 ? transform(paths, ([x, y]) => [1 - x, y]) : paths;
    }
    case 'diagonals':
      return diagonals45(width, height);
    case 'dynamic':
      return dynamicSymmetry(width, height);
    case 'level':
      return levelingGrid(width, height);
  }
}
