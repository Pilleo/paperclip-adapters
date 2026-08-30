export interface ExecutionPolicyParticipant {
  readonly type: "agent" | "user";
  readonly agentId?: string | undefined;
  readonly userId?: string | undefined;
}

export interface ExecutionPolicyStage {
  readonly type: "review" | "approval";
  readonly participants: readonly ExecutionPolicyParticipant[];
}

export interface MazewallExecutionPolicy {
  readonly mode: "normal";
  readonly commentRequired: true;
  readonly stages: readonly ExecutionPolicyStage[];
}

export function buildMazewallExecutionPolicy(options: {
  readonly vibeAgentId?: string | undefined;
  readonly reviewerAgentId?: string | undefined;
  readonly approverUserId?: string | undefined;
}): MazewallExecutionPolicy | null {
  const stages: ExecutionPolicyStage[] = [];

  if (options.vibeAgentId) {
    stages.push({
      type: "review",
      participants: [{ type: "agent", agentId: options.vibeAgentId }],
    });
  }
  if (options.reviewerAgentId && options.reviewerAgentId !== options.vibeAgentId) {
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
