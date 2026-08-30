import { describe, it, expect } from "vitest";
import { extractIssueMetadata } from "../src/core/parser.js";
import { calculateConflictMatrix, isExclusiveLock, issueConflictReason } from "../src/core/dispatcher.js";

describe("mazewall lock semantics", () => {
  it("parses core_lock exclusive needs_kernel open_questions", () => {
    const meta = extractIssueMetadata({
      id: "i1",
      identifier: "MAZ-1",
      title: "Kernel change",
      status: "todo",
      description: `---
core_lock: true
needs_kernel: true
exclusive: true
open_questions: true
has_side_effects: false
target_files:
  - enforcer/src/A.kt
target_symbols:
  - Foo.bar
---
`,
    });
    expect(meta.coreLock).toBe(true);
    expect(meta.needsKernel).toBe(true);
    expect(meta.exclusive).toBe(true);
    expect(meta.openQuestions).toBe(true);
    expect(meta.hasSideEffects).toBe(false);
    expect(isExclusiveLock(meta)).toBe(true);
  });

  it("treats empty files and modules as exclusive", () => {
    const a = extractIssueMetadata({
      id: "a",
      identifier: "MAZ-10",
      title: "A",
      status: "todo",
      description: "---\npriority: high\n---",
    });
    const b = extractIssueMetadata({
      id: "b",
      identifier: "MAZ-11",
      title: "B",
      status: "todo",
      description: "---\npriority: high\n---",
    });
    expect(isExclusiveLock(a)).toBe(true);
    expect(issueConflictReason(a, b)).toMatch(/Exclusive/);
  });

  it("collides Foo#bar with Foo.bar", () => {
    const a = extractIssueMetadata({
      id: "a",
      title: "A",
      status: "todo",
      description: `---
has_side_effects: false
target_files: ["enforcer/src/Foo.kt"]
target_modules: [":enforcer"]
target_symbols: ["Foo#bar"]
---`,
    });
    const b = extractIssueMetadata({
      id: "b",
      title: "B",
      status: "todo",
      description: `---
has_side_effects: false
target_files: ["enforcer/src/Foo.kt"]
target_modules: [":enforcer"]
target_symbols: ["Foo.bar"]
---`,
    });
    expect(issueConflictReason(a, b)).toMatch(/symbol/i);
  });

  it("allows disjoint symbols in the same file when has_side_effects is false", () => {
    const a = extractIssueMetadata({
      id: "a",
      title: "A",
      status: "todo",
      description: `---
has_side_effects: false
target_files: ["enforcer/src/Foo.kt"]
target_modules: [":enforcer"]
target_symbols: ["Foo#one"]
---`,
    });
    const b = extractIssueMetadata({
      id: "b",
      title: "B",
      status: "todo",
      description: `---
has_side_effects: false
target_files: ["enforcer/src/Foo.kt"]
target_modules: [":enforcer"]
target_symbols: ["Foo#two"]
---`,
    });
    expect(issueConflictReason(a, b)).toBeNull();
    expect(calculateConflictMatrix([a, b]).conflictEdges).toHaveLength(0);
  });
});
