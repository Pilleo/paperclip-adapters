import type { PaperclipInteraction } from "./paperclip-client.js";

export type JulesLifecycleSnapshot =
  | {
    readonly kind: "valid";
    readonly cardId: string;
    readonly revisionId: string;
    readonly reviewer: "luna" | "terra";
    readonly providerActivityId: string;
  }
  | {
    readonly kind: "legacy_unique";
    readonly cardId: string;
    readonly revisionId: string;
    readonly reviewer: "luna" | "terra";
    readonly providerActivityId: string;
  }
  | { readonly kind: "inconsistent"; readonly reason: string };

export interface RawLifecycleEvidence {
  readonly issueId: string;
  readonly sessionId: string;
  readonly latestPlanActivityIds: readonly string[];
  readonly interactions: readonly PaperclipInteraction[];
  readonly reviewerRunIds: readonly string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function reviewerFromCard(input: RawLifecycleEvidence, interaction: PaperclipInteraction): "luna" | "terra" | null {
  const key = interaction.idempotencyKey;
  const prefix = `jules:plan-review:v2:${input.issueId}:${input.sessionId}:`;
  if (!key?.startsWith(prefix)) return null;
  const reviewer = key.split(":").at(6);
  if (reviewer !== "luna" && reviewer !== "terra") return null;
  return reviewer;
}

function revisionFromCard(input: RawLifecycleEvidence, interaction: PaperclipInteraction): string | null {
  const payload = record(interaction.payload);
  const target = record(payload?.["target"]);
  if (target?.["type"] !== "issue_document" || target["issueId"] !== input.issueId || target["key"] !== "plan") return null;
  return typeof target["revisionId"] === "string" ? target["revisionId"] : null;
}

function providerActivityFromCard(interaction: PaperclipInteraction): string | null {
  const payload = record(interaction.payload);
  return typeof payload?.["providerActivityId"] === "string" ? payload["providerActivityId"] : null;
}

function resolverIsAttested(input: RawLifecycleEvidence, interaction: PaperclipInteraction): boolean {
  if (interaction.resolvedByAgentId && interaction.resolvedByAgentId === interaction.addresseeAgentId) return true;
  return interaction.resolvedByUserId === "local-board" &&
    typeof interaction.resolvedByRunId === "string" &&
    input.reviewerRunIds.includes(interaction.resolvedByRunId);
}

/**
 * Converts raw Paperclip interaction transport data into the one bounded
 * identity used by Jules recovery. It deliberately refuses heuristic text
 * matching: a legacy card is recoverable only when its provider activity is
 * unique in the observed plan history.
 */
export function buildJulesLifecycleSnapshot(input: RawLifecycleEvidence): JulesLifecycleSnapshot {
  const cards = input.interactions.filter((interaction) => interaction.status === "answered" && resolverIsAttested(input, interaction));
  if (cards.length !== 1) {
    return { kind: "inconsistent", reason: cards.length === 0 ? "no attested answered plan card" : "multiple attested answered plan cards" };
  }
  const card = cards[0]!;
  const reviewer = reviewerFromCard(input, card);
  const revisionId = revisionFromCard(input, card);
  if (!reviewer || !revisionId) return { kind: "inconsistent", reason: "answered card lacks exact Jules plan identity" };
  const providerActivityId = providerActivityFromCard(card);
  if (providerActivityId) {
    if (!input.latestPlanActivityIds.includes(providerActivityId)) {
      return { kind: "inconsistent", reason: "card provider activity is absent from observed plan history" };
    }
    return { kind: "valid", cardId: card.id, revisionId, reviewer, providerActivityId };
  }
  if (input.latestPlanActivityIds.length !== 1) {
    return { kind: "inconsistent", reason: "legacy card has ambiguous provider activity identity" };
  }
  return { kind: "legacy_unique", cardId: card.id, revisionId, reviewer, providerActivityId: input.latestPlanActivityIds[0]! };
}
