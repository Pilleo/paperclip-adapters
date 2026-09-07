import type { ReviewWaitState } from "./review-wait-state.js";

export interface ExecutionPolicyParticipant {
  readonly type: "agent" | "user";
  readonly agentId?: string | undefined;
  readonly userId?: string | undefined;
}

export interface ExecutionPolicyStage {
  /** Stable UUID: Paperclip persists currentStageId as a UUID. */
  readonly id?: string | undefined;
  readonly type: "review" | "approval";
  readonly participants: readonly ExecutionPolicyParticipant[];
}

export interface MazewallExecutionPolicy {
  readonly mode: "normal";
  readonly commentRequired: true;
  readonly stages: readonly ExecutionPolicyStage[];
}

export function buildMazewallExecutionPolicy(options: {
  readonly vibeReviewerAgentId?: string | undefined;
  readonly reviewerAgentId?: string | undefined;
  readonly approverUserId?: string | undefined;
}): MazewallExecutionPolicy | null {
  const stages: ExecutionPolicyStage[] = [];

  if (options.vibeReviewerAgentId) {
    stages.push({
      type: "review",
      participants: [{ type: "agent", agentId: options.vibeReviewerAgentId }],
    });
  }
  if (options.reviewerAgentId && options.reviewerAgentId !== options.vibeReviewerAgentId) {
    stages.push({
      type: "review",
      participants: [{ type: "agent", agentId: options.reviewerAgentId }],
    });
  }
  if (options.approverUserId) {
    stages.push({
      type: "approval",
      participants: [{ type: "user", userId: options.approverUserId }],
    });
  }

  if (stages.length === 0) return null;
  return { mode: "normal", commentRequired: true, stages };
}

// Adapter-owned protocol identifiers. They must remain stable across
// restarts because Paperclip validates stage IDs as UUIDs and stores the
// active execution state's currentStageId by value.
export const NATIVE_PR_REVIEW_STAGE_IDS = Object.freeze({
  luna: "4f2f31d2-91b9-4d4b-8c1f-11cf3a9e1a01",
  terra: "4f2f31d2-91b9-4d4b-8c1f-11cf3a9e1a02",
} as const);

/**
 * Legacy policies accidentally named the writable Vibe developer as a review
 * participant. Restrict migration to that exact unsafe shape so an operator's
 * unrelated custom policy is never overwritten.
 */
export function issueHasUnsafeVibeReviewParticipant(
  rawIssue: Readonly<Record<string, unknown>>,
  writableVibeAgentId?: string | undefined,
): boolean {
  if (!writableVibeAgentId) return false;
  const policy = rawIssue["executionPolicy"];
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return false;
  const stages = (policy as { stages?: unknown }).stages;
  if (!Array.isArray(stages)) return false;
  return stages.some((stage) => {
    if (!stage || typeof stage !== "object" || Array.isArray(stage)) return false;
    const participants = (stage as { participants?: unknown }).participants;
    return Array.isArray(participants) && participants.some((participant) =>
      participant && typeof participant === "object" && !Array.isArray(participant) &&
      (participant as { agentId?: unknown }).agentId === writableVibeAgentId,
    );
  });
}

export function issueHasExecutionPolicy(rawIssue: Readonly<Record<string, unknown>>): boolean {
  const policy = rawIssue["executionPolicy"];
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return false;
  const stages = (policy as { stages?: unknown }).stages;
  return Array.isArray(stages) && stages.length > 0;
}

/**
 * PR reviews are adapter-owned native interactions. Clearing this stale
 * Paperclip policy after the interaction exists prevents the runtime from
 * launching reviewers independently of the addressed review card.
 */
export function nativePrReviewCleanupPatch(): Record<string, unknown> {
  return {
    status: "in_review",
    assigneeAgentId: null,
    executionPolicy: null,
    executionState: null,
  };
}

/**
 * Paperclip 2026.831 cancels an issue-scoped reviewer wake when the addressed
 * reviewer is not also the issue assignee. Keep the host policy/state empty so
 * Paperclip does not independently launch a second generic review participant;
 * the native interaction remains the sole decision authority.
 *
 * Upstream can remove this adapter compatibility patch once addressed native
 * interactions authorize their addressee independently of issue assignment.
 */
export function nativePrReviewOwnershipPatch(reviewerAgentId: string): Record<string, unknown> {
  return {
    status: "in_review",
    assigneeAgentId: reviewerAgentId,
    executionPolicy: null,
    executionState: null,
  };
}

/**
 * Review cards are the execution primitive. Do not install a Paperclip
 * execution policy for them: that policy can launch a generic reviewer run
 * before the addressed request_item_verdicts interaction exists.
 */
export function nativePrReviewParticipantPatch(
  orchestratorAgentId: string,
  reviewerAgentId: string,
  executionState: Record<string, unknown>,
): Record<string, unknown> {
  // The card's addressee authorizes the reviewer. The issue must remain owned
  // by the orchestrator: changing assignee here makes Paperclip cancel an
  // already queued reviewer heartbeat as `issue_assignee_changed`.
  void reviewerAgentId;
  return {
    status: "in_review",
    assigneeAgentId: orchestratorAgentId,
    executionPolicy: null,
    executionState,
  };
}

/** Keep a paused review visible; Paperclip normalizes an unowned in_review to backlog. */
export function nativePrReviewWaitPatch(orchestratorAgentId: string, executionState: ReviewWaitState): Record<string, unknown> {
  return { status: "in_review", assigneeAgentId: orchestratorAgentId, executionPolicy: null, executionState };
}

const POLICY_STATUSES = new Set(["in_progress", "in_review"]);

export function issueNeedsExecutionPolicyBackfill(
  issue: {
  readonly status: string;
  readonly assigneeAgentId?: string | null | undefined;
  /** PR review is governed exclusively by native interaction cards. */
  readonly hasReadyPullRequest?: boolean | undefined;
  readonly rawIssue: Readonly<Record<string, unknown>>;
  },
  managedWorkerIds: ReadonlySet<string>,
): boolean {
  if (issue.hasReadyPullRequest) return false;
  if (!POLICY_STATUSES.has(issue.status)) return false;
  const assignee = issue.assigneeAgentId;
  if (!assignee || !managedWorkerIds.has(assignee)) return false;
  return !issueHasExecutionPolicy(issue.rawIssue);
}

/**
 * A ready PR can be stranded by Paperclip's generic liveness repair after an
 * unbound reviewer run. Only these terminal/non-review projections may be
 * restored into the adapter-owned native-card lane; an active work or review
 * state must remain owned by its existing state machine.
 */
export function shouldRecoverNativePrReview(input: {
  readonly status: string;
  readonly orchestratorManaged: boolean;
  readonly merged: boolean;
  readonly hasUnreviewedReadyPullRequest: boolean;
}): boolean {
  if (!input.orchestratorManaged || input.merged || !input.hasUnreviewedReadyPullRequest) return false;
  switch (input.status) {
    case "blocked":
    case "backlog":
    case "todo":
    case "done":
      return true;
    case "in_progress":
    case "in_review":
    case "cancelled":
      return false;
    default:
      return false;
  }
}
