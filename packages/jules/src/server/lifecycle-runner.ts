import {
  reduceJulesLifecycle,
  type JulesLifecycleDecision,
  type JulesLifecycleEvent,
  type JulesLifecycleState,
} from "@pilleo/paperclip-adapter-common";
import {
  beginEffect,
  confirmEffect,
  retryStartedEffect,
  type LifecycleEffectJournal,
  type LifecycleEffectKind,
} from "./lifecycle-effect-journal.js";
import type {
  NativePlanEffect,
  NativePlanEffectReconciliation,
} from "./native-plan-effect-reconciler.js";

export interface LifecycleRunnerDependencies {
  readonly persistJournal: (journal: LifecycleEffectJournal) => Promise<void>;
  readonly createCard?: (input: { readonly reviewer: "luna" | "terra"; readonly revisionId: string }) => Promise<{ readonly receipt: string }>;
  readonly approvePlan?: (input: { readonly sessionId: string; readonly revisionId: string }) => Promise<{ readonly receipt: string }>;
  readonly requestPlanRevision?: (input: {
    readonly cardId: string;
    readonly revisionId: string;
    readonly reviewer: "luna" | "terra";
    readonly runId: string;
  }) => Promise<{ readonly receipt: string }>;
  readonly reconcileNativePlanEffect?: (input: {
    readonly effect: NativePlanEffect;
    readonly effectId: string;
  }) => Promise<NativePlanEffectReconciliation>;
}

export interface RunJulesLifecycleInput {
  readonly state: JulesLifecycleState;
  readonly event: JulesLifecycleEvent;
  readonly journal: LifecycleEffectJournal;
  readonly now: string;
  readonly dependencies: LifecycleRunnerDependencies;
}

export interface RunJulesLifecycleResult extends JulesLifecycleDecision {
  readonly journal: LifecycleEffectJournal;
  /** `deferred` effects remain the existing poll/reconciliation owner's responsibility during migration. */
  readonly disposition: "executed" | "deferred";
}

function required<T>(value: T | undefined, effect: NativePlanEffect["kind"]): T {
  if (value) return value;
  throw new Error(`Missing typed native-plan dependency for ${effect}`);
}

function journalIdentity(effect: NativePlanEffect): { readonly effectId: string; readonly kind: LifecycleEffectKind } {
  switch (effect.kind) {
    case "create_card":
      return { effectId: `card:${effect.reviewer}:${effect.revisionId}`, kind: "create_card" };
    case "approve_plan":
      return { effectId: `approve:${effect.sessionId}:${effect.revisionId}`, kind: "approve_plan" };
    case "request_plan_revision":
      return { effectId: `revision:${effect.cardId}:${effect.runId}`, kind: "request_plan_revision" };
    default: {
      const exhaustive: never = effect;
      return exhaustive;
    }
  }
}

async function executeJournaledNativePlanEffect(
  effect: NativePlanEffect,
  journal: LifecycleEffectJournal,
  now: string,
  dependencies: LifecycleRunnerDependencies,
): Promise<LifecycleEffectJournal> {
  const identity = journalIdentity(effect);
  const existing = journal.effects.find((entry) => entry.effectId === identity.effectId);
  if (existing) {
    switch (existing.attempt.kind) {
      case "confirmed":
        return journal;
      case "started":
        throw new Error(`Native-plan effect ${identity.effectId} requires remote reconciliation before retry`);
      default: {
        const exhaustive: never = existing.attempt;
        return exhaustive;
      }
    }
  }

  const started = beginEffect(journal, { ...identity, startedAt: now });
  await dependencies.persistJournal(started);
  const receipt = await performNativePlanEffect(effect, dependencies);
  const confirmed = confirmEffect(started, identity.effectId, receipt);
  await dependencies.persistJournal(confirmed);
  return confirmed;
}

async function performNativePlanEffect(
  effect: NativePlanEffect,
  dependencies: LifecycleRunnerDependencies,
): Promise<string> {
  switch (effect.kind) {
    case "create_card":
      return (await required(dependencies.createCard, effect.kind)({
        reviewer: effect.reviewer,
        revisionId: effect.revisionId,
      })).receipt;
    case "approve_plan":
      return (await required(dependencies.approvePlan, effect.kind)({
        sessionId: effect.sessionId,
        revisionId: effect.revisionId,
      })).receipt;
    case "request_plan_revision":
      return (await required(dependencies.requestPlanRevision, effect.kind)({
        cardId: effect.cardId,
        revisionId: effect.revisionId,
        reviewer: effect.reviewer,
        runId: effect.runId,
      })).receipt;
    default: {
      const exhaustive: never = effect;
      return exhaustive;
    }
  }
}

function isNativePlanEffect(effect: JulesLifecycleDecision["effect"]): effect is NativePlanEffect {
  switch (effect.kind) {
    case "create_card":
    case "approve_plan":
    case "request_plan_revision":
      return true;
    case "poll_provider":
    case "rearm_monitor":
    case "reconcile_effect":
    case "preserve":
    case "complete_issue":
    case "report_invariant_violation":
      return false;
    default: {
      const exhaustive: never = effect;
      return exhaustive;
    }
  }
}

function nativePlanEffectForReconciliation(
  state: JulesLifecycleState,
  effectId: string,
): NativePlanEffect | undefined {
  const retryState: JulesLifecycleState = { ...state, effect: { kind: "not_started" } };
  const retryDecision = reduceJulesLifecycle(retryState, { kind: "heartbeat" });
  if (isNativePlanEffect(retryDecision.effect) &&
      journalIdentity(retryDecision.effect).effectId === effectId) return retryDecision.effect;

  // Jules can transition to IN_PROGRESS before the adapter observes the
  // approvePlan response. The active provider state then correctly stops
  // emitting an approval command, but the persisted effect ID still proves
  // which exact call was interrupted. Reconstruct only that Terra transition;
  // every other mismatched effect remains non-actionable.
  if (state.review.kind !== "resolved" || state.review.reviewer !== "terra" ||
      state.review.verdict !== "approve") return undefined;
  const expectedEffectId = `approve:${state.provider.sessionId}:${state.review.revisionId}`;
  if (effectId !== expectedEffectId) return undefined;
  return {
    kind: "approve_plan",
    sessionId: state.provider.sessionId,
    revisionId: state.review.revisionId,
  };
}

async function reconcileNativePlanEffect(
  effect: NativePlanEffect,
  journal: LifecycleEffectJournal,
  now: string,
  dependencies: LifecycleRunnerDependencies,
): Promise<{ readonly journal: LifecycleEffectJournal; readonly disposition: "executed" | "deferred" }> {
  const identity = journalIdentity(effect);
  const reconciliation = await required(dependencies.reconcileNativePlanEffect, effect.kind)({ effect, effectId: identity.effectId });
  switch (reconciliation.kind) {
    case "confirmed": {
      const confirmed = confirmEffect(journal, identity.effectId, reconciliation.receipt);
      await dependencies.persistJournal(confirmed);
      return { journal: confirmed, disposition: "executed" };
    }
    case "retry_safe":
      {
        const retried = retryStartedEffect(journal, identity.effectId, now);
        await dependencies.persistJournal(retried);
        const receipt = await performNativePlanEffect(effect, dependencies);
        const confirmed = confirmEffect(retried, identity.effectId, receipt);
        await dependencies.persistJournal(confirmed);
        return { journal: confirmed, disposition: "executed" };
      }
    case "await_observation":
      return { journal, disposition: "deferred" };
    case "inconsistent":
      throw new Error(`Native-plan effect ${identity.effectId} is inconsistent: ${reconciliation.reason}`);
    default: {
      const exhaustive: never = reconciliation;
      return exhaustive;
    }
  }
}

/**
 * Executes only reducer-emitted native-plan mutations. It intentionally has
 * no generic provider-message dependency: native cards advance through typed
 * Jules operations, never reviewer prose.
 */
export async function runJulesLifecycle(input: RunJulesLifecycleInput): Promise<RunJulesLifecycleResult> {
  const decision = reduceJulesLifecycle(input.state, input.event);
  switch (decision.effect.kind) {
    case "reconcile_effect": {
      const effect = nativePlanEffectForReconciliation(input.state, decision.effect.effectId);
      if (!effect) return { ...decision, journal: input.journal, disposition: "deferred" };
      const reconciliation = await reconcileNativePlanEffect(effect, input.journal, input.now, input.dependencies);
      return { ...decision, ...reconciliation };
    }
    default:
      if (!isNativePlanEffect(decision.effect)) return { ...decision, journal: input.journal, disposition: "deferred" };
      return {
        ...decision,
        journal: await executeJournaledNativePlanEffect(decision.effect, input.journal, input.now, input.dependencies),
        disposition: "executed",
      };
  }
}
