import { describe, expect, it } from "vitest";
import { canReconcileManagedFleet } from "../src/core/fleet-manager.js";

describe("canReconcileManagedFleet", () => {
  it.each([
    ["http://localhost:3100", undefined, true, true],
    ["http://127.0.0.1:3100", "", true, true],
    ["http://localhost:3100", undefined, false, false],
    ["https://paperclip.example", undefined, true, false],
    ["https://paperclip.example", "agent-token", true, true],
  ] as const)("returns %s / token=%s / enabled=%s => %s", (apiUrl, token, enabled, expected) => {
    expect(canReconcileManagedFleet(apiUrl, token, enabled)).toBe(expected);
  });
});
