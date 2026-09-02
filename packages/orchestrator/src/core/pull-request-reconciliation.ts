/**
 * Pure lifecycle decision for a registered pull request.
 *
 * GitHub is authoritative for whether the PR is open or merged. Paperclip's
 * work-product status is metadata and can lag behind GitHub, so it must never
 * be allowed to reopen an issue after a verified merge.
 */

export type ReconciliationIssueStatus = "backlog" | "todo" | "in_progress" | "in_review" | "done" | "cancelled" | string;
export type ReconciliationPullRequestState = "OPEN" | "CLOSED" | "MERGED";
export type ReconciliationApprovalStatus = "pending" | "approved" | "rejected" | "cancelled" | string;

export interface PullRequestReconciliationInput {
  readonly issueId: string;
  readonly issueStatus: ReconciliationIssueStatus;
  readonly workProduct?: {
    readonly id: string;
    readonly status?: string | null | undefined;
    readonly reviewState?: string | null | undefined;
    readonly url: string;
  } | undefined;
  readonly pullRequest?: {
    readonly number: number;
    readonly url: string;
    readonly state: ReconciliationPullRequestState;
    readonly mergedAt: string | null;
  } | undefined;
  readonly mergeApproval?: {
    readonly id: string;
    readonly status: ReconciliationApprovalStatus;
  } | undefined;
  readonly auditAlreadyRecorded: boolean;
}

export type PullRequestReconciliationDecision =
  | {
      readonly action: "COMPLETE_MERGED_PR";
      readonly issueStatus: "done";
      readonly workProductStatus: "merged";
      readonly workProductReviewState: "approved";
      readonly cancelMergeApprovalId?: string | undefined;
      readonly shouldPostAudit: boolean;
      readonly reason: string;
    }
  | {
      readonly action: "NORMALIZE_MERGED_METADATA";
      readonly issueStatus: "done";
      readonly workProductStatus: "merged";
      readonly workProductReviewState: "approved";
      readonly cancelMergeApprovalId?: string | undefined;
      readonly shouldPostAudit: boolean;
      readonly reason: string;
    }
  | {
      readonly action: "RECOVER_OPEN_PR_REVIEW";
      readonly issueStatus: "in_review";
      readonly reason: string;
    }
  | { readonly action: "NOOP"; readonly reason: string }
  | { readonly action: "DEFER"; readonly reason: string };

function needsMergedMetadata(input: PullRequestReconciliationInput): boolean {
  return input.workProduct?.status?.toLowerCase() !== "merged" ||
    input.workProduct?.reviewState?.toLowerCase() !== "approved";
}

function pendingMergeApprovalId(input: PullRequestReconciliationInput): string | undefined {
  return input.mergeApproval?.status === "pending" ? input.mergeApproval.id : undefined;
}

export function decidePullRequestReconciliation(
  input: PullRequestReconciliationInput,
): PullRequestReconciliationDecision {
  if (!input.pullRequest) {
    return { action: "DEFER", reason: "GitHub PR state is unavailable; refusing to guess the lifecycle transition." };
  }

  if (input.pullRequest.state === "MERGED") {
    const metadataNeedsUpdate = needsMergedMetadata(input);
    const shouldPostAudit = !input.auditAlreadyRecorded;
    const cancelMergeApprovalId = pendingMergeApprovalId(input);
    if (input.issueStatus === "done" && !metadataNeedsUpdate && !shouldPostAudit) {
      return { action: "NOOP", reason: `PR #${input.pullRequest.number} is already fully reconciled.` };
    }

    const action = input.issueStatus === "done" ? "NORMALIZE_MERGED_METADATA" : "COMPLETE_MERGED_PR";
    return {
      action,
      issueStatus: "done",
      workProductStatus: "merged",
      workProductReviewState: "approved",
      ...(cancelMergeApprovalId ? { cancelMergeApprovalId } : {}),
      shouldPostAudit,
      reason: `PR #${input.pullRequest.number} is merged on GitHub; terminal completion takes precedence over stale Paperclip review metadata.`,
    };
  }

  if (input.pullRequest.state === "OPEN" && ["done", "blocked", "in_progress"].includes(input.issueStatus)) {
    return {
      action: "RECOVER_OPEN_PR_REVIEW",
      issueStatus: "in_review",
      reason: `PR #${input.pullRequest.number} is explicitly open and the completed issue still needs review recovery.`,
    };
  }

  if (input.pullRequest.state === "CLOSED") {
    return { action: "NOOP", reason: `PR #${input.pullRequest.number} is closed without a verified merge; no lifecycle transition is safe.` };
  }

  return { action: "NOOP", reason: `PR #${input.pullRequest.number} requires no reconciliation from issue status ${input.issueStatus}.` };
}
