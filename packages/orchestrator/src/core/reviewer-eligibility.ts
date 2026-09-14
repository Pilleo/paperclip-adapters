/**
 * Native review cards can only be addressed to agents Paperclip considers
 * invokable. Keep this decision pure so dispatch cannot accidentally turn an
 * unavailable reviewer into a heartbeat retry loop.
 */
export type ReviewerEligibility =
  | { readonly kind: "eligible"; readonly transport?: DecisionTransport }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * The executor must distinguish a valid review dispatch from every reason it
 * cannot dispatch.  Keeping this as a discriminated union prevents a malformed
 * fleet projection from becoming a silent `continue` that strands an issue in
 * `in_review` without either a card or an operator-visible recovery state.
 */
export type NativeReviewDispatchPlan =
  | { readonly kind: "dispatch"; readonly targetAgentId: string; readonly transport?: DecisionTransport }
  | { readonly kind: "missing_target"; readonly reason: string }
  | { readonly kind: "unmanaged_target"; readonly targetAgentId: string; readonly reason: string }
  | { readonly kind: "reviewer_unavailable"; readonly targetAgentId: string; readonly reason: string };

const INVOKABLE_STATUSES = new Set(["idle", "running", "busy"]);

export function evaluateReviewerEligibility(status: string | undefined): ReviewerEligibility {
  if (status && INVOKABLE_STATUSES.has(status)) return { kind: "eligible" };
  return {
    kind: "unavailable",
    reason: status ? `reviewer status is ${status}` : "reviewer status is unknown",
  };
}

const TRANSPORT_PREFERENCE: readonly DecisionTransport[] = ["mcp_tool", "acp_tool", "adapter_callback"];

/**
 * Fails closed before a model is invoked unless the agent advertises a
 * runtime-validated, non-prose decision channel for the requested operation.
 */
export function evaluateStructuredReviewerEligibility(
  status: string | undefined,
  rawCapability: unknown,
  rawDecisionKind: DecisionKind,
): ReviewerEligibility {
  const statusEligibility = evaluateReviewerEligibility(status);
  if (statusEligibility.kind === "unavailable") return statusEligibility;
  if (rawCapability === undefined) {
    return { kind: "unavailable", reason: "structured decision capability is missing" };
  }
  const capability = StructuredDecisionCapabilitySchema.safeParse(rawCapability);
  const decisionKind = DecisionKindSchema.safeParse(rawDecisionKind);
  if (!capability.success || !decisionKind.success) {
    return { kind: "unavailable", reason: "structured decision capability is invalid" };
  }
  const selection = selectDecisionTransport(capability.data, decisionKind.data, TRANSPORT_PREFERENCE);
  return selection.status === "supported"
    ? { kind: "eligible", transport: selection.transport }
    : { kind: "unavailable", reason: selection.reason };
}

/** Pure preflight for every native review-card creation attempt. */
export function planNativeReviewDispatch(input: {
  readonly targetAgentId?: string | undefined;
  readonly managedAgentIds: ReadonlySet<string>;
  readonly status?: string | undefined;
  readonly capability: unknown;
  readonly decisionKind?: DecisionKind | undefined;
}): NativeReviewDispatchPlan {
  if (!input.targetAgentId) {
    return { kind: "missing_target", reason: "review pipeline supplied no target agent" };
  }
  if (!input.managedAgentIds.has(input.targetAgentId)) {
    return {
      kind: "unmanaged_target",
      targetAgentId: input.targetAgentId,
      reason: "review pipeline target is not managed by this orchestrator",
    };
  }
  const eligibility = evaluateStructuredReviewerEligibility(
    input.status,
    input.capability,
    input.decisionKind ?? "pull_request_review",
  );
  if (eligibility.kind === "unavailable") {
    return { kind: "reviewer_unavailable", targetAgentId: input.targetAgentId, reason: eligibility.reason };
  }
  return { kind: "dispatch", targetAgentId: input.targetAgentId, ...(eligibility.transport ? { transport: eligibility.transport } : {}) };
}

export function isReviewerEligibilityFailure(status: number, text: string): boolean {
  if (status === 401 || status === 403) return true;
  if (status !== 422) return false;
  return /not invokable|paused|offline|process[- ]?lost|agent.*(?:error|unavailable)/i.test(text);
}
import {
  DecisionKindSchema,
  StructuredDecisionCapabilitySchema,
  selectDecisionTransport,
  type DecisionKind,
  type DecisionTransport,
} from "@pilleo/paperclip-adapter-common";
