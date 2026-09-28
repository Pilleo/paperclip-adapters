import { describe, expect, it } from "vitest";
import { decidePlanProviderAction } from "../src/server/plan-provider-decision.js";

const base = { sessionId: "session-1", checkpointSessionId: "session-1", planActivityId: "plan-1", planRevisionId: "rev-1",
  latestActivityId: "plan-1", providerState: "AWAITING_PLAN_APPROVAL", historyComplete: true,
  outputCount: 0, verdict: null, effect: null } as const;

describe("provider state versus typed plan verdict", () => {
  it("holds a completed, unapproved provider before consuming a pending native child", () => {
    expect(decidePlanProviderAction({ ...base, providerState: "COMPLETED" }))
      .toEqual({ kind: "wait_for_verdict" });
    expect(decidePlanProviderAction({ ...base, providerState: "COMPLETED", verdict: "approve" }))
      .toEqual({ kind: "approve_once", effectId: "approve:session-1:rev-1" });
    expect(decidePlanProviderAction({ ...base, providerState: "COMPLETED", verdict: "reject" }))
      .toEqual({ kind: "request_revision_once", effectId: "revise:session-1:plan-1" });
    expect(decidePlanProviderAction({ ...base, providerState: "COMPLETED", verdict: "reject", outputCount: 1 }))
      .toEqual({ kind: "hold", reason: "unverified_progress" });
  });
  it("does not treat unapproved IN_PROGRESS as proof of approval", () => {
    expect(decidePlanProviderAction({ ...base, providerState: "IN_PROGRESS", verdict: "approve" }))
      .toEqual({ kind: "hold", reason: "unverified_progress" });
  });
  it("allows a typed verdict only against the exact pending plan", () => {
    expect(decidePlanProviderAction({ ...base, verdict: "approve" })).toEqual({ kind: "approve_once", effectId: "approve:session-1:rev-1" });
    expect(decidePlanProviderAction({ ...base, verdict: "reject" })).toEqual({ kind: "request_revision_once", effectId: "revise:session-1:plan-1" });
  });
  it("waits for attributable evidence after a lost approval response instead of replaying it", () => {
    expect(decidePlanProviderAction({ ...base, verdict: null, effect: { kind: "started", effectId: "approve:session-1:rev-1" } }))
      .toEqual({ kind: "wait_for_verdict" });
    expect(decidePlanProviderAction({ ...base, providerState: "IN_PROGRESS", verdict: "approve",
      effect: { kind: "started", effectId: "approve:session-1:rev-1" } }))
      .toEqual({ kind: "reconcile_started_effect", effectId: "approve:session-1:rev-1" });
    expect(decidePlanProviderAction({ ...base, providerState: "COMPLETED", verdict: "approve",
      effect: { kind: "started", effectId: "approve:session-1:rev-1" } }))
      .toEqual({ kind: "reconcile_started_effect", effectId: "approve:session-1:rev-1" });
    expect(decidePlanProviderAction({ ...base, verdict: "approve", effect: { kind: "confirmed", effectId: "approve:session-1:rev-1" } }))
      .toEqual({ kind: "approve_once", effectId: "approve:session-1:rev-1" });
    expect(decidePlanProviderAction({ ...base, verdict: "reject", effect: { kind: "started", effectId: "approve:session-1:rev-1" } }))
      .toEqual({ kind: "hold", reason: "identity_conflict" });
    expect(decidePlanProviderAction({ ...base, verdict: "approve", effect: { kind: "started", effectId: "approve:session-1:plan-1" } }))
      .toEqual({ kind: "hold", reason: "identity_conflict" });
    expect(decidePlanProviderAction({ ...base, providerState: "COMPLETED", verdict: "approve", outputCount: 1,
      effect: { kind: "confirmed", effectId: "approve:session-1:rev-1" } })).toEqual({ kind: "reconcile_recorded_work" });
    expect(decidePlanProviderAction({ ...base, providerState: "COMPLETED", verdict: "approve", outputCount: 1,
      approvalActivityId: "approved-plan-1", effect: { kind: "started", effectId: "approve:session-1:rev-1" } }))
      .toEqual({ kind: "reconcile_started_effect", effectId: "approve:session-1:rev-1" });
    expect(decidePlanProviderAction({ ...base, providerState: "COMPLETED", outputCount: 1,
      approvalActivityId: "approved-plan-1", effect: { kind: "started", effectId: "approve:session-1:rev-1" } }))
      .toEqual({ kind: "wait_for_verdict" });
    expect(decidePlanProviderAction({ ...base, providerState: "COMPLETED", verdict: "approve", outputCount: 1,
      effect: { kind: "started", effectId: "approve:session-1:rev-1" } }))
      .toEqual({ kind: "hold", reason: "unverified_progress" });
    expect(decidePlanProviderAction({ ...base, providerState: "COMPLETED", outputCount: 1,
      effect: { kind: "confirmed", effectId: "approve:session-1:rev-1" } }))
      .toEqual({ kind: "wait_for_verdict" });
    expect(decidePlanProviderAction({ ...base, providerState: "COMPLETED",
      effect: { kind: "confirmed", effectId: "approve:session-1:rev-1" } }))
      .toEqual({ kind: "wait_for_verdict" });
    expect(decidePlanProviderAction({ ...base, providerState: "COMPLETED", verdict: "approve",
      effect: { kind: "confirmed", effectId: "approve:session-1:rev-1" } }))
      .toEqual({ kind: "approve_once", effectId: "approve:session-1:rev-1" });
  });
  it("refuses a different plan, session or incomplete activity history", () => {
    expect(decidePlanProviderAction({ ...base, latestActivityId: "plan-2" })).toEqual({ kind: "hold", reason: "identity_conflict" });
    expect(decidePlanProviderAction({ ...base, latestActivityId: null, verdict: "approve", providerState: "COMPLETED" }))
      .toEqual({ kind: "hold", reason: "identity_conflict" });
    expect(decidePlanProviderAction({ ...base, checkpointSessionId: "session-2" })).toEqual({ kind: "hold", reason: "identity_conflict" });
    expect(decidePlanProviderAction({ ...base, historyComplete: false })).toEqual({ kind: "hold", reason: "incomplete_history" });
  });
});
