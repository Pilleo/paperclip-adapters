import { describe, expect, it } from "vitest";
import { hasDelegatedReviewChild, isDelegatedReviewChild } from "../src/core/recovery-eligibility.js";
import { ParsedIssueMetadata } from "../src/core/types.js";

const issue = (id: string, parentId: string | null, description: string): ParsedIssueMetadata => ({
  id,
  identifier: id,
  title: id,
  status: "blocked",
  priority: "low",
  priorityRank: 1,
  dependencies: [],
  targetFiles: [],
  targetModules: [],
  targetSymbols: [],
  hasSideEffects: true,
  coreLock: false,
  needsKernel: false,
  exclusive: false,
  verifyCheap: [],
  isNonInterfering: false,
  openQuestions: false,
  orchestratorManaged: false,
  parentId,
  rawIssue: { description },
});

describe("delegated review recovery eligibility", () => {
  it("recognizes marked Jules coordination records even when historical parent linkage is absent", () => {
    expect(isDelegatedReviewChild(issue("child", "parent", "<!-- jules-plan-review:x -->"))).toBe(true);
    expect(isDelegatedReviewChild(issue("unparented", null, "<!-- jules-plan-review:x -->"))).toBe(true);
    expect(isDelegatedReviewChild(issue("question", null, "<!-- jules-question-adjudication:x -->"))).toBe(true);
    expect(isDelegatedReviewChild(issue("ordinary", "parent", "normal task"))).toBe(false);
  });

  it("protects the parent while a delegated child exists", () => {
    const parent = issue("parent", null, "normal task");
    const child = issue("child", "parent", "<!-- jules-plan-review:x -->");
    expect(hasDelegatedReviewChild(parent.id, [parent, child])).toBe(true);
  });

  it("releases the parent after the delegated child reaches a terminal state", () => {
    const parent = issue("parent", null, "normal task");
    const child = { ...issue("child", "parent", "<!-- jules-plan-review:x -->"), status: "done" };
    expect(hasDelegatedReviewChild(parent.id, [parent, child])).toBe(false);
  });
});
