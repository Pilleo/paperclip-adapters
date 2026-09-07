import type { ParsedIssueMetadata } from "./types.js";

export type RecoveryArtifactKind = "productivity" | "silence";

export type RecoveryArtifactDecision =
  | { readonly action: "preserve" }
  | { readonly action: "close"; readonly status: "cancelled"; readonly reason: string };

export type BlockedManagedWorkDecision =
  | { readonly action: "preserve" }
  | { readonly action: "reclaim"; readonly status: "todo"; readonly reason: string };

function description(issue: ParsedIssueMetadata): string {
  const value = issue.rawIssue["description"];
  return typeof value === "string" ? value.toLowerCase() : "";
}

export function classifyRecoveryArtifact(issue: ParsedIssueMetadata): RecoveryArtifactKind | null {
  const title = issue.title.toLowerCase();
  const body = description(issue);
  if (title.startsWith("review productivity for ") || body.includes("unusual productivity/progression pattern")) return "productivity";
  if (title.startsWith("review silent active run for ") || body.includes("critical output silence")) return "silence";
  return null;
}

function isTerminal(status: string): boolean {
  return status === "done" || status === "cancelled";
}

/**
 * Paperclip productivity/silence reports are observations, not work. Once
 * their source is terminal or their assigned reviewer cannot be invoked,
 * retrying them only creates the blocked -> todo -> blocked loop.
 */
export function decideRecoveryArtifact(
  issue: ParsedIssueMetadata,
  source: ParsedIssueMetadata | null,
  assigneeInvokable: boolean,
): RecoveryArtifactDecision {
  const kind = classifyRecoveryArtifact(issue);
  if (!kind || isTerminal(issue.status)) return { action: "preserve" };
  if (issue.status === "blocked") {
    return { action: "close", status: "cancelled", reason: `${kind} diagnostic is blocked and is not executable work` };
  }
  if (source && isTerminal(source.status)) {
    return { action: "close", status: "cancelled", reason: `${kind} diagnostic source is terminal` };
  }
  if (!assigneeInvokable) {
    return { action: "close", status: "cancelled", reason: `${kind} diagnostic assignee is not invokable` };
  }
  return { action: "preserve" };
}

/** Reclaims stale local Vibe work, while preserving explicit Jules gates. */
export function decideBlockedManagedWork(
  issue: ParsedIssueMetadata,
  adapterType: string | null,
  agentStatus: string | null,
): BlockedManagedWorkDecision {
  if (issue.status !== "blocked" || adapterType !== "vibe" || issue.executionRunId) return { action: "preserve" };
  const body = description(issue);
  if (body.includes("awaits plan approval") || body.includes("awaiting plan approval") || body.includes("human approval")) {
    return { action: "preserve" };
  }
  if (agentStatus === "paused" || agentStatus === "error" || agentStatus === "offline" || !agentStatus) {
    return { action: "preserve" };
  }
  return { action: "reclaim", status: "todo", reason: "blocked Vibe work has no live execution or provider monitor" };
}
