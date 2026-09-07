import type { HeartbeatRunSummary } from "./session-continuation.js";
import { isCanonicalReviewCardKey } from "./review-interaction-state.js";

export type ReviewSessionDecision =
  | { readonly action: "await_run"; readonly runId: string }
  | { readonly action: "answered" }
  | { readonly action: "recover"; readonly runId: string; readonly reason: string }
  | { readonly action: "protocol_failure"; readonly reason: string }
  | { readonly action: "dispatch" };

export interface ReviewCardBinding {
  readonly id: string;
  readonly status?: string | undefined;
  readonly addresseeAgentId?: string | null | undefined;
  readonly idempotencyKey?: string | undefined;
}

/**
 * Idempotency fence for recovery of one terminal reviewer run. A new run is
 * permitted only for a different terminal run id; repeated heartbeats cannot
 * spend quota retrying the same failed invocation.
 */
export function nativeReviewRecoveryWakeKey(
  agentId: string,
  issueId: string,
  interactionId: string,
  runId: string,
): string {
  return `native-review-recovery:v1:${agentId}:${issueId}:${interactionId}:${runId}`;
}

/**
 * Finds the one canonical card/run pair that owns the current review turn.
 * This is deliberately derived from native card identity and heartbeat
 * context; executionState is not safe storage for adapter-only fields because
 * Paperclip validates and strips unknown properties.
 */
export function findReviewCardBinding(input: {
  readonly cards: readonly ReviewCardBinding[];
  readonly runs: readonly Pick<HeartbeatRunSummary, "id" | "agentId" | "status" | "issueId" | "interactionId">[];
  readonly issueId: string;
  readonly reviewerAgentId: string;
}): { readonly card: ReviewCardBinding; readonly run?: Pick<HeartbeatRunSummary, "id" | "status" | "interactionId"> } | null {
  const card = input.cards.find((candidate) =>
    candidate.status === "pending" &&
    candidate.addresseeAgentId === input.reviewerAgentId &&
    isCanonicalReviewCardKey(candidate.idempotencyKey),
  );
  if (card) {
    const run = input.runs.find((candidate) =>
      candidate.issueId === input.issueId &&
      candidate.agentId === input.reviewerAgentId &&
      LIVE_RUN_STATUSES.has(candidate.status) &&
      candidate.interactionId === card.id,
    );
    return { card, ...(run ? { run } : {}) };
  }
  const run = input.runs.find((candidate) =>
    candidate.issueId === input.issueId &&
    candidate.agentId === input.reviewerAgentId &&
    LIVE_RUN_STATUSES.has(candidate.status) &&
    candidate.interactionId != null &&
    input.cards.some((candidateCard) => candidateCard.id === candidate.interactionId),
  );
  if (!run || !run.interactionId) return null;
  const boundCard = input.cards.find((candidate) => candidate.id === run.interactionId);
  return boundCard ? { card: boundCard, run } : null;
}

const LIVE_RUN_STATUSES = new Set(["queued", "running", "active", "claimed"]);
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

/**
 * Correlates the adapter-owned review session before any new attempt is
 * allocated. Paperclip may omit interaction metadata from a run and may
 * cancel its visible card; the persisted interaction identity still fences
 * the exact issue/reviewer pair until that run is terminal.
 */
export function decideReviewSession(input: {
  readonly issueId: string;
  readonly reviewerAgentId: string;
  readonly interactionId: string;
  readonly runs: readonly Pick<HeartbeatRunSummary, "id" | "agentId" | "status" | "issueId" | "interactionId">[];
  readonly interactions: readonly { readonly id: string; readonly status?: string; readonly result?: unknown }[];
}): ReviewSessionDecision {
  const interaction = input.interactions.find((candidate) => candidate.id === input.interactionId);
  if (interaction?.status === "answered") return { action: "answered" };

  const liveRun = input.runs
    .filter((run) => run.issueId === input.issueId && run.agentId === input.reviewerAgentId &&
      LIVE_RUN_STATUSES.has(run.status) && run.interactionId === input.interactionId)
    .sort((left, right) => left.id.localeCompare(right.id))[0];
  if (liveRun) return { action: "await_run", runId: liveRun.id };

  // A successful process is not a successful review. The MCP tool may have
  // returned an infrastructure error while Codex itself still exited 0. A
  // pending card is the authoritative evidence that the review did not
  // complete, so recover the same card once the bound run is terminal.
  if (interaction?.status === "pending") {
    const terminalRun = input.runs
      .filter((run) =>
        run.issueId === input.issueId &&
        run.agentId === input.reviewerAgentId &&
        TERMINAL_RUN_STATUSES.has(run.status) &&
        run.interactionId === input.interactionId,
      )
      .sort((left, right) => right.id.localeCompare(left.id))[0];
    if (terminalRun) {
      return {
        action: "recover",
        runId: terminalRun.id,
        reason: "reviewer run ended without a structured verdict",
      };
    }
  }

  if (interaction?.status && interaction.status !== "pending") {
    return { action: "protocol_failure", reason: "reviewer run ended without a structured verdict" };
  }
  return { action: "dispatch" };
}
