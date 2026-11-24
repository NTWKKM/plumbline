/**
 * Main-thread client for the pipeline worker. Buffers are transferred to the worker; a copy
 * is kept until the job settles so a worker crash can finish the job inline.
 * Where workers are unavailable the same operations run inline, so callers never branch.
 */
import {
  AnalyzeRequest,
  AnalyzeResult,
  ProcessRequest,
  runAnalyze,
  runProcess,
} from './pipelineOps';

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  /** The request with its own pixels, untouched by the transfer, for the inline fallback. */
  fallback: AnalyzeRequest | ProcessRequest;
};

function runInline(req: AnalyzeRequest | ProcessRequest): unknown {
  return req.op === 'analyze' ? runAnalyze(req) : { rgba: runProcess(req) };
}

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
      // A worker that cannot load falls back to inline work for every later call,
      // and the jobs it held are finished inline from their kept copies
      e.preventDefault();
      const jobs = [...pending.values()];
      pending.clear();
      for (const job of jobs) {
        try {
          job.resolve(runInline(job.fallback));
        } catch (err) {
          job.reject(err instanceof Error ? err : new Error('Pipeline worker crashed'));
        }
      }
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
    return Promise.resolve(runInline(req) as R);
  }
  const id = nextId++;
  const fallback = { ...req, rgba: req.rgba.slice() } as AnalyzeRequest | ProcessRequest;
  return new Promise<R>((resolve, reject) => {
    // Removed from `pending` before settling, so a job settles exactly once
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, fallback });
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
