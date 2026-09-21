import { describe, expect, it } from "vitest";
import {
  parsePlanReviewIdempotencyKey,
  planReviewIdempotencyKey,
  projectEffectAttempt,
} from "../src/jules-plan-review-identity.js";

describe("Jules native plan-review identity", () => {
  it("round-trips the primary and one bounded recovery generation", () => {
    const primary = {
      issueId: "issue-985", sessionId: "session-985", revisionId: "revision-29",
      stage: "luna" as const, generation: 0 as const,
    };
    expect(planReviewIdempotencyKey(primary)).toBe(
      "jules:plan-review:v2:issue-985:session-985:revision-29:luna",
    );
    expect(parsePlanReviewIdempotencyKey(
      "jules:plan-review:v2:issue-985:session-985:revision-29:luna:recovery:1",
    )).toEqual({ ...primary, generation: 1 });
  });

  it.each([
    [undefined, { kind: "not_started" }],
    [{ effectId: "card:terra:revision-29", attempt: { kind: "started", startedAt: "2026-09-20T00:00:00.000Z" } }, { kind: "started", effectId: "card:terra:revision-29", startedAt: "2026-09-20T00:00:00.000Z" }],
    [{ effectId: "card:terra:revision-29", attempt: { kind: "confirmed", receipt: "card-terra" } }, { kind: "confirmed", effectId: "card:terra:revision-29", receipt: "card-terra" }],
  ] as const)("projects durable journal evidence %#", (entry, expected) => {
    expect(projectEffectAttempt("card:terra:revision-29", entry)).toEqual(expected);
  });
});
