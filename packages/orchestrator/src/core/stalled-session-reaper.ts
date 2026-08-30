import { ParsedIssueMetadata } from "./types.js";

export interface StalledSessionReaperOptions {
  readonly stalledThresholdMs?: number; // local managed workers (default 15 minutes)
  readonly julesThresholdMs?: number; // managed Jules only (default 48 hours)
  readonly managedAgentIds?: ReadonlySet<string>;
  readonly managedJulesIds?: ReadonlySet<string>;
  readonly now?: () => number;
}

export interface ReclaimResult {
  readonly issueId: string;
  readonly identifier: string;
  readonly title: string;
  readonly idleDurationMs: number;
  readonly action: "reclaimed_to_todo" | "quarantined";
}

/**
 * Identifies and reclaims issues stuck in 'in_progress' without an active runner or heartbeat.
 */
export function identifyStalledIssues(
  issues: readonly ParsedIssueMetadata[],
  activeExecutionIssueIds: ReadonlySet<string>,
  options: StalledSessionReaperOptions = {}
): readonly { issue: ParsedIssueMetadata; idleDurationMs: number }[] {
  const defaultThreshold = options.stalledThresholdMs ?? 15 * 60 * 1000;
  const julesThreshold = options.julesThresholdMs ?? 48 * 60 * 60 * 1000;
  const currentTimestamp = (options.now ?? Date.now)();
  const managedAgentIds = options.managedAgentIds;
  const managedJulesIds = options.managedJulesIds ?? new Set<string>();

  const stalled: { issue: ParsedIssueMetadata; idleDurationMs: number }[] = [];

  for (const issue of issues) {
    if (issue.status !== "in_progress") continue;
    if (activeExecutionIssueIds.has(issue.id)) continue;

    const assignee = issue.assigneeAgentId;
    if (!assignee) continue;
    if (managedAgentIds && !managedAgentIds.has(assignee)) {
      continue;
    }

    const isManagedJules = managedJulesIds.has(assignee);
    const threshold = isManagedJules ? julesThreshold : defaultThreshold;
    const lastUpdated = issue.updatedAt ? new Date(issue.updatedAt).getTime() : 0;
    const idleDuration = currentTimestamp - lastUpdated;

    if (idleDuration >= threshold) {
      stalled.push({ issue, idleDurationMs: idleDuration });
    }
  }

  return Object.freeze(stalled);
}
