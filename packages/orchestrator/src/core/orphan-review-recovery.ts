import type { HeartbeatRunSummary } from "./session-continuation.js";

export interface ReviewRecoveryActionSnapshot {
  readonly id?: unknown;
  readonly kind?: unknown;
  readonly status?: unknown;
  readonly cause?: unknown;
  readonly fingerprint?: unknown;
  readonly evidence?: unknown;
}

export type OrphanReviewRecoveryPlan = Readonly<{
  cancelRunIds: readonly string[];
  resolveRecoveryActionId: string | null;
  reason: string;
}>;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isGenericReviewDisposition(action: ReviewRecoveryActionSnapshot | null | undefined): boolean {
  if (!action || action.status !== "active" || action.kind !== "deliberate_wait_without_target") return false;
  const evidence = action.evidence && typeof action.evidence === "object"
    ? action.evidence as Record<string, unknown>
    : {};
  return action.cause === "deliberate_wait_without_target" ||
    evidence["latestRunErrorCode"] === "issue_continuation_waiting_on_review" ||
    text(action.fingerprint)?.startsWith("disposition_repair:v1:") === true;
}

/**
 * Temporary adapter containment for Paperclip versions whose generic
 * disposition-repair service does not understand native PR review cards.
 *
 * The upstream fix belongs in Paperclip: make a live review card a typed
 * disposition, carry its interaction id/kind into the heartbeat context, and
 * prevent the generic owner-repair worker from waking or blocking a reviewer
 * when that typed disposition is present. Until then, this function is the
 * narrow, idempotent safety fence used by the orchestrator adapter.
 */
export function planOrphanReviewRecovery(input: {
  readonly issueId: string;
  readonly reviewerAgentIds: readonly string[];
  /** Adapter-owned correlation survives Paperclip card cancellation. */
  readonly activeReviewInteractionId?: string | null | undefined;
  readonly runs: readonly HeartbeatRunSummary[];
  readonly interactions: readonly { readonly id: string; readonly kind?: string; readonly status?: string }[];
  readonly activeRecoveryAction?: ReviewRecoveryActionSnapshot | null | undefined;
}): OrphanReviewRecoveryPlan {
  const boundInteractionIds = new Set(
    input.interactions
      .filter((item) => item.kind === "request_item_verdicts" && item.status === "pending")
      .map((item) => item.id),
  );
  // Paperclip versions that launch an addressed interaction through the
  // assignment path currently omit interactionId/interactionKind from the
  // heartbeat context. Within one issue, a single pending native card is an
  // unambiguous correlation fence; cancelling that run creates the exact
  // free-text fallback this adapter is meant to prevent.
  const pendingCardCount = input.interactions.filter((item) =>
    item.kind === "request_item_verdicts" && item.status === "pending",
  ).length;
  const cancelRunIds = input.runs
    .filter((run) => input.reviewerAgentIds.includes(run.agentId))
    .filter((run) => ["queued", "running", "active", "claimed"].includes(run.status))
    .filter((run) => run.issueId === input.issueId)
    .filter((run) => {
      if (run.interactionKind === "request_item_verdicts" && run.interactionId && boundInteractionIds.has(run.interactionId)) return false;
      if (input.activeReviewInteractionId && run.issueId === input.issueId) return false;
      return pendingCardCount !== 1;
    })
    .map((run) => run.id)
    .filter(Boolean);

  return {
    cancelRunIds,
    resolveRecoveryActionId: isGenericReviewDisposition(input.activeRecoveryAction)
      ? text(input.activeRecoveryAction?.id)
      : null,
    reason: "Native PR review card is the authoritative disposition; generic Paperclip owner repair is a false positive.",
  };
}
