import { z } from "zod";
import { nativePlanReviewStageId, parsePlanReviewIdempotencyKey } from "@pilleo/paperclip-adapter-common";

const Principal = z.object({ type: z.literal("agent"), agentId: z.string().min(1) });
const Context = z.object({
  issueId: z.string().min(1), interactionId: z.string().nullish(),
  executionStage: z.object({
    stageId: z.string(), stageType: z.literal("review"), wakeRole: z.literal("reviewer"),
    currentParticipant: Principal, returnAssignee: Principal,
  }).optional(),
});
const Run = z.object({
  id: z.string(), companyId: z.string(), agentId: z.string(),
  status: z.enum(["queued", "running", "scheduled", "succeeded", "failed", "cancelled", "timed_out", "interrupted"]),
  contextSnapshot: Context,
});
const Card = z.object({
  id: z.string(), companyId: z.string(), issueId: z.string(), kind: z.literal("request_item_verdicts"),
  status: z.string(), addresseeAgentId: z.string(), idempotencyKey: z.string(),
  resolvedByAgentId: z.string().nullish(), resolvedByRunId: z.string().nullish(), sourceRunId: z.string(),
  payload: z.object({ target: z.object({ type: z.literal("issue_document"), issueId: z.string(),
    key: z.literal("plan"), documentId: z.string(), revisionId: z.string(), revisionNumber: z.number().int().positive() }) }),
  result: z.unknown().optional(),
});
const Verdict = z.object({ outcome: z.literal("resolved"), complete: z.literal(true),
  items: z.array(z.object({ id: z.literal("plan"), verdict: z.enum(["approve", "reject"]), reason: z.string().optional() })).length(1) });
const Policy = z.object({ mode: z.literal("normal").optional(), monitor: z.null().optional(),
  stages: z.array(z.object({ id: z.string(), type: z.literal("review"), participants: z.array(Principal).length(1) })).length(1) });
const State = z.object({ status: z.literal("pending"), currentStageId: z.string(), currentStageType: z.literal("review"),
  currentParticipant: Principal, returnAssignee: Principal });
const Issue = z.object({ id: z.string(), companyId: z.string(), status: z.string(), assigneeAgentId: z.string(),
  executionRunId: z.string().nullish(), executionBlocker: z.unknown().optional(),
  executionPolicy: z.unknown(), executionState: z.unknown() });

export interface NativePlanReconciliationEvidence {
  readonly companyId: string;
  readonly issueId: string;
  readonly ownerId: string;
  readonly reviewerId: string;
  readonly sessionId: string;
  readonly issue: unknown;
  readonly cards: readonly unknown[];
  readonly document: unknown;
  readonly sourceRun: unknown;
  readonly runs: readonly unknown[];
  readonly runsComplete: boolean;
}

export type NativePlanReconciliationDecision =
  | { readonly kind: "await_verdict" }
  | { readonly kind: "await_reviewer_settlement" }
  | { readonly kind: "return_to_jules"; readonly interactionId: string; readonly ownerId: string; readonly stageId: string }
  | { readonly kind: "verify_jules_continuation"; readonly interactionId: string; readonly ownerId: string }
  | { readonly kind: "conflict"; readonly reason: string };

/** Pure gate. An answered card is evidence, never permission to cancel an active reviewer. */
export function decideNativePlanReviewReconciliation(input: NativePlanReconciliationEvidence): NativePlanReconciliationDecision {
  const conflict = (reason: string): NativePlanReconciliationDecision => ({ kind: "conflict", reason });
  const issueResult = Issue.safeParse(input.issue);
  if (!input.runsComplete || !issueResult.success || !input.sessionId || input.ownerId === input.reviewerId) return conflict("incomplete_evidence");
  const issue = issueResult.data;
  if (issue.id !== input.issueId || issue.companyId !== input.companyId || issue.executionBlocker != null) return conflict("issue_identity_or_recovery_hold");
  const runsResult = z.array(Run).safeParse(input.runs);
  if (!runsResult.success) return conflict("invalid_run_evidence");
  const runs = runsResult.data;
  if (runs.some((run) => run.companyId !== input.companyId || run.agentId !== input.reviewerId || run.contextSnapshot.issueId !== input.issueId)) return conflict("foreign_run_evidence");
  if (issue.executionRunId || runs.some((run) => run.status === "queued" || run.status === "running" || run.status === "scheduled")) return { kind: "await_reviewer_settlement" };
  const cards = input.cards.map((raw) => Card.safeParse(raw));
  if (cards.some((card) => !card.success)) return conflict("invalid_card_evidence");
  const candidates = cards.flatMap((card) => {
    if (!card.success) return [];
    const key = parsePlanReviewIdempotencyKey(card.data.idempotencyKey);
    return key && key.issueId === input.issueId && key.sessionId === input.sessionId &&
      card.data.addresseeAgentId === input.reviewerId ? [{ card: card.data, key }] : [];
  });
  const document = z.object({ id: z.string(), latestRevisionId: z.string(), latestRevisionNumber: z.number().int().positive() }).safeParse(input.document);
  if (!document.success) return conflict("invalid_document");
  const current = candidates.filter(({ key }) => key.revisionId === document.data.latestRevisionId);
  if (current.length !== 1) return conflict("ambiguous_or_stale_card");
  const selected = current[0];
  if (!selected) return conflict("missing_card");
  const { card, key } = selected;
  const target = card.payload.target;
  if (card.companyId !== input.companyId || card.issueId !== input.issueId || target.issueId !== input.issueId ||
      target.documentId !== document.data.id || target.revisionId !== key.revisionId || target.revisionNumber !== document.data.latestRevisionNumber) return conflict("card_target_mismatch");
  if (card.status === "pending") return { kind: "await_verdict" };
  const verdict = Verdict.safeParse(card.result);
  const item = verdict.success ? verdict.data.items[0] : undefined;
  if (card.status !== "answered" || !item || (item.verdict === "reject" && !item.reason?.trim()) ||
      card.resolvedByAgentId !== input.reviewerId) return conflict("invalid_verdict");
  const source = z.object({ id: z.string(), companyId: z.string(), agentId: z.string(), contextSnapshot: Context }).safeParse(input.sourceRun);
  if (!source.success || source.data.id !== card.sourceRunId || source.data.companyId !== input.companyId ||
      source.data.agentId !== input.ownerId || source.data.contextSnapshot.issueId !== input.issueId) return conflict("invalid_source_run");
  const run = runs.find((candidate) => candidate.id === card.resolvedByRunId);
  if (!run || run.status !== "succeeded") return conflict("unsettled_or_failed_verdict_run");
  const stageId = nativePlanReviewStageId(input.issueId, key.revisionId, key.stage);
  const stage = run.contextSnapshot.executionStage;
  const binding = run.contextSnapshot.interactionId;
  if (binding !== card.id && !(binding == null && stage?.stageId === stageId &&
      stage.currentParticipant.agentId === input.reviewerId && stage.returnAssignee.agentId === input.ownerId)) return conflict("verdict_run_binding_mismatch");
  if (issue.status === "in_progress" && issue.assigneeAgentId === input.ownerId && issue.executionPolicy === null) {
    return { kind: "verify_jules_continuation", interactionId: card.id, ownerId: input.ownerId };
  }
  const policy = Policy.safeParse(issue.executionPolicy);
  const state = State.safeParse(issue.executionState);
  if (!policy.success || !state.success || issue.status !== "in_review" || issue.assigneeAgentId !== input.reviewerId ||
      policy.data.stages[0]?.id !== stageId || policy.data.stages[0]?.participants[0]?.agentId !== input.reviewerId ||
      state.data.currentStageId !== stageId || state.data.currentParticipant.agentId !== input.reviewerId ||
      state.data.returnAssignee.agentId !== input.ownerId) return conflict("unowned_review_stage");
  return { kind: "return_to_jules", interactionId: card.id, ownerId: input.ownerId, stageId };
}
