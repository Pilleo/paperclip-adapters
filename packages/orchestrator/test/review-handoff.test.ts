import { describe, it, expect } from "vitest";
import {
  evaluateReviewVerdict,
  determineReviewHandoffAction,
} from "../src/core/review-handoff.js";
import { ParsedIssueMetadata } from "../src/core/types.js";

describe("Review Handoff & Reassignment Engine", () => {
  const baseIssue: ParsedIssueMetadata = {
    id: "issue-1",
    identifier: "MAZ-141",
    title: "Cap SandboxDispatcher poolCache growth",
    status: "in_review",
    priority: "high",
    component: "enforcer",
    targetModules: [":enforcer"],
    targetFiles: ["enforcer/src/main/kotlin/io/mazewall/SandboxDispatcher.kt"],
    targetSymbols: ["SandboxDispatcher"],
    dependencies: [],
    openQuestions: false,
    body: "Issue description",
    assigneeAgentId: "reviewer-123",
  };

  it("detects REQUEST_CHANGES verdict from reviewer comments", () => {
    const comments = [
      {
        id: "c-1",
        body: "Review requested for PR #400",
        createdAt: "2026-08-30T10:00:00Z",
      },
      {
        id: "c-2",
        body: "## 🛑 Automated Code Review Verdict: **REQUEST_CHANGES**\n- Violation: Unbounded cache growth detected.",
        authorAgentId: "reviewer-123",
        createdAt: "2026-08-30T10:05:00Z",
      },
    ];

    const verdict = evaluateReviewVerdict(comments, "reviewer-123");
    expect(verdict.verdict).toBe("REQUEST_CHANGES");
    expect(verdict.reviewCommentId).toBe("c-2");
  });

  it("detects APPROVE verdict from reviewer comments", () => {
    const comments = [
      {
        id: "c-1",
        body: "### 📝 Response Format\n- **🎯 Recommendation:** APPROVE\n- **💡 Findings:** All tests pass cleanly.",
        authorAgentId: "reviewer-123",
        createdAt: "2026-08-30T10:05:00Z",
      },
    ];

    const verdict = evaluateReviewVerdict(comments, "reviewer-123");
    expect(verdict.verdict).toBe("APPROVE");
    expect(verdict.reviewCommentId).toBe("c-1");
  });

  it("returns PENDING when no review has been posted yet", () => {
    const comments = [
      {
        id: "c-1",
        body: "Review requested for PR #400",
        createdAt: "2026-08-30T10:00:00Z",
      },
    ];

    const verdict = evaluateReviewVerdict(comments, "reviewer-123");
    expect(verdict.verdict).toBe("PENDING");
  });

  it("determines REASSIGN_TO_WORKER action on REQUEST_CHANGES", () => {
    const handoff = determineReviewHandoffAction({
      issue: baseIssue,
      verdict: "REQUEST_CHANGES",
      workerAgentId: "jules-worker-id",
      reviewerAgentId: "reviewer-123",
    });

    expect(handoff.action).toBe("REASSIGN_TO_WORKER");
    expect(handoff.targetStatus).toBe("in_progress");
    expect(handoff.targetAssigneeId).toBe("jules-worker-id");
    expect(handoff.wakeAgent).toBe(true);
  });

  it("determines UNASSIGN_REVIEWER action on APPROVE", () => {
    const handoff = determineReviewHandoffAction({
      issue: baseIssue,
      verdict: "APPROVE",
      workerAgentId: "jules-worker-id",
      reviewerAgentId: "reviewer-123",
    });

    expect(handoff.action).toBe("UNASSIGN_REVIEWER");
    expect(handoff.targetStatus).toBe("in_review");
    expect(handoff.targetAssigneeId).toBeNull();
    expect(handoff.wakeAgent).toBe(false);
  });

  it("determines WAIT action when review is PENDING", () => {
    const handoff = determineReviewHandoffAction({
      issue: baseIssue,
      verdict: "PENDING",
      workerAgentId: "jules-worker-id",
      reviewerAgentId: "reviewer-123",
    });

    expect(handoff.action).toBe("WAIT");
  });
});
