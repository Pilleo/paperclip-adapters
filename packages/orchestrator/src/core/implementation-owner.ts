export type ImplementationRejectionStage = "luna_review" | "terra_review" | "operator_approval";

export interface ImplementationWakeEpoch {
  readonly version: 1;
  readonly issueId: string;
  readonly headSha: string;
  readonly stage: ImplementationRejectionStage;
  readonly feedbackId: string;
}

export function resolveImplementationOwner(input: {
  readonly metadataAgentId: string | null;
  readonly currentAssigneeId: string | null;
  readonly managedWorkerIds: ReadonlySet<string>;
}): string | null {
  if (input.metadataAgentId !== null) {
    return input.managedWorkerIds.has(input.metadataAgentId) ? input.metadataAgentId : null;
  }
  return input.currentAssigneeId !== null && input.managedWorkerIds.has(input.currentAssigneeId)
    ? input.currentAssigneeId
    : null;
}

export function buildImplementationRejectionWake(input: {
  readonly issueId: string;
  readonly identifier: string;
  readonly headSha: string;
  readonly stage: ImplementationRejectionStage;
  readonly feedback:
    | { readonly kind: "native_review"; readonly interactionId: string; readonly reason: string }
    | { readonly kind: "operator_approval"; readonly approvalId: string };
}): { readonly reason: string; readonly idempotencyKey: string; readonly epoch: ImplementationWakeEpoch } {
  const feedbackId = input.feedback.kind === "native_review"
    ? input.feedback.interactionId
    : input.feedback.approvalId;
  const epoch: ImplementationWakeEpoch = Object.freeze({
    version: 1,
    issueId: input.issueId,
    headSha: input.headSha,
    stage: input.stage,
    feedbackId,
  });
  const reason = input.feedback.kind === "native_review"
    ? `The answered native PR review card ${input.feedback.interactionId} requested changes for ${input.identifier}: ${input.feedback.reason}`
    : `The merge approval ${input.feedback.approvalId} was rejected for ${input.identifier}; reconcile the current PR head.`;
  return Object.freeze({
    reason,
    idempotencyKey: `orchestrator:implementation-reconcile:${input.issueId}:${input.headSha}:${input.stage}:${feedbackId}`,
    epoch,
  });
}
