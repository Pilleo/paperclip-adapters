/**
 * Typed bridge for an answered Jules plan-review child back to its parent.
 *
 * Paperclip's built-in `wake_assignee` continuation wakes the child assignee
 * (the reviewer), not the Jules assignee of the parent.  Until Paperclip
 * provides a typed parent-continuation policy, the orchestrator may repair
 * that gap only from this versioned form identity.  It never reads reviewer
 * prose, comments, or a provider transcript.
 */

import { parsePlanReviewIdempotencyKey } from "@pilleo/paperclip-adapter-common";

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
  readonly currentRevisionId: string;
  readonly interactions: readonly NativeInteractionSnapshot[];
}): ResolvedJulesPlanVerdict | null {
  for (const interaction of input.interactions) {
    if (typeof interaction.id !== "string" || interaction.kind !== "request_item_verdicts" || interaction.status !== "answered") continue;
    if (typeof interaction.idempotencyKey !== "string") continue;
    const identity = parsePlanReviewIdempotencyKey(interaction.idempotencyKey);
    if (!identity) continue;
    if (identity.issueId !== input.parentId ||
        identity.sessionId !== input.parentSessionId ||
        identity.revisionId !== input.currentRevisionId ||
        !targetMatches(interaction.payload, input.parentId, identity.revisionId)) continue;
    return {
      interactionId: interaction.id,
      sessionId: identity.sessionId,
      revisionId: identity.revisionId,
    };
  }
  return null;
}
