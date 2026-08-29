import { describe, it, expect } from "vitest";
import { completionInteractionResult, createPendingResult } from "../src/server/terminal-handler.js";
import { JulesAdapterSessionV1 } from "../src/server/session.js";

describe("terminal-handler", () => {
  const dummySession: JulesAdapterSessionV1 = {
    version: 1,
    paperclipIssueId: "issue-123" as any,
    promptHash: "abc",
    promptHashVersion: 2,
    repository: "owner/repo",
    source: "github",
    baseBranch: "main",
    phase: "RUNNING",
    sessionId: "jules-123",
    julesSessionId: "jules-123" as any,
    attempt: 1,
    failedSessions: [],
    createdAt: new Date().toISOString(),
  };

  it("formats completionInteractionResult with exitCode 0", () => {
    const res = completionInteractionResult(dummySession, "done", "Finished without PR", true);
    expect(res.exitCode).toBe(0);
    expect(res.clearSession).toBe(true);
    expect((res.resultJson as any).issueStatus).toBe("done");
  });

  it("formats createPendingResult with exitCode 0 and nextRunDelayMs", () => {
    const res = createPendingResult(dummySession, "Polling in progress", 5000);
    expect(res.exitCode).toBe(0);
    expect((res.resultJson as any).nextRunDelayMs).toBe(5000);
  });
});
