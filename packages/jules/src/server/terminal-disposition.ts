export type TerminalDispositionAction =
  | "create_plan_review"
  | "resume_pending_plan_review"
  | "handoff_pr"
  | "request_no_pr_confirmation"
  | "resume_missing_pr"
  | "retry_failed_session"
  | "block_missing_pr";

export interface TerminalDispositionInput {
  readonly providerState: "COMPLETED" | "FAILED";
  readonly requiresPr: boolean;
  readonly hasPr: boolean;
  readonly hasUnapprovedPlan: boolean;
  readonly hasPendingPlanReview: boolean;
  /** Bounded automatic recovery for a provider that completed before opening its required PR. */
  readonly missingPrRetryCount?: number;
  /** A Jules FAILED state can be an ephemeral cloud-VM failure; retry it once in-place. */
  readonly failedSessionRetryCount?: number;
}

export interface TerminalDisposition {
  readonly action: TerminalDispositionAction;
}

/**
 * Terminal provider state is not enough to declare a coding task complete.
 * A required PR and the latest typed plan gate are durable contracts that
 * outrank a coarse Jules COMPLETED transition.
 */
export function decideTerminalDisposition(input: TerminalDispositionInput): TerminalDisposition {
  switch (input.providerState) {
    case "FAILED":
      return (input.failedSessionRetryCount ?? 0) === 0
        ? { action: "retry_failed_session" }
        : { action: "block_missing_pr" };
    case "COMPLETED":
      if (input.hasPr) return { action: "handoff_pr" };
      if (input.hasUnapprovedPlan) {
        return { action: input.hasPendingPlanReview ? "resume_pending_plan_review" : "create_plan_review" };
      }
      if (!input.requiresPr) return { action: "request_no_pr_confirmation" };
      return (input.missingPrRetryCount ?? 0) === 0
        ? { action: "resume_missing_pr" }
        : { action: "block_missing_pr" };
  }
}
