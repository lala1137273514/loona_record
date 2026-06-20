import { describe, expect, test } from "vitest";
import {
  DEFAULT_PROMPTS,
  buildManifestCsv,
  createStoragePath,
  exportFilenameForCase,
  sanitizeNamePart,
  type RecordingCase,
} from "./cases";

describe("DEFAULT_PROMPTS", () => {
  test("contains Loona prompt coverage and a negative prompt", () => {
    expect(DEFAULT_PROMPTS.length).toBeGreaterThanOrEqual(6);
    expect(DEFAULT_PROMPTS.some((prompt) => prompt.text.includes("Loona"))).toBe(true);
    expect(DEFAULT_PROMPTS.some((prompt) => prompt.recommendedLabel === "real_neg")).toBe(true);
  });
});

describe("sanitizeNamePart", () => {
  test("keeps names filesystem safe and compact", () => {
    expect(sanitizeNamePart("Jason Zhang")).toBe("Jason-Zhang");
    expect(sanitizeNamePart("  中文 / test!!  ")).toBe("test");
    expect(sanitizeNamePart("")).toBe("unknown");
  });
});

describe("createStoragePath", () => {
  test("builds unique paths under label and uid folders", () => {
    const path = createStoragePath({
      label: "real_pos",
      uid: "user-123",
      caseId: "case-456",
      date: new Date("2026-06-20T08:30:12Z"),
    });

    expect(path).toBe("real_pos/user-123/20260620T083012Z-case-456.wav");
  });
});

describe("exportFilenameForCase", () => {
  test("matches collected folder training naming", () => {
    const filename = exportFilenameForCase({
      id: "6c15e2aa-1111-2222-3333-444444444444",
      uid: "6c7b2abb-aaaa-bbbb-cccc-dddddddddddd",
      username: "Jason Zhang",
      label: "real_neg",
      created_at: "2026-06-20T08:30:12.000Z",
    });

    expect(filename).toBe(
      "collected/real_neg/realneg_Jason-Zhang_6c7b2abb_20260620-083012_6c15e2aa.wav",
    );
  });
});

describe("buildManifestCsv", () => {
  test("escapes commas, quotes, and newlines", () => {
    const rows: RecordingCase[] = [
      {
        id: "case-1",
        uid: "uid-1",
        username: "A, \"B\"",
        label: "real_pos",
        prompt_key: "free",
        prompt_text: "Say\nLoona",
        storage_bucket: "loona-recordings",
        storage_path: "real_pos/uid-1/file.wav",
        duration_ms: 1200,
        sample_rate: 16000,
        channels: 1,
        mime_type: "audio/wav",
        client_created_at: null,
        created_at: "2026-06-20T08:30:12.000Z",
      },
    ];

    const csv = buildManifestCsv(rows);

    expect(csv.split("\n")[0]).toBe(
      "id,uid,username,label,prompt_key,prompt_text,storage_path,duration_ms,sample_rate,channels,created_at,export_path",
    );
    expect(csv).toContain('"A, ""B"""');
    expect(csv).toContain('"Say\nLoona"');
    expect(csv).toContain("collected/real_pos/realpos_A-B_uid-1_20260620-083012_case-1.wav");
  });
});
