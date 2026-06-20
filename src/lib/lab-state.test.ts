import { describe, expect, test } from "vitest";
import { getLabDisplayState } from "./lab-state";

describe("getLabDisplayState", () => {
  test("keeps upload success separate from wake detection", () => {
    expect(getLabDisplayState("sample_saved")).toEqual({
      appClassName: "lab-app",
      headline: "🔴 待命",
    });
  });

  test("turns green only for real wake detection", () => {
    expect(getLabDisplayState("wake_detected")).toEqual({
      appClassName: "lab-app green",
      headline: "🟢 识别到 Loona",
    });
  });
});
