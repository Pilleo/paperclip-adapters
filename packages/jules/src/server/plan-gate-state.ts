/**
 * Reconciles the narrow boundary between Jules' provider state and Paperclip's
 * native plan-review card.  A provider can still be awaiting approval after a
 * card is deliberately withdrawn while a PR rejection is being handed off.
 * That withdrawal is adapter-owned, so it may be restored; every other
 * cancellation remains fail-closed for an operator to inspect.
 *
 * Keep this reducer independent of API shapes.  Both heartbeat recovery and
 * an operator repair command can therefore make the same conservative choice.
 */
export type PlanGateProviderState =
  | "QUEUED"
  | "PLANNING"
  | "IN_PROGRESS"
  | "AWAITING_USER_FEEDBACK"
  | "AWAITING_PLAN_APPROVAL"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "UNKNOWN";

export interface PlanGateInteraction {
  readonly status: "pending" | "answered" | "cancelled" | "unknown";
  readonly cancellationReason?: string | undefined;
}

export interface PlanGateObservation {
  readonly providerState: PlanGateProviderState;
  readonly hasUnresolvedProviderQuestion: boolean;
  readonly matchingInteraction?: PlanGateInteraction | undefined;
  /** A cancelled card consumes an immutable idempotency key; bound reopen attempts. */
  readonly recoveryAttempts?: number | undefined;
}

export type PlanGateDecision =
  | { readonly action: "restore" }
  | { readonly action: "await_card" }
  | { readonly action: "await_provider" }
  | { readonly action: "await_provider_question" }
  | { readonly action: "manual_recovery_required" };

/** Reasons written exclusively by adapter control flow, never reviewer prose. */
export const RESTORABLE_PLAN_GATE_CANCELLATION_REASONS = new Set<string>([
  "Superseded by structured PR rejection for the same Jules session and immutable PR head.",
  "Superseded plan-review card: an immutable matching PR review card is the active native review authority.",
]);

export interface RecoveredPlanGatePointer {
  readonly interactionId: string;
  readonly activityId: string;
  readonly question: string;
  readonly documentId: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly reviewerAgentId: string;
  readonly stage: "luna" | "terra";
}

interface RawPlanGateCard {
  kind?: unknown; status?: unknown; id?: unknown; idempotencyKey?: unknown; addresseeAgentId?: unknown;
  result?: unknown; payload?: unknown;
}
interface RawPlanTarget {
  type?: unknown; issueId?: unknown; key?: unknown; documentId?: unknown; revisionId?: unknown; revisionNumber?: unknown;
}

/**
 * Rebuilds a lost local pointer from the immutable fields of one cancelled
 * native card. This is intentionally narrower than general interaction
 * discovery: the card must be the exact session's v2 key, have a typed plan
 * target, and carry one adapter-owned cancellation reason.
 */
export function recoverMissingPlanGatePointer(input: {
  readonly issueId: string;
  readonly sessionId: string;
  readonly latestPlanActivityId: string;
  readonly interactions: readonly unknown[];
}): RecoveredPlanGatePointer | null {
  const prefix = `jules:plan-review:v2:${input.issueId}:${input.sessionId}:`;
  const candidates = input.interactions.flatMap((value): RecoveredPlanGatePointer[] => {
    if (!value || typeof value !== "object") return [];
    const card = value as RawPlanGateCard;
    if (card.kind !== "request_item_verdicts" || card.status !== "cancelled" || typeof card.id !== "string" ||
        typeof card.idempotencyKey !== "string" || !card.idempotencyKey.startsWith(prefix) ||
        typeof card.addresseeAgentId !== "string") return [];
    const result = card.result && typeof card.result === "object" ? card.result as { reason?: unknown } : undefined;
    if (!result || typeof result.reason !== "string" || !RESTORABLE_PLAN_GATE_CANCELLATION_REASONS.has(result.reason)) return [];
    const payload = card.payload && typeof card.payload === "object" ? card.payload as { target?: unknown; detailsMarkdown?: unknown } : undefined;
    const target = payload?.target && typeof payload.target === "object" ? payload.target as RawPlanTarget : undefined;
    const question = payload?.detailsMarkdown;
    const keyParts = card.idempotencyKey.split(":");
    const stage = keyParts.at(6);
    if (!target || target.type !== "issue_document" || target.issueId !== input.issueId || target.key !== "plan" ||
        typeof target.documentId !== "string" || typeof target.revisionId !== "string" ||
        !Number.isInteger(target.revisionNumber) || (stage !== "luna" && stage !== "terra") || typeof question !== "string") return [];
    return [{ interactionId: card.id, activityId: input.latestPlanActivityId, question, documentId: target.documentId,
      revisionId: target.revisionId, revisionNumber: target.revisionNumber as number, reviewerAgentId: card.addresseeAgentId, stage }];
  });
  return candidates.length === 1 ? candidates[0]! : null;
}

export function decidePlanGateRecovery(input: PlanGateObservation): PlanGateDecision {
  if (input.providerState !== "AWAITING_PLAN_APPROVAL") return { action: "await_provider" };
  if (input.hasUnresolvedProviderQuestion) return { action: "await_provider_question" };
  if (!input.matchingInteraction) return { action: "manual_recovery_required" };

  switch (input.matchingInteraction.status) {
    case "pending":
    case "answered":
      return { action: "await_card" };
    case "cancelled":
      return input.recoveryAttempts !== undefined && input.recoveryAttempts >= 3
        ? { action: "manual_recovery_required" }
        : RESTORABLE_PLAN_GATE_CANCELLATION_REASONS.has(input.matchingInteraction.cancellationReason ?? "")
        ? { action: "restore" }
        : { action: "manual_recovery_required" };
    case "unknown":
      return { action: "manual_recovery_required" };
    default:
      return assertNever(input.matchingInteraction.status);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled plan-gate interaction status: ${String(value)}`);
}
