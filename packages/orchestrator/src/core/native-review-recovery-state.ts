import { reviewInteractionKeyPrefix } from "./review-interaction-state.js";
import type { HeartbeatRunSummary } from "./session-continuation.js";

export interface RecoverableNativeReviewCard {
  readonly id: string;
  readonly kind?: string | undefined;
  readonly status?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly addresseeAgentId?: string | null | undefined;
}

export interface NativeReviewRecoveryPrIdentity {
  readonly url: string;
  readonly headSha: string;
}

export type NativeReviewRecoveryDecision =
  | { readonly action: "no_action" }
  | { readonly action: "await_run"; readonly interactionId: string; readonly runId: string }
  | {
      readonly action: "restore_and_recover";
      readonly interactionId: string;
      readonly reviewerAgentId: string;
      readonly failedRunId?: string | undefined;
      readonly withdrawInteractionIds: readonly string[];
    }
  | { readonly action: "protocol_failure"; readonly reason: "multiple_pending_canonical_pr_cards" };

/**
 * The released Paperclip ownership guard validates a queued reviewer run
 * against the issue assignee before it recognizes the native-card payload.
 * Assigning the card's explicit addressee before the wake is therefore the
 * narrow adapter-side bridge for hot-restart recovery. Remove this when core
 * persists the interaction binding before applying its ownership gate.
 */
export function nativeReviewRecoveryIssuePatch(
  decision: Extract<NativeReviewRecoveryDecision, { readonly action: "restore_and_recover" }>,
): { readonly status: "in_review"; readonly assigneeAgentId: string } {
  return { status: "in_review", assigneeAgentId: decision.reviewerAgentId };
}

const LIVE_RUN_STATUSES = new Set(["queued", "running", "active", "claimed"]);
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);

function isCanonicalPrCard(
  card: RecoverableNativeReviewCard,
  issueId: string,
  prIdentity: NativeReviewRecoveryPrIdentity,
): boolean {
  if (card.kind !== "request_item_verdicts" || card.status !== "pending") return false;
  const key = card.idempotencyKey;
  if (!key) return false;
  const lunaPrefix = reviewInteractionKeyPrefix({ issueId, prUrl: prIdentity.url, headSha: prIdentity.headSha, stage: "luna" });
  const terraPrefix = reviewInteractionKeyPrefix({ issueId, prUrl: prIdentity.url, headSha: prIdentity.headSha, stage: "terra" });
  return key === lunaPrefix || key.startsWith(`${lunaPrefix}:attempt:`) ||
    key === terraPrefix || key.startsWith(`${terraPrefix}:attempt:`);
}

/**
 * Adapter-only compatibility fence for Paperclip versions which can lose a
 * review-run's interaction binding during a hot restart and project the
 * source issue back to backlog. The typed PR card plus immutable PR identity
 * are the authority; issue status, assignment, and reviewer prose are not.
 */
export function decideNativeReviewRecovery(input: {
  readonly issueId: string;
  readonly issueStatus: string;
  readonly issueAssigneeAgentId?: string | null | undefined;
  readonly orchestratorManaged: boolean;
  readonly prIdentity: NativeReviewRecoveryPrIdentity;
  readonly cards: readonly RecoverableNativeReviewCard[];
  readonly reviewerRuns: readonly Pick<HeartbeatRunSummary, "id" | "agentId" | "status" | "issueId" | "interactionId">[];
}): NativeReviewRecoveryDecision {
  if (!input.orchestratorManaged) return { action: "no_action" };

  const canonicalCards = input.cards.filter((card) => isCanonicalPrCard(card, input.issueId, input.prIdentity));
  if (canonicalCards.length === 0) return { action: "no_action" };
  if (canonicalCards.length > 1) return { action: "protocol_failure", reason: "multiple_pending_canonical_pr_cards" };

  const canonical = canonicalCards[0]!;
  const reviewerAgentId = canonical.addresseeAgentId;
  if (!reviewerAgentId) return { action: "no_action" };
  const runs = input.reviewerRuns.filter((run) =>
    run.issueId === input.issueId && run.agentId === reviewerAgentId &&
    (run.interactionId === canonical.id || run.interactionId == null),
  );
  const liveRun = runs.find((run) => LIVE_RUN_STATUSES.has(run.status));
  if (liveRun) return { action: "await_run", interactionId: canonical.id, runId: liveRun.id };

  const failedRun = runs.find((run) => TERMINAL_RUN_STATUSES.has(run.status));
  // A pending card without a reviewer execution is normal immediately after
  // the review pipeline creates it. Recovery is justified only when the host
  // projection left the native review lane or the bound reviewer run ended.
  // Otherwise this compatibility fence would bypass the regular availability
  // gate and manufacture an unnecessary reviewer wake on every new card.
  if (
    input.issueStatus === "in_review" &&
    (input.issueAssigneeAgentId == null || input.issueAssigneeAgentId === reviewerAgentId) &&
    !failedRun
  ) {
    return { action: "no_action" };
  }
  const withdrawInteractionIds = input.cards
    .filter((card) => card.id !== canonical.id && card.kind === "request_item_verdicts" && card.status === "pending")
    .filter((card) => card.idempotencyKey?.startsWith(`jules:plan-review:v2:${input.issueId}:`))
    .map((card) => card.id);

  // A pending card with no run is dispatchable. A terminal run needs the same
  // card recovered. Both paths restore the host's review projection first.
  return {
    action: "restore_and_recover",
    interactionId: canonical.id,
    reviewerAgentId,
    ...(failedRun ? { failedRunId: failedRun.id } : {}),
    withdrawInteractionIds,
  };
}
