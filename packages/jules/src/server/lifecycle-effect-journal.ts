import { z } from "zod";

export const LifecycleEffectKindSchema = z.enum(["deliver_verdict", "send_provider_message", "approve_plan", "rearm_monitor", "legacy_unknown"]);
export type LifecycleEffectKind = z.infer<typeof LifecycleEffectKindSchema>;

export type LifecycleEffectAttempt =
  | { readonly kind: "started"; readonly startedAt: string }
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
      z.object({ kind: z.literal("started"), startedAt: z.string().datetime() }),
      z.object({ kind: z.literal("confirmed"), receipt: z.string().min(1) }),
    ]),
  })).max(50),
});

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
      attempt: { kind: "started", startedAt: input.startedAt },
    }],
  };
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
