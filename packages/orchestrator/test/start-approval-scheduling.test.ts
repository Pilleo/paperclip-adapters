import { describe, expect, it } from "vitest";
import { selectStartApprovalCandidates } from "../src/core/start-approval-scheduling.js";
import type { ParsedIssueMetadata } from "../src/core/types.js";

function issue(overrides: Partial<ParsedIssueMetadata> = {}): ParsedIssueMetadata {
  return {
    id: "issue-a",
    title: "Task",
    status: "backlog",
    priority: "medium",
    priorityRank: 2,
    dependencies: [],
    targetFiles: ["a.ts"],
    targetModules: [],
    targetSymbols: [],
    hasSideEffects: false,
    coreLock: false,
    needsKernel: false,
    exclusive: false,
    verifyCheap: [],
    isNonInterfering: false,
    openQuestions: false,
    orchestratorManaged: true,
    rawIssue: {},
    ...overrides,
  };
}

describe("start approval scheduling", () => {
  it("authorizes dependent tasks before their blockers become terminal", () => {
    const parent = issue({ id: "a", priorityRank: 3 });
    const child = issue({ id: "b", dependencies: ["a"], priorityRank: 2 });
    expect(selectStartApprovalCandidates([child, parent]).map((candidate) => candidate.id)).toEqual(["a", "b"]);
  });

  it("limits an early approval wave to selected roots and their dependents", () => {
    const root = issue({ id: "a", priorityRank: 3 });
    const dependent = issue({ id: "b", dependencies: ["a"], priorityRank: 2 });
    const unrelated = issue({ id: "c", targetFiles: ["unrelated.ts"], priorityRank: 1 });

    expect(selectStartApprovalCandidates([root, dependent, unrelated], [root.id]).map((candidate) => candidate.id))
      .toEqual(["a", "b"]);
  });

  it("authorizes a root sharing a selected root's file before either can be dispatched together", () => {
    const integer = issue({ id: "03", targetFiles: ["numbers.js", "int.test.js"], priorityRank: 3 });
    const decimal = issue({ id: "04", targetFiles: ["numbers.js", "decimal.test.js"], priorityRank: 2 });
    const pair = issue({ id: "14", targetFiles: ["pair.js"], dependencies: ["03", "04"], priorityRank: 1 });
    const unrelated = issue({ id: "unrelated", targetFiles: ["other.js"], priorityRank: 0 });

    expect(selectStartApprovalCandidates([integer, decimal, pair, unrelated], [integer.id])
      .map((candidate) => candidate.id)).toEqual(["03", "04", "14"]);
  });

  it("completes a pending root's shared-file wave even while other unapproved roots consume dispatch slots", () => {
    const selectedA = issue({ id: "01", targetFiles: ["first.js"], priorityRank: 5 });
    const selectedB = issue({ id: "02", targetFiles: ["second.js"], priorityRank: 4 });
    const pendingRoot = issue({ id: "03", targetFiles: ["numbers.js", "int.test.js"], priorityRank: 3 });
    const competingRoot = issue({ id: "04", targetFiles: ["numbers.js", "decimal.test.js"], priorityRank: 2 });
    const join = issue({ id: "14", targetFiles: ["pair.js"], dependencies: ["03", "04"], priorityRank: 1 });

    expect(selectStartApprovalCandidates([selectedA, selectedB, pendingRoot, competingRoot, join],
      ["01", "02"], ["03"]).map((candidate) => candidate.id)).toEqual(["01", "02", "03", "04", "14"]);
  });

  it.each([
    ["unmanaged", issue({ orchestratorManaged: false })],
    ["question", issue({ openQuestions: true })],
    ["active", issue({ status: "in_progress" })],
    ["terminal", issue({ status: "done" })],
    ["review child", issue({ isDelegatedReviewChild: true })],
  ])("does not create a start approval for %s work", (_name, candidate) => {
    expect(selectStartApprovalCandidates([candidate])).toEqual([]);
  });
});
