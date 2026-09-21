import { describe, expect, it } from "vitest";
import { reconcileNativePlanEffect } from "../src/server/native-plan-effect-reconciler.js";

describe("reconcileNativePlanEffect", () => {
  it.each([
    [
      "confirms an exact parent-owned card",
      { kind: "create_card", reviewer: "terra", revisionId: "rev-1" },
      { card: { kind: "exact", cardId: "terra-card-1" } },
      { kind: "confirmed", receipt: "terra-card-1" },
    ],
    [
      "permits one card retry only after authoritative absence",
      { kind: "create_card", reviewer: "terra", revisionId: "rev-1" },
      { card: { kind: "absent" } },
      { kind: "retry_safe" },
    ],
    [
      "awaits provider observation when an interrupted approval leaves the exact plan pending",
      { kind: "approve_plan", sessionId: "session-1", revisionId: "rev-1" },
      { approval: { kind: "same_plan_pending" } },
      { kind: "await_observation" },
    ],
    [
      "confirms approval when the same session progressed",
      { kind: "approve_plan", sessionId: "session-1", revisionId: "rev-1" },
      { approval: { kind: "same_session_progressed", state: "IN_PROGRESS" } },
      { kind: "confirmed", receipt: "provider:IN_PROGRESS" },
    ],
    [
      "observes instead of retrying approval on a provider question",
      { kind: "approve_plan", sessionId: "session-1", revisionId: "rev-1" },
      { approval: { kind: "provider_question" } },
      { kind: "await_observation" },
    ],
    [
      "confirms a mirrored opaque revision marker",
      { kind: "request_plan_revision", cardId: "luna-card-1", revisionId: "rev-1", reviewer: "luna", runId: "run-1" },
      { revisionRequest: { kind: "marker_mirrored", activityId: "message-1" } },
      { kind: "confirmed", receipt: "message-1" },
    ],
    [
      "does not resend an unobserved revision marker",
      { kind: "request_plan_revision", cardId: "luna-card-1", revisionId: "rev-1", reviewer: "luna", runId: "run-1" },
      { revisionRequest: { kind: "marker_not_observed" } },
      { kind: "await_observation" },
    ],
  ] as const)("%s", (_name, effect, evidence, expected) => {
    expect(reconcileNativePlanEffect(effect, evidence)).toEqual(expected);
  });
});
