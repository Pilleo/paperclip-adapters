import { describe, it, expect } from "vitest";
import { describeGitHubAccessProblem, hasUnreviewedReadyPullRequest, matchPrToIssue, processRawPullRequests, registeredPullRequestFromIssue } from "../src/core/github-sync.js";
import { extractIssueMetadata } from "../src/core/parser.js";
import { GitHubPullRequest } from "../src/core/types.js";

describe("GitHub PR Sync Module", () => {
  it("makes authentication and rate-limit failures human-actionable", () => {
    expect(describeGitHubAccessProblem(401, "rest")).toContain("authentication was rejected");
    expect(describeGitHubAccessProblem(403, "rest")).toContain("authenticate the Paperclip service");
    expect(describeGitHubAccessProblem(408, "gh")).toContain("timed out");
  });

  it("retains the immutable PR head SHA for review-card invalidation", () => {
    expect(processRawPullRequests([{
      number: 1, title: "Review", state: "OPEN", headRefName: "feature", headRefOid: "abc123",
      baseRefName: "main", mergedAt: null, url: "https://github.com/acme/repo/pull/1",
    }]).openPrs[0]?.headRefOid).toBe("abc123");
  });

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

  it("matches a registered Paperclip pull-request work product exactly", () => {
    const pr: GitHubPullRequest = {
      number: 3,
      title: "Adapters linter fixes",
      state: "OPEN",
      headRefName: "jules/final",
      baseRefName: "master",
      mergedAt: null,
      url: "https://github.com/Pilleo/paperclip-adapters/pull/3",
      files: [],
    };

    const issue = extractIssueMetadata({
      id: "873f5b3d-0ab7-441f-8da3-8beb4b56b3c7",
      identifier: "MAZ-834",
      title: "Planning linter",
      status: "in_review",
      workProducts: [{
        type: "pull_request",
        url: pr.url,
        status: "ready_for_review",
      }],
    });

    expect(matchPrToIssue(pr, issue)).toBe(true);
  });

  it("extracts a reviewable PR when gh is unavailable", () => {
    const issue = extractIssueMetadata({
      id: "issue-834",
      identifier: "MAZ-834",
      title: "Planning linter",
      status: "in_review",
      workProducts: [{
        type: "pull_request",
        url: "https://github.com/Pilleo/paperclip-adapters/pull/3",
        status: "ready_for_review",
      }],
    });

    expect(registeredPullRequestFromIssue(issue)).toMatchObject({
      number: 3,
      url: "https://github.com/Pilleo/paperclip-adapters/pull/3",
      state: "OPEN",
    });
  });

  it("recognizes a registered PR explicitly awaiting review", () => {
    const issue = extractIssueMetadata({
      id: "issue-834",
      identifier: "MAZ-834",
      title: "Planning linter",
      status: "done",
      workProducts: [{
        type: "pull_request",
        url: "https://github.com/Pilleo/paperclip-adapters/pull/3",
        status: "ready_for_review",
        reviewState: "none",
      }],
    });
    expect(hasUnreviewedReadyPullRequest(issue)).toBe(true);
    const mergedIssue = extractIssueMetadata({
      id: "issue-834",
      identifier: "MAZ-834",
      title: "Planning linter",
      status: "done",
      workProducts: [{
        type: "pull_request",
        url: "https://github.com/Pilleo/paperclip-adapters/pull/3",
        status: "merged",
        reviewState: "none",
      }],
    });
    expect(hasUnreviewedReadyPullRequest(mergedIssue)).toBe(false);
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
