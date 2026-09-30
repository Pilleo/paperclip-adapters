import { describe, expect, it } from "vitest";
import { classifyJulesPrReviewDisposition, deriveJulesPrHandoffEvidence, openJulesPrRecoveryKey } from "../src/core/jules-monitor-state.js";

const prIdentity = { prUrl: "https://github.com/acme/repo/pull/6", headSha: "a".repeat(40) };
const completedProducerRun = {
  id: "run-pr-11", agentId: "jules-agent", issueId: "issue-1551", status: "succeeded",
  startedAt: "2026-09-21T09:16:30.000Z", finishedAt: "2026-09-21T09:16:46.000Z",
  provider: "jules", providerSessionId: "3636402812288664406", julesState: "COMPLETED", stopReason: "completed",
} as const;

describe("openJulesPrRecoveryKey", () => {
  const recovery = {
    issueId: "issue-1549",
    prUrl: "https://github.com/acme/repo/pull/9",
    headSha: "f8a85c8b",
    issueStatus: "in_review",
    assigneeAgentId: null,
  } as const;

  it("is stable across a self-authored issue timestamp update", () => {
    expect(openJulesPrRecoveryKey(recovery)).toBe(openJulesPrRecoveryKey({ ...recovery }));
  });

  it.each([
    ["a new PR head", { headSha: "new-head" }],
    ["a projected status regression", { issueStatus: "in_progress" }],
    ["a projected owner regression", { assigneeAgentId: "jules-agent" }],
  ])("changes when %s requires a fresh recovery", (_name, change) => {
    expect(openJulesPrRecoveryKey(recovery)).not.toBe(openJulesPrRecoveryKey({ ...recovery, ...change }));
  });
});

describe("classifyJulesPrReviewDisposition", () => {
  const scheduledJulesMonitor = {
    monitor: {
      serviceName: "jules",
      externalRef: "3636402812288664406",
    },
  } as const;

  it("hands a completed PR producer to native review despite its stale scheduled monitor", () => {
    const handoff = deriveJulesPrHandoffEvidence({ ...prIdentity, executionPolicy: scheduledJulesMonitor,
      issueId: completedProducerRun.issueId, producerRunId: completedProducerRun.id,
      producerRun: completedProducerRun, heartbeatRuns: [completedProducerRun] });
    expect(classifyJulesPrReviewDisposition({
      currentHeadRejected: false,
      executionPolicy: scheduledJulesMonitor,
      handoff,
    })).toEqual({ kind: "eligible_for_review" });
  });

  it("does not accept a terminal handoff label forged at a runtime boundary", () => {
    expect(classifyJulesPrReviewDisposition({ currentHeadRejected: false,
      executionPolicy: scheduledJulesMonitor, handoff: { kind: "terminal_pr_handoff" } as never }))
      .toEqual({ kind: "await_provider" });
  });
});

describe("deriveJulesPrHandoffEvidence", () => {
  const scheduledJulesMonitor = {
    monitor: {
      serviceName: "jules",
      externalRef: "3636402812288664406",
    },
  } as const;

  it("binds terminal handoff to the exact issue, session, PR head and proving run", () => {
    const input = { executionPolicy: scheduledJulesMonitor, issueId: "issue-1551",
      producerRunId: completedProducerRun.id, producerRun: completedProducerRun,
      prUrl: "https://github.com/acme/repo/pull/6", headSha: "a".repeat(40), heartbeatRuns: [completedProducerRun] };
    expect(deriveJulesPrHandoffEvidence(input)).toMatchObject({ kind: "terminal_pr_handoff", evidence: {
      issueId: "issue-1551", providerSessionId: "3636402812288664406", prUrl: input.prUrl,
      headSha: input.headSha, producerRunId: "run-pr-11", completionRunId: "run-pr-11",
    } });
    const decision = deriveJulesPrHandoffEvidence(input);
    if (decision.kind !== "terminal_pr_handoff") throw new Error("Fixture handoff not validated");
    expect(classifyJulesPrReviewDisposition({ currentHeadRejected: false, executionPolicy: scheduledJulesMonitor,
      handoff: { kind: "terminal_pr_handoff", evidence: { ...decision.evidence, headSha: "b".repeat(40) } } as never }))
      .toEqual({ kind: "await_provider" });
    expect(deriveJulesPrHandoffEvidence({ ...input, producerRun: { ...completedProducerRun, issueId: "another-issue" } }))
      .toEqual({ kind: "active_or_unverified_monitor" });
    expect(deriveJulesPrHandoffEvidence({ ...input, headSha: "" }))
      .toEqual({ kind: "active_or_unverified_monitor" });
  });

  it("uses a hydrated later exact-head same-session handoff when the original producer is legacy", () => {
    const legacy = { ...completedProducerRun, julesState: null };
    const latest = { ...completedProducerRun, id: "later-terminal", finishedAt: "2026-09-21T09:20:00Z",
      handoffPending: true, prUrl: "https://github.com/acme/repo/pull/6", headSha: "a".repeat(40) };
    const input = { executionPolicy: { monitor: { serviceName: "jules", externalRef: "[redacted]" } },
      issueId: "issue-1551", producerRunId: legacy.id, producerRun: legacy,
      handoffRun: latest, prUrl: latest.prUrl, headSha: latest.headSha,
      heartbeatRuns: [latest] };
    expect(deriveJulesPrHandoffEvidence(input)).toMatchObject({ kind: "terminal_pr_handoff", evidence: {
      producerRunId: legacy.id, completionRunId: latest.id, headSha: latest.headSha,
    } });
    for (const change of [{ headSha: "b".repeat(40) }, { providerSessionId: "other" },
      { agentId: "other-worker" }, { handoffPending: false }, { issueId: "other-issue" }]) {
      expect(deriveJulesPrHandoffEvidence({ ...input, handoffRun: { ...latest, ...change } }))
        .toEqual({ kind: "active_or_unverified_monitor" });
    }
    expect(deriveJulesPrHandoffEvidence({ ...input,
      heartbeatRuns: [{ ...latest, id: "live", status: "running" }] }))
      .toEqual({ kind: "active_or_unverified_monitor" });
  });

  it.each([
    ["the matching completed producer", [completedProducerRun], { kind: "terminal_pr_handoff" }],
    ["a later live provider run", [completedProducerRun, { ...completedProducerRun, id: "run-live", startedAt: "2026-09-21T09:17:00.000Z", finishedAt: "2026-09-21T09:17:01.000Z", julesState: "IN_PROGRESS", stopReason: null }], { kind: "active_or_unverified_monitor" }],
    ["a producer run for another session", [{ ...completedProducerRun, providerSessionId: "other-session" }], { kind: "active_or_unverified_monitor" }],
    ["a failed producer run", [{ ...completedProducerRun, status: "failed" }], { kind: "active_or_unverified_monitor" }],
  ])("returns %s", (_name, runs, expected) => {
    expect(deriveJulesPrHandoffEvidence({
      ...prIdentity,
      executionPolicy: scheduledJulesMonitor,
      issueId: "issue-1551",
      producerRunId: "run-pr-11",
      heartbeatRuns: runs,
    })).toMatchObject(expected);
  });

  it("preserves the no-monitor legacy state", () => {
    expect(deriveJulesPrHandoffEvidence({
      executionPolicy: null,
      issueId: "issue-1551",
      producerRunId: "run-pr-11",
      heartbeatRuns: [completedProducerRun],
    })).toEqual({ kind: "no_authoritative_monitor" });
  });

  it("does not treat a cleared historical monitor as active when an operator-linked PR has no producer run", () => {
    expect(deriveJulesPrHandoffEvidence({
      executionPolicy: null,
      executionState: { status: "idle", monitor: {
        serviceName: "jules", externalRef: "[redacted]", status: "cleared", clearReason: "invalid_status",
      } },
      issueId: "issue-b", producerRunId: null, heartbeatRuns: [],
    })).toEqual({ kind: "no_authoritative_monitor" });
  });

  it("hydrates the immutable PR producer when Paperclip retains its monitor only in executionState", () => {
    expect(deriveJulesPrHandoffEvidence({
      ...prIdentity,
      executionPolicy: null,
      executionState: {
        status: "idle",
        // Paperclip redacts persisted external refs from external adapters.
        monitor: { ...scheduledJulesMonitor.monitor, externalRef: "[redacted]" },
      },
      issueId: "issue-1551",
      producerRunId: completedProducerRun.id,
      producerRun: completedProducerRun,
      // The list endpoint deliberately strips resultJson from this record.
      heartbeatRuns: [{ ...completedProducerRun, provider: null, providerSessionId: null, julesState: null, stopReason: null }],
    })).toMatchObject({ kind: "terminal_pr_handoff", evidence: { completionRunId: completedProducerRun.id } });
  });

  it("does not hand off while a newer issue run is still active", () => {
    expect(deriveJulesPrHandoffEvidence({
      executionPolicy: scheduledJulesMonitor,
      issueId: "issue-1551",
      producerRunId: completedProducerRun.id,
      producerRun: completedProducerRun,
      heartbeatRuns: [
        completedProducerRun,
        {
          ...completedProducerRun,
          id: "run-monitor-started-during-handoff",
          status: "running",
          startedAt: "2026-09-21T09:32:07.000Z",
          finishedAt: null,
          julesState: "IN_PROGRESS",
          stopReason: null,
        },
      ],
    })).toEqual({ kind: "active_or_unverified_monitor" });
  });
});
