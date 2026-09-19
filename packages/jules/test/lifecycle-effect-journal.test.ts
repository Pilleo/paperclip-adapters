import { describe, expect, it } from "vitest";
import {
  beginEffect,
  classifyInterruptedEffect,
  confirmEffect,
  type LifecycleEffectJournal,
} from "../src/server/lifecycle-effect-journal.js";

describe("durable lifecycle effect journal", () => {
  it.each<readonly [string, LifecycleEffectJournal, "execute" | "reconcile" | "observe"]>([
    ["has no durable effect before a write", { version: 1, effects: [] }, "execute"],
    [
      "reconciles an effect that may have escaped before interruption",
      { version: 1, effects: [{ effectId: "verdict:card-1", kind: "deliver_verdict", attempt: { kind: "started", startedAt: "2026-09-20T00:00:00.000Z" } }] },
      "reconcile",
    ],
    [
      "only observes after a receipt confirms delivery",
      { version: 1, effects: [{ effectId: "verdict:card-1", kind: "deliver_verdict", attempt: { kind: "confirmed", receipt: "activity-1" } }] },
      "observe",
    ],
  ])("%s", (_label, journal, expected) => {
    expect(classifyInterruptedEffect(journal, "verdict:card-1")).toEqual({ action: expected });
  });

  it("keeps one deterministic journal entry while moving it from started to confirmed", () => {
    const started = beginEffect(
      { version: 1, effects: [] },
      { effectId: "verdict:card-1", kind: "deliver_verdict", startedAt: "2026-09-20T00:00:00.000Z" },
    );
    const confirmed = confirmEffect(started, "verdict:card-1", "activity-1");

    expect(confirmed).toEqual({
      version: 1,
      effects: [{
        effectId: "verdict:card-1",
        kind: "deliver_verdict",
        attempt: { kind: "confirmed", receipt: "activity-1" },
      }],
    });
  });
});
