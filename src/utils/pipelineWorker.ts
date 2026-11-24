/**
 * Main-thread client for the pipeline worker. Buffers are transferred, not copied.
 * Where workers are unavailable the same operations run inline, so callers never branch.
 */
import {
  AnalyzeRequest,
  AnalyzeResult,
  ProcessRequest,
  runAnalyze,
  runProcess,
} from './pipelineOps';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

let worker: Worker | null | undefined;
let nextId = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL('../workers/pipeline.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
      const job = pending.get(e.data.id);
      if (!job) return;
      pending.delete(e.data.id);
      if (e.data.ok) job.resolve(e.data.result);
      else job.reject(new Error(e.data.error || 'Pipeline worker failed'));
    };
    worker.onerror = (e) => {
      // A worker that cannot load falls back to inline work for every later call
      e.preventDefault();
      for (const job of pending.values()) job.reject(new Error('Pipeline worker crashed'));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

function post<R>(req: AnalyzeRequest | ProcessRequest): Promise<R> {
  const w = getWorker();
  if (!w) {
    return Promise.resolve(
      (req.op === 'analyze' ? runAnalyze(req) : { rgba: runProcess(req) }) as R
    );
  }
  const id = nextId++;
  return new Promise<R>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    w.postMessage({ ...req, id }, [req.rgba.buffer]);
  });
}

export function analyzeInWorker(req: Omit<AnalyzeRequest, 'op' | 'id'>): Promise<AnalyzeResult> {
  return post<AnalyzeResult>({ ...req, op: 'analyze' });
}

export async function processInWorker(
  req: Omit<ProcessRequest, 'op' | 'id'>
): Promise<Uint8ClampedArray> {
  const { rgba } = await post<{ rgba: Uint8ClampedArray }>({ ...req, op: 'process' });
  return rgba;
}
