import { describe, expect, it } from "vitest";
import {
  parsePlanReviewInteraction,
  reducePlanReview,
  type PlanReviewIdentity,
} from "../src/server/plan-review-protocol.js";

const identity: PlanReviewIdentity = {
  issueId: "issue-985",
  sessionId: "session-985",
  documentId: "document-985",
  revisionId: "revision-29",
  revisionNumber: 29,
  stage: "luna",
  reviewerAgentId: "luna-1",
};

function v2Card(overrides: Record<string, unknown> = {}) {
  return {
    id: "card-v2",
    kind: "request_item_verdicts",
    status: "pending",
    addresseeAgentId: "luna-1",
    idempotencyKey: "jules:plan-review:v2:issue-985:session-985:revision-29:luna",
    payload: {
      items: [{ id: "plan", label: "Plan" }],
      target: {
        type: "issue_document",
        issueId: "issue-985",
        documentId: "document-985",
        key: "plan",
        revisionId: "revision-29",
        revisionNumber: 29,
      },
    },
    ...overrides,
  };
}

describe("typed Jules plan-review protocol", () => {
  it.each([
    ["foreign issue", { ...v2Card(), payload: { ...v2Card().payload, target: { ...v2Card().payload.target, issueId: "other" } } }],
    ["wrong item", { ...v2Card(), payload: { ...v2Card().payload, items: [{ id: "pull_request" }] } }],
    ["wrong stage key", { ...v2Card(), idempotencyKey: "jules:plan-review:v2:issue-985:session-985:revision-29:terra" }],
    ["legacy confirmation", { ...v2Card(), kind: "request_confirmation", idempotencyKey: "jules:plan-review:v1:issue-985:session-985:revision-29:luna" }],
  ] as const)("does not accept %s as a v2 card", (_label, raw) => {
    expect(parsePlanReviewInteraction(raw, identity)).not.toMatchObject({ kind: "v2" });
  });

  it("parses only the exact addressed v2 pending card", () => {
    expect(parsePlanReviewInteraction(v2Card(), identity)).toMatchObject({
      kind: "v2",
      state: "pending",
      interactionId: "card-v2",
      identity,
    });
  });

  it.each([
    ["first bounded recovery", "jules:plan-review:v2:issue-985:session-985:revision-29:luna:recovery:1", true],
    ["non-numeric recovery suffix", "jules:plan-review:v2:issue-985:session-985:revision-29:luna:recovery:one", false],
    ["zero recovery suffix", "jules:plan-review:v2:issue-985:session-985:revision-29:luna:recovery:0", false],
  ])("%s is accepted only when it is a bounded recovery key", (_label, idempotencyKey, accepted) => {
    const observation = parsePlanReviewInteraction(v2Card({ idempotencyKey }), identity);
    expect(observation.kind === "v2").toBe(accepted);
  });

  it("accepts only a complete verdict for the declared plan item", () => {
    const card = v2Card({
      status: "answered",
      result: { outcome: "resolved", complete: true, items: [{ id: "plan", verdict: "approve" }] },
    });
    expect(parsePlanReviewInteraction(card, identity)).toMatchObject({
      kind: "v2",
      state: "answered",
      decision: { kind: "approve" },
    });
  });

  it.each([
    ["missing reason", { outcome: "resolved", complete: true, items: [{ id: "plan", verdict: "reject" }] }],
    ["wrong item", { outcome: "resolved", complete: true, items: [{ id: "pull_request", verdict: "approve" }] }],
    ["partial result", { outcome: "resolved", complete: false, items: [{ id: "plan", verdict: "approve" }] }],
  ] as const)("does not turn %s into a decision", (_label, result) => {
    expect(parsePlanReviewInteraction(v2Card({ status: "answered", result }), identity)).toMatchObject({
      kind: "unrecognized",
    });
  });

  it.each([
    ["pending legacy", "legacy_pending", "migrate_legacy"],
    ["pending v2", "v2_pending", "await"],
    ["Luna approval", "luna_approved", "create_terra"],
    ["Terra approval", "terra_approved", "approve_jules"],
    ["rejection", "rejected", "request_revision"],
  ] as const)("maps %s to one exhaustive effect", (_label, cardState, effect) => {
    expect(reducePlanReview({ identity, state: cardState })).toMatchObject({ effect });
  });

  it("does not emit an effect for malformed or foreign observations", () => {
    expect(reducePlanReview({ identity, state: "unrecognized" })).toEqual({ effect: "await", reason: "unrecognized_card" });
  });
});
