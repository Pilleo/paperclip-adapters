export type WorkspaceSyncInteraction = Readonly<{
  id: string;
  kind?: string;
  status?: string;
  idempotencyKey?: string;
}>;

export type WorkspaceSyncInteractionPlan =
  | Readonly<{ action: "reuse"; interactionId: string }>
  | Readonly<{ action: "create"; idempotencyKey: string }>;

export function workspaceSyncInteractionKey(issueId: string, disposition: string): string {
  return `workspace-sync:${issueId}:${disposition}`;
}

export function planWorkspaceSyncInteraction(
  issueId: string,
  disposition: string,
  interactions: readonly WorkspaceSyncInteraction[],
): WorkspaceSyncInteractionPlan {
  const idempotencyKey = workspaceSyncInteractionKey(issueId, disposition);
  const pending = interactions.find((interaction) =>
    interaction.kind === "ask_user_questions" && interaction.status === "pending" && interaction.idempotencyKey === idempotencyKey,
  );
  return pending ? { action: "reuse", interactionId: pending.id } : { action: "create", idempotencyKey };
}

export function buildWorkspaceSyncInteractionRequest(issueId: string, disposition: string, reason: string): Record<string, unknown> {
  return {
    kind: "ask_user_questions",
    idempotencyKey: workspaceSyncInteractionKey(issueId, disposition),
    title: "Workspace synchronization needs operator action",
    resolverPolicy: "human_only",
    continuationPolicy: "wake_assignee",
    payload: {
      version: 1,
      prompt: `Fresh work is paused because ${reason}. Repair the project workspace, then submit this form to trigger a fresh safety check.`,
      questions: [{ id: "workspace_rechecked", label: "Workspace repaired", type: "boolean", required: true }],
    },
  };
}
