import { describe, it, expect } from "vitest";
import { lintBacklogMarkdown, parseSymbolTarget } from "../src/index.js";

describe("Strict Backlog Linter", () => {
  it("validates a compliant backlog markdown file", () => {
    const md = `---
title: "Fix NullPointer in Downcall"
severity: "HIGH"
priority: high
component: "enforcer"
target_modules: [":enforcer"]
target_files: ["enforcer/src/Native.kt"]
target_symbols: ["NativeLayout#downcallHandle"]
---

# 🔴 [Severity: HIGH]: Fix NullPointer in Downcall
**Context:** Off-heap layout alignment issue.
**Needed:** Fix the alignment in ValueLayout.
`;
    const res = lintBacklogMarkdown(md, "issue-20260829-123045-fix-nullpointer.md");
    expect(res.isValid).toBe(true);
    expect(res.errors).toHaveLength(0);
    expect(res.normalizedMetadata.title).toBe("Fix NullPointer in Downcall");
    expect(res.normalizedMetadata.component).toBe("enforcer");
    expect(res.normalizedMetadata.priority).toBe("high");
    expect(res.normalizedMetadata.targetModules).toContain(":enforcer");
    expect(res.normalizedMetadata.targetSymbols).toContain("NativeLayout#downcallHandle");
    expect(res.needsClarification).toBe(false);
  });

  it("fails if target_modules contains invalid Gradle module", () => {
    const md = `---
title: "Invalid module"
component: "enforcer"
target_modules: [":invalid-module"]
target_files: ["foo.kt"]
---
**Context:** Foo
**Needed:** Bar
`;
    const res = lintBacklogMarkdown(md, "issue-20260829-123045-invalid.md");
    expect(res.isValid).toBe(false);
    expect(res.errors.some((e) => e.includes("Invalid Gradle module"))).toBe(true);
  });

  it("fails if open_questions: true but section is missing", () => {
    const md = `---
title: "Inconsistent questions"
component: "enforcer"
target_modules: [":enforcer"]
target_files: ["foo.kt"]
open_questions: true
---
**Context:** Foo
**Needed:** Bar
`;
    const res = lintBacklogMarkdown(md, "issue-20260829-123045-inconsistent.md");
    expect(res.isValid).toBe(false);
    expect(res.errors.some((e) => e.includes("missing a non-empty '## ❓ Open Questions'"))).toBe(true);
  });

  it("parses method-level granularity target symbols", () => {
    const s1 = parseSymbolTarget("PureJavaBpfEngine#compile");
    expect(s1.className).toBe("PureJavaBpfEngine");
    expect(s1.methodName).toBe("compile");

    const s2 = parseSymbolTarget("io.mazewall.enforcer.Landlock.ruleset");
    expect(s2.className).toBe("io.mazewall.enforcer.Landlock");
    expect(s2.methodName).toBe("ruleset");
  });
});
