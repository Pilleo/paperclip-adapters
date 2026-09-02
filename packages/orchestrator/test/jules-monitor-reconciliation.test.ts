import { describe, expect, it } from "vitest";
import { decideJulesMonitorReconciliation, type JulesMonitorSnapshot } from "../src/core/jules-monitor-reconciliation.js";

const base: JulesMonitorSnapshot = {
  issueStatus: "blocked",
  assigneeIsOrchestrator: true,
  serviceName: "jules",
  monitorStatus: "triggered",
  timeoutAt: "2026-09-02T14:00:00.000Z",
  hasProviderSession: true,
};

describe("Jules monitor reconciliation", () => {
  it("resumes a blocked issue when its persisted Jules monitor expired", () => {
    expect(decideJulesMonitorReconciliation(base, Date.parse("2026-09-02T15:00:00.000Z"))).toEqual({
      action: "resume_provider",
      issueStatus: "in_progress",
      reason: "expired Jules monitor has a persisted provider session",
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
