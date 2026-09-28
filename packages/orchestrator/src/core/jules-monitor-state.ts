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
 * The provider monitor is normally the ownership authority. A completed Jules
 * heartbeat that produced the current PR is the one exception: Paperclip
 * intentionally retains that monitor for recovery, but the provider has
 * already handed the immutable PR to native review.
 */
export type JulesPrHandoffEvidence =
  | { readonly kind: "terminal_pr_handoff" }
  | { readonly kind: "active_or_unverified_monitor" }
  | { readonly kind: "no_authoritative_monitor" };

export interface JulesPrHandoffHeartbeatRun {
  readonly id: string;
  readonly issueId: string | null;
  readonly status: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly provider: string | null;
  readonly providerSessionId: string | null;
  readonly julesState: string | null;
  readonly stopReason: string | null;
}

function monitorSessionId(executionPolicy: unknown): string | null {
  if (!isAuthoritativeJulesMonitor(executionPolicy)) return null;
  const monitor = (executionPolicy as Record<string, unknown>)["monitor"] as Record<string, unknown>;
  // Paperclip retains a redacted monitor projection after it has already
  // cleared execution ownership. It is history, not a live provider lease:
  // an operator-reconciled PR may have no adapter producer run to override it.
  if (monitor["status"] === "cleared") return null;
  return monitor["externalRef"] as string;
}

function completedAt(run: JulesPrHandoffHeartbeatRun): number | null {
  const timestamp = run.finishedAt ?? run.startedAt;
  if (!timestamp) return null;
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : null;
}

function hasLiveIssueExecution(runs: readonly JulesPrHandoffHeartbeatRun[], issueId: string): boolean {
  return runs.some(
    (run) =>
      run.issueId === issueId &&
      ["queued", "claimed", "running", "active"].includes(run.status),
  );
}

/**
 * A persisted monitor ordinarily owns the next provider action. The only safe
 * override is the exact run that registered the current PR: it must be the
 * newest run for this issue/session and explicitly report Jules completion.
 * Generic `pending` is intentionally not considered here because completed
 * Jules runs retain it solely to preserve Paperclip's monitor cadence.
 */
export function deriveJulesPrHandoffEvidence(input: {
  readonly executionPolicy?: unknown;
  /** Paperclip can retain the provider monitor here after policy cleanup. */
  readonly executionState?: unknown;
  readonly issueId: string;
  readonly producerRunId?: string | null;
  /**
   * The detail endpoint is authoritative for a work-product producer. The
   * list endpoint deliberately omits `resultJson`, so it cannot prove a
   * completed provider handoff by itself.
   */
  readonly producerRun?: JulesPrHandoffHeartbeatRun | null;
  readonly heartbeatRuns: readonly JulesPrHandoffHeartbeatRun[];
}): JulesPrHandoffEvidence {
  const sessionId = monitorSessionId(input.executionPolicy) ?? monitorSessionId(input.executionState);
  if (!sessionId) return { kind: "no_authoritative_monitor" };
  if (!input.producerRunId) return { kind: "active_or_unverified_monitor" };
  // The producer's immutable completion proves it created the PR; it does
  // not authorize overwriting a monitor run that started after that producer.
  // The caller must retry after the live run has settled.
  if (hasLiveIssueExecution(input.heartbeatRuns, input.issueId)) {
    return { kind: "active_or_unverified_monitor" };
  }

  if (input.producerRun?.id === input.producerRunId) {
    // Adapter-facing issue reads redact externalRef. The immutable
    // work-product already binds this exact run to the current PR, so the
    // hydrated run's terminal Jules result remains sufficient proof when the
    // only unavailable value is the secret session reference.
    const observableSessionId = sessionId === "[redacted]" ? null : sessionId;
    return isCompletedJulesProducer(input.producerRun, observableSessionId)
      ? { kind: "terminal_pr_handoff" }
      : { kind: "active_or_unverified_monitor" };
  }

  const matchingRuns = input.heartbeatRuns
    .filter((run) => run.issueId === input.issueId && run.providerSessionId === sessionId)
    .map((run) => ({ run, timestamp: completedAt(run) }));
  if (matchingRuns.length === 0 || matchingRuns.some((candidate) => candidate.timestamp === null)) {
    return { kind: "active_or_unverified_monitor" };
  }

  const newestTimestamp = Math.max(...matchingRuns.map((candidate) => candidate.timestamp!));
  const newestRuns = matchingRuns.filter((candidate) => candidate.timestamp === newestTimestamp).map((candidate) => candidate.run);
  if (newestRuns.length !== 1) return { kind: "active_or_unverified_monitor" };

  const latest = newestRuns[0]!;
  if (latest.id === input.producerRunId && isCompletedJulesProducer(latest, sessionId)) {
    return { kind: "terminal_pr_handoff" };
  }
  return { kind: "active_or_unverified_monitor" };
}

function isCompletedJulesProducer(run: JulesPrHandoffHeartbeatRun, sessionId: string | null): boolean {
  return run.status === "succeeded" &&
    run.provider === "jules" &&
    (sessionId === null || run.providerSessionId === sessionId) &&
    run.julesState === "COMPLETED" &&
    run.stopReason === "completed";
}

/**
 * Idempotency identity for promoting an already-open Jules PR into native
 * review.  Deliberately omit `updatedAt`: the promotion itself patches the
 * issue, so including that mutable timestamp creates a new key on every
 * heartbeat and turns one recovery into a write loop.
 */
export function openJulesPrRecoveryKey(input: {
  readonly issueId: string;
  readonly prUrl: string;
  readonly headSha?: string | null;
  readonly issueStatus: string;
  readonly assigneeAgentId?: string | null;
}): string {
  return [
    "jules-open-pr-recovery",
    input.issueId,
    input.prUrl.replace(/\/$/, "").toLowerCase(),
    input.headSha || "unknown",
    input.issueStatus,
    input.assigneeAgentId || "unassigned",
  ].join(":");
}

/**
 * Keep the two non-review states separate. A live monitor means the provider
 * owns the next action; a rejected head without that monitor means ownership
 * was lost and must be reattached before this PR can make progress again.
 */
export function classifyJulesPrReviewDisposition(input: {
  readonly currentHeadRejected: boolean;
  readonly executionPolicy?: unknown;
  readonly handoff?: JulesPrHandoffEvidence | undefined;
}): JulesPrReviewDisposition {
  const monitorState: JulesPrHandoffEvidence = input.handoff ?? (isAuthoritativeJulesMonitor(input.executionPolicy)
    ? { kind: "active_or_unverified_monitor" }
    : { kind: "no_authoritative_monitor" });

  switch (monitorState.kind) {
    case "active_or_unverified_monitor":
      return { kind: "await_provider" };
    case "terminal_pr_handoff": {
      switch (input.currentHeadRejected) {
        case true:
          return { kind: "recover_provider" };
        case false:
          return { kind: "eligible_for_review" };
      }
    }
    case "no_authoritative_monitor": {
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
