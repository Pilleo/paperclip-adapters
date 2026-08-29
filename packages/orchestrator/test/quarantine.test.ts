import { describe, it, expect } from "vitest";
import { evaluateTaskQuarantine } from "../src/core/quarantine.js";
import { ParsedIssueMetadata } from "../src/core/types.js";

describe("quarantine", () => {
  const dummyIssue: ParsedIssueMetadata = {
    id: "issue-1",
    title: "Test issue",
    status: "todo",
    priority: "high",
    priorityRank: 3,
    dependencies: [],
    targetFiles: ["file.kt"],
    targetModules: [":enforcer"],
    targetSymbols: [],
    hasSideEffects: false,
    isNonInterfering: false,
    rawIssue: {},
  };

  it("does not quarantine tasks below failure threshold", () => {
    const res = evaluateTaskQuarantine(dummyIssue, [{ status: "failed" }]);
    expect(res.shouldQuarantine).toBe(false);
    expect(res.maintainLocks).toBe(true);
  });

  it("quarantines tasks meeting failure threshold while preserving file locks", () => {
    const history = [
      { status: "failed" },
      { status: "error" },
      { status: "failed" },
    ];
    const res = evaluateTaskQuarantine(dummyIssue, history);
    expect(res.shouldQuarantine).toBe(true);
    expect(res.maintainLocks).toBe(true);
    expect(res.reason).toContain("Quarantined for operator triage");
  });
});
