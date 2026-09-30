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

class MergedPrAuthorization {
  private readonly verified = true;
  constructor(readonly issueId: string, readonly prUrl: string, readonly mergedAt: string) {}
  matchesIssue(issueId: string): boolean { return this.verified && this.issueId === issueId; }
}
const issuedMergeAuthorizations = new WeakSet<MergedPrAuthorization>();
export type VerifiedMergedPrAuthorization = MergedPrAuthorization;

export function assertMergedPrAuthorization(issueId: string, authorization: VerifiedMergedPrAuthorization): void {
  if (!issuedMergeAuthorizations.has(authorization) || !authorization.matchesIssue(issueId)) {
    throw new Error(`Invalid verified merge authorization for ${issueId}`);
  }
}

type ReconciliationPullRequest = Readonly<{ number: number; url: string }> & (
  | { readonly state: "MERGED"; readonly mergedAt: string }
  | { readonly state: "OPEN" | "CLOSED"; readonly mergedAt: null }
);

export interface PullRequestReconciliationInput {
  readonly issueId: string;
  readonly issueStatus: ReconciliationIssueStatus;
  readonly workProduct?: {
    readonly id: string;
    readonly status?: string | null | undefined;
    readonly reviewState?: string | null | undefined;
    readonly url: string;
  } | undefined;
  readonly pullRequest?: ReconciliationPullRequest | undefined;
  readonly mergeApproval?: {
    readonly id: string;
    readonly status: ReconciliationApprovalStatus;
  } | undefined;
  readonly auditAlreadyRecorded: boolean;
}

/**
 * A bounded GitHub listing is a discovery optimization, never lifecycle
 * authority. The scheduler may directly probe a board-registered PR only for
 * a pending merge gate or an active managed review lane. Keeping this choice
 * typed and pure prevents later recovery code from silently broadening it.
 */
export type RegisteredPullRequestObservation =
  | { readonly kind: "probe"; readonly reason: "pending_merge_approval" | "managed_active_pr_outside_discovery" }
  | { readonly kind: "skip"; readonly reason: "missing_registration" | "already_discovered" | "not_a_merge_cleanup_candidate" };

function normalizedPullRequestUrl(url: string): string {
  return url.replace(/\/$/, "").toLowerCase();
}

export function selectRegisteredPullRequestObservation(input: {
  readonly registeredPrUrl?: string | undefined;
  readonly discoveredPrUrls: ReadonlySet<string>;
  readonly hasPendingMergeApproval: boolean;
  readonly orchestratorManaged: boolean;
  readonly issueStatus: ReconciliationIssueStatus;
}): RegisteredPullRequestObservation {
  if (!input.registeredPrUrl) return { kind: "skip", reason: "missing_registration" };
  const registeredUrl = normalizedPullRequestUrl(input.registeredPrUrl);
  if ([...input.discoveredPrUrls].some((url) => normalizedPullRequestUrl(url) === registeredUrl)) {
    return { kind: "skip", reason: "already_discovered" };
  }
  if (input.hasPendingMergeApproval) return { kind: "probe", reason: "pending_merge_approval" };
  if (input.orchestratorManaged && (input.issueStatus === "blocked" || input.issueStatus === "in_review")) {
    return { kind: "probe", reason: "managed_active_pr_outside_discovery" };
  }
  return { kind: "skip", reason: "not_a_merge_cleanup_candidate" };
}

export type PullRequestReconciliationDecision =
  | {
      readonly action: "COMPLETE_MERGED_PR";
      readonly authorization: VerifiedMergedPrAuthorization;
      readonly issueStatus: "done";
      readonly workProductStatus: "merged";
      readonly workProductReviewState: "approved";
      readonly cancelMergeApprovalId?: string | undefined;
      readonly shouldPostAudit: boolean;
      readonly reason: string;
    }
  | {
      readonly action: "NORMALIZE_MERGED_METADATA";
      readonly authorization: VerifiedMergedPrAuthorization;
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
  | { readonly action: "NOOP"; readonly reason: string; readonly authorization?: VerifiedMergedPrAuthorization }
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
    if (typeof input.pullRequest.mergedAt !== "string" || !input.pullRequest.mergedAt.trim() ||
        !Number.isFinite(Date.parse(input.pullRequest.mergedAt))) {
      return { action: "DEFER", reason: "GitHub merge timestamp is missing or invalid; completion is not authorized." };
    }
    if (!input.issueId.trim() || !Number.isSafeInteger(input.pullRequest.number) || input.pullRequest.number < 1 ||
        !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9]\d*\/?$/.test(input.pullRequest.url) ||
        (input.workProduct && normalizedPullRequestUrl(input.workProduct.url) !== normalizedPullRequestUrl(input.pullRequest.url))) {
      return { action: "DEFER", reason: "Merged PR identity does not match its registered issue scope." };
    }
    const authorization = new MergedPrAuthorization(input.issueId, input.pullRequest.url, input.pullRequest.mergedAt);
    Object.freeze(authorization);
    issuedMergeAuthorizations.add(authorization);
    const metadataNeedsUpdate = needsMergedMetadata(input);
    const shouldPostAudit = !input.auditAlreadyRecorded;
    const cancelMergeApprovalId = pendingMergeApprovalId(input);
    // A pending final-merge approval is a visible stale gate even after all
    // task and work-product metadata is terminal. Keep this reconciliation
    // active until the caller invalidates that approval.
    if (input.issueStatus === "done" && !metadataNeedsUpdate && !shouldPostAudit && !cancelMergeApprovalId) {
      return { action: "NOOP", authorization, reason: `PR #${input.pullRequest.number} is already fully reconciled.` };
    }

    const action = input.issueStatus === "done" ? "NORMALIZE_MERGED_METADATA" : "COMPLETE_MERGED_PR";
    return {
      action,
      authorization,
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
