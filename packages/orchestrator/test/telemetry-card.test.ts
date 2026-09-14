import { describe, it, expect } from "vitest";
import { formatOrchestratorDashboardCard } from "../src/core/telemetry-card.js";

describe("telemetry-card", () => {
  const baseParams = {
    companyId: "c1",
    totalIssues: 100,
    inProgressCount: 5,
    inReviewCount: 2,
    resolvedCount: 30,
    todoCount: 63,
    julesRunning: 5,
    julesNewSessionBudget: 3,
    vibeRunning: 1,
    vibeCapacity: 1,
    ghStatus: {
      openPrs: [],
      mergedPrs: [],
      openPrFiles: new Set(["enforcer/src/Bpf.kt"]),
    },
    conflictResult: {
      blockedByMap: new Map(),
      conflictEdges: [],
    },
    approvalsPendingCount: 2,
    elapsedMs: 250,
  };

  it("formats rich Markdown dashboard table", () => {
    const card = formatOrchestratorDashboardCard(baseParams);
    expect(card).toContain("Orchestrator Live Telemetry");
    expect(card).toContain("`3` new starts/heartbeat");
    expect(card).toContain("enforcer/src/Bpf.kt");
    expect(card).toContain("Total: **100**");
  });

  it("renders rate-limit cooldown countdown when pause timestamp is active", () => {
    const now = 1700000000000;
    const rateLimitEnd = now + 192000; // 3m 12s in future
    const card = formatOrchestratorDashboardCard({
      ...baseParams,
      nowMs: now,
      rateLimitPausedUntilMs: rateLimitEnd,
    });

    expect(card).toContain("⏸️ **Paused** (Rate limit cooldown: `3m 12s` remaining)");
  });

  it("reports local admissions without claiming provider quota", () => {
    const card = formatOrchestratorDashboardCard({
      ...baseParams,
      julesNewSessionBudget: 1,
    });

    expect(card).toContain("`1` new starts/heartbeat");
    expect(card).not.toContain("daily rolling");
  });
});
