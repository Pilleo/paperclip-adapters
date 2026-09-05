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
import { isAuthoritativeJulesMonitor } from "../src/core/jules-monitor-state.js";

describe("native PR review interaction state", () => {
  it("recognizes canonical retry keys while rejecting legacy review stages", () => {
    expect(isCanonicalReviewCardKey("pr-review:v13:issue-1:pr:sha:luna:attempt:21")).toBe(true);
    expect(isCanonicalReviewCardKey("pr-review:v13:issue-1:pr:sha:terra")).toBe(true);
    expect(isCanonicalReviewCardKey("pr-review:v13:issue-1:pr:sha:strong:attempt:21")).toBe(false);
    expect(isCanonicalReviewCardKey("pr-review:v13:issue-1:pr:sha:luna:attempt:x")).toBe(false);
  });

  it("does not promote a green PR when the current head is rejected or Jules has a resumable monitor", () => {
    expect(canPromoteOpenPrToReview({ ciGreen: true, currentHeadRejected: true, hasRecoverableJulesMonitor: false })).toBe(false);
    expect(canPromoteOpenPrToReview({ ciGreen: true, currentHeadRejected: false, hasRecoverableJulesMonitor: true })).toBe(false);
    expect(canPromoteOpenPrToReview({ ciGreen: true, currentHeadRejected: false, hasRecoverableJulesMonitor: false })).toBe(true);
    expect(canPromoteOpenPrToReview({ ciGreen: false, currentHeadRejected: false, hasRecoverableJulesMonitor: false })).toBe(false);
  });

  it("does not treat an executionState-only monitor projection as Jules ownership", () => {
    expect(isAuthoritativeJulesMonitor({ monitor: { serviceName: "jules", externalRef: "session-1" } })).toBe(true);
    expect(isAuthoritativeJulesMonitor(null)).toBe(false);
  });

  it("finds only structured rejection cards for the current immutable head", () => {
    expect(hasNativeRejectionForHead([
      { id: "luna", kind: "request_item_verdicts", status: "answered", idempotencyKey: "pr-review:v13:issue-1:pr:head-a:luna", result: { items: [{ id: "pull_request", verdict: "reject", reason: "Fix it" }] } },
      { id: "old", kind: "request_item_verdicts", status: "answered", idempotencyKey: "pr-review:v13:issue-1:pr:head-b:luna", result: { items: [{ id: "pull_request", verdict: "reject", reason: "Old" }] } },
      { id: "comment", kind: "comment", status: "answered", idempotencyKey: "pr-review:v13:issue-1:pr:head-a:terra", result: { items: [{ id: "pull_request", verdict: "reject", reason: "No" }] } },
    ], "issue-1", "head-a")).toBe(true);
    expect(hasNativeRejectionForHead([], "issue-1", "head-a")).toBe(false);
  });

  it("selects every other pending review card after a rejection, including legacy stale cards", () => {
    expect(selectReviewCardsToWithdrawAfterRejection([
      { id: "rejected", kind: "request_item_verdicts", status: "answered", idempotencyKey: "pr-review:v13:issue-1:pr:sha:luna" },
      { id: "stale-terra", kind: "request_item_verdicts", status: "pending", idempotencyKey: "pr-review:v13:issue-1:pr:sha:terra" },
      { id: "stale-strong", kind: "request_item_verdicts", status: "pending", idempotencyKey: "pr-review:v12:issue-1:pr:sha:strong" },
      { id: "other-issue", kind: "request_item_verdicts", status: "pending", idempotencyKey: "pr-review:v13:issue-2:pr:sha:terra" },
      { id: "comment", kind: "comment", status: "pending", idempotencyKey: "pr-review:v13:issue-1:pr:sha:terra" },
    ], "issue-1", "rejected")).toEqual(["stale-terra", "stale-strong"]);
  });
  it("uses a stable stage-and-head identity, not comments or assignment", () => {
    expect(reviewInteractionIdempotencyKey({ issueId: "issue-1", prUrl: "https://github.com/acme/repo/pull/1", headSha: "abc", stage: "vibe" }))
      .toBe("pr-review:v13:issue-1:https://github.com/acme/repo/pull/1:abc:vibe");
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

  it("recognizes migrated v2 through v13 review cards for stale cleanup", () => {
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
    expect(isReviewInteractionForIssue("pr-review:v13:issue-1:pr:sha:luna", "issue-1")).toBe(true);
    expect(isReviewInteractionForIssue("pr-review:v3:issue-2:pr:sha:luna", "issue-1")).toBe(false);
  });

  it("reuses a pending dialog without a second dispatch effect", () => {
    const identity = { issueId: "issue-1", prUrl: "https://github.com/acme/repo/pull/1", headSha: "abc", stage: "vibe" as const };
    expect(planReviewDialog(identity, [{ id: "dialog-1", kind: "request_item_verdicts", status: "pending", continuationPolicy: "wake_assignee", idempotencyKey: reviewInteractionIdempotencyKey(identity) }]))
      .toEqual({ action: "reuse", interactionId: "dialog-1" });
  });

  it("allocates the next idempotency attempt after a cancelled card", () => {
    const identity = { issueId: "issue-1", prUrl: "pr-1", headSha: "abc", stage: "luna" as const };
    expect(selectReviewAttempt(identity, [{ id: "old", kind: "request_item_verdicts", status: "cancelled", idempotencyKey: reviewInteractionIdempotencyKey(identity) }])).toBe(1);
    expect(reviewInteractionIdempotencyKey({ ...identity, attempt: 1 })).toContain(":attempt:1");
  });

  it("reuses a pending retry attempt instead of allocating another key", () => {
    const identity = { issueId: "issue-1", prUrl: "pr-1", headSha: "abc", stage: "luna" as const };
    const attemptOne = reviewInteractionIdempotencyKey({ ...identity, attempt: 1 });
    expect(planReviewDialog(identity, [{
      id: "retry-1", kind: "request_item_verdicts", status: "pending",
      idempotencyKey: attemptOne, continuationPolicy: "wake_assignee",
    }])).toEqual({ action: "reuse", interactionId: "retry-1" });
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
    expect(buildReviewInteractionRequest(identity)).toMatchObject({ continuationPolicy: "none", addresseeAgentId: "luna-1" });
  });

  it("reuses the adapter workaround card when it is intentionally unaddressed", () => {
    const identity = {
      issueId: "issue-1", prUrl: "pr-1", headSha: "abc", stage: "terra" as const,
      reviewerAgentId: "terra-1",
    };
    expect(planReviewDialog(identity, [{
      id: "unaddressed-card", kind: "request_item_verdicts", status: "pending",
      continuationPolicy: "wake_assignee", addresseeAgentId: null,
      idempotencyKey: reviewInteractionIdempotencyKey(identity),
    }])).toEqual({ action: "reuse", interactionId: "unaddressed-card" });
  });

  it("builds a visible addressed reviewer card", () => {
    const request = buildReviewInteractionRequest({
      issueId: "issue-1", prUrl: "pr-1", headSha: "abc", stage: "terra", reviewerAgentId: "terra-1",
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
