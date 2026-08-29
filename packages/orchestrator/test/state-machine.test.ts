import { describe, it, expect } from "vitest";
import { evaluateIssueTransition } from "../src/core/state-machine.js";

describe("Issue State Machine", () => {
  it("allows DISPATCH from backlog or todo to in_progress", () => {
    const res1 = evaluateIssueTransition("backlog", null, {
      type: "DISPATCH",
      targetAgentId: "agent-1",
      reason: "Ready to work",
    });
    expect(res1.isAllowed).toBe(true);
    expect(res1.toStatus).toBe("in_progress");
    expect(res1.updatedAssigneeAgentId).toBe("agent-1");

    const res2 = evaluateIssueTransition("todo", null, {
      type: "DISPATCH",
      targetAgentId: "agent-2",
      reason: "Ready to work",
    });
    expect(res2.isAllowed).toBe(true);
    expect(res2.toStatus).toBe("in_progress");
  });

  it("rejects DISPATCH on terminal or in_review states", () => {
    const res = evaluateIssueTransition("done", "agent-1", {
      type: "DISPATCH",
      targetAgentId: "agent-2",
      reason: "Try to redispatch",
    });
    expect(res.isAllowed).toBe(false);
    expect(res.toStatus).toBe("done");
  });

  it("allows SUBMIT_FOR_REVIEW from in_progress to in_review", () => {
    const res = evaluateIssueTransition("in_progress", "dev-agent", {
      type: "SUBMIT_FOR_REVIEW",
      reviewerAgentId: "reviewer-agent",
      prUrl: "https://github.com/Pilleo/mazewall/pull/500",
    });
    expect(res.isAllowed).toBe(true);
    expect(res.toStatus).toBe("in_review");
    expect(res.updatedAssigneeAgentId).toBe("reviewer-agent");
  });

  it("allows APPROVE_AND_MERGE from in_review to done", () => {
    const res = evaluateIssueTransition("in_review", "reviewer-agent", {
      type: "APPROVE_AND_MERGE",
      prNumber: 500,
    });
    expect(res.isAllowed).toBe(true);
    expect(res.toStatus).toBe("done");
    expect(res.reason).toContain("PR #500 merged on GitHub");
  });

  it("allows REQUEST_CHANGES from in_review back to todo", () => {
    const res = evaluateIssueTransition("in_review", "reviewer-agent", {
      type: "REQUEST_CHANGES",
      feedback: "Please fix failing test assertions",
    });
    expect(res.isAllowed).toBe(true);
    expect(res.toStatus).toBe("todo");
    expect(res.updatedAssigneeAgentId).toBeNull();
  });

  it("allows BLOCK and UNBLOCK transitions", () => {
    const blockRes = evaluateIssueTransition("backlog", null, {
      type: "BLOCK",
      blockerIds: ["MAZ-1", "MAZ-2"],
    });
    expect(blockRes.isAllowed).toBe(true);
    expect(blockRes.toStatus).toBe("blocked");

    const unblockRes = evaluateIssueTransition("blocked", null, {
      type: "UNBLOCK",
    });
    expect(unblockRes.isAllowed).toBe(true);
    expect(unblockRes.toStatus).toBe("backlog");
  });
});
