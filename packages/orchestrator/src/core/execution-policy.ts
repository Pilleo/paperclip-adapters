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
 * Verify the atomic transition that transfers an implementation provider's PR
 * to the adapter-owned review-card protocol. Inert Paperclip normalization is
 * acceptable; a provider owner, policy, active monitor, or review state is
 * not, because it could produce a competing execution path.
 */
/**
 * Paperclip can retain an `idle`/`triggered` Jules monitor after the atomic
 * handoff PATCH. That monitor is historical telemetry only when the caller
 * has independently correlated the ready PR to the newest completed Jules
 * producer run. Keep the evidence explicit: a bare triggered monitor is not
 * safe to review and must remain provider-owned.
 */
export function isNativePrReviewHandoffProjection(
  issue: Readonly<Record<string, unknown>>,
  evidence: { readonly terminalJulesProducer?: boolean | undefined } = {},
): boolean {
  return issue["status"] === "in_review" &&
    issue["assigneeAgentId"] === null &&
    issue["executionPolicy"] === null &&
    isPaperclipNormalizedTerminalExecutionState(issue["executionState"], Boolean(evidence.terminalJulesProducer));
}

/**
 * A verified GitHub merge must atomically end every Paperclip-owned execution
 * projection. A status-only update leaves an execution-policy participant
 * eligible for recovery and can reanimate an already merged task.
 *
 * This is an adapter compatibility boundary until Paperclip provides a
 * conditional terminal transition that clears execution ownership server-side.
 */
export function mergedPrTerminalPatch(): Record<string, unknown> {
  return {
    status: "done",
    assigneeAgentId: null,
    executionPolicy: null,
    executionState: null,
  };
}

function isPaperclipNormalizedTerminalExecutionState(value: unknown, allowRetainedTriggeredJulesMonitor = false): boolean {
  if (value === null || value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Readonly<Record<string, unknown>>;
  if (state["status"] !== "idle") return false;
  for (const key of ["reviewRequest", "currentStageId", "currentStageType", "currentStageIndex", "currentParticipant"] as const) {
    if (state[key] !== null && state[key] !== undefined) return false;
  }
  const monitor = state["monitor"];
  if (monitor === null || monitor === undefined) return true;
  if (!monitor || typeof monitor !== "object" || Array.isArray(monitor)) return false;
  const monitorRecord = monitor as Readonly<Record<string, unknown>>;
  if (monitorRecord["status"] === "cleared") return true;
  return allowRetainedTriggeredJulesMonitor &&
    monitorRecord["status"] === "triggered" &&
    monitorRecord["serviceName"] === "jules";
}

/**
 * Paperclip currently normalizes a null executionState into an inert `idle`
 * record with a cleared external monitor. Treat only that documented inert
 * shape as terminal; an active monitor, participant, review request, or host
 * policy remains a failed terminal transition.
 */
export function isMergedPrTerminalProjection(issue: Readonly<Record<string, unknown>>): boolean {
  return issue["status"] === "done" &&
    issue["assigneeAgentId"] === null &&
    issue["executionPolicy"] === null &&
    isPaperclipNormalizedTerminalExecutionState(issue["executionState"]);
}

/**
 * Merge reconciliation clears ownership, not historical provider telemetry.
 * A completed issue with only an inert monitor must not be re-patched every
 * heartbeat; an assignee, host policy, active state, or non-terminal status
 * can still reanimate work and therefore must be cleared atomically.
 */
export function requiresMergedPrTerminalOwnershipCleanup(issue: Readonly<Record<string, unknown>>): boolean {
  if (issue["status"] !== "done") return true;
  if (issue["assigneeAgentId"] !== null && issue["assigneeAgentId"] !== undefined) return true;
  if (issue["executionPolicy"] !== null && issue["executionPolicy"] !== undefined) return true;
  const executionState = issue["executionState"];
  if (executionState === null || executionState === undefined) return false;
  if (!executionState || typeof executionState !== "object" || Array.isArray(executionState)) return true;
  const state = executionState as Readonly<Record<string, unknown>>;
  const status = state["status"];
  if (status !== "idle" && status !== "completed" && status !== "cleared") return true;
  return ["reviewRequest", "currentStageId", "currentStageType", "currentStageIndex", "currentParticipant"]
    .some((key) => state[key] !== null && state[key] !== undefined);
}

/**
 * Managed implementation is owned by its provider adapter. Native review
 * cards own Luna/Terra decisions later; installing a host execution policy
 * here creates a competing generic-review state machine.
 */
export function nativeManagedExecutionDispatchPatch(assigneeAgentId: string): Record<string, unknown> {
  return {
    status: "in_progress",
    assigneeAgentId,
    executionPolicy: null,
    executionState: null,
  };
}

/**
 * Paperclip v831 execution-policy review stages do not consume the adapter's
 * addressed `request_item_verdicts` cards.  A managed ready PR therefore has
 * exactly one review authority: transfer it to the native-card ladder before
 * Luna or Terra is dispatched.  The predicate is deliberately narrow so an
 * operator-authored policy remains untouched outside that protocol.
 */
export function shouldTakeOverNativePrReview(input: {
  readonly orchestratorManaged: boolean;
  readonly hasReadyPullRequest: boolean;
  readonly nativeReviewConfigured: boolean;
  readonly rawIssue: Readonly<Record<string, unknown>>;
}): boolean {
  return input.orchestratorManaged &&
    input.hasReadyPullRequest &&
    input.nativeReviewConfigured &&
    issueHasExecutionPolicy(input.rawIssue);
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
  /** A red or unverifiable CI gate belongs to the implementation lane, never review. */
  readonly ciGreen: boolean;
}): boolean {
  if (!input.orchestratorManaged || input.merged || !input.hasUnreviewedReadyPullRequest || !input.ciGreen) return false;
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
