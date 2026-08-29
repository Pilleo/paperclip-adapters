import { describe, expect, it } from "vitest";
import {
  isAfterCheckpoint,
  laterCheckpoint,
  normalizeActivities,
} from "../src/server/activity-checkpoint";

const activity = (id: string, createTime?: string, extra: Record<string, unknown> = {}) => ({
  id,
  ...(createTime ? { createTime } : {}),
  ...extra,
});

describe("Jules activity checkpointing", () => {
  it("normalizes reordered pages by createTime and ID and removes duplicate IDs", () => {
    const normalized = normalizeActivities([
      activity("c", "2026-08-08T10:02:00.000Z"),
      activity("b", "2026-08-08T10:01:00.000Z"),
      activity("a", "2026-08-08T10:01:00.000Z"),
      activity("b", "2026-08-08T10:01:00.000Z", { description: "duplicate" }),
    ]);
    expect(normalized.map(({ id }) => id)).toEqual(["a", "b", "c"]);
    expect(normalized).toHaveLength(3);
  });

  it("keeps only the bounded overlap around a durable checkpoint", () => {
    const checkpoint = { createTime: "2026-08-08T10:10:00.000Z", id: "cursor" };
    expect(isAfterCheckpoint(activity("old", "2026-08-08T10:04:59.999Z"), checkpoint)).toBe(false);
    expect(isAfterCheckpoint(activity("overlap", "2026-08-08T10:05:00.000Z"), checkpoint)).toBe(true);
    expect(isAfterCheckpoint(activity("new", "2026-08-08T10:11:00.000Z"), checkpoint)).toBe(true);
    expect(isAfterCheckpoint(activity("unknown-time"), checkpoint)).toBe(true);
  });

  it("never moves the checkpoint backwards when an overlapped page is reordered", () => {
    const checkpoint = { createTime: "2026-08-08T10:10:00.000Z", id: "z" };
    expect(laterCheckpoint(checkpoint, activity("old", "2026-08-08T10:08:00.000Z"))).toEqual(checkpoint);
    expect(laterCheckpoint(checkpoint, activity("next", "2026-08-08T10:11:00.000Z"))).toEqual({
      createTime: "2026-08-08T10:11:00.000Z",
      id: "next",
    });
  });
});
