import { describe, expect, it } from "vitest";
import { planTerminalParentBarrier, type BarrierIssue, type BarrierRun } from "../src/core/terminal-parent-barrier.js";

const parent: BarrierIssue = { id: "parent-1", status: "done" };

describe("terminal parent barrier", () => {
  it("plans cancellation before closing every nonterminal descendant", () => {
    const result = planTerminalParentBarrier({
      parent,
      descendants: [
        { id: "child-1", status: "blocked" },
        { id: "child-2", status: "in_progress" },
        { id: "child-3", status: "done" },
      ],
      runs: [
        { id: "run-1", issueId: "child-1", status: "queued" },
        { id: "run-2", issueId: "child-2", status: "running" },
        { id: "run-3", issueId: "child-3", status: "running" },
      ],
    });

    expect(result).toEqual({
      cancelRunIds: ["run-1", "run-2"],
      closeIssueIds: ["child-1", "child-2"],
      reason: "parent-1 is terminal",
    });
  });

  it("is a no-op for a nonterminal parent and terminal descendants", () => {
    expect(planTerminalParentBarrier({
      parent: { id: "parent-1", status: "in_progress" },
      descendants: [{ id: "child-1", status: "done" }],
      runs: [],
    })).toEqual({ cancelRunIds: [], closeIssueIds: [], reason: null });
  });

  it("deduplicates run and child ids deterministically", () => {
    const runs: BarrierRun[] = [
      { id: "run-1", issueId: "child-1", status: "running" },
      { id: "run-1", issueId: "child-1", status: "queued" },
    ];
    expect(planTerminalParentBarrier({
      parent,
      descendants: [{ id: "child-1", status: "blocked" }, { id: "child-1", status: "blocked" }],
      runs,
    })).toMatchObject({ cancelRunIds: ["run-1"], closeIssueIds: ["child-1"] });
  });
});
