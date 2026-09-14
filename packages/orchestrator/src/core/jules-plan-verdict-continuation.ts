/**
 * Typed bridge for an answered Jules plan-review child back to its parent.
 *
 * Paperclip's built-in `wake_assignee` continuation wakes the child assignee
 * (the reviewer), not the Jules assignee of the parent.  Until Paperclip
 * provides a typed parent-continuation policy, the orchestrator may repair
 * that gap only from this versioned form identity.  It never reads reviewer
 * prose, comments, or a provider transcript.
 */

export interface NativeInteractionSnapshot {
  readonly id?: unknown;
  readonly kind?: unknown;
  readonly status?: unknown;
  readonly idempotencyKey?: unknown;
  readonly payload?: unknown;
}

export interface ResolvedJulesPlanVerdict {
  readonly interactionId: string;
  readonly sessionId: string;
  readonly revisionId: string;
}

const PLAN_VERDICT_KEY = /^jules:plan-review:v2:([^:]+):([^:]+):([^:]+):(luna|terra)(?::recovery:\d+)?$/;

function targetMatches(
  payload: unknown,
  parentId: string,
  revisionId: string,
): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const target = (payload as Record<string, unknown>)["target"];
  if (!target || typeof target !== "object" || Array.isArray(target)) return false;
  const record = target as Record<string, unknown>;
  return record["type"] === "issue_document" &&
    record["issueId"] === parentId &&
    record["key"] === "plan" &&
    record["revisionId"] === revisionId;
}

/**
 * Returns the exact resolved native form which is allowed to resume its
 * parent. Every identity component is duplicated between the key and form
 * target, so a copied card, stale revision, or ordinary comment fails closed.
 */
export function resolvedJulesPlanVerdict(input: {
  readonly parentId: string;
  readonly parentSessionId: string;
  readonly interactions: readonly NativeInteractionSnapshot[];
}): ResolvedJulesPlanVerdict | null {
  for (const interaction of input.interactions) {
    if (typeof interaction.id !== "string" || interaction.kind !== "request_item_verdicts" || interaction.status !== "answered") continue;
    if (typeof interaction.idempotencyKey !== "string") continue;
    const key = interaction.idempotencyKey.match(PLAN_VERDICT_KEY);
    if (!key) continue;
    const keyParentId = key[1];
    const sessionId = key[2];
    const revisionId = key[3];
    if (!keyParentId || !sessionId || !revisionId) continue;
    if (keyParentId !== input.parentId || sessionId !== input.parentSessionId || !targetMatches(interaction.payload, input.parentId, revisionId)) continue;
    return { interactionId: interaction.id, sessionId, revisionId };
  }
  return null;
}
