/**
 * The pixel operations the worker runs, kept free of DOM types so the same code
 * runs in the worker, on the main thread as a fallback, and in node tests.
 */
import {
  AutoCorrectAnalysis,
  LevelingAnalysis,
  WbProfileMode,
  analyzeAutoCorrection,
  applyAutoCorrectionToRgba,
  applyHorizontalKeystoneWarpToRgba,
  applyProjectiveKeystoneWarpToRgba,
  detectHorizonTiltFromGrayscale,
} from './geometry';

export interface AnalyzeRequest {
  id?: number;
  op: 'analyze';
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  maxAutoAngleDeg: number;
  wbProfile: WbProfileMode;
  /** Skip horizon detection when only the white-balance profile changed. */
  toneOnly?: boolean;
}

export interface AnalyzeResult {
  analysis: LevelingAnalysis | null;
  autoCorrect: AutoCorrectAnalysis;
  gray: Uint8Array;
}

export interface ProcessRequest {
  id?: number;
  op: 'process';
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  keystoneDeg: number;
  keystoneHDeg: number;
  autoCorrect: AutoCorrectAnalysis | null;
  strength: number;
}

export type PipelineRequest = AnalyzeRequest | ProcessRequest;

export function toGrayscale(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    gray[i] = Math.round(0.299 * rgba[idx] + 0.587 * rgba[idx + 1] + 0.114 * rgba[idx + 2]);
  }
  return gray;
}

export function runAnalyze(req: AnalyzeRequest): AnalyzeResult {
  const gray = toGrayscale(req.rgba, req.width, req.height);
  const analysis = req.toneOnly
    ? null
    : detectHorizonTiltFromGrayscale(gray, req.width, req.height, req.maxAutoAngleDeg);
  const autoCorrect = analyzeAutoCorrection(req.rgba, req.width, req.height, req.wbProfile);
  return { analysis, autoCorrect, gray };
}

export function runProcess(req: ProcessRequest): Uint8ClampedArray {
  const { rgba, width, height } = req;
  if (Math.abs(req.keystoneDeg) >= 0.02) {
    applyProjectiveKeystoneWarpToRgba(rgba, width, height, req.keystoneDeg);
  }
  if (Math.abs(req.keystoneHDeg) >= 0.02) {
    applyHorizontalKeystoneWarpToRgba(rgba, width, height, req.keystoneHDeg);
  }
  if (req.autoCorrect && req.strength > 0) {
    applyAutoCorrectionToRgba(rgba, width, height, req.autoCorrect, req.strength);
  }
  return rgba;
}
