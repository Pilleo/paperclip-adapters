import { describe, expect, it } from "vitest";
import { resolvedJulesPlanVerdict } from "../src/core/jules-plan-verdict-continuation.js";

const parentId = "parent-1450";
const sessionId = "18097790208000457615";
const revisionId = "64eb2176-f2a6-472a-943a-ce3b51666b23";

function card(overrides: Record<string, unknown> = {}) {
  return {
    id: "plan-card",
    kind: "request_item_verdicts",
    status: "answered",
    idempotencyKey: `jules:plan-review:v2:${parentId}:${sessionId}:${revisionId}:luna:recovery:1`,
    payload: {
      target: {
        type: "issue_document",
        issueId: parentId,
        key: "plan",
        revisionId,
      },
    },
    ...overrides,
  };
}

describe("resolved Jules native plan verdict", () => {
  it("accepts only an answered v2 verdict bound to this parent, session, and plan revision", () => {
    expect(resolvedJulesPlanVerdict({
      parentId,
      parentSessionId: sessionId,
      currentRevisionId: revisionId,
      interactions: [card()],
    })).toEqual({
      interactionId: "plan-card",
      sessionId,
      revisionId,
    });
  });

  it("rejects an answered card for a superseded plan revision", () => {
    expect(resolvedJulesPlanVerdict({
      parentId,
      parentSessionId: sessionId,
      currentRevisionId: "newer-revision",
      interactions: [card()],
    })).toBeNull();
  });

  it.each([
    ["pending", card({ status: "pending" })],
    ["comment", card({ kind: "comment" })],
    ["another parent", card({ idempotencyKey: `jules:plan-review:v2:other:${sessionId}:${revisionId}:luna` })],
    ["another session", card({ idempotencyKey: `jules:plan-review:v2:${parentId}:other:${revisionId}:luna` })],
    ["wrong target", card({ payload: { target: { type: "issue_document", issueId: "other", key: "plan", revisionId } } })],
    ["wrong revision", card({ payload: { target: { type: "issue_document", issueId: parentId, key: "plan", revisionId: "other" } } })],
  ])("rejects %s", (_name, interaction) => {
    expect(resolvedJulesPlanVerdict({
      parentId,
      parentSessionId: sessionId,
      currentRevisionId: revisionId,
      interactions: [interaction],
    })).toBeNull();
  });
});
