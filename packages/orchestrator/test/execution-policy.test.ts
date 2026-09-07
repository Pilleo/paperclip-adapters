import { describe, it, expect } from "vitest";
import {
  buildMazewallExecutionPolicy,
  issueHasExecutionPolicy,
  issueHasUnsafeVibeReviewParticipant,
  issueNeedsExecutionPolicyBackfill,
  nativePrReviewCleanupPatch,
  nativePrReviewOwnershipPatch,
  nativePrReviewParticipantPatch,
  nativePrReviewWaitPatch,
  shouldRecoverNativePrReview,
} from "../src/core/execution-policy.js";

describe("mazewall execution policy builder", () => {
  it("builds read-only Vibe then strong review stages without a fake merge type", () => {
    const policy = buildMazewallExecutionPolicy({
      vibeReviewerAgentId: "vibe-review-1",
      reviewerAgentId: "rev-1",
    });
    expect(policy?.stages).toHaveLength(2);
    expect(policy?.stages[0]).toEqual({
      type: "review",
      participants: [{ type: "agent", agentId: "vibe-review-1" }],
    });
    expect(policy?.stages[1]?.type).toBe("review");
  });

  it("identifies only the legacy writable Vibe review participant for migration", () => {
    expect(issueHasUnsafeVibeReviewParticipant({
      executionPolicy: { stages: [{ type: "review", participants: [{ type: "agent", agentId: "vibe-dev" }] }] },
    }, "vibe-dev")).toBe(true);
    expect(issueHasUnsafeVibeReviewParticipant({
      executionPolicy: { stages: [{ type: "review", participants: [{ type: "agent", agentId: "vibe-review" }] }] },
    }, "vibe-dev")).toBe(false);
  });

  it("detects an existing Paperclip executionPolicy", () => {
    expect(issueHasExecutionPolicy({ executionPolicy: { stages: [{ type: "review" }] } })).toBe(true);
    expect(issueHasExecutionPolicy({})).toBe(false);
  });

  it("clears Paperclip reviewer execution before adapter-owned PR review", () => {
    expect(nativePrReviewCleanupPatch()).toEqual({
      status: "in_review",
      assigneeAgentId: null,
      executionPolicy: null,
      executionState: null,
    });
  });

  it("keeps an unavailable review owned and visible", () => {
    expect(nativePrReviewWaitPatch("orch-1", { status: "waiting_for_reviewer" })).toEqual({ status: "in_review", assigneeAgentId: "orch-1", executionPolicy: null, executionState: { status: "waiting_for_reviewer" } });
  });

  it("assigns an active native review to its addressed reviewer without a host review policy", () => {
    expect(nativePrReviewOwnershipPatch("luna-1")).toEqual({
      status: "in_review",
      assigneeAgentId: "luna-1",
      executionPolicy: null,
      executionState: null,
    });
  });

  it("keeps adapter-owned review execution with the orchestrator", () => {
    expect(nativePrReviewParticipantPatch("orch-1", "luna-1", { status: "pending", currentParticipant: { type: "agent", agentId: "luna-1" } })).toEqual({
      status: "in_review",
      assigneeAgentId: "orch-1",
      executionPolicy: null,
      executionState: { status: "pending", currentParticipant: { type: "agent", agentId: "luna-1" } },
    });
  });

  it("selects managed in_progress issues that skipped dispatch", () => {
    const managed = new Set(["jules-1"]);
    expect(
      issueNeedsExecutionPolicyBackfill(
        {
          status: "in_progress",
          assigneeAgentId: "jules-1",
          rawIssue: {},
        },
        managed,
      ),
    ).toBe(true);
    expect(
      issueNeedsExecutionPolicyBackfill(
        {
          status: "in_progress",
          assigneeAgentId: "jules-1",
          rawIssue: { executionPolicy: { stages: [{ type: "review" }] } },
        },
        managed,
      ),
    ).toBe(false);
    expect(
      issueNeedsExecutionPolicyBackfill(
        {
          status: "in_progress",
          assigneeAgentId: "jules-1",
          hasReadyPullRequest: true,
          rawIssue: {},
        },
        managed,
      ),
    ).toBe(false);
    expect(
      issueNeedsExecutionPolicyBackfill(
        {
          status: "backlog",
          assigneeAgentId: "jules-1",
          rawIssue: {},
        },
        managed,
      ),
    ).toBe(false);
    expect(
      issueNeedsExecutionPolicyBackfill(
        {
          status: "in_progress",
          assigneeAgentId: "indie-jules",
          rawIssue: {},
        },
        managed,
      ),
    ).toBe(false);
  });

  it.each([
    ["blocked", true],
    ["backlog", true],
    ["todo", true],
    ["done", true],
    ["in_progress", false],
    ["in_review", false],
  ])("recovers an unreviewed ready PR from %s only when the review lane is terminal", (status, expected) => {
    expect(shouldRecoverNativePrReview({
      status,
      orchestratorManaged: true,
      merged: false,
      hasUnreviewedReadyPullRequest: true,
    })).toBe(expected);
  });
});
