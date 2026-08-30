import { ParsedIssueMetadata, IssueStatus } from "./types.js";
import { PrCiCheckResult } from "./github-sync.js";
import { PaperclipApprovalSummary } from "./approvals.js";
import { evaluateReviewVerdict, ReviewVerdictType } from "./review-handoff.js";

export type ReviewStage =
  | "ci_gate"
  | "vibe_review"
  | "strong_review"
  | "operator_approval"
  | "completed";

export interface ReviewPipelineParams {
  readonly issue: ParsedIssueMetadata;
  readonly prNumber?: number | undefined;
  readonly prUrl?: string | undefined;
  readonly ciStatus?: PrCiCheckResult | undefined;
  readonly comments: readonly {
    readonly id: string;
    readonly body: string;
    readonly authorAgentId?: string | null | undefined;
    readonly createdAt?: string | undefined;
  }[];
  readonly existingApprovals: readonly PaperclipApprovalSummary[];
  readonly vibeAgentId?: string | undefined;
  readonly reviewerAgentId?: string | undefined;
  readonly workerAgentId?: string | undefined;
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
      readonly stage: "completed";
      readonly action: "EXECUTE_MERGE";
      readonly prNumber?: number | undefined;
      readonly prUrl?: string | undefined;
      readonly reason: string;
    }
  | {
      readonly stage: "vibe_review" | "strong_review" | "operator_approval";
      readonly action: "REASSIGN_TO_WORKER";
      readonly targetStatus: IssueStatus;
      readonly targetAssigneeId: string | null;
      readonly feedbackSummary?: string | undefined;
      readonly reason: string;
    };

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
    comments,
    existingApprovals,
    vibeAgentId,
    reviewerAgentId,
    workerAgentId,
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

  // Evaluate Vibe review verdict (if Vibe is configured)
  const vibeVerdict = vibeAgentId
    ? evaluateReviewVerdict(comments, vibeAgentId)
    : { verdict: "APPROVE" as ReviewVerdictType, feedbackSummary: "Vibe bypassed (unconfigured)" };

  // 2. Stage 2: Cheap Vibe Fast Review
  if (vibeAgentId) {
    if (vibeVerdict.verdict === "REQUEST_CHANGES") {
      return {
        stage: "vibe_review",
        action: "REASSIGN_TO_WORKER",
        targetStatus: "in_progress",
        targetAssigneeId: workerAgentId || null,
        feedbackSummary: vibeVerdict.feedbackSummary,
        reason: `Vibe fast review requested changes on [${issue.identifier || issue.id}]. Reassigning back to worker in_progress (skipping strong review).`,
      };
    }

    if (vibeVerdict.verdict !== "APPROVE") {
      return {
        stage: "vibe_review",
        action: "DISPATCH_VIBE_REVIEW",
        targetAgentId: vibeAgentId,
        reason: `CI is green; routing [${issue.identifier || issue.id}] to Vibe for cheap triage & structural sanity review.`,
      };
    }
  }

  // Evaluate Strong Model review verdict (Terra / Grok / Strong Reviewer)
  const strongVerdict = reviewerAgentId
    ? evaluateReviewVerdict(comments, reviewerAgentId)
    : { verdict: "APPROVE" as ReviewVerdictType, feedbackSummary: "Strong reviewer bypassed (unconfigured)" };

  // 3. Stage 3: Deep Strong Model Review
  if (reviewerAgentId) {
    if (strongVerdict.verdict === "REQUEST_CHANGES") {
      return {
        stage: "strong_review",
        action: "REASSIGN_TO_WORKER",
        targetStatus: "in_progress",
        targetAssigneeId: workerAgentId || null,
        feedbackSummary: strongVerdict.feedbackSummary,
        reason: `Strong model review requested changes on [${issue.identifier || issue.id}]. Reassigning back to worker in_progress.`,
      };
    }

    if (strongVerdict.verdict !== "APPROVE") {
      return {
        stage: "strong_review",
        action: "DISPATCH_STRONG_REVIEW",
        targetAgentId: reviewerAgentId,
        reason: `Vibe triage passed; routing [${issue.identifier || issue.id}] to Strong Reviewer for deep invariant & security audit.`,
      };
    }
  }

  // 4. Stage 4: Operator Final Review & Merge Approval Gate
  const matchingMergeApproval = existingApprovals.find(
    (app) =>
      (app.type === "task_merge_approval" ||
        (app.type === "request_board_approval" && app.payload?.["action"] === "task_merge")) &&
      (app.issueIds.includes(issue.id) || app.payload?.["issueId"] === issue.id)
  );

  if (!matchingMergeApproval) {
    return {
      stage: "operator_approval",
      action: "CREATE_MERGE_APPROVAL",
      prNumber,
      prUrl,
      vibeSummary: vibeVerdict.feedbackSummary,
      strongSummary: strongVerdict.feedbackSummary,
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

  return {
    stage: "operator_approval",
    action: "AWAIT_OPERATOR_APPROVAL",
    approvalId: matchingMergeApproval.id,
    reason: `Awaiting operator final review & merge approval in Paperclip (approval ${matchingMergeApproval.id}).`,
  };
}
