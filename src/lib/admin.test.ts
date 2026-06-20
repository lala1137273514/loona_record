import { describe, expect, test } from "vitest";
import { isValidAdminToken } from "./admin";

describe("isValidAdminToken", () => {
  test("accepts exact configured token", () => {
    expect(isValidAdminToken("secret", "secret")).toBe(true);
  });

  test("rejects missing or mismatched tokens", () => {
    expect(isValidAdminToken(null, "secret")).toBe(false);
    expect(isValidAdminToken("secret", undefined)).toBe(false);
    expect(isValidAdminToken("wrong", "secret")).toBe(false);
    expect(isValidAdminToken(" secret ", "secret")).toBe(false);
  });
});
