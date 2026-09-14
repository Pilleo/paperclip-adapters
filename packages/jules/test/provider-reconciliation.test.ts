import { describe, expect, it } from "vitest";
import { reconcileProviderState, selectTerminalPullRequestUrl } from "../src/server/provider-reconciliation.js";

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

  it.each([
    {
      name: "completed provider session with no fresh output",
      state: "COMPLETED" as const,
      discovered: undefined,
      persisted: "https://github.com/Pilleo/paperclip-adapters/pull/8",
      expected: "https://github.com/Pilleo/paperclip-adapters/pull/8",
    },
    {
      name: "failed provider session with no fresh output",
      state: "FAILED" as const,
      discovered: undefined,
      persisted: "https://github.com/Pilleo/paperclip-adapters/pull/8",
      expected: "https://github.com/Pilleo/paperclip-adapters/pull/8",
    },
    {
      name: "terminal provider session with a new authoritative handoff",
      state: "COMPLETED" as const,
      discovered: "https://github.com/Pilleo/paperclip-adapters/pull/9",
      persisted: "https://github.com/Pilleo/paperclip-adapters/pull/8",
      expected: "https://github.com/Pilleo/paperclip-adapters/pull/9",
    },
    {
      name: "nonterminal provider session with a stale persisted handoff",
      state: "IN_PROGRESS" as const,
      discovered: undefined,
      persisted: "https://github.com/Pilleo/paperclip-adapters/pull/8",
      expected: undefined,
    },
  ])("selects the correct PR identity for $name", ({ state, discovered, persisted, expected }) => {
    expect(selectTerminalPullRequestUrl({ state, discovered, persisted })).toBe(expected);
  });
});
