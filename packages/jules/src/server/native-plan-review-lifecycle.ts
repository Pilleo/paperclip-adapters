import { z } from "zod";

const ReviewIdentitySchema = z.object({
  childIssueId: z.string().min(1),
  interactionId: z.string().min(1),
  reviewerAgentId: z.string().min(1),
}).readonly();

const ReviewCardSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("request_item_verdicts"),
  status: z.enum(["pending", "answered"]),
  addresseeAgentId: z.string().min(1),
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
}).passthrough();

const ChildStatusSchema = z.enum(["backlog", "todo", "in_progress", "blocked", "in_review", "done", "cancelled"]);

export interface NativePlanReviewLifecycleInput {
  readonly identity: z.input<typeof ReviewIdentitySchema>;
  readonly childStatus: z.input<typeof ChildStatusSchema>;
  readonly card: unknown | null;
  readonly runs: readonly unknown[];
  readonly nowMs: number;
  readonly maxRecoveryAttempts: number;
}

export type NativePlanReviewAction =
  | { readonly action: "create_card" }
  | { readonly action: "wake_card"; readonly interactionId: string }
  | { readonly action: "await_run"; readonly runId: string }
  | { readonly action: "await_verdict"; readonly runId: string }
  | { readonly action: "recover_card"; readonly interactionId: string; readonly failedRunId: string; readonly attempt: number }
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
  if (!Number.isFinite(raw.nowMs) || !Number.isInteger(raw.maxRecoveryAttempts) || raw.maxRecoveryAttempts < 0) {
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
  if (card.status === "answered") return { action: "consume_verdict", interactionId: card.id };

  const runsResult = z.array(ReviewRunSchema).safeParse(raw.runs);
  if (!runsResult.success) return { action: "escalate_protocol_failure", reason: "invalid_run_evidence" };
  const boundRuns = runsResult.data.filter((run) =>
    run.issueId === identity.childIssueId &&
    run.agentId === identity.reviewerAgentId &&
    run.interactionId === identity.interactionId &&
    run.interactionKind === "request_item_verdicts",
  );
  const current = latestRun(boundRuns);
  if (!current) return { action: "wake_card", interactionId: card.id };

  switch (current.status) {
    case "queued":
    case "running":
      return { action: "await_run", runId: current.id };
    case "succeeded":
      return { action: "await_verdict", runId: current.id };
    case "failed":
    case "cancelled":
    case "timed_out": {
      const failedRuns = boundRuns.filter((run) =>
        run.status === "failed" || run.status === "cancelled" || run.status === "timed_out",
      );
      if (failedRuns.length > raw.maxRecoveryAttempts) {
        return { action: "escalate_protocol_failure", reason: "recovery_budget_exhausted" };
      }
      return {
        action: "recover_card",
        interactionId: card.id,
        failedRunId: current.id,
        attempt: failedRuns.length,
      };
    }
    default:
      return assertNever(current.status);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled native plan review run status: ${String(value)}`);
}
