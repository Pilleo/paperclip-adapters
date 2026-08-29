import { describe, it, expect } from "vitest";
import {
  formatApprovalCard,
  formatClarificationQuestionCard,
  formatFleetStatusCard,
  formatTaskQueueCard,
} from "../src/formatters.js";

describe("Telegram Card Formatters", () => {
  it("formats pending approval card with inline action buttons", () => {
    const card = formatApprovalCard({
      approvalId: "app-123",
      issueIdentifier: "MAZ-100",
      issueTitle: "Implement FFM ABI",
      prNumber: 42,
      prUrl: "https://github.com/pilleo/mazewall/pull/42",
      reviewVerdict: "✅ Green CI & Grok Approved",
      requestedBy: "jules",
    });

    expect(card.text).toContain("MAZ-100");
    expect(card.text).toContain("Implement FFM ABI");
    expect(card.text).toContain("pull/42");
    expect(card.text).toContain("Green CI & Grok Approved");

    const buttons = card.replyMarkup.inline_keyboard;
    expect(buttons[0]?.[0]?.callback_data).toBe("approve:app-123");
    expect(buttons[0]?.[1]?.callback_data).toBe("reject:app-123");
    expect(buttons[1]?.[0]?.url).toBe("https://github.com/pilleo/mazewall/pull/42");
  });

  it("formats clarification question card", () => {
    const text = formatClarificationQuestionCard({
      issueIdentifier: "MAZ-105",
      issueTitle: "Clarify struct layout",
      question: "Should we use 64-bit alignment?",
      agentName: "Jules",
    });

    expect(text).toContain("Clarification Question from Jules");
    expect(text).toContain("MAZ-105");
    expect(text).toContain("Should we use 64-bit alignment?");
  });

  it("formats fleet status live telemetry card", () => {
    const text = formatFleetStatusCard({
      activeSessions: 5,
      maxConcurrent: 15,
      dailySpendEstimate: 0.25,
      dailySpendBudget: 25.0,
      openIssuesCount: 42,
      inReviewCount: 3,
      pendingApprovalsCount: 2,
    });

    expect(text).toContain("5 / 15");
    expect(text).toContain("$0.250 / $25.00");
    expect(text).toContain("Pending Approvals:* `2`");
  });

  it("formats task queue card with empty and populated lists", () => {
    const empty = formatTaskQueueCard([]);
    expect(empty).toContain("Task Queue is Empty");

    const tasks = [
      { identifier: "MAZ-10", title: "Task 1", priority: "high" },
      { identifier: "MAZ-11", title: "Task 2", priority: "medium" },
    ];
    const card = formatTaskQueueCard(tasks);
    expect(card).toContain("MAZ-10");
    expect(card).toContain("MAZ-11");
  });
});
