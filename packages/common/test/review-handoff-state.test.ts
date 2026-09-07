import { describe, expect, it } from "vitest";
import { decideReviewHandoff, shouldRestorePlanReviewAfterConsumedPrRejection } from "../src/review-handoff-state.js";

const rejection = {
  interactionId: "luna-reject-1",
  prUrl: "https://github.com/Pilleo/paperclip-adapters/pull/5",
  headSha: "a".repeat(40),
  stage: "luna" as const,
  reason: "Fix the cancellation endpoint.",
};

describe("review handoff precedence", () => {
  it("routes a matching PR rejection ahead of a pending Terra plan card", () => {
    expect(decideReviewHandoff({
      providerState: "COMPLETED",
      currentPr: { url: rejection.prUrl, headSha: rejection.headSha },
      pendingPlanReview: { interactionId: "terra-plan-1", stage: "terra" },
      rejection,
    })).toEqual({
      action: "relay_pr_rejection",
      rejection,
      supersedePlanInteractionId: "terra-plan-1",
    });
  });

  it("does not let an already-delivered rejection cancel a later plan-review cycle", () => {
    expect(decideReviewHandoff({
      providerState: "AWAITING_PLAN_APPROVAL",
      currentPr: { url: rejection.prUrl, headSha: rejection.headSha },
      pendingPlanReview: { interactionId: "replacement-luna-plan-1", stage: "luna" },
      rejection,
      deliveredRejectionDeliveryId: `native-review:${rejection.interactionId}:${rejection.headSha}`,
    })).toEqual({ action: "await_plan_review" });
  });

  it("does not route an older PR-head rejection", () => {
    expect(decideReviewHandoff({
      providerState: "COMPLETED",
      currentPr: { url: rejection.prUrl, headSha: "b".repeat(40) },
      pendingPlanReview: { interactionId: "terra-plan-1", stage: "terra" },
      rejection,
    })).toEqual({ action: "await_plan_review" });
  });

  it("does not infer a rejection when the immutable head is unavailable", () => {
    expect(decideReviewHandoff({
      providerState: "COMPLETED",
      currentPr: { url: rejection.prUrl },
      pendingPlanReview: { interactionId: "terra-plan-1", stage: "terra" },
      rejection,
    })).toEqual({ action: "await_plan_review" });
  });

  it("does not let a plan approval advance the PR review lane", () => {
    expect(decideReviewHandoff({
      providerState: "COMPLETED",
      currentPr: { url: rejection.prUrl, headSha: rejection.headSha },
      pendingPlanReview: { interactionId: "terra-plan-1", stage: "terra" },
    })).toEqual({ action: "await_plan_review" });
  });

  it.each([
    ["restores only the adapter-cancelled replacement plan", {
      interactionStatus: "cancelled", withdrawalReason: "Superseded by structured PR rejection for the same Jules session and immutable PR head.",
      deliveredRejectionDeliveryId: "native-review:luna-reject-1:abc",
    }, true],
    ["does not restore an ordinary cancellation", {
      interactionStatus: "cancelled", withdrawalReason: "Cancelled by board user.",
      deliveredRejectionDeliveryId: "native-review:luna-reject-1:abc",
    }, false],
    ["does not restore without a delivered rejection", {
      interactionStatus: "cancelled", withdrawalReason: "Superseded by structured PR rejection for the same Jules session and immutable PR head.",
    }, false],
    ["does not restore a pending card", {
      interactionStatus: "pending", withdrawalReason: "Superseded by structured PR rejection for the same Jules session and immutable PR head.",
      deliveredRejectionDeliveryId: "native-review:luna-reject-1:abc",
    }, false],
  ] as const)("%s", (_label, input, expected) => {
    expect(shouldRestorePlanReviewAfterConsumedPrRejection(input)).toBe(expected);
  });
});
