import { describe, expect, it } from "vitest";
import { nativePlanReviewStageId } from "@pilleo/paperclip-adapter-common";
import {
  decideNativePlanReviewLifecycle,
  type NativePlanReviewLifecycleInput,
  type NativePlanReviewAction,
} from "../src/server/native-plan-review-lifecycle.js";

const NOW = Date.parse("2026-09-19T18:00:00.000Z");
const identity = {
  childIssueId: "child-1",
  interactionId: "card-1",
  reviewerAgentId: "luna-1",
  immutableKey: "jules:plan-review:v2:issue-1:session-1:revision-1:luna",
} as const;

function input(
  overrides: Partial<NativePlanReviewLifecycleInput> = {},
): NativePlanReviewLifecycleInput {
  return {
    identity,
    childStatus: "todo",
    card: {
      id: "card-1",
      kind: "request_item_verdicts",
      status: "pending",
      addresseeAgentId: "luna-1",
      idempotencyKey: identity.immutableKey,
      createdAt: "2026-09-19T17:55:00.000Z",
    },
    runs: [],
    nowMs: NOW,
    graceMs: 60_000,
    maxRecoveryAttempts: 1,
    ...overrides,
  };
}

describe("native plan review lifecycle", () => {
  it.each<{
    name: string;
    input: NativePlanReviewLifecycleInput;
    expected: NativePlanReviewAction;
  }>([
    {
      name: "creates a card when no canonical card exists",
      input: input({ card: null }),
      expected: { action: "create_card" },
    },
    {
      name: "recovers dispatch on one overdue pending card that has never had a bound run",
      input: input(),
      expected: {
        action: "recover_dispatch",
        interactionId: "card-1",
        reviewerAgentId: "luna-1",
        immutableKey: identity.immutableKey,
        attempt: 0,
      },
    },
    {
      name: "awaits a queued bound run",
      input: input({ runs: [{ id: "run-1", status: "queued", issueId: "child-1", agentId: "luna-1", interactionId: "card-1", interactionKind: "request_item_verdicts", startedAt: null, finishedAt: null }] }),
      expected: { action: "await_run", runId: "run-1" },
    },
    {
      name: "awaits a running bound run",
      input: input({ runs: [{ id: "run-1", status: "running", issueId: "child-1", agentId: "luna-1", interactionId: "card-1", interactionKind: "request_item_verdicts", startedAt: "2026-09-19T17:59:00.000Z", finishedAt: null }] }),
      expected: { action: "await_run", runId: "run-1" },
    },
    {
      name: "awaits an exact native-stage reviewer run without card-bound context",
      input: input({
        identity: { ...identity, childIssueId: "issue-1" }, childStatus: "in_review",
        runs: [{ id: "stage-run-1", status: "running", issueId: "issue-1", agentId: "luna-1",
          interactionId: null, interactionKind: null,
          stageId: nativePlanReviewStageId("issue-1", "revision-1", "luna"), stageType: "review", wakeRole: "reviewer",
          currentParticipantAgentId: "luna-1", returnAssigneeAgentId: "jules-1",
          startedAt: "2026-09-19T17:59:00.000Z", finishedAt: null }],
      }),
      expected: { action: "await_run", runId: "stage-run-1" },
    },
    {
      name: "refuses to associate a different native stage with this card",
      input: input({
        identity: { ...identity, childIssueId: "issue-1" }, childStatus: "in_review",
        runs: [{ id: "wrong-stage-run", status: "running", issueId: "issue-1", agentId: "luna-1",
          interactionId: null, interactionKind: null, stageId: "foreign-stage", stageType: "review", wakeRole: "reviewer",
          currentParticipantAgentId: "luna-1", returnAssigneeAgentId: "jules-1",
          startedAt: "2026-09-19T17:59:00.000Z", finishedAt: null }],
      }),
      expected: { action: "escalate_protocol_failure", reason: "invalid_run_evidence" },
    },
    {
      name: "awaits a verdict after a successful bound run",
      input: input({ runs: [{ id: "run-1", status: "succeeded", issueId: "child-1", agentId: "luna-1", interactionId: "card-1", interactionKind: "request_item_verdicts", startedAt: "2026-09-19T17:58:00.000Z", finishedAt: "2026-09-19T17:59:00.000Z" }] }),
      expected: { action: "await_verdict", runId: "run-1" },
    },
    {
      name: "ignores a failed unbound automatic wake and recovers dispatch on the canonical card",
      input: input({ runs: [{ id: "run-unbound", status: "failed", issueId: "child-1", agentId: "luna-1", interactionId: null, interactionKind: null, startedAt: "2026-09-19T17:58:00.000Z", finishedAt: "2026-09-19T17:58:01.000Z", error: "continuation_source_context_missing" }] }),
      expected: {
        action: "recover_dispatch",
        interactionId: "card-1",
        reviewerAgentId: "luna-1",
        immutableKey: identity.immutableKey,
        attempt: 0,
      },
    },
    {
      name: "replaces the card after one failed bound run",
      input: input({ runs: [{ id: "run-1", status: "failed", issueId: "child-1", agentId: "luna-1", interactionId: "card-1", interactionKind: "request_item_verdicts", startedAt: "2026-09-19T17:58:00.000Z", finishedAt: "2026-09-19T17:58:01.000Z", error: "transport_error" }] }),
      expected: { action: "replace_card", interactionId: "card-1", nextAttempt: 1, cause: "terminal_run", failedRunId: "run-1" },
    },
    {
      name: "recovers same-card dispatch after pre-start assignee-change cancellation",
      input: input({ runs: [{ id: "run-1", status: "cancelled", issueId: "child-1", agentId: "luna-1", interactionId: "card-1", interactionKind: "request_item_verdicts", startedAt: null, finishedAt: "2026-09-21T17:27:47.341Z", errorCode: "issue_assignee_changed" }] }),
      expected: {
        action: "recover_dispatch",
        interactionId: "card-1",
        reviewerAgentId: "luna-1",
        immutableKey: identity.immutableKey,
        attempt: 0,
      },
    },
    {
      name: "consumes an answered canonical card",
      input: input({ card: { id: "card-1", kind: "request_item_verdicts", status: "answered", addresseeAgentId: "luna-1", idempotencyKey: identity.immutableKey, createdAt: "2026-09-19T17:55:00.000Z" } }),
      expected: { action: "consume_verdict", interactionId: "card-1" },
    },
    {
      name: "fails closed when the card belongs to another reviewer",
      input: input({ card: { id: "card-1", kind: "request_item_verdicts", status: "pending", addresseeAgentId: "terra-1", idempotencyKey: identity.immutableKey, createdAt: "2026-09-19T17:55:00.000Z" } }),
      expected: { action: "escalate_protocol_failure", reason: "card_identity_mismatch" },
    },
    {
      name: "fails closed when duplicate canonical cards exist",
      input: input({
        card: {
          duplicate: [
            { id: "card-1", kind: "request_item_verdicts", status: "pending", addresseeAgentId: "luna-1", idempotencyKey: identity.immutableKey, createdAt: "2026-09-19T17:55:00.000Z" },
            { id: "card-2", kind: "request_item_verdicts", status: "pending", addresseeAgentId: "luna-1", idempotencyKey: identity.immutableKey, createdAt: "2026-09-19T17:55:00.000Z" },
          ],
        },
      }),
      expected: { action: "escalate_protocol_failure", reason: "ambiguous_canonical_card" },
    },
    {
      name: "fails closed on malformed run evidence",
      input: input({ runs: [{ id: "run-1", status: "running", agentId: "luna-1" }] }),
      expected: { action: "escalate_protocol_failure", reason: "invalid_run_evidence" },
    },
    {
      name: "recovers dispatch when the replacement generation is also orphaned",
      input: input({
        identity: { ...identity, immutableKey: `${identity.immutableKey}:recovery:1` },
        card: {
          id: "card-1", kind: "request_item_verdicts", status: "pending", addresseeAgentId: "luna-1",
          idempotencyKey: `${identity.immutableKey}:recovery:1`, createdAt: "2026-09-19T17:55:00.000Z",
        },
      }),
      expected: {
        action: "recover_dispatch",
        interactionId: "card-1",
        reviewerAgentId: "luna-1",
        immutableKey: `${identity.immutableKey}:recovery:1`,
        attempt: 1,
      },
    },
    {
      name: "waits during the host dispatch grace period",
      input: input({
        card: {
          id: "card-1", kind: "request_item_verdicts", status: "pending", addresseeAgentId: "luna-1",
          idempotencyKey: identity.immutableKey, createdAt: "2026-09-19T17:59:30.000Z",
        },
      }),
      expected: { action: "await_native_dispatch" },
    },
  ])("$name", ({ input: lifecycleInput, expected }) => {
    expect(decideNativePlanReviewLifecycle(lifecycleInput)).toEqual(expected);
  });
});
