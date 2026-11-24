import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_OUTPUT,
  DEFAULT_PHOTO_EDIT,
  applyEditToPhotos,
  diffKeys,
  editFor,
  migrateLegacyConfig,
  sanitizeOutput,
  sanitizePhotoEdit,
  sanitizePresets,
  toPipelineConfig,
  transferable,
} from './edits';

test('editFor falls back to the default edit with the photo baseline tilt', () => {
  const session = { edits: {}, output: DEFAULT_OUTPUT };
  assert.deepEqual(editFor(session, 'a', 3.4), { ...DEFAULT_PHOTO_EDIT, tiltDeg: 3.4 });
});

test('applyEditToPhotos copies corrections but keeps each tilt and hand crop', () => {
  const crop = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };
  const session = {
    edits: {
      a: { ...DEFAULT_PHOTO_EDIT, tiltDeg: 2, manualAngleOffsetDeg: 1.5, wbProfile: 'neutral' as const },
      b: { ...DEFAULT_PHOTO_EDIT, tiltDeg: -1, cropOverride: crop },
    },
    output: DEFAULT_OUTPUT,
  };
  const next = applyEditToPhotos(session, transferable(session.edits.a), ['b', 'c'], { c: 5 });
  assert.equal(next.edits.b.manualAngleOffsetDeg, 1.5);
  assert.equal(next.edits.b.wbProfile, 'neutral');
  assert.equal(next.edits.b.tiltDeg, -1);
  assert.deepEqual(next.edits.b.cropOverride, crop);
  assert.equal(next.edits.c.tiltDeg, 5);
  assert.equal(next.edits.a, session.edits.a);
});

test('toPipelineConfig merges an edit with the shared output', () => {
  const config = toPipelineConfig(DEFAULT_PHOTO_EDIT, { ...DEFAULT_OUTPUT, aspectPreset: '4:5' });
  assert.equal(config.aspectPreset, '4:5');
  assert.equal(config.autoLevelEnabled, true);
  assert.equal(config.maxAutoAngleDeg, 15);
});

test('diffKeys names changed fields, including nested crops', () => {
  const a = { ...DEFAULT_PHOTO_EDIT };
  const b = { ...a, manualAngleOffsetDeg: 1, cropOverride: { x: 0, y: 0, width: 1, height: 1 } };
  assert.equal(diffKeys(a, b), 'cropOverride,manualAngleOffsetDeg');
  assert.equal(diffKeys(a, { ...a }), '');
});

test('sanitizers clamp ranges and reject bad values', () => {
  const edit = sanitizePhotoEdit({
    manualAngleOffsetDeg: 99,
    autoCorrectStrength: 42.6,
    wbProfile: 'sepia',
    cropOverride: { x: 0.8, y: 0, width: 0.5, height: 2 },
  });
  assert.equal(edit.manualAngleOffsetDeg, 15);
  assert.equal(edit.autoCorrectStrength, 43);
  assert.equal(edit.wbProfile, 'ambient');
  assert.ok(edit.cropOverride);
  assert.ok(Math.abs(edit.cropOverride.width - 0.2) < 1e-9);
  assert.equal(edit.cropOverride.height, 1);
  assert.equal(sanitizePhotoEdit({ cropOverride: { x: 'a' } }).cropOverride, null);

  const output = sanitizeOutput({ backgroundColor: 'red', jpegQuality: 10, aspectPreset: '5:7' });
  assert.equal(output.backgroundColor, DEFAULT_OUTPUT.backgroundColor);
  assert.equal(output.jpegQuality, 70);
  assert.equal(output.aspectPreset, DEFAULT_OUTPUT.aspectPreset);
});

test('sanitizePresets drops unnamed entries and strips per-photo fields', () => {
  const presets = sanitizePresets([
    { id: 'p1', name: 'Warm square', edit: { tiltDeg: 4, wbProfile: 'neutral' }, output: {} },
    { id: 'p2', name: '  ' },
    'junk',
  ]);
  assert.equal(presets.length, 1);
  assert.equal(presets[0].edit.wbProfile, 'neutral');
  assert.ok(!('tiltDeg' in presets[0].edit));
});

test('migrateLegacyConfig splits the old global config', () => {
  const { output, edit } = migrateLegacyConfig({ paddingPercent: 20, manualAngleOffsetDeg: -2 });
  assert.equal(output.paddingPercent, 20);
  assert.equal(edit.manualAngleOffsetDeg, -2);
});

test('parseStoredSession sanitises every field and tolerates junk', async () => {
  const { parseStoredSession } = await import('./persist');
  assert.equal(parseStoredSession(null), null);
  const s = parseStoredSession({
    edits: { a: { manualAngleOffsetDeg: 50 } },
    output: { paddingPercent: 12 },
    order: ['a', 3, 'b'],
    presets: 'nope',
  });
  assert.ok(s);
  assert.equal(s.edits.a.manualAngleOffsetDeg, 15);
  assert.equal(s.output.paddingPercent, 12);
  assert.deepEqual(s.order, ['a', 'b']);
  assert.equal(s.selectedId, 'a');
  assert.deepEqual(s.presets, []);
});
