import { describe, it, expect, vi } from "vitest";
import { buildGitHubPullRequestCheckArgs, buildGitHubPullRequestListArgs, buildGitHubPullRequestViewArgs, checkPrCiIsGreen, classifyGhNoChecksResult, describeGitHubAccessProblem, hasUnreviewedReadyPullRequest, matchPrToIssue, prCiResultFromGhFailure, processRawPullRequests, registeredPullRequestFromIssue, resolveGitHubCliExecutable, resolvePrCiGate } from "../src/core/github-sync.js";
import { extractIssueMetadata } from "../src/core/parser.js";
import { GitHubPullRequest } from "../src/core/types.js";

describe("GitHub PR Sync Module", () => {
  it("prefers the primary Jules PR over an older placeholder work product", () => {
    const issue = extractIssueMetadata({
      id: "issue-1", identifier: "MAZ-1", title: "Task", status: "in_review",
      workProducts: [
        { type: "pull_request", url: "https://github.com/example/repo/pull/1", isPrimary: true },
        { type: "pull_request", url: "https://github.com/Pilleo/paperclip-adapters/pull/5", isPrimary: true, metadata: { source: "jules" } },
      ],
    });
    expect(registeredPullRequestFromIssue(issue)?.url).toBe("https://github.com/Pilleo/paperclip-adapters/pull/5");
  });

  it("prefers the adapter-canonical Jules PR over a stale primary that also claims Jules provenance", () => {
    const issue = extractIssueMetadata({
      id: "issue-985", identifier: "MAZ-985", title: "Task", status: "in_review",
      workProducts: [
        { type: "pull_request", url: "https://github.com/example/repo/pull/1", isPrimary: true, metadata: { source: "jules" } },
        { type: "pull_request", url: "https://github.com/Pilleo/paperclip-adapters/pull/5", isPrimary: false, metadata: { source: "jules", producer: "paperclip-jules-adapter", schemaVersion: 1 } },
      ],
    });
    expect(registeredPullRequestFromIssue(issue)?.url).toBe("https://github.com/Pilleo/paperclip-adapters/pull/5");
  });

  it("uses an explicit repository when building gh discovery arguments", () => {
    expect(buildGitHubPullRequestListArgs("Pilleo/paperclip-adapters", 50)).toEqual([
      "pr", "list", "--repo", "Pilleo/paperclip-adapters", "--state", "all", "--limit", "50",
      "--json", "number,title,state,headRefName,headRefOid,baseRefName,mergedAt,url,files",
    ]);
  });

  it("uses the canonical registered URL for a targeted historical PR lookup", () => {
    expect(buildGitHubPullRequestViewArgs("https://github.com/acme/repo/pull/17")).toEqual([
      "pr", "view", "https://github.com/acme/repo/pull/17",
      "--json", "number,title,state,headRefName,headRefOid,baseRefName,mergedAt,url,files",
    ]);
  });

  it("makes authentication and rate-limit failures human-actionable", () => {
    expect(describeGitHubAccessProblem(401, "rest")).toContain("authentication was rejected");
    expect(describeGitHubAccessProblem(403, "rest")).toContain("authenticate the Paperclip service");
    expect(describeGitHubAccessProblem(408, "gh")).toContain("timed out");
  });

  it("treats an authoritative empty check-runs response as green", async () => {
    const originalFetch = global.fetch;
    const originalPath = process.env["PATH"];
    process.env["PATH"] = "";
    global.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ head: { sha: "abc123" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ check_runs: [] }), { status: 200 }));
    try {
      await expect(checkPrCiIsGreen(
        1,
        undefined,
        "https://github.com/Pilleo/repo/pull/1",
      )).resolves.toEqual({ isGreen: true, status: "none" });
    } finally {
      global.fetch = originalFetch;
      if (originalPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = originalPath;
    }
  });

  it.each([500, 401, 403, 429])("keeps HTTP %s fail-closed", async (status) => {
    const originalFetch = global.fetch;
    const originalPath = process.env["PATH"];
    process.env["PATH"] = "";
    global.fetch = vi.fn().mockResolvedValue(new Response("failure", { status }));
    try {
      expect((await checkPrCiIsGreen(
        1,
        undefined,
        "https://github.com/Pilleo/repo/pull/1",
      )).isGreen).toBe(false);
    } finally {
      global.fetch = originalFetch;
      if (originalPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = originalPath;
    }
  });

  it.each([
    ["uses an explicit runtime override", { PAPERCLIP_GH_PATH: "/runtime/bin/gh" }, new Set<string>(), "/runtime/bin/gh"],
    ["uses the system gh when the runner PATH was sanitized", {}, new Set(["/usr/bin/gh"]), "/usr/bin/gh"],
    ["keeps normal PATH lookup when no known absolute path exists", {}, new Set<string>(), "gh"],
  ])("%s", (_name, environment, existingPaths, expected) => {
    expect(resolveGitHubCliExecutable(environment, (candidate) => existingPaths.has(candidate))).toBe(expected);
  });

  it.each([
    ["GitHub CLI's exact no-checks terminal result", "no checks reported on the 'feature' branch", true],
    ["the exact no-checks stderr line wrapped by node's command error", "Command failed: gh pr checks 7\nno checks reported on the 'feature' branch\n", true],
    ["a no-checks phrase embedded in another failure", "HTTP 403: no checks reported on the 'feature' branch", false],
    ["an authentication failure", "HTTP 403 rate limit exceeded", false],
  ])("classifies %s without treating GitHub access failures as no-CI", (_name, detail, expected) => {
    expect(classifyGhNoChecksResult(detail)).toBe(expected);
  });

  it("turns only GitHub CLI's no-checks exit into a review-eligible CI result", () => {
    expect(prCiResultFromGhFailure("no checks reported on the 'feature' branch")).toEqual({
      isGreen: true,
      status: "none",
    });
    expect(prCiResultFromGhFailure("HTTP 403 rate limit exceeded")).toBeNull();
  });

  it("recognizes the Buffer stderr emitted by node execFile for no-checks exits", () => {
    expect(prCiResultFromGhFailure(Buffer.from("no checks reported on the 'canary' branch\n"))).toEqual({
      isGreen: true,
      status: "none",
    });
  });

  it("treats a managed worker's explicit CI-skip policy as a successful gate", () => {
    expect(resolvePrCiGate("skip", {
      isGreen: false,
      status: "pending",
      accessProblem: "GitHub rest access is unavailable (HTTP 403).",
    })).toEqual({ isGreen: true, status: "success" });
  });

  it("checks a registered PR against its URL repository rather than the local cwd remote", () => {
    expect(buildGitHubPullRequestCheckArgs(17, "https://github.com/acme/repo/pull/17")).toEqual([
      "pr", "checks", "17", "--repo", "acme/repo", "--json", "state,bucket,name",
    ]);
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
