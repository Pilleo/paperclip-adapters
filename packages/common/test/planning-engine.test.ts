import { describe, it, expect } from "vitest";
import {
  synthesizeDeterministicPlan,
  formatPlanMarkdown,
  extractTestSuitesFromCodannaOutput,
} from "../src/index.js";

describe("planning-engine", () => {
  const sampleMarkdown = `---
title: "Fix BpfFilter downcall alignment"
component: "enforcer"
priority: high
target_files: ["enforcer/src/main/kotlin/io/mazewall/BpfFilter.kt"]
target_symbols: ["BpfFilter#compile"]
---

**Context:** The FFM downcall layout alignment is 4 bytes instead of 8 bytes on ARM64.
**Needed:** Fix the alignment layout in BpfFilter.kt and verify downcall handles.
`;

  it("synthesizes deterministic plan without AI", () => {
    const plan = synthesizeDeterministicPlan(sampleMarkdown, "issue-101");
    expect(plan.title).toBe("Fix BpfFilter downcall alignment");
    expect(plan.component).toBe("enforcer");
    expect(plan.priority).toBe("high");
    expect(plan.targetFiles).toContain("enforcer/src/main/kotlin/io/mazewall/BpfFilter.kt");
    expect(plan.targetSymbols[0]?.methodName).toBe("compile");
    expect(plan.testFiles).toContain("enforcer/src/test/kotlin/io/mazewall/BpfFilterTest.kt");
    expect(plan.contextSummary).toContain("FFM downcall layout alignment");
    expect(plan.neededSummary).toContain("Fix the alignment layout");
    expect(plan.steps).toHaveLength(3);
  });

  it("formats structured Markdown plan correctly with blast radius", () => {
    const plan = synthesizeDeterministicPlan(sampleMarkdown, "issue-101");
    const planWithBlastRadius = {
      ...plan,
      impactedTestSuites: ["enforcer/src/test/kotlin/io/mazewall/seccomp/HighConcurrencyInstallationTest.kt"],
    };
    const md = formatPlanMarkdown(planWithBlastRadius);
    expect(md).toContain("## 📋 Implementation Plan: Fix BpfFilter downcall alignment");
    expect(md).toContain("Target Methods & Symbols");
    expect(md).toContain("`BpfFilter#compile`");
    expect(md).toContain("Candidate Test Files & Blast Radius");
    expect(md).toContain("⚡ Impacted Caller Test Suites (Codanna Blast Radius)");
    expect(md).toContain("`enforcer/src/test/kotlin/io/mazewall/seccomp/HighConcurrencyInstallationTest.kt`");
    expect(md).toContain("TDD Protocol");
  });

  it("includes Codanna symbol outlines on the short plan by default", () => {
    const plan = synthesizeDeterministicPlan(sampleMarkdown, "issue-101");
    const md = formatPlanMarkdown({
      ...plan,
      semanticSymbolContext: "#### Symbol: `BpfFilter#compile`\n```\nfn compile()\n```",
    });
    expect(md).toContain("Codanna symbol outlines");
    expect(md).toContain("fn compile()");
  });

  describe("extractTestSuitesFromCodannaOutput", () => {
    it.each([
      {
        name: "extracts Kotlin and Java test files from Called by section",
        codannaOutput: `
clearCache (Method) at ./enforcer/src/main/kotlin/io/mazewall/seccomp/PureJavaBpfEngine.kt:38-40 [symbol_id:7375]
Called by 3 function(s):
  - setup at ./enforcer/src/test/kotlin/io/mazewall/seccomp/HighConcurrencyInstallationTest.kt:35 [symbol_id:6315]
  - tearDown at ./enforcer/src/test/java/io/mazewall/JavaInteropSpec.java:43 [symbol_id:6316]
  - internalHelper at ./enforcer/src/main/kotlin/io/mazewall/seccomp/PureJavaBpfEngine.kt:120 [symbol_id:7380]
`,
        expectedTests: [
          "enforcer/src/test/kotlin/io/mazewall/seccomp/HighConcurrencyInstallationTest.kt",
          "enforcer/src/test/java/io/mazewall/JavaInteropSpec.java",
        ],
      },
      {
        name: "ignores non-test source files",
        codannaOutput: `
Called by 1 function(s):
  - helper at ./enforcer/src/main/kotlin/io/mazewall/seccomp/PureJavaBpfEngine.kt:60 [symbol_id:7380]
`,
        expectedTests: [],
      },
      {
        name: "handles empty caller list gracefully",
        codannaOutput: "Defines 0 symbol(s)",
        expectedTests: [],
      },
    ])("$name", ({ codannaOutput, expectedTests }) => {
      const extracted = extractTestSuitesFromCodannaOutput(codannaOutput);
      expect(extracted).toEqual(expectedTests);
    });
  });
});
