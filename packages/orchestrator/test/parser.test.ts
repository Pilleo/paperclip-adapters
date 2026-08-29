import { describe, it, expect } from "vitest";
import { extractIssueMetadata, parsePriorityRank, parseYamlList } from "../src/core/parser.js";

describe("Parser Core Module", () => {
  describe("parsePriorityRank", () => {
    it("maps critical/urgent/blocker to rank 4", () => {
      expect(parsePriorityRank("critical")).toEqual({ priority: "critical", rank: 4 });
      expect(parsePriorityRank("urgent")).toEqual({ priority: "critical", rank: 4 });
      expect(parsePriorityRank("blocker")).toEqual({ priority: "critical", rank: 4 });
    });

    it("maps high/p1 to rank 3", () => {
      expect(parsePriorityRank("high")).toEqual({ priority: "high", rank: 3 });
      expect(parsePriorityRank("p1")).toEqual({ priority: "high", rank: 3 });
    });

    it("maps medium/p2/normal to rank 2", () => {
      expect(parsePriorityRank("medium")).toEqual({ priority: "medium", rank: 2 });
      expect(parsePriorityRank("p2")).toEqual({ priority: "medium", rank: 2 });
      expect(parsePriorityRank("normal")).toEqual({ priority: "medium", rank: 2 });
    });

    it("defaults unknown or null priorities to low rank 1", () => {
      expect(parsePriorityRank("low")).toEqual({ priority: "low", rank: 1 });
      expect(parsePriorityRank(null)).toEqual({ priority: "low", rank: 1 });
      expect(parsePriorityRank(undefined)).toEqual({ priority: "low", rank: 1 });
      expect(parsePriorityRank("custom-unknown")).toEqual({ priority: "low", rank: 1 });
    });
  });

  describe("parseYamlList", () => {
    it("handles native string arrays", () => {
      expect(parseYamlList(["a", "b", "  c  "])).toEqual(["a", "b", "c"]);
    });

    it("handles inline json-like brackets [a, b]", () => {
      expect(parseYamlList('["file1.kt", "file2.kt"]')).toEqual(["file1.kt", "file2.kt"]);
      expect(parseYamlList("[file1.kt, file2.kt]")).toEqual(["file1.kt", "file2.kt"]);
    });

    it("handles single string items", () => {
      expect(parseYamlList("single-item")).toEqual(["single-item"]);
      expect(parseYamlList("")).toEqual([]);
    });

    it("returns empty array for invalid inputs", () => {
      expect(parseYamlList(null)).toEqual([]);
      expect(parseYamlList(123)).toEqual([]);
    });
  });

  describe("extractIssueMetadata", () => {
    it("parses full YAML frontmatter correctly", () => {
      const issue = {
        id: "issue-123",
        identifier: "MAZ-100",
        issueNumber: 100,
        title: "Test Feature",
        status: "backlog",
        description: `---
priority: high
component: "enforcer"
target_files:
  - "enforcer/src/main/kotlin/io/mazewall/BpfFilter.kt"
target_modules:
  - ":enforcer"
target_symbols:
  - "BpfFilter.install"
dependencies:
  - "MAZ-99"
has_side_effects: false
---
# Context
Detailed context here.`,
      };

      const meta = extractIssueMetadata(issue);
      expect(meta.id).toBe("issue-123");
      expect(meta.identifier).toBe("MAZ-100");
      expect(meta.issueNumber).toBe(100);
      expect(meta.priority).toBe("high");
      expect(meta.priorityRank).toBe(3);
      expect(meta.component).toBe("enforcer");
      expect(meta.targetFiles).toEqual(["enforcer/src/main/kotlin/io/mazewall/BpfFilter.kt"]);
      expect(meta.targetModules).toEqual([":enforcer"]);
      expect(meta.targetSymbols).toEqual(["BpfFilter.install"]);
      expect(meta.dependencies).toEqual(["MAZ-99"]);
      expect(meta.hasSideEffects).toBe(false);
      expect(meta.isNonInterfering).toBe(false);
      expect(Object.isFrozen(meta)).toBe(true);
    });

    it("identifies docs/ci/review non-interfering tasks", () => {
      const docsIssue = extractIssueMetadata({
        id: "docs-1",
        title: "Update README",
        status: "todo",
        description: "---\ncomponent: \"docs\"\n---",
      });
      expect(docsIssue.isNonInterfering).toBe(true);

      const reviewIssue = extractIssueMetadata({
        id: "review-1",
        identifier: "MAZ-review-task",
        title: "Security Audit",
        status: "todo",
        description: "Review task description",
      });
      expect(reviewIssue.isNonInterfering).toBe(true);
    });

    it("falls back to markdown tags when frontmatter is absent", () => {
      const issue = {
        id: "issue-fallback",
        title: "Fallback Task",
        status: "todo",
        description: `
Files: [src/A.kt, src/B.kt]
Modules: [:core]
Symbols: [MySymbol]
Depends_on: [MAZ-1]
`,
      };

      const meta = extractIssueMetadata(issue);
      expect(meta.targetFiles).toEqual(["src/A.kt", "src/B.kt"]);
      expect(meta.targetModules).toEqual([":core"]);
      expect(meta.targetSymbols).toEqual(["MySymbol"]);
      expect(meta.dependencies).toEqual(["MAZ-1"]);
    });
  });
});
