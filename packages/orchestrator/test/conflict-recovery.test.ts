import { describe, expect, it } from "vitest";
import { normalizeConflictRecoveryPolicy, selectConflictRecoveryAgent } from "../src/core/conflict-recovery.js";

describe("conflict recovery policy", () => {
  it("keeps agent selection inert until automatic repair is explicitly enabled", () => {
    expect(normalizeConflictRecoveryPolicy({ conflictRecoveryAgentId: "chosen" })).toEqual({ mode: "manual" });
    expect(normalizeConflictRecoveryPolicy({ conflictRecoveryMode: "git_only", conflictRecoveryAgentId: "chosen" }))
      .toEqual({ mode: "git_only" });
    expect(normalizeConflictRecoveryPolicy({ conflictRecoveryMode: "agent", conflictRecoveryAgentId: " chosen " }))
      .toEqual({ mode: "agent", agentId: "chosen" });
  });

  it.each(["codex_local", "antigravity", "jules", "process", "custom_adapter"])(
    "selects the exact independent %s agent without adapter filtering", (adapterType) => {
      const chosen = { id: "chosen", companyId: "company", adapterType, name: "Independent reviewer", role: "qa" };
      expect(selectConflictRecoveryAgent("company", "chosen", [
        { id: "other", companyId: "company", adapterType: "process" }, chosen,
      ])).toBe(chosen);
    },
  );

  it("fails instead of substituting another agent for an absent or foreign resolver", () => {
    const agents = [{ id: "other", companyId: "company", adapterType: "process" },
      { id: "chosen", companyId: "foreign", adapterType: "jules" }];
    expect(() => selectConflictRecoveryAgent("company", "missing", agents)).toThrow();
    expect(() => selectConflictRecoveryAgent("company", "chosen", agents)).toThrow();
  });
});
