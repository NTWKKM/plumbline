import test from 'node:test';
import assert from 'node:assert/strict';
import { createLatestRunner, createMutex, runPool } from './pool';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('runPool keeps order and never exceeds the limit', async () => {
  let active = 0;
  let peak = 0;
  const results = await runPool([1, 2, 3, 4, 5], 2, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await tick();
    active--;
    return n * 10;
  });
  assert.deepEqual(results, [10, 20, 30, 40, 50]);
  assert.equal(peak, 2);
});

test('runPool stops starting work once aborted', async () => {
  const controller = new AbortController();
  const started: number[] = [];
  await assert.rejects(
    runPool(
      [1, 2, 3, 4],
      1,
      async (n) => {
        started.push(n);
        if (n === 2) controller.abort();
        await tick();
      },
      controller.signal
    ),
    { name: 'AbortError' }
  );
  assert.deepEqual(started, [1, 2]);
});

test('runPool stops scheduling after the first failure and lets active tasks settle', async () => {
  const started: number[] = [];
  const settled: number[] = [];
  await assert.rejects(
    runPool([1, 2, 3, 4, 5], 2, async (n) => {
      started.push(n);
      if (n === 1) throw new Error('first');
      await tick(10);
      settled.push(n);
    }),
    { message: 'first' }
  );
  assert.deepEqual(started, [1, 2]);
  assert.deepEqual(settled, [2]);
});

test('createMutex runs sections one at a time, even after a failure', async () => {
  const lock = createMutex();
  const order: string[] = [];
  const a = lock(async () => {
    order.push('a1');
    await tick();
    order.push('a2');
    throw new Error('boom');
  });
  const b = lock(async () => {
    order.push('b');
  });
  await assert.rejects(a);
  await b;
  assert.deepEqual(order, ['a1', 'a2', 'b']);
});

test('createLatestRunner skips intermediate requests', async () => {
  const seen: number[] = [];
  const run = createLatestRunner<number>(async (n) => {
    seen.push(n);
    await tick();
  });
  for (let i = 1; i <= 5; i++) run(i);
  await tick(30);
  assert.deepEqual(seen, [1, 5]);
});
