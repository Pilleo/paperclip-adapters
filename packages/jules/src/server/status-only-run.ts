export type StatusOnlyRunDecision =
  | { readonly kind: "normal" }
  | { readonly kind: "status_comment"; readonly issueId: string }
  | { readonly kind: "invalid"; readonly reason: string };

/** A status-only wake cannot spend another provider or deliverable effect. */
export function classifyJulesStatusOnlyRun(input: {
  readonly run: unknown;
  readonly expected: { readonly runId: string; readonly companyId: string;
    readonly agentId: string; readonly issueId: string };
}): StatusOnlyRunDecision {
  const record = input.run && typeof input.run === "object" && !Array.isArray(input.run)
    ? input.run as Record<string, unknown> : null;
  if (!record || !input.expected.runId || !input.expected.companyId || !input.expected.agentId ||
      !input.expected.issueId || record["id"] !== input.expected.runId ||
      record["companyId"] !== input.expected.companyId || record["agentId"] !== input.expected.agentId ||
      record["status"] !== "running") {
    return { kind: "invalid", reason: "status-only source run identity or execution ownership changed" };
  }
  const snapshot = record["contextSnapshot"] && typeof record["contextSnapshot"] === "object" &&
    !Array.isArray(record["contextSnapshot"])
    ? record["contextSnapshot"] as Record<string, unknown> : null;
  if (!snapshot || snapshot["issueId"] !== input.expected.issueId) {
    return { kind: "invalid", reason: "status-only run lost its exact task attribution" };
  }
  // Coalesced monitor wakes can replace wakeReason while the host retains these
  // mutation guards. The durable authority takes precedence over the wake label.
  if (snapshot["recoveryIntent"] === "status_only") {
    if (snapshot["allowDeliverableWork"] !== false || snapshot["allowDocumentUpdates"] !== false ||
        snapshot["resumeRequiresNormalModel"] !== true) {
      return { kind: "invalid", reason: "status-only run has incomplete host mutation guards" };
    }
    return { kind: "status_comment", issueId: input.expected.issueId };
  }
  return snapshot["wakeReason"] === "missing_issue_comment"
    ? { kind: "status_comment", issueId: input.expected.issueId }
    : { kind: "normal" };
}
