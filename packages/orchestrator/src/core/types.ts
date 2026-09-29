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

export type IssueState = IssueStatus | "unknown";

const ISSUE_STATUSES: ReadonlySet<string> = new Set<IssueStatus>([
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
  "blocked",
]);

export function normalizeIssueStatus(raw: unknown): IssueState {
  if (typeof raw !== "string") return "unknown";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "resolved") return "done";
  return ISSUE_STATUSES.has(normalized) ? normalized as IssueStatus : "unknown";
}

export interface ParsedIssueMetadata {
  readonly id: string;
  readonly identifier?: string | null | undefined;
  readonly issueNumber?: number | null | undefined;
  readonly title: string;
  /** Original task contract used to ground native reviewer decisions. */
  readonly description?: string | null | undefined;
  readonly status: IssueState;
  readonly priority: TaskPriority;
  readonly priorityRank: number;
  readonly dependencies: readonly string[];
  readonly targetFiles: readonly string[];
  readonly targetModules: readonly string[];
  readonly targetSymbols: readonly string[];
  readonly hasSideEffects: boolean;
  readonly coreLock: boolean;
  readonly needsKernel: boolean;
  readonly exclusive: boolean;
  readonly verifyCheap: readonly string[];
  readonly component?: string | null | undefined;
  readonly projectSlug?: string | null | undefined;
  readonly projectId?: string | null | undefined;
  readonly isNonInterfering: boolean;
  readonly openQuestions: boolean;
  /** True when the task is owned by this orchestrator's imported backlog. */
  readonly orchestratorManaged: boolean;
  readonly assigneeAgentId?: string | null | undefined;
  /** Native Paperclip parent relationship, when this is a child issue. */
  readonly parentId?: string | null | undefined;
  /** Stable marker identifies children whose state is owned by a reviewer ladder. */
  readonly isDelegatedReviewChild?: boolean;
  readonly updatedAt?: string | null | undefined;
  readonly executionRunId?: string | null | undefined;
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
  /** Fresh provider-session starts allowed in this tick; provider-owned sessions do not consume it. */
  readonly julesNewSessionBudget?: number | undefined;
  readonly vibeCapacity?: number | undefined;
  readonly maxToSelect?: number | undefined;
  readonly extraLockedFiles?: ReadonlySet<string> | undefined;
  /** Already-approved starts outrank merely pending resource contenders. */
  readonly preferredIssueIds?: ReadonlySet<string> | undefined;
  /** Recoverable provider sessions may resume only on the Jules lane. */
  readonly julesOnlyIssueIds: ReadonlySet<string>;
}

interface GitHubPullRequestFields {
  readonly number: number;
  readonly title: string;
  readonly headRefName: string;
  /** Immutable Git commit identity used to invalidate prior review verdicts. */
  readonly headRefOid?: string | undefined;
  readonly baseRefName: string;
  readonly url: string;
  readonly files: readonly string[];
}

export type GitHubPullRequest = GitHubPullRequestFields & (
  | { readonly state: "MERGED"; readonly mergedAt: string }
  | { readonly state: "OPEN" | "CLOSED"; readonly mergedAt: null }
);

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
