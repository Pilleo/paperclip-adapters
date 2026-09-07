import { describe, expect, it } from "vitest";
import { runProjectWorkerPool } from "../src/core/project-worker-pool.js";

describe("runProjectWorkerPool", () => {
  it("limits concurrent workers and preserves project order", async () => {
    let active = 0;
    let peak = 0;
    const result = await runProjectWorkerPool(["a", "b", "c", "d"], 2, async (projectId) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return projectId.toUpperCase();
    });

    expect(peak).toBe(2);
    expect(result).toEqual([
      { item: "a", ok: true, value: "A" },
      { item: "b", ok: true, value: "B" },
      { item: "c", ok: true, value: "C" },
      { item: "d", ok: true, value: "D" },
    ]);
  });

  it("contains worker errors so one project cannot cancel the heartbeat", async () => {
    const result = await runProjectWorkerPool(["good", "bad", "later"], 2, async (projectId) => {
      if (projectId === "bad") throw new Error("project failed");
      return projectId;
    });

    expect(result).toEqual([
      { item: "good", ok: true, value: "good" },
      { item: "bad", ok: false, error: "project failed" },
      { item: "later", ok: true, value: "later" },
    ]);
  });

  it("rejects invalid concurrency instead of silently running unbounded", async () => {
    await expect(runProjectWorkerPool(["a"], 0, async (item) => item)).rejects.toThrow(/concurrency/i);
  });
});
