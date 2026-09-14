export type WorkspaceSyncInteraction = Readonly<{
  id: string;
  kind?: string;
  status?: string;
  idempotencyKey?: string;
}>;

export type WorkspaceSyncInteractionPlan =
  | Readonly<{ action: "reuse"; interactionId: string; withdrawInteractionIds: readonly string[] }>
  | Readonly<{ action: "create"; idempotencyKey: string }>;

export function workspaceSyncInteractionKey(issueId: string): string {
  return `workspace-sync:v2:${issueId}`;
}

export function planWorkspaceSyncInteraction(
  issueId: string,
  interactions: readonly WorkspaceSyncInteraction[],
): WorkspaceSyncInteractionPlan {
  const idempotencyKey = workspaceSyncInteractionKey(issueId);
  // v1 incorrectly included the volatile hold reason in the key. Recognize
  // those pending cards so an upgrade neither spams a second form nor loses a
  // human's in-flight response; retain exactly one and withdraw the rest.
  const keyPrefix = `workspace-sync:${issueId}:`;
  const pending = interactions.filter((interaction) =>
    interaction.kind === "ask_user_questions" && interaction.status === "pending" &&
    (interaction.idempotencyKey === idempotencyKey || interaction.idempotencyKey?.startsWith(keyPrefix)),
  );
  const retained = pending[0];
  return retained
    ? { action: "reuse", interactionId: retained.id, withdrawInteractionIds: pending.slice(1).map((interaction) => interaction.id) }
    : { action: "create", idempotencyKey };
}

export function buildWorkspaceSyncInteractionRequest(issueId: string, reason: string): Record<string, unknown> {
  return {
    kind: "ask_user_questions",
    idempotencyKey: workspaceSyncInteractionKey(issueId),
    title: "Workspace synchronization needs operator action",
    resolverPolicy: "human_only",
    continuationPolicy: "wake_assignee",
    payload: {
      version: 1,
      prompt: `Fresh work is paused because ${reason}. Repair the project workspace, then submit this form to trigger a fresh safety check.`,
      questions: [{
        id: "workspace_rechecked",
        prompt: "After repairing the workspace, confirm that Paperclip should recheck it.",
        selectionMode: "single",
        options: [{ id: "recheck", label: "Recheck workspace synchronization" }],
      }],
    },
  };
}
