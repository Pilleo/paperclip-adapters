import { describe, it, expect } from "vitest";
import { calculateJulesCapacity, resolveJulesDispatchCapacity } from "../src/core/jules-quota.js";

describe("Jules Quota Module", () => {
  it("keeps the configured Paperclip queue lane available when provider quota is full", () => {
    const quota = calculateJulesCapacity([], Date.now(), 15, 100);
    expect(resolveJulesDispatchCapacity(1, { ...quota, effectiveAvailableCapacity: 0 }, 0)).toBe(1);
  });

  it("uses configured queue capacity when live quota cannot be read", () => {
    expect(resolveJulesDispatchCapacity(1, {
      activeSessionsCount: 0,
      sessionsLast24hCount: 0,
      maxConcurrent: 15,
      maxDaily: 100,
      availableConcurrentSlots: 0,
      availableDailySlots: 0,
      effectiveAvailableCapacity: 0,
      fetchedLive: false,
    }, 0)).toBe(1);
  });

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
