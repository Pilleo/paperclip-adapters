import { describe, it, expect } from "vitest";
import { evaluateTaskStartApproval, PaperclipApprovalSummary } from "../src/core/approvals.js";
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
    dependencies: [],
    isOpenQuestions: false,
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
