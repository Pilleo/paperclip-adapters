import { describe, expect, it } from "vitest";
import { parseReviewDecisionComment, validateReviewDecision } from "../src/core/review-decision.js";

describe("review decision contract", () => {
  it("accepts all_good with or without an optional comment", () => {
    expect(validateReviewDecision({ decision: "all_good" })).toEqual({ decision: "all_good" });
    expect(validateReviewDecision({ decision: "all_good", comment: "Looks good" })).toEqual({
      decision: "all_good", comment: "Looks good",
    });
  });

  it("requires actionable feedback for needs_work", () => {
    expect(validateReviewDecision({ decision: "needs_work", comment: "  " })).toBeNull();
    expect(validateReviewDecision({ decision: "needs_work", comment: "Fix the null check" })).toEqual({
      decision: "needs_work", comment: "Fix the null check",
    });
  });

  it("parses only the exact machine decision line", () => {
    expect(parseReviewDecisionComment('PAPERCLIP_REVIEW_DECISION {"decision":"all_good"}\nLooks good')).toEqual({
      decision: "all_good",
    });
    expect(parseReviewDecisionComment('Looks good PAPERCLIP_REVIEW_DECISION {"decision":"all_good"}')).toBeNull();
  });
});
