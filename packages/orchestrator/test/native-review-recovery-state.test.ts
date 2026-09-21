import { describe, expect, it } from "vitest";
import {
  decideJulesPlanNativeReviewRecovery,
  decideNativeReviewRecovery,
} from "../src/core/native-review-recovery-state.js";

const prCard = {
  id: "pr-card",
  kind: "request_item_verdicts",
  status: "pending",
  addresseeAgentId: "luna-1",
  idempotencyKey: "pr-review:v13:issue-1:https://github.com/acme/repo/pull/1:head-1:luna",
  createdAt: "2026-09-15T18:00:00.000Z",
};

const stalePlanCard = {
  id: "plan-card",
  kind: "request_item_verdicts",
  status: "pending",
  addresseeAgentId: "luna-1",
  idempotencyKey: "jules:plan-review:v2:issue-1:session-1:revision-1:luna",
  createdAt: "2026-09-15T18:00:00.000Z",
};

const terraPlanCard = {
  ...stalePlanCard,
  id: "terra-plan-card",
  addresseeAgentId: "terra-1",
  idempotencyKey: "jules:plan-review:v2:issue-1:session-1:revision-1:terra",
};

const planRecoveryInput = (cards: readonly typeof stalePlanCard[], reviewerRuns: readonly {
  id: string;
  agentId: string;
  status: string;
  issueId: string;
  interactionId?: string;
}[] = []) => ({
  issueId: "issue-1",
  orchestratorManaged: true,
  issueAssigneeAgentId: "jules-1",
  julesAgentId: "jules-1",
  reviewerAgentIds: { luna: "luna-1", terra: "terra-1" },
  nowMs: Date.parse("2026-09-15T18:02:00.000Z"),
  graceMs: 60_000,
  cards,
  reviewerRuns,
});

describe("native review recovery state", () => {
  const prRecoveryInput = (cards: readonly typeof prCard[], reviewerRuns: readonly {
    id: string;
    agentId: string;
    status: string;
    issueId: string;
    interactionId?: string;
  }[] = []) => ({
    issueId: "issue-1",
    issueStatus: "in_review",
    orchestratorManaged: true,
    prIdentity: { url: "https://github.com/acme/repo/pull/1", headSha: "head-1" },
    nowMs: Date.parse("2026-09-15T18:02:00.000Z"),
    graceMs: 60_000,
    maxReplacementAttempts: 1,
    cards,
    reviewerRuns,
  });

  it("replaces the canonical PR card after a lost dispatch and retires a superseded plan card", () => {
    expect(decideNativeReviewRecovery({
      ...prRecoveryInput([prCard]),
      issueStatus: "backlog",
      cards: [stalePlanCard, prCard],
      reviewerRuns: [{ id: "lost-luna", agentId: "luna-1", status: "failed", issueId: "issue-1", interactionId: "pr-card" }],
    })).toEqual({
      action: "replace_card",
      interactionId: "pr-card",
      reviewerAgentId: "luna-1",
      failedRunId: "lost-luna",
      stage: "luna",
      nextAttempt: 1,
      cause: "terminal_run",
      withdrawInteractionIds: ["plan-card"],
    });
  });

  it("keeps an overdue contract-scoped PR card and requests same-card dispatch recovery", () => {
    expect(decideNativeReviewRecovery({
      ...prRecoveryInput([prCard]),
      issueStatus: "backlog",
      cards: [stalePlanCard, { ...prCard, idempotencyKey: `${prCard.idempotencyKey}:contract:170855u` }],
    })).toMatchObject({
      action: "recover_dispatch",
      interactionId: "pr-card",
      reviewerAgentId: "luna-1",
      stage: "luna",
    });
  });

  it("waits rather than waking again while the canonical card has a live reviewer run", () => {
    expect(decideNativeReviewRecovery(prRecoveryInput([prCard], [
      { id: "live-luna", agentId: "luna-1", status: "running", issueId: "issue-1", interactionId: "pr-card" },
    ]))).toEqual({ action: "await_run", interactionId: "pr-card", runId: "live-luna" });
  });

  it("waits for Paperclip while the original card is inside the dispatch grace period", () => {
    expect(decideNativeReviewRecovery({
      ...prRecoveryInput([prCard]),
      nowMs: Date.parse("2026-09-15T18:00:30.000Z"),
    })).toEqual({ action: "await_native_dispatch", interactionId: "pr-card" });
  });

  it("recovers dispatch for an overdue original card without relying on issue assignment", () => {
    expect(decideNativeReviewRecovery({
      ...prRecoveryInput([prCard]),
      issueAssigneeAgentId: "luna-1",
    })).toMatchObject({ action: "recover_dispatch", interactionId: "pr-card", reviewerAgentId: "luna-1", stage: "luna" });
  });

  it("recovers dispatch on the same replacement card when it remains orphaned", () => {
    expect(decideNativeReviewRecovery(prRecoveryInput([{
      ...prCard,
      id: "pr-card-attempt-1",
      idempotencyKey: `${prCard.idempotencyKey}:attempt:1`,
    }]))).toEqual({
      action: "recover_dispatch",
      interactionId: "pr-card-attempt-1",
      reviewerAgentId: "luna-1",
      stage: "luna",
      immutableKey: `${prCard.idempotencyKey}:attempt:1`,
    });
  });

  it("reuses the card after a graceful-shutdown interruption without reading reviewer prose", () => {
    expect(decideNativeReviewRecovery(prRecoveryInput([prCard], [
      { id: "shutdown-luna", agentId: "luna-1", status: "interrupted", issueId: "issue-1", interactionId: "pr-card" },
    ]))).toEqual({
      action: "replace_card",
      interactionId: "pr-card",
      reviewerAgentId: "luna-1",
      failedRunId: "shutdown-luna",
      stage: "luna",
      nextAttempt: 1,
      cause: "terminal_run",
      withdrawInteractionIds: [],
    });
  });

  it("does not repair a plan card without a PR card for the immutable head", () => {
    expect(decideNativeReviewRecovery(prRecoveryInput([stalePlanCard as typeof prCard]))).toEqual({ action: "no_action" });
  });

  it("refuses to repair an ambiguous set of current PR cards", () => {
    expect(decideNativeReviewRecovery(prRecoveryInput([prCard, { ...prCard, id: "other-pr-card" }]))).toEqual({
      action: "protocol_failure",
      reason: "multiple_pending_canonical_pr_cards",
    });
  });

  it("recovers one overdue Terra Jules plan card without changing its Jules ownership", () => {
    expect(decideJulesPlanNativeReviewRecovery(planRecoveryInput([terraPlanCard]))).toEqual({
      action: "recover",
      interactionId: "terra-plan-card",
      reviewerAgentId: "terra-1",
      recoveryRunId: undefined,
    });
  });

  it("ignores an unbound reviewer run when deciding recovery for the typed Terra card", () => {
    expect(decideJulesPlanNativeReviewRecovery(planRecoveryInput([terraPlanCard], [{
      id: "terra-run",
      agentId: "terra-1",
      status: "running",
      issueId: "issue-1",
    }]))).toEqual({
      action: "recover",
      interactionId: "terra-plan-card",
      reviewerAgentId: "terra-1",
      recoveryRunId: undefined,
    });
  });

  it("fails closed for an ambiguous Jules plan ladder", () => {
    expect(decideJulesPlanNativeReviewRecovery(planRecoveryInput([stalePlanCard, terraPlanCard]))).toEqual({
      action: "protocol_failure",
      reason: "multiple_pending_canonical_jules_plan_cards",
    });
  });

  it("does not dispatch a newly-created plan card during Paperclip's native-dispatch grace period", () => {
    expect(decideJulesPlanNativeReviewRecovery({
      ...planRecoveryInput([terraPlanCard]),
      nowMs: Date.parse("2026-09-15T18:00:30.000Z"),
    })).toEqual({ action: "no_action" });
  });

  it("stops automatic Jules plan recovery after two terminal reviewer attempts", () => {
    expect(decideJulesPlanNativeReviewRecovery(planRecoveryInput([terraPlanCard], [
      { id: "terra-failed-1", agentId: "terra-1", status: "failed", issueId: "issue-1", interactionId: "terra-plan-card" },
      { id: "terra-failed-2", agentId: "terra-1", status: "timed_out", issueId: "issue-1", interactionId: "terra-plan-card" },
    ]))).toEqual({ action: "retry_exhausted", interactionId: "terra-plan-card" });
  });
});
