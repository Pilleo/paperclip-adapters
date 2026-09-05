import { describe, expect, it } from "vitest";
import { selectJulesSupervisorActions } from "../src/core/jules-supervisor.js";

const now = Date.parse("2026-08-31T00:00:00.000Z");
const run = {
  id: "run-1", agentId: "jules-1", status: "succeeded", issueId: "issue-1",
  sessionIdBefore: "session-1", sessionIdAfter: "session-1", providerSessionId: "session-1",
  startedAt: new Date(now - 301_000).toISOString(), finishedAt: new Date(now - 300_001).toISOString(), retryNotBefore: null,
};

describe("Jules supervisor bridge", () => {
  it("returns the source run for an explicit, session-preserving resume", () => {
    expect(selectJulesSupervisorActions({
      issues: [{ id: "issue-1", status: "in_progress", assigneeAgentId: "jules-1" }],
      runs: [run], julesAgentId: "jules-1", now,
    })).toEqual([{ issueId: "issue-1", sessionId: "session-1", resumeFromRunId: "run-1", wake: true }]);
  });

  it("does not supervise a non-Jules or terminal issue", () => {
    expect(selectJulesSupervisorActions({
      issues: [{ id: "issue-1", status: "done", assigneeAgentId: "jules-1" }],
      runs: [run], julesAgentId: "jules-1", now,
    })).toEqual([]);
  });

  it("skips a sessionless scheduled retry and resumes from the newest session-bearing source run", () => {
    const source = {
      ...run,
      id: "source-run",
      finishedAt: new Date(now - 301_000).toISOString(),
    };
    expect(selectJulesSupervisorActions({
      issues: [{ id: "issue-1", status: "in_progress", assigneeAgentId: "jules-1" }],
      runs: [
        {
          ...source,
          id: "scheduled-retry",
          status: "scheduled_retry",
          sessionIdBefore: null,
          sessionIdAfter: null,
          providerSessionId: null,
          startedAt: null,
          finishedAt: null,
          retryNotBefore: new Date(now - 1_000).toISOString(),
        },
        source,
      ],
      julesAgentId: "jules-1",
      now,
    })).toEqual([{ issueId: "issue-1", sessionId: "session-1", resumeFromRunId: "source-run", wake: true }]);
  });
});
