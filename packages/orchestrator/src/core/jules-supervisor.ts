/**
 * Temporary adapter-only recovery for Paperclip versions that do not yet
 * recognise a successful external-provider poll as a continuation. The
 * explicit source run bypasses Paperclip's no-progress re-wake throttle while
 * preserving the provider session. This module uses only structured heartbeat
 * state; it never reads or classifies Jules prose.
 */
import { liveSessionId, type HeartbeatRunSummary } from "./session-continuation.js";

export const JULES_SUPERVISOR_MARKER = "jules-session-supervisor";
export const JULES_SUPERVISOR_CADENCE_MS = 300_000;

export interface JulesSupervisorIssue {
  readonly id: string;
  readonly identifier?: string | null | undefined;
  readonly status: string;
  readonly assigneeAgentId?: string | null | undefined;
}

export interface JulesSupervisorAction {
  readonly issueId: string;
  readonly sessionId: string;
  readonly resumeFromRunId: string;
  readonly wake: boolean;
}

/** One-time cleanup for children created by the superseded bridge. */
export function selectJulesSupervisorIssueIdsToClose(input: {
  supervisorChildren: readonly { id: string; parentId: string }[];
}): string[] {
  return input.supervisorChildren.map((child) => child.id);
}

export function selectJulesSupervisorActions(input: {
  issues: readonly JulesSupervisorIssue[];
  runs: readonly HeartbeatRunSummary[];
  julesAgentId: string | undefined;
  now?: number;
}): JulesSupervisorAction[] {
  if (!input.julesAgentId) return [];
  const now = input.now ?? Date.now();
  return input.issues.flatMap((issue) => {
    if (issue.assigneeAgentId !== input.julesAgentId || issue.status !== "in_progress") return [];
    const run = input.runs.find((candidate) => candidate.issueId === issue.id && Boolean(liveSessionId(candidate)));
    const sessionId = run ? liveSessionId(run) : null;
    if (!run || !sessionId) return [];
    const retryAt = run.retryNotBefore ? Date.parse(run.retryNotBefore) : NaN;
    const finishedAt = Date.parse(run.finishedAt ?? run.startedAt ?? "");
    const due = Number.isNaN(retryAt)
      ? !Number.isNaN(finishedAt) && now >= finishedAt + JULES_SUPERVISOR_CADENCE_MS
      : now >= retryAt;
    return [{
      issueId: issue.id,
      sessionId,
      resumeFromRunId: run.id,
      wake: due,
    }];
  });
}
