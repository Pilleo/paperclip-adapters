export type DependencyGateResult =
  | { readonly safe: true }
  | { readonly safe: false; readonly reason: string };

/**
 * Evaluate the server's enriched blockedBy projection immediately before a
 * dispatch. Missing blocker data is unsafe: an approved start can authorize
 * work, but it cannot authorize bypassing an unresolved or unreadable edge.
 */
export function evaluateAuthoritativeDependencies(issue: Readonly<Record<string, unknown>>): DependencyGateResult {
  const blockedBy = issue["blockedBy"];
  if (!Array.isArray(blockedBy)) {
    return { safe: false, reason: "authoritative blockedBy projection is missing" };
  }

  for (const blocker of blockedBy) {
    if (!blocker || typeof blocker !== "object" || Array.isArray(blocker)) {
      return { safe: false, reason: "authoritative blocker record is malformed" };
    }
    const record = blocker as Record<string, unknown>;
    const blockerId = typeof record["id"] === "string" ? record["id"] : "unknown blocker";
    const status = typeof record["status"] === "string" ? record["status"].trim().toLowerCase() : "";
    if (status !== "done" && status !== "cancelled") {
      return { safe: false, reason: `unresolved blocker ${blockerId} (${status || "unknown status"})` };
    }
  }

  return { safe: true };
}
