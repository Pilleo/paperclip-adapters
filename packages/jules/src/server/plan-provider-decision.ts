export type PlanProviderAction =
  | { readonly kind: "wait_for_verdict" }
  | { readonly kind: "approve_once"; readonly effectId: string }
  | { readonly kind: "reconcile_started_effect"; readonly effectId: string }
  | { readonly kind: "request_revision_once"; readonly effectId: string }
  | { readonly kind: "reconcile_recorded_work" }
  | { readonly kind: "observe_provider"; readonly reason: "unverified_progress" }
  | { readonly kind: "hold"; readonly reason: "terminal_without_approval" | "identity_conflict" |
      "incomplete_history" | "unverified_progress" };

export interface PlanProviderEvidence {
  readonly sessionId: string;
  readonly checkpointSessionId: string;
  readonly planActivityId: string;
  readonly planRevisionId: string;
  readonly latestActivityId: string | null;
  readonly providerState: string;
  readonly historyComplete: boolean;
  readonly outputCount: number;
  readonly approvalActivityId?: string | null;
  readonly verdict: "approve" | "reject" | null;
  readonly effect: { readonly kind: "started" | "confirmed"; readonly effectId: string } | null;
}

/** Never infer a plan approval from completion or generic provider progress. */
export function decidePlanProviderAction(input: PlanProviderEvidence): PlanProviderAction {
  if (!input.historyComplete) return { kind: "hold", reason: "incomplete_history" };
  if (!input.sessionId || !input.planActivityId || input.checkpointSessionId !== input.sessionId ||
      input.latestActivityId !== input.planActivityId) {
    return { kind: "hold", reason: "identity_conflict" };
  }
  const approval = `approve:${input.sessionId}:${input.planRevisionId}`;
  const revision = `revise:${input.sessionId}:${input.planActivityId}`;
  if (input.effect?.effectId !== undefined && input.effect.effectId !== approval) {
    return { kind: "hold", reason: "identity_conflict" };
  }
  if (input.effect?.kind === "started") {
    if (input.providerState === "FAILED") {
      return { kind: "hold", reason: "terminal_without_approval" };
    }
    if (input.verdict === "reject") return { kind: "hold", reason: "identity_conflict" };
    if (input.providerState === "IN_PROGRESS" && !input.approvalActivityId) {
      return input.outputCount > 0 ? { kind: "hold", reason: "unverified_progress" }
        : { kind: "observe_provider", reason: "unverified_progress" };
    }
    if (input.providerState === "COMPLETED" && input.outputCount > 0) {
      if (!input.approvalActivityId) return { kind: "hold", reason: "unverified_progress" };
      return input.verdict === "approve" ? { kind: "reconcile_started_effect", effectId: approval }
        : input.verdict === null ? { kind: "wait_for_verdict" }
        : { kind: "hold", reason: "identity_conflict" };
    }
    if (input.providerState === "COMPLETED") return input.verdict === "approve"
      ? { kind: "reconcile_started_effect", effectId: approval }
      : { kind: "wait_for_verdict" };
    return input.verdict === "approve"
      ? { kind: "reconcile_started_effect", effectId: approval }
      : { kind: "wait_for_verdict" };
  }
  if (input.providerState === "FAILED") return { kind: "hold", reason: "terminal_without_approval" };
  if (input.providerState === "COMPLETED") {
    if (input.effect?.kind === "confirmed" && input.effect.effectId === approval && input.outputCount === 0) {
      return input.verdict === "approve" ? { kind: "approve_once", effectId: approval }
        : input.verdict === null ? { kind: "wait_for_verdict" }
        : { kind: "hold", reason: "identity_conflict" };
    }
    if (input.effect?.kind === "confirmed" && input.effect.effectId === approval && input.outputCount > 0) {
      return input.verdict === "approve" ? { kind: "reconcile_recorded_work" }
        : input.verdict === null ? { kind: "wait_for_verdict" }
        : { kind: "hold", reason: "unverified_progress" };
    }
    if (input.outputCount > 0) return { kind: "hold", reason: "unverified_progress" };
    // An outputless completed session can accept the exact reviewed plan
    // approval or a typed revision request in that same provider session.
    if (input.effect === null) {
      if (input.verdict === "reject") return { kind: "request_revision_once", effectId: revision };
      if (input.verdict === "approve") return { kind: "approve_once", effectId: approval };
      if (input.verdict === null) return { kind: "wait_for_verdict" };
    }
    return { kind: "hold", reason: "terminal_without_approval" };
  }
  if (input.providerState === "IN_PROGRESS" && input.effect?.kind !== "confirmed") {
    // A state poll is not a failed write, and generic progress is not approval.
    // Keep observing the original session without authorizing remote mutations.
    return input.outputCount > 0 ? { kind: "hold", reason: "unverified_progress" }
      : { kind: "observe_provider", reason: "unverified_progress" };
  }
  if (input.effect?.kind === "confirmed") {
    return input.verdict === "reject" ? { kind: "hold", reason: "identity_conflict" }
      : input.verdict === "approve" ? { kind: "approve_once", effectId: approval }
      : { kind: "wait_for_verdict" };
  }
  if (input.providerState !== "AWAITING_PLAN_APPROVAL") return { kind: "wait_for_verdict" };
  switch (input.verdict) {
    case "approve": return { kind: "approve_once", effectId: approval };
    case "reject": return { kind: "request_revision_once", effectId: revision };
    case null: return { kind: "wait_for_verdict" };
    default: {
      const exhaustive: never = input.verdict;
      return exhaustive;
    }
  }
}
