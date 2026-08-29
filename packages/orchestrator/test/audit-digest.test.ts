import { describe, it, expect } from "vitest";
import { synthesizeAuditDigest } from "../src/core/audit-digest.js";
import { ParsedIssueMetadata, GitHubPullRequest } from "../src/core/types.js";

describe("Audit Digest Synthesizer", () => {
  const sampleIssue: ParsedIssueMetadata = {
    id: "issue-202",
    identifier: "MAZ-202",
    title: "Support Landlock Path Normalization",
    status: "done",
    priority: "high",
    priorityRank: 2,
    dependencies: [],
    targetFiles: ["enforcer/src/main/kotlin/io/mazewall/Landlock.kt"],
    targetModules: [":enforcer"],
    targetSymbols: ["Landlock#addPathRule"],
    hasSideEffects: false,
    component: "enforcer",
    isNonInterfering: false,
    rawIssue: {},
  };

  const samplePr: GitHubPullRequest = {
    number: 55,
    title: "feat: landlock path normalization",
    headRefName: "jules/issue-202-landlock",
    baseRefName: "master",
    state: "MERGED",
    mergedAt: "2026-08-29T18:00:00Z",
    url: "https://github.com/Pilleo/mazewall/pull/55",
    files: ["enforcer/src/main/kotlin/io/mazewall/Landlock.kt"],
  };

  it("synthesizes a clean markdown audit digest with PR link, blast radius, and invariants", () => {
    const digest = synthesizeAuditDigest({
      issue: sampleIssue,
      pr: samplePr,
      testBlastRadius: ["enforcer/src/test/kotlin/io/mazewall/LandlockTest.kt"],
      durationMs: 45000,
    });

    expect(digest).toContain("### 🏁 Execution Audit Digest: [MAZ-202] Support Landlock Path Normalization");
    expect(digest).toContain("[PR #55: feat: landlock path normalization](https://github.com/Pilleo/mazewall/pull/55)");
    expect(digest).toContain("`Landlock#addPathRule`");
    expect(digest).toContain("✅ Verified Clean (0 violations)");
    expect(digest).toContain("`enforcer/src/main/kotlin/io/mazewall/Landlock.kt`");
    expect(digest).toContain("`enforcer/src/test/kotlin/io/mazewall/LandlockTest.kt`");
    expect(digest).toContain("Execution Latency:** 45s");
  });
});
