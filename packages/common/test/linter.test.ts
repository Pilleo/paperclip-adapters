import { describe, it, expect } from "vitest";
import {
  lintBacklogMarkdown,
  parseSymbolTarget,
  VALID_SEVERITIES,
  VALID_COMPONENTS,
  VALID_GRADLE_MODULES,
} from "../src/index.js";

describe("Strict Backlog Linter - Parameterized Validation Suite", () => {
  it.each(VALID_SEVERITIES)("accepts valid severity: %s", (severity) => {
    const md = `---
title: "Fix issue with ${severity}"
severity: "${severity}"
component: "enforcer"
target_modules: [":enforcer"]
target_files: ["enforcer/src/Native.kt"]
---

**Context:** Test context for ${severity}.
**Needed:** Test needed fix.
`;
    const res = lintBacklogMarkdown(md, "issue-20260829-123045-test.md");
    expect(res.isValid).toBe(true);
    expect(res.normalizedMetadata.severity).toBe(severity);
  });

  it.each(["INVALID", "SUPER_CRITICAL", "URGENT", "P1"])(
    "rejects invalid severity: %s",
    (invalidSeverity) => {
      const md = `---
title: "Invalid severity test"
severity: "${invalidSeverity}"
component: "enforcer"
target_modules: [":enforcer"]
target_files: ["enforcer/src/Native.kt"]
---
**Context:** Foo
**Needed:** Bar
`;
      const res = lintBacklogMarkdown(md, "issue-20260829-123045-test.md");
      expect(res.isValid).toBe(false);
      expect(res.errors.some((e) => e.includes("Invalid severity"))).toBe(true);
    }
  );

  it.each(VALID_COMPONENTS)("accepts valid canonical component: %s", (component) => {
    const md = `---
title: "Test component ${component}"
component: "${component}"
target_modules: [":enforcer"]
target_files: ["file.kt"]
---
**Context:** Valid component.
**Needed:** Valid fix.
`;
    const res = lintBacklogMarkdown(md, "issue-20260829-123045-comp.md");
    expect(res.isValid).toBe(true);
    expect(res.normalizedMetadata.component).toBe(component);
  });

  it.each([":invalid", ":unknown:tool", "core", "platform"])(
    "rejects non-canonical Gradle module: %s",
    (invalidModule) => {
      const md = `---
title: "Invalid module"
component: "enforcer"
target_modules: ["${invalidModule}"]
target_files: ["foo.kt"]
---
**Context:** Foo
**Needed:** Bar
`;
      const res = lintBacklogMarkdown(md, "issue-20260829-123045-mod.md");
      expect(res.isValid).toBe(false);
      expect(res.errors.some((e) => e.includes("Invalid target module"))).toBe(true);
    }
  );

  it("accepts npm workspace target_modules for this adapters monorepo", () => {
    const md = `---
title: "Plan ladder on Jules"
component: "orchestrator"
target_modules: ["packages/jules", "@pilleo/paperclip-jules-adapter"]
target_files: ["packages/jules/src/server/plan-reviewer.ts"]
target_symbols: ["evaluatePlanClarity"]
---
**Context:** Plan review must try Mistral before Luna.
**Needed:** Keep Mistral first; Terra is Codex.
`;
    const res = lintBacklogMarkdown(md, "issue-20260830-210000-plan-ladder.md");
    expect(res.isValid).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it("rejects generic core or platform strings not prefixed", () => {
    const md = `---
title: "Test Reject generic modules"
component: "orchestrator"
target_modules: ["core", "platform"]
target_files: ["packages/jules/src/server/plan-reviewer.ts"]
target_symbols: ["evaluatePlanClarity"]
---
**Context:** Generic names
**Needed:** Fix generic names
`;
    const res = lintBacklogMarkdown(md, "issue-20260830-210001-generic-names.md");
    expect(res.isValid).toBe(false);
    expect(res.errors.some((e) => e.includes("Invalid target module 'core'"))).toBe(true);
    expect(res.errors.some((e) => e.includes("Invalid target module 'platform'"))).toBe(true);
  });

  describe.each([
    { input: "BpfFilter#compile", expectedClass: "BpfFilter", expectedMethod: "compile" },
    { input: "io.mazewall.Landlock.ruleset", expectedClass: "io.mazewall.Landlock", expectedMethod: "ruleset" },
    { input: "PureJavaBpfEngine#compileArm64", expectedClass: "PureJavaBpfEngine", expectedMethod: "compileArm64" },
    { input: "LinuxNative", expectedClass: undefined, expectedMethod: undefined },
  ])("Symbol Target Parser: %o", ({ input, expectedClass, expectedMethod }) => {
    it(`parses "${input}" correctly`, () => {
      const parsed = parseSymbolTarget(input);
      expect(parsed.className).toBe(expectedClass);
      expect(parsed.methodName).toBe(expectedMethod);
    });
  });

  it.each([
    { filename: "issue-20260829-123045-fix-bug.md", valid: true },
    { filename: "issue-20260829_123045-fix-bug.md", valid: true },
    { filename: "issue-123-short-slug.md", valid: true },
    { filename: "invalid_name.md", valid: false },
    { filename: "issue-without-date.md", valid: false },
  ])("validates filename format: $filename (valid: $valid)", ({ filename, valid }) => {
    const md = `---
title: "Filename check"
component: "enforcer"
target_modules: [":enforcer"]
target_files: ["foo.kt"]
---
**Context:** Foo
**Needed:** Bar
`;
    const res = lintBacklogMarkdown(md, filename);
    const hasFilenameError = res.errors.some((e) => e.includes("Invalid filename format"));
    expect(hasFilenameError).toBe(!valid);
  });
});
