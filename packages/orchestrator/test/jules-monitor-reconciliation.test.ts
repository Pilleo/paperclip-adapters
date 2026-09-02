import { describe, expect, it } from "vitest";
import { buildJulesMonitorReattachment, decideJulesMonitorReconciliation, type JulesMonitorSnapshot } from "../src/core/jules-monitor-reconciliation.js";

const base: JulesMonitorSnapshot = {
  issueStatus: "blocked",
  assigneeIsOrchestrator: true,
  serviceName: "jules",
  monitorStatus: "triggered",
  timeoutAt: "2026-09-02T14:00:00.000Z",
  hasProviderSession: true,
};

describe("Jules monitor reconciliation", () => {
  it("builds a native monitor patch from a verified provider session", () => {
    expect(buildJulesMonitorReattachment({ mode: "normal", stages: [] }, "jules-836", Date.parse("2026-09-02T15:00:00.000Z"))).toEqual({
      mode: "normal",
      stages: [],
      monitor: {
        nextCheckAt: "2026-09-02T15:05:00.000Z",
        timeoutAt: "2026-09-04T15:00:00.000Z",
        notes: "Jules cloud session is active; Paperclip will poll it when this monitor is due.",
        scheduledBy: "assignee",
        kind: "external_service",
        serviceName: "jules",
        externalRef: "jules-836",
        recoveryPolicy: "wake_owner",
      },
    });
  });

  it("rejects reattachment without a non-empty provider session", () => {
    expect(() => buildJulesMonitorReattachment({}, "", Date.parse("2026-09-02T15:00:00.000Z"))).toThrow("provider session");
  });
  it("resumes a blocked issue when its persisted Jules monitor expired", () => {
    expect(decideJulesMonitorReconciliation(base, Date.parse("2026-09-02T15:00:00.000Z"))).toEqual({
      action: "resume_provider",
      issueStatus: "in_progress",
      reason: "expired Jules monitor has a persisted provider session",
    });
  });

  it("never resumes from a provider reference alone when the monitor cannot be reattached", () => {
    expect(decideJulesMonitorReconciliation({ ...base, monitorCanBeReattached: false }, Date.parse("2026-09-02T15:00:00.000Z"))).toEqual({
      action: "return_to_todo",
      issueStatus: "todo",
      reason: "expired Jules monitor has no verified executable continuation",
    });
  });

  it("does not resume without a provider session", () => {
    expect(decideJulesMonitorReconciliation({ ...base, hasProviderSession: false }, Date.parse("2026-09-02T15:00:00.000Z"))).toEqual({
      action: "preserve",
      reason: "expired Jules monitor has no provider session to resume",
    });
  });

  it("does not touch healthy, non-Jules, or unexpired monitors", () => {
    for (const snapshot of [
      { ...base, issueStatus: "in_progress" },
      { ...base, assigneeIsOrchestrator: false },
      { ...base, timeoutAt: "2026-09-02T16:00:00.000Z" },
      { ...base, monitorStatus: "scheduled" },
    ] satisfies JulesMonitorSnapshot[]) {
      expect(decideJulesMonitorReconciliation(snapshot, Date.parse("2026-09-02T15:00:00.000Z")).action).toBe("preserve");
    }
  });

  it("does not resume an expired Jules monitor owned by another worker", () => {
    expect(decideJulesMonitorReconciliation({ ...base, assigneeIsOrchestrator: false }, Date.parse("2026-09-02T15:00:00.000Z")).action).toBe("preserve");
  });

  it("restores a todo issue when its persisted Jules monitor is resumable", () => {
    expect(decideJulesMonitorReconciliation({ ...base, issueStatus: "todo" }, Date.parse("2026-09-02T15:00:00.000Z")).action).toBe("resume_provider");
  });
});
