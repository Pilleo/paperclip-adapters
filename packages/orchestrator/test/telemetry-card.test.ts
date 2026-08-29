import { describe, it, expect } from "vitest";
import { formatOrchestratorDashboardCard } from "../src/core/telemetry-card.js";

describe("telemetry-card", () => {
  it("formats rich Markdown dashboard table", () => {
    const card = formatOrchestratorDashboardCard({
      companyId: "c1",
      totalIssues: 100,
      inProgressCount: 5,
      inReviewCount: 2,
      resolvedCount: 30,
      todoCount: 63,
      julesQuota: {
        fetchedLive: true,
        activeSessionsCount: 15,
        maxConcurrent: 15,
        sessionsLast24hCount: 33,
        maxDaily: 100,
        availableCapacity: 0,
        effectiveAvailableCapacity: 0,
        rateLimited: false,
      },
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
    });

    expect(card).toContain("Orchestrator Live Telemetry");
    expect(card).toContain("15/15");
    expect(card).toContain("enforcer/src/Bpf.kt");
    expect(card).toContain("Total: **100**");
  });
});
