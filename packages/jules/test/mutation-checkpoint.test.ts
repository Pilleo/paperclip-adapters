import { describe, expect, it } from "vitest";
import { beginMutation, markMutationFailed, markMutationSucceeded, shouldResumeMutation } from "../src/server/mutation-checkpoint.js";

describe("durable mutation checkpoints", () => {
  it("starts pending and preserves the deterministic identity", () => {
    const checkpoint = beginMutation({
      key: "jules:comment:issue-1:activity-1",
      operation: "mirror_activity",
      issueId: "issue-1",
      sessionId: "session-1",
      activityId: "activity-1",
      now: "2026-09-02T00:00:00.000Z",
    });
    expect(checkpoint).toMatchObject({ version: 1, key: "jules:comment:issue-1:activity-1", status: "pending" });
    expect(shouldResumeMutation(checkpoint)).toBe(true);
  });

  it("marks success and makes a restart a no-op", () => {
    const pending = beginMutation({ key: "k", operation: "comment", issueId: "i", now: "2026-09-02T00:00:00.000Z" });
    const succeeded = markMutationSucceeded(pending, { responseId: "comment-1", now: "2026-09-02T00:01:00.000Z" });
    expect(succeeded).toMatchObject({ status: "succeeded", responseId: "comment-1", error: undefined });
    expect(shouldResumeMutation(succeeded)).toBe(false);
  });

  it("keeps transient failure resumable and records a useful error", () => {
    const pending = beginMutation({ key: "k", operation: "monitor", issueId: "i", now: "2026-09-02T00:00:00.000Z" });
    const failed = markMutationFailed(pending, "  Paperclip unavailable  ", "2026-09-02T00:01:00.000Z");
    expect(failed).toMatchObject({ status: "failed", error: "Paperclip unavailable" });
    expect(shouldResumeMutation(failed)).toBe(true);
  });
});
