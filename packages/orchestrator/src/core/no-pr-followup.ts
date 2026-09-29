import { createHash } from "node:crypto";

export interface NoPrFollowupSnapshot {
  readonly issueId: string;
  readonly sessionId: string;
  readonly durableSessionId: string;
  readonly julesAgentId: string;
  readonly assigneeAgentId: string | null;
  readonly issueStatus: string;
  readonly providerState: string;
  readonly prRequired: boolean;
  readonly noPrConfirmation: "pending" | "accepted" | "rejected" | "missing";
  readonly products: readonly unknown[];
  readonly remotePullRequests: readonly string[];
  readonly targetFiles: readonly string[];
  readonly siblings: readonly {
    readonly id: string;
    readonly status: string;
    readonly targetFiles: readonly string[];
    readonly prProductStatus?: string;
    readonly githubPrState?: string;
  }[];
}

export type NoPrFollowupDecision =
  | { readonly kind: "held"; readonly reason: string }
  | { readonly kind: "ready"; readonly marker: string; readonly prompt: string };

/**
 * A terminal provider state is not permission to spawn a replacement session.
 * The sole safe outbound message is tied to the original durable session,
 * exact PR contract, and a released, GitHub-verified shared-file scope.
 */
export function planNoPrFollowup(input: NoPrFollowupSnapshot): NoPrFollowupDecision {
  if (!input.issueId || !input.sessionId || input.durableSessionId !== input.sessionId ||
      input.assigneeAgentId !== input.julesAgentId || input.issueStatus !== "blocked") {
    return { kind: "held", reason: "source_or_original_session_changed" };
  }
  if (!input.prRequired || input.noPrConfirmation !== "pending") {
    return { kind: "held", reason: "no_authoritative_pr_required_confirmation" };
  }
  if (input.providerState !== "COMPLETED" || input.products.length || input.remotePullRequests.length) {
    return { kind: "held", reason: "provider_or_pr_evidence_changed" };
  }
  if (!input.targetFiles.length || input.targetFiles.some((file) => !file || file.includes("\n"))) {
    return { kind: "held", reason: "invalid_file_scope" };
  }
  const scoped = new Set(input.targetFiles);
  const conflict = input.siblings.find((sibling) => sibling.id !== input.issueId &&
    sibling.targetFiles.some((file) => scoped.has(file)) &&
    !(sibling.status === "done" && sibling.prProductStatus === "merged" && sibling.githubPrState === "MERGED"));
  if (conflict) return { kind: "held", reason: "shared_file_not_merged" };
  const marker = `paperclip:pr-required-followup:${createHash("sha256")
    .update(`${input.issueId}:${input.sessionId}:commit-push-pr:v1`).digest("hex")}`;
  return {
    kind: "ready",
    marker,
    prompt: `[${marker}] Continue this same Jules session for Paperclip issue ${input.issueId}. This task explicitly requires one pull request, but the session completed without a PR. If scoped changes already exist, finish and test them; otherwise implement them first. Work from latest master and preserve previously merged sibling exports. Run the declared node --test command, commit and push the scoped changes, and open exactly one pull request against master in the existing repository. Stay within ${input.targetFiles.join(", ")}. Do not create another provider session or a duplicate PR. If commit, push or PR creation is blocked, explain the exact blocker instead of claiming completion.`,
  };
}
