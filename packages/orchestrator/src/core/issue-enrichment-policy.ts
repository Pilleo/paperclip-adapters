/**
 * Company issue listings are intentionally compact and omit executionState.
 * Lifecycle recovery needs the full record for terminal, review, and blocked
 * issues; without this fetch an expired external monitor is invisible.
 */
export function needsFullIssueRecord(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return normalized === "done" || normalized === "in_review" || normalized === "blocked";
}
