/**
 * Domain types for the Paperclip Deterministic Orchestrator.
 * All models are designed with immutability and strict type safety.
 */

export type TaskPriority = "critical" | "high" | "medium" | "low";

export type IssueStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "cancelled"
  | "blocked";

export interface ParsedIssueMetadata {
  readonly id: string;
  readonly identifier?: string | null | undefined;
  readonly issueNumber?: number | null | undefined;
  readonly title: string;
  readonly status: IssueStatus | string;
  readonly priority: TaskPriority;
  readonly priorityRank: number;
  readonly dependencies: readonly string[];
  readonly targetFiles: readonly string[];
  readonly targetModules: readonly string[];
  readonly targetSymbols: readonly string[];
  readonly hasSideEffects: boolean;
  readonly component?: string | null | undefined;
  readonly isNonInterfering: boolean;
  readonly assigneeAgentId?: string | null | undefined;
  readonly rawIssue: Readonly<Record<string, unknown>>;
}

export interface ConflictEdge {
  readonly issueId1: string;
  readonly issueId2: string;
  readonly reason: string;
}

export interface ConflictMatrixResult {
  readonly blockedByMap: ReadonlyMap<string, readonly string[]>;
  readonly conflictEdges: readonly ConflictEdge[];
}

export interface CandidateSelection {
  readonly issue: ParsedIssueMetadata;
  readonly targetAgentId?: string | undefined;
  readonly reason: string;
}

export interface MultiLaneOptions {
  readonly julesAgentId?: string | undefined;
  readonly vibeAgentId?: string | undefined;
  readonly julesRunningCount?: number | undefined;
  readonly vibeRunningCount?: number | undefined;
  readonly julesCapacity?: number | undefined;
  readonly vibeCapacity?: number | undefined;
  readonly maxToSelect?: number | undefined;
  readonly extraLockedFiles?: ReadonlySet<string> | undefined;
}

export interface JulesQuotaStatus {
  readonly activeSessionsCount: number;
  readonly sessionsLast24hCount: number;
  readonly maxConcurrent: number;
  readonly maxDaily: number;
  readonly availableConcurrentSlots: number;
  readonly availableDailySlots: number;
  readonly effectiveAvailableCapacity: number;
  readonly fetchedLive: boolean;
  readonly error?: string | undefined;
}

export interface GitHubPullRequest {
  readonly number: number;
  readonly title: string;
  readonly state: "OPEN" | "CLOSED" | "MERGED";
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly mergedAt: string | null;
  readonly url: string;
  readonly files: readonly string[];
}

export interface GitHubSyncStatus {
  readonly openPrs: readonly GitHubPullRequest[];
  readonly mergedPrs: readonly GitHubPullRequest[];
  readonly openPrFiles: ReadonlySet<string>;
  readonly error?: string | undefined;
}

export interface WorkspaceConsistencyReport {
  readonly isClean: boolean;
  readonly currentBranch: string;
  readonly headSha: string;
  readonly isConsistent: boolean;
  readonly warning?: string | undefined;
}
