import { describe, it, expect } from "vitest";
import {
  formatApprovalCard,
  formatClarificationQuestionCard,
  formatFleetStatusCard,
  formatTaskQueueCard,
  compactDescription,
} from "../src/formatters.js";

describe("Telegram Message Formatters", () => {
  it("formats compact description as Telegram blockquote", () => {
    const raw = "The task is prioritized and ready for dispatch.\n\nComponent: core\nPriority: high\nPlanned Agent: 8ec6f7dd";
    const formatted = compactDescription(raw);
    expect(formatted).toContain("> 📝 _The task is prioritized and ready for dispatch._");
    expect(formatted).not.toContain("Component: core");
  });

  it("formats task start approval card with Start / Defer buttons and description block", () => {
    const card = formatApprovalCard({
      approvalId: "app-1",
      action: "task_start",
      issueIdentifier: "MAZ-101",
      issueTitle: "Implement BPF linear scan",
      description: "Perform strict instruction validation without kernel traps.",
      reason: "Routed to primary Jules lane",
      priority: "high",
    });

    expect(card.text).toContain("Task Dispatch Approval");
    expect(card.text).toContain("[MAZ-101] Implement BPF linear scan");
    expect(card.text).toContain("HIGH");
    expect(card.text).toContain("> 📝 _Perform strict instruction validation without kernel traps._");
    expect(card.replyMarkup.inline_keyboard[0]![0]!.text).toBe("▶️ Start Task");
    expect(card.replyMarkup.inline_keyboard[0]![1]!.text).toBe("⏸️ Skip / Defer");
  });

  it("formats PR merge approval card with Approve & Merge button and link", () => {
    const card = formatApprovalCard({
      approvalId: "app-2",
      action: "pr_merge",
      issueIdentifier: "MAZ-102",
      issueTitle: "Fix seccomp offset",
      prNumber: 42,
      prUrl: "https://github.com/Pilleo/mazewall/pull/42",
      reviewVerdict: "Passed with zero findings.",
    });

    expect(card.text).toContain("Pull Request Merge Approval");
    expect(card.text).toContain("[#42]");
    expect(card.replyMarkup.inline_keyboard[0]![0]!.text).toBe("🚢 Approve & Merge");
    expect(card.replyMarkup.inline_keyboard[0]![1]!.text).toBe("✏️ Request Changes");
    expect(card.replyMarkup.inline_keyboard[1]![0]!.text).toBe("🔍 View PR on GitHub");
  });

  it("formats clarification question card cleanly", () => {
    const card = formatClarificationQuestionCard({
      issueIdentifier: "MAZ-103",
      issueTitle: "Clarify struct size",
      question: "Should sock_filter use 64-bit alignment?",
      agentName: "Jules",
    });

    expect(card).toContain("Clarification Question from Jules");
    expect(card).toContain("Should sock_filter use 64-bit alignment?");
  });

  it("formats fleet status telemetry correctly with budget math", () => {
    const card = formatFleetStatusCard({
      activeSessions: 3,
      maxConcurrent: 15,
      dailySpendEstimate: 12.5,
      dailySpendBudget: 25.0,
      openIssuesCount: 40,
      inReviewCount: 5,
      pendingApprovalsCount: 2,
    });

    expect(card).toContain("Paperclip Fleet Live Telemetry");
    expect(card).toContain("3 / 15");
    expect(card).toContain("`$12.500 / $25.00` (50%)");
  });

  it("formats top task queue card", () => {
    const card = formatTaskQueueCard([
      { identifier: "MAZ-1", title: "Task One", priority: "high" },
      { identifier: "MAZ-2", title: "Task Two", priority: "low" },
    ]);

    expect(card).toContain("Top Unblocked Tasks (2 ready)");
    expect(card).toContain("*[MAZ-1]* Task One (`high`)");
  });
});
