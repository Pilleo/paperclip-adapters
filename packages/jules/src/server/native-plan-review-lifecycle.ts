import { z } from "zod";
import {
  decideNativeReviewDispatch,
  nativePlanReviewStageId,
  parsePlanReviewIdempotencyKey,
  type NativeReviewRunStatus,
} from "@pilleo/paperclip-adapter-common";

const ReviewIdentitySchema = z.object({
  childIssueId: z.string().min(1),
  interactionId: z.string().min(1),
  reviewerAgentId: z.string().min(1),
  immutableKey: z.string().min(1),
}).readonly();

const ReviewCardSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("request_item_verdicts"),
  status: z.enum(["pending", "answered"]),
  addresseeAgentId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  createdAt: z.string().min(1),
}).passthrough();

const ReviewRunSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "timed_out"]),
  issueId: z.string().min(1),
  agentId: z.string().min(1),
  interactionId: z.string().nullable(),
  interactionKind: z.string().nullable(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  error: z.string().optional(),
  stopReason: z.string().nullable().optional(),
  errorCode: z.string().nullable().optional(),
  stageId: z.string().nullable().optional(),
  stageType: z.string().nullable().optional(),
  wakeRole: z.string().nullable().optional(),
  currentParticipantAgentId: z.string().nullable().optional(),
  returnAssigneeAgentId: z.string().nullable().optional(),
}).passthrough();

const ChildStatusSchema = z.enum(["backlog", "todo", "in_progress", "blocked", "in_review", "done", "cancelled"]);

export interface NativePlanReviewLifecycleInput {
  readonly identity: z.input<typeof ReviewIdentitySchema>;
  readonly childStatus: unknown;
  readonly card: unknown | null;
  readonly runs: readonly unknown[];
  readonly nowMs: number;
  readonly graceMs: number;
  readonly maxRecoveryAttempts: number;
}

export type NativePlanReviewAction =
  | { readonly action: "create_card" }
  | { readonly action: "await_native_dispatch" }
  | { readonly action: "await_run"; readonly runId: string }
  | { readonly action: "await_verdict"; readonly runId: string }
  | {
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
  | { readonly action: "consume_verdict"; readonly interactionId: string }
  | { readonly action: "escalate_protocol_failure"; readonly reason:
      | "invalid_identity"
      | "invalid_child_status"
      | "invalid_card_evidence"
      | "ambiguous_canonical_card"
      | "card_identity_mismatch"
      | "invalid_run_evidence"
      | "recovery_budget_exhausted" };

function latestRun<T extends { readonly startedAt: string | null }>(runs: readonly T[]): T | undefined {
  return [...runs].sort((left, right) =>
    Date.parse(right.startedAt ?? "1970-01-01T00:00:00.000Z") -
    Date.parse(left.startedAt ?? "1970-01-01T00:00:00.000Z"),
  )[0];
}

export function decideNativePlanReviewLifecycle(
  raw: NativePlanReviewLifecycleInput,
): NativePlanReviewAction {
  const identityResult = ReviewIdentitySchema.safeParse(raw.identity);
  if (!identityResult.success) return { action: "escalate_protocol_failure", reason: "invalid_identity" };
  if (!ChildStatusSchema.safeParse(raw.childStatus).success) {
    return { action: "escalate_protocol_failure", reason: "invalid_child_status" };
  }
  if (!Number.isFinite(raw.nowMs) || !Number.isFinite(raw.graceMs) || raw.graceMs < 0 ||
      !Number.isInteger(raw.maxRecoveryAttempts) || raw.maxRecoveryAttempts < 0) {
    return { action: "escalate_protocol_failure", reason: "invalid_run_evidence" };
  }

  if (raw.card === null) return { action: "create_card" };
  if (raw.card && typeof raw.card === "object" && !Array.isArray(raw.card) &&
      "duplicate" in raw.card) {
    const duplicate = z.object({ duplicate: z.array(ReviewCardSchema).min(2) }).safeParse(raw.card);
    return duplicate.success
      ? { action: "escalate_protocol_failure", reason: "ambiguous_canonical_card" }
      : { action: "escalate_protocol_failure", reason: "invalid_card_evidence" };
  }

  const cardResult = ReviewCardSchema.safeParse(raw.card);
  if (!cardResult.success) return { action: "escalate_protocol_failure", reason: "invalid_card_evidence" };
  const identity = identityResult.data;
  const card = cardResult.data;
  if (card.id !== identity.interactionId || card.addresseeAgentId !== identity.reviewerAgentId) {
    return { action: "escalate_protocol_failure", reason: "card_identity_mismatch" };
  }
  if (card.idempotencyKey !== identity.immutableKey) {
    return { action: "escalate_protocol_failure", reason: "card_identity_mismatch" };
  }

  const runsResult = z.array(ReviewRunSchema).safeParse(raw.runs);
  if (!runsResult.success) return { action: "escalate_protocol_failure", reason: "invalid_run_evidence" };
  const parsedKey = parsePlanReviewIdempotencyKey(card.idempotencyKey);
  if (!parsedKey) return { action: "escalate_protocol_failure", reason: "card_identity_mismatch" };
  const expectedStageId = nativePlanReviewStageId(parsedKey.issueId, parsedKey.revisionId, parsedKey.stage);
  const stageRuns = runsResult.data.filter((run) =>
    run.issueId === identity.childIssueId && run.agentId === identity.reviewerAgentId &&
    run.interactionId === null && run.stageId != null);
  if (stageRuns.some((run) => run.stageId !== expectedStageId || run.stageType !== "review" ||
      run.wakeRole !== "reviewer" || run.currentParticipantAgentId !== identity.reviewerAgentId ||
      !run.returnAssigneeAgentId)) {
    return { action: "escalate_protocol_failure", reason: "invalid_run_evidence" };
  }
  const boundRuns = runsResult.data.filter((run) =>
    run.issueId === identity.childIssueId &&
    run.agentId === identity.reviewerAgentId &&
    run.interactionId === identity.interactionId &&
    run.interactionKind === "request_item_verdicts",
  );
  const decision = decideNativeReviewDispatch({
    identity: {
      issueId: identity.childIssueId,
      reviewerAgentId: identity.reviewerAgentId,
      immutableKey: identity.immutableKey,
    },
    card: {
      id: card.id,
      status: card.status,
      createdAt: card.createdAt,
      reviewerAgentId: card.addresseeAgentId,
      immutableKey: card.idempotencyKey,
      attempt: parsedKey.generation,
    },
    runs: [...boundRuns, ...stageRuns].map((run) => ({
      id: run.id,
      status: run.status as NativeReviewRunStatus,
      issueId: run.issueId,
      reviewerAgentId: run.agentId,
      interactionId: run.interactionId ?? card.id,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      stopReason: run.stopReason ?? null,
      errorCode: run.errorCode ?? null,
    })),
    nowMs: raw.nowMs,
    graceMs: raw.graceMs,
    maxReplacementAttempts: raw.maxRecoveryAttempts,
  });
  switch (decision.action) {
    case "await_native_dispatch":
    case "await_run":
    case "await_verdict":
    case "consume_verdict":
    case "recover_dispatch":
    case "replace_card":
      return decision;
    case "retry_exhausted":
      return { action: "escalate_protocol_failure", reason: "recovery_budget_exhausted" };
    case "protocol_failure":
      return {
        action: "escalate_protocol_failure",
        reason: decision.reason === "card_identity_mismatch" ? "card_identity_mismatch" : "invalid_run_evidence",
      };
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled native plan review run status: ${String(value)}`);
}
