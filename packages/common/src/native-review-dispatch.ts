export type NativeReviewRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted";

export interface NativeReviewDispatchIdentity {
  readonly issueId: string;
  readonly reviewerAgentId: string;
  readonly immutableKey: string;
}

/**
 * The only adapter-owned wake payload for an addressed native verdict card.
 *
 * Paperclip owns dispatch and reviewer-run creation.  An adapter may request
 * recovery only by naming the exact interaction and declaring the interaction
 * mutation; a generic agent wake loses the card context and can spend reviewer
 * quota on an unrelated prompt.
 */
export interface NativeInteractionWakeInput {
  readonly issueId: string;
  readonly reviewerAgentId: string;
  readonly interactionId: string;
  readonly reason: "native_review_dispatch_recovery" | "native_plan_review";
}

export interface NativeInteractionWakeRequest {
  readonly path: string;
  readonly body: {
    readonly source: "automation";
    readonly triggerDetail: "system";
    readonly reason: NativeInteractionWakeInput["reason"];
    readonly forceFreshSession: true;
    readonly payload: {
      readonly issueId: string;
      readonly mutation: "interaction";
      readonly interactionId: string;
      readonly interactionKind: "request_item_verdicts";
    };
  };
}

export function buildNativeInteractionWakeRequest(input: NativeInteractionWakeInput): NativeInteractionWakeRequest {
  return {
    path: `/api/agents/${encodeURIComponent(input.reviewerAgentId)}/wakeup`,
    body: {
      source: "automation",
      triggerDetail: "system",
      reason: input.reason,
      forceFreshSession: true,
      payload: {
        issueId: input.issueId,
        mutation: "interaction",
        interactionId: input.interactionId,
        interactionKind: "request_item_verdicts",
      },
    },
  };
}

export interface NativeReviewDispatchCard {
  readonly id: string;
  readonly status: "pending" | "answered";
  readonly createdAt: string;
  readonly reviewerAgentId: string;
  readonly immutableKey: string;
  readonly attempt: number;
}

export interface NativeReviewDispatchRun {
  readonly id: string;
  readonly status: NativeReviewRunStatus;
  readonly issueId: string;
  readonly reviewerAgentId: string;
  readonly interactionId: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  /** Provenance for pre-execution host cancellation (e.g. issue_assignee_changed). */
  readonly stopReason?: string | null | undefined;
  readonly errorCode?: string | null | undefined;
}

export interface NativeReviewDispatchInput {
  readonly identity: NativeReviewDispatchIdentity;
  readonly card: NativeReviewDispatchCard;
  /** Runs supplied here must already belong to this immutable review turn. */
  readonly runs: readonly NativeReviewDispatchRun[];
  readonly nowMs: number;
  readonly graceMs: number;
  readonly maxReplacementAttempts: number;
}

export type NativeReviewDispatchDecision =
  | { readonly action: "await_native_dispatch" }
  | { readonly action: "await_run"; readonly runId: string }
  | { readonly action: "await_verdict"; readonly runId: string }
  | { readonly action: "consume_verdict"; readonly interactionId: string }
  | {
      /**
       * Paperclip accepted the addressed card but has not bound a reviewer
       * run after the dispatch grace period. Recover the host dispatch on
       * this exact card; do not create another card for missing dispatch.
       */
      readonly action: "recover_dispatch";
      readonly interactionId: string;
      readonly reviewerAgentId: string;
      readonly immutableKey: string;
      readonly attempt: number;
    }
  | {
      readonly action: "replace_card";
      readonly interactionId: string;
      readonly nextAttempt: number;
      readonly cause: "missing_dispatch" | "terminal_run";
      readonly failedRunId?: string | undefined;
    }
  | { readonly action: "retry_exhausted"; readonly interactionId: string; readonly attempt: number }
  | {
      readonly action: "protocol_failure";
      readonly reason:
        | "invalid_identity"
        | "invalid_card_evidence"
        | "invalid_run_evidence"
        | "card_identity_mismatch"
        | "unbound_run_evidence"
        | "multiple_live_runs";
    };

const LIVE_STATUSES = new Set<NativeReviewRunStatus>(["queued", "running"]);
const TERMINAL_FAILURE_STATUSES = new Set<NativeReviewRunStatus>([
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
]);

function timestamp(value: string | null): number {
  if (value === null) return 0;
  return Date.parse(value);
}

function latestRun(runs: readonly NativeReviewDispatchRun[]): NativeReviewDispatchRun | undefined {
  return [...runs].sort((left, right) => timestamp(right.startedAt) - timestamp(left.startedAt))[0];
}

/**
 * A host cancellation before execution never ran the reviewer. Paperclip
 * cancels the queued run as `issue_assignee_changed` when the issue owner
 * changes; the addressed card was never dispatched and must be recovered on
 * the same card, not replaced.
 */
function isPreStartAssigneeCancellation(run: NativeReviewDispatchRun): boolean {
  return run.status === "cancelled" &&
    run.startedAt === null &&
    (run.stopReason === "issue_assignee_changed" || run.errorCode === "issue_assignee_changed");
}

/**
 * Pure decision point for one addressed native-review card. Paperclip owns
 * dispatch; adapters may request one idempotent public recovery wake for an
 * overdue card with no bound run. Replacing a card is reserved for a terminal
 * reviewer run, because a replacement would otherwise repeat the same failed
 * Paperclip dispatch path.
 */
export function decideNativeReviewDispatch(input: NativeReviewDispatchInput): NativeReviewDispatchDecision {
  const { identity, card } = input;
  if (!identity.issueId || !identity.reviewerAgentId || !identity.immutableKey) {
    return { action: "protocol_failure", reason: "invalid_identity" };
  }
  if (
    !card.id ||
    !Number.isInteger(card.attempt) ||
    card.attempt < 0 ||
    !Number.isFinite(input.nowMs) ||
    !Number.isFinite(input.graceMs) ||
    input.graceMs < 0 ||
    !Number.isInteger(input.maxReplacementAttempts) ||
    input.maxReplacementAttempts < 0
  ) {
    return { action: "protocol_failure", reason: "invalid_card_evidence" };
  }
  if (card.reviewerAgentId !== identity.reviewerAgentId || card.immutableKey !== identity.immutableKey) {
    return { action: "protocol_failure", reason: "card_identity_mismatch" };
  }
  if (card.status === "answered") return { action: "consume_verdict", interactionId: card.id };

  const createdAtMs = Date.parse(card.createdAt);
  if (!Number.isFinite(createdAtMs)) {
    return { action: "protocol_failure", reason: "invalid_card_evidence" };
  }

  const unbound = input.runs.some((run) =>
    !run.id ||
    run.issueId !== identity.issueId ||
    run.reviewerAgentId !== identity.reviewerAgentId ||
    run.interactionId !== card.id ||
    (run.startedAt !== null && !Number.isFinite(Date.parse(run.startedAt))) ||
    (run.finishedAt !== null && !Number.isFinite(Date.parse(run.finishedAt))),
  );
  if (unbound) return { action: "protocol_failure", reason: "unbound_run_evidence" };

  const liveRuns = input.runs.filter((run) => LIVE_STATUSES.has(run.status));
  if (liveRuns.length > 1) return { action: "protocol_failure", reason: "multiple_live_runs" };
  if (liveRuns[0]) return { action: "await_run", runId: liveRuns[0].id };

  // Pre-start assignee-change cancellations never executed the reviewer, so
  // they are not terminal-run evidence. Exclude them before selecting the
  // authoritative run; an overdue card with only such cancellations recovers
  // on the same card.
  const effectiveRuns = input.runs.filter((run) => !isPreStartAssigneeCancellation(run));
  const current = latestRun(effectiveRuns);
  if (current?.status === "succeeded") return { action: "await_verdict", runId: current.id };
  if (current && !TERMINAL_FAILURE_STATUSES.has(current.status)) {
    return { action: "protocol_failure", reason: "invalid_run_evidence" };
  }

  if (!current && input.nowMs - createdAtMs < input.graceMs) return { action: "await_native_dispatch" };
  if (!current) {
    return {
      action: "recover_dispatch",
      interactionId: card.id,
      reviewerAgentId: identity.reviewerAgentId,
      immutableKey: identity.immutableKey,
      attempt: card.attempt,
    };
  }
  if (card.attempt >= input.maxReplacementAttempts) {
    return { action: "retry_exhausted", interactionId: card.id, attempt: card.attempt };
  }
  return {
    action: "replace_card",
    interactionId: card.id,
    nextAttempt: card.attempt + 1,
    cause: "terminal_run",
    failedRunId: current.id,
  };
}
