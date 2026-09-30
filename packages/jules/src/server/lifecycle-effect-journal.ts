import { z } from "zod";

export const LifecycleEffectKindSchema = z.enum([
  "deliver_verdict",
  "send_provider_message",
  "create_card",
  "replace_plan_card",
  "recover_plan_dispatch",
  "approve_plan",
  "request_plan_revision",
  "rearm_monitor",
  "legacy_unknown",
]);
export type LifecycleEffectKind = z.infer<typeof LifecycleEffectKindSchema>;

export type LifecycleEffectAttempt =
  | { readonly kind: "started"; readonly startedAt: string; readonly attempts: number }
  | { readonly kind: "confirmed"; readonly receipt: string };

export interface LifecycleEffectEntry {
  readonly effectId: string;
  readonly kind: LifecycleEffectKind;
  readonly attempt: LifecycleEffectAttempt;
}

export interface LifecycleEffectJournal {
  readonly version: 1;
  readonly effects: readonly LifecycleEffectEntry[];
}

export const LifecycleEffectJournalSchema = z.object({
  version: z.literal(1),
  effects: z.array(z.object({
    effectId: z.string().min(1),
    kind: LifecycleEffectKindSchema,
    attempt: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("started"),
        startedAt: z.string().datetime(),
        // Sessions persisted before retry tracking have one already-issued
        // attempt; decode them rather than treating them as a new mutation.
        attempts: z.number().int().positive().max(2).optional().transform((value) => value ?? 1),
      }),
      z.object({ kind: z.literal("confirmed"), receipt: z.string().min(1) }),
    ]),
  })).max(50),
});

/** A runtime envelope may lag the disk checkpoint; confirmed effects never regress to started. */
export function mergeEffectJournals(
  replayed: LifecycleEffectJournal | undefined,
  recovered: LifecycleEffectJournal | undefined,
): LifecycleEffectJournal | undefined {
  if (!replayed) return recovered;
  if (!recovered) return replayed;
  const effects = [...replayed.effects];
  for (const durable of recovered.effects) {
    const index = effects.findIndex((entry) => entry.effectId === durable.effectId);
    if (index < 0) { effects.push(durable); continue; }
    const current = effects[index]!;
    if (current.kind !== durable.kind ||
        (current.attempt.kind === "confirmed" && durable.attempt.kind === "confirmed" &&
          current.attempt.receipt !== durable.attempt.receipt)) {
      throw new Error(`Lifecycle effect journal conflict for ${durable.effectId}`);
    }
    if (durable.attempt.kind === "confirmed" || current.attempt.kind === "confirmed") {
      effects[index] = durable.attempt.kind === "confirmed" ? durable : current;
      continue;
    }
    effects[index] = (durable.attempt.attempts ?? 1) >= (current.attempt.attempts ?? 1) ? durable : current;
  }
  if (effects.length > 50) throw new Error("Lifecycle effect journal exceeds its durable limit");
  return { version: 1, effects };
}

export type InterruptedEffectDisposition =
  | { readonly action: "execute" }
  | { readonly action: "reconcile" }
  | { readonly action: "observe" };

/** Persist this result before an external mutation. Repeating a begun effect is idempotent. */
export function beginEffect(
  journal: LifecycleEffectJournal,
  input: { readonly effectId: string; readonly kind: LifecycleEffectKind; readonly startedAt: string },
): LifecycleEffectJournal {
  const existing = journal.effects.find((effect) => effect.effectId === input.effectId);
  if (existing) return journal;
  return {
    version: 1,
    effects: [...journal.effects, {
      effectId: input.effectId,
      kind: input.kind,
      attempt: { kind: "started", startedAt: input.startedAt, attempts: 1 },
    }],
  };
}

/**
 * Records the only permitted replay: a read-after-write reconciliation has
 * authoritatively proved the native operation absent. Native effects have at
 * most two total attempts so a broken remote cannot cause session churn.
 */
export function retryStartedEffect(
  journal: LifecycleEffectJournal,
  effectId: string,
  startedAt: string,
): LifecycleEffectJournal {
  let found = false;
  const effects = journal.effects.map((effect): LifecycleEffectEntry => {
    if (effect.effectId !== effectId) return effect;
    found = true;
    if (effect.kind !== "create_card") {
      throw new Error(`Lifecycle effect ${effectId} (${effect.kind}) is not replayable through native-card retry`);
    }
    if (effect.attempt.kind !== "started") {
      throw new Error(`Cannot retry confirmed lifecycle effect ${effectId}`);
    }
    const attempts = effect.attempt.attempts ?? 1;
    if (attempts >= 2) {
      throw new Error(`Native-plan retry limit reached for ${effectId}`);
    }
    return {
      ...effect,
      attempt: { kind: "started", startedAt, attempts: attempts + 1 },
    };
  });
  if (!found) throw new Error(`Cannot retry unknown lifecycle effect ${effectId}`);
  return { version: 1, effects };
}

/** A receipt is the only evidence that allows a restart to skip reconciliation. */
export function confirmEffect(
  journal: LifecycleEffectJournal,
  effectId: string,
  receipt: string,
): LifecycleEffectJournal {
  let found = false;
  const effects = journal.effects.map((effect): LifecycleEffectEntry => {
    if (effect.effectId !== effectId) return effect;
    found = true;
    return { ...effect, attempt: { kind: "confirmed", receipt } };
  });
  if (!found) throw new Error(`Cannot confirm unknown lifecycle effect ${effectId}`);
  return { version: 1, effects };
}

/** Classifies restart behavior from durable mutation evidence, never process exit state. */
export function classifyInterruptedEffect(
  journal: LifecycleEffectJournal,
  effectId: string,
): InterruptedEffectDisposition {
  const effect = journal.effects.find((entry) => entry.effectId === effectId);
  if (!effect) return { action: "execute" };
  switch (effect.attempt.kind) {
    case "started":
      return { action: "reconcile" };
    case "confirmed":
      return { action: "observe" };
    default: {
      const exhaustive: never = effect.attempt;
      return exhaustive;
    }
  }
}
