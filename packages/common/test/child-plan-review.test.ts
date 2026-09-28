import { describe, expect, it } from "vitest";
import { childPlanReviewDescription, parseChildPlanReviewDescription, childPlanReviewKey, ChildPlanReviewIdentitySchema, isStablePlanReviewChild } from "../src/child-plan-review.js";

export const identity = { version: 3 as const, companyId: "company", parentIssueId: "parent", sessionId: "session",
  activityId: "activity", documentId: "document", revisionId: "revision", revisionNumber: 1,
  stage: "luna" as const, reviewerAgentId: "luna", bootstrapAgentId: "orchestrator", julesAgentId: "jules" };
describe("stable child plan identity", () => {
  it("round-trips the explicit child protocol without interpreting plan prose", () => {
    expect(parseChildPlanReviewDescription(childPlanReviewDescription(identity))).toEqual(identity);
    expect(parseChildPlanReviewDescription("Review this plan please")).toBeNull();
  });
  it("binds child identity to session, revision, stage, reviewer and bootstrap owner", () => {
    const key = childPlanReviewKey(identity);
    for (const [field, value] of Object.entries({ sessionId: "other", revisionId: "other", stage: "terra", reviewerAgentId: "other", bootstrapAgentId: "other" })) {
      expect(childPlanReviewKey({ ...identity, [field]: value } as typeof identity)).not.toBe(key);
    }
    expect(key).toMatch(/^jules:plan-child:v3:[0-9a-f]{64}$/);
  });
  it("rejects a reviewer that is also the bootstrap or Jules author", () => {
    expect(ChildPlanReviewIdentitySchema.safeParse({ ...identity, bootstrapAgentId: "luna" }).success).toBe(false);
    expect(ChildPlanReviewIdentitySchema.safeParse({ ...identity, reviewerAgentId: "jules" }).success).toBe(false);
  });
  it("identifies protocol tasks for scheduler isolation only with matching company, parent and creator", () => {
    const issue = { companyId: "company", parentId: "parent", createdByAgentId: "jules", description: childPlanReviewDescription(identity) };
    expect(isStablePlanReviewChild(issue)).toBe(true);
    expect(isStablePlanReviewChild({ ...issue, companyId: "other" })).toBe(false);
    expect(isStablePlanReviewChild({ ...issue, createdByAgentId: "other" })).toBe(false);
  });
});
