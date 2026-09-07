import { describe, expect, it } from "vitest";
import { extractIssueMetadata } from "../src/core/parser.js";
import {
  decideIssueLifecycleReconciliation,
  diagnosticStableKey,
  type LifecycleReconciliationDecision,
} from "../src/core/issue-lifecycle-reconciliation.js";

function issue(overrides: Record<string, unknown> = {}) {
  return extractIssueMetadata({
    id: "issue-1",
    identifier: "MAZ-1",
    title: "Implementation task",
    description: "---\norchestrator_managed: true\n---",
    status: "todo",
    priority: "medium",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  });
}

const now = () => Date.parse("2026-09-02T00:00:00.000Z");

describe("issue lifecycle reconciliation", () => {
  it("closes stale Paperclip silence diagnostics instead of treating them as active work", () => {
    const diagnostic = issue({
      id: "diag-1",
      identifier: "MAZ-903",
      title: "Review silent active run for [Orchestrated] Vibe Fast Reviewer",
      status: "in_progress",
      assigneeAgentId: "orchestrator",
      description: [
        "Paperclip detected critical output silence on an active heartbeat run.",
        "- Run: run-1",
        "- Source issue: [MAZ-891](/MAZ/issues/MAZ-891)",
        "- Generated at: 2026-08-31T23:01:35.000Z",
      ].join("\n"),
      updatedAt: "2026-08-31T23:01:35.000Z",
    });

    expect(decideIssueLifecycleReconciliation(diagnostic, [diagnostic], { now })).toEqual({
      action: "close_diagnostic",
      status: "done",
      reason: "stale Paperclip diagnostic has no active execution",
    });
  });

  it("preserves a fresh diagnostic while its observation window is still active", () => {
    const diagnostic = issue({
      title: "Review productivity for MAZ-908",
      status: "in_progress",
      assigneeAgentId: "orchestrator",
      description: "Paperclip detected an unusual productivity/progression pattern.\nGenerated at: 2026-09-01T23:00:00.000Z",
      updatedAt: "2026-09-01T23:00:00.000Z",
    });

    expect(decideIssueLifecycleReconciliation(diagnostic, [diagnostic], { now })).toEqual({ action: "preserve" });
  });

  it("repairs persisted in_progress records that have neither owner nor execution", () => {
    const orphan = issue({ status: "in_progress", assigneeAgentId: null, executionRunId: null });
    expect(decideIssueLifecycleReconciliation(orphan, [orphan], { now })).toEqual({
      action: "reclaim_orphan_in_progress",
      status: "todo",
      reason: "in_progress issue has no assignee or active execution",
    });
  });

  it("closes delegated review children after their parent becomes terminal", () => {
    const parent = issue({ id: "parent", identifier: "MAZ-834", status: "done" });
    const child = issue({
      id: "child",
      identifier: "MAZ-877",
      parentId: "parent",
      status: "blocked",
      title: "Review Jules plan (vibe)",
      description: "<!-- jules-plan-review: MAZ-834 -->",
    });

    expect(decideIssueLifecycleReconciliation(child, [parent, child], { now })).toEqual({
      action: "close_obsolete_review_child",
      status: "cancelled",
      reason: "parent is terminal",
    });
  });

  it("preserves delegated review children while their parent is still active", () => {
    const parent = issue({ id: "parent", identifier: "MAZ-836", status: "blocked" });
    const child = issue({
      id: "child",
      parentId: "parent",
      status: "blocked",
      title: "Review Jules plan (vibe)",
      description: "<!-- jules-plan-review: MAZ-836 -->",
    });

    expect(decideIssueLifecycleReconciliation(child, [parent, child], { now })).toEqual({ action: "preserve" });
  });

  it("deduplicates diagnostics by source run and kind", () => {
    const first = issue({
      id: "diag-1",
      title: "Review silent active run for [Orchestrated] Vibe Fast Reviewer",
      description: "Paperclip detected critical output silence.\n- Run: run-1\n- Source issue: [MAZ-1]",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    const duplicate = issue({
      id: "diag-2",
      title: "Review silent active run for [Orchestrated] Vibe Fast Reviewer",
      description: "Paperclip detected critical output silence.\n- Run: run-1\n- Source issue: [MAZ-1]",
      createdAt: "2026-09-01T01:00:00.000Z",
    });

    expect(diagnosticStableKey(first)).toBe(diagnosticStableKey(duplicate));
    const decision = decideIssueLifecycleReconciliation(duplicate, [first, duplicate], { now });
    expect(decision).toEqual({
      action: "close_duplicate_diagnostic",
      status: "cancelled",
      reason: "duplicate diagnostic for the same source run",
    } satisfies LifecycleReconciliationDecision);
  });
});
