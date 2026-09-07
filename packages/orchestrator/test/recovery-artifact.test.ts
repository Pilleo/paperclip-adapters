import { describe, expect, it } from "vitest";
import { classifyRecoveryArtifact, decideBlockedManagedWork, decideRecoveryArtifact } from "../src/core/recovery-artifact.js";
import type { ParsedIssueMetadata } from "../src/core/types.js";

const issue = (overrides: Partial<ParsedIssueMetadata> = {}): ParsedIssueMetadata => ({
  id: "artifact",
  title: "Review productivity for MAZ-909",
  status: "blocked",
  priority: "low",
  priorityRank: 1,
  dependencies: [],
  targetFiles: [],
  targetModules: [],
  targetSymbols: [],
  hasSideEffects: false,
  coreLock: false,
  needsKernel: false,
  exclusive: false,
  verifyCheap: [],
  isNonInterfering: true,
  openQuestions: false,
  orchestratorManaged: false,
  assigneeAgentId: "reviewer",
  rawIssue: { description: "Paperclip detected an unusual productivity/progression pattern." },
  ...overrides,
});

describe("Paperclip recovery artifact policy", () => {
  it("classifies productivity and silence diagnostics", () => {
    expect(classifyRecoveryArtifact(issue())).toBe("productivity");
    expect(classifyRecoveryArtifact(issue({ title: "Review silent active run for MAZ-909", rawIssue: { description: "critical output silence" } }))).toBe("silence");
    expect(classifyRecoveryArtifact(issue({ title: "real task", rawIssue: {} }))).toBeNull();
  });

  it("closes an artifact when its source is terminal", () => {
    expect(decideRecoveryArtifact(issue(), issue({ id: "source", title: "source", status: "done", rawIssue: {} }), true)).toEqual(expect.objectContaining({
      action: "close", status: "cancelled",
    }));
  });

  it("closes an artifact with an unavailable assignee instead of retrying it", () => {
    expect(decideRecoveryArtifact(issue(), null, false)).toEqual(expect.objectContaining({
      action: "close", status: "cancelled",
    }));
  });

  it("closes blocked diagnostics even when their source is still actionable", () => {
    expect(decideRecoveryArtifact(issue(), null, true)).toEqual({
      action: "close", status: "cancelled", reason: "productivity diagnostic is blocked and is not executable work",
    });
    expect(decideRecoveryArtifact(issue({ status: "todo" }), null, true)).toEqual({ action: "preserve" });
  });

  it("reclaims stale blocked Vibe work but preserves a Jules approval gate", () => {
    expect(decideBlockedManagedWork(issue({ title: "real Vibe task", rawIssue: {} }), "vibe", "idle")).toEqual({
      action: "reclaim", status: "todo", reason: "blocked Vibe work has no live execution or provider monitor",
    });
    expect(decideBlockedManagedWork(issue({ rawIssue: { description: "Jules awaits plan approval in Paperclip." } }), "jules", "idle")).toEqual({ action: "preserve" });
  });
});
