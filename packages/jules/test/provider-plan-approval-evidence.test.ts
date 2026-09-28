import { describe, expect, it } from "vitest";
import { findApprovedPlanActivity } from "../src/server/provider-plan-approval-evidence.js";

const generated = { id: "plan-activity", createTime: "2026-09-27T20:00:00Z",
  planGenerated: { plan: { id: "provider-plan", steps: [{ title: "Implement" }] } } };
const approved = { id: "approval-activity", createTime: "2026-09-27T20:03:00Z",
  planApproved: { planId: "provider-plan" } };
const input = { activities: [generated, approved], planActivityId: "plan-activity",
  startedAt: "2026-09-27T20:02:00Z", historyComplete: true };

describe("started Jules approval read-after-write evidence", () => {
  it("finds a provider approval of the exact current plan after the durable attempt started", () => {
    expect(findApprovedPlanActivity(input)).toBe("approval-activity");
    expect(findApprovedPlanActivity({ ...input, activities: [generated, approved,
      { ...approved, id: "duplicate-provider-projection", createTime: "2026-09-27T20:04:00Z" }] }))
      .toBe("approval-activity");
  });

  it("refuses incomplete history, another plan, pre-attempt approval, and an advanced plan", () => {
    expect(findApprovedPlanActivity({ ...input, historyComplete: false })).toBeNull();
    expect(findApprovedPlanActivity({ ...input, activities: [generated, { ...approved,
      planApproved: { planId: "other-plan" } }] })).toBeNull();
    expect(findApprovedPlanActivity({ ...input, startedAt: "2026-09-27T20:04:00Z" })).toBeNull();
    expect(findApprovedPlanActivity({ ...input, activities: [generated, approved, { ...generated,
      id: "new-plan-activity", createTime: "2026-09-27T20:05:00Z" }] })).toBeNull();
  });
});
