/**
 * Temporary adapter-only recovery for Paperclip versions that do not yet
 * recognise a successful external-provider poll as a continuation. The
 * explicit source run bypasses Paperclip's no-progress re-wake throttle while
 * preserving the provider session. This module uses only structured heartbeat
 * state; it never reads or classifies Jules prose.
 */
import { liveSessionId, type HeartbeatRunSummary } from "./session-continuation.js";
import { JULES_PROVIDER_POLL_CADENCE_MS } from "@pilleo/paperclip-adapter-common";

export const JULES_SUPERVISOR_MARKER = "jules-session-supervisor";
// The supervisor is only a compatibility continuation path. It must never
// poll more often than the native Jules monitor, or it defeats the provider
// pacing contract by sending an additional wake between monitor checks.
export const JULES_SUPERVISOR_CADENCE_MS = JULES_PROVIDER_POLL_CADENCE_MS;

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
    // Paperclip places a scheduled retry ahead of the source run that owns
    // the provider session. The retry row intentionally has no session id;
    // using `find` therefore made a due retry look unresumable forever. Pick
    // the newest session-bearing run, while ignoring sessionless scheduler
    // projections and preserving the source run id for the explicit wake.
    const run = input.runs
      .filter((candidate) => candidate.issueId === issue.id && Boolean(liveSessionId(candidate)))
      .sort((left, right) => {
        const leftTime = Date.parse(left.finishedAt ?? left.startedAt ?? "");
        const rightTime = Date.parse(right.finishedAt ?? right.startedAt ?? "");
        return rightTime - leftTime;
      })[0];
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
