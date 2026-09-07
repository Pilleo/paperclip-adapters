/**
 * Paperclip's cross-issue write guard validates the persisted run's source
 * issue, not merely the presence of a run id or JWT. Keep that requirement
 * explicit at the adapter boundary so a generic/manual wake cannot enter a
 * mutation path and then retry a guaranteed 403.
 */
export type IssueScopedRunDecision =
  | { readonly kind: "scoped"; readonly runId: string }
  | { readonly kind: "unscoped"; readonly code: "run_id_missing" | "issue_context_missing" | "issue_context_mismatch" };

export function evaluateIssueScopedRun(input: {
  readonly runId?: unknown;
  readonly context?: unknown;
  readonly issueId: string;
}): IssueScopedRunDecision {
  const runId = typeof input.runId === "string" ? input.runId.trim() : "";
  if (!runId) return { kind: "unscoped", code: "run_id_missing" };

  const context = input.context && typeof input.context === "object" && !Array.isArray(input.context)
    ? input.context as Record<string, unknown>
    : {};
  const nestedIssueId = [context["task"], context["paperclipIssue"]]
    .map((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate)
      ? (candidate as Record<string, unknown>)["id"]
      : undefined)
    .find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
  const contextIssueId = [context["issueId"], context["taskId"], nestedIssueId]
    .find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0)?.trim();
  if (!contextIssueId) return { kind: "unscoped", code: "issue_context_missing" };
  if (contextIssueId !== input.issueId) return { kind: "unscoped", code: "issue_context_mismatch" };
  return { kind: "scoped", runId };
}
