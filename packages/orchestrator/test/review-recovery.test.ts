import { describe, expect, it } from "vitest";
import { isSameReviewerUnavailableRecovery, reviewerUnavailableRecoveryPayload } from "../src/core/review-recovery.js";

describe("reviewer recovery action", () => {
  it("builds a stable, non-transcript recovery payload", () => {
    const payload = reviewerUnavailableRecoveryPayload({
      prUrl: "https://github.com/acme/repo/pull/1",
      headSha: "abc",
      stage: "luna",
      reviewerAgentId: "agent-1",
      reviewerStatus: "paused",
      reason: "paused",
      circuitKey: "review-card:issue:luna:abc:agent-1",
    });
    expect(payload.kind).toBe("reviewer_unavailable");
    expect(payload.fingerprint).toBe("review-card:issue:luna:abc:agent-1");
    expect(payload).not.toHaveProperty("transcript");
    expect(isSameReviewerUnavailableRecovery({ ...payload, status: "active" }, String(payload.fingerprint))).toBe(true);
    expect(isSameReviewerUnavailableRecovery({ ...payload, status: "resolved" }, String(payload.fingerprint))).toBe(false);
  });
});
