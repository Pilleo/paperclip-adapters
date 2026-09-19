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

function hasJulesMonitor(container: unknown): boolean {
  if (!container || typeof container !== "object" || Array.isArray(container)) return false;
  const monitor = (container as Record<string, unknown>)["monitor"];
  if (!monitor || typeof monitor !== "object" || Array.isArray(monitor)) return false;
  return (monitor as Record<string, unknown>)["serviceName"] === "jules";
}

/**
 * Detects which state machine owns a blocked issue, not whether its monitor is
 * executable. A redacted executionState projection is deliberately enough to
 * keep generic orphan cleanup away; the stricter monitor reconciliation path
 * separately proves the durable session before it mutates or resumes work.
 */
export function hasJulesMonitorClaim(input: {
  readonly executionPolicy?: unknown;
  readonly executionState?: unknown;
}): boolean {
  return hasJulesMonitor(input.executionPolicy) || hasJulesMonitor(input.executionState);
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

/** Compatibility predicate for callers that only need the review-eligible arm. */
export function canPromoteJulesPrToReview(input: {
  readonly ciGreen: boolean;
  readonly currentHeadRejected: boolean;
  readonly executionPolicy?: unknown;
}): boolean {
  return input.ciGreen && classifyJulesPrReviewDisposition(input).kind === "eligible_for_review";
}
