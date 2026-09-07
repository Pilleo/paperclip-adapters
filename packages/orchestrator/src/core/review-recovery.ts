import type { PrReviewStage } from "./review-interaction-state.js";

export interface ReviewerUnavailableRecoveryInput {
  readonly prUrl: string;
  readonly headSha: string;
  readonly stage: PrReviewStage;
  readonly reviewerAgentId: string;
  readonly reviewerStatus: string;
  readonly reason: string;
  readonly circuitKey: string;
}

export function reviewerUnavailableRecoveryPayload(input: ReviewerUnavailableRecoveryInput): Record<string, unknown> {
  return {
    kind: "reviewer_unavailable",
    ownerType: "board",
    cause: `Reviewer ${input.reviewerAgentId} is unavailable: ${input.reason}`,
    fingerprint: input.circuitKey,
    evidence: {
      reviewerAgentId: input.reviewerAgentId,
      reviewerStatus: input.reviewerStatus,
      reviewStage: input.stage,
      prUrl: input.prUrl,
      headSha: input.headSha,
    },
    nextAction: `Wait for reviewer ${input.reviewerAgentId} to become invokable, then resume the ${input.stage} PR review for ${input.prUrl}.`,
    monitorPolicy: { mode: "orchestrator_heartbeat", retryWhen: "reviewer_invokable" },
    wakePolicy: { mode: "next_heartbeat" },
    preserveExistingOwner: true,
  };
}

export function isSameReviewerUnavailableRecovery(action: unknown, fingerprint: string): boolean {
  if (!action || typeof action !== "object") return false;
  const value = action as Record<string, unknown>;
  return (value["kind"] === "reviewer_unavailable") &&
    (value["status"] === "active" || value["status"] === "escalated") &&
    value["fingerprint"] === fingerprint;
}
