import { describe, expect, it } from "vitest";
import { buildGitHubRevisionMonitor, isGitHubRevisionHandoffMonitor } from "../src/core/implementation-handoff-monitor.js";

describe("GitHub revision handoff monitor", () => {
  it("creates one bounded native monitor for the immutable revision epoch", () => {
    expect(buildGitHubRevisionMonitor({
      issueId: "issue-1241",
      pullRequestUrl: "https://github.com/Pilleo/paperclip-adapters/pull/7",
      headSha: "abc123",
      feedbackId: "card-1",
      now: Date.parse("2026-09-08T12:00:00.000Z"),
    })).toEqual({
      mode: "normal",
      stages: [],
      monitor: {
        nextCheckAt: "2026-09-08T12:15:00.000Z",
        timeoutAt: "2026-09-08T16:00:00.000Z",
        notes: "Await GitHub PR revision for issue-1241 at abc123 after structured feedback card-1.",
        scheduledBy: "board",
        kind: "external_service",
        serviceName: "github",
        externalRef: "https://github.com/Pilleo/paperclip-adapters/pull/7",
        recoveryPolicy: "wake_owner",
        maxAttempts: 1,
      },
    });
  });
});

describe("isGitHubRevisionHandoffMonitor", () => {
  it("recognizes only the typed GitHub revision monitor", () => {
    expect(isGitHubRevisionHandoffMonitor(buildGitHubRevisionMonitor({
      issueId: "issue-1",
      pullRequestUrl: "https://github.com/acme/repo/pull/1",
      headSha: "head-1",
      feedbackId: "feedback-1",
      now: Date.parse("2026-09-08T12:00:00.000Z"),
    }))).toBe(true);
    expect(isGitHubRevisionHandoffMonitor({ mode: "normal", stages: [] })).toBe(false);
  });
});
