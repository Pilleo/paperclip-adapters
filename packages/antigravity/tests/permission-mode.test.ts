import { describe, expect, it } from "vitest";
import { normalizeAntigravityPermissionMode } from "../src/server/config.js";

describe("provider permission policy", () => {
  it("keeps the published restrictive aliases read-only in headless ACP execution", () => {
    expect(normalizeAntigravityPermissionMode("read-only")).toBe("approve-reads");
    expect(normalizeAntigravityPermissionMode("prompt-on-write")).toBe("approve-reads");
  });

  it("preserves explicit canonical policies and the documented unconfigured default", () => {
    expect(normalizeAntigravityPermissionMode(undefined)).toBe("approve-all");
    for (const mode of ["approve-all", "approve-reads", "deny-all"] as const) {
      expect(normalizeAntigravityPermissionMode(mode)).toBe(mode);
    }
  });

  it("rejects ambiguous or misspelled policies before the engine can widen them", () => {
    for (const mode of ["default", "read_only", "", false, null]) {
      expect(() => normalizeAntigravityPermissionMode(mode)).toThrow("Invalid Antigravity ACP permission mode");
    }
  });
});
