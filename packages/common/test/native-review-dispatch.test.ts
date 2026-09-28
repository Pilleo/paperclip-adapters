import { describe, expect, it } from "vitest";
import {
  buildNativeInteractionWakeRequest,
  decideNativeReviewDispatch,
  type NativeReviewDispatchInput,
  type NativeReviewDispatchDecision,
} from "../src/native-review-dispatch.js";

const NOW = Date.parse("2026-09-21T12:05:00.000Z");
const IDENTITY = {
  issueId: "issue-1",
  reviewerAgentId: "luna-1",
  immutableKey: "pr-review:v13:issue-1:repo:head:luna",
} as const;

function input(overrides: Partial<NativeReviewDispatchInput> = {}): NativeReviewDispatchInput {
  return {
    identity: IDENTITY,
    card: {
      id: "card-1",
      status: "pending",
      createdAt: "2026-09-21T12:00:00.000Z",
      reviewerAgentId: "luna-1",
      immutableKey: IDENTITY.immutableKey,
      attempt: 0,
    },
    runs: [],
    nowMs: NOW,
    graceMs: 60_000,
    maxReplacementAttempts: 1,
    ...overrides,
  };
}

function run(
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out" | "interrupted",
  overrides: Record<string, unknown> = {},
) {
  return {
    id: `run-${status}`,
    status,
    issueId: "issue-1",
    reviewerAgentId: "luna-1",
    interactionId: "card-1",
    startedAt: "2026-09-21T12:01:00.000Z",
    finishedAt: status === "queued" || status === "running" ? null : "2026-09-21T12:02:00.000Z",
    ...overrides,
  };
}

describe("native review dispatch state", () => {
  it("builds the only supported interaction-bound native wake contract", () => {
    expect(buildNativeInteractionWakeRequest({
      issueId: "issue-1551",
      reviewerAgentId: "luna-1",
      interactionId: "card-1551",
      reason: "native_review_dispatch_recovery",
    })).toEqual({
      path: "/api/agents/luna-1/wakeup",
      body: {
        source: "automation",
        triggerDetail: "system",
        reason: "native_review_dispatch_recovery",
        forceFreshSession: true,
        payload: {
          issueId: "issue-1551",
          mutation: "interaction",
          interactionId: "card-1551",
          interactionKind: "request_item_verdicts",
        },
      },
    });
  });

  it.each<{ name: string; value: NativeReviewDispatchInput; expected: NativeReviewDispatchDecision }>([
    {
      name: "waits during the host dispatch grace period",
      value: input({ nowMs: Date.parse("2026-09-21T12:00:30.000Z") }),
      expected: { action: "await_native_dispatch" },
    },
    {
      name: "waits for a queued bound run",
      value: input({ runs: [run("queued")] }),
      expected: { action: "await_run", runId: "run-queued" },
    },
    {
      name: "waits for a running bound run",
      value: input({ runs: [run("running")] }),
      expected: { action: "await_run", runId: "run-running" },
    },
    {
      name: "waits for a verdict after a successful bound run",
      value: input({ runs: [run("succeeded")] }),
      expected: { action: "await_verdict", runId: "run-succeeded" },
    },
    {
      name: "consumes an answered card",
      value: input({ card: { ...input().card, status: "answered" } }),
      expected: { action: "consume_verdict", interactionId: "card-1" },
    },
    {
      name: "recovers host dispatch for an overdue original card with no run",
      value: input(),
      expected: {
        action: "recover_dispatch",
        interactionId: "card-1",
        reviewerAgentId: "luna-1",
        immutableKey: IDENTITY.immutableKey,
        attempt: 0,
      },
    },
    {
      name: "recovers same-card dispatch after pre-start assignee-change cancellation",
      value: input({
        runs: [
          {
            id: "run-cancelled",
            status: "cancelled",
            issueId: "issue-1",
            reviewerAgentId: "luna-1",
            interactionId: "card-1",
            startedAt: null,
            finishedAt: "2026-09-21T17:27:47.341Z",
            stopReason: "issue_assignee_changed",
            errorCode: "issue_assignee_changed",
          },
        ],
      }),
      expected: {
        action: "recover_dispatch",
        interactionId: "card-1",
        reviewerAgentId: "luna-1",
        immutableKey: IDENTITY.immutableKey,
        attempt: 0,
      },
    },
    {
      name: "replaces the card after a terminal run",
      value: input({ runs: [run("failed")] }),
      expected: { action: "replace_card", interactionId: "card-1", nextAttempt: 1, cause: "terminal_run", failedRunId: "run-failed" },
    },
    {
      name: "recovers host dispatch for an overdue replacement card with no run",
      value: input({ card: { ...input().card, attempt: 1 } }),
      expected: {
        action: "recover_dispatch",
        interactionId: "card-1",
        reviewerAgentId: "luna-1",
        immutableKey: IDENTITY.immutableKey,
        attempt: 1,
      },
    },
    {
      name: "stops when a replacement has a terminal bound run",
      value: input({ card: { ...input().card, attempt: 1 }, runs: [run("failed")] }),
      expected: { action: "retry_exhausted", interactionId: "card-1", attempt: 1 },
    },
    {
      name: "fails closed for a reviewer mismatch",
      value: input({ card: { ...input().card, reviewerAgentId: "terra-1" } }),
      expected: { action: "protocol_failure", reason: "card_identity_mismatch" },
    },
    {
      name: "fails closed for an immutable identity mismatch",
      value: input({ card: { ...input().card, immutableKey: "other-head" } }),
      expected: { action: "protocol_failure", reason: "card_identity_mismatch" },
    },
    {
      name: "fails closed for an invalid creation time",
      value: input({ card: { ...input().card, createdAt: "not-a-date" } }),
      expected: { action: "protocol_failure", reason: "invalid_card_evidence" },
    },
    {
      name: "fails closed for a malformed replacement attempt",
      value: input({ card: { ...input().card, attempt: -1 } }),
      expected: { action: "protocol_failure", reason: "invalid_card_evidence" },
    },
    {
      name: "fails closed for a run not bound to the card",
      value: input({ runs: [run("running", { interactionId: "different-card" })] }),
      expected: { action: "protocol_failure", reason: "unbound_run_evidence" },
    },
    {
      name: "fails closed for two live runs on one card",
      value: input({ runs: [run("queued"), run("running")] }),
      expected: { action: "protocol_failure", reason: "multiple_live_runs" },
    },
  ])("$name", ({ value, expected }) => {
    expect(decideNativeReviewDispatch(value)).toEqual(expected);
  });
});
