export type JulesMonitorAction =
  | { readonly action: "resume_provider"; readonly issueStatus: "in_progress"; readonly reason: string }
  | { readonly action: "return_to_todo"; readonly issueStatus: "todo"; readonly reason: string }
  | { readonly action: "preserve"; readonly reason: string };

export interface JulesMonitorSnapshot {
  readonly issueStatus: string;
  readonly assigneeIsOrchestrator: boolean;
  readonly serviceName: string | null;
  readonly monitorStatus: string | null;
  readonly timeoutAt: string | null;
  readonly hasProviderSession: boolean;
  /** Whether the adapter can prove that a native monitor will be re-established. */
  readonly monitorCanBeReattached?: boolean;
}

const JULES_MONITOR_CADENCE_MS = 5 * 60 * 1000;
const JULES_MONITOR_TIMEOUT_MS = 48 * 60 * 60 * 1000;

/**
 * Builds the same native Paperclip monitor shape used by the Jules adapter.
 * Keeping this pure lets the orchestrator prove the payload before issuing a
 * mutation; an external session id by itself is never treated as a monitor.
 */
export function buildJulesMonitorReattachment(
  existingPolicy: Record<string, unknown>,
  providerSessionId: string,
  now: number,
): Record<string, unknown> {
  const sessionId = providerSessionId.trim();
  if (!sessionId) throw new Error("Cannot reattach Jules monitor without a provider session id");
  if (!Number.isFinite(now)) throw new Error("Cannot reattach Jules monitor with an invalid timestamp");
  const { monitor: _previousMonitor, ...policy } = existingPolicy;
  return {
    ...policy,
    mode: policy["mode"] ?? "normal",
    monitor: {
      nextCheckAt: new Date(now + JULES_MONITOR_CADENCE_MS).toISOString(),
      timeoutAt: new Date(now + JULES_MONITOR_TIMEOUT_MS).toISOString(),
      notes: "Jules cloud session is active; Paperclip will poll it when this monitor is due.",
      scheduledBy: "assignee",
      kind: "external_service",
      serviceName: "jules",
      externalRef: sessionId,
      recoveryPolicy: "wake_owner",
    },
  };
}

/**
 * Paperclip may leave a managed Jules issue blocked after an expired external
 * monitor even though the provider session is still resumable. This reducer
 * only reopens that exact structured state; it never classifies provider prose
 * or guesses completion.
 */
export function decideJulesMonitorReconciliation(
  snapshot: JulesMonitorSnapshot,
  now: number,
): JulesMonitorAction {
  if (snapshot.issueStatus !== "blocked" && snapshot.issueStatus !== "todo") return { action: "preserve", reason: "issue is not resumable from its current status" };
  if (!snapshot.assigneeIsOrchestrator) return { action: "preserve", reason: "issue is not owned by the orchestrator" };
  if (snapshot.serviceName !== "jules") return { action: "preserve", reason: "monitor is not a Jules monitor" };
  // Native executionPolicy.monitor payloads do not carry the legacy
  // `triggered` status. A missing status is valid when the remaining native
  // monitor fields are present; an explicit non-triggered status is not.
  if (snapshot.monitorStatus !== null && snapshot.monitorStatus !== "triggered") return { action: "preserve", reason: "Jules monitor is not triggered" };
  const timeout = snapshot.timeoutAt ? Date.parse(snapshot.timeoutAt) : NaN;
  if (!Number.isFinite(timeout) || now < timeout) return { action: "preserve", reason: "Jules monitor timeout has not elapsed" };
  if (!snapshot.hasProviderSession) return { action: "preserve", reason: "expired Jules monitor has no provider session to resume" };
  if (snapshot.monitorCanBeReattached === false) {
    return { action: "return_to_todo", issueStatus: "todo", reason: "expired Jules monitor has no verified executable continuation" };
  }
  return { action: "resume_provider", issueStatus: "in_progress", reason: "expired Jules monitor has a persisted provider session" };
}
