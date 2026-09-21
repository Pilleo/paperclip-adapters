import type { JulesLifecycleEffect } from "@pilleo/paperclip-adapter-common";

export type NativePlanEffect = Extract<JulesLifecycleEffect, {
  readonly kind: "create_card" | "approve_plan" | "request_plan_revision";
}>;

export type NativePlanEffectReconciliation =
  | { readonly kind: "confirmed"; readonly receipt: string }
  | { readonly kind: "retry_safe" }
  | { readonly kind: "await_observation" }
  | { readonly kind: "inconsistent"; readonly reason: string };

export type NativePlanEffectEvidence = {
  readonly card?:
    | { readonly kind: "exact"; readonly cardId: string }
    | { readonly kind: "absent" }
    | { readonly kind: "ambiguous" };
  readonly approval?:
    | { readonly kind: "same_plan_pending" }
    | { readonly kind: "same_session_progressed"; readonly state: string }
    | { readonly kind: "provider_question" }
    | { readonly kind: "failed" }
    | { readonly kind: "unknown" };
  readonly revisionRequest?:
    | { readonly kind: "marker_mirrored"; readonly activityId: string }
    | { readonly kind: "marker_not_observed" }
    | { readonly kind: "ambiguous" };
};

/**
 * Classifies a persisted but unconfirmed external mutation using only
 * read-after-write evidence. It never interprets reviewer prose.
 */
export function reconcileNativePlanEffect(
  effect: NativePlanEffect,
  evidence: NativePlanEffectEvidence,
): NativePlanEffectReconciliation {
  switch (effect.kind) {
    case "create_card":
      switch (evidence.card?.kind) {
        case "exact":
          return { kind: "confirmed", receipt: evidence.card.cardId };
        case "absent":
          return { kind: "retry_safe" };
        case "ambiguous":
        case undefined:
          return { kind: "await_observation" };
        default: {
          const exhaustive: never = evidence.card;
          return exhaustive;
        }
      }
    case "approve_plan":
      switch (evidence.approval?.kind) {
        case "same_plan_pending":
          // A started approval is an unknown external effect. Seeing the
          // exact plan still pending cannot prove that replaying approvePlan
          // is safe, so preserve the typed card and wait for provider state.
          return { kind: "await_observation" };
        case "same_session_progressed":
          return { kind: "confirmed", receipt: `provider:${evidence.approval.state}` };
        case "provider_question":
        case "unknown":
          return { kind: "await_observation" };
        case "failed":
          return { kind: "inconsistent", reason: "provider failed while plan approval outcome is unknown" };
        case undefined:
          return { kind: "await_observation" };
        default: {
          const exhaustive: never = evidence.approval;
          return exhaustive;
        }
      }
    case "request_plan_revision":
      switch (evidence.revisionRequest?.kind) {
        case "marker_mirrored":
          return { kind: "confirmed", receipt: evidence.revisionRequest.activityId };
        case "marker_not_observed":
        case "ambiguous":
        case undefined:
          return { kind: "await_observation" };
        default: {
          const exhaustive: never = evidence.revisionRequest;
          return exhaustive;
        }
      }
    default: {
      const exhaustive: never = effect;
      return exhaustive;
    }
  }
}
