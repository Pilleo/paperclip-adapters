/**
 * Native review cards can only be addressed to agents Paperclip considers
 * invokable. Keep this decision pure so dispatch cannot accidentally turn an
 * unavailable reviewer into a heartbeat retry loop.
 */
export type ReviewerEligibility =
  | { readonly kind: "eligible"; readonly transport?: DecisionTransport }
  | { readonly kind: "unavailable"; readonly reason: string };

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
