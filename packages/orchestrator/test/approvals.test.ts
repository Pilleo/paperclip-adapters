import { describe, it, expect } from "vitest";
import {
  evaluateTaskStartApproval,
  evaluatePrMergeApproval,
  shouldReclaimUnapprovedStart,
  PaperclipApprovalSummary,
} from "../src/core/approvals.js";
import { ParsedIssueMetadata } from "../src/core/types.js";

function createMockIssue(overrides: Partial<ParsedIssueMetadata> = {}): ParsedIssueMetadata {
  return {
    id: "issue-1",
    identifier: "MAZ-100",
    title: "Implement feature X",
    status: "todo",
    priority: "high",
    priorityRank: 3,
    component: "enforcer",
    targetFiles: ["enforcer/src/Main.kt"],
    targetSymbols: [],
    targetModules: [],
    dependencies: [],
    hasSideEffects: true,
    coreLock: false,
    needsKernel: false,
    exclusive: false,
    verifyCheap: [],
    openQuestions: false,
    isNonInterfering: false,
    rawIssue: {},
    ...overrides,
  };
}

describe("evaluateTaskStartApproval", () => {
  it("dispatches immediately if requireApproval is false", () => {
    const issue = createMockIssue();
    const decision = evaluateTaskStartApproval(issue, "agent-1", [], false);
    expect(decision.action).toBe("DISPATCH");
  });

  it("requests approval if no existing approval exists", () => {
    const issue = createMockIssue();
    const decision = evaluateTaskStartApproval(issue, "agent-jules", []);
    expect(decision.action).toBe("CREATE_APPROVAL_REQUEST");
    if (decision.action === "CREATE_APPROVAL_REQUEST") {
      expect(decision.title).toContain("MAZ-100");
      expect(decision.description).toContain("enforcer");
      expect(decision.targetAgentId).toBe("agent-jules");
    }
  });

  it("awaits approval if existing approval is pending", () => {
    const issue = createMockIssue();
    const existing: PaperclipApprovalSummary[] = [
      {
        id: "app-123",
        type: "task_start_approval",
        status: "pending",
        issueIds: ["issue-1"],
      },
    ];
    const decision = evaluateTaskStartApproval(issue, "agent-jules", existing);
    expect(decision.action).toBe("AWAIT_APPROVAL");
    if (decision.action === "AWAIT_APPROVAL") {
      expect(decision.approvalId).toBe("app-123");
    }
  });

  it("dispatches if existing approval is approved", () => {
    const issue = createMockIssue();
    const existing: PaperclipApprovalSummary[] = [
      {
        id: "app-123",
        type: "task_start_approval",
        status: "approved",
        issueIds: ["issue-1"],
      },
    ];
    const decision = evaluateTaskStartApproval(issue, "agent-jules", existing);
    expect(decision.action).toBe("DISPATCH");
    if (decision.action === "DISPATCH") {
      expect(decision.reason).toContain("app-123");
    }
  });

  it.each([
    {
      desc: "assigned todo with pending start is reclaimed",
      issue: { id: "issue-1", status: "todo", assigneeAgentId: "jules-1" },
      status: "pending" as const,
      reclaim: true,
    },
    {
      desc: "in_progress with pending start is reclaimed",
      issue: { id: "issue-1", status: "in_progress", assigneeAgentId: "jules-1" },
      status: "pending" as const,
      reclaim: true,
    },
    {
      desc: "approved start is not reclaimed",
      issue: { id: "issue-1", status: "in_progress", assigneeAgentId: "jules-1" },
      status: "approved" as const,
      reclaim: false,
    },
    {
      desc: "unassigned backlog with pending start stays put",
      issue: { id: "issue-1", status: "backlog", assigneeAgentId: null },
      status: "pending" as const,
      reclaim: false,
    },
  ])("reclaim table: $desc", ({ issue, status, reclaim }) => {
    const existing: PaperclipApprovalSummary[] = [
      { id: "app-123", type: "task_start_approval", status, issueIds: ["issue-1"] },
    ];
    expect(shouldReclaimUnapprovedStart(issue, existing)).toBe(reclaim);
  });

  it("skips dispatch if existing approval is rejected", () => {
    const issue = createMockIssue();
    const existing: PaperclipApprovalSummary[] = [
      {
        id: "app-123",
        type: "task_start_approval",
        status: "rejected",
        issueIds: ["issue-1"],
      },
    ];
    const decision = evaluateTaskStartApproval(issue, "agent-jules", existing);
    expect(decision.action).toBe("SKIP_REJECTED");
  });
});

describe("evaluatePrMergeApproval", () => {
  it("creates merge approval request if no matching approval exists", () => {
    const issue = createMockIssue();
    const decision = evaluatePrMergeApproval(issue, 526, [], {
      prUrl: "https://github.com/Pilleo/mazewall/pull/526",
      vibeSummary: "Clean AST diff.",
      strongSummary: "Zero invariant violations.",
    });

    expect(decision.action).toBe("CREATE_MERGE_APPROVAL_REQUEST");
    if (decision.action === "CREATE_MERGE_APPROVAL_REQUEST") {
      expect(decision.title).toContain("PR #526");
      expect(decision.description).toContain("Stage 2 (Vibe Fast Review)");
      expect(decision.description).toContain("Stage 3 (Strong Model Review)");
    }
  });

  it("executes merge if matching merge approval is approved", () => {
    const issue = createMockIssue();
    const existing: PaperclipApprovalSummary[] = [
      {
        id: "merge-app-1",
        type: "task_merge_approval",
        status: "approved",
        issueIds: [issue.id],
      },
    ];

    const decision = evaluatePrMergeApproval(issue, 526, existing);
    expect(decision.action).toBe("EXECUTE_MERGE");
  });

  it("awaits approval if matching merge approval is pending", () => {
    const issue = createMockIssue();
    const existing: PaperclipApprovalSummary[] = [
      {
        id: "merge-app-1",
        type: "task_merge_approval",
        status: "pending",
        issueIds: [issue.id],
      },
    ];

    const decision = evaluatePrMergeApproval(issue, 526, existing);
    expect(decision.action).toBe("AWAIT_MERGE_APPROVAL");
  });
});
