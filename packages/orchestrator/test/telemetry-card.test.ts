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
    julesCapacity: 15,
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
    expect(card).toContain("Jules queue: `5/15` configured active assignments");
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

    expect(card).toContain("⏸️ **Paused** (rate-limit cooldown: `3m 12s` remaining)");
  });

  it("renders configured Jules queue capacity", () => {
    const card = formatOrchestratorDashboardCard({
      ...baseParams,
      julesRunning: 3,
      julesCapacity: 12,
    });

    expect(card).toContain("Jules queue: `3/12` configured active assignments");
  });

  it("reports only Paperclip-owned Jules queue capacity", () => {
    const card = formatOrchestratorDashboardCard({
      ...baseParams,
      julesRunning: 2,
      julesCapacity: 7,
    });

    expect(card).toContain("Jules queue: `2/7` configured active assignments");
    expect(card).not.toContain("Full/Exhausted");
    expect(card).not.toContain("15/15");
  });
});
