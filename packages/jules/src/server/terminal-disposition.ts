export type TerminalDispositionAction =
  | "create_plan_review"
  | "resume_pending_plan_review"
  | "handoff_pr"
  | "request_no_pr_confirmation"
  | "block_missing_pr";

export interface TerminalDispositionInput {
  readonly providerState: "COMPLETED" | "FAILED";
  readonly requiresPr: boolean;
  readonly hasPr: boolean;
  readonly hasUnapprovedPlan: boolean;
  readonly hasPendingPlanReview: boolean;
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
      return { action: "block_missing_pr" };
    case "COMPLETED":
      if (input.hasPr) return { action: "handoff_pr" };
      if (input.hasUnapprovedPlan) {
        return { action: input.hasPendingPlanReview ? "resume_pending_plan_review" : "create_plan_review" };
      }
      return { action: input.requiresPr ? "block_missing_pr" : "request_no_pr_confirmation" };
  }
}
