import { describe, expect, it } from "vitest";
import { buildJulesMonitorReattachment, decideJulesMonitorReconciliation, resolveJulesMonitorSessionId, type JulesMonitorSnapshot } from "../src/core/jules-monitor-reconciliation.js";

const base: JulesMonitorSnapshot = {
  issueStatus: "blocked",
  assigneeIsOrchestrator: true,
  serviceName: "jules",
  monitorStatus: "triggered",
  timeoutAt: "2026-09-02T14:00:00.000Z",
  hasProviderSession: true,
};

describe("Jules monitor reconciliation", () => {
  it("recovers a redacted monitor reference only from the durable Jules session handle", () => {
    expect(resolveJulesMonitorSessionId({
      monitorExternalRef: "[redacted]",
      sessionHandleBody: [
        "julesSessionId: session-836",
        "url: https://jules.google.com/session/session-836",
        "prUrl: https://github.com/acme/repo/pull/836",
      ].join("\n"),
    })).toBe("session-836");
  });

  it("rejects a redacted monitor reference without an exact durable session handle", () => {
    expect(resolveJulesMonitorSessionId({
      monitorExternalRef: "[redacted]",
      sessionHandleBody: "sessionId: session-836",
    })).toBeNull();
  });

  it("builds a native monitor patch from a verified provider session", () => {
    expect(buildJulesMonitorReattachment({ mode: "normal", stages: [] }, "jules-836", Date.parse("2026-09-02T15:00:00.000Z"))).toEqual({
      mode: "normal",
      stages: [],
      monitor: {
        nextCheckAt: "2026-09-02T15:15:00.000Z",
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

  it("repairs an in-progress Jules issue whose monitor was cleared by invalid assignee", () => {
    expect(decideJulesMonitorReconciliation({
      ...base,
      issueStatus: "in_progress",
      monitorStatus: "cleared",
      monitorClearReason: "invalid_assignee",
      assigneeIsJules: true,
    }, Date.parse("2026-09-02T15:00:00.000Z"))).toEqual({
      action: "resume_provider",
      issueStatus: "in_progress",
      reason: "cleared Jules monitor has a persisted provider session and valid Jules ownership",
    });
  });

  it("repairs the cleared monitor even before executionPolicy is present", () => {
    expect(decideJulesMonitorReconciliation({
      ...base,
      issueStatus: "in_progress",
      monitorStatus: "cleared",
      monitorClearReason: "invalid_assignee",
      assigneeIsJules: true,
      monitorCanBeReattached: false,
    }, Date.parse("2026-09-02T15:00:00.000Z")).action).toBe("resume_provider");
  });

  it("repairs the same monitor when Paperclip has already marked the Jules issue blocked", () => {
    expect(decideJulesMonitorReconciliation({
      ...base,
      issueStatus: "blocked",
      monitorStatus: "cleared",
      monitorClearReason: "invalid_assignee",
      assigneeIsJules: true,
      monitorCanBeReattached: false,
    }, Date.parse("2026-09-02T15:00:00.000Z")).action).toBe("resume_provider");
  });

  it("reattaches an active Jules monitor stranded after executionPolicy was stripped", () => {
    expect(decideJulesMonitorReconciliation({
      ...base,
      issueStatus: "in_progress",
      monitorDetached: true,
      timeoutAt: "2026-09-05T19:27:11.536Z",
    }, Date.parse("2026-09-04T01:00:00.000Z"))).toEqual({
      action: "resume_provider",
      issueStatus: "in_progress",
      reason: "stranded Jules monitor has a persisted provider session",
    });
  });

  it("reattaches a detached Jules monitor after failed-run recovery parks its issue in backlog", () => {
    expect(decideJulesMonitorReconciliation({
      ...base,
      issueStatus: "backlog",
      monitorDetached: true,
      timeoutAt: "2026-09-05T19:27:11.536Z",
    }, Date.parse("2026-09-04T01:00:00.000Z"))).toEqual({
      action: "resume_provider",
      issueStatus: "in_progress",
      reason: "stranded Jules monitor has a persisted provider session",
    });
  });

  it("resumes a manually cleared monitor only after an exact native plan verdict was resolved", () => {
    const snapshot = {
      ...base,
      issueStatus: "backlog",
      assigneeIsJules: true,
      monitorStatus: "cleared",
      monitorClearReason: "manual",
      resolvedNativePlanVerdict: true,
    } satisfies JulesMonitorSnapshot;
    expect(decideJulesMonitorReconciliation(snapshot, Date.parse("2026-09-02T15:00:00.000Z"))).toEqual({
      action: "resume_provider",
      issueStatus: "in_progress",
      reason: "resolved native plan verdict needs its Jules parent resumed",
    });
    expect(decideJulesMonitorReconciliation({ ...snapshot, resolvedNativePlanVerdict: false }, Date.parse("2026-09-02T15:00:00.000Z")).action).toBe("preserve");
  });

  it("resumes a blocked Jules parent after its exact native plan verdict resolves", () => {
    expect(decideJulesMonitorReconciliation({
      ...base,
      issueStatus: "blocked",
      assigneeIsJules: true,
      monitorStatus: "cleared",
      monitorClearReason: "manual",
      resolvedNativePlanVerdict: true,
    }, Date.parse("2026-09-02T15:00:00.000Z"))).toEqual({
      action: "resume_provider",
      issueStatus: "in_progress",
      reason: "resolved native plan verdict needs its Jules parent resumed",
    });
  });

  it("does not repair a cleared monitor without proven Jules ownership", () => {
    expect(decideJulesMonitorReconciliation({
      ...base,
      issueStatus: "in_progress",
      monitorStatus: "cleared",
      monitorClearReason: "invalid_assignee",
      assigneeIsJules: false,
    }, Date.parse("2026-09-02T15:00:00.000Z")).action).toBe("preserve");
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
