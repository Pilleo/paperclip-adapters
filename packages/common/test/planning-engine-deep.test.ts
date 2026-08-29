import { describe, it, expect } from "vitest";
import { synthesizeDeterministicPlan, extractTestSuitesFromCodannaOutput } from "../src/planning-engine.js";

describe("Deep Planning Engine & Blast Radius Tests", () => {
  it("extracts test files from Codanna call graph output", () => {
    const codannaOutput = `
io.mazewall.enforcer.Landlock#restrict
  Calls:
    - io.mazewall.ffi.LinuxNative#syscall
  Called by:
    - at ./enforcer/src/test/kotlin/io/mazewall/LandlockTest.kt:45
    - in ./enforcer/src/test/kotlin/io/mazewall/SandboxIntegrationSpec.kt:120
    - in ./enforcer/src/main/kotlin/io/mazewall/OtherService.kt:10
`;

    const suites = extractTestSuitesFromCodannaOutput(codannaOutput);
    expect(suites).toContain("enforcer/src/test/kotlin/io/mazewall/LandlockTest.kt");
    expect(suites).toContain("enforcer/src/test/kotlin/io/mazewall/SandboxIntegrationSpec.kt");
    expect(suites).not.toContain("enforcer/src/main/kotlin/io/mazewall/OtherService.kt");
  });

  it("synthesizes deterministic plan with default fallbacks when sections are omitted", () => {
    const rawMarkdown = `---
title: "Minimal Plan"
component: "profiler"
priority: "high"
target_files: ["profiler/src/Profiler.kt"]
target_symbols: ["Profiler#start"]
---
Bare markdown body with no explicit sections.`;

    const plan = synthesizeDeterministicPlan(rawMarkdown, "MAZ-200");
    expect(plan.issueId).toBe("MAZ-200");
    expect(plan.title).toBe("Minimal Plan");
    expect(plan.component).toBe("profiler");
    expect(plan.priority).toBe("high");
    expect(plan.targetFiles).toContain("profiler/src/Profiler.kt");
    expect(plan.targetSymbols[0]?.symbol).toBe("Profiler#start");
    expect(plan.steps.length).toBeGreaterThan(0);
  });
});
