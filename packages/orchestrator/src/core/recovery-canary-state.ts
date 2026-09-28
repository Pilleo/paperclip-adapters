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
}

export interface RecoveryCanaryState {
  readonly parent: { readonly status: unknown; readonly assigneeAgentId: unknown };
  readonly children: readonly { readonly id: string; readonly status: unknown; readonly parentId: unknown }[];
  readonly pendingCards: readonly { readonly id: string; readonly idempotencyKey: unknown; readonly addresseeAgentId: unknown }[];
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

/** The old parent card is an authority lock; it never proves an approval or grants a second wake. */
export function classifyRecoveryCanaryParentHold(input: {
  readonly issue: Readonly<Record<string, unknown>>;
  readonly prUrl: string;
  readonly headSha: string;
  readonly reviewerAgentId: string;
  readonly cards: readonly Readonly<Record<string, unknown>>[];
  readonly reviewerRuns: readonly Readonly<Record<string, unknown>>[];
  readonly children: readonly Readonly<Record<string, unknown>>[];
}): { readonly kind: "board_disposition_required"; readonly parentCardId: string; readonly stalePlanCardId: string }
  | { readonly kind: "not_qualified" } {
  const issueId = input.issue["id"];
  const products = input.issue["workProducts"];
  const matchingProducts = Array.isArray(products) ? products.filter((product) => isRecord(product) &&
    product["type"] === "pull_request" && product["isPrimary"] === true &&
    product["status"] === "ready_for_review" && product["url"] === input.prUrl &&
    isRecord(product["metadata"]) && product["metadata"]["source"] === "jules" &&
    product["metadata"]["headSha"] === input.headSha) : [];
  if (typeof issueId !== "string" || input.issue["status"] !== "in_review" || input.issue["assigneeAgentId"] !== null ||
      !/^[a-f0-9]{40}$/i.test(input.headSha) || matchingProducts.length !== 1 ||
      input.children.some((child) => child["status"] !== "done") ||
      input.reviewerRuns.some((run) => run["issueId"] === issueId && run["agentId"] === input.reviewerAgentId)) {
    return { kind: "not_qualified" };
  }
  const pending = input.cards.filter((card) => card["status"] === "pending" && card["kind"] === "request_item_verdicts");
  const parents = pending.filter((card) => card["createdByAgentId"] === null &&
    card["addresseeAgentId"] === input.reviewerAgentId &&
    typeof card["idempotencyKey"] === "string" && card["idempotencyKey"].startsWith("pr-review:v") &&
    card["idempotencyKey"].includes(`:${issueId}:${input.prUrl}:${input.headSha}:`));
  const plans = pending.filter((card) => typeof card["idempotencyKey"] === "string" &&
    card["idempotencyKey"].startsWith(`jules:plan-review:v2:${issueId}:`));
  if (pending.length !== 2 || parents.length !== 1 || plans.length !== 1 ||
      typeof parents[0]?.["id"] !== "string" || typeof plans[0]?.["id"] !== "string") {
    return { kind: "not_qualified" };
  }
  return { kind: "board_disposition_required", parentCardId: parents[0]["id"], stalePlanCardId: plans[0]["id"] };
}
