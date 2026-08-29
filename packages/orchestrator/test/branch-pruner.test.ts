import { describe, it, expect } from "vitest";
import { identifyMergedBranches } from "../src/core/branch-pruner.js";
import { GitHubPullRequest } from "../src/core/types.js";

describe("Branch Pruner", () => {
  it("identifies merged feature branches while protecting master/main", () => {
    const prs: GitHubPullRequest[] = [
      {
        number: 42,
        title: "feat: add bpf cache clear",
        headRefName: "jules/issue-101-cache-clear",
        baseRefName: "master",
        state: "MERGED",
        mergedAt: "2026-08-29T10:00:00Z",
        url: "https://github.com/Pilleo/mazewall/pull/42",
        files: ["enforcer/src/main/kotlin/io/mazewall/Bpf.kt"],
      },
      {
        number: 43,
        title: "fix: main branch PR",
        headRefName: "master",
        baseRefName: "master",
        state: "MERGED",
        mergedAt: "2026-08-29T11:00:00Z",
        url: "https://github.com/Pilleo/mazewall/pull/43",
        files: [],
      },
      {
        number: 44,
        title: "feat: unmerged PR",
        headRefName: "jules/issue-102-wip",
        baseRefName: "master",
        state: "OPEN",
        mergedAt: null,
        url: "https://github.com/Pilleo/mazewall/pull/44",
        files: [],
      },
    ];

    const prunable = identifyMergedBranches(prs);
    expect(prunable).toHaveLength(1);
    expect(prunable[0]?.prNumber).toBe(42);
    expect(prunable[0]?.branchName).toBe("jules/issue-101-cache-clear");
    expect(prunable[0]?.action).toBe("prunable");
  });
});
