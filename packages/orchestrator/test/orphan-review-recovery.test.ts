import { describe, expect, it } from "vitest";
import { planOrphanReviewRecovery } from "../src/core/orphan-review-recovery.js";
import type { HeartbeatRunSummary } from "../src/core/session-continuation.js";

const run = (patch: Partial<HeartbeatRunSummary> = {}): HeartbeatRunSummary => ({
  id: "run-1", agentId: "luna", status: "running", finishedAt: null, startedAt: null,
  sessionIdBefore: null, sessionIdAfter: null, issueId: "issue-1", retryNotBefore: null,
  providerSessionId: "session-1", interactionId: null, interactionKind: null,
  reviewStage: null, reviewHeadSha: null, ...patch,
});

describe("orphan native review recovery", () => {
  it("cancels a reviewer run with no native interaction binding", () => {
    expect(planOrphanReviewRecovery({ issueId: "issue-1", reviewerAgentIds: ["luna", "terra"], runs: [run()], interactions: [] }).cancelRunIds).toEqual(["run-1"]);
  });

  it("preserves a run bound to a pending request-item verdict card", () => {
    expect(planOrphanReviewRecovery({ issueId: "issue-1", reviewerAgentIds: ["luna"], runs: [run({ interactionId: "card-1", interactionKind: "request_item_verdicts" })], interactions: [{ id: "card-1", kind: "request_item_verdicts", status: "pending" }] }).cancelRunIds).toEqual([]);
  });

  it("preserves an issue-bound reviewer run when Paperclip omits interaction context", () => {
    expect(planOrphanReviewRecovery({
      issueId: "issue-1",
      reviewerAgentIds: ["luna"],
      runs: [run({ interactionId: null, interactionKind: null })],
      interactions: [{ id: "card-1", kind: "request_item_verdicts", status: "pending" }],
    }).cancelRunIds).toEqual([]);
  });

  it("preserves the correlated live run after Paperclip cancels its card", () => {
    expect(planOrphanReviewRecovery({
      issueId: "issue-1",
      reviewerAgentIds: ["luna"],
      activeReviewInteractionId: "card-1",
      runs: [run({ interactionId: null, interactionKind: null })],
      interactions: [{ id: "card-1", kind: "request_item_verdicts", status: "cancelled" }],
    }).cancelRunIds).toEqual([]);
  });

  it("resolves only Paperclip's generic review disposition repair", () => {
    const base = { issueId: "issue-1", reviewerAgentIds: ["luna"], runs: [], interactions: [] } as const;
    expect(planOrphanReviewRecovery({ ...base, activeRecoveryAction: { id: "repair-1", kind: "deliberate_wait_without_target", status: "active", cause: "deliberate_wait_without_target" } }).resolveRecoveryActionId).toBe("repair-1");
    expect(planOrphanReviewRecovery({ ...base, activeRecoveryAction: { id: "wait-1", kind: "reviewer_unavailable", status: "active" } }).resolveRecoveryActionId).toBeNull();
  });

  it("is idempotent", () => {
    const input = { issueId: "issue-1", reviewerAgentIds: ["luna"], runs: [run()], interactions: [], activeRecoveryAction: { id: "repair-1", kind: "deliberate_wait_without_target", status: "active" } };
    expect(planOrphanReviewRecovery(input)).toEqual(planOrphanReviewRecovery(input));
  });
});
