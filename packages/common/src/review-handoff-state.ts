/**
 * Resolves the only cross-domain precedence edge in the Jules lifecycle.
 *
 * A plan card governs whether Jules may begin implementation. A native PR
 * verdict governs an immutable submitted PR head. Once a reviewer rejects
 * that exact head, continuing to wait for an older plan card is unsafe: it
 * hides actionable feedback and leaves a completed provider session polling.
 * Keep this reducer pure so both live wakes and restart recovery follow the
 * same, auditable rule rather than inspecting reviewer prose.
 */
export type ReviewHandoffProviderState =
  | "QUEUED"
  | "PLANNING"
  | "IN_PROGRESS"
  | "AWAITING_USER_FEEDBACK"
  | "AWAITING_PLAN_APPROVAL"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "UNKNOWN";

export interface ImmutablePullRequestIdentity {
  readonly url: string;
  /** A verdict can only be routed when the immutable reviewed commit is known. */
  readonly headSha?: string | undefined;
}

export interface PendingPlanReview {
  readonly interactionId: string;
  readonly stage: "luna" | "terra";
}

export interface NativePrRejection {
  readonly interactionId: string;
  readonly prUrl: string;
  readonly headSha: string;
  readonly stage: "luna" | "terra";
  readonly reason: string;
}

/** Adapter-owned terminal reason; never use reviewer-provided prose as state. */
export const PR_REJECTION_SUPERSEDED_PLAN_REASON =
  "Superseded by structured PR rejection for the same Jules session and immutable PR head.";

export interface ConsumedPrRejectionPlanRestoreInput {
  readonly interactionStatus: string;
  readonly withdrawalReason?: string | undefined;
  readonly deliveredRejectionDeliveryId?: string | undefined;
}

/**
 * A previous adapter version cancelled the plan Jules published in response to
 * feedback because it repeatedly rediscovered the old PR rejection. Restore
 * only that known adapter cancellation; user/system cancellations remain
 * terminal and are never guessed back into existence.
 */
export function shouldRestorePlanReviewAfterConsumedPrRejection(
  input: ConsumedPrRejectionPlanRestoreInput,
): boolean {
  return input.interactionStatus === "cancelled" &&
    input.withdrawalReason === PR_REJECTION_SUPERSEDED_PLAN_REASON &&
    Boolean(input.deliveredRejectionDeliveryId);
}

export interface ReviewHandoffInput {
  readonly providerState: ReviewHandoffProviderState;
  readonly currentPr?: ImmutablePullRequestIdentity | undefined;
  readonly pendingPlanReview?: PendingPlanReview | undefined;
  readonly rejection?: NativePrRejection | undefined;
  /**
   * Durable provider-delivery checkpoint. Once this exact immutable rejection
   * has reached Jules, it is historical evidence, not precedence over a plan
   * activity Jules publishes in response to that feedback.
   */
  readonly deliveredRejectionDeliveryId?: string | undefined;
}

export type ReviewHandoffDecision =
  | { readonly action: "relay_pr_rejection"; readonly rejection: NativePrRejection; readonly supersedePlanInteractionId?: string | undefined }
  | { readonly action: "await_plan_review" }
  | { readonly action: "await_provider" };

function samePrHead(current: ImmutablePullRequestIdentity | undefined, rejection: NativePrRejection | undefined): boolean {
  return Boolean(
    current?.headSha && rejection &&
    current.url === rejection.prUrl &&
    current.headSha === rejection.headSha,
  );
}

export function nativePrRejectionDeliveryId(rejection: Pick<NativePrRejection, "interactionId" | "headSha">): string {
  return `native-review:${rejection.interactionId}:${rejection.headSha}`;
}

/**
 * Native PR rejection is the highest-precedence continuation for its exact
 * immutable head. Never use this to recover a URL-only or stale-head card.
 */
export function decideReviewHandoff(input: ReviewHandoffInput): ReviewHandoffDecision {
  // This check must precede plan-card precedence. Otherwise every recovery
  // heartbeat rediscovers an answered PR card and cancels the replacement plan
  // that Jules created after receiving the rejection.
  if (input.rejection && input.deliveredRejectionDeliveryId === nativePrRejectionDeliveryId(input.rejection)) {
    return input.pendingPlanReview ? { action: "await_plan_review" } : { action: "await_provider" };
  }
  if (samePrHead(input.currentPr, input.rejection)) {
    return {
      action: "relay_pr_rejection",
      rejection: input.rejection!,
      ...(input.pendingPlanReview ? { supersedePlanInteractionId: input.pendingPlanReview.interactionId } : {}),
    };
  }
  if (input.pendingPlanReview) return { action: "await_plan_review" };
  return { action: "await_provider" };
}
