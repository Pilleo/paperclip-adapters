import { describe, expect, it } from "vitest";
import { processRawPullRequests, resolveIssuePullRequestObservation } from "../src/core/github-sync.js";
import { extractIssueMetadata } from "../src/core/parser.js";
import type { GitHubPullRequest, GitHubSyncStatus } from "../src/core/types.js";

const registeredUrl = "https://github.com/example/repo/pull/7";
const remote = (url: string, title = "Unrelated"): GitHubPullRequest => ({ number: 7, title,
  url, state: "OPEN", headRefName: "topic", headRefOid: "a".repeat(40), baseRefName: "main",
  mergedAt: null, files: [] });
const issue = (registered: boolean) => extractIssueMetadata({ id: "issue-1", identifier: "MAZ-1",
  title: "Canary", status: "in_review", ...(registered ? { workProducts: [{
    type: "pull_request", url: registeredUrl, isPrimary: true,
    metadata: { source: "jules", headSha: "b".repeat(40) },
  }] } : {}) });
const status = (openPrs: readonly GitHubPullRequest[], error?: string): GitHubSyncStatus => ({
  openPrs, mergedPrs: [], openPrFiles: new Set(), ...(error ? { error } : {}),
});

describe("issue PR discovery at bounded GitHub boundary", () => {
  it("keeps a registered immutable head on GitHub transport failure even if remote data is inconsistent", () => {
    expect(resolveIssuePullRequestObservation(issue(true), status([remote(registeredUrl)], "gh unavailable")))
      .toMatchObject({ kind: "registered_after_unavailable", registered: { url: registeredUrl,
        headRefOid: "b".repeat(40) }, error: "gh unavailable" });
  });

  it("distinguishes a remote match from a registered PR outside the bounded discovery window", () => {
    expect(resolveIssuePullRequestObservation(issue(true), status([remote(registeredUrl)])))
      .toMatchObject({ kind: "remote_open", pr: { url: registeredUrl, headRefOid: "a".repeat(40) } });
    expect(resolveIssuePullRequestObservation(issue(true), status([])))
      .toMatchObject({ kind: "registered_outside_window", registered: { url: registeredUrl } });
  });

  it("does not turn unavailable GitHub discovery into confirmed PR absence", () => {
    expect(resolveIssuePullRequestObservation(issue(false), status([], "gh unavailable")))
      .toEqual({ kind: "unavailable", error: "gh unavailable" });
    expect(resolveIssuePullRequestObservation(issue(false), status([])))
      .toEqual({ kind: "not_in_window" });
  });

  it("preserves the existing issue-title match before registered URL fallback", () => {
    expect(resolveIssuePullRequestObservation(issue(true), status([
      remote("https://github.com/example/repo/pull/9", "MAZ-1 task"), remote(registeredUrl),
    ]))).toMatchObject({ kind: "remote_open", pr: { url: "https://github.com/example/repo/pull/9" } });
  });

  it("fails closed on an unknown provider PR state instead of treating it as confirmed absence", () => {
    const malformed = processRawPullRequests([{ number: 7, title: "MAZ-1", url: registeredUrl,
      state: "SUSPENDED", headRefName: "topic", baseRefName: "main", mergedAt: null }]);
    expect(malformed.error).toMatch(/unknown.*PR state/i);
    expect(malformed.openPrs).toEqual([]);
    expect(resolveIssuePullRequestObservation(issue(true), malformed))
      .toMatchObject({ kind: "registered_after_unavailable", registered: { url: registeredUrl } });
  });
});
