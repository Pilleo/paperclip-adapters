import { ParsedIssueMetadata } from "./types.js";
import { InvariantCheckResult } from "./invariant-checker.js";

export interface ReviewPromptParams {
  readonly issue: ParsedIssueMetadata;
  readonly prUrl?: string | undefined;
  readonly prNumber?: number | undefined;
  readonly branchName?: string | undefined;
  readonly invariantResult?: InvariantCheckResult | undefined;
  readonly testBlastRadius?: readonly string[] | undefined;
}

/**
 * Synthesizes a compact, token-efficient review prompt for the Reviewer Agent.
 * Avoids dumping full source files; focuses strictly on AST targets, blast radius, and invariants.
 */
export function synthesizeTokenFriendlyReviewPrompt(params: ReviewPromptParams): string {
  const { issue, prUrl, prNumber, branchName, invariantResult, testBlastRadius } = params;

  const targetSymbols =
    issue.targetSymbols && issue.targetSymbols.length > 0
      ? issue.targetSymbols.map((s) => `- \`${s}\``).join("\n")
      : "None explicitly declared (review target files)";

  const targetFiles =
    issue.targetFiles && issue.targetFiles.length > 0
      ? issue.targetFiles.map((f) => `- \`${f}\``).join("\n")
      : "See PR diff";

  const blastRadiusSection =
    testBlastRadius && testBlastRadius.length > 0
      ? `\n**⚡ Impacted Caller Test Suites (Codanna Blast Radius):**\n${testBlastRadius.map((t) => `- \`${t}\``).join("\n")}`
      : "";

  const invariantSection = invariantResult
    ? invariantResult.isValid
      ? "✅ **Project Invariants:** Clean (0 violations detected)."
      : `⚠️ **Project Invariants Flagged:**\n${invariantResult.violations.map((v) => `- [${v.severity}] ${v.ruleId}: ${v.message}`).join("\n")}`
    : "ℹ️ Invariant check passed.";

  return `## 🔍 Code Review Request: [${issue.identifier || issue.id}] ${issue.title}

**Pull Request:** ${prUrl || (prNumber ? `#${prNumber}` : "Pending")} | **Branch:** \`${branchName || "feature branch"}\`

### 🎯 Scope & Declared Targets
**Target Symbols:**
${targetSymbols}

**Target Files:**
${targetFiles}${blastRadiusSection}

### 🛡️ Pre-Flight Invariants Status
${invariantSection}

---

### 📋 Token-Efficient Review Guidelines
1. **Surgical Inspection:** Use semantic symbol lookup (\`codanna retrieve describe <Symbol>\`) or inspect only the specific method diffs (\`git diff origin/master...HEAD -- <file>\`). Do NOT load full source files into context.
2. **Review Priorities:**
   - **Correctness & TDD:** Verify reproducer tests exist and verify behavior without side-effect leaks.
   - **Invariants:** Verify zero silent exception swallows, no memory/layout regressions, and strict type safety.
   - **Scope Discipline:** Ensure changes did not escape the declared \`target_files\` or \`target_symbols\`.

### 📝 Response Format
When providing your review assessment, output:
- **🚨 Severity:** [CLEAN / MINOR / MAJOR / BLOCKING]
- **💡 Findings:** [Concise bullet points on logic, security, or test coverage]
- **🎯 Recommendation:** [APPROVE / REQUEST_CHANGES]`;
}
