import { describe, it, expect } from "vitest";
import {
  calculateJulesCapacity,
} from "../src/core/jules-quota.js";

describe("Deep Jules Quota Tests", () => {
  it("parses live session list and calculates 24h rolling capacity", () => {
    const now = Date.now();
    const mockSessions = [
      { state: "IN_PROGRESS", createTime: new Date(now - 1000 * 60 * 60).toISOString() },
      { state: "COMPLETED", createTime: new Date(now - 1000 * 60 * 120).toISOString() },
      { state: "COMPLETED", createTime: new Date(now - 1000 * 60 * 60 * 25).toISOString() }, // > 24h old
    ];

    const quota = calculateJulesCapacity(mockSessions, now, 15, 100);
    expect(quota.activeSessionsCount).toBe(1);
    expect(quota.sessionsLast24hCount).toBe(2); // Only 2 in last 24h
    expect(quota.availableConcurrentSlots).toBe(14);
    expect(quota.availableDailySlots).toBe(98);
    expect(quota.effectiveAvailableCapacity).toBe(14);
  });
});
