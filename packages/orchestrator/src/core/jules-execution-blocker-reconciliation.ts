type UnknownRecord = Readonly<Record<string, unknown>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_RUN_STATUSES = new Set(["failed", "interrupted", "timed_out", "cancelled"]);
const RECOVERABLE_ISSUE_STATUSES = new Set(["blocked", "todo", "in_progress"]);

export interface JulesExecutionBlockerSnapshot {
  readonly issueStatus: unknown;
  readonly assigneeAgentId: unknown;
  readonly julesAgentId: unknown;
  readonly providerSessionId: unknown;
  readonly executionBlocker: unknown;
  readonly failedRun: unknown;
}

export interface JulesExecutionBlockerPointer {
  readonly actionId: string;
  readonly runId: string;
  readonly providerSessionId: string;
  readonly agentId: string;
}

export type JulesExecutionBlockerRecovery =
  | {
      readonly action: "resolve_to_todo";
      readonly actionId: string;
      readonly runId: string;
      readonly providerSessionId: string;
      readonly reason: string;
    }
  | { readonly action: "preserve"; readonly reason: string };

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

/**
 * Parse only the narrow Paperclip recovery hold that can safely be delegated
 * back to the Jules adapter. The durable session proves where continuation
 * lives; the recovery action and failed run UUIDs preserve Paperclip's typed
 * no-replay boundary until the server validates the reconciliation evidence.
 */
export function parseJulesExecutionBlockerPointer(
  snapshot: Omit<JulesExecutionBlockerSnapshot, "failedRun">,
): JulesExecutionBlockerPointer | null {
  if (!RECOVERABLE_ISSUE_STATUSES.has(String(snapshot.issueStatus ?? ""))) return null;
  const assigneeAgentId = nonEmptyString(snapshot.assigneeAgentId);
  const julesAgentId = nonEmptyString(snapshot.julesAgentId);
  if (!assigneeAgentId || assigneeAgentId !== julesAgentId) return null;
  const providerSessionId = nonEmptyString(snapshot.providerSessionId);
  if (!providerSessionId) return null;
  const blocker = record(snapshot.executionBlocker);
  if (blocker?.["cause"] !== "legacy_execution_requires_reconciliation") return null;
  const actionId = nonEmptyString(blocker["recoveryActionId"]);
  const runId = nonEmptyString(blocker["runId"]);
  const blockerAgentId = nonEmptyString(blocker["agentId"]);
  if (!actionId || !UUID.test(actionId) || !runId || !UUID.test(runId)) return null;
  if (blockerAgentId && blockerAgentId !== julesAgentId) return null;
  return { actionId, runId, providerSessionId, agentId: julesAgentId };
}

/**
 * Decide whether a legacy Paperclip execution hold belongs to a stopped Jules
 * polling turn. `jules_polling_error` means the adapter did not establish a
 * completed local continuation; it does not authorize replaying remote work.
 * The resulting `mixed` reconciliation deliberately returns control to the
 * Jules adapter, which must inspect its persisted provider session first.
 */
export function decideJulesExecutionBlockerRecovery(
  snapshot: JulesExecutionBlockerSnapshot,
): JulesExecutionBlockerRecovery {
  const pointer = parseJulesExecutionBlockerPointer(snapshot);
  if (!pointer) return { action: "preserve", reason: "issue has no typed Jules execution blocker continuation" };
  const run = record(snapshot.failedRun);
  if (!run) return { action: "preserve", reason: "blocking run is unavailable" };
  if (run["id"] !== pointer.runId) return { action: "preserve", reason: "blocking run identity changed" };
  if (run["agentId"] !== pointer.agentId) return { action: "preserve", reason: "blocking run owner changed" };
  if (!TERMINAL_RUN_STATUSES.has(String(run["status"] ?? "")) || !nonEmptyString(run["finishedAt"])) {
    return { action: "preserve", reason: "blocking run is not terminal" };
  }
  if (run["errorCode"] !== "jules_polling_error") {
    return { action: "preserve", reason: "blocking run did not fail in Jules polling" };
  }
  return {
    action: "resolve_to_todo",
    actionId: pointer.actionId,
    runId: pointer.runId,
    providerSessionId: pointer.providerSessionId,
    reason: "terminal Jules polling run left a durable provider continuation behind a legacy execution hold",
  };
}

export function buildJulesExecutionReconciliationPayload(
  decision: Extract<JulesExecutionBlockerRecovery, { action: "resolve_to_todo" }>,
): Record<string, unknown> {
  return {
    actionId: decision.actionId,
    outcome: "restored",
    sourceIssueStatus: "todo",
    resolutionNote: `Jules polling run ${decision.runId} stopped locally; return the durable provider continuation to its adapter.`,
    executionReconciliation: {
      runId: decision.runId,
      providerStopped: true,
      actionOutcome: "mixed",
      outcomeEvidence: `Jules polling run ${decision.runId} is terminal and durable session ${decision.providerSessionId} remains recorded. Remote action outcomes are intentionally treated as mixed; the Jules adapter must inspect that session before continuing.`,
    },
  };
}
