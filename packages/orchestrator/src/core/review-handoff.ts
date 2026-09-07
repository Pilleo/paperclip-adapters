import { ParsedIssueMetadata, IssueStatus } from "./types.js";
import { parseReviewDecisionComment } from "./review-decision.js";

export type ReviewVerdictType = "APPROVE" | "REQUEST_CHANGES" | "COMMENT" | "PENDING";

export interface ReviewVerdictEvaluation {
  readonly verdict: ReviewVerdictType;
  readonly reviewCommentId?: string | undefined;
  readonly feedbackSummary?: string | undefined;
}

export interface ReviewHandoffAction {
  readonly action: "REASSIGN_TO_WORKER" | "UNASSIGN_REVIEWER" | "WAIT";
  readonly targetStatus?: IssueStatus | undefined;
  readonly targetAssigneeId?: string | null | undefined;
  readonly wakeAgent?: boolean | undefined;
  readonly reason: string;
}

export function evaluateReviewVerdict(
  comments: readonly {
    id: string;
    body: string;
    authorAgentId?: string | null | undefined;
    createdAt?: string | undefined;
  }[],
  reviewerAgentId?: string
): ReviewVerdictEvaluation {
  // Sort comments newest first
  const sorted = [...comments].sort((a, b) => {
    const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return timeB - timeA;
  });

  for (const comment of sorted) {
    // Skip review request prompts that include format instructions
    if (comment.body.startsWith("## 🔍 Code Review Request:")) {
      continue;
    }

    // Require matching author agent if reviewerAgentId is provided
    if (reviewerAgentId && comment.authorAgentId !== reviewerAgentId) {
      continue;
    }

    const machineDecision = parseReviewDecisionComment(comment.body);
    if (machineDecision?.decision === "needs_work") {
      return {
        verdict: "REQUEST_CHANGES",
        reviewCommentId: comment.id,
        feedbackSummary: machineDecision.comment,
      };
    }
    if (machineDecision?.decision === "all_good") {
      return {
        verdict: "APPROVE",
        reviewCommentId: comment.id,
        feedbackSummary: machineDecision.comment || "Reviewer found no blocking issues.",
      };
    }

    // Do not interpret review prose. Only the shared machine decision is a
    // state transition; all other comments remain pending.
  }

  return { verdict: "PENDING" };
}

export function determineReviewHandoffAction(params: {
  readonly issue: ParsedIssueMetadata;
  readonly verdict: ReviewVerdictType;
  readonly workerAgentId?: string | undefined;
  readonly reviewerAgentId?: string | undefined;
}): ReviewHandoffAction {
  const { issue, verdict, workerAgentId } = params;

  switch (verdict) {
    case "REQUEST_CHANGES": {
      return {
        action: "REASSIGN_TO_WORKER",
        targetStatus: "in_progress",
        targetAssigneeId: workerAgentId || null,
        wakeAgent: Boolean(workerAgentId),
        reason: `Code review requested changes on [${issue.identifier || issue.id}]. Reassigning back to worker in_progress.`,
      };
    }

    case "APPROVE": {
      return {
        action: "UNASSIGN_REVIEWER",
        targetStatus: "in_review",
        targetAssigneeId: null,
        wakeAgent: false,
        reason: `Code review approved for [${issue.identifier || issue.id}]. Unassigning reviewer; awaiting merge.`,
      };
    }

    case "COMMENT":
    case "PENDING":
    default:
      return {
        action: "WAIT",
        reason: `Review for [${issue.identifier || issue.id}] is pending or awaiting input.`,
      };
  }
}
