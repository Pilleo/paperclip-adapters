import { describe, it, expect } from "vitest";
import { evaluateScopeConformity, ScopeConformityParams } from "../src/core/scope-conformity.js";

describe("Plan vs Diff Scope Conformity Checker", () => {
  it("evaluates clean scope when modified files match declared target files exactly", () => {
    const params: ScopeConformityParams = {
      declaredTargetFiles: ["src/core/Engine.ts", "src/test/Engine.test.ts"],
      declaredTargetSymbols: ["Engine.process"],
      modifiedFiles: ["src/core/Engine.ts", "src/test/Engine.test.ts"],
      rawDiff: "function process() { ... }",
    };

    const report = evaluateScopeConformity(params);
    expect(report.isConformant).toBe(true);
    expect(report.unplannedFiles).toHaveLength(0);
    expect(report.missingTargetFiles).toHaveLength(0);
    expect(report.conformityScore).toBe(100);
  });

  it("detects unplanned file sprawl when agent modifies files outside the plan", () => {
    const params: ScopeConformityParams = {
      declaredTargetFiles: ["src/core/Engine.ts"],
      declaredTargetSymbols: [],
      modifiedFiles: ["src/core/Engine.ts", "src/unrelated/Config.ts", "README.md"],
      rawDiff: "",
    };

    const report = evaluateScopeConformity(params);
    expect(report.isConformant).toBe(false);
    expect(report.unplannedFiles).toContain("src/unrelated/Config.ts");
    expect(report.unplannedFiles).toContain("README.md");
  });

  it("detects missing files when agent forgets a declared target file from the plan", () => {
    const params: ScopeConformityParams = {
      declaredTargetFiles: ["src/core/Engine.ts", "src/core/Driver.ts"],
      declaredTargetSymbols: [],
      modifiedFiles: ["src/core/Engine.ts"],
      rawDiff: "",
    };

    const report = evaluateScopeConformity(params);
    expect(report.isConformant).toBe(false);
    expect(report.missingTargetFiles).toContain("src/core/Driver.ts");
  });

  it("formats scope report section for inclusion in review prompts", () => {
    const params: ScopeConformityParams = {
      declaredTargetFiles: ["src/core/Engine.ts"],
      declaredTargetSymbols: ["Engine.start"],
      modifiedFiles: ["src/core/Engine.ts", "src/other/Extra.ts"],
      rawDiff: "",
    };

    const report = evaluateScopeConformity(params);
    expect(report.summaryText).toMatch(/Scope Drift Detected/);
    expect(report.summaryText).toContain("src/other/Extra.ts");
  });
});
