import { describe, expect, it } from "vitest";
import { buildReviewWaitState, isReviewWaitState, reviewWaitStateMatches } from "../src/core/review-wait-state.js";

describe("review wait state", () => {
  const input = { prUrl: "https://github.com/acme/repo/pull/1", headSha: "a".repeat(40), stage: "luna" as const, reviewerAgentId: "luna-1", reviewerStatus: "paused", reason: "reviewer status is paused", circuitKey: "review-card:issue:luna:sha:luna-1", now: "2026-09-03T00:00:00.000Z" };
  it("builds and validates a durable wait state", () => { const state = buildReviewWaitState(input); expect(isReviewWaitState(state)).toBe(true); expect(reviewWaitStateMatches(state, input)).toBe(true); });
  it("rejects a different PR identity", () => { const state = buildReviewWaitState(input); expect(reviewWaitStateMatches(state, { ...input, headSha: "b".repeat(40) })).toBe(false); expect(isReviewWaitState({ ...state, status: "pending" })).toBe(false); });
});
