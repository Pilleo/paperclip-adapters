import { describe, expect, it } from "vitest";
import { decideNativeReviewRecovery, nativeReviewRecoveryIssuePatch } from "../src/core/native-review-recovery-state.js";

const prCard = {
  id: "pr-card",
  kind: "request_item_verdicts",
  status: "pending",
  addresseeAgentId: "luna-1",
  idempotencyKey: "pr-review:v13:issue-1:https://github.com/acme/repo/pull/1:head-1:luna",
};

const stalePlanCard = {
  id: "plan-card",
  kind: "request_item_verdicts",
  status: "pending",
  addresseeAgentId: "luna-1",
  idempotencyKey: "jules:plan-review:v2:issue-1:session-1:revision-1:luna",
};

describe("native review recovery state", () => {
  it("restores the canonical PR card after a restart projection and retires a superseded plan card", () => {
    expect(decideNativeReviewRecovery({
      issueId: "issue-1",
      issueStatus: "backlog",
      orchestratorManaged: true,
      prIdentity: { url: "https://github.com/acme/repo/pull/1", headSha: "head-1" },
      cards: [stalePlanCard, prCard],
      reviewerRuns: [{ id: "lost-luna", agentId: "luna-1", status: "failed", issueId: "issue-1", interactionId: "pr-card" }],
    })).toEqual({
      action: "restore_and_recover",
      interactionId: "pr-card",
      reviewerAgentId: "luna-1",
      failedRunId: "lost-luna",
      withdrawInteractionIds: ["plan-card"],
    });
  });

  it("waits rather than waking again while the canonical card has a live reviewer run", () => {
    expect(decideNativeReviewRecovery({
      issueId: "issue-1",
      issueStatus: "in_review",
      orchestratorManaged: true,
      prIdentity: { url: "https://github.com/acme/repo/pull/1", headSha: "head-1" },
      cards: [prCard],
      reviewerRuns: [{ id: "live-luna", agentId: "luna-1", status: "running", issueId: "issue-1", interactionId: "pr-card" }],
    })).toEqual({ action: "await_run", interactionId: "pr-card", runId: "live-luna" });
  });

  it("leaves a healthy unassigned in-review card to the normal review pipeline", () => {
    expect(decideNativeReviewRecovery({
      issueId: "issue-1",
      issueStatus: "in_review",
      orchestratorManaged: true,
      prIdentity: { url: "https://github.com/acme/repo/pull/1", headSha: "head-1" },
      cards: [prCard],
      reviewerRuns: [],
    })).toEqual({ action: "no_action" });
  });

  it("recognizes Paperclip's addressed-reviewer assignment as a healthy native review projection", () => {
    expect(decideNativeReviewRecovery({
      issueId: "issue-1",
      issueStatus: "in_review",
      issueAssigneeAgentId: "luna-1",
      orchestratorManaged: true,
      prIdentity: { url: "https://github.com/acme/repo/pull/1", headSha: "head-1" },
      cards: [prCard],
      reviewerRuns: [],
    })).toEqual({ action: "no_action" });
  });

  it("assigns the addressed reviewer before recovering a lost native-review run", () => {
    const decision = decideNativeReviewRecovery({
      issueId: "issue-1",
      issueStatus: "backlog",
      issueAssigneeAgentId: "jules-1",
      orchestratorManaged: true,
      prIdentity: { url: "https://github.com/acme/repo/pull/1", headSha: "head-1" },
      cards: [prCard],
      reviewerRuns: [],
    });
    expect(decision.action).toBe("restore_and_recover");
    if (decision.action !== "restore_and_recover") throw new Error("expected recovery decision");
    expect(nativeReviewRecoveryIssuePatch(decision)).toEqual({ status: "in_review", assigneeAgentId: "luna-1" });
  });

  it("reuses the card after a graceful-shutdown interruption without reading reviewer prose", () => {
    expect(decideNativeReviewRecovery({
      issueId: "issue-1",
      issueStatus: "in_review",
      orchestratorManaged: true,
      prIdentity: { url: "https://github.com/acme/repo/pull/1", headSha: "head-1" },
      cards: [prCard],
      reviewerRuns: [{ id: "shutdown-luna", agentId: "luna-1", status: "interrupted", issueId: "issue-1", interactionId: "pr-card" }],
    })).toEqual({
      action: "restore_and_recover",
      interactionId: "pr-card",
      reviewerAgentId: "luna-1",
      failedRunId: "shutdown-luna",
      withdrawInteractionIds: [],
    });
  });

  it("does not repair a plan card without a PR card for the immutable head", () => {
    expect(decideNativeReviewRecovery({
      issueId: "issue-1",
      issueStatus: "backlog",
      orchestratorManaged: true,
      prIdentity: { url: "https://github.com/acme/repo/pull/1", headSha: "head-1" },
      cards: [stalePlanCard],
      reviewerRuns: [],
    })).toEqual({ action: "no_action" });
  });

  it("refuses to repair an ambiguous set of current PR cards", () => {
    expect(decideNativeReviewRecovery({
      issueId: "issue-1",
      issueStatus: "backlog",
      orchestratorManaged: true,
      prIdentity: { url: "https://github.com/acme/repo/pull/1", headSha: "head-1" },
      cards: [prCard, { ...prCard, id: "other-pr-card" }],
      reviewerRuns: [],
    })).toEqual({ action: "protocol_failure", reason: "multiple_pending_canonical_pr_cards" });
  });
});
