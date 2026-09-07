import type { JulesSessionState } from "./session.js";

export type CompletionEvidence = {
  readonly providerState: JulesSessionState;
  readonly prMerged: boolean;
  readonly mutationPending: boolean;
};

export type CompletionDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: "provider_state_unknown" | "provider_not_terminal" | "pr_not_merged" | "pending_mutation" };

/** Pure terminal-transition guard. Evidence, not timing, authorizes completion. */
export function evaluateCompletionTransition(evidence: CompletionEvidence): CompletionDecision {
  if (evidence.mutationPending) return { allowed: false, reason: "pending_mutation" };
  if (evidence.providerState === "UNKNOWN") return { allowed: false, reason: "provider_state_unknown" };
  if (evidence.providerState !== "COMPLETED") return { allowed: false, reason: "provider_not_terminal" };
  if (!evidence.prMerged) return { allowed: false, reason: "pr_not_merged" };
  return { allowed: true };
}

