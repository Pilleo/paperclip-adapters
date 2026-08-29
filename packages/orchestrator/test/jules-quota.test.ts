import { describe, it, expect } from "vitest";
import { calculateJulesCapacity } from "../src/core/jules-quota.js";

describe("Jules Quota Module", () => {
  it("calculates available concurrent and daily capacity accurately", () => {
    const now = Date.now();
    const sessions = [
      { state: "IN_PROGRESS", createTime: new Date(now - 1000 * 60 * 10).toISOString() },
      { state: "PLANNING", createTime: new Date(now - 1000 * 60 * 30).toISOString() },
      { state: "COMPLETED", createTime: new Date(now - 1000 * 60 * 60 * 2).toISOString() },
      { state: "COMPLETED", createTime: new Date(now - 1000 * 60 * 60 * 30).toISOString() }, // > 24h old
    ];

    const quota = calculateJulesCapacity(sessions, now, 15, 100);
    expect(quota.activeSessionsCount).toBe(2); // 1 in_progress + 1 planning
    expect(quota.sessionsLast24hCount).toBe(3); // 3 created in last 24h
    expect(quota.availableConcurrentSlots).toBe(13); // 15 - 2
    expect(quota.availableDailySlots).toBe(97); // 100 - 3
    expect(quota.effectiveAvailableCapacity).toBe(13); // min(13, 97)
  });

  it("handles empty sessions list with full capacity", () => {
    const quota = calculateJulesCapacity([], Date.now(), 15, 100);
    expect(quota.activeSessionsCount).toBe(0);
    expect(quota.availableConcurrentSlots).toBe(15);
    expect(quota.availableDailySlots).toBe(100);
    expect(quota.effectiveAvailableCapacity).toBe(15);
  });
});
