import { describe, expect, it } from "vitest";
import {
  reviewInteractionIdempotencyKey,
  isReviewInteractionForIssue,
  buildNativeReviewExecutionState,
  planReviewDialog,
  buildReviewInteractionRequest,
  shouldExplicitlyWakeReviewCard,
  selectReviewAttempt,
  reviewVerdictFromInteraction,
  shouldWakeAssignedReview,
  selectPrReviewIssues,
  isCanonicalReviewCardKey,
  selectReviewCardsToWithdrawAfterRejection,
  canPromoteOpenPrToReview,
  hasNativeRejectionForHead,
} from "../src/core/review-interaction-state.js";

describe("native PR review interaction state", () => {
  it("uses a stable stage-and-head identity, not comments or assignment", () => {
    expect(reviewInteractionIdempotencyKey({ issueId: "issue-1", prUrl: "https://github.com/acme/repo/pull/1", headSha: "abc", stage: "vibe" }))
      .toBe("pr-review:v12:issue-1:https://github.com/acme/repo/pull/1:abc:vibe");
  });

  it("accepts only the bound item's native verdict and requires a rejection reason", () => {
    expect(reviewVerdictFromInteraction({
      id: "interaction-1", kind: "request_item_verdicts", status: "answered",
      result: { items: [{ id: "pull_request", verdict: "reject", reason: "Missing regression test" }] },
    }, "interaction-1")).toEqual({ decision: "needs_work", reason: "Missing regression test" });
    expect(reviewVerdictFromInteraction({
      id: "interaction-1", kind: "request_item_verdicts", status: "answered",
      result: { items: [{ id: "pull_request", verdict: "reject", reason: "  " }] },
    }, "interaction-1")).toBeNull();
    expect(reviewVerdictFromInteraction({
      id: "other", kind: "request_item_verdicts", status: "answered",
      result: { items: [{ id: "pull_request", verdict: "approve" }] },
    }, "interaction-1")).toBeNull();
  });

  it("recognizes migrated v2 through v12 review cards for stale cleanup", () => {
    expect(isReviewInteractionForIssue("pr-review:v2:issue-1:pr:sha:vibe", "issue-1")).toBe(true);
    expect(isReviewInteractionForIssue("pr-review:v3:issue-1:pr:sha:luna", "issue-1")).toBe(true);
    expect(isReviewInteractionForIssue("pr-review:v4:issue-1:pr:sha:luna", "issue-1")).toBe(true);
    expect(isReviewInteractionForIssue("pr-review:v5:issue-1:pr:sha:luna", "issue-1")).toBe(true);
    expect(isReviewInteractionForIssue("pr-review:v6:issue-1:pr:sha:luna", "issue-1")).toBe(true);
    expect(isReviewInteractionForIssue("pr-review:v7:issue-1:pr:sha:luna", "issue-1")).toBe(true);
    expect(isReviewInteractionForIssue("pr-review:v8:issue-1:pr:sha:luna", "issue-1")).toBe(true);
    expect(isReviewInteractionForIssue("pr-review:v9:issue-1:pr:sha:luna", "issue-1")).toBe(true);
    expect(isReviewInteractionForIssue("pr-review:v10:issue-1:pr:sha:luna", "issue-1")).toBe(true);
    expect(isReviewInteractionForIssue("pr-review:v11:issue-1:pr:sha:luna", "issue-1")).toBe(true);
    expect(isReviewInteractionForIssue("pr-review:v12:issue-1:pr:sha:luna", "issue-1")).toBe(true);
    expect(isReviewInteractionForIssue("pr-review:v3:issue-2:pr:sha:luna", "issue-1")).toBe(false);
  });

  it("reuses a pending dialog without a second dispatch effect", () => {
    const identity = { issueId: "issue-1", prUrl: "https://github.com/acme/repo/pull/1", headSha: "abc", stage: "vibe" as const };
    expect(planReviewDialog(identity, [{ id: "dialog-1", kind: "request_item_verdicts", status: "pending", continuationPolicy: "wake_assignee", idempotencyKey: reviewInteractionIdempotencyKey(identity) }]))
      .toEqual({ action: "reuse", interactionId: "dialog-1" });
  });

  it("reuses only a pending dialog addressed to the configured reviewer", () => {
    const identity = {
      issueId: "issue-1", prUrl: "https://github.com/acme/repo/pull/1", headSha: "abc",
      stage: "luna" as const, reviewerAgentId: "luna-1",
    };
    expect(planReviewDialog(identity, [{
      id: "dialog-1", kind: "request_item_verdicts", status: "pending",
      continuationPolicy: "wake_assignee", addresseeAgentId: "luna-1",
      idempotencyKey: reviewInteractionIdempotencyKey(identity),
    }])).toEqual({ action: "reuse", interactionId: "dialog-1" });
    expect(buildReviewInteractionRequest(identity)).toMatchObject({
      continuationPolicy: "wake_assignee", addresseeAgentId: "luna-1",
    });
  });

  it("binds the parent issue to the native reviewer participant without assigning it", () => {
    expect(buildNativeReviewExecutionState({ status: "idle", monitor: { kind: "external_service" } }, "luna", "luna-1")).toMatchObject({
      status: "pending",
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: "luna-1" },
      currentStageId: "4f2f31d2-91b9-4d4b-8c1f-11cf3a9e1a01",
      currentStageIndex: 0,
      reviewRequest: { kind: "pull_request", stage: "luna" },
      monitor: { kind: "external_service" },
    });
  });

  it("preserves the second stage as a UUID and records the first stage complete", () => {
    expect(buildNativeReviewExecutionState(null, "terra", "terra-1")).toMatchObject({
      currentStageId: "4f2f31d2-91b9-4d4b-8c1f-11cf3a9e1a02",
      currentStageIndex: 1,
      completedStageIds: ["4f2f31d2-91b9-4d4b-8c1f-11cf3a9e1a01"],
    });
  });

  it("does not reuse a legacy addressed or wake-on-resolution dialog", () => {
    const identity = { issueId: "issue-1", prUrl: "https://github.com/acme/repo/pull/1", headSha: "abc", stage: "vibe" as const };
    expect(planReviewDialog(identity, [{
      id: "legacy-dialog", kind: "request_item_verdicts", status: "pending",
      idempotencyKey: reviewInteractionIdempotencyKey(identity),
      addresseeAgentId: "reviewer-1", continuationPolicy: "wake_assignee",
    }])).toEqual({ action: "create", idempotencyKey: reviewInteractionIdempotencyKey(identity) });
  });

  it("re-wakes an already-assigned reviewer after restart only when its pending card has no active issue-bound run", () => {
    expect(shouldWakeAssignedReview({ dialogCreated: true, hasActiveBoundRun: false })).toBe(true);
    expect(shouldWakeAssignedReview({ dialogCreated: false, hasActiveBoundRun: false })).toBe(true);
    expect(shouldWakeAssignedReview({ dialogCreated: false, hasActiveBoundRun: true })).toBe(false);
  });

  it("creates an unaddressed two-option dialog without waking a reviewer before assignment", () => {
    const request = buildReviewInteractionRequest(
      { issueId: "issue-1", prUrl: "https://github.com/acme/repo/pull/1", headSha: "abc", stage: "vibe" },
    );
    expect(request).toMatchObject({
      kind: "request_item_verdicts", continuationPolicy: "wake_assignee",
      payload: {
        verdicts: ["approve", "reject"], requireReasonOn: ["reject"], reasonLabel: "What must change?",
        supersedeOnUserComment: false,
      },
    });
    expect(request).not.toHaveProperty("addresseeAgentId");
    expect(request.payload.detailsMarkdown).toContain("/interactions/<INTERACTION_ID>/verdicts");
    expect(request.payload.detailsMarkdown).toContain('"verdicts":[{"id":"pull_request","verdict":"approve"}]');
  });

  it("selects only orchestrator-owned issues with an actual pull request", () => {
    expect(selectPrReviewIssues([
      { id: "pr", status: "in_review", orchestratorManaged: true, hasPullRequest: true },
      { id: "jules-question", status: "in_review", orchestratorManaged: false, hasPullRequest: false, description: "<!-- jules-question-adjudication:x -->" },
      { id: "plan", status: "in_review", orchestratorManaged: true, hasPullRequest: false, description: "<!-- jules-plan-review:x -->" },
    ])).toEqual(["pr"]);
  });
});
