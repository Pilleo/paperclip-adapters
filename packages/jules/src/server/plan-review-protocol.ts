import { z } from "zod";
import {
  parsePlanReviewIdempotencyKey,
  planReviewIdempotencyKey as nativePlanReviewIdempotencyKey,
} from "@pilleo/paperclip-adapter-common";

export const PlanReviewStageSchema = z.enum(["luna", "terra"]);
export type PlanReviewStage = z.infer<typeof PlanReviewStageSchema>;

export interface PlanReviewIdentity {
  readonly issueId: string;
  readonly sessionId: string;
  readonly documentId: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly stage: PlanReviewStage;
  readonly reviewerAgentId: string;
  /** Generation zero is the original card; one is the only infrastructure recovery card. */
  readonly generation?: 0 | 1;
}

const RawInteractionSchema = z.object({
  id: z.string().min(1),
  kind: z.string().optional(),
  status: z.string().optional(),
  addresseeAgentId: z.string().optional(),
  resolvedByAgentId: z.string().optional().nullable(),
  idempotencyKey: z.string().optional(),
  payload: z.unknown().optional(),
  result: z.unknown().optional(),
}).passthrough();

const PlanTargetSchema = z.object({
  type: z.literal("issue_document"),
  issueId: z.string().min(1),
  documentId: z.string().min(1),
  key: z.literal("plan"),
  revisionId: z.string().min(1),
  revisionNumber: z.number().int().positive(),
});

const VerdictResultSchema = z.object({
  outcome: z.literal("resolved"),
  complete: z.literal(true),
  items: z.array(z.object({
    id: z.literal("plan"),
    verdict: z.enum(["approve", "reject"]),
    reason: z.string().optional(),
  })).length(1),
});

export function parsePlanReviewVerdictResult(value: unknown): { kind: "approve" | "reject"; reason?: string } | null {
  const result = VerdictResultSchema.safeParse(value);
  if (!result.success) return null;
  const verdict = result.data.items[0];
  if (!verdict) return null;
  if (verdict.verdict === "reject" && (!verdict.reason || !verdict.reason.trim())) return null;
  return { kind: verdict.verdict, ...(verdict.reason ? { reason: verdict.reason.trim() } : {}) };
}

export type PlanReviewObservation =
  | {
      readonly kind: "v2";
      readonly state: "pending" | "answered";
      readonly interactionId: string;
      readonly identity: PlanReviewIdentity;
      readonly decision?: { readonly kind: "approve" | "reject"; readonly reason?: string };
    }
  | {
      readonly kind: "legacy";
      readonly state: "pending" | "accepted" | "rejected";
      readonly interactionId: string;
      readonly identity: PlanReviewIdentity;
      readonly reason?: string;
    }
  | {
      /** A terminal card was resolved by a human override rather than its addressed reviewer. */
      readonly kind: "untrusted";
      readonly reason: "v2 answered card was not resolved by the addressed reviewer";
      readonly interactionId: string;
      readonly identity: PlanReviewIdentity;
    }
  | { readonly kind: "unrecognized"; readonly reason: string };

function key(identity: PlanReviewIdentity, version: "v1" | "v2"): string {
  return `jules:plan-review:${version}:${identity.issueId}:${identity.sessionId}:${identity.revisionId}:${identity.stage}`;
}

function hasKey(rawKey: string | undefined, identity: PlanReviewIdentity, version: "v1" | "v2"): boolean {
  if (!rawKey) return false;
  switch (version) {
    case "v1":
      return rawKey === key(identity, version);
    case "v2": {
      const parsed = parsePlanReviewIdempotencyKey(rawKey);
      return parsed !== null &&
        parsed.issueId === identity.issueId &&
        parsed.sessionId === identity.sessionId &&
        parsed.revisionId === identity.revisionId &&
        parsed.stage === identity.stage;
    }
    default: {
      const exhaustive: never = version;
      return exhaustive;
    }
  }
}

function sameTarget(target: unknown, identity: PlanReviewIdentity): boolean {
  const parsed = PlanTargetSchema.safeParse(target);
  return parsed.success && parsed.data.issueId === identity.issueId &&
    parsed.data.documentId === identity.documentId && parsed.data.revisionId === identity.revisionId &&
    parsed.data.revisionNumber === identity.revisionNumber;
}

function parseLegacy(raw: z.infer<typeof RawInteractionSchema>, identity: PlanReviewIdentity): PlanReviewObservation | null {
  if (raw.kind !== "request_confirmation" || !hasKey(raw.idempotencyKey, identity, "v1")) return null;
  if (raw.status !== "pending" && raw.status !== "accepted" && raw.status !== "rejected") return null;
  if (raw.status === "pending") return { kind: "legacy", state: "pending", interactionId: raw.id, identity };
  const result = raw.result && typeof raw.result === "object" ? raw.result as { reason?: unknown } : null;
  const reason = typeof result?.reason === "string" && result.reason.trim() ? result.reason.trim() : undefined;
  return raw.status === "rejected" && !reason
    ? { kind: "unrecognized", reason: "legacy rejection has no reason" }
    : { kind: "legacy", state: raw.status, interactionId: raw.id, identity, ...(reason ? { reason } : {}) };
}

export function parsePlanReviewInteraction(rawValue: unknown, identity: PlanReviewIdentity): PlanReviewObservation {
  const raw = RawInteractionSchema.safeParse(rawValue);
  if (!raw.success) return { kind: "unrecognized", reason: "interaction shape is invalid" };
  const legacy = parseLegacy(raw.data, identity);
  if (legacy) return legacy;

  if (raw.data.kind !== "request_item_verdicts" || !hasKey(raw.data.idempotencyKey, identity, "v2") ||
      raw.data.addresseeAgentId !== identity.reviewerAgentId || !sameTarget(
        raw.data.payload && typeof raw.data.payload === "object" ? (raw.data.payload as { target?: unknown }).target : undefined,
        identity,
      )) {
    return { kind: "unrecognized", reason: "interaction is not the exact v2 plan card" };
  }

  const payload = raw.data.payload && typeof raw.data.payload === "object" ? raw.data.payload as { items?: unknown } : {};
  const items = z.array(z.object({ id: z.literal("plan") })).length(1).safeParse(payload.items);
  if (!items.success) return { kind: "unrecognized", reason: "v2 card does not declare exactly one plan item" };
  if (raw.data.status === "pending") return { kind: "v2", state: "pending", interactionId: raw.data.id, identity };
  if (raw.data.status !== "answered") return { kind: "unrecognized", reason: "v2 card is not pending or answered" };
  // Paperclip currently permits a human override for an addressed-agent card.
  // A plan-review ladder must not misrepresent that override as Luna/Terra's
  // decision: only the configured reviewer can advance or reject this gate.
  if (raw.data.resolvedByAgentId !== identity.reviewerAgentId) {
    return {
      kind: "untrusted",
      reason: "v2 answered card was not resolved by the addressed reviewer",
      interactionId: raw.data.id,
      identity,
    };
  }

  const verdict = parsePlanReviewVerdictResult(raw.data.result);
  if (!verdict) return { kind: "unrecognized", reason: "v2 result is not one complete plan verdict" };
  return {
    kind: "v2",
    state: "answered",
    interactionId: raw.data.id,
    identity,
    decision: { kind: verdict.kind, ...(verdict.reason ? { reason: verdict.reason } : {}) },
  };
}

export type PlanReviewReducerState = "legacy_pending" | "v2_pending" | "luna_approved" | "terra_approved" | "rejected" | "unrecognized";
export type PlanReviewEffect =
  | { readonly effect: "migrate_legacy" }
  | { readonly effect: "await"; readonly reason: string }
  | { readonly effect: "create_terra" }
  | { readonly effect: "approve_jules" }
  | { readonly effect: "request_revision" };

export function reducePlanReview(input: { readonly identity: PlanReviewIdentity; readonly state: PlanReviewReducerState }): PlanReviewEffect {
  switch (input.state) {
    case "legacy_pending": return { effect: "migrate_legacy" };
    case "v2_pending": return { effect: "await", reason: "pending_verdict" };
    case "luna_approved": return { effect: "create_terra" };
    case "terra_approved": return { effect: "approve_jules" };
    case "rejected": return { effect: "request_revision" };
    case "unrecognized": return { effect: "await", reason: "unrecognized_card" };
    default: return assertNever(input.state);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled plan-review state: ${String(value)}`);
}

export function planReviewIdempotencyKey(identity: PlanReviewIdentity, version: "v1" | "v2" = "v2"): string {
  switch (version) {
    case "v1":
      return key(identity, version);
    case "v2":
      return nativePlanReviewIdempotencyKey({
        issueId: identity.issueId,
        sessionId: identity.sessionId,
        revisionId: identity.revisionId,
        stage: identity.stage,
        generation: identity.generation ?? 0,
      });
    default: {
      const exhaustive: never = version;
      return exhaustive;
    }
  }
}
