import { describe, expect, it } from "vitest";
import { evaluateCompletionTransition } from "../src/server/transition-guards.js";

describe("Jules transition guards", () => {
  it("allows completion only with completed provider and merged PR evidence", () => {
    expect(evaluateCompletionTransition({ providerState: "COMPLETED", prMerged: true, mutationPending: false }))
      .toEqual({ allowed: true });
  });

  it.each([
    ["UNKNOWN", false, false, "provider_state_unknown"],
    ["IN_PROGRESS", true, false, "provider_not_terminal"],
    ["COMPLETED", false, false, "pr_not_merged"],
    ["COMPLETED", true, true, "pending_mutation"],
  ] as const)("rejects unsafe completion (%s)", (providerState, prMerged, mutationPending, reason) => {
    expect(evaluateCompletionTransition({ providerState, prMerged, mutationPending })).toEqual({ allowed: false, reason });
  });
});
