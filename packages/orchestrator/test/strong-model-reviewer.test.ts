import { describe, it, expect } from "vitest";
import {
  buildPrReviewPrompt,
  parseReviewModelResponse,
  formatGitHubPrReviewComment,
  executeStrongModelPrReview,
} from "../src/core/strong-model-reviewer.js";
import { ParsedIssueMetadata } from "../src/core/types.js";

describe("Strong Model PR Reviewer", () => {
  const mockIssue: ParsedIssueMetadata = {
    id: "issue-100",
    identifier: "MAZ-100",
    title: "Implement Landlock ABI V5 Scopes",
    status: "in_review",
    priority: "high",
    priorityRank: 3,
    component: "enforcer",
    targetFiles: ["enforcer/src/Landlock.kt"],
    targetSymbols: ["Landlock.restrict"],
    dependencies: [],
    isOpenQuestions: false,
    isNonInterfering: false,
    rawIssue: {},
  };

  it("builds a token-efficient prompt with compact surgical diff", () => {
    const diff = "--- a/Landlock.kt\n+++ b/Landlock.kt\n@@ -10,3 +10,4 @@\n+ val ABI_V5 = 5";
    const { systemPrompt, userPrompt } = buildPrReviewPrompt(mockIssue, diff);

    expect(systemPrompt).toContain("Zero Silent Bypasses");
    expect(systemPrompt).toContain("Memory Safety & FFM");
    expect(userPrompt).toContain("MAZ-100");
    expect(userPrompt).toContain("Landlock.restrict");
    expect(userPrompt).toContain("+ val ABI_V5 = 5");
  });

  it("parses strong model response with findings and questions", () => {
    const rawJson = JSON.stringify({
      verdict: "REQUEST_CHANGES",
      summary: "Potential FFM memory leak in downcall arena.",
      findings: ["Arena is not scoped to Arena.ofConfined().", "Missing Landlock ABI V5 check."],
      questions: ["Is ABI V5 supported on kernel 5.15 LTS?"],
    });

    const parsed = parseReviewModelResponse(rawJson, "grok-beta");
    expect(parsed.verdict).toBe("REQUEST_CHANGES");
    expect(parsed.summary).toContain("Potential FFM memory leak");
    expect(parsed.findings.length).toBe(2);
    expect(parsed.questions[0]).toContain("kernel 5.15");
  });

  it("formats markdown review comment suitable for GitHub PR", () => {
    const parsed = {
      verdict: "APPROVE" as const,
      summary: "Clean implementation with green reproducer tests.",
      findings: ["Zero swallows of EPERM.", "MemorySegment layouts strictly aligned."],
      questions: [],
    };

    const comment = formatGitHubPrReviewComment(mockIssue, parsed, "gpt-4o");
    expect(comment).toContain("## ✅ Automated Code Review Verdict: **APPROVE**");
    expect(comment).toContain("**Reviewer Model:** `gpt-4o`");
    expect(comment).toContain("MemorySegment layouts strictly aligned.");
  });

  it("executes review in mock mode without throwing", async () => {
    const result = await executeStrongModelPrReview(
      mockIssue,
      0, // PR 0 skips actual gh cli post in test
      "+ fun test() {}",
      { provider: "mock" }
    );

    expect(result.verdict).toBe("APPROVE");
    expect(result.commentBody).toContain("Automated Code Review Verdict");
  });
});
