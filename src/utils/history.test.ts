import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canRedo,
  canUndo,
  createHistory,
  pushHistory,
  redoHistory,
  undoHistory,
} from './history';

test('push, undo and redo walk the timeline in order', () => {
  let h = createHistory(0);
  h = pushHistory(h, 1, { now: 0 });
  h = pushHistory(h, 2, { now: 10_000 });
  assert.equal(h.present, 2);
  assert.equal(canUndo(h), true);
  assert.equal(canRedo(h), false);

  h = undoHistory(h);
  assert.equal(h.present, 1);
  h = undoHistory(h);
  assert.equal(h.present, 0);
  assert.equal(canUndo(h), false);

  h = redoHistory(h);
  assert.equal(h.present, 1);
  assert.equal(canRedo(h), true);
});

test('a new push after undo discards the redo branch', () => {
  let h = createHistory('a');
  h = pushHistory(h, 'b', { now: 0 });
  h = undoHistory(h);
  h = pushHistory(h, 'c', { now: 5_000 });
  assert.equal(h.present, 'c');
  assert.deepEqual(h.future, []);
  assert.deepEqual(h.past, ['a']);
});

test('same-key pushes inside the window coalesce into one undo step', () => {
  let h = createHistory(0);
  h = pushHistory(h, 1, { key: 'slider', now: 0 });
  h = pushHistory(h, 2, { key: 'slider', now: 100 });
  h = pushHistory(h, 3, { key: 'slider', now: 200 });
  assert.equal(h.present, 3);
  assert.deepEqual(h.past, [0]);

  h = undoHistory(h);
  assert.equal(h.present, 0);
});

test('different keys or an elapsed window start a new step', () => {
  let h = createHistory(0);
  h = pushHistory(h, 1, { key: 'a', now: 0 });
  h = pushHistory(h, 2, { key: 'b', now: 50 });
  h = pushHistory(h, 3, { key: 'b', now: 5_000 });
  assert.deepEqual(h.past, [0, 1, 2]);
});

test('undo breaks coalescing so the next edit is its own step', () => {
  let h = createHistory(0);
  h = pushHistory(h, 1, { key: 'k', now: 0 });
  h = pushHistory(h, 2, { key: 'k', now: 10 });
  h = undoHistory(h);
  h = pushHistory(h, 5, { key: 'k', now: 20 });
  assert.deepEqual(h.past, [0]);
  assert.equal(h.present, 5);
});

test('history is bounded by the limit and drops the oldest entries', () => {
  let h = createHistory(0);
  for (let i = 1; i <= 10; i++) {
    h = pushHistory(h, i, { now: i * 10_000, limit: 3 });
  }
  assert.deepEqual(h.past, [7, 8, 9]);
  assert.equal(h.present, 10);
});

test('pushing the identical reference is a no-op', () => {
  const value = { x: 1 };
  const h = createHistory(value);
  assert.equal(pushHistory(h, value), h);
  assert.equal(undoHistory(h), h);
  assert.equal(redoHistory(h), h);
});
