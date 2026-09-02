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

const POLICY_STATUSES = new Set(["in_progress", "in_review"]);

export function issueNeedsExecutionPolicyBackfill(
  issue: {
    readonly status: string;
    readonly assigneeAgentId?: string | null | undefined;
    readonly rawIssue: Readonly<Record<string, unknown>>;
  },
  managedWorkerIds: ReadonlySet<string>,
): boolean {
  if (!POLICY_STATUSES.has(issue.status)) return false;
  const assignee = issue.assigneeAgentId;
  if (!assignee || !managedWorkerIds.has(assignee)) return false;
  return !issueHasExecutionPolicy(issue.rawIssue);
}
