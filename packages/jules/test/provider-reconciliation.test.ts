import { describe, expect, it } from "vitest";
import { reconcileProviderState } from "../src/server/provider-reconciliation.js";

describe("reconcileProviderState", () => {
  it.each(["QUEUED", "PLANNING", "IN_PROGRESS", "AWAITING_USER_FEEDBACK", "AWAITING_PLAN_APPROVAL"] as const)(
    "treats a successful remote %s poll as live even with a stale completed PR checkpoint",
    (remoteState) => {
      expect(reconcileProviderState({ remoteState, persistedPhase: "COMPLETED", hasPersistedPr: true, remotePollSucceeded: true }))
        .toEqual({ action: "continue_live", clearStalePr: true });
    },
  );

  it.each(["COMPLETED", "FAILED"] as const)("allows terminal handling only for a successful remote %s poll", (remoteState) => {
    expect(reconcileProviderState({ remoteState, persistedPhase: "RUNNING", hasPersistedPr: true, remotePollSucceeded: true }))
      .toEqual({ action: "handle_terminal" });
  });

  it("never infers a terminal disposition from persisted state after a failed poll", () => {
    expect(reconcileProviderState({ remoteState: "UNKNOWN", persistedPhase: "COMPLETED", hasPersistedPr: true, remotePollSucceeded: false }))
      .toEqual({ action: "retain_retry" });
  });
});
