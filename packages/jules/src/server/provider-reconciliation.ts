import type { JulesSessionState, SessionPhase } from "./session.js";

export type ProviderReconciliation =
  | { readonly action: "continue_live"; readonly clearStalePr: boolean }
  | { readonly action: "handle_terminal" }
  | { readonly action: "retain_retry" };

export function reconcileProviderState(input: {
  readonly remoteState: JulesSessionState;
  readonly persistedPhase: SessionPhase;
  readonly hasPersistedPr: boolean;
  readonly remotePollSucceeded: boolean;
}): ProviderReconciliation {
  if (!input.remotePollSucceeded) return { action: "retain_retry" };
  switch (input.remoteState) {
    case "COMPLETED":
    case "FAILED":
      return { action: "handle_terminal" };
    case "QUEUED":
    case "PLANNING":
    case "IN_PROGRESS":
    case "AWAITING_USER_FEEDBACK":
    case "AWAITING_PLAN_APPROVAL":
    case "CANCELLED":
    case "UNKNOWN":
      return { action: "continue_live", clearStalePr: input.hasPersistedPr };
    default:
      return assertNever(input.remoteState);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Jules provider state: ${String(value)}`);
}
