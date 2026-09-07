import { describe, expect, it } from "vitest";
import { decidePlanGateRecovery, recoverMissingPlanGatePointer } from "../src/server/plan-gate-state.js";

describe("decidePlanGateRecovery", () => {
  it.each([
    ["PR rejection supersession", "Superseded by structured PR rejection for the same Jules session and immutable PR head.", "restore"],
    ["PR-card authority supersession", "Superseded plan-review card: an immutable matching PR review card is the active native review authority.", "restore"],
    ["user cancellation", "Cancelled by a board member.", "manual_recovery_required"],
    ["unknown system cancellation", "issue_assignee_changed", "manual_recovery_required"],
  ] as const)("%s is %s", (_name, cancellationReason, action) => {
    expect(decidePlanGateRecovery({
      providerState: "AWAITING_PLAN_APPROVAL",
      hasUnresolvedProviderQuestion: false,
      matchingInteraction: { status: "cancelled", cancellationReason },
    })).toEqual({ action });
  });

  it.each([
    ["provider is no longer awaiting approval", "IN_PROGRESS", false, { status: "cancelled", cancellationReason: "Superseded by structured PR rejection for the same Jules session and immutable PR head." }, "await_provider"],
    ["a newer Jules question exists", "AWAITING_PLAN_APPROVAL", true, { status: "cancelled", cancellationReason: "Superseded by structured PR rejection for the same Jules session and immutable PR head." }, "await_provider_question"],
    ["the exact card is still pending", "AWAITING_PLAN_APPROVAL", false, { status: "pending" }, "await_card"],
    ["no matching card was found", "AWAITING_PLAN_APPROVAL", false, undefined, "manual_recovery_required"],
  ] as const)("does not recreate when %s", (_name, providerState, hasUnresolvedProviderQuestion, matchingInteraction, action) => {
    expect(decidePlanGateRecovery({ providerState, hasUnresolvedProviderQuestion, matchingInteraction })).toEqual({ action });
  });
});

describe("recoverMissingPlanGatePointer", () => {
  it("recovers only one exact adapter-cancelled native card", () => {
    expect(recoverMissingPlanGatePointer({
      issueId: "issue-1", sessionId: "session-1", latestPlanActivityId: "activity-1",
      interactions: [{
        id: "card-1", status: "cancelled", kind: "request_item_verdicts", addresseeAgentId: "luna-1",
        idempotencyKey: "jules:plan-review:v2:issue-1:session-1:revision-1:luna",
        payload: { detailsMarkdown: "Plan text", target: { type: "issue_document", issueId: "issue-1", documentId: "doc-1", key: "plan", revisionId: "revision-1", revisionNumber: 1 } },
        result: { reason: "Superseded plan-review card: an immutable matching PR review card is the active native review authority." },
      }],
    })).toEqual({
      interactionId: "card-1", activityId: "activity-1", question: "Plan text", documentId: "doc-1", revisionId: "revision-1", revisionNumber: 1, reviewerAgentId: "luna-1", stage: "luna",
    });
  });

  it("refuses ambiguous or non-adapter cancellations", () => {
    const base = { id: "card-1", status: "cancelled", kind: "request_item_verdicts", addresseeAgentId: "luna-1", idempotencyKey: "jules:plan-review:v2:issue-1:session-1:revision-1:luna", payload: { detailsMarkdown: "Plan", target: { type: "issue_document", issueId: "issue-1", documentId: "doc-1", key: "plan", revisionId: "revision-1", revisionNumber: 1 } }, result: { reason: "Cancelled by a board member." } };
    expect(recoverMissingPlanGatePointer({ issueId: "issue-1", sessionId: "session-1", latestPlanActivityId: "activity-1", interactions: [base] })).toBeNull();
    const restoredReason = { reason: "Superseded plan-review card: an immutable matching PR review card is the active native review authority." };
    expect(recoverMissingPlanGatePointer({ issueId: "issue-1", sessionId: "session-1", latestPlanActivityId: "activity-1", interactions: [{ ...base, result: restoredReason }, { ...base, id: "card-2", result: restoredReason }] })).toBeNull();
  });
});
