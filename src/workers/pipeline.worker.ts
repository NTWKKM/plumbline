/// <reference lib="webworker" />
/**
 * Pixel work that would otherwise block the main thread: horizon and tone analysis
 * on the 640px detect buffer, and keystone + tone correction on the full-resolution crop.
 */
import { runAnalyze, runProcess, type PipelineRequest } from '../utils/pipelineOps';

self.onmessage = (e: MessageEvent<PipelineRequest>) => {
  const req = e.data;
  try {
    if (req.op === 'analyze') {
      const result = runAnalyze(req);
      self.postMessage({ id: req.id, ok: true, result });
    } else {
      const rgba = runProcess(req);
      self.postMessage({ id: req.id, ok: true, result: { rgba } }, [rgba.buffer]);
    }
  } catch (err) {
    self.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
