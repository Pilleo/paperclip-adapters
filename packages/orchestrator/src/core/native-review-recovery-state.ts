import { isCanonicalReviewCardKey, reviewInteractionKeyPrefix } from "./review-interaction-state.js";
import type { HeartbeatRunSummary } from "./session-continuation.js";
import { decideNativeReviewDispatch, type NativeReviewRunStatus } from "@pilleo/paperclip-adapter-common";

export interface RecoverableNativeReviewCard {
  readonly id: string;
  readonly kind?: string | undefined;
  readonly status?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly addresseeAgentId?: string | null | undefined;
  readonly createdAt?: string | undefined;
}

export interface NativeReviewRecoveryPrIdentity {
  readonly url: string;
  readonly headSha: string;
}

export type NativeReviewRecoveryDecision =
  | { readonly action: "no_action" }
  | { readonly action: "await_native_dispatch"; readonly interactionId: string }
  | { readonly action: "await_run"; readonly interactionId: string; readonly runId: string }
  | { readonly action: "await_verdict"; readonly interactionId: string; readonly runId: string }
  | {
      readonly action: "recover_dispatch";
      readonly interactionId: string;
      readonly reviewerAgentId: string;
      readonly stage: "luna" | "terra";
      /** Exact canonical card key; revalidation must fence a stale PR head. */
      readonly immutableKey: string;
    }
  | { readonly action: "retry_exhausted"; readonly interactionId: string; readonly attempt: number }
  | {
      readonly action: "replace_card";
      readonly interactionId: string;
      readonly reviewerAgentId: string;
      readonly stage: "luna" | "terra";
      readonly nextAttempt: number;
      readonly cause: "missing_dispatch" | "terminal_run";
      readonly failedRunId?: string | undefined;
      readonly withdrawInteractionIds: readonly string[];
    }
  | { readonly action: "protocol_failure"; readonly reason: string };

export type JulesPlanNativeReviewRecoveryDecision =
  | { readonly action: "no_action" }
  | { readonly action: "await_run"; readonly interactionId: string; readonly runId: string }
  | { readonly action: "retry_exhausted"; readonly interactionId: string }
  | {
      readonly action: "recover";
      readonly interactionId: string;
      readonly reviewerAgentId: string;
      readonly recoveryRunId: string | undefined;
    }
  | { readonly action: "protocol_failure"; readonly reason: "multiple_pending_canonical_jules_plan_cards" };

/**
 * Last-moment fence for an explicit compatibility wake. The caller must use a
 * fresh card/run read: an earlier scheduler snapshot may have selected a
 * recovery just as Paperclip's native reviewer resolves the card.
 */
export type NativeReviewWakeDecision =
  | { readonly action: "answered" }
  | { readonly action: "await_native_dispatch" }
  | { readonly action: "await_run"; readonly runId: string }
  | { readonly action: "recover_dispatch" }
  | { readonly action: "retry_exhausted" }
  | { readonly action: "protocol_failure"; readonly reason: "card_identity_mismatch" }
  | { readonly action: "no_action" };

/**
 * A typed PR card remains the only review authority after recovery.  Do not
 * reassign the issue to its reviewer: that recreates Paperclip's independent
 * execution-review lane and can produce recovery spam after a verdict.
 */
const LIVE_RUN_STATUSES = new Set(["queued", "running", "active", "claimed"]);
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);

export function decideNativeReviewWake(input: {
  readonly issueId: string;
  readonly reviewerAgentId: string;
  readonly nowMs: number;
  readonly graceMs: number;
  readonly card: Pick<RecoverableNativeReviewCard, "id" | "status" | "createdAt">;
  readonly reviewerRuns: readonly Pick<HeartbeatRunSummary, "id" | "agentId" | "status" | "issueId" | "interactionId">[];
}): NativeReviewWakeDecision {
  if (input.card.status === "answered") return { action: "answered" };
  if (input.card.status !== "pending") return { action: "no_action" };

  const runs = input.reviewerRuns.filter((run) =>
    run.issueId === input.issueId &&
    run.agentId === input.reviewerAgentId &&
    run.interactionId === input.card.id,
  );
  const liveRun = runs.find((run) => LIVE_RUN_STATUSES.has(run.status));
  if (liveRun) return { action: "await_run", runId: liveRun.id };

  const createdAtMs = input.card.createdAt ? Date.parse(input.card.createdAt) : Number.NaN;
  if (!Number.isFinite(createdAtMs) || input.nowMs - createdAtMs < input.graceMs) {
    return { action: "await_native_dispatch" };
  }

  const terminalRuns = runs.filter((run) => TERMINAL_RUN_STATUSES.has(run.status));
  // A terminal run proves the card was dispatched. The outer reducer owns the
  // bounded replacement transition; a same-card wake would run the reviewer twice.
  if (terminalRuns.length > 0) return { action: "no_action" };
  return { action: "recover_dispatch" };
}

function isCanonicalPrCard(
  card: RecoverableNativeReviewCard,
  issueId: string,
  prIdentity: NativeReviewRecoveryPrIdentity,
): boolean {
  if (card.kind !== "request_item_verdicts") return false;
  const key = card.idempotencyKey;
  if (!key) return false;
  const lunaPrefix = reviewInteractionKeyPrefix({ issueId, prUrl: prIdentity.url, headSha: prIdentity.headSha, stage: "luna" });
  const terraPrefix = reviewInteractionKeyPrefix({ issueId, prUrl: prIdentity.url, headSha: prIdentity.headSha, stage: "terra" });
  const matchesStagePrefix = (prefix: string) =>
    key === prefix || key.startsWith(`${prefix}:attempt:`) || key.startsWith(`${prefix}:contract:`);
  // Contract-scoped cards retain the same immutable issue/PR/head/stage
  // identity. Validate their complete v13 grammar before accepting the
  // prefix, so a restart cannot leave a stale Jules card beside the one
  // authoritative PR verdict card.
  return (matchesStagePrefix(lunaPrefix) || matchesStagePrefix(terraPrefix)) &&
    isCanonicalReviewCardKey(key);
}

function prCardStageAndAttempt(card: RecoverableNativeReviewCard): {
  readonly stage: "luna" | "terra";
  readonly attempt: number;
} | null {
  const key = card.idempotencyKey;
  if (!key || !isCanonicalReviewCardKey(key)) return null;
  const match = key.match(/:(luna|terra)(?::contract:[a-z0-9]+)?(?::attempt:([1-9]\d*))?$/);
  if (!match) return null;
  return {
    stage: match[1] as "luna" | "terra",
    attempt: match[2] ? Number(match[2]) : 0,
  };
}

type JulesPlanReviewStage = "luna" | "terra";

function julesPlanReviewStage(
  card: RecoverableNativeReviewCard,
  issueId: string,
  reviewerAgentIds: Readonly<Record<JulesPlanReviewStage, string>>,
): JulesPlanReviewStage | null {
  if (card.kind !== "request_item_verdicts" || card.status !== "pending") return null;
  const key = card.idempotencyKey?.split(":");
  if (!key || key.length !== 7 || key[0] !== "jules" || key[1] !== "plan-review" || key[2] !== "v2") return null;
  if (key[3] !== issueId || !key[4] || !key[5]) return null;
  const stage = key[6];
  if (stage !== "luna" && stage !== "terra") return null;
  return card.addresseeAgentId === reviewerAgentIds[stage] ? stage : null;
}

/**
 * Jules owns the plan gate and keeps its implementation issue assigned to the
 * provider worker. Paperclip v831 can nevertheless fail to start an addressed
 * native reviewer for the typed card. This selector detects only that missing
 * dispatch; it deliberately never applies the PR-review ownership projection.
 */
export function decideJulesPlanNativeReviewRecovery(input: {
  readonly issueId: string;
  readonly orchestratorManaged: boolean;
  readonly issueAssigneeAgentId?: string | null | undefined;
  readonly julesAgentId: string;
  readonly reviewerAgentIds: Readonly<Record<JulesPlanReviewStage, string>>;
  readonly nowMs: number;
  readonly graceMs: number;
  readonly cards: readonly RecoverableNativeReviewCard[];
  readonly reviewerRuns: readonly Pick<HeartbeatRunSummary, "id" | "agentId" | "status" | "issueId" | "interactionId">[];
}): JulesPlanNativeReviewRecoveryDecision {
  if (!input.orchestratorManaged || input.issueAssigneeAgentId !== input.julesAgentId) return { action: "no_action" };

  const cards = input.cards.filter((card) => julesPlanReviewStage(card, input.issueId, input.reviewerAgentIds) !== null);
  if (cards.length === 0) return { action: "no_action" };
  if (cards.length > 1) return { action: "protocol_failure", reason: "multiple_pending_canonical_jules_plan_cards" };

  const card = cards[0]!;
  const stage = julesPlanReviewStage(card, input.issueId, input.reviewerAgentIds);
  if (!stage) return { action: "no_action" };
  const reviewerAgentId = input.reviewerAgentIds[stage];
  const createdAtMs = card.createdAt ? Date.parse(card.createdAt) : Number.NaN;
  if (!Number.isFinite(createdAtMs) || input.nowMs - createdAtMs < input.graceMs) return { action: "no_action" };

  const runs = input.reviewerRuns.filter((run) =>
    run.issueId === input.issueId && run.agentId === reviewerAgentId &&
    run.interactionId === card.id,
  );
  const liveRun = runs.find((run) => LIVE_RUN_STATUSES.has(run.status));
  if (liveRun) return { action: "await_run", interactionId: card.id, runId: liveRun.id };

  const terminalRuns = runs.filter((run) => TERMINAL_RUN_STATUSES.has(run.status));
  // A missing host dispatch merits one recovery. If the reviewer itself ends
  // without a typed verdict, retry that same card once. Further automatic
  // retries would turn a provider outage into quota-consuming review spam.
  if (new Set(terminalRuns.map((run) => run.id)).size >= 2) {
    return { action: "retry_exhausted", interactionId: card.id };
  }
  const terminalRun = terminalRuns[0];
  return {
    action: "recover",
    interactionId: card.id,
    reviewerAgentId,
    recoveryRunId: terminalRun?.id,
  };
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
  readonly nowMs: number;
  readonly graceMs: number;
  readonly maxReplacementAttempts: number;
  readonly cards: readonly RecoverableNativeReviewCard[];
  readonly reviewerRuns: readonly Pick<HeartbeatRunSummary, "id" | "agentId" | "status" | "issueId" | "interactionId">[];
}): NativeReviewRecoveryDecision {
  if (!input.orchestratorManaged) return { action: "no_action" };

  const canonicalCards = input.cards.filter((card) => isCanonicalPrCard(card, input.issueId, input.prIdentity));
  if (canonicalCards.length === 0) return { action: "no_action" };
  const pendingCards = canonicalCards.filter((card) => card.status === "pending");
  if (pendingCards.length > 1) return { action: "protocol_failure", reason: "multiple_pending_canonical_pr_cards" };
  const canonical = pendingCards[0] ?? [...canonicalCards]
    .filter((card) => card.status !== "answered")
    .sort((left, right) => (prCardStageAndAttempt(right)?.attempt ?? -1) - (prCardStageAndAttempt(left)?.attempt ?? -1))[0];
  if (!canonical) return { action: "no_action" };
  const reviewerAgentId = canonical.addresseeAgentId;
  if (!reviewerAgentId) return { action: "no_action" };
  const parsed = prCardStageAndAttempt(canonical);
  if (!parsed) return { action: "protocol_failure", reason: "invalid_card_identity" };
  const withdrawInteractionIds = input.cards
    .filter((card) => card.id !== canonical.id && card.kind === "request_item_verdicts" && card.status === "pending")
    .filter((card) => card.idempotencyKey?.startsWith(`jules:plan-review:v2:${input.issueId}:`))
    .map((card) => card.id);
  // Only a pending card can be dispatched. A cancelled/withdrawn card is not
  // evidence of a terminal reviewer run and must not trigger card churn.
  if (canonical.status !== "pending") return { action: "no_action" };

  const exactRuns = input.reviewerRuns.filter((run) =>
    run.issueId === input.issueId && run.agentId === reviewerAgentId && run.interactionId === canonical.id,
  );
  const decision = decideNativeReviewDispatch({
    identity: {
      issueId: input.issueId,
      reviewerAgentId,
      immutableKey: canonical.idempotencyKey!,
    },
    card: {
      id: canonical.id,
      status: "pending",
      createdAt: canonical.createdAt ?? "",
      reviewerAgentId,
      immutableKey: canonical.idempotencyKey!,
      attempt: parsed.attempt,
    },
    runs: exactRuns.map((run) => ({
      id: run.id,
      status: run.status as NativeReviewRunStatus,
      issueId: run.issueId ?? input.issueId,
      reviewerAgentId: run.agentId ?? reviewerAgentId,
      interactionId: run.interactionId ?? null,
      startedAt: null,
      finishedAt: null,
    })),
    nowMs: input.nowMs,
    graceMs: input.graceMs,
    maxReplacementAttempts: input.maxReplacementAttempts,
  });
  switch (decision.action) {
    case "await_native_dispatch":
      return { action: "await_native_dispatch", interactionId: canonical.id };
    case "await_run":
      return { action: "await_run", interactionId: canonical.id, runId: decision.runId };
    case "await_verdict":
      return { action: "await_verdict", interactionId: canonical.id, runId: decision.runId };
    case "recover_dispatch":
      return {
        action: "recover_dispatch",
        interactionId: decision.interactionId,
        reviewerAgentId: decision.reviewerAgentId,
        stage: parsed.stage,
        immutableKey: decision.immutableKey,
      };
    case "consume_verdict":
      return { action: "no_action" };
    case "retry_exhausted":
      return decision;
    case "replace_card":
      return {
        ...decision,
        reviewerAgentId,
        stage: parsed.stage,
        withdrawInteractionIds,
      };
    case "protocol_failure":
      return decision;
  }
}
