import type { StructuredDecision, StructuredReviewDecision } from "./structured-decision.js";

export interface DecisionLadderStage {
  readonly key: string;
  readonly strength: "weak" | "strong";
  readonly agentId: string;
}

export type DecisionLadderTransition =
  | { readonly action: "advance"; readonly nextStage: DecisionLadderStage }
  | { readonly action: "complete" }
  | { readonly action: "return_to_worker"; readonly reason: string }
  | { readonly action: "escalate_to_human"; readonly reason: string }
  | { readonly action: "protocol_failure"; readonly reason: "review_ladder_requires_review_outcome" | "invalid_review_stage" };

export function advanceDecisionLadder(
  stages: readonly DecisionLadderStage[],
  stageIndex: number,
  outcome: StructuredDecision,
): DecisionLadderTransition {
  const stage = stages[stageIndex];
  if (!stage) return { action: "protocol_failure", reason: "invalid_review_stage" };
  if (outcome.kind !== "review") {
    return { action: "protocol_failure", reason: "review_ladder_requires_review_outcome" };
  }
  return advanceReviewOutcome(stages, stageIndex, outcome);
}

function advanceReviewOutcome(
  stages: readonly DecisionLadderStage[],
  stageIndex: number,
  outcome: StructuredReviewDecision,
): DecisionLadderTransition {
  switch (outcome.verdict) {
    case "reject":
      return { action: "return_to_worker", reason: outcome.reason };
    case "approve": {
      const nextStage = stages[stageIndex + 1];
      return nextStage ? { action: "advance", nextStage } : { action: "complete" };
    }
    case "uncertain": {
      const nextStage = stages[stageIndex + 1];
      return nextStage
        ? { action: "advance", nextStage }
        : { action: "escalate_to_human", reason: outcome.reason };
    }
  }
}
