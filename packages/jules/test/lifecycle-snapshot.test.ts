import { describe, expect, it } from "vitest";
import { interactionFromResponse } from "../src/server/paperclip-client.js";
import { buildJulesLifecycleSnapshot } from "../src/server/lifecycle-snapshot.js";

function rawPlanCard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "card-1",
    status: "answered",
    kind: "request_item_verdicts",
    idempotencyKey: "jules:plan-review:v2:issue-1:session-1:rev-1:luna",
    addresseeAgentId: "luna-1",
    payload: {
      providerActivityId: "activity-1",
      target: {
        type: "issue_document",
        issueId: "issue-1",
        key: "plan",
        documentId: "document-1",
        revisionId: "rev-1",
        revisionNumber: 1,
      },
    },
    result: { verdicts: [{ id: "plan", verdict: "reject" }] },
    ...overrides,
  };
}

describe("Jules lifecycle snapshot", () => {
  it("accepts a local-board resolution only when the exact reviewer run is retained", () => {
    const interaction = interactionFromResponse(rawPlanCard({
      resolvedByUserId: "local-board",
      resolvedByRunId: "run-luna-1",
    }), 200);

    expect(buildJulesLifecycleSnapshot({
      issueId: "issue-1",
      sessionId: "session-1",
      latestPlanActivityIds: ["activity-1"],
      interactions: [interaction],
      reviewerRunIds: ["run-luna-1"],
    })).toEqual({
      kind: "valid",
      cardId: "card-1",
      revisionId: "rev-1",
      reviewer: "luna",
      providerActivityId: "activity-1",
    });
  });

  it("accepts a direct reviewer resolution without a local-board run", () => {
    const interaction = interactionFromResponse(rawPlanCard({ resolvedByAgentId: "luna-1" }), 200);

    expect(buildJulesLifecycleSnapshot({
      issueId: "issue-1",
      sessionId: "session-1",
      latestPlanActivityIds: ["activity-1"],
      interactions: [interaction],
      reviewerRunIds: [],
    })).toMatchObject({ kind: "valid", cardId: "card-1" });
  });

  it("migrates a legacy answered card only when one plan activity makes the binding unique", () => {
    const interaction = interactionFromResponse(rawPlanCard({
      payload: {
        target: {
          type: "issue_document", issueId: "issue-1", key: "plan",
          documentId: "document-1", revisionId: "rev-1", revisionNumber: 1,
        },
      },
      resolvedByAgentId: "luna-1",
    }), 200);

    expect(buildJulesLifecycleSnapshot({
      issueId: "issue-1", sessionId: "session-1", latestPlanActivityIds: ["activity-1"],
      interactions: [interaction], reviewerRunIds: [],
    })).toMatchObject({ kind: "legacy_unique", providerActivityId: "activity-1" });
  });

  it("fails closed when two provider activities could bind a legacy answered card", () => {
    const interaction = interactionFromResponse(rawPlanCard({
      payload: {
        target: {
          type: "issue_document", issueId: "issue-1", key: "plan",
          documentId: "document-1", revisionId: "rev-1", revisionNumber: 1,
        },
      },
      resolvedByAgentId: "luna-1",
    }), 200);

    expect(buildJulesLifecycleSnapshot({
      issueId: "issue-1", sessionId: "session-1", latestPlanActivityIds: ["activity-1", "activity-2"],
      interactions: [interaction], reviewerRunIds: [],
    })).toEqual({ kind: "inconsistent", reason: "legacy card has ambiguous provider activity identity" });
  });
});
