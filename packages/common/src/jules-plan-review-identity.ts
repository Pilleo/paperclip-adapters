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
