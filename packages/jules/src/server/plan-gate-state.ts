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
  readonly status: "pending" | "answered" | "cancelled" | "expired" | "unknown";
  readonly cancellationReason?: string | undefined;
}

export interface PlanGateObservation {
  readonly providerState: PlanGateProviderState;
  readonly hasUnresolvedProviderQuestion: boolean;
  readonly matchingInteraction?: PlanGateInteraction | undefined;
}

export type PlanGateDecision =
  | { readonly action: "request_provider_plan_revision"; readonly terminalCard: "cancelled" | "expired" }
  | { readonly action: "await_card" }
  | { readonly action: "await_provider" }
  | { readonly action: "await_provider_question" }
  | { readonly action: "manual_recovery_required" };

/** Reasons written exclusively by adapter control flow, never reviewer prose. */
export const REPLAN_REQUIRED_PLAN_GATE_CANCELLATION_REASONS = new Set<string>([
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
interface RawPlanGatePayload {
  target?: unknown;
  detailsMarkdown?: unknown;
  /** Immutable Jules activity that produced the reviewed plan. */
  providerActivityId?: unknown;
}
interface RawPlanTarget {
  type?: unknown; issueId?: unknown; key?: unknown; documentId?: unknown; revisionId?: unknown; revisionNumber?: unknown;
}

/**
 * Rebuilds a lost local pointer from one exact native card.  A persisted
 * session ID can survive an owner-run cancellation while the transient
 * session envelope (and therefore its pending-card pointer) does not. A card
 * is recoverable only when its payload proves the exact Jules plan activity.
 * Session identity alone is insufficient: a reviewer may have answered an
 * older revision before Jules generated a replacement plan.
 *
 * This is intentionally narrower than general interaction discovery: the
 * card must carry the exact session's v2 key and typed plan target, and there
 * must be exactly one eligible candidate.  Ambiguous, user-cancelled, and
 * malformed cards fail closed.
 */
export function recoverMissingPlanGatePointer(input: {
  readonly issueId: string;
  readonly sessionId: string;
  readonly latestPlanActivityId: string;
  readonly interactions: readonly unknown[];
  /** A later provider plan proves older answered cards are historical. */
  readonly allowAnswered?: boolean | undefined;
}): RecoveredPlanGatePointer | null {
  const prefix = `jules:plan-review:v2:${input.issueId}:${input.sessionId}:`;
  const candidates = input.interactions.flatMap((value): RecoveredPlanGatePointer[] => {
    if (!value || typeof value !== "object") return [];
    const card = value as RawPlanGateCard;
    const recoverableStatus = card.status === "cancelled" ||
      (card.status === "answered" && input.allowAnswered !== false);
    if (card.kind !== "request_item_verdicts" || !recoverableStatus || typeof card.id !== "string" ||
        typeof card.idempotencyKey !== "string" || !card.idempotencyKey.startsWith(prefix) ||
        typeof card.addresseeAgentId !== "string") return [];
    const result = card.result && typeof card.result === "object" ? card.result as { reason?: unknown } : undefined;
    if (card.status === "cancelled" &&
        (!result || typeof result.reason !== "string" || !REPLAN_REQUIRED_PLAN_GATE_CANCELLATION_REASONS.has(result.reason))) return [];
    const payload = card.payload && typeof card.payload === "object" ? card.payload as RawPlanGatePayload : undefined;
    const target = payload?.target && typeof payload.target === "object" ? payload.target as RawPlanTarget : undefined;
    const question = payload?.detailsMarkdown;
    const providerActivityId = payload?.providerActivityId;
    const keyParts = card.idempotencyKey.split(":");
    const stage = keyParts.at(6);
    if (!target || target.type !== "issue_document" || target.issueId !== input.issueId || target.key !== "plan" ||
        typeof target.documentId !== "string" || typeof target.revisionId !== "string" ||
        !Number.isInteger(target.revisionNumber) || (stage !== "luna" && stage !== "terra") || typeof question !== "string" ||
        typeof providerActivityId !== "string" || providerActivityId !== input.latestPlanActivityId) return [];
    return [{ interactionId: card.id, activityId: providerActivityId, question, documentId: target.documentId,
      revisionId: target.revisionId, revisionNumber: target.revisionNumber as number, reviewerAgentId: card.addresseeAgentId, stage }];
  });
  return candidates.length === 1 ? candidates[0]! : null;
}

export function decidePlanGateRecovery(input: PlanGateObservation): PlanGateDecision {
  if (input.hasUnresolvedProviderQuestion) return { action: "await_provider_question" };
  if (!input.matchingInteraction) return { action: "manual_recovery_required" };

  switch (input.matchingInteraction.status) {
    case "expired":
      // A native v2 card is an immutable review cycle. An expiry has no
      // reviewer decision, so recovery needs a fresh provider plan activity,
      // never a second card for the same revision.
      return input.providerState === "AWAITING_PLAN_APPROVAL" || input.providerState === "COMPLETED"
        ? { action: "request_provider_plan_revision", terminalCard: "expired" }
        : { action: "await_provider" };
    case "cancelled":
      if (input.providerState !== "AWAITING_PLAN_APPROVAL" && input.providerState !== "COMPLETED") {
        return { action: "await_provider" };
      }
      return REPLAN_REQUIRED_PLAN_GATE_CANCELLATION_REASONS.has(
        input.matchingInteraction.cancellationReason ?? "",
      )
        ? { action: "request_provider_plan_revision", terminalCard: "cancelled" }
        : { action: "manual_recovery_required" };
    case "unknown":
      return { action: "manual_recovery_required" };
    case "pending":
    case "answered":
      if (input.providerState !== "AWAITING_PLAN_APPROVAL") return { action: "await_provider" };
      return { action: "await_card" };
    default:
      return assertNever(input.matchingInteraction.status);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled plan-gate interaction status: ${String(value)}`);
}
