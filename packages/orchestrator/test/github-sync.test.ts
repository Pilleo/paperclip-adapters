import { describe, it, expect } from "vitest";
import { matchPrToIssue, processRawPullRequests } from "../src/core/github-sync.js";
import { extractIssueMetadata } from "../src/core/parser.js";
import { GitHubPullRequest } from "../src/core/types.js";

describe("GitHub PR Sync Module", () => {
  it("matches PR to issue by UUID in title", () => {
    const pr: GitHubPullRequest = {
      number: 521,
      title: "Fix broken tests (52a1d9d0-2f9a-4130-bd61-5bc163175656)",
      state: "MERGED",
      headRefName: "fix-branch",
      baseRefName: "master",
      mergedAt: "2026-08-26T23:12:52Z",
      url: "https://github.com/Pilleo/mazewall/pull/521",
      files: ["enforcer/BpfFilter.kt"],
    };

    const issue = extractIssueMetadata({
      id: "52a1d9d0-2f9a-4130-bd61-5bc163175656",
      identifier: "MAZ-769",
      title: "Fix broken tests",
      status: "in_progress",
    });

    expect(matchPrToIssue(pr, issue)).toBe(true);
  });

  it("matches PR to issue by PR URL in description", () => {
    const pr: GitHubPullRequest = {
      number: 525,
      title: "Purge coverage theater tests",
      state: "OPEN",
      headRefName: "jules-branch",
      baseRefName: "master",
      mergedAt: null,
      url: "https://github.com/Pilleo/mazewall/pull/525",
      files: ["profiler/Profiler.kt"],
    };

    const issue = extractIssueMetadata({
      id: "issue-abc",
      title: "Coverage audit",
      status: "in_review",
      description: "Related PR: https://github.com/Pilleo/mazewall/pull/525",
    });

    expect(matchPrToIssue(pr, issue)).toBe(true);
  });

  it("partitions raw PRs and extracts open PR modified files", () => {
    const rawList = [
      {
        number: 1,
        title: "Open PR",
        state: "OPEN",
        headRefName: "feat-1",
        baseRefName: "master",
        mergedAt: null,
        url: "https://github.com/org/repo/pull/1",
        files: ["src/A.kt", "src/B.kt"],
      },
      {
        number: 2,
        title: "Merged PR",
        state: "MERGED",
        headRefName: "feat-2",
        baseRefName: "master",
        mergedAt: "2026-08-28T00:00:00Z",
        url: "https://github.com/org/repo/pull/2",
        files: ["src/C.kt"],
      },
    ];

    const result = processRawPullRequests(rawList);
    expect(result.openPrs.length).toBe(1);
    expect(result.mergedPrs.length).toBe(1);
    expect(result.openPrFiles.has("src/A.kt")).toBe(true);
    expect(result.openPrFiles.has("src/B.kt")).toBe(true);
    expect(result.openPrFiles.has("src/C.kt")).toBe(false);
  });
});
