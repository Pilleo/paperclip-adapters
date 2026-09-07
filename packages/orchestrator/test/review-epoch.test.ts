import { describe, expect, it } from "vitest";
import {
  reduceReviewEpoch,
  type ReviewEpochObservation,
} from "../src/core/review-epoch.js";

const base = (overrides: Partial<ReviewEpochObservation> = {}): ReviewEpochObservation => ({
  issueId: "issue-1",
  prUrl: "https://github.com/acme/repo/pull/1",
  headSha: "0123456789012345678901234567890123456789",
  stage: "luna",
  nextStage: "terra",
  reviewerAgentId: "luna-1",
  card: { state: "pending", id: "card-1" },
  reviewerRun: { state: "missing" },
  recovery: { state: "never_attempted" },
  verdict: null,
  ...overrides,
});

describe("review epoch reducer", () => {
  it.each([
    ["missing run before recovery", { state: "never_attempted" as const }, "wake_once"],
    ["missing run after recovery lease", { state: "leased" as const }, "await_verdict"],
    ["active run", { state: "active" as const }, "await_verdict"],
  ])("emits at most one recovery wake: %s", (_name, recovery, action) => {
    expect(reduceReviewEpoch(base({ recovery }))).toMatchObject({ action });
  });

  it("never advances from a pending card because of comments or assignment", () => {
    expect(reduceReviewEpoch(base({
      comments: [{ body: "LGTM" }],
      assignedReviewer: "luna-1",
      recovery: { state: "leased" },
    }))).toMatchObject({ action: "await_verdict", stage: "luna" });
  });

  it("advances only on the exact structured approval for this immutable head", () => {
    expect(reduceReviewEpoch(base({
      card: { state: "answered", id: "card-1" },
      verdict: { cardId: "card-1", headSha: "0123456789012345678901234567890123456789", decision: "all_good" },
    }))).toMatchObject({ action: "advance", nextStage: "terra" });
  });

  it("advances arbitrary configured stages without provider-name branching", () => {
    expect(reduceReviewEpoch(base({
      stage: "budget-review",
      nextStage: "expert-review",
      card: { state: "answered", id: "card-1" },
      verdict: { cardId: "card-1", headSha: "0123456789012345678901234567890123456789", decision: "all_good" },
    }))).toEqual({ action: "advance", nextStage: "expert-review" });
  });

  it("completes an approved final configured stage", () => {
    expect(reduceReviewEpoch(base({
      stage: "expert-review",
      nextStage: null,
      card: { state: "answered", id: "card-1" },
      verdict: { cardId: "card-1", headSha: "0123456789012345678901234567890123456789", decision: "all_good" },
    }))).toEqual({ action: "complete", stage: "expert-review" });
  });

  it("rejects a verdict from another card or head", () => {
    expect(reduceReviewEpoch(base({
      card: { state: "answered", id: "old-card" },
      recovery: { state: "leased" },
      verdict: { cardId: "old-card", headSha: "fedcba9876543210fedcba9876543210fedcba98", decision: "all_good" },
    }))).toMatchObject({ action: "await_verdict", stage: "luna" });
  });

  it("escalates a second recovery failure instead of allocating another card or wake", () => {
    expect(reduceReviewEpoch(base({
      recovery: { state: "failed" as const, reason: "409 checkout lock" },
    }))).toMatchObject({ action: "escalate", reason: "409 checkout lock" });
  });

  it("escalates rather than re-waking a card whose bound reviewer run failed", () => {
    expect(reduceReviewEpoch(base({
      reviewerRun: { state: "failed", runId: "run-1", reason: "reviewer adapter failed" },
    }))).toMatchObject({ action: "escalate", reason: "reviewer adapter failed" });
  });

  it("recreates an internally retired card when no reviewer run owns it", () => {
    expect(reduceReviewEpoch(base({
      card: { state: "retired", id: "cancelled-card", reason: "superseded before the plan gate completed" },
    }))).toMatchObject({ action: "create_card", stage: "luna" });
  });

  it("does not replace a retired card while its reviewer run is still active", () => {
    expect(reduceReviewEpoch(base({
      card: { state: "retired", id: "cancelled-card", reason: "cancelled by Paperclip" },
      reviewerRun: { state: "active", runId: "run-1" },
    }))).toMatchObject({ action: "escalate", stage: "luna" });
  });
});
