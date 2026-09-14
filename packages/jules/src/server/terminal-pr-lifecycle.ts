import type { CiCheckStatus } from "./ci-status.js";

/**
 * Decides ownership after Jules reaches a terminal provider state.
 *
 * A PR is a durable Paperclip work product.  Once it exists, a failed
 * provider session must not fall through to the generic retry path: that path
 * starts from the repository base branch and can create a second PR.  Keep
 * this reducer free of API calls so retry, restart, and live polling take the
 * same explicit transition.
 */
export type TerminalPrLifecycleAction =
  | "route_to_review"
  | "await_ci"
  | "start_pr_remediation"
  | "await_pr_remediation"
  | "normal_terminal_failure"
  | "normal_completion_without_pr";

export interface TerminalPrLifecycleInput {
  readonly providerState: "COMPLETED" | "FAILED";
  readonly hasPr: boolean;
  readonly ciStatus: CiCheckStatus;
  readonly hasRecoverySession: boolean;
}

export function decideTerminalPrLifecycle(input: TerminalPrLifecycleInput): {
  readonly action: TerminalPrLifecycleAction;
} {
  switch (input.providerState) {
    case "COMPLETED":
      if (!input.hasPr) return { action: "normal_completion_without_pr" };
      switch (input.ciStatus) {
        case "success":
          return { action: "route_to_review" };
        case "pending":
        case "unknown":
          return { action: "await_ci" };
        case "stalled":
        case "failed":
          return input.hasRecoverySession
            ? { action: "await_pr_remediation" }
            : { action: "start_pr_remediation" };
        default:
          return assertNever(input.ciStatus);
      }
    case "FAILED":
      if (!input.hasPr) return { action: "normal_terminal_failure" };
      return input.hasRecoverySession
        ? { action: "await_pr_remediation" }
        : { action: "start_pr_remediation" };
    default:
      return assertNever(input.providerState);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled terminal PR lifecycle value: ${String(value)}`);
}
