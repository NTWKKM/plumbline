/**
 * Pure maths for the canvas tools: the straighten line and the hand crop.
 * Coordinates are in source pixels unless a name says normalized.
 */
import { clamp } from './geometry';
import { MIN_CROP_FRACTION, NormalizedCrop } from './edits';

export { MIN_CROP_FRACTION };

/**
 * The rotation (degrees, canvas convention: positive is clockwise) that makes a drawn line
 * level, or plumb when it was drawn closer to vertical. Returns null for a line too short to trust.
 */
export function rotationToStraighten(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  minLength = 12
): number | null {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (Math.hypot(dx, dy) < minLength) return null;
  let deg = (Math.atan2(dy, dx) * 180) / Math.PI; // (-180, 180]
  // Fold into (-90, 90]: a line drawn right-to-left means the same as left-to-right
  if (deg > 90) deg -= 180;
  if (deg <= -90) deg += 180;
  // Closer to vertical: measure against plumb instead of level
  if (deg > 45) deg -= 90;
  else if (deg < -45) deg += 90;
  return Number((-deg).toFixed(2));
}

export type CropHandle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** Moves or resizes a normalized crop by a normalized delta, kept inside the unit square. */
export function adjustCrop(
  crop: NormalizedCrop,
  handle: CropHandle,
  dx: number,
  dy: number
): NormalizedCrop {
  if (handle === 'move') {
    return {
      ...crop,
      x: clamp(crop.x + dx, 0, 1 - crop.width),
      y: clamp(crop.y + dy, 0, 1 - crop.height),
    };
  }
  let left = crop.x;
  let top = crop.y;
  let right = crop.x + crop.width;
  let bottom = crop.y + crop.height;
  if (handle.includes('w')) left = clamp(left + dx, 0, right - MIN_CROP_FRACTION);
  if (handle.includes('e')) right = clamp(right + dx, left + MIN_CROP_FRACTION, 1);
  if (handle.includes('n')) top = clamp(top + dy, 0, bottom - MIN_CROP_FRACTION);
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + MIN_CROP_FRACTION, 1);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Which handle (if any) a normalized point grabs; `tolerance` is in normalized units. */
export function hitCropHandle(
  crop: NormalizedCrop,
  px: number,
  py: number,
  toleranceX: number,
  toleranceY: number
): CropHandle | null {
  const left = crop.x;
  const right = crop.x + crop.width;
  const top = crop.y;
  const bottom = crop.y + crop.height;
  const dL = Math.abs(px - left);
  const dR = Math.abs(px - right);
  const dT = Math.abs(py - top);
  const dB = Math.abs(py - bottom);
  const insideX = px >= left - toleranceX && px <= right + toleranceX;
  const insideY = py >= top - toleranceY && py <= bottom + toleranceY;
  if (!insideX || !insideY) return null;
  // On a crop narrower than two hit zones both edges qualify: take the one nearer the pointer
  const v = dT <= toleranceY && (dB > toleranceY || dT <= dB) ? 'n' : dB <= toleranceY ? 's' : '';
  const h = dL <= toleranceX && (dR > toleranceX || dL <= dR) ? 'w' : dR <= toleranceX ? 'e' : '';
  if (v || h) return (v + h) as CropHandle;
  return px > left && px < right && py > top && py < bottom ? 'move' : null;
}

/** Converts a pixel crop to a normalized one against a source of the given size. */
export function normalizeCrop(
  crop: { x: number; y: number; width: number; height: number },
  srcW: number,
  srcH: number
): NormalizedCrop {
  return {
    x: crop.x / srcW,
    y: crop.y / srcH,
    width: crop.width / srcW,
    height: crop.height / srcH,
  };
}
