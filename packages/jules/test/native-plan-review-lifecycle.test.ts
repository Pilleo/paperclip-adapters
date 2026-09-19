import { describe, expect, it } from "vitest";
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
    },
    runs: [],
    nowMs: NOW,
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
      name: "wakes one pending card that has never had a bound run",
      input: input(),
      expected: { action: "wake_card", interactionId: "card-1" },
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
      name: "awaits a verdict after a successful bound run",
      input: input({ runs: [{ id: "run-1", status: "succeeded", issueId: "child-1", agentId: "luna-1", interactionId: "card-1", interactionKind: "request_item_verdicts", startedAt: "2026-09-19T17:58:00.000Z", finishedAt: "2026-09-19T17:59:00.000Z" }] }),
      expected: { action: "await_verdict", runId: "run-1" },
    },
    {
      name: "ignores a failed unbound automatic wake and starts the canonical card",
      input: input({ runs: [{ id: "run-unbound", status: "failed", issueId: "child-1", agentId: "luna-1", interactionId: null, interactionKind: null, startedAt: "2026-09-19T17:58:00.000Z", finishedAt: "2026-09-19T17:58:01.000Z", error: "continuation_source_context_missing" }] }),
      expected: { action: "wake_card", interactionId: "card-1" },
    },
    {
      name: "recovers the same card after one failed bound run",
      input: input({ runs: [{ id: "run-1", status: "failed", issueId: "child-1", agentId: "luna-1", interactionId: "card-1", interactionKind: "request_item_verdicts", startedAt: "2026-09-19T17:58:00.000Z", finishedAt: "2026-09-19T17:58:01.000Z", error: "transport_error" }] }),
      expected: { action: "recover_card", interactionId: "card-1", failedRunId: "run-1", attempt: 1 },
    },
    {
      name: "consumes an answered canonical card",
      input: input({ card: { id: "card-1", kind: "request_item_verdicts", status: "answered", addresseeAgentId: "luna-1" } }),
      expected: { action: "consume_verdict", interactionId: "card-1" },
    },
    {
      name: "fails closed when the card belongs to another reviewer",
      input: input({ card: { id: "card-1", kind: "request_item_verdicts", status: "pending", addresseeAgentId: "terra-1" } }),
      expected: { action: "escalate_protocol_failure", reason: "card_identity_mismatch" },
    },
    {
      name: "fails closed when duplicate canonical cards exist",
      input: input({
        card: {
          duplicate: [
            { id: "card-1", kind: "request_item_verdicts", status: "pending", addresseeAgentId: "luna-1" },
            { id: "card-2", kind: "request_item_verdicts", status: "pending", addresseeAgentId: "luna-1" },
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
      name: "stops after the recovery budget is exhausted",
      input: input({
        runs: [
          { id: "run-1", status: "failed", issueId: "child-1", agentId: "luna-1", interactionId: "card-1", interactionKind: "request_item_verdicts", startedAt: "2026-09-19T17:56:00.000Z", finishedAt: "2026-09-19T17:56:01.000Z", error: "transport_error" },
          { id: "run-2", status: "failed", issueId: "child-1", agentId: "luna-1", interactionId: "card-1", interactionKind: "request_item_verdicts", startedAt: "2026-09-19T17:58:00.000Z", finishedAt: "2026-09-19T17:58:01.000Z", error: "transport_error" },
        ],
      }),
      expected: { action: "escalate_protocol_failure", reason: "recovery_budget_exhausted" },
    },
  ])("$name", ({ input: lifecycleInput, expected }) => {
    expect(decideNativePlanReviewLifecycle(lifecycleInput)).toEqual(expected);
  });
});
