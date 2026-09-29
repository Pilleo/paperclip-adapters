import type { StressTask } from "./stress-campaign-manifest.js";

export interface StressReviewEvidence {
  readonly stage: string;
  readonly verdict: string;
  readonly runStatus: string;
  readonly sessionId?: string;
  readonly headSha?: string;
  readonly reviewerAgentId?: string;
  readonly runAgentId?: string;
  readonly runIssueId?: string;
  readonly childId?: string;
  readonly cardId?: string;
  readonly runId?: string;
}

export interface StressIssueEvidence {
  readonly key: string;
  readonly id: string;
  readonly status: string;
  readonly assigneeAgentId: string | null;
  readonly executionRunId: string | null;
  readonly blockedBy: readonly string[];
  readonly startApproval: "pending" | "approved" | "rejected" | "missing";
  readonly mergeApproval?: "pending" | "approved" | "rejected" | "missing";
  readonly executionBlocker: string | null;
  readonly startedAt?: string;
  readonly providerSessionId?: string;
  readonly providerSessionIds?: readonly string[];
  readonly productCount?: number;
  readonly product: { readonly url: string; readonly headSha: string; readonly status: string } | null;
  readonly github: { readonly state: string; readonly headSha: string; readonly mergedAt: string | null; readonly parents: readonly string[] } | null;
  readonly planReviews: readonly StressReviewEvidence[];
  readonly prReviews: readonly StressReviewEvidence[];
}

export type StressProgress =
  | { readonly kind: "awaiting_user_start" | "awaiting_user_merge" | "awaiting_provider" | "passed"; readonly reason?: string }
  | { readonly kind: "invalid" | "failed"; readonly reason: string };

const sha = /^[a-f0-9]{40}$/i;

function validDate(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function approvedReviews(issue: StressIssueEvidence, which: "plan" | "pr"): boolean {
  const reviews = which === "plan" ? issue.planReviews : issue.prReviews;
  const stages = which === "plan" ? ["luna", "terra"] : ["luna", "strong"];
  return reviews.length === 2 && stages.every((stage) => {
    const review = reviews.find((item) => item.stage === stage);
    if (!review || review.verdict !== "approve" || review.runStatus !== "succeeded") return false;
    if (review.reviewerAgentId && (review.runAgentId !== review.reviewerAgentId || review.runIssueId !== review.childId)) return false;
    return which === "plan" ? review.sessionId === issue.providerSessionId : review.headSha === issue.product?.headSha;
  });
}

function verifiedMerge(issue: StressIssueEvidence): boolean {
  return issue.product?.status === "merged" && !!issue.product.url && sha.test(issue.product.headSha) &&
    issue.github?.state === "MERGED" && issue.github.headSha === issue.product.headSha &&
    validDate(issue.github.mergedAt) !== null && issue.github.parents.length === 2 &&
    issue.github.parents[1] === issue.product.headSha;
}

export function evaluateStressProgress(tasks: readonly StressTask[], issues: readonly StressIssueEvidence[]): StressProgress {
  const pilot = tasks.length === 2 && tasks[0]?.key === "03" && tasks[1]?.key === "04";
  if ((!pilot && tasks.length !== 20) || issues.length !== tasks.length ||
      new Set(issues.map((issue) => issue.id)).size !== tasks.length) {
    return { kind: "invalid", reason: "incomplete_or_duplicate_campaign_issues" };
  }
  const byKey = new Map(issues.map((issue) => [issue.key, issue]));
  if (byKey.size !== tasks.length) return { kind: "invalid", reason: "duplicate_task_key" };
  const sessionOwners = new Map<string, string>();
  let waitingStart = false;
  let waitingMerge = false;
  let waitingProvider = false;
  for (const task of tasks) {
    const issue = byKey.get(task.key);
    if (!issue) return { kind: "invalid", reason: `missing_${task.key}` };
    const expected = task.predecessors.map((key) => byKey.get(key)?.id);
    if (expected.some((id) => !id) || expected.length !== issue.blockedBy.length ||
        new Set(issue.blockedBy).size !== issue.blockedBy.length || expected.some((id) => !issue.blockedBy.includes(id!))) {
      return { kind: "invalid", reason: `${task.key}_native_dependencies_mismatch` };
    }
    if (issue.status === "blocked" || issue.status === "cancelled" || issue.startApproval === "rejected") {
      return { kind: "failed", reason: `${task.key}_terminal_or_rejected` };
    }
    if (issue.executionBlocker) return { kind: issue.status === "done" ? "invalid" : "failed", reason: `${task.key}_execution_blocker` };
    if (issue.productCount !== undefined && issue.productCount !== (issue.product ? 1 : 0)) {
      return { kind: "invalid", reason: `${task.key}_duplicate_pr_product` };
    }
    if (issue.product && (!issue.github || issue.github.headSha !== issue.product.headSha) && issue.prReviews.length > 0) {
      return { kind: "invalid", reason: `${task.key}_stale_pr_head_verdict` };
    }
    if (issue.providerSessionIds && new Set(issue.providerSessionIds).size > 1) {
      return { kind: "invalid", reason: `${task.key}_duplicate_provider_sessions` };
    }
    if (issue.providerSessionId) {
      const prior = sessionOwners.get(issue.providerSessionId);
      if (prior && prior !== task.key) return { kind: "invalid", reason: `${task.key}_shared_provider_session` };
      sessionOwners.set(issue.providerSessionId, task.key);
    }
    const started = issue.status === "in_progress" || issue.status === "in_review" || issue.status === "done" ||
      !!issue.assigneeAgentId || !!issue.executionRunId || !!issue.providerSessionId || !!issue.product;
    if (started && issue.startApproval !== "approved") return { kind: "invalid", reason: `${task.key}_started_without_user_approval` };
    for (const predecessorKey of task.predecessors) {
      const predecessor = byKey.get(predecessorKey)!;
      if (started && (predecessor.status !== "done" || !verifiedMerge(predecessor))) {
        return { kind: "invalid", reason: `${task.key}_started_before_${predecessorKey}_merged` };
      }
      const predecessorMergedAt = validDate(predecessor.github?.mergedAt);
      const startedAt = validDate(issue.startedAt);
      if (started && startedAt !== null && predecessorMergedAt !== null && startedAt <= predecessorMergedAt) {
        return { kind: "invalid", reason: `${task.key}_started_before_${predecessorKey}_merge_time` };
      }
    }
    if (issue.status === "done") {
      if (!issue.providerSessionId || !issue.startedAt || !verifiedMerge(issue) ||
          !approvedReviews(issue, "plan") || !approvedReviews(issue, "pr")) {
        return { kind: "invalid", reason: `${task.key}_terminal_proof_incomplete` };
      }
    } else if (issue.product && issue.github?.state === "MERGED") {
      waitingProvider = true;
    } else if (issue.product && issue.github?.state === "OPEN" && approvedReviews(issue, "pr") &&
               (issue.mergeApproval === "pending" || issue.mergeApproval === "approved")) {
      waitingMerge = true;
    } else if (!started && issue.startApproval === "pending") {
      waitingStart = true;
    } else {
      waitingProvider = true;
    }
  }
  const sharedA = byKey.get("03")!;
  const sharedB = byKey.get("04")!;
  if ([sharedA, sharedB].every((issue) => issue.status === "in_progress" || issue.status === "in_review")) {
    return { kind: "invalid", reason: "shared_03_04_overlap" };
  }
  if (sharedA.startedAt && sharedB.startedAt) {
    const a = validDate(sharedA.startedAt);
    const b = validDate(sharedB.startedAt);
    const aEnd = validDate(sharedA.github?.mergedAt);
    const bEnd = validDate(sharedB.github?.mergedAt);
    if (a === null || b === null || !(aEnd !== null && aEnd < b || bEnd !== null && bEnd < a)) {
      return { kind: "invalid", reason: "shared_03_04_interval_overlap" };
    }
  }
  if (waitingMerge) return { kind: "awaiting_user_merge" };
  if (waitingStart) return { kind: "awaiting_user_start" };
  return { kind: waitingProvider ? "awaiting_provider" : "passed" };
}
