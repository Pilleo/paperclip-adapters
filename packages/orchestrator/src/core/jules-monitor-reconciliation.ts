export type JulesMonitorAction =
  | { readonly action: "resume_provider"; readonly issueStatus: "in_progress"; readonly reason: string }
  | { readonly action: "preserve"; readonly reason: string };

export interface JulesMonitorSnapshot {
  readonly issueStatus: string;
  readonly assigneeIsOrchestrator: boolean;
  readonly serviceName: string | null;
  readonly monitorStatus: string | null;
  readonly timeoutAt: string | null;
  readonly hasProviderSession: boolean;
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
  if (snapshot.monitorStatus !== "triggered") return { action: "preserve", reason: "Jules monitor is not triggered" };
  const timeout = snapshot.timeoutAt ? Date.parse(snapshot.timeoutAt) : NaN;
  if (!Number.isFinite(timeout) || now < timeout) return { action: "preserve", reason: "Jules monitor timeout has not elapsed" };
  if (!snapshot.hasProviderSession) return { action: "preserve", reason: "expired Jules monitor has no provider session to resume" };
  return { action: "resume_provider", issueStatus: "in_progress", reason: "expired Jules monitor has a persisted provider session" };
}
