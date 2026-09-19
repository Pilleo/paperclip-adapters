import { assertNever } from "./fp.js";

export type JulesProviderState =
  | { readonly kind: "awaiting_plan"; readonly sessionId: string; readonly revisionId: string }
  | { readonly kind: "awaiting_feedback"; readonly sessionId: string; readonly revisionId: string }
  | { readonly kind: "in_progress"; readonly sessionId: string }
  | { readonly kind: "completed"; readonly sessionId: string; readonly pullRequestUrl: string };

export type JulesReviewGate =
  | { readonly kind: "none" }
  | { readonly kind: "pending"; readonly cardId: string; readonly revisionId: string; readonly reviewer: "luna" | "terra" }
  | {
    readonly kind: "resolved";
    readonly cardId: string;
    readonly revisionId: string;
    readonly reviewer: "luna" | "terra";
    readonly verdict: "approve" | "reject";
    readonly runId: string;
  };

export type JulesEffectAttempt =
  | { readonly kind: "not_started" }
  | { readonly kind: "started"; readonly effectId: string; readonly startedAt: string }
  | { readonly kind: "confirmed"; readonly effectId: string; readonly receipt: string };

export type JulesMonitorState =
  | { readonly kind: "none" }
  | { readonly kind: "scheduled"; readonly monitorId: string }
  | { readonly kind: "triggered"; readonly monitorId: string };

export interface JulesLifecycleState {
  readonly provider: JulesProviderState;
  readonly review: JulesReviewGate;
  readonly effect: JulesEffectAttempt;
  readonly monitor: JulesMonitorState;
}

export type JulesLifecycleEvent =
  | { readonly kind: "heartbeat" }
  | { readonly kind: "run_interrupted" }
  | {
    readonly kind: "review_card_resolved";
    readonly cardId: string;
    readonly revisionId: string;
    readonly reviewer: "luna" | "terra";
    readonly verdict: "approve" | "reject";
    readonly runId: string;
  };

export type JulesLifecycleEffect =
  | { readonly kind: "create_card"; readonly reviewer: "luna" | "terra"; readonly revisionId: string }
  | { readonly kind: "deliver_verdict"; readonly cardId: string; readonly verdict: "approve" | "reject"; readonly runId: string }
  | { readonly kind: "poll_provider"; readonly sessionId: string }
  | { readonly kind: "rearm_monitor"; readonly sessionId: string; readonly monitorId: string }
  | { readonly kind: "reconcile_effect"; readonly effectId: string }
  | { readonly kind: "preserve"; readonly reason: string }
  | { readonly kind: "complete_issue"; readonly pullRequestUrl: string }
  | { readonly kind: "report_invariant_violation"; readonly reason: string };

export interface JulesLifecycleDecision {
  readonly state: JulesLifecycleState;
  readonly effect: JulesLifecycleEffect;
}

function preserve(state: JulesLifecycleState, reason: string): JulesLifecycleDecision {
  return { state, effect: { kind: "preserve", reason } };
}

function currentRevision(provider: JulesProviderState): string | null {
  switch (provider.kind) {
    case "awaiting_plan":
    case "awaiting_feedback":
      return provider.revisionId;
    case "in_progress":
    case "completed":
      return null;
    default:
      return assertNever(provider);
  }
}

function sessionId(provider: JulesProviderState): string {
  switch (provider.kind) {
    case "awaiting_plan":
    case "awaiting_feedback":
    case "in_progress":
    case "completed":
      return provider.sessionId;
    default:
      return assertNever(provider);
  }
}

function decideInterrupted(state: JulesLifecycleState): JulesLifecycleDecision {
  switch (state.effect.kind) {
    case "started":
      return { state, effect: { kind: "reconcile_effect", effectId: state.effect.effectId } };
    case "confirmed":
      return { state, effect: { kind: "poll_provider", sessionId: sessionId(state.provider) } };
    case "not_started":
      switch (state.monitor.kind) {
        case "triggered":
          return {
            state,
            effect: { kind: "rearm_monitor", sessionId: sessionId(state.provider), monitorId: state.monitor.monitorId },
          };
        case "none":
        case "scheduled":
          return preserve(state, "interrupted before a remote effect; existing monitor state is authoritative");
        default:
          return assertNever(state.monitor);
      }
    default:
      return assertNever(state.effect);
  }
}

function decideHeartbeat(state: JulesLifecycleState): JulesLifecycleDecision {
  switch (state.provider.kind) {
    case "completed":
      return { state, effect: { kind: "complete_issue", pullRequestUrl: state.provider.pullRequestUrl } };
    case "in_progress":
      return { state, effect: { kind: "poll_provider", sessionId: state.provider.sessionId } };
    case "awaiting_plan":
    case "awaiting_feedback":
      switch (state.review.kind) {
        case "none":
          return {
            state,
            effect: { kind: "create_card", reviewer: "luna", revisionId: state.provider.revisionId },
          };
        case "pending":
          return preserve(state, "an exact native review card already owns this revision");
        case "resolved":
          switch (state.effect.kind) {
            case "not_started":
              return {
                state,
                effect: {
                  kind: "deliver_verdict",
                  cardId: state.review.cardId,
                  verdict: state.review.verdict,
                  runId: state.review.runId,
                },
              };
            case "started":
              return { state, effect: { kind: "reconcile_effect", effectId: state.effect.effectId } };
            case "confirmed":
              return { state, effect: { kind: "poll_provider", sessionId: state.provider.sessionId } };
            default:
              return assertNever(state.effect);
          }
        default:
          return assertNever(state.review);
      }
    default:
      return assertNever(state.provider);
  }
}

/** A pure, exhaustive decision point for a single Jules/Paperclip lifecycle. */
export function reduceJulesLifecycle(
  state: JulesLifecycleState,
  event: JulesLifecycleEvent,
): JulesLifecycleDecision {
  switch (event.kind) {
    case "heartbeat":
      return decideHeartbeat(state);
    case "run_interrupted":
      return decideInterrupted(state);
    case "review_card_resolved": {
      const revisionId = currentRevision(state.provider);
      if (!revisionId || revisionId !== event.revisionId) {
        return preserve(state, "resolved review card belongs to a stale or terminal provider revision");
      }
      if (state.review.kind !== "pending" || state.review.cardId !== event.cardId || state.review.reviewer !== event.reviewer) {
        return preserve(state, "resolved review card does not match the pending native gate");
      }
      const next: JulesLifecycleState = {
        ...state,
        review: {
          kind: "resolved",
          cardId: event.cardId,
          revisionId: event.revisionId,
          reviewer: event.reviewer,
          verdict: event.verdict,
          runId: event.runId,
        },
      };
      return decideHeartbeat(next);
    }
    default:
      return assertNever(event);
  }
}
