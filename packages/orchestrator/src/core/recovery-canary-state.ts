/**
 * Stable E2E assertion boundary for the Jules PR recovery canary.
 * Paperclip updates activity timestamps, status versions, and derived
 * projections on every heartbeat; those are not adapter effects. This
 * projection retains only the durable review contract the adapter owns.
 */
export interface RecoveryCanaryInput {
  readonly issue: Readonly<Record<string, unknown>>;
  readonly children: readonly Readonly<Record<string, unknown>>[];
  readonly interactions: readonly Readonly<Record<string, unknown>>[];
  readonly workProducts: readonly Readonly<Record<string, unknown>>[];
  readonly approvals: readonly Readonly<Record<string, unknown>>[];
  readonly heartbeatRuns: readonly Readonly<Record<string, unknown>>[];
}

export interface RecoveryCanaryState {
  readonly parent: { readonly status: unknown; readonly assigneeAgentId: unknown };
  readonly children: readonly { readonly id: string; readonly status: unknown; readonly parentId: unknown }[];
  readonly pendingCards: readonly { readonly id: string; readonly idempotencyKey: unknown; readonly addresseeAgentId: unknown }[];
  readonly workProducts: readonly { readonly id: string; readonly status: unknown; readonly externalId: unknown }[];
  readonly approvals: readonly { readonly id: string; readonly status: unknown }[];
  readonly heartbeatRuns: readonly { readonly id: string; readonly status: unknown }[];
}

/**
 * The recovery canary mutates a disposable company, so a failed test and a
 * failed cleanup are independently actionable. Preserve both causes instead
 * of letting the `finally` block hide one behind a log line.
 */
export function combineRecoveryCanaryFailure(
  operationError: unknown,
  cleanupError: unknown,
  companyId: string,
): Error {
  const cleanupMessage = `Canary cleanup failed; disposable company ${companyId} may remain: ${
    cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
  }`;
  if (operationError !== undefined) {
    return new AggregateError(
      [operationError, cleanupError],
      `Canary operation and cleanup failed; disposable company ${companyId} may remain`,
    );
  }
  return new Error(cleanupMessage);
}

export interface OwnedRecoveryCanaryCleanupInput {
  readonly ownsServerState: boolean;
  readonly apiUrl: string;
  readonly dataDirectory: string | undefined;
}

/**
 * A Paperclip 2026.831.1 server cannot delete a company after this canary has
 * produced heartbeat-run events: its company-delete route violates the
 * heartbeat_run_events foreign key. Do not mask that server defect with a
 * retry. CI instead owns the entire loopback server data directory and removes
 * it only after the server process has stopped. This narrow predicate keeps
 * the normal, externally-hosted-server cleanup path fail-closed.
 *
 * Remove the owned-state path after Paperclip deletes heartbeat_run_events (or
 * cascades them) before deleting heartbeat_runs.
 */
export function shouldUseOwnedRecoveryCanaryCleanup(input: OwnedRecoveryCanaryCleanupInput): boolean {
  if (!input.ownsServerState || !input.dataDirectory || !input.dataDirectory.startsWith("/")) return false;
  try {
    const hostname = new URL(input.apiUrl).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function projectRecoveryCanaryState(input: RecoveryCanaryInput): RecoveryCanaryState {
  const children = input.children
    .filter(isRecord)
    .flatMap((child) => typeof child["id"] === "string"
      ? [{ id: child["id"], status: child["status"], parentId: child["parentId"] }]
      : [])
    .sort((left, right) => left.id.localeCompare(right.id));
  const pendingCards = input.interactions
    .filter(isRecord)
    .filter((interaction) => interaction["kind"] === "request_item_verdicts" && interaction["status"] === "pending")
    .flatMap((interaction) => typeof interaction["id"] === "string"
      ? [{ id: interaction["id"], idempotencyKey: interaction["idempotencyKey"], addresseeAgentId: interaction["addresseeAgentId"] }]
      : [])
    .sort((left, right) => left.id.localeCompare(right.id));
  const workProducts = (input.workProducts || [])
    .filter(isRecord)
    .flatMap((wp) => typeof wp["id"] === "string"
      ? [{ id: wp["id"], status: wp["status"], externalId: wp["externalId"] }]
      : [])
    .sort((left, right) => left.id.localeCompare(right.id));
  const approvals = (input.approvals || [])
    .filter(isRecord)
    .flatMap((approval) => typeof approval["id"] === "string"
      ? [{ id: approval["id"], status: approval["status"] }]
      : [])
    .sort((left, right) => left.id.localeCompare(right.id));
  const heartbeatRuns = (input.heartbeatRuns || [])
    .filter(isRecord)
    .flatMap((run) => typeof run["id"] === "string"
      ? [{ id: run["id"], status: run["status"] }]
      : [])
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    parent: { status: input.issue["status"], assigneeAgentId: input.issue["assigneeAgentId"] },
    children,
    pendingCards,
    workProducts,
    approvals,
    heartbeatRuns,
  };
}
