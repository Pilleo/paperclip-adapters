import { z } from "zod";

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
}

const RawInteractionSchema = z.object({
  id: z.string().min(1),
  kind: z.string().optional(),
  status: z.string().optional(),
  addresseeAgentId: z.string().optional(),
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
  | { readonly kind: "unrecognized"; readonly reason: string };

function key(identity: PlanReviewIdentity, version: "v1" | "v2", recoveryAttempt?: number): string {
  const base = `jules:plan-review:${version}:${identity.issueId}:${identity.sessionId}:${identity.revisionId}:${identity.stage}`;
  return recoveryAttempt && recoveryAttempt > 0 ? `${base}:recovery:${recoveryAttempt}` : base;
}

function hasKey(rawKey: string | undefined, identity: PlanReviewIdentity, version: "v1" | "v2"): boolean {
  if (!rawKey) return false;
  const base = key(identity, version);
  return rawKey === base || new RegExp(`^${escapeRegExp(base)}:recovery:[1-9][0-9]*$`).test(rawKey);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

export function planReviewIdempotencyKey(identity: PlanReviewIdentity, version: "v1" | "v2" = "v2", recoveryAttempt?: number): string {
  return key(identity, version, recoveryAttempt);
}
