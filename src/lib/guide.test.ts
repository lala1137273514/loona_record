import { describe, expect, test } from "vitest";
import { FINISH_STEPS, ORIGINAL_TEST_TASKS } from "./guide";

describe("original Loona lab guide", () => {
  test("keeps the original ten-step checklist wording", () => {
    expect(ORIGINAL_TEST_TASKS).toHaveLength(10);
    expect(ORIGINAL_TEST_TASKS[0]).toMatchObject({
      text: "单独说「Loona」",
      note: "×3 次",
    });
    expect(ORIGINAL_TEST_TASKS[9].text).toContain("正常打字");
    expect(ORIGINAL_TEST_TASKS[9].note).toContain("Ctrl+Q");
  });

  test("keeps the original finish handoff flow", () => {
    expect(FINISH_STEPS).toEqual([
      "关掉页面，终端里按 Ctrl+C 停止",
      "右键包里的 collected 文件夹 → 压缩",
      "把 collected.zip 发回给我",
    ]);
  });
});
