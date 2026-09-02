import { describe, expect, it } from "vitest";
import { allocateProjectCapacity } from "../src/core/project-capacity.js";

describe("allocateProjectCapacity", () => {
  it("keeps the sum of project budgets within each company limit", () => {
    const allocation = allocateProjectCapacity({
      projectIds: ["a", "b", "c"],
      maxConcurrentJules: 7,
      maxConcurrentVibe: 4,
    });

    expect(allocation).toEqual([
      { projectId: "a", jules: 2, vibe: 1 },
      { projectId: "b", jules: 2, vibe: 1 },
      { projectId: "c", jules: 3, vibe: 2 },
    ]);
    expect(allocation.reduce((sum, item) => sum + item.jules, 0)).toBeLessThanOrEqual(7);
    expect(allocation.reduce((sum, item) => sum + item.vibe, 0)).toBeLessThanOrEqual(4);
  });

  it("deduplicates project ids deterministically", () => {
    expect(allocateProjectCapacity({ projectIds: ["b", "a", "b"], maxConcurrentJules: 2, maxConcurrentVibe: 1 })).toEqual([
      { projectId: "b", jules: 1, vibe: 0 },
      { projectId: "a", jules: 1, vibe: 1 },
    ]);
  });

  it("does not exceed a one-slot lane when several projects are runnable", () => {
    const allocation = allocateProjectCapacity({ projectIds: ["a", "b", "c"], maxConcurrentJules: 1, maxConcurrentVibe: 1 });
    expect(allocation.map((item) => item.vibe)).toEqual([0, 0, 1]);
    expect(allocation.reduce((sum, item) => sum + item.vibe, 0)).toBe(1);
  });
});
