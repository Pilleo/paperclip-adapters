import { describe, it, expect } from "vitest";
import { evaluateSessionWatchdog, DEFAULT_STALL_THRESHOLD_MS } from "../src/server/watchdog.js";
import { asPaperclipId, asJulesSessionId, asJulesActivityId } from "../src/server/brands.js";
import { JulesAdapterSessionV1 } from "../src/server/session.js";

describe("watchdog", () => {
  const baseSession: JulesAdapterSessionV1 = {
    version: 1,
    paperclipIssueId: asPaperclipId("task-123"),
    promptHash: "hash123",
    repository: "Pilleo/mazewall",
    source: "sources/github/Pilleo/mazewall",
    baseBranch: "master",
    phase: "RUNNING",
    julesState: "IN_PROGRESS",
    sessionId: "sess-1",
    julesSessionId: asJulesSessionId("sess-1"),
    attempt: 1,
    failedSessions: [],
    createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString()
  };

  it("does not nudge when session is recently active (< 15 min)", () => {
    const now = Date.now();
    const lastActivity = new Date(now - 5 * 60 * 1000).toISOString();

    const evalResult = evaluateSessionWatchdog(baseSession, lastActivity, now);
    expect(evalResult.shouldNudge).toBe(false);
  });

  it("triggers nudge when session has been silent for > 15 min in IN_PROGRESS", () => {
    const now = Date.now();
    const lastActivity = new Date(now - 20 * 60 * 1000).toISOString();

    const evalResult = evaluateSessionWatchdog(baseSession, lastActivity, now);
    expect(evalResult.shouldNudge).toBe(true);
    expect(evalResult.nudgeMessage).toContain("Status check");
    expect(evalResult.nudgeCount).toBe(1);
  });

  it("suppresses nudge when waiting on pending user interaction card", () => {
    const now = Date.now();
    const lastActivity = new Date(now - 30 * 60 * 1000).toISOString();
    const sessionWithInteraction: JulesAdapterSessionV1 = {
      ...baseSession,
      pendingInteraction: {
        type: "user_feedback",
        julesActivityId: asJulesActivityId("act-1"),
        question: "Clarification needed?",
        createdAt: lastActivity
      }
    };

    const evalResult = evaluateSessionWatchdog(sessionWithInteraction, lastActivity, now);
    expect(evalResult.shouldNudge).toBe(false);
  });

  it("suppresses nudge when cooldown between nudges has not elapsed", () => {
    const now = Date.now();
    const lastActivity = new Date(now - 60 * 60 * 1000).toISOString();
    const sessionWithNudge = {
      ...baseSession,
      lastWatchdogNudgeAt: new Date(now - 5 * 60 * 1000).toISOString(),
      watchdogNudgeCount: 1
    } as JulesAdapterSessionV1;

    const evalResult = evaluateSessionWatchdog(sessionWithNudge, lastActivity, now);
    expect(evalResult.shouldNudge).toBe(false);
    expect(evalResult.reason).toContain("cooldown");
  });

  it("does not nudge non-working terminal phases (COMPLETED / FAILED)", () => {
    const now = Date.now();
    const lastActivity = new Date(now - 60 * 60 * 1000).toISOString();
    const completedSession: JulesAdapterSessionV1 = {
      ...baseSession,
      phase: "COMPLETED",
      julesState: "COMPLETED"
    };

    const evalResult = evaluateSessionWatchdog(completedSession, lastActivity, now);
    expect(evalResult.shouldNudge).toBe(false);
  });
});
