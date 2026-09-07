import { describe, expect, it } from "vitest";
import { parseWorkerFeedback, workerFeedbackPrompt } from "../src/worker-feedback.js";

const feedback = {
  version: 1 as const,
  kind: "code_review_rejection" as const,
  deliveryId: "delivery-1",
  issueId: "issue-1",
  reviewInteractionId: "interaction-1",
  reviewStage: "terra" as const,
  prUrl: "https://github.com/acme/repo/pull/1",
  headSha: "abc123",
  reason: "Cover the failure path.",
  createdAt: "2026-09-03T00:00:00.000Z",
};

describe("worker feedback protocol", () => {
  it("accepts a complete typed rejection envelope", () => {
    expect(parseWorkerFeedback(feedback)).toEqual(feedback);
  });

  it("rejects malformed or untrusted free-form payloads", () => {
    expect(parseWorkerFeedback({ reason: "please continue" })).toBeNull();
    expect(parseWorkerFeedback({ ...feedback, kind: "status_prompt" })).toBeNull();
  });

  it("renders actionable provider feedback", () => {
    expect(workerFeedbackPrompt(feedback)).toContain("Cover the failure path.");
    expect(workerFeedbackPrompt(feedback)).toContain(feedback.prUrl);
  });
});
