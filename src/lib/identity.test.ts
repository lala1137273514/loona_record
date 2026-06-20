import { describe, expect, test } from "vitest";
import { normalizeUsername, shouldCreateNewUid } from "./identity";

describe("normalizeUsername", () => {
  test("trims names and collapses internal whitespace", () => {
    expect(normalizeUsername("  Jason   Zhang  ")).toBe("Jason Zhang");
  });

  test("falls back to anonymous for blank names", () => {
    expect(normalizeUsername("   ")).toBe("anonymous");
  });
});

describe("shouldCreateNewUid", () => {
  test("requires a new uid only when current uid is missing", () => {
    expect(shouldCreateNewUid(null)).toBe(true);
    expect(shouldCreateNewUid("")).toBe(true);
    expect(shouldCreateNewUid("abc")).toBe(false);
  });
});
