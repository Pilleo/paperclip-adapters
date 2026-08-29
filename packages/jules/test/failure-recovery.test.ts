import { describe, it, expect } from "vitest";
import { evaluateSessionFailure } from "../src/server/failure-recovery.js";
import { asPaperclipId, asJulesSessionId } from "../src/server/brands.js";
import { JulesAdapterSessionV1 } from "../src/server/session.js";

describe("failure-recovery", () => {
  const baseSession: JulesAdapterSessionV1 = {
    version: 1,
    paperclipIssueId: asPaperclipId("task-123"),
    promptHash: "hash123",
    repository: "Pilleo/mazewall",
    source: "sources/github/Pilleo/mazewall",
    baseBranch: "master",
    phase: "RUNNING",
    sessionId: "sess-1",
    julesSessionId: asJulesSessionId("sess-1"),
    attempt: 1,
    failedSessions: [],
    createdAt: new Date().toISOString()
  };

  it("schedules in-place retry when failure count is below limit", () => {
    const decision = evaluateSessionFailure(baseSession, "Jules was unable to complete the task.");
    expect(decision.action).toBe("IN_PLACE_RETRY");
    expect(decision.inPlaceAttempt).toBe(1);
    expect(decision.retryMessage).toBe("retry");
  });

  it("increments inPlaceAttempt on subsequent in-place retries", () => {
    const sessionWithOneRetry = {
      ...baseSession,
      inPlaceRetryCount: 1
    } as JulesAdapterSessionV1;

    const decision = evaluateSessionFailure(sessionWithOneRetry, "Task failed");
    expect(decision.action).toBe("IN_PLACE_RETRY");
    expect(decision.inPlaceAttempt).toBe(2);
  });

  it("marks blocked when in-place retries are exhausted", () => {
    const sessionExhausted = {
      ...baseSession,
      inPlaceRetryCount: 2
    } as JulesAdapterSessionV1;

    const decision = evaluateSessionFailure(sessionExhausted, "Task failed");
    expect(decision.action).toBe("MARK_BLOCKED");
    expect(decision.reason).toContain("Exhausted");
  });

  it("marks blocked immediately on unrecoverable configuration errors", () => {
    const decision = evaluateSessionFailure(baseSession, "Invalid API key or unauthorized access");
    expect(decision.action).toBe("MARK_BLOCKED");
    expect(decision.classification).toBe("configuration");
  });
});
