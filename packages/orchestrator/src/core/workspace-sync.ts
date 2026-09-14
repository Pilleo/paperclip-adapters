export type WorkspaceSyncPolicy = Readonly<{
  repoUrl: string;
  defaultRef: string;
}>;

export type WorkspaceSyncObservation =
  | Readonly<{ kind: "dirty"; branch: string; headSha: string }>
  | Readonly<{ kind: "clean_default"; branch: string; headSha: string; remoteHeadSha: string }>
  | Readonly<{ kind: "clean_non_default"; branch: string; headSha: string }>
  | Readonly<{ kind: "diverged"; branch: string; headSha: string; remoteHeadSha: string }>
  | Readonly<{ kind: "remote_unavailable"; branch: string; headSha: string; detail: string }>
  | Readonly<{ kind: "inspection_failed"; detail: string }>;

export type WorkspaceSyncDecision =
  | Readonly<{ action: "fast_forward"; repoUrl: string; defaultRef: string }>
  | Readonly<{ action: "hold"; reason: string }>;

/**
 * Decides whether fresh dispatch may synchronize a project checkout. This
 * reducer deliberately has no permissive fallback: a missing policy or an
 * observation outside the clean configured branch is a hold.
 */
export function evaluateWorkspaceSync(input: Readonly<{
  observation: WorkspaceSyncObservation;
  policy: WorkspaceSyncPolicy | null;
}>): WorkspaceSyncDecision {
  if (!input.policy) {
    return { action: "hold", reason: "Paperclip project synchronization policy is missing." };
  }

  switch (input.observation.kind) {
    case "clean_default":
      return {
        action: "fast_forward",
        repoUrl: input.policy.repoUrl,
        defaultRef: input.policy.defaultRef,
      };
    case "dirty":
      return { action: "hold", reason: "Project checkout has uncommitted changes." };
    case "clean_non_default":
      return { action: "hold", reason: "Project checkout is not on the configured default branch." };
    case "diverged":
      return { action: "hold", reason: "Project checkout diverged from the configured remote branch." };
    case "remote_unavailable":
      return { action: "hold", reason: `Configured remote is unavailable: ${input.observation.detail}` };
    case "inspection_failed":
      return { action: "hold", reason: `Checkout inspection failed: ${input.observation.detail}` };
  }
}
