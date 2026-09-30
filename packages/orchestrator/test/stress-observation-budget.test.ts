import { describe, expect, it } from "vitest";
import { decideObservationWindow } from "../src/core/stress-observation-budget.js";

describe("bounded observation is separate from human decision time", () => {
  it.each(["awaiting_user_start", "awaiting_user_merge"] as const)("preserves %s after observer window ends", (kind) => {
    expect(decideObservationWindow(kind, true)).toEqual({ action: "stop_waiting_for_user", waitingFor: kind });
    expect(decideObservationWindow(kind, false)).toEqual({ action: "observe" });
  });
  it("keeps an automated observation deadline distinct from workflow failure", () => {
    expect(decideObservationWindow("awaiting_provider", true)).toEqual({ action: "automation_window_ended" });
    expect(decideObservationWindow("awaiting_provider", false)).toEqual({ action: "observe" });
  });
  it.each(["passed", "recovered"] as const)("stops when the outcome is %s", (kind) => {
    expect(decideObservationWindow(kind, false)).toEqual({ action: "complete" });
  });
  it.each(["invalid", "failed"] as const)("retains actual %s workflow evidence", (kind) => {
    expect(decideObservationWindow(kind, true)).toEqual({ action: "workflow_error" });
  });
});
