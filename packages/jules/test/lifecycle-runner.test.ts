import { describe, expect, it, vi } from "vitest";
import type { JulesLifecycleState } from "@pilleo/paperclip-adapter-common";
import { runJulesLifecycle } from "../src/server/lifecycle-runner.js";

const lunaApproved: JulesLifecycleState = {
  provider: { kind: "awaiting_plan", sessionId: "session-1", revisionId: "revision-1" },
  review: { kind: "resolved", cardId: "card-luna", revisionId: "revision-1", reviewer: "luna", verdict: "approve", runId: "run-luna-1" },
  effect: { kind: "not_started" },
  monitor: { kind: "scheduled", monitorId: "monitor-1" },
};

describe("runJulesLifecycle", () => {
  it("journals Luna approval before creating exactly one Terra native card", async () => {
    const persistJournal = vi.fn().mockResolvedValue(undefined);
    const createCard = vi.fn().mockResolvedValue({ receipt: "card-terra" });

    const result = await runJulesLifecycle({
      state: lunaApproved,
      event: { kind: "heartbeat" },
      journal: { version: 1, effects: [] },
      now: "2026-09-20T00:00:00.000Z",
      dependencies: { persistJournal, createCard },
    });

    expect(persistJournal).toHaveBeenNthCalledWith(1, {
      version: 1,
      effects: [{ effectId: "card:terra:revision-1", kind: "create_card", attempt: { kind: "started", startedAt: "2026-09-20T00:00:00.000Z", attempts: 1 } }],
    });
    expect(createCard).toHaveBeenCalledExactlyOnceWith({ reviewer: "terra", revisionId: "revision-1" });
    expect(persistJournal).toHaveBeenLastCalledWith({
      version: 1,
      effects: [{ effectId: "card:terra:revision-1", kind: "create_card", attempt: { kind: "confirmed", receipt: "card-terra" } }],
    });
    expect(result.effect).toEqual({ kind: "create_card", reviewer: "terra", revisionId: "revision-1" });
  });

  it("uses Jules typed approval once after Terra approves", async () => {
    const persistJournal = vi.fn().mockResolvedValue(undefined);
    const approvePlan = vi.fn().mockResolvedValue({ receipt: "approved-revision-1" });

    const result = await runJulesLifecycle({
      state: { ...lunaApproved, review: { kind: "resolved", cardId: "card-terra", revisionId: "revision-1", reviewer: "terra", verdict: "approve", runId: "run-terra-1" } },
      event: { kind: "heartbeat" },
      journal: { version: 1, effects: [] },
      now: "2026-09-20T00:00:00.000Z",
      dependencies: { persistJournal, approvePlan },
    });

    expect(approvePlan).toHaveBeenCalledExactlyOnceWith({ sessionId: "session-1", revisionId: "revision-1" });
    expect(result.journal.effects).toEqual([{ effectId: "approve:session-1:revision-1", kind: "approve_plan", attempt: { kind: "confirmed", receipt: "approved-revision-1" } }]);
  });

  it("prepares exactly one revision request after a native rejection", async () => {
    const persistJournal = vi.fn().mockResolvedValue(undefined);
    const requestPlanRevision = vi.fn().mockResolvedValue({ receipt: "revision-request-1" });

    const result = await runJulesLifecycle({
      state: { ...lunaApproved, review: { kind: "resolved", cardId: "card-luna", revisionId: "revision-1", reviewer: "luna", verdict: "reject", runId: "run-luna-1" } },
      event: { kind: "heartbeat" },
      journal: { version: 1, effects: [] },
      now: "2026-09-20T00:00:00.000Z",
      dependencies: { persistJournal, requestPlanRevision },
    });

    expect(requestPlanRevision).toHaveBeenCalledExactlyOnceWith({ cardId: "card-luna", revisionId: "revision-1", reviewer: "luna", runId: "run-luna-1" });
    expect(result.journal.effects).toEqual([{ effectId: "revision:card-luna:run-luna-1", kind: "request_plan_revision", attempt: { kind: "confirmed", receipt: "revision-request-1" } }]);
  });

  it("does not duplicate a confirmed Terra-card creation on a repeated heartbeat", async () => {
    const persistJournal = vi.fn().mockResolvedValue(undefined);
    const createCard = vi.fn().mockResolvedValue({ receipt: "unexpected" });

    const result = await runJulesLifecycle({
      state: { ...lunaApproved, effect: { kind: "confirmed", effectId: "card:terra:revision-1", receipt: "card-terra" } },
      event: { kind: "heartbeat" },
      journal: { version: 1, effects: [{ effectId: "card:terra:revision-1", kind: "create_card", attempt: { kind: "confirmed", receipt: "card-terra" } }] },
      now: "2026-09-20T00:01:00.000Z",
      dependencies: { persistJournal, createCard },
    });

    expect(createCard).not.toHaveBeenCalled();
    expect(persistJournal).not.toHaveBeenCalled();
    expect(result.effect).toEqual({ kind: "poll_provider", sessionId: "session-1" });
  });

  it("reconciles a started Terra-card creation after interruption instead of creating another card", async () => {
    const persistJournal = vi.fn().mockResolvedValue(undefined);
    const createCard = vi.fn().mockResolvedValue({ receipt: "unexpected" });
    const reconcileNativePlanEffect = vi.fn().mockResolvedValue({ kind: "confirmed", receipt: "card-terra" } as const);

    const result = await runJulesLifecycle({
      state: { ...lunaApproved, effect: { kind: "started", effectId: "card:terra:revision-1", startedAt: "2026-09-20T00:00:00.000Z" } },
      event: { kind: "heartbeat" },
      journal: { version: 1, effects: [{ effectId: "card:terra:revision-1", kind: "create_card", attempt: { kind: "started", startedAt: "2026-09-20T00:00:00.000Z" } }] },
      now: "2026-09-20T00:01:00.000Z",
      dependencies: { persistJournal, createCard, reconcileNativePlanEffect },
    });

    expect(reconcileNativePlanEffect).toHaveBeenCalledExactlyOnceWith({
      effect: { kind: "create_card", reviewer: "terra", revisionId: "revision-1" },
      effectId: "card:terra:revision-1",
    });
    expect(createCard).not.toHaveBeenCalled();
    expect(persistJournal).toHaveBeenCalledExactlyOnceWith({
      version: 1,
      effects: [{ effectId: "card:terra:revision-1", kind: "create_card", attempt: { kind: "confirmed", receipt: "card-terra" } }],
    });
    expect(result.journal.effects[0]?.attempt).toEqual({ kind: "confirmed", receipt: "card-terra" });
  });

  it("defers a started effect whose remote outcome is not yet observable", async () => {
    const persistJournal = vi.fn().mockResolvedValue(undefined);
    const createCard = vi.fn();
    const reconcileNativePlanEffect = vi.fn().mockResolvedValue({ kind: "await_observation" } as const);

    const result = await runJulesLifecycle({
      state: { ...lunaApproved, effect: { kind: "started", effectId: "card:terra:revision-1", startedAt: "2026-09-20T00:00:00.000Z" } },
      event: { kind: "heartbeat" },
      journal: { version: 1, effects: [{ effectId: "card:terra:revision-1", kind: "create_card", attempt: { kind: "started", startedAt: "2026-09-20T00:00:00.000Z" } }] },
      now: "2026-09-20T00:01:00.000Z",
      dependencies: { persistJournal, createCard, reconcileNativePlanEffect },
    });

    expect(createCard).not.toHaveBeenCalled();
    expect(persistJournal).not.toHaveBeenCalled();
    expect(result.disposition).toBe("deferred");
  });

  it("replays a started card creation only after reconciliation proves retry safety", async () => {
    const persistJournal = vi.fn().mockResolvedValue(undefined);
    const createCard = vi.fn().mockResolvedValue({ receipt: "terra-card-2" });
    const reconcileNativePlanEffect = vi.fn().mockResolvedValue({ kind: "retry_safe" } as const);

    const result = await runJulesLifecycle({
      state: { ...lunaApproved, effect: { kind: "started", effectId: "card:terra:revision-1", startedAt: "2026-09-20T00:00:00.000Z" } },
      event: { kind: "heartbeat" },
      journal: { version: 1, effects: [{ effectId: "card:terra:revision-1", kind: "create_card", attempt: { kind: "started", startedAt: "2026-09-20T00:00:00.000Z", attempts: 1 } }] },
      now: "2026-09-20T00:01:00.000Z",
      dependencies: { persistJournal, createCard, reconcileNativePlanEffect },
    });

    expect(createCard).toHaveBeenCalledExactlyOnceWith({ reviewer: "terra", revisionId: "revision-1" });
    expect(result.journal.effects[0]?.attempt).toEqual({ kind: "confirmed", receipt: "terra-card-2" });
    expect(persistJournal).toHaveBeenNthCalledWith(1, {
      version: 1,
      effects: [{ effectId: "card:terra:revision-1", kind: "create_card", attempt: { kind: "started", startedAt: "2026-09-20T00:01:00.000Z", attempts: 2 } }],
    });
  });

  it("reconciles a started Terra approval after Jules has progressed", async () => {
    const persistJournal = vi.fn().mockResolvedValue(undefined);
    const reconcileNativePlanEffect = vi.fn().mockResolvedValue({
      kind: "confirmed",
      receipt: "provider:IN_PROGRESS",
    } as const);

    const result = await runJulesLifecycle({
      state: {
        provider: { kind: "in_progress", sessionId: "session-1" },
        review: {
          kind: "resolved",
          cardId: "card-terra",
          revisionId: "revision-1",
          reviewer: "terra",
          verdict: "approve",
          runId: "run-terra-1",
        },
        effect: {
          kind: "started",
          effectId: "approve:session-1:revision-1",
          startedAt: "2026-09-20T00:00:00.000Z",
        },
        monitor: { kind: "scheduled", monitorId: "monitor-1" },
      },
      event: { kind: "run_interrupted" },
      journal: {
        version: 1,
        effects: [{
          effectId: "approve:session-1:revision-1",
          kind: "approve_plan",
          attempt: { kind: "started", startedAt: "2026-09-20T00:00:00.000Z", attempts: 1 },
        }],
      },
      now: "2026-09-20T00:01:00.000Z",
      dependencies: { persistJournal, reconcileNativePlanEffect },
    });

    expect(reconcileNativePlanEffect).toHaveBeenCalledExactlyOnceWith({
      effect: { kind: "approve_plan", sessionId: "session-1", revisionId: "revision-1" },
      effectId: "approve:session-1:revision-1",
    });
    expect(result.journal.effects[0]?.attempt).toEqual({ kind: "confirmed", receipt: "provider:IN_PROGRESS" });
    expect(result.disposition).toBe("executed");
  });
});
