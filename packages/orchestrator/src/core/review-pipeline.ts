import { ParsedIssueMetadata, IssueStatus } from "./types.js";
import { PrCiCheckResult } from "./github-sync.js";
import { PaperclipApprovalSummary } from "./approvals.js";
import type { HeartbeatRunSummary } from "./session-continuation.js";
import { reviewInteractionIdempotencyKey, reviewInteractionIdempotencyKeys, reviewInteractionKeyPrefix, reviewVerdictFromInteraction, type PrReviewStage } from "./review-interaction-state.js";
import { reduceReviewEpoch, type ReviewEpochStage } from "./review-epoch.js";

export type ReviewStage =
  | "ci_gate"
  | "vibe_review"
  | "strong_review"
  | "luna_review"
  | "terra_review"
  | "operator_approval"
  | "completed";

export interface ReviewPipelineParams {
  readonly issue: ParsedIssueMetadata;
  readonly prNumber?: number | undefined;
  readonly prUrl?: string | undefined;
  readonly ciStatus?: PrCiCheckResult | undefined;
  /** Native Paperclip review cards; comments are deliberately not protocol input. */
  readonly interactions?: readonly {
    readonly id: string;
    readonly kind?: string | undefined;
    readonly status?: string | undefined;
    readonly idempotencyKey?: string | undefined;
    readonly result?: unknown;
  }[] | undefined;
  /** All recent runs, including terminal runs, used as the durable recovery lease. */
  readonly heartbeatRuns?: readonly Pick<HeartbeatRunSummary, "id" | "agentId" | "status" | "issueId" | "interactionId">[] | undefined;
  readonly reviewHeadSha?: string | undefined;
  /** Legacy input retained only to prove comments cannot transition review. */
  readonly comments?: readonly unknown[] | undefined;
  readonly existingApprovals: readonly PaperclipApprovalSummary[];
  readonly vibeReviewerAgentId?: string | undefined;
  readonly reviewerAgentId?: string | undefined;
  readonly lunaReviewerAgentId?: string | undefined;
  readonly terraReviewerAgentId?: string | undefined;
  readonly workerAgentId?: string | undefined;
  /** Persisted Paperclip execution state used to make dispatch idempotent. */
  readonly executionState?: {
    readonly status?: string | undefined;
    readonly currentStageIndex?: number | null | undefined;
    readonly currentParticipant?: { readonly type?: string; readonly agentId?: string | null } | null | undefined;
  } | null | undefined;
  /** Current Paperclip lifecycle status of the active reviewer, when known. */
  readonly reviewerAgentStatus?: string | undefined;
}

export type ReviewPipelineDecision =
  | {
      readonly stage: "ci_gate";
      readonly action: "AWAIT_CI";
      readonly reason: string;
    }
  | {
      readonly stage: "vibe_review";
      readonly action: "DISPATCH_VIBE_REVIEW";
      readonly targetAgentId: string;
      readonly reason: string;
    }
  | {
      readonly stage: "strong_review";
      readonly action: "DISPATCH_STRONG_REVIEW";
      readonly targetAgentId: string;
      readonly reason: string;
    }
  | {
      readonly stage: "luna_review" | "terra_review";
      readonly action: "DISPATCH_LUNA_REVIEW" | "DISPATCH_TERRA_REVIEW";
      readonly targetAgentId: string;
      readonly reason: string;
    }
  | {
      readonly stage: "luna_review" | "terra_review";
      readonly action: "RECOVER_REVIEW";
      readonly targetAgentId: string;
      readonly reason: string;
    }
  | {
      readonly stage: "luna_review" | "terra_review";
      readonly action: "AWAIT_REVIEW_CONFIGURATION";
      readonly reason: string;
    }
  | {
      readonly stage: "luna_review" | "terra_review";
      readonly action: "AWAIT_REVIEW";
      readonly reason: string;
    }
  | {
      readonly stage: "luna_review" | "terra_review";
      readonly action: "AWAIT_OPERATOR_RECOVERY";
      readonly reason: string;
    }
  | {
      readonly stage: "operator_approval";
      readonly action: "CREATE_MERGE_APPROVAL";
      readonly prNumber?: number | undefined;
      readonly prUrl?: string | undefined;
      readonly vibeSummary?: string | undefined;
      readonly strongSummary?: string | undefined;
      readonly reason: string;
    }
  | {
      readonly stage: "operator_approval";
      readonly action: "AWAIT_OPERATOR_APPROVAL";
      readonly approvalId: string;
      readonly reason: string;
    }
  | {
      readonly stage: "operator_approval";
      readonly action: "RECONCILE_OPERATOR_GATE";
      readonly approvalId: string;
      readonly reason: string;
    }
  | {
      readonly stage: "completed";
      readonly action: "EXECUTE_MERGE";
      readonly prNumber?: number | undefined;
      readonly prUrl?: string | undefined;
      readonly reason: string;
    }
  | {
      readonly stage: "vibe_review" | "strong_review" | "luna_review" | "terra_review" | "operator_approval";
      readonly action: "REASSIGN_TO_WORKER";
      readonly targetStatus: IssueStatus;
      readonly targetAssigneeId: string | null;
      readonly feedbackSummary?: string | undefined;
      readonly reason: string;
    };

function findMergeApproval(
  approvals: readonly PaperclipApprovalSummary[],
  issueId: string,
): PaperclipApprovalSummary | undefined {
  return approvals.find((approval) =>
    (approval.type === "task_merge_approval" ||
      (approval.type === "request_board_approval" && approval.payload?.["action"] === "task_merge")) &&
    (approval.issueIds.includes(issueId) || approval.payload?.["issueId"] === issueId),
  );
}

/**
 * Pure multi-tier review pipeline evaluator.
 * Progresses PRs strictly through:
 * 1. CI Gate (100% green)
 * 2. Cheap Vibe Fast Review
 * 3. Deep Strong Model Review (Terra / Grok)
 * 4. Human Operator Final Merge Gate
 */
export function evaluateReviewPipelineProgress(
  params: ReviewPipelineParams
): ReviewPipelineDecision {
  const {
    issue,
    prNumber,
    prUrl,
    ciStatus,
    interactions = [],
    reviewHeadSha,
    existingApprovals,
    vibeReviewerAgentId,
    reviewerAgentId,
    lunaReviewerAgentId,
    terraReviewerAgentId,
    workerAgentId,
    executionState,
    reviewerAgentStatus,
  } = params;

  // 1. Stage 1: CI Gate
  if (!ciStatus || !ciStatus.isGreen) {
    const statusText = ciStatus ? ciStatus.status : "unknown";
    return {
      stage: "ci_gate",
      action: "AWAIT_CI",
      reason: `CI check status is "${statusText}". Waiting for green build before starting review chain.`,
    };
  }

  const verdictFor = (stage: PrReviewStage) => {
    const identity = {
      issueId: issue.id,
      prUrl: prUrl || `pr-${prNumber || "unknown"}`,
      headSha: reviewHeadSha || "unknown",
      stage,
    } as const;
    const exactKeys = reviewInteractionIdempotencyKeys(identity);
    // Paperclip/GitHub integrations have historically returned the same PR
    // as both its web URL and API URL. The immutable identity is the issue,
    // head SHA, and stage; tolerate only that URL spelling difference so an
    // answered native card cannot cause an unnecessary second reviewer run.
    const interaction = interactions.find((candidate) => {
      const key = candidate.idempotencyKey || "";
      const matchesIdentity = exactKeys.includes(key) || (
        key.includes(`:${issue.id}:`) &&
        (reviewHeadSha
          ? /^pr-review:v(?:9|10|11|12):/.test(key) && key.endsWith(`:${reviewHeadSha}:${stage}`)
          // If GitHub could not provide the current head, retain only a
          // versioned review card carrying a real commit SHA; do not fall
          // back to prose or an unbound URL-only card.
          : new RegExp(`:v\\d+:.*:[0-9a-f]{40}:${stage}$`, "i").test(key))
      );
      // Expired/cancelled generations are retained by Paperclip and may
      // appear before the answered replacement. Only an answered card can
      // be evidence of a verdict; pending cards are handled by the durable
      // execution-state wait path below.
      return matchesIdentity && candidate.status === "answered";
    });
    return reviewVerdictFromInteraction(interaction, interaction?.id);
  };

  // Paperclip's execution state is the durable dispatch lock. Once the
  // active participant owns a stage, repeated heartbeats must not create new
  // runs merely because a card is pending, expired, or otherwise lacks a
  // usable verdict. A missing card is the sole repair case: the caller may
  // create one card for the already-active stage, after which this guard holds.
  const activeStageHasCard = (stage: PrReviewStage): boolean => {
    const expectedKey = reviewInteractionIdempotencyKey({
      issueId: issue.id,
      prUrl: prUrl || `pr-${prNumber || "unknown"}`,
      headSha: reviewHeadSha || "unknown",
      stage,
    });
    return interactions.some((interaction) => interaction.idempotencyKey === expectedKey &&
      (interaction.status === "pending" || interaction.status === "answered"));
  };
  const activeReviewerOwnsStage = (stage: PrReviewStage, reviewerAgentId: string): boolean => {
    const expectedIndex = stage === "luna" ? 0 : stage === "terra" ? 1 : null;
    return executionState?.status === "pending" &&
      executionState.currentParticipant?.type === "agent" &&
      executionState.currentParticipant.agentId === reviewerAgentId &&
      (expectedIndex === null || executionState.currentStageIndex === expectedIndex);
  };
  const awaitActiveReview = (stage: "luna" | "terra", reviewerAgentId: string): ReviewPipelineDecision | null => {
    const expectedIndex = stage === "luna" ? 0 : 1;
    const humanEscalationOwnsStage = executionState?.status === "pending" &&
      executionState.currentParticipant?.type === "user" &&
      executionState.currentStageIndex === expectedIndex;
    if (!humanEscalationOwnsStage && (!activeReviewerOwnsStage(stage, reviewerAgentId) || !activeStageHasCard(stage))) return null;
    return {
      stage: stage === "luna" ? "luna_review" : "terra_review",
      action: "AWAIT_REVIEW",
      reason: humanEscalationOwnsStage
        ? `Review is escalated to the human participant; no agent review may restart for this immutable PR head.`
        : `A native ${stage} review card already exists for this immutable PR head; waiting for its terminal verdict.`,
    };
  };

  // New reviewer lane is selected whenever configured. It is intentionally
  // separate from the legacy Vibe lane so stale Vibe verdicts cannot approve.
  if (lunaReviewerAgentId !== undefined || terraReviewerAgentId !== undefined) {
    if (!lunaReviewerAgentId) return { stage: "luna_review", action: "AWAIT_REVIEW_CONFIGURATION", reason: "OpenAI Luna reviewer is not configured; refusing to skip the weak review stage." };
    const lunaVerdict = verdictFor("luna");
    if (lunaVerdict?.decision === "needs_work") return { stage: "luna_review", action: "REASSIGN_TO_WORKER", targetStatus: "in_progress", targetAssigneeId: workerAgentId || null, feedbackSummary: lunaVerdict.reason, reason: `Luna review requested changes on [${issue.identifier || issue.id}].` };
    // A terminal native verdict is the transition event. Never wake the
    // reviewer to ask it to perform Paperclip bookkeeping; the orchestrator
    // owns the next-stage transition below.
    const lunaWait = lunaVerdict?.decision === "all_good" ? null : awaitActiveReview("luna", lunaReviewerAgentId);
    if (lunaWait) return lunaWait;
    if (lunaVerdict?.decision !== "all_good") return { stage: "luna_review", action: "DISPATCH_LUNA_REVIEW", targetAgentId: lunaReviewerAgentId, reason: `CI is green; routing [${issue.identifier || issue.id}] to OpenAI Luna for the first review.` };
    if (!terraReviewerAgentId) return { stage: "terra_review", action: "AWAIT_REVIEW_CONFIGURATION", reason: "OpenAI Terra reviewer is not configured; refusing to skip the strong review stage." };
    const terraVerdict = verdictFor("terra");
    if (terraVerdict?.decision === "needs_work") return { stage: "terra_review", action: "REASSIGN_TO_WORKER", targetStatus: "in_progress", targetAssigneeId: workerAgentId || null, feedbackSummary: terraVerdict.reason, reason: `Terra review requested changes on [${issue.identifier || issue.id}].` };
    const terraWait = terraVerdict?.decision === "all_good" ? null : awaitActiveReview("terra", terraReviewerAgentId);
    if (terraWait) return terraWait;
    if (terraVerdict?.decision !== "all_good") return { stage: "terra_review", action: "DISPATCH_TERRA_REVIEW", targetAgentId: terraReviewerAgentId, reason: `Luna approved; routing [${issue.identifier || issue.id}] to OpenAI Terra for the strong review.` };
    const mergeApproval = findMergeApproval(existingApprovals, issue.id);
    if (!mergeApproval) {
      return { stage: "operator_approval", action: "CREATE_MERGE_APPROVAL", prNumber, prUrl, reason: `Luna and Terra approved [${issue.identifier || issue.id}]. Creating final operator merge approval card.` };
    }
    if (mergeApproval.status === "approved") {
      return { stage: "completed", action: "EXECUTE_MERGE", prNumber, prUrl, reason: `Operator approved final merge for [${issue.identifier || issue.id}] (approval ${mergeApproval.id}). Ready for automated merge.` };
    }
    if (mergeApproval.status === "rejected") {
      return {
        stage: "operator_approval",
        action: "REASSIGN_TO_WORKER",
        targetStatus: "in_progress",
        targetAssigneeId: workerAgentId || null,
        feedbackSummary: `Operator rejected merge approval ${mergeApproval.id}`,
        reason: `Operator rejected merge approval for [${issue.identifier || issue.id}]. Reassigning back to worker.`,
      };
    }
    const staleReviewerOwnership = hasStaleReviewerOwnership({
      assigneeAgentId: issue.rawIssue["assigneeAgentId"] as string | null | undefined,
      executionPolicy: issue.rawIssue["executionPolicy"],
      executionState: issue.rawIssue["executionState"],
    });
    return {
      stage: "operator_approval",
      action: staleReviewerOwnership ? "RECONCILE_OPERATOR_GATE" : "AWAIT_OPERATOR_APPROVAL",
      approvalId: mergeApproval.id,
      reason: staleReviewerOwnership
        ? `Awaiting operator final review & merge approval in Paperclip (approval ${mergeApproval.id}); clearing stale reviewer execution ownership.`
        : `Awaiting operator final review & merge approval in Paperclip (approval ${mergeApproval.id}).`,
    };
  }

  // Native interaction verdicts are authoritative. Comments, prose, and
  // assignment history cannot approve/reject a PR review stage.
  const vibeVerdict = vibeReviewerAgentId ? verdictFor("vibe") : { decision: "all_good" as const };

  // 2. Stage 2: Cheap Vibe Fast Review
  if (vibeReviewerAgentId) {
    if (vibeVerdict?.decision === "needs_work") {
      return {
        stage: "vibe_review",
        action: "REASSIGN_TO_WORKER",
        targetStatus: "in_progress",
        targetAssigneeId: workerAgentId || null,
        feedbackSummary: vibeVerdict.reason,
        reason: `Vibe fast review requested changes on [${issue.identifier || issue.id}]. Reassigning back to worker in_progress (skipping strong review).`,
      };
    }

    if (vibeVerdict?.decision !== "all_good") {
      return {
        stage: "vibe_review",
        action: "DISPATCH_VIBE_REVIEW",
        targetAgentId: vibeReviewerAgentId,
        reason: `CI is green; routing [${issue.identifier || issue.id}] to Vibe for cheap triage & structural sanity review.`,
      };
    }
  }

  // Evaluate Strong Model review verdict (Terra / Grok / Strong Reviewer)
  const strongVerdict = reviewerAgentId ? verdictFor("strong") : { decision: "all_good" as const };

  // 3. Stage 3: Deep Strong Model Review
  if (reviewerAgentId) {
    if (strongVerdict?.decision === "needs_work") {
      return {
        stage: "strong_review",
        action: "REASSIGN_TO_WORKER",
        targetStatus: "in_progress",
        targetAssigneeId: workerAgentId || null,
        feedbackSummary: strongVerdict.reason,
        reason: `Strong model review requested changes on [${issue.identifier || issue.id}]. Reassigning back to worker in_progress.`,
      };
    }

    if (strongVerdict?.decision !== "all_good") {
      return {
        stage: "strong_review",
        action: "DISPATCH_STRONG_REVIEW",
        targetAgentId: reviewerAgentId,
        reason: `Vibe triage passed; routing [${issue.identifier || issue.id}] to Strong Reviewer for deep invariant & security audit.`,
      };
    }
  }

  // 4. Stage 4: Operator Final Review & Merge Approval Gate
  const matchingMergeApproval = findMergeApproval(existingApprovals, issue.id);

  if (!matchingMergeApproval) {
    return {
      stage: "operator_approval",
      action: "CREATE_MERGE_APPROVAL",
      prNumber,
      prUrl,
      vibeSummary: vibeVerdict?.decision === "needs_work" ? vibeVerdict.reason : undefined,
      strongSummary: strongVerdict?.decision === "needs_work" ? strongVerdict.reason : undefined,
      reason: `Both Vibe and Strong Reviewer approved [${issue.identifier || issue.id}]. Creating final operator merge approval card.`,
    };
  }

  if (matchingMergeApproval.status === "approved") {
    return {
      stage: "completed",
      action: "EXECUTE_MERGE",
      prNumber,
      prUrl,
      reason: `Operator approved final merge for [${issue.identifier || issue.id}] (approval ${matchingMergeApproval.id}). Ready for automated merge.`,
    };
  }

  if (matchingMergeApproval.status === "rejected") {
    return {
      stage: "operator_approval",
      action: "REASSIGN_TO_WORKER",
      targetStatus: "in_progress",
      targetAssigneeId: workerAgentId || null,
      feedbackSummary: `Operator rejected merge approval ${matchingMergeApproval.id}`,
      reason: `Operator rejected merge approval for [${issue.identifier || issue.id}]. Reassigning back to worker.`,
    };
  }

  const staleReviewerOwnership = hasStaleReviewerOwnership({
    assigneeAgentId: issue.rawIssue["assigneeAgentId"] as string | null | undefined,
    executionPolicy: issue.rawIssue["executionPolicy"],
    executionState: issue.rawIssue["executionState"],
  });
  return {
    stage: "operator_approval",
    action: staleReviewerOwnership ? "RECONCILE_OPERATOR_GATE" : "AWAIT_OPERATOR_APPROVAL",
    approvalId: matchingMergeApproval.id,
    reason: staleReviewerOwnership
      ? `Awaiting operator final review & merge approval in Paperclip (approval ${matchingMergeApproval.id}); clearing stale reviewer execution ownership.`
      : `Awaiting operator final review & merge approval in Paperclip (approval ${matchingMergeApproval.id}).`,
  };
}

/**
 * Paperclip can restore the first native review participant after a server
 * restart even though the durable review cards and merge approval are done.
 * The operator approval is now the authoritative gate, so the adapter must
 * remove reviewer execution ownership while preserving the visible review
 * status. The caller applies this only when one of these fields is stale.
 */
export function operatorGateReconciliationPatch(): Record<string, unknown> {
  return {
    status: "in_review",
    assigneeAgentId: null,
    executionPolicy: null,
    executionState: null,
  };
}

export function hasStaleReviewerOwnership(input: {
  readonly assigneeAgentId?: string | null | undefined;
  readonly executionPolicy?: unknown | undefined;
  readonly executionState?: unknown | undefined;
}): boolean {
  return input.assigneeAgentId != null || input.executionPolicy != null || input.executionState != null;
}
