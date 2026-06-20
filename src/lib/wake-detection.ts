export type WakeDetectionResult = {
  wake?: boolean;
  responded?: boolean;
  position?: string;
  duration_ms?: number;
  score?: number;
  verifier_score?: number | null;
  error?: string;
};

export function isWakeDetected(result: WakeDetectionResult) {
  return result.wake === true && result.responded !== false;
}

export function formatWakeDetectionStatus(result: WakeDetectionResult) {
  const parts = [
    result.position ? `位置:${result.position}` : null,
    Number.isFinite(result.duration_ms) ? `整段:${Math.round(result.duration_ms ?? 0)}ms` : null,
    Number.isFinite(result.score) ? `分数:${(result.score ?? 0).toFixed(2)}` : null,
    Number.isFinite(result.verifier_score ?? Number.NaN)
      ? `验证:${(result.verifier_score ?? 0).toFixed(2)}`
      : null,
  ].filter(Boolean);

  return parts.length > 0 ? `${parts.join("  ")}   (错了按Q)` : "识别到 Loona   (错了按Q)";
}

