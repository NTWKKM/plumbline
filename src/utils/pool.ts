/** Runs `task` over `items` with at most `limit` in flight; stops starting new ones once aborted. */
export async function runPool<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      if (signal?.aborted) return;
      const index = next++;
      results[index] = await task(items[index], index);
    }
  };
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane);
  await Promise.all(lanes);
  if (signal?.aborted) {
    throw new DOMException('Export cancelled', 'AbortError');
  }
  return results;
}

/** Serialises async sections (for example, reserving a file name then writing it). */
export function createMutex() {
  let tail: Promise<unknown> = Promise.resolve();
  return <R>(fn: () => Promise<R>): Promise<R> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

/**
 * Keeps only the latest request while one is running: a slider drag that fires 30 updates
 * renders the first and the last, never the 28 in between.
 */
export function createLatestRunner<A>(run: (args: A) => Promise<void>) {
  let running = false;
  let pending: { args: A } | null = null;
  const pump = async (args: A): Promise<void> => {
    running = true;
    try {
      await run(args);
    } finally {
      running = false;
      if (pending) {
        const nextArgs = pending.args;
        pending = null;
        void pump(nextArgs);
      }
    }
  };
  return (args: A) => {
    if (running) {
      pending = { args };
      return;
    }
    void pump(args);
  };
}
