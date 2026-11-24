/**
 * Edit model: per-photo corrections plus one shared output setting for the whole queue.
 *
 * A series of framed photos should share its frame (aspect, border, colour, export settings),
 * while straightening, crop and tone belong to each photo. Splitting the old single
 * PipelineConfig this way is what makes per-photo editing possible.
 */
import {
  AspectRatioPreset,
  MAX_AUTO_ANGLE_LIMIT_DEG,
  PipelineConfig,
  WbProfileMode,
  clamp,
} from './geometry';

/** A crop chosen by hand, as fractions (0..1) of the rotated source. */
export interface NormalizedCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PhotoEdit {
  /** Simulated sensor tilt; only sample photos expose it (a demo of the leveller). */
  tiltDeg: number;
  autoLevelEnabled: boolean;
  manualAngleOffsetDeg: number;
  keystoneWarpEnabled: boolean;
  manualKeystoneDeg: number;
  manualKeystoneHDeg: number;
  autoCropEnabled: boolean;
  preserveAspectRatioInCrop: boolean;
  cropOverride: NormalizedCrop | null;
  autoCorrectEnabled: boolean;
  autoCorrectStrength: number;
  wbProfile: WbProfileMode;
}

export interface OutputSettings {
  aspectPreset: AspectRatioPreset;
  paddingPercent: number;
  backgroundColor: string;
  preserveExifMetadata: boolean;
  renderExifCaption: boolean;
  jpegQuality: number;
}

/** The part of an edit that can be copied between photos (tilt and a hand crop stay put). */
export type TransferableEdit = Omit<PhotoEdit, 'tiltDeg' | 'cropOverride'>;

export interface Preset {
  id: string;
  name: string;
  edit: TransferableEdit;
  output: OutputSettings;
}

export interface EditSession {
  edits: Record<string, PhotoEdit>;
  output: OutputSettings;
}

export const DEFAULT_PHOTO_EDIT: PhotoEdit = {
  tiltDeg: 0,
  autoLevelEnabled: true,
  manualAngleOffsetDeg: 0,
  keystoneWarpEnabled: true,
  manualKeystoneDeg: 0,
  manualKeystoneHDeg: 0,
  autoCropEnabled: true,
  preserveAspectRatioInCrop: true,
  cropOverride: null,
  autoCorrectEnabled: true,
  autoCorrectStrength: 75,
  wbProfile: 'ambient',
};

export const DEFAULT_OUTPUT: OutputSettings = {
  aspectPreset: '1:1',
  paddingPercent: 10,
  backgroundColor: '#FFFFFF',
  preserveExifMetadata: true,
  renderExifCaption: true,
  jpegQuality: 95,
};

const ASPECT_PRESETS: AspectRatioPreset[] = ['1:1', '4:5', '16:9', '3:2', 'original'];

export function toPipelineConfig(edit: PhotoEdit, output: OutputSettings): PipelineConfig {
  return {
    autoLevelEnabled: edit.autoLevelEnabled,
    maxAutoAngleDeg: MAX_AUTO_ANGLE_LIMIT_DEG,
    manualAngleOffsetDeg: edit.manualAngleOffsetDeg,
    keystoneWarpEnabled: edit.keystoneWarpEnabled,
    manualKeystoneDeg: edit.manualKeystoneDeg,
    manualKeystoneHDeg: edit.manualKeystoneHDeg,
    autoCropEnabled: edit.autoCropEnabled,
    preserveAspectRatioInCrop: edit.preserveAspectRatioInCrop,
    cropOverride: edit.cropOverride,
    autoCorrectEnabled: edit.autoCorrectEnabled,
    autoCorrectStrength: edit.autoCorrectStrength,
    wbProfile: edit.wbProfile,
    ...output,
  };
}

export function editFor(session: EditSession, id: string, baselineTiltDeg = 0): PhotoEdit {
  return session.edits[id] ?? { ...DEFAULT_PHOTO_EDIT, tiltDeg: baselineTiltDeg };
}

export function transferable(edit: PhotoEdit): TransferableEdit {
  const { tiltDeg: _tilt, cropOverride: _crop, ...rest } = edit;
  return rest;
}

/** Apply copied settings to the given photos, keeping each photo's own tilt and hand crop. */
export function applyEditToPhotos(
  session: EditSession,
  source: TransferableEdit,
  ids: string[],
  baselineTilts: Record<string, number> = {}
): EditSession {
  const edits = { ...session.edits };
  for (const id of ids) {
    const current = editFor(session, id, baselineTilts[id] ?? 0);
    edits[id] = { ...current, ...source };
  }
  return { ...session, edits };
}

/** Names the fields that differ, so history can merge repeated edits of one field. */
export function diffKeys<T extends object>(a: T, b: T): string {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof T)[]);
  return [...keys]
    .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    .sort()
    .join(',');
}

// ---------- Sanitising persisted data ----------

type Loose = Record<string, unknown>;

const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
const num = (v: unknown, fallback: number, min: number, max: number, round = false) =>
  typeof v === 'number' && Number.isFinite(v) ? clamp(round ? Math.round(v) : v, min, max) : fallback;

function sanitizeCrop(v: unknown): NormalizedCrop | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Loose;
  const x = num(o.x, NaN, 0, 1);
  const y = num(o.y, NaN, 0, 1);
  const width = num(o.width, NaN, 0.02, 1);
  const height = num(o.height, NaN, 0.02, 1);
  if ([x, y, width, height].some(Number.isNaN)) return null;
  return { x, y, width: Math.min(width, 1 - x), height: Math.min(height, 1 - y) };
}

export function sanitizePhotoEdit(v: unknown, fallback: PhotoEdit = DEFAULT_PHOTO_EDIT): PhotoEdit {
  const o = (v && typeof v === 'object' ? v : {}) as Loose;
  const d = fallback;
  return {
    tiltDeg: num(o.tiltDeg, d.tiltDeg, -12, 12),
    autoLevelEnabled: bool(o.autoLevelEnabled, d.autoLevelEnabled),
    manualAngleOffsetDeg: num(o.manualAngleOffsetDeg, d.manualAngleOffsetDeg, -15, 15),
    keystoneWarpEnabled: bool(o.keystoneWarpEnabled, d.keystoneWarpEnabled),
    manualKeystoneDeg: num(o.manualKeystoneDeg, d.manualKeystoneDeg, -12, 12),
    manualKeystoneHDeg: num(o.manualKeystoneHDeg, d.manualKeystoneHDeg, -12, 12),
    autoCropEnabled: bool(o.autoCropEnabled, d.autoCropEnabled),
    preserveAspectRatioInCrop: bool(o.preserveAspectRatioInCrop, d.preserveAspectRatioInCrop),
    cropOverride: 'cropOverride' in o ? sanitizeCrop(o.cropOverride) : d.cropOverride,
    autoCorrectEnabled: bool(o.autoCorrectEnabled, d.autoCorrectEnabled),
    autoCorrectStrength: num(o.autoCorrectStrength, d.autoCorrectStrength, 0, 100, true),
    wbProfile: o.wbProfile === 'ambient' || o.wbProfile === 'neutral' ? o.wbProfile : d.wbProfile,
  };
}

export function sanitizeOutput(v: unknown): OutputSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Loose;
  const d = DEFAULT_OUTPUT;
  return {
    aspectPreset: ASPECT_PRESETS.includes(o.aspectPreset as AspectRatioPreset)
      ? (o.aspectPreset as AspectRatioPreset)
      : d.aspectPreset,
    paddingPercent: num(o.paddingPercent, d.paddingPercent, 0, 30, true),
    backgroundColor:
      typeof o.backgroundColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(o.backgroundColor)
        ? o.backgroundColor
        : d.backgroundColor,
    preserveExifMetadata: bool(o.preserveExifMetadata, d.preserveExifMetadata),
    renderExifCaption: bool(o.renderExifCaption, d.renderExifCaption),
    jpegQuality: num(o.jpegQuality, d.jpegQuality, 70, 100, true),
  };
}

export function sanitizePresets(v: unknown): Preset[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((p): p is Loose => !!p && typeof p === 'object')
    .filter((p) => typeof p.id === 'string' && typeof p.name === 'string' && p.name.trim() !== '')
    .map((p) => ({
      id: p.id as string,
      name: (p.name as string).slice(0, 60),
      edit: transferable(sanitizePhotoEdit(p.edit)),
      output: sanitizeOutput(p.output),
    }));
}

/**
 * Migrates the single global config that older builds kept in localStorage:
 * its output fields become the shared output, its correction fields the default edit.
 */
export function migrateLegacyConfig(v: unknown): { output: OutputSettings; edit: PhotoEdit } {
  return { output: sanitizeOutput(v), edit: sanitizePhotoEdit(v) };
}
