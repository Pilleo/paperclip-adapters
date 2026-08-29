import { describe, it, expect } from "vitest";
import { synthesizeTokenFriendlyReviewPrompt } from "../src/core/review-synthesizer.js";
import { ParsedIssueMetadata } from "../src/core/types.js";

describe("Token-Friendly Review Synthesizer", () => {
  const sampleIssue: ParsedIssueMetadata = {
    id: "issue-101",
    identifier: "MAZ-101",
    title: "Support PureJavaBpfEngine Cache Clearing",
    status: "in_review",
    priority: "high",
    priorityRank: 2,
    dependencies: [],
    targetFiles: ["enforcer/src/main/kotlin/io/mazewall/PureJavaBpfEngine.kt"],
    targetModules: [":enforcer"],
    targetSymbols: ["PureJavaBpfEngine#clearCache"],
    hasSideEffects: false,
    component: "enforcer",
    isNonInterfering: false,
    rawIssue: {},
  };

  it("synthesizes compact token-efficient review prompt with symbols and blast radius", () => {
    const prompt = synthesizeTokenFriendlyReviewPrompt({
      issue: sampleIssue,
      prUrl: "https://github.com/Pilleo/mazewall/pull/42",
      prNumber: 42,
      branchName: "jules/issue-101-cache-clear",
      testBlastRadius: ["enforcer/src/test/kotlin/io/mazewall/HighConcurrencyInstallationTest.kt"],
      invariantResult: { isValid: true, violations: [] },
    });

    expect(prompt).toContain("## 🔍 Code Review Request: [MAZ-101] Support PureJavaBpfEngine Cache Clearing");
    expect(prompt).toContain("https://github.com/Pilleo/mazewall/pull/42");
    expect(prompt).toContain("`PureJavaBpfEngine#clearCache`");
    expect(prompt).toContain("HighConcurrencyInstallationTest.kt");
    expect(prompt).toContain("Project Invariants:** Clean");
    expect(prompt).toContain("Token-Efficient Review Guidelines");
    expect(prompt).toContain("codanna retrieve describe");
    expect(prompt).toContain("APPROVE / REQUEST_CHANGES");
  });

  it("handles invariant violation warnings in prompt", () => {
    const prompt = synthesizeTokenFriendlyReviewPrompt({
      issue: sampleIssue,
      prUrl: "https://github.com/Pilleo/mazewall/pull/43",
      invariantResult: {
        isValid: false,
        violations: [
          {
            ruleId: "NO_SILENT_EPERM_BYPASS",
            severity: "CRITICAL",
            message: "Silent bypass detected",
            matchedPattern: "catch (e: EPERM)",
          },
        ],
      },
    });

    expect(prompt).toContain("⚠️ **Project Invariants Flagged:**");
    expect(prompt).toContain("[CRITICAL] NO_SILENT_EPERM_BYPASS: Silent bypass detected");
  });
});
