import { describe, expect, it } from "vitest";
import { nativePlanReviewStageId } from "@pilleo/paperclip-adapter-common";
import { decideNativePlanReviewReconciliation } from "../src/core/native-plan-review-reconciliation.js";

const stageId = nativePlanReviewStageId("issue", "revision", "luna");
function evidence() {
  return {
    companyId: "company", issueId: "issue", ownerId: "jules", reviewerId: "luna", sessionId: "session",
    issue: { id: "issue", companyId: "company", status: "in_review", assigneeAgentId: "luna",
      executionRunId: null, executionBlocker: null,
      executionPolicy: { mode: "normal", stages: [{ id: stageId, type: "review", participants: [{ type: "agent", agentId: "luna" }] }] },
      executionState: { status: "pending", currentStageId: stageId, currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "luna" }, returnAssignee: { type: "agent", agentId: "jules" } } },
    document: { id: "document", latestRevisionId: "revision", latestRevisionNumber: 1 },
    cards: [{ id: "card", companyId: "company", issueId: "issue", kind: "request_item_verdicts", status: "answered",
      addresseeAgentId: "luna", resolvedByAgentId: "luna", resolvedByRunId: "review-run", sourceRunId: "source-run",
      idempotencyKey: "jules:plan-review:v2:issue:session:revision:luna",
      payload: { target: { type: "issue_document", issueId: "issue", key: "plan", documentId: "document", revisionId: "revision", revisionNumber: 1 } },
      result: { outcome: "resolved", complete: true, items: [{ id: "plan", verdict: "approve" }] } }],
    sourceRun: { id: "source-run", companyId: "company", agentId: "jules", contextSnapshot: { issueId: "issue" } },
    runs: [{ id: "review-run", companyId: "company", agentId: "luna", status: "succeeded",
      contextSnapshot: { issueId: "issue", interactionId: "card" } }],
    runsComplete: true,
  };
}

describe("settled native plan review reconciliation", () => {
  it("returns ownership only for a settled attributed verdict and exact stage", () => {
    expect(decideNativePlanReviewReconciliation(evidence())).toEqual({
      kind: "return_to_jules", interactionId: "card", ownerId: "jules", stageId,
    });
  });

  it.each(["running", "queued", "scheduled"])("waits for a %s reviewer run even when the card is answered", (status) => {
    const input = evidence();
    input.runs.push({ ...input.runs[0]!, id: "other-run", status });
    expect(decideNativePlanReviewReconciliation(input)).toEqual({ kind: "await_reviewer_settlement" });
  });

  it.each(["failed", "cancelled", "timed_out"])("does not clear recovery state after a %s verdict run", (status) => {
    const input = evidence();
    input.runs[0]!.status = status;
    expect(decideNativePlanReviewReconciliation(input).kind).toBe("conflict");
  });

  it("does not treat incomplete run lists as settled evidence", () => {
    expect(decideNativePlanReviewReconciliation({ ...evidence(), runsComplete: false }).kind).toBe("conflict");
  });

  it("waits for a pending typed card", () => {
    const input = evidence(); input.cards[0]!.status = "pending";
    expect(decideNativePlanReviewReconciliation(input)).toEqual({ kind: "await_verdict" });
  });

  it("rejects duplicate cards for the same turn", () => {
    const input = evidence(); input.cards.push({ ...input.cards[0]!, id: "duplicate" });
    expect(decideNativePlanReviewReconciliation(input).kind).toBe("conflict");
  });

  it.each(["companyId", "resolvedByAgentId", "resolvedByRunId"])("rejects changed card %s", (field) => {
    const input = evidence(); Object.assign(input.cards[0]!, { [field]: "wrong" });
    expect(decideNativePlanReviewReconciliation(input).kind).toBe("conflict");
  });

  it("rejects a newer plan document", () => {
    const input = evidence(); input.document.latestRevisionId = "new-revision";
    expect(decideNativePlanReviewReconciliation(input).kind).toBe("conflict");
  });

  it("preserves a foreign review policy", () => {
    const input = evidence(); input.issue.executionPolicy.stages[0]!.id = "foreign";
    expect(decideNativePlanReviewReconciliation(input).kind).toBe("conflict");
  });

  it("accepts exact host stage provenance without inventing a card-bound run", () => {
    const input = evidence();
    const runs = [{ ...input.runs[0], contextSnapshot: { issueId: "issue", executionStage: {
      stageId, stageType: "review", wakeRole: "reviewer",
      currentParticipant: { type: "agent", agentId: "luna" }, returnAssignee: { type: "agent", agentId: "jules" },
    } } }];
    expect(decideNativePlanReviewReconciliation({ ...input, runs }).kind).toBe("return_to_jules");
  });

  it("rejects an unrelated stage even with the correct reviewer identity", () => {
    const input = evidence();
    const runs = [{ ...input.runs[0], contextSnapshot: { issueId: "issue", executionStage: {
      stageId: "foreign", stageType: "review", wakeRole: "reviewer",
      currentParticipant: { type: "agent", agentId: "luna" }, returnAssignee: { type: "agent", agentId: "jules" },
    } } }];
    expect(decideNativePlanReviewReconciliation({ ...input, runs }).kind).toBe("conflict");
  });

  it("preserves an active execution recovery hold", () => {
    const input = evidence();
    expect(decideNativePlanReviewReconciliation({ ...input, issue: {
      ...input.issue, executionBlocker: { recoveryActionId: "hold" },
    } }).kind).toBe("conflict");
  });

  it("refuses to clear an unrelated monitor during stage handback", () => {
    const input = evidence();
    expect(decideNativePlanReviewReconciliation({ ...input, issue: {
      ...input.issue, executionPolicy: { ...input.issue.executionPolicy, monitor: { serviceName: "other" } },
    } }).kind).toBe("conflict");
  });

  it("does not assume returned ownership means Jules has resumed", () => {
    const input = evidence();
    const issue = { ...input.issue, status: "in_progress", assigneeAgentId: "jules", executionPolicy: null, executionState: null };
    expect(decideNativePlanReviewReconciliation({ ...input, issue })).toEqual({
      kind: "verify_jules_continuation", interactionId: "card", ownerId: "jules",
    });
  });
});
