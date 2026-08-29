import { describe, it, expect } from "vitest";
import { lintBacklogMarkdown, validateBacklogDirectory, parseSymbolTarget } from "../src/linter.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("Deep Linter & Backlog Directory Validation", () => {
  it("parses symbol targets with # and . delimiters", () => {
    expect(parseSymbolTarget("Class#method")).toEqual({
      symbol: "Class#method",
      className: "Class",
      methodName: "method",
    });
    expect(parseSymbolTarget("io.mazewall.Class.method")).toEqual({
      symbol: "io.mazewall.Class.method",
      className: "io.mazewall.Class",
      methodName: "method",
    });
    expect(parseSymbolTarget("SimpleSymbol")).toEqual({
      symbol: "SimpleSymbol",
    });
  });

  it("validates entire backlog directory recursively including resolved subdirs", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "backlog-test-"));
    const resolvedDir = path.join(tmpDir, "resolved");
    fs.mkdirSync(resolvedDir);

    const validContent = `---
title: "Valid task"
severity: "HIGH"
status: "open"
priority: "high"
component: "enforcer"
target_modules: [":enforcer"]
target_files: ["enforcer/src/Landlock.kt"]
---
**Context:** Some context
**Needed:** Some steps`;

    const invalidContent = `---
title: ""
severity: "INVALID_SEVERITY"
status: "invalid_status"
component: "invalid_comp"
target_modules: [":invalid-mod"]
---
`;

    fs.writeFileSync(path.join(tmpDir, "issue-20260801-120000-valid-task.md"), validContent);
    fs.writeFileSync(path.join(resolvedDir, "issue-20260801-120001-invalid-task.md"), invalidContent);

    const result = validateBacklogDirectory(tmpDir);
    expect(result.totalIssues).toBe(2);
    expect(result.validCount).toBe(1);
    expect(result.errors.length).toBeGreaterThan(0);

    // Test non-existent dir
    const nonExistent = validateBacklogDirectory("/path/to/nothing/404");
    expect(nonExistent.totalIssues).toBe(0);
    expect(nonExistent.errors[0]?.message).toBe("Directory does not exist");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("flags open questions in frontmatter and markdown body", () => {
    const content = `---
title: "Task with question"
severity: "MEDIUM"
status: "open"
priority: "medium"
component: "docs"
target_modules: [":platform"]
target_files: ["docs/presentation/presentation.html"]
open_questions: true
---
**Context:** Context info
**Needed:** Needed info
## ❓ Open Questions
- Should we support X?`;

    const res = lintBacklogMarkdown(content, "issue-20260801-130000-question.md");
    expect(res.errors).toEqual([]);
    expect(res.needsClarification).toBe(true);
    expect(res.isValid).toBe(true);
  });
});
