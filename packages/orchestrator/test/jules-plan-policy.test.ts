import { describe, expect, it } from "vitest";
import { needsJulesPlanPolicyPatch } from "../src/core/jules-plan-policy.js";

describe("managed Jules plan-policy reconciliation", () => {
  const current = {
    planApprovalPolicy: "review_required",
    planReviewerAgentId: "luna",
    planStrongReviewerAgentId: "gemini",
    questionReviewerAgentId: "terra",
    questionAdjudicatorAgentId: "terra",
  };

  it("does not PATCH an existing policy when this orchestrator has no policy override", () => {
    expect(needsJulesPlanPolicyPatch(current, {
      planReviewerAgentId: "luna",
      planStrongReviewerAgentId: "gemini",
      questionReviewerAgentId: "terra",
      questionAdjudicatorAgentId: "terra",
    })).toBe(false);
  });

  it("PATCHes when an explicitly managed reviewer or policy differs", () => {
    expect(needsJulesPlanPolicyPatch(current, { planReviewerAgentId: "new-luna" })).toBe(true);
    expect(needsJulesPlanPolicyPatch(current, { planApprovalPolicy: "new-policy" })).toBe(true);
    expect(needsJulesPlanPolicyPatch(current, { questionAdjudicatorAgentId: "new-terra" })).toBe(true);
  });

  it("ignores optional fields that this project does not configure", () => {
    expect(needsJulesPlanPolicyPatch(current, {})).toBe(false);
  });
});
