import { describe, expect, it } from "vitest";
import { formatWakeDetectionStatus, isWakeDetected } from "./wake-detection";

describe("isWakeDetected", () => {
  it("treats wake true as a detector hit", () => {
    expect(isWakeDetected({ wake: true })).toBe(true);
  });

  it("does not treat rejected detector results as hits", () => {
    expect(isWakeDetected({ wake: true, responded: false })).toBe(false);
    expect(isWakeDetected({ wake: false })).toBe(false);
  });
});

describe("formatWakeDetectionStatus", () => {
  it("formats original lab wake metadata", () => {
    expect(formatWakeDetectionStatus({
      position: "head",
      duration_ms: 1234,
      score: 0.734,
      verifier_score: 0.812,
    })).toBe("位置:head  整段:1234ms  分数:0.73  验证:0.81   (错了按Q)");
  });

  it("keeps a useful fallback when metadata is absent", () => {
    expect(formatWakeDetectionStatus({ wake: true })).toBe("识别到 Loona   (错了按Q)");
  });
});

