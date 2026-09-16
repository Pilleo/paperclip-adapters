import { describe, expect, it } from "vitest";
import { decideTerminalDisposition } from "../src/server/terminal-disposition.js";

describe("terminal Jules disposition", () => {
  it.each([
    // Jules can report FAILED for an ephemeral cloud-VM setup problem even
    // though the same session accepts a subsequent `retry` instruction.
    [{ providerState: "FAILED", requiresPr: true, hasPr: false, hasUnapprovedPlan: false, hasPendingPlanReview: false, failedSessionRetryCount: 0 }, "retry_failed_session"],
    [{ providerState: "FAILED", requiresPr: true, hasPr: false, hasUnapprovedPlan: false, hasPendingPlanReview: false, failedSessionRetryCount: 1 }, "block_missing_pr"],
    [{ providerState: "COMPLETED", requiresPr: true, hasPr: false, hasUnapprovedPlan: true, hasPendingPlanReview: false }, "create_plan_review"],
    [{ providerState: "COMPLETED", requiresPr: true, hasPr: false, hasUnapprovedPlan: true, hasPendingPlanReview: true }, "resume_pending_plan_review"],
    [{ providerState: "COMPLETED", requiresPr: true, hasPr: false, hasUnapprovedPlan: false, hasPendingPlanReview: false, missingPrRetryCount: 1 }, "block_missing_pr"],
    // A task whose own contract requires a PR must not fall into a human
    // no-PR confirmation merely because the fleet-wide policy is `auto`.
    // The adapter gets one typed provider continuation before failing closed.
    [{ providerState: "COMPLETED", requiresPr: true, hasPr: false, hasUnapprovedPlan: false, hasPendingPlanReview: false, missingPrRetryCount: 0 }, "resume_missing_pr"],
    [{ providerState: "COMPLETED", requiresPr: false, hasPr: false, hasUnapprovedPlan: false, hasPendingPlanReview: false }, "request_no_pr_confirmation"],
    [{ providerState: "COMPLETED", requiresPr: true, hasPr: true, hasUnapprovedPlan: false, hasPendingPlanReview: false }, "handoff_pr"],
  ] as const)("routes %o to %s", (input, action) => {
    expect(decideTerminalDisposition(input).action).toBe(action);
  });
});
