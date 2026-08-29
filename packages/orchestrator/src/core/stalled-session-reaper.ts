import { ParsedIssueMetadata } from "./types.js";

export interface StalledSessionReaperOptions {
  readonly stalledThresholdMs?: number; // default: 15 minutes
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
  const threshold = options.stalledThresholdMs ?? 15 * 60 * 1000;
  const currentTimestamp = (options.now ?? Date.now)();

  const stalled: { issue: ParsedIssueMetadata; idleDurationMs: number }[] = [];

  for (const issue of issues) {
    if (issue.status !== "in_progress") continue;
    if (activeExecutionIssueIds.has(issue.id)) continue;

    const lastUpdated = issue.updatedAt ? new Date(issue.updatedAt).getTime() : 0;
    const idleDuration = currentTimestamp - lastUpdated;

    if (idleDuration >= threshold) {
      stalled.push({ issue, idleDurationMs: idleDuration });
    }
  }

  return Object.freeze(stalled);
}
