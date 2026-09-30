import { describe, expect, it } from "vitest";
import {
  beginEffect,
  classifyInterruptedEffect,
  confirmEffect,
  LifecycleEffectJournalSchema,
  retryStartedEffect,
  type LifecycleEffectJournal,
} from "../src/server/lifecycle-effect-journal.js";
import { reconcileNativePlanEffect } from "../src/server/native-plan-effect-reconciler.js";

function nativeRetryAuthorization(revisionId = "rev-1") {
  const result = reconcileNativePlanEffect({ kind: "create_card", reviewer: "terra", revisionId }, { card: { kind: "absent" } });
  if (result.kind !== "retry_safe") throw new Error("Fixture did not prove native-card absence");
  return result.authorization;
}

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

  it("never replaces an already confirmed effect receipt", () => {
    const started = beginEffect({ version: 1, effects: [] }, {
      effectId: "card:terra:rev-1", kind: "create_card", startedAt: "2026-09-20T00:00:00Z",
    });
    const confirmed = confirmEffect(started, "card:terra:rev-1", "native-card-1");
    expect(confirmEffect(confirmed, "card:terra:rev-1", "native-card-1")).toEqual(confirmed);
    expect(() => confirmEffect(confirmed, "card:terra:rev-1", "different-card")).toThrow("receipt conflict");
    expect(confirmed.effects[0]?.attempt).toEqual({ kind: "confirmed", receipt: "native-card-1" });
  });

  it("accepts durable entries for each typed native-plan mutation", () => {
    const journal = LifecycleEffectJournalSchema.parse({
      version: 1,
      effects: [
        { effectId: "card:terra:rev-1", kind: "create_card", attempt: { kind: "started", startedAt: "2026-09-20T00:00:00.000Z" } },
        { effectId: "approve:session-1:rev-1", kind: "approve_plan", attempt: { kind: "started", startedAt: "2026-09-20T00:00:00.000Z" } },
        { effectId: "revision:card-1:run-luna-1", kind: "request_plan_revision", attempt: { kind: "started", startedAt: "2026-09-20T00:00:00.000Z" } },
        { effectId: "replace-plan-card:issue-1:key", kind: "replace_plan_card", attempt: { kind: "started", startedAt: "2026-09-20T00:00:00.000Z" } },
        { effectId: "recover-plan-dispatch:issue-1:card-1", kind: "recover_plan_dispatch", attempt: { kind: "started", startedAt: "2026-09-20T00:00:00.000Z" } },
      ],
    });

    expect(journal.effects.map((effect) => effect.kind)).toEqual(["create_card", "approve_plan", "request_plan_revision", "replace_plan_card", "recover_plan_dispatch"]);
  });

  it("permits one verified retry and refuses a third native-plan attempt", () => {
    const started: LifecycleEffectJournal = {
      version: 1,
      effects: [{
        effectId: "card:terra:rev-1",
        kind: "create_card",
        attempt: { kind: "started", startedAt: "2026-09-20T00:00:00.000Z" },
      }],
    };

    const retried = retryStartedEffect(started, "card:terra:rev-1", "2026-09-20T00:01:00.000Z", nativeRetryAuthorization());
    expect(retried.effects[0]?.attempt).toEqual({
      kind: "started", startedAt: "2026-09-20T00:01:00.000Z", attempts: 2,
    });
    expect(() => retryStartedEffect(retried, "card:terra:rev-1", "2026-09-20T00:02:00.000Z", nativeRetryAuthorization())).toThrow(
      "retry limit",
    );
  });

  it.each(["send_provider_message", "approve_plan", "request_plan_revision", "legacy_unknown"] as const)(
    "refuses generic replay of an uncertain %s effect", (kind) => {
      const journal = beginEffect({ version: 1, effects: [] }, {
        effectId: "card:terra:rev-1", kind, startedAt: "2026-09-20T00:00:00.000Z",
      });
      expect(() => retryStartedEffect(journal, "card:terra:rev-1", "2026-09-20T00:01:00.000Z", nativeRetryAuthorization()))
        .toThrow("not replayable");
      expect(journal.effects[0]?.attempt).toMatchObject({ kind: "started", attempts: 1 });
    },
  );

  it("rejects a forged retry authorization at the runtime boundary", () => {
    const journal = beginEffect({ version: 1, effects: [] }, {
      effectId: "card:terra:rev-1", kind: "create_card", startedAt: "2026-09-20T00:00:00Z",
    });
    expect(() => retryStartedEffect(journal, "card:terra:rev-1", "2026-09-20T00:01:00Z",
      { effectId: "card:terra:rev-1" } as never)).toThrow("retry authorization");
  });

  it("does not reuse a copied retry authorization for another card identity", () => {
    const journal = beginEffect({ version: 1, effects: [] }, {
      effectId: "card:terra:rev-2", kind: "create_card", startedAt: "2026-09-20T00:00:00Z",
    });
    expect(() => retryStartedEffect(journal, "card:terra:rev-2", "2026-09-20T00:01:00Z",
      { ...nativeRetryAuthorization(), effectId: "card:terra:rev-2" } as never)).toThrow("retry authorization");
  });
});
