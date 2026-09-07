import { describe, expect, it } from "vitest";
import { selectUndeliveredActivities, advanceActivityCursor } from "../src/server/activity-reconciliation.js";

describe("provider activity reconciliation", () => {
  const activities = [
    { id: "old", createTime: "2026-08-30T00:00:00.000Z" },
    { id: "new", createTime: "2026-08-30T00:20:00.000Z" },
  ];

  it("selects only activities after the checkpoint and not already delivered", () => {
    expect(selectUndeliveredActivities(activities, {
      createTime: "2026-08-30T00:10:00.000Z",
      id: "checkpoint",
    }, ["new"])).toEqual([]);
  });

  it("preserves provider order and deduplicates IDs", () => {
    expect(selectUndeliveredActivities([
      activities[1], activities[1], activities[0],
    ], undefined, [])).toEqual([activities[0], activities[1]]);
  });

  it("does not advance the cursor when no activity was delivered", () => {
    const checkpoint = { createTime: "2026-08-30T00:02:00.000Z", id: "checkpoint" };
    expect(advanceActivityCursor(checkpoint, [])).toBe(checkpoint);
  });

  it("advances to the latest delivered activity", () => {
    expect(advanceActivityCursor(undefined, activities)).toEqual({
      createTime: "2026-08-30T00:20:00.000Z",
      id: "new",
    });
  });
});
