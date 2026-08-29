import { JulesAdapterSessionV1 } from "./session.js";
import { classifyFailure, FailureClassification } from "./failure-classifier.js";

export const MAX_IN_PLACE_RETRIES = 2;

export type FailureActionType =
  | "IN_PLACE_RETRY"
  | "FRESH_SESSION_RETRY"
  | "MARK_BLOCKED";

export interface FailureRecoveryDecision {
  action: FailureActionType;
  inPlaceAttempt: number;
  retryMessage?: string;
  reason: string;
  classification: FailureClassification;
}

export function evaluateSessionFailure(
  session: JulesAdapterSessionV1,
  failureReason: unknown,
  maxInPlaceRetries: number = MAX_IN_PLACE_RETRIES
): FailureRecoveryDecision {
  const errorObj = typeof failureReason === "string" ? new Error(failureReason) : failureReason;
  const reasonText = typeof failureReason === "string" ? failureReason : (failureReason as Error)?.message || "Jules encountered a failure.";
  const classification = classifyFailure(errorObj);

  // Configuration errors (e.g. 401/403/api key) cannot be resolved by retrying in-place
  if (classification === "configuration") {
    return {
      action: "MARK_BLOCKED",
      inPlaceAttempt: 0,
      reason: "Unrecoverable configuration error: " + reasonText,
      classification
    };
  }

  const currentInPlaceAttempts = (session as { inPlaceRetryCount?: number }).inPlaceRetryCount || 0;

  if (currentInPlaceAttempts < maxInPlaceRetries) {
    return {
      action: "IN_PLACE_RETRY",
      inPlaceAttempt: currentInPlaceAttempts + 1,
      retryMessage: "retry",
      reason: "Attempting in-place failure retry " + (currentInPlaceAttempts + 1) + "/" + maxInPlaceRetries,
      classification
    };
  }

  return {
    action: "MARK_BLOCKED",
    inPlaceAttempt: currentInPlaceAttempts,
    reason: "Exhausted in-place retries (" + currentInPlaceAttempts + "/" + maxInPlaceRetries + "): " + reasonText,
    classification
  };
}
