import { describe, expect, it } from "vitest";
import {
  decideNativeReviewWake,
  decideJulesPlanNativeReviewRecovery,
  decideNativeReviewRecovery,
  nativeReviewRecoveryIssuePatch,
} from "../src/core/native-review-recovery-state.js";

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
  describe("final native-review wake decision", () => {
    const wakeInput = (patch: Record<string, unknown> = {}) => ({
      issueId: "issue-1",
      reviewerAgentId: "terra-1",
      nowMs: Date.parse("2026-09-15T18:02:00.000Z"),
      graceMs: 60_000,
      card: {
        ...terraPlanCard,
        createdAt: "2026-09-15T18:00:00.000Z",
      },
      reviewerRuns: [],
      ...patch,
    });

    it.each([
      [
        "the card was answered after the stale recovery snapshot",
        wakeInput({ card: { ...terraPlanCard, status: "answered" } }),
        { action: "answered" },
      ],
      [
        "Paperclip has already started the addressed reviewer",
        wakeInput({ reviewerRuns: [{ id: "terra-live", agentId: "terra-1", status: "running", issueId: "issue-1", interactionId: "terra-plan-card" }] }),
        { action: "await_run", runId: "terra-live" },
      ],
      [
        "the host native-dispatch grace window is still open",
        wakeInput({ nowMs: Date.parse("2026-09-15T18:00:30.000Z") }),
        { action: "await_native_dispatch" },
      ],
      [
        "the pending card has no native reviewer run after grace",
        wakeInput(),
        { action: "compatibility_wake", recoveryRunId: undefined },
      ],
    ])("%s", (_name, input, expected) => {
      expect(decideNativeReviewWake(input)).toEqual(expected);
    });
  });

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

  it("recovers a contract-scoped PR card and withdraws the stale Jules plan card", () => {
    expect(decideNativeReviewRecovery({
      issueId: "issue-1",
      issueStatus: "backlog",
      orchestratorManaged: true,
      prIdentity: { url: "https://github.com/acme/repo/pull/1", headSha: "head-1" },
      cards: [stalePlanCard, { ...prCard, idempotencyKey: `${prCard.idempotencyKey}:contract:170855u` }],
      reviewerRuns: [],
    })).toMatchObject({
      action: "restore_and_recover",
      interactionId: "pr-card",
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
    expect(nativeReviewRecoveryIssuePatch(decision)).toEqual({
      status: "in_review",
      assigneeAgentId: null,
      executionPolicy: null,
      executionState: null,
    });
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

  it("recovers one overdue Terra Jules plan card without changing its Jules ownership", () => {
    expect(decideJulesPlanNativeReviewRecovery(planRecoveryInput([terraPlanCard]))).toEqual({
      action: "recover",
      interactionId: "terra-plan-card",
      reviewerAgentId: "terra-1",
      recoveryRunId: undefined,
    });
  });

  it("waits for the one live unbound native reviewer run instead of waking a second Terra", () => {
    expect(decideJulesPlanNativeReviewRecovery(planRecoveryInput([terraPlanCard], [{
      id: "terra-run",
      agentId: "terra-1",
      status: "running",
      issueId: "issue-1",
    }]))).toEqual({ action: "await_run", interactionId: "terra-plan-card", runId: "terra-run" });
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
