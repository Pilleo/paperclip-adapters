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

  describe.each([
    {
      name: "prevents false positive substring collision on issueNumber (issue-2 vs issue-2026...)",
      prTitle: "fix(core): resolve issue-20260826-102701 branch sync",
      issueNumber: 2,
      identifier: "MAZ-2",
      expectedMatch: false,
    },
    {
      name: "prevents false positive substring collision on identifier (MAZ-2 vs MAZ-20)",
      prTitle: "feat(enforcer): MAZ-20 adds BPF linear scan",
      issueNumber: 2,
      identifier: "MAZ-2",
      expectedMatch: false,
    },
    {
      name: "accurately matches exact word boundary identifier (MAZ-2 in title)",
      prTitle: "feat(enforcer): [MAZ-2] adds BPF linear scan",
      issueNumber: 2,
      identifier: "MAZ-2",
      expectedMatch: true,
    },
    {
      name: "accurately matches exact word boundary issueNumber (issue-2 in title)",
      prTitle: "feat(enforcer): resolve issue-2 regression",
      issueNumber: 2,
      identifier: "MAZ-2",
      expectedMatch: true,
    },
  ])("PR Collision Matrix: $name", ({ prTitle, issueNumber, identifier, expectedMatch }) => {
    it(`evaluates matchPrToIssue accurately (${expectedMatch})`, () => {
      const pr: GitHubPullRequest = {
        number: 99,
        title: prTitle,
        state: "OPEN",
        headRefName: "feature-branch",
        baseRefName: "master",
        mergedAt: null,
        url: "https://github.com/org/repo/pull/99",
        files: [],
      };

      const issue = extractIssueMetadata({
        id: "target-issue-uuid",
        issueNumber,
        identifier,
        title: "Test Task",
        status: "todo",
      });

      expect(matchPrToIssue(pr, issue)).toBe(expectedMatch);
    });
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
        files: [{ path: "file1.ts" }, "file2.ts"],
      },
      {
        number: 2,
        title: "Merged PR",
        state: "MERGED",
        headRefName: "feat-2",
        baseRefName: "master",
        mergedAt: "2026-08-25T10:00:00Z",
        url: "https://github.com/org/repo/pull/2",
        files: ["file3.ts"],
      },
    ];

    const result = processRawPullRequests(rawList);
    expect(result.openPrs.length).toBe(1);
    expect(result.mergedPrs.length).toBe(1);
    expect(result.openPrFiles.has("file1.ts")).toBe(true);
    expect(result.openPrFiles.has("file2.ts")).toBe(true);
    expect(result.openPrFiles.has("file3.ts")).toBe(false);
  });
});
