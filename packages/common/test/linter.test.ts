import { describe, it, expect } from "vitest";
import { lintBacklogMarkdown } from "../src/index.js";

describe("Backlog Linter", () => {
  it("validates a compliant backlog markdown file", () => {
    const md = `---
title: "Fix NullPointer in Downcall"
severity: "HIGH"
priority: high
component: "enforcer"
target_files: ["enforcer/src/Native.kt"]
---

# 🔴 [Severity: HIGH]: Fix NullPointer in Downcall
**Context:** Off-heap layout alignment issue.
**Needed:** Fix the alignment in ValueLayout.
`;
    const res = lintBacklogMarkdown(md, "issue-1.md");
    expect(res.isValid).toBe(true);
    expect(res.errors).toHaveLength(0);
    expect(res.normalizedMetadata.title).toBe("Fix NullPointer in Downcall");
    expect(res.normalizedMetadata.component).toBe("enforcer");
    expect(res.normalizedMetadata.priority).toBe("high");
    expect(res.needsClarification).toBe(false);
  });

  it("flags missing frontmatter as error", () => {
    const md = "# Just raw markdown";
    const res = lintBacklogMarkdown(md);
    expect(res.isValid).toBe(false);
    expect(res.errors).toContain("Missing YAML frontmatter block (--- ... ---)");
  });

  it("detects open questions and sets needsClarification", () => {
    const md = `---
title: "Investigate memory layout"
component: "enforcer"
open_questions: true
---

**Context:** Need more info.
**Needed:** Ask the operator.

## ❓ Open Questions
1. Should we support ARM64?
`;
    const res = lintBacklogMarkdown(md);
    expect(res.isValid).toBe(true);
    expect(res.needsClarification).toBe(true);
  });
});
