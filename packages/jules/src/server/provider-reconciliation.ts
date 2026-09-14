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

/**
 * A completed Jules session does not necessarily repeat its PR handoff in the
 * final polling payload. The persisted URL is safe only for a terminal remote
 * state, where it is the same session's durable handoff identity. Live states
 * must never reuse it: a resumed provider can be working on a new turn.
 */
export function selectTerminalPullRequestUrl<T extends string>(input: {
  readonly state: JulesSessionState;
  readonly discovered: T | undefined;
  readonly persisted: T | undefined;
}): T | undefined {
  if (input.discovered) return input.discovered;
  switch (input.state) {
    case "COMPLETED":
    case "FAILED":
      return input.persisted;
    case "QUEUED":
    case "PLANNING":
    case "IN_PROGRESS":
    case "AWAITING_USER_FEEDBACK":
    case "AWAITING_PLAN_APPROVAL":
    case "CANCELLED":
    case "UNKNOWN":
      return undefined;
    default:
      return assertNever(input.state);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Jules provider state: ${String(value)}`);
}
