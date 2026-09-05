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

export type ReviewDispatchDecision = Extract<ReviewPipelineDecision, {
  readonly action: "DISPATCH_VIBE_REVIEW" | "DISPATCH_STRONG_REVIEW" |
    "DISPATCH_LUNA_REVIEW" | "DISPATCH_TERRA_REVIEW" | "RECOVER_REVIEW";
}>;

export function isReviewDispatchDecision(decision: ReviewPipelineDecision): decision is ReviewDispatchDecision {
  switch (decision.action) {
    case "DISPATCH_VIBE_REVIEW":
    case "DISPATCH_STRONG_REVIEW":
    case "DISPATCH_LUNA_REVIEW":
    case "DISPATCH_TERRA_REVIEW":
    case "RECOVER_REVIEW":
      return true;
    case "AWAIT_CI":
    case "AWAIT_REVIEW_CONFIGURATION":
    case "AWAIT_REVIEW":
    case "AWAIT_OPERATOR_RECOVERY":
    case "REASSIGN_TO_WORKER":
    case "RECONCILE_OPERATOR_GATE":
    case "CREATE_MERGE_APPROVAL":
    case "AWAIT_OPERATOR_APPROVAL":
    case "EXECUTE_MERGE":
      return false;
  }
}

export function reviewDispatchStage(decision: ReviewDispatchDecision): PrReviewStage {
  switch (decision.action) {
    case "DISPATCH_VIBE_REVIEW":
      return "vibe";
    case "DISPATCH_STRONG_REVIEW":
      return "strong";
    case "DISPATCH_LUNA_REVIEW":
      return "luna";
    case "DISPATCH_TERRA_REVIEW":
      return "terra";
    case "RECOVER_REVIEW":
      return decision.stage === "luna_review" ? "luna" : "terra";
  }
}

export type ReviewPipelineActionGroup = "ci" | "wait" | "dispatch" | "mutation";

/** Exhaustive top-level routing classification used by the effectful executor. */
export function classifyReviewPipelineAction(action: ReviewPipelineDecision["action"]): ReviewPipelineActionGroup {
  switch (action) {
    case "AWAIT_CI":
      return "ci";
    case "AWAIT_REVIEW_CONFIGURATION":
    case "AWAIT_REVIEW":
    case "AWAIT_OPERATOR_RECOVERY":
    case "AWAIT_OPERATOR_APPROVAL":
      return "wait";
    case "DISPATCH_VIBE_REVIEW":
    case "DISPATCH_STRONG_REVIEW":
    case "DISPATCH_LUNA_REVIEW":
    case "DISPATCH_TERRA_REVIEW":
    case "RECOVER_REVIEW":
      return "dispatch";
    case "REASSIGN_TO_WORKER":
    case "RECONCILE_OPERATOR_GATE":
    case "CREATE_MERGE_APPROVAL":
    case "EXECUTE_MERGE":
      return "mutation";
  }
}

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
    heartbeatRuns = [],
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
      const matchesIdentity = exactKeys.includes(key) ||
        key.startsWith(`${reviewInteractionKeyPrefix(identity)}:attempt:`) || (
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
    return interactions.some((interaction) => {
      if (interaction.status !== "pending" && interaction.status !== "answered") return false;
      if (interaction.idempotencyKey === expectedKey || interaction.idempotencyKey?.startsWith(`${reviewInteractionKeyPrefix({ issueId: issue.id, prUrl: prUrl || `pr-${prNumber || "unknown"}`, headSha: reviewHeadSha || "unknown", stage })}:attempt:`)) return true;
      // GitHub head lookup may be temporarily unavailable. A pending card
      // carrying a real SHA is still the same immutable review identity; do
      // not redispatch merely because this heartbeat has an `unknown` head.
      return !reviewHeadSha && Boolean(
        interaction.idempotencyKey &&
        new RegExp(`:v(?:9|10|11|12):${issue.id}:.*:[0-9a-f]{40}:${stage}$`, "i").test(interaction.idempotencyKey),
      );
    });
  };
  const cardFor = (stage: ReviewEpochStage) => {
    const identity = {
      issueId: issue.id,
      prUrl: prUrl || `pr-${prNumber || "unknown"}`,
      headSha: reviewHeadSha || "unknown",
      stage,
    } as const;
    const prefix = reviewInteractionKeyPrefix(identity);
    const exactKeys = reviewInteractionIdempotencyKeys(identity);
    return [...interactions].reverse().find((interaction) =>
      interaction.kind === "request_item_verdicts" &&
      (() => {
        const key = interaction.idempotencyKey || "";
        return exactKeys.includes(key) || key.startsWith(`${prefix}:attempt:`) || (
          key.includes(`:${issue.id}:`) &&
          (reviewHeadSha
            ? /^pr-review:v\d+:/.test(key) && key.endsWith(`:${reviewHeadSha}:${stage}`)
            : new RegExp(`:v\\d+:.*:[0-9a-f]{40}:${stage}$`, "i").test(key))
        );
      })(),
    );
  };

  /** The reducer is the sole owner of card/run/verdict transitions. */
  const epochDecision = (stage: ReviewEpochStage, reviewerAgentId: string) => {
    const card = cardFor(stage);
    const boundRuns = card
      ? heartbeatRuns.filter((run) => run.issueId === issue.id && run.agentId === reviewerAgentId && run.interactionId === card.id)
      : [];
    const failedRun = boundRuns.find((run) => ["failed", "cancelled", "timed_out"].includes(String(run.status).toLowerCase()));
    const activeRun = boundRuns.find((run) => ["queued", "running"].includes(String(run.status).toLowerCase()));
    const compatibilityExecutionLease = executionState?.status === "pending" &&
      executionState.currentParticipant?.type === "agent" &&
      executionState.currentParticipant.agentId === reviewerAgentId;
    const finishedRun = boundRuns.find((run) => !activeRun && !failedRun);
    const verdict = verdictFor(stage);
    return reduceReviewEpoch({
      issueId: issue.id,
      prUrl: prUrl || `pr-${prNumber || "unknown"}`,
      headSha: reviewHeadSha || "unknown",
      stage,
      reviewerAgentId,
      card: card
        ? card.status === "answered"
          ? { state: "answered" as const, id: card.id }
          : card.status === "pending"
            ? { state: "pending" as const, id: card.id }
            : { state: "retired" as const, id: card.id, reason: `Native ${stage} review card ${card.id} is ${card.status || "terminal"}.` }
        : { state: "missing" as const },
      reviewerRun: failedRun
        ? { state: "failed" as const, runId: failedRun.id, reason: `Bound ${stage} reviewer run ${failedRun.id} ended ${failedRun.status}.` }
        : activeRun || compatibilityExecutionLease
          ? { state: "active" as const, runId: activeRun?.id ?? "legacy-execution-state" }
          : finishedRun
            ? { state: "finished" as const, runId: finishedRun.id }
            : { state: "missing" as const },
      recovery: { state: "never_attempted" },
      verdict: verdict && card
        ? {
            cardId: card.id,
            headSha: reviewHeadSha || "unknown",
            decision: verdict.decision,
            ...(verdict.decision === "needs_work" ? { reason: verdict.reason } : {}),
          }
        : null,
    });
  };

  // New reviewer lane is selected whenever configured. It is intentionally
  // separate from the legacy Vibe lane so stale Vibe verdicts cannot approve.
  const mapEpochDecision = (
    stage: ReviewEpochStage,
    reviewerAgentId: string,
    decision: ReturnType<typeof reduceReviewEpoch>,
  ): ReviewPipelineDecision | null => {
    const pipelineStage: "luna_review" | "terra_review" = stage === "luna" ? "luna_review" : "terra_review";
    switch (decision.action) {
      case "reassign_worker":
        return {
          stage: pipelineStage,
          action: "REASSIGN_TO_WORKER",
          targetStatus: "in_progress",
          targetAssigneeId: workerAgentId || null,
          feedbackSummary: decision.reason,
          reason: `${stage === "luna" ? "Luna" : "Terra"} review requested changes on [${issue.identifier || issue.id}].`,
        };
      case "escalate":
        return { stage: pipelineStage, action: "AWAIT_OPERATOR_RECOVERY", reason: decision.reason };
      case "await_verdict":
        return { stage: pipelineStage, action: "AWAIT_REVIEW", reason: `Native ${stage === "luna" ? "Luna" : "Terra"} review is awaiting its structured verdict.` };
      case "create_card":
        return {
          stage: pipelineStage,
          action: stage === "luna" ? "DISPATCH_LUNA_REVIEW" : "DISPATCH_TERRA_REVIEW",
          targetAgentId: reviewerAgentId,
          reason: stage === "luna"
            ? `CI is green; routing [${issue.identifier || issue.id}] to OpenAI Luna for the first review.`
            : `Luna approved; routing [${issue.identifier || issue.id}] to OpenAI Terra for the strong review.`,
        };
      case "wake_once":
        return { stage: pipelineStage, action: "RECOVER_REVIEW", targetAgentId: reviewerAgentId, reason: `A pending native ${stage === "luna" ? "Luna" : "Terra"} review card has no bound run; issuing its one recovery wake.` };
      case "advance":
        return null;
      default:
        throw new Error(`Unhandled review epoch decision: ${JSON.stringify(decision)}`);
    }
  };

  if (lunaReviewerAgentId !== undefined || terraReviewerAgentId !== undefined) {
    if (!lunaReviewerAgentId) return { stage: "luna_review", action: "AWAIT_REVIEW_CONFIGURATION", reason: "OpenAI Luna reviewer is not configured; refusing to skip the weak review stage." };
    const luna = epochDecision("luna", lunaReviewerAgentId);
    const lunaPipelineDecision = mapEpochDecision("luna", lunaReviewerAgentId, luna);
    if (lunaPipelineDecision) return lunaPipelineDecision;
    if (!terraReviewerAgentId) return { stage: "terra_review", action: "AWAIT_REVIEW_CONFIGURATION", reason: "OpenAI Terra reviewer is not configured; refusing to skip the strong review stage." };
    const terra = epochDecision("terra", terraReviewerAgentId);
    const terraPipelineDecision = mapEpochDecision("terra", terraReviewerAgentId, terra);
    if (terraPipelineDecision) return terraPipelineDecision;
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

  // Legacy Vibe/Strong configuration is intentionally fail-closed. Mixing it
  // with the canonical Luna/Terra ladder was the source of duplicate cards
  // and free-text review activity. New PR reviews must explicitly configure
  // the typed weak and strong participants above.
  void vibeReviewerAgentId;
  void reviewerAgentId;
  return {
    stage: "luna_review",
    action: "AWAIT_REVIEW_CONFIGURATION",
    reason: "Canonical Luna/Terra reviewers are not configured; refusing to dispatch the legacy Vibe/Strong review lane.",
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
