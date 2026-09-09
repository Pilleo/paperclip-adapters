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
  return {
    parent: { status: input.issue["status"], assigneeAgentId: input.issue["assigneeAgentId"] },
    children,
    pendingCards,
  };
}
