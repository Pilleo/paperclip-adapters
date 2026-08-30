import { describe, it, expect } from "vitest";
import {
  DEFAULT_CONTINUATION_CADENCE_MS,
  evaluateSessionContinuation,
  liveHeartbeatIssueIds,
  liveSessionId,
  parseHeartbeatRun,
  selectSessionContinuations,
  type HeartbeatRunSummary,
} from "../src/core/session-continuation.js";

const now = Date.parse("2026-08-30T15:00:00.000Z");
const managed = new Set(["jules-1", "vibe-1"]);

function run(overrides: Partial<HeartbeatRunSummary> = {}): HeartbeatRunSummary {
  return {
    id: "run-1",
    agentId: "jules-1",
    status: "succeeded",
    finishedAt: new Date(now - DEFAULT_CONTINUATION_CADENCE_MS - 1_000).toISOString(),
    startedAt: new Date(now - DEFAULT_CONTINUATION_CADENCE_MS - 2_000).toISOString(),
    sessionIdBefore: "2024763132299585220",
    sessionIdAfter: "2024763132299585220",
    issueId: "issue-821",
    retryNotBefore: null,
    providerSessionId: "2024763132299585220",
    ...overrides,
  };
}

describe("session continuation", () => {
  it("parses live session identity from heartbeat runs", () => {
    const parsed = parseHeartbeatRun({
      id: "run-1",
      agentId: "jules-1",
      status: "succeeded",
      sessionIdBefore: null,
      sessionIdAfter: "sess-live",
      contextSnapshot: { issueId: "issue-821" },
      resultJson: { retryNotBefore: "2026-08-30T15:05:00.000Z", julesSessionId: "sess-live" },
    });
    expect(parsed.issueId).toBe("issue-821");
    expect(liveSessionId(parsed)).toBe("sess-live");
    expect(parsed.retryNotBefore).toBe("2026-08-30T15:05:00.000Z");
  });

  it("wakes a managed idle Jules worker when the live session cadence has elapsed", () => {
    const decision = evaluateSessionContinuation({
      issue: { id: "issue-821", status: "in_progress", assigneeAgentId: "jules-1" },
      worker: { id: "jules-1", status: "idle", adapterType: "jules" },
      latestRun: run(),
      now,
      managedWorkerIds: managed,
    });
    expect(decision).toEqual({
      action: "WAKE",
      agentId: "jules-1",
      issueId: "issue-821",
      reason: "Continue live jules session 2024763132299585220",
    });
  });

  it("does not create a session when there is no live provider id", () => {
    const decision = evaluateSessionContinuation({
      issue: { id: "issue-821", status: "in_progress", assigneeAgentId: "jules-1" },
      worker: { id: "jules-1", status: "idle", adapterType: "jules" },
      latestRun: run({ sessionIdBefore: null, sessionIdAfter: null, providerSessionId: null }),
      now,
      managedWorkerIds: managed,
    });
    expect(decision.action).toBe("SKIP");
    if (decision.action === "SKIP") {
      expect(decision.reason).toMatch(/no live provider session/i);
    }
  });

  it("honors retryNotBefore", () => {
    const decision = evaluateSessionContinuation({
      issue: { id: "issue-821", status: "in_progress", assigneeAgentId: "jules-1" },
      worker: { id: "jules-1", status: "idle", adapterType: "jules" },
      latestRun: run({ retryNotBefore: "2026-08-30T15:05:00.000Z" }),
      now,
      managedWorkerIds: managed,
    });
    expect(decision.action).toBe("SKIP");
    if (decision.action === "SKIP") {
      expect(decision.reason).toMatch(/retryNotBefore/);
    }
  });

  it("does not wake a worker that is already running", () => {
    const decision = evaluateSessionContinuation({
      issue: { id: "issue-821", status: "in_progress", assigneeAgentId: "jules-1" },
      worker: { id: "jules-1", status: "running", adapterType: "jules" },
      latestRun: run(),
      now,
      managedWorkerIds: managed,
    });
    expect(decision.action).toBe("SKIP");
  });

  it("ignores independent agents and backlog issues", () => {
    expect(
      evaluateSessionContinuation({
        issue: { id: "issue-821", status: "in_progress", assigneeAgentId: "indie-jules" },
        worker: { id: "indie-jules", status: "idle", adapterType: "jules" },
        latestRun: run({ agentId: "indie-jules" }),
        now,
        managedWorkerIds: managed,
      }).action
    ).toBe("SKIP");
    expect(
      evaluateSessionContinuation({
        issue: { id: "issue-9", status: "backlog", assigneeAgentId: "jules-1" },
        worker: { id: "jules-1", status: "idle", adapterType: "jules" },
        latestRun: run({ issueId: "issue-9" }),
        now,
        managedWorkerIds: managed,
      }).action
    ).toBe("SKIP");
  });

  it("wakes at most one continuation per worker", () => {
    const wakes = selectSessionContinuations({
      issues: [
        { id: "issue-a", status: "in_progress", assigneeAgentId: "jules-1" },
        { id: "issue-b", status: "in_review", assigneeAgentId: "jules-1" },
      ],
      workers: [{ id: "jules-1", status: "idle", adapterType: "jules" }],
      runs: [
        run({ issueId: "issue-a" }),
        run({ id: "run-2", issueId: "issue-b", sessionIdAfter: "sess-b", providerSessionId: "sess-b" }),
      ],
      now,
    });
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.issueId).toBe("issue-a");
  });

  it.each([
    {
      desc: "idle worker with live session past cadence",
      workerStatus: "idle",
      issueStatus: "in_progress",
      run: { sessionIdAfter: "s1", retryNotBefore: null as string | null, finishedAtOffsetMs: DEFAULT_CONTINUATION_CADENCE_MS + 1000 },
      expectAction: "WAKE",
    },
    {
      desc: "running worker skipped",
      workerStatus: "running",
      issueStatus: "in_progress",
      run: { sessionIdAfter: "s1", retryNotBefore: null, finishedAtOffsetMs: DEFAULT_CONTINUATION_CADENCE_MS + 1000 },
      expectAction: "SKIP",
    },
    {
      desc: "retryNotBefore in the future",
      workerStatus: "idle",
      issueStatus: "in_progress",
      run: { sessionIdAfter: "s1", retryNotBefore: "2026-08-30T15:05:00.000Z", finishedAtOffsetMs: DEFAULT_CONTINUATION_CADENCE_MS + 1000 },
      expectAction: "SKIP",
    },
    {
      desc: "no live session id",
      workerStatus: "idle",
      issueStatus: "in_progress",
      run: { sessionIdAfter: null, retryNotBefore: null, finishedAtOffsetMs: DEFAULT_CONTINUATION_CADENCE_MS + 1000 },
      expectAction: "SKIP",
    },
    {
      desc: "backlog is not continued",
      workerStatus: "idle",
      issueStatus: "backlog",
      run: { sessionIdAfter: "s1", retryNotBefore: null, finishedAtOffsetMs: DEFAULT_CONTINUATION_CADENCE_MS + 1000 },
      expectAction: "SKIP",
    },
  ])("continuation table: $desc", ({ workerStatus, issueStatus, run: runBits, expectAction }) => {
    const latest = run({
      status: "succeeded",
      sessionIdAfter: runBits.sessionIdAfter,
      sessionIdBefore: runBits.sessionIdAfter,
      providerSessionId: runBits.sessionIdAfter,
      retryNotBefore: runBits.retryNotBefore,
      finishedAt: new Date(now - runBits.finishedAtOffsetMs).toISOString(),
    });
    const decision = evaluateSessionContinuation({
      issue: { id: "issue-821", status: issueStatus, assigneeAgentId: "jules-1" },
      worker: { id: "jules-1", status: workerStatus, adapterType: "jules" },
      latestRun: latest,
      now,
      managedWorkerIds: managed,
    });
    expect(decision.action).toBe(expectAction);
  });

  it("treats a recent live heartbeat as an active execution for stall protection", () => {
    const ids = liveHeartbeatIssueIds([run({ finishedAt: new Date(now - 60_000).toISOString() })], now, 15 * 60 * 1000);
    expect(ids.has("issue-821")).toBe(true);
  });
});
