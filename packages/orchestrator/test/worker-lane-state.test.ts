import { describe, expect, it } from "vitest";
import { resolveWorkerLaneCapacity } from "../src/core/worker-lane-state.js";

describe("worker lane state", () => {
  it.each([
    { status: "idle", expected: 3 },
    { status: "running", expected: 3 },
    { status: "paused", expected: 0 },
    { status: "error", expected: 0 },
  ])("uses managed-agent availability for the $status Vibe lane", ({ status, expected }) => {
    expect(resolveWorkerLaneCapacity({ lane: "vibe", configuredCapacity: 3, runningCount: 0, agentStatus: status })).toBe(expected);
  });

  it("keeps the configured Jules queue open without provider session observations", () => {
    expect(resolveWorkerLaneCapacity({ lane: "jules", configuredCapacity: 7, runningCount: 2, agentStatus: "idle" })).toBe(7);
  });
});
