import { describe, it, expect } from "vitest";
import { evaluateIssueTransition } from "../src/core/state-machine.js";

describe("Deep State Machine Transition Matrix", () => {
  it("handles REQUEST_CHANGES event when in_review", () => {
    const res = evaluateIssueTransition("in_review", "agent-1", { type: "REQUEST_CHANGES", feedback: "Fix FFM layout" });

    expect(res.isAllowed).toBe(true);
    expect(res.fromStatus).toBe("in_review");
    expect(res.toStatus).toBe("todo");
    expect(res.updatedAssigneeAgentId).toBeNull();
    expect(res.reason).toContain("Fix FFM layout");
  });

  it("rejects REQUEST_CHANGES when not in_review", () => {
    const res = evaluateIssueTransition("in_progress", "agent-1", { type: "REQUEST_CHANGES" });

    expect(res.isAllowed).toBe(false);
    expect(res.toStatus).toBe("in_progress");
    expect(res.reason).toContain("Cannot request changes when not in review");
  });

  it("handles CANCEL event on active tasks but rejects on completed tasks", () => {
    const cancelRes = evaluateIssueTransition("todo", "agent-1", { type: "CANCEL", reason: "Superseded" });
    expect(cancelRes.isAllowed).toBe(true);
    expect(cancelRes.toStatus).toBe("cancelled");

    const doneCancelRes = evaluateIssueTransition("done", "agent-1", { type: "CANCEL" });
    expect(doneCancelRes.isAllowed).toBe(false);
    expect(doneCancelRes.reason).toContain("Cannot cancel an already completed task");
  });

  it("handles BLOCK and UNBLOCK lifecycle", () => {
    const blockRes = evaluateIssueTransition("todo", "agent-1", { type: "BLOCK", blockerIds: ["MAZ-99"] });
    expect(blockRes.isAllowed).toBe(true);
    expect(blockRes.toStatus).toBe("blocked");
    expect(blockRes.reason).toContain("Blocked by MAZ-99");

    const unblockRes = evaluateIssueTransition("blocked", "agent-1", { type: "UNBLOCK" });
    expect(unblockRes.isAllowed).toBe(true);
    expect(unblockRes.toStatus).toBe("backlog");

    const invalidUnblock = evaluateIssueTransition("in_progress", "agent-1", { type: "UNBLOCK" });
    expect(invalidUnblock.isAllowed).toBe(false);
  });
});
