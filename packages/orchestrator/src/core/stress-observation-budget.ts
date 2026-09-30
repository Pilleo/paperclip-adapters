import type { StressProgress } from "./stress-campaign-progress.js";

export type ObservationDecision =
  | { readonly action: "observe" | "complete" | "automation_window_ended" | "workflow_error" }
  | { readonly action: "stop_waiting_for_user"; readonly waitingFor: "awaiting_user_start" | "awaiting_user_merge" };

export function decideObservationWindow(kind: StressProgress["kind"] | "recovered", expired: boolean): ObservationDecision {
  switch (kind) {
    case "awaiting_user_start":
    case "awaiting_user_merge":
      return expired ? { action: "stop_waiting_for_user", waitingFor: kind } : { action: "observe" };
    case "awaiting_provider":
      return expired ? { action: "automation_window_ended" } : { action: "observe" };
    case "passed":
    case "recovered":
      return { action: "complete" };
    case "invalid":
    case "failed":
      return { action: "workflow_error" };
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unknown observation outcome: ${String(exhaustive)}`);
    }
  }
}
