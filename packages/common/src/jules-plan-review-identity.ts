import { createHash } from "node:crypto";

/** The sole durable identity for a parent-owned native Jules plan card. */
export type JulesPlanReviewGeneration = 0 | 1;

export interface JulesPlanReviewIdentity {
  readonly issueId: string;
  readonly sessionId: string;
  readonly revisionId: string;
  readonly stage: "luna" | "terra";
  readonly generation: JulesPlanReviewGeneration;
}

export type ProjectedEffectAttempt =
  | { readonly kind: "not_started" }
  | { readonly kind: "started"; readonly effectId: string; readonly startedAt: string }
  | { readonly kind: "confirmed"; readonly effectId: string; readonly receipt: string };

interface DurableEffectEntry {
  readonly effectId: string;
  readonly attempt:
    | { readonly kind: "started"; readonly startedAt: string }
    | { readonly kind: "confirmed"; readonly receipt: string };
}

const PRIMARY_KEY = /^jules:plan-review:v2:([^:]+):([^:]+):([^:]+):(luna|terra)$/;
const RECOVERY_KEY = /^jules:plan-review:v2:([^:]+):([^:]+):([^:]+):(luna|terra):recovery:1$/;

export function planReviewIdempotencyKey(identity: JulesPlanReviewIdentity): string {
  const base = `jules:plan-review:v2:${identity.issueId}:${identity.sessionId}:${identity.revisionId}:${identity.stage}`;
  switch (identity.generation) {
    case 0:
      return base;
    case 1:
      return `${base}:recovery:1`;
    default: {
      const exhaustive: never = identity.generation;
      return exhaustive;
    }
  }
}

export function parsePlanReviewIdempotencyKey(value: string): JulesPlanReviewIdentity | null {
  const match = PRIMARY_KEY.exec(value) ?? RECOVERY_KEY.exec(value);
  if (!match) return null;
  const [, issueId, sessionId, revisionId, stage] = match;
  if (!issueId || !sessionId || !revisionId || (stage !== "luna" && stage !== "terra")) return null;
  return {
    issueId,
    sessionId,
    revisionId,
    stage,
    generation: value.endsWith(":recovery:1") ? 1 : 0,
  };
}

/** One stable, UUID-shaped review stage per immutable Jules plan turn. */
export function nativePlanReviewStageId(issueId: string, revisionId: string, reviewer: "luna" | "terra"): string {
  const digest = createHash("sha256").update(`jules:plan-review-stage:v1:${issueId}:${revisionId}:${reviewer}`).digest();
  const stageBytes = digest.subarray(0, 16);
  const view = new DataView(stageBytes.buffer, stageBytes.byteOffset, stageBytes.length);
  view.setUint8(6, (view.getUint8(6) & 0x0f) | 0x40);
  view.setUint8(8, (view.getUint8(8) & 0x3f) | 0x80);
  const hex = stageBytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Projects persisted evidence without allowing callers to erase a started effect. */
export function projectEffectAttempt(
  effectId: string,
  entry: DurableEffectEntry | undefined,
): ProjectedEffectAttempt {
  if (!entry || entry.effectId !== effectId) return { kind: "not_started" };
  switch (entry.attempt.kind) {
    case "started":
      return { kind: "started", effectId, startedAt: entry.attempt.startedAt };
    case "confirmed":
      return { kind: "confirmed", effectId, receipt: entry.attempt.receipt };
    default: {
      const exhaustive: never = entry.attempt;
      return exhaustive;
    }
  }
}
