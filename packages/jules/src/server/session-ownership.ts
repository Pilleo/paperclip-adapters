export type JulesIssueOwnership = "owned" | "transferred" | "missing" | "unknown";

export interface JulesIssueOwnershipInput {
  readonly issue?: { readonly assigneeAgentId?: string | null; readonly status?: string } | null;
  readonly julesAgentId?: string | null;
  readonly fetchFailed?: { readonly status?: number | null };
}

/**
 * Decide whether a restored Jules session is still allowed to mutate its issue.
 * This is deliberately typed and independent from HTTP error text: a completed
 * session can outlive a Paperclip reassignment, and a 403 must not become an
 * endless retry loop.
 */
export function evaluateJulesIssueOwnership(input: JulesIssueOwnershipInput): JulesIssueOwnership {
  if (input.fetchFailed) {
    if (input.fetchFailed.status === 404) return "missing";
    return "unknown";
  }
  if (!input.issue || !input.julesAgentId) return "unknown";
  if (input.issue.status === "cancelled" || input.issue.status === "done") return "transferred";
  return input.issue.assigneeAgentId === input.julesAgentId ? "owned" : "transferred";
}
