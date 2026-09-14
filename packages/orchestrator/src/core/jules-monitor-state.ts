/**
 * Paperclip projects a native monitor into executionState while a run is
 * executing. That projection can survive a terminal adapter result, so it is
 * not authoritative ownership of provider work. Only executionPolicy is the
 * durable input the orchestrator can safely reattach.
 */
export function isAuthoritativeJulesMonitor(executionPolicy: unknown): boolean {
  if (!executionPolicy || typeof executionPolicy !== "object" || Array.isArray(executionPolicy)) return false;
  const monitor = (executionPolicy as Record<string, unknown>)["monitor"];
  if (!monitor || typeof monitor !== "object" || Array.isArray(monitor)) return false;
  const record = monitor as Record<string, unknown>;
  return record["serviceName"] === "jules" && typeof record["externalRef"] === "string" && (record["externalRef"] as string).trim().length > 0;
}

export type JulesPrReviewDisposition =
  | { readonly kind: "await_provider" }
  | { readonly kind: "recover_provider" }
  | { readonly kind: "eligible_for_review" };

/**
 * Keep the two non-review states separate. A live monitor means the provider
 * owns the next action; a rejected head without that monitor means ownership
 * was lost and must be reattached before this PR can make progress again.
 */
export function classifyJulesPrReviewDisposition(input: {
  readonly currentHeadRejected: boolean;
  readonly executionPolicy?: unknown;
}): JulesPrReviewDisposition {
  const monitorState: "authoritative" | "absent" = isAuthoritativeJulesMonitor(input.executionPolicy)
    ? "authoritative"
    : "absent";

  switch (monitorState) {
    case "authoritative":
      return { kind: "await_provider" };
    case "absent": {
      const rejectionState: "rejected" | "clear" = input.currentHeadRejected ? "rejected" : "clear";
      switch (rejectionState) {
        case "rejected":
          return { kind: "recover_provider" };
        case "clear":
          return { kind: "eligible_for_review" };
      }
    }
  }
}
