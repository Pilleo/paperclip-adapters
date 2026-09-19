import { JULES_PROVIDER_POLL_CADENCE_MS } from "@pilleo/paperclip-adapter-common";

export type JulesMonitorAction =
  | { readonly action: "resume_provider"; readonly issueStatus: "in_progress"; readonly reason: string }
  | { readonly action: "return_to_todo"; readonly issueStatus: "todo"; readonly reason: string }
  | { readonly action: "preserve"; readonly reason: string };

export interface JulesMonitorSnapshot {
  readonly issueStatus: string;
  readonly assigneeIsOrchestrator: boolean;
  readonly serviceName: string | null;
  readonly monitorStatus: string | null;
  readonly monitorClearReason?: string | null;
  readonly timeoutAt: string | null;
  readonly hasProviderSession: boolean;
  /** Whether the adapter can prove that a native monitor will be re-established. */
  readonly monitorCanBeReattached?: boolean;
  /** The native policy was dropped while the projected Jules monitor survived. */
  readonly monitorDetached?: boolean;
  /**
   * An exact v2 native plan-verdict card for this parent/session/revision was
   * resolved. This is the sole safe exception for the adapter's deliberate
   * `manual` monitor clear while a reviewer owns the child form.
   */
  readonly resolvedNativePlanVerdict?: boolean;
  readonly assigneeIsJules?: boolean;
}

const JULES_MONITOR_TIMEOUT_MS = 48 * 60 * 60 * 1000;
const JULES_SESSION_HANDLE_ID = /^julesSessionId:\s*([A-Za-z0-9_-]+)\s*$/m;

/**
 * Resolve the provider identity used to rebuild a Jules monitor.
 *
 * Paperclip deliberately redacts an external monitor reference in some issue
 * projections after clearing the monitor. That display placeholder is not a
 * provider identity. A recovery may use the issue's durable `jules-session`
 * document instead, but only when it contains the exact, versioned handle
 * line written by the Jules adapter.
 */
export function resolveJulesMonitorSessionId(input: {
  readonly monitorExternalRef: unknown;
  readonly sessionHandleBody?: unknown;
}): string | null {
  if (typeof input.monitorExternalRef === "string") {
    const candidate = input.monitorExternalRef.trim();
    if (/^[A-Za-z0-9_-]+$/.test(candidate) && candidate !== "redacted") return candidate;
  }
  if (typeof input.sessionHandleBody !== "string") return null;
  return input.sessionHandleBody.match(JULES_SESSION_HANDLE_ID)?.[1] ?? null;
}

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
      nextCheckAt: new Date(now + JULES_PROVIDER_POLL_CADENCE_MS).toISOString(),
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
  const invalidAssigneeRepair = (snapshot.issueStatus === "in_progress" || snapshot.issueStatus === "blocked" || snapshot.issueStatus === "todo") &&
    snapshot.monitorStatus === "cleared" &&
    snapshot.monitorClearReason === "invalid_assignee" &&
    snapshot.assigneeIsJules === true;
  // A failed worker heartbeat can be normalized to backlog and returned to
  // the orchestrator before its native monitor projection is reconstructed.
  // This is still the same proven, detached Jules continuation; ownership and
  // provider-session checks below remain mandatory before it can resume.
  const strandedMonitorRepair =
    (snapshot.issueStatus === "in_progress" || snapshot.issueStatus === "backlog" || snapshot.issueStatus === "blocked" || snapshot.issueStatus === "todo") &&
    snapshot.monitorDetached === true;
  // Paperclip can normalize a parent that is waiting on a reviewer-owned
  // native form to either backlog or blocked. Both are a suspended Jules
  // continuation, provided the exact v2 card proves that the parent/session/
  // revision still match. Never include in_progress: an active Jules run will
  // consume the card through its normal heartbeat instead of being woken again.
  const resolvedPlanVerdictRepair =
    (snapshot.issueStatus === "backlog" || snapshot.issueStatus === "blocked") &&
    snapshot.monitorStatus === "cleared" &&
    snapshot.monitorClearReason === "manual" &&
    snapshot.resolvedNativePlanVerdict === true;
  if (snapshot.issueStatus !== "blocked" && snapshot.issueStatus !== "todo" && !invalidAssigneeRepair && !strandedMonitorRepair && !resolvedPlanVerdictRepair) return { action: "preserve", reason: "issue is not resumable from its current status" };
  if (!snapshot.assigneeIsOrchestrator) return { action: "preserve", reason: "issue is not owned by the orchestrator" };
  if (snapshot.serviceName !== "jules") return { action: "preserve", reason: "monitor is not a Jules monitor" };
  // Native executionPolicy.monitor payloads do not carry the legacy
  // `triggered` status. A missing status is valid when the remaining native
  // monitor fields are present; an explicit non-triggered status is not.
  if (!invalidAssigneeRepair && !strandedMonitorRepair && !resolvedPlanVerdictRepair && snapshot.monitorStatus !== null && snapshot.monitorStatus !== "triggered") return { action: "preserve", reason: "Jules monitor is not triggered" };
  const timeout = snapshot.timeoutAt ? Date.parse(snapshot.timeoutAt) : NaN;
  if (!invalidAssigneeRepair && !strandedMonitorRepair && !resolvedPlanVerdictRepair && (!Number.isFinite(timeout) || now < timeout)) return { action: "preserve", reason: "Jules monitor timeout has not elapsed" };
  if (!snapshot.hasProviderSession) return { action: "preserve", reason: "expired Jules monitor has no provider session to resume" };
  // For the invalid-assignee repair path, `executionState.monitor` is the
  // verified native provider record we are rehydrating into
  // `executionPolicy.monitor`; requiring an already-existing policy here
  // would make the repair logically impossible. The strict fallback remains
  // for ordinary expired monitors whose only evidence is an external id.
  if (!invalidAssigneeRepair && !strandedMonitorRepair && !resolvedPlanVerdictRepair && snapshot.monitorCanBeReattached === false) {
    return { action: "return_to_todo", issueStatus: "todo", reason: "expired Jules monitor has no verified executable continuation" };
  }
  return {
    action: "resume_provider",
    issueStatus: "in_progress",
    reason: resolvedPlanVerdictRepair
      ? "resolved native plan verdict needs its Jules parent resumed"
      : strandedMonitorRepair
      ? "stranded Jules monitor has a persisted provider session"
      : invalidAssigneeRepair
      ? "cleared Jules monitor has a persisted provider session and valid Jules ownership"
      : "expired Jules monitor has a persisted provider session",
  };
}
