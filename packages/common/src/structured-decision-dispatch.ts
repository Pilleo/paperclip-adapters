import {
  selectDecisionTransport,
  validateStructuredDecision,
  type DecisionKind,
  type DecisionTransport,
  type StructuredDecision,
  type StructuredDecisionCapability,
} from "./structured-decision.js";

export interface StructuredDecisionRequest {
  readonly decisionKind: DecisionKind;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type StructuredDecisionTransportHandler = (request: StructuredDecisionRequest) => Promise<unknown>;
export type StructuredDecisionTransportRegistry = Partial<Record<DecisionTransport, StructuredDecisionTransportHandler>>;

export type StructuredDecisionDispatchResult =
  | { readonly status: "submitted"; readonly transport: DecisionTransport; readonly decision: StructuredDecision }
  | { readonly status: "failed"; readonly reason: "decision_kind_not_supported" | "transport_not_available" | "transport_handler_missing" | "invalid_structured_decision" | "transport_error" };

/** Shared opt-in adapter boundary. No transport may degrade to comments/prose. */
export async function dispatchStructuredDecision(input: {
  readonly capability: StructuredDecisionCapability;
  readonly decisionKind: DecisionKind;
  readonly preference: readonly DecisionTransport[];
  readonly payload: Readonly<Record<string, unknown>>;
  readonly transports: StructuredDecisionTransportRegistry;
}): Promise<StructuredDecisionDispatchResult> {
  const selection = selectDecisionTransport(input.capability, input.decisionKind, input.preference);
  if (selection.status === "unsupported") return { status: "failed", reason: selection.reason };
  const handler = input.transports[selection.transport];
  if (!handler) return { status: "failed", reason: "transport_handler_missing" };
  try {
    const decision = validateStructuredDecision(await handler({ decisionKind: input.decisionKind, payload: input.payload }));
    return decision
      ? { status: "submitted", transport: selection.transport, decision }
      : { status: "failed", reason: "invalid_structured_decision" };
  } catch {
    return { status: "failed", reason: "transport_error" };
  }
}
