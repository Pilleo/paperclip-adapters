import { describe, expect, it } from "vitest";
import { decideTerminalDisposition } from "../src/server/terminal-disposition.js";

describe("terminal Jules disposition", () => {
  it.each([
    [{ providerState: "COMPLETED", requiresPr: true, hasPr: false, hasUnapprovedPlan: true, hasPendingPlanReview: false }, "create_plan_review"],
    [{ providerState: "COMPLETED", requiresPr: true, hasPr: false, hasUnapprovedPlan: true, hasPendingPlanReview: true }, "resume_pending_plan_review"],
    [{ providerState: "COMPLETED", requiresPr: true, hasPr: false, hasUnapprovedPlan: false, hasPendingPlanReview: false }, "block_missing_pr"],
    [{ providerState: "COMPLETED", requiresPr: false, hasPr: false, hasUnapprovedPlan: false, hasPendingPlanReview: false }, "request_no_pr_confirmation"],
    [{ providerState: "COMPLETED", requiresPr: true, hasPr: true, hasUnapprovedPlan: false, hasPendingPlanReview: false }, "handoff_pr"],
  ] as const)("routes %o to %s", (input, action) => {
    expect(decideTerminalDisposition(input).action).toBe(action);
  });
});
