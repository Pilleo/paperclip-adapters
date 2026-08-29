import { ParsedIssueMetadata } from "./types.js";

export interface QuarantineDecision {
  readonly shouldQuarantine: boolean;
  readonly reason?: string | undefined;
  readonly consecutiveFailures: number;
  readonly maintainLocks: boolean;
}

export const MAX_ALLOWED_CONSECUTIVE_FAILURES = 3;

export function evaluateTaskQuarantine(
  issue: ParsedIssueMetadata,
  failureHistory: readonly { readonly status?: string; readonly error?: string }[] = []
): QuarantineDecision {
  const failedRuns = failureHistory.filter(
    (r) => r.status === "failed" || r.status === "aborted" || r.status === "error"
  );

  const consecutiveFailures = failedRuns.length;

  if (consecutiveFailures >= MAX_ALLOWED_CONSECUTIVE_FAILURES) {
    return {
      shouldQuarantine: true,
      consecutiveFailures,
      reason: `Task failed ${consecutiveFailures} consecutive times. Quarantined for operator triage.`,
      maintainLocks: true, // File locks must be preserved to prevent race conditions on unstable code
    };
  }

  return {
    shouldQuarantine: false,
    consecutiveFailures,
    maintainLocks: true,
  };
}
