import { describe, expect, it } from "vitest";
import { advanceDecisionLadder, type DecisionLadderStage } from "../src/decision-ladder.js";

const stages: readonly DecisionLadderStage[] = [
  { key: "budget-review", strength: "weak", agentId: "agent-a" },
  { key: "expert-review", strength: "strong", agentId: "agent-b" },
];

describe("decision ladder", () => {
  it.each([
    [0, { kind: "review", verdict: "approve" }, { action: "advance", nextStage: stages[1] }],
    [1, { kind: "review", verdict: "approve" }, { action: "complete" }],
    [0, { kind: "review", verdict: "reject", reason: "Needs a focused correction." }, { action: "return_to_worker", reason: "Needs a focused correction." }],
    [0, { kind: "review", verdict: "uncertain", reason: "Requires stronger analysis." }, { action: "advance", nextStage: stages[1] }],
    [1, { kind: "review", verdict: "uncertain", reason: "Requires human context." }, { action: "escalate_to_human", reason: "Requires human context." }],
  ] as const)("reduces stage %i and outcome %# without provider-specific branches", (stageIndex, outcome, expected) => {
    expect(advanceDecisionLadder(stages, stageIndex, outcome)).toEqual(expected);
  });

  it("rejects question outcomes in a review ladder", () => {
    expect(advanceDecisionLadder(stages, 0, { kind: "question", verdict: "answer", answer: "Proceed." }))
      .toEqual({ action: "protocol_failure", reason: "review_ladder_requires_review_outcome" });
  });

  it("rejects invalid stage indexes instead of guessing", () => {
    expect(advanceDecisionLadder(stages, 2, { kind: "review", verdict: "approve" }))
      .toEqual({ action: "protocol_failure", reason: "invalid_review_stage" });
  });
});
