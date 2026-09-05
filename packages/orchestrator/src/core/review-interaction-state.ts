import { NATIVE_PR_REVIEW_STAGE_IDS } from "./execution-policy.js";

/**
 * The Paperclip interaction is the only authoritative PR-review input.
 * Comments and assignment/status are audit context only and never transition
 * a review stage.
 */
export type PrReviewStage = "luna" | "terra" | "vibe" | "strong";

/**
 * Bump when the native interaction request shape changes. Paperclip reserves
 * cancelled idempotency keys forever, so reusing an old key with a changed
 * payload produces a conflict instead of a safe replacement card.
 */
export const NATIVE_REVIEW_CARD_PROTOCOL_VERSION = "v13" as const;

export interface ReviewInteractionIdentity {
  readonly issueId: string;
  readonly prUrl: string;
  readonly headSha: string;
  readonly stage: PrReviewStage;
  readonly reviewerAgentId?: string | undefined;
  readonly attempt?: number | undefined;
}

export interface NativeReviewInteraction {
  readonly id: string;
  readonly idempotencyKey?: string | undefined;
  readonly kind?: string | undefined;
  readonly status?: string | undefined;
  readonly continuationPolicy?: string | undefined;
  readonly addresseeAgentId?: string | null | undefined;
  readonly result?: unknown;
}

/**
 * Pending review cards are durable locks, including cards created by an older
 * adapter generation. Once a terminal reject sends the PR back to its worker,
 * every other pending card for that immutable review turn is unsafe: it can
 * wake a second reviewer after the worker has started fixing the PR.
 *
 * Keep this selector pure so the caller can fence the resulting withdrawals
 * with its convergence guard. The rejected card itself is retained as the
 * audit record; only other pending native cards are withdrawn.
 */
export function selectReviewCardsToWithdrawAfterRejection(
  interactions: readonly NativeReviewInteraction[],
  issueId: string,
  rejectedInteractionId?: string,
): string[] {
  return interactions
    .filter((interaction) =>
      interaction.id !== rejectedInteractionId &&
      interaction.kind === "request_item_verdicts" &&
      interaction.status === "pending" &&
      typeof interaction.idempotencyKey === "string" &&
      isReviewInteractionForIssue(interaction.idempotencyKey, issueId),
    )
    .map((interaction) => interaction.id);
}

export type NativeReviewVerdict =
  | { readonly decision: "all_good" }
  | { readonly decision: "needs_work"; readonly reason: string };

export type ReviewDialogPlan =
  | { readonly action: "reuse"; readonly interactionId: string }
  | { readonly action: "create"; readonly idempotencyKey: string };

export interface ReviewInteractionRequest {
  readonly kind: "request_item_verdicts";
  readonly idempotencyKey: string;
  readonly title: string;
  /** Addressed cards are Paperclip's native review dispatch primitive. */
  readonly continuationPolicy: "none" | "wake_assignee";
  readonly addresseeAgentId?: string | undefined;
  readonly payload: {
    readonly version: 1;
    readonly prompt: string;
    readonly detailsMarkdown: string;
    readonly items: readonly [{ readonly id: "pull_request"; readonly label: "Pull request"; readonly description: string }];
    readonly verdicts: readonly ["approve", "reject"];
    readonly requireReasonOn: readonly ["reject"];
    readonly reasonLabel: "What must change?";
    readonly allowBulkApprove: true;
    readonly supersedeOnUserComment: false;
  };
}

export function buildNativeReviewExecutionState(
  previous: Record<string, unknown> | null | undefined,
  stage: PrReviewStage,
  reviewerAgentId: string,
  reviewRecoveryKey?: string,
  reviewInteractionId?: string,
): Record<string, unknown> {
  const currentStageId = stage === "luna"
    ? NATIVE_PR_REVIEW_STAGE_IDS.luna
    : stage === "terra"
      ? NATIVE_PR_REVIEW_STAGE_IDS.terra
      : null;
  const currentStageIndex = stage === "luna" ? 0 : stage === "terra" ? 1 : null;
  return {
    ...(previous ?? {}),
    status: "pending",
    currentStageId,
    currentStageIndex,
    currentStageType: "review",
    currentParticipant: { type: "agent", agentId: reviewerAgentId },
    lastDecisionOutcome: null,
    reviewRequest: { kind: "pull_request", stage },
    ...(reviewRecoveryKey ? { reviewRecoveryKey } : {}),
    ...(reviewInteractionId ? { reviewInteractionId } : {}),
    completedStageIds: stage === "terra" ? [NATIVE_PR_REVIEW_STAGE_IDS.luna] : [],
  };
}

export function reviewInteractionIdempotencyKey(identity: ReviewInteractionIdentity): string {
  // Paperclip retains idempotency keys after an interaction is withdrawn.
  // Versioning the safe-card protocol lets us retire the old addressed card
  // and create exactly one replacement without weakening idempotency.
  // v12 is required because Paperclip permanently reserves an idempotency key
  // after a card expires or is cancelled. This generation also carries the
  // non-superseding review-card contract, plus the explicit structured
  // response instructions needed by ACP agents.
  return `pr-review:v12:${identity.issueId}:${identity.prUrl}:${identity.headSha}:${identity.stage}`;
}

/** Current plus immediately previous card generations. Paperclip permanently
 * reserves an idempotency key after expiry, while answered cards remain valid
 * evidence during a rolling adapter upgrade. */
export function reviewInteractionIdempotencyKeys(identity: ReviewInteractionIdentity): string[] {
  const current = reviewInteractionIdempotencyKey(identity);
  const previous = `pr-review:v11:${identity.issueId}:${identity.prUrl}:${identity.headSha}:${identity.stage}`;
  const older = `pr-review:v10:${identity.issueId}:${identity.prUrl}:${identity.headSha}:${identity.stage}`;
  const legacy = `pr-review:v9:${identity.issueId}:${identity.prUrl}:${identity.headSha}:${identity.stage}`;
  return [current, previous, older, legacy];
}

/** Returns true for current and migrated PR-review card keys belonging to an issue. */
export function isReviewInteractionForIssue(idempotencyKey: string | undefined, issueId: string): boolean {
  return Boolean(
    idempotencyKey?.startsWith(`pr-review:${issueId}:`) ||
    idempotencyKey?.startsWith(`pr-review:v2:${issueId}:`) ||
    idempotencyKey?.startsWith(`pr-review:v3:${issueId}:`) ||
    idempotencyKey?.startsWith(`pr-review:v4:${issueId}:`) ||
    idempotencyKey?.startsWith(`pr-review:v5:${issueId}:`) ||
    idempotencyKey?.startsWith(`pr-review:v6:${issueId}:`) ||
    idempotencyKey?.startsWith(`pr-review:v7:${issueId}:`) ||
    idempotencyKey?.startsWith(`pr-review:v8:${issueId}:`) ||
    idempotencyKey?.startsWith(`pr-review:v9:${issueId}:`) ||
    idempotencyKey?.startsWith(`pr-review:v10:${issueId}:`) ||
    idempotencyKey?.startsWith(`pr-review:v11:${issueId}:`) ||
    idempotencyKey?.startsWith(`pr-review:v12:${issueId}:`),
  );
}

export function reviewVerdictFromInteraction(
  interaction: NativeReviewInteraction | undefined,
  expectedInteractionId: string | undefined,
): NativeReviewVerdict | null {
  if (!interaction || !expectedInteractionId || interaction.id !== expectedInteractionId ||
      interaction.kind !== "request_item_verdicts" || interaction.status !== "answered") return null;
  const result = interaction.result;
  if (!result || typeof result !== "object") return null;
  const items = (result as Record<string, unknown>)["items"];
  if (!Array.isArray(items)) return null;
  const prVerdict = items.find((verdict) =>
    verdict && typeof verdict === "object" && (verdict as Record<string, unknown>)["id"] === "pull_request",
  ) as Record<string, unknown> | undefined;
  if (!prVerdict) return null;
  if (prVerdict["verdict"] === "approve") return { decision: "all_good" };
  const reason = typeof prVerdict["reason"] === "string" ? prVerdict["reason"].trim() : "";
  return prVerdict["verdict"] === "reject" && reason ? { decision: "needs_work", reason } : null;
}

/** Plans a single idempotent dialog effect. Answering wakes the addressed
 * reviewer so it can complete Paperclip's separate execution-policy write. */
export function planReviewDialog(
  identity: ReviewInteractionIdentity,
  interactions: readonly (NativeReviewInteraction & { readonly idempotencyKey?: string | undefined })[],
): ReviewDialogPlan {
  const idempotencyKey = reviewInteractionIdempotencyKey(identity);
  const pending = interactions.find((interaction) =>
    interaction.kind === "request_item_verdicts" && interaction.status === "pending" &&
    interaction.idempotencyKey === idempotencyKey &&
    interaction.continuationPolicy === "wake_assignee" &&
    (identity.reviewerAgentId ? interaction.addresseeAgentId === identity.reviewerAgentId : !interaction.addresseeAgentId),
  );
  return pending ? { action: "reuse", interactionId: pending.id } : { action: "create", idempotencyKey };
}

/**
 * A runtime-owned assignment does not produce a new assignment event when a
 * server restart leaves the card and assignee intact.  In that case recover
 * exactly as far as the native runtime can observe: wake only while no active
 * heartbeat is bound to this issue.  Once a bound run exists, the orchestrator
 * must wait for its structured verdict rather than issuing another wake.
 */
export function shouldWakeAssignedReview(input: {
  readonly dialogCreated: boolean;
  readonly hasActiveBoundRun: boolean;
}): boolean {
  return input.dialogCreated || !input.hasActiveBoundRun;
}

export function buildReviewInteractionRequest(identity: ReviewInteractionIdentity): ReviewInteractionRequest {
  return {
    kind: "request_item_verdicts",
    idempotencyKey: reviewInteractionIdempotencyKey(identity),
    title: `Review pull request ${identity.prUrl}`,
    continuationPolicy: "wake_assignee",
    ...(identity.reviewerAgentId ? { addresseeAgentId: identity.reviewerAgentId } : {}),
    payload: {
      version: 1,
      prompt: "Review this pull request and choose a disposition.",
      detailsMarkdown: `**PR:** ${identity.prUrl}\n\nChoose approve only when the PR is ready. Reject requires a concrete reason.\n\nThis is a native Paperclip review card. Do not post a plain review comment as the decision. Submit the structured verdict first with POST \`$PAPERCLIP_API_BASE/api/issues/$PAPERCLIP_TASK_ID/interactions/<INTERACTION_ID>/verdicts\` using JSON \`{\"verdicts\":[{\"id\":\"pull_request\",\"verdict\":\"approve\"}]}\` (use \`verdict: \"reject\"\` plus \`reason\` for requested changes). Replace \`<INTERACTION_ID>\` with the actual interaction id from the wake message. Then use the normal Paperclip issue update route as the active execution participant: approve with status \`done\` and a concise review comment, or request changes with status \`in_progress\` and the same concrete reason. Re-fetch the issue and confirm executionState changed before finishing.`,
      items: [{ id: "pull_request", label: "Pull request", description: identity.prUrl }],
      verdicts: ["approve", "reject"],
      requireReasonOn: ["reject"],
      reasonLabel: "What must change?",
      allowBulkApprove: true,
      // PR reconciliation/status comments are informational. They must not
      // invalidate the authoritative review dialog while the reviewer is
      // still examining the immutable PR head.
      supersedeOnUserComment: false,
    },
  };
}

/** Prevent internal Jules coordination and non-PR work entering the PR lane. */
export function selectPrReviewIssues(issues: readonly {
  readonly id: string;
  readonly status: string;
  readonly orchestratorManaged: boolean;
  readonly hasPullRequest: boolean;
  readonly description?: string | undefined;
}[]): string[] {
  return issues
    .filter((issue) => issue.status === "in_review" && issue.orchestratorManaged && issue.hasPullRequest &&
      !issue.description?.includes("<!-- jules-"))
    .map((issue) => issue.id);
}
