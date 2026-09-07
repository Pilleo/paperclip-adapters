import { describe, expect, it } from "vitest";
import { selectStaleJulesReviewChildren } from "../src/core/stale-review-artifacts.js";

describe("selectStaleJulesReviewChildren", () => {
  it.each([
    ["legacy supervisor marker", "jules-session-supervisor canary"],
    ["question adjudication marker", "jules-question-adjudication canary"],
    ["explicit productivity review", undefined],
  ])("selects a non-terminal %s child regardless of project omission", (_label, description) => {
    const children = [{
      id: "child-1",
      parentId: "parent-1",
      status: "in_progress",
      ...(description ? { description } : { originKind: "issue_productivity_review" }),
    }];

    expect(selectStaleJulesReviewChildren("parent-1", children)).toEqual(["child-1"]);
  });

  it("accepts children from the parent route when parentId is omitted", () => {
    expect(selectStaleJulesReviewChildren("parent-1", [
      { id: "child-1", status: "todo", description: "jules-session-supervisor canary" },
    ])).toEqual(["child-1"]);
  });

  it("does not select generic, terminal, malformed, or unrelated children", () => {
    expect(selectStaleJulesReviewChildren("parent-1", [
      { id: "generic", parentId: "parent-1", status: "in_progress", description: "ordinary child" },
      { id: "done", parentId: "parent-1", status: "done", description: "jules-session-supervisor" },
      { id: "cancelled", parentId: "parent-1", status: "cancelled", originKind: "issue_productivity_review" },
      { id: "wrong-parent", parentId: "parent-2", status: "in_progress", originKind: "issue_productivity_review" },
      { parentId: "parent-1", status: "in_progress", originKind: "issue_productivity_review" },
    ])).toEqual([]);
  });

  it("returns deterministic unique ids", () => {
    const children = [
      { id: "child-2", parentId: "parent-1", status: "blocked", description: "jules-question-adjudication" },
      { id: "child-1", parentId: "parent-1", status: "in_review", originKind: "issue_productivity_review" },
      { id: "child-2", parentId: "parent-1", status: "blocked", description: "jules-question-adjudication" },
    ];
    expect(selectStaleJulesReviewChildren("parent-1", children)).toEqual(["child-1", "child-2"]);
  });
});
