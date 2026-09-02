import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitHubPullRequest, GitHubSyncStatus, ParsedIssueMetadata } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Pure helper to match a GitHub PR to a Paperclip issue by UUID, identifier, issue number, or PR URL.
 *
 * Jules registers the PR as a Paperclip work product. That URL is the
 * strongest available correlation signal, but it is not necessarily present
 * in the PR title, branch, or issue description. Keep this check exact and
 * scoped to pull-request work products so an unrelated artifact cannot claim
 * an issue during the review scan.
 */
export function matchPrToIssue(pr: GitHubPullRequest, issue: ParsedIssueMetadata): boolean {
  const rawWorkProducts = issue.rawIssue["workProducts"] ?? issue.rawIssue["work_products"];
  if (Array.isArray(rawWorkProducts)) {
    const normalizedPrUrl = pr.url.replace(/\/$/, "").toLowerCase();
    if (rawWorkProducts.some((product) => {
      if (!product || typeof product !== "object") return false;
      const candidate = product as Record<string, unknown>;
      const type = candidate["type"] ?? candidate["kind"];
      const url = candidate["url"];
      return (type === "pull_request" || type === "pull-request") &&
        typeof url === "string" && url.replace(/\/$/, "").toLowerCase() === normalizedPrUrl;
    })) return true;
  }

  const prText = `${pr.title} ${pr.headRefName} ${pr.url}`.toLowerCase();
  if (issue.id && prText.includes(issue.id.toLowerCase())) return true;
  if (issue.identifier && new RegExp(`\\b${issue.identifier.toLowerCase()}\\b`).test(prText)) return true;
  if (issue.issueNumber && new RegExp(`\\bissue-${issue.issueNumber}\\b`, "i").test(prText)) return true;

  const rawDesc = typeof issue.rawIssue["description"] === "string" ? (issue.rawIssue["description"] as string).toLowerCase() : "";
  if (rawDesc.includes(pr.url.toLowerCase()) || rawDesc.includes(`/pull/${pr.number}`)) return true;

  return false;
}

/** Build a minimal PR record from Paperclip's authoritative work product. */
export function registeredPullRequestFromIssue(issue: ParsedIssueMetadata): GitHubPullRequest | undefined {
  const rawWorkProducts = issue.rawIssue["workProducts"] ?? issue.rawIssue["work_products"];
  if (!Array.isArray(rawWorkProducts)) return undefined;
  for (const product of rawWorkProducts) {
    if (!product || typeof product !== "object") continue;
    const candidate = product as Record<string, unknown>;
    const type = candidate["type"] ?? candidate["kind"];
    const url = candidate["url"];
    if ((type !== "pull_request" && type !== "pull-request") || typeof url !== "string") continue;
    const number = Number(url.match(/\/pull\/(\d+)(?:\/|$)/)?.[1]);
    if (!Number.isInteger(number) || number <= 0) continue;
    return Object.freeze({
      number,
      title: typeof candidate["title"] === "string" ? candidate["title"] : issue.title,
      state: "OPEN",
      headRefName: "",
      baseRefName: "",
      mergedAt: null,
      url,
      files: Object.freeze([]),
    });
  }
  return undefined;
}

/**
 * Detect the only safe terminal-state recovery case: Paperclip says the issue
 * is done, but its Jules-owned PR is still explicitly awaiting review. A
 * merged/closed work product must never be reopened by this recovery path.
 */
export function hasUnreviewedReadyPullRequest(issue: ParsedIssueMetadata): boolean {
  const rawWorkProducts = issue.rawIssue["workProducts"] ?? issue.rawIssue["work_products"];
  if (!Array.isArray(rawWorkProducts)) return false;
  return rawWorkProducts.some((product) => {
    if (!product || typeof product !== "object") return false;
    const candidate = product as Record<string, unknown>;
    const type = candidate["type"] ?? candidate["kind"];
    const url = candidate["url"];
    const productStatus = String(candidate["status"] ?? "").toLowerCase();
    const reviewState = String(candidate["reviewState"] ?? candidate["review_state"] ?? "").toLowerCase();
    return (type === "pull_request" || type === "pull-request") &&
      typeof url === "string" && /\/pull\/\d+(?:\/|$)/.test(url) &&
      (productStatus === "ready_for_review" || productStatus === "open") &&
      (!reviewState || reviewState === "none");
  });
}

export interface RawPullRequestItem {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly headRefName: string;
  readonly headRefOid?: string | undefined;
  readonly baseRefName: string;
  readonly mergedAt: string | null;
  readonly url: string;
  readonly files?: readonly (string | { readonly path?: string | undefined })[] | undefined;
}

export function processRawPullRequests(
  rawList: readonly RawPullRequestItem[]
): GitHubSyncStatus {
  const openPrs: GitHubPullRequest[] = [];
  const mergedPrs: GitHubPullRequest[] = [];
  const openPrFiles = new Set<string>();

  for (const item of rawList) {
    const stateUpper = (item.state || "").toUpperCase() as "OPEN" | "CLOSED" | "MERGED";
    const files: string[] = (item.files || [])
      .map((f) => (typeof f === "string" ? f : f.path || ""))
      .filter(Boolean);

    const pr: GitHubPullRequest = Object.freeze({
      number: item.number,
      title: item.title,
      state: stateUpper,
      headRefName: item.headRefName,
      ...(typeof item.headRefOid === "string" && item.headRefOid ? { headRefOid: item.headRefOid } : {}),
      baseRefName: item.baseRefName,
      mergedAt: item.mergedAt,
      url: item.url,
      files: Object.freeze(files),
    });

    if (stateUpper === "OPEN") {
      openPrs.push(pr);
      files.forEach((f) => openPrFiles.add(f));
    } else if (stateUpper === "MERGED") {
      mergedPrs.push(pr);
    }
  }

  return {
    openPrs: Object.freeze(openPrs),
    mergedPrs: Object.freeze(mergedPrs),
    openPrFiles: Object.freeze(openPrFiles),
  };
}

export async function fetchGitHubPullRequests(workspacePath: string, limit = 50): Promise<GitHubSyncStatus> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "pr",
        "list",
        "--state",
        "all",
        "--limit",
        String(limit),
        "--json",
        "number,title,state,headRefName,headRefOid,baseRefName,mergedAt,url,files",
      ],
      // Remote verification must not consume an entire heartbeat when gh is
      // unauthenticated or waiting on a broken network connection. Registered
      // Paperclip work products provide the review fallback below.
      { cwd: workspacePath, timeout: 8_000 }
    );

    const rawList = JSON.parse(stdout);
    if (!Array.isArray(rawList)) {
      return {
        openPrs: Object.freeze([]),
        mergedPrs: Object.freeze([]),
        openPrFiles: Object.freeze(new Set<string>()),
        error: "Malformed JSON response from gh pr list",
      };
    }

    return processRawPullRequests(rawList);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      openPrs: Object.freeze([]),
      mergedPrs: Object.freeze([]),
      openPrFiles: Object.freeze(new Set<string>()),
      error: msg,
    };
  }
}

/**
 * Resolve an immutable PR head without relying on GitHub REST rate limits.
 * Review state must never be keyed only by a branch name: a force-push/new
 * commit must create a new review card.
 */
export async function fetchPullRequestHeadSha(prUrl: string): Promise<string | undefined> {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/i.exec(prUrl);
  if (!match) return undefined;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-remote", `https://github.com/${match[1]}/${match[2]}.git`, `refs/pull/${match[3]}/head`],
      { timeout: 8_000 },
    );
    const sha = stdout.trim().split(/\s+/, 1)[0] || "";
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

export interface PrCiCheckResult {
  readonly isGreen: boolean;
  readonly status: "success" | "pending" | "failed" | "none";
  /**
   * A human-actionable explanation when CI could not be queried.  `pending`
   * is otherwise ambiguous: it can mean a real running workflow or that the
   * service lost GitHub access.  The latter must be made loud by the caller.
   */
  readonly accessProblem?: string | undefined;
}

/** Classify GitHub access failures without including credentials or URLs. */
export function describeGitHubAccessProblem(status: number, source: "gh" | "rest", detail?: string): string {
  if (status === 401) return `GitHub ${source} authentication was rejected (HTTP 401).`;
  if (status === 403) return `GitHub ${source} access is unavailable (HTTP 403; authenticate the Paperclip service or wait for rate-limit reset).`;
  if (status === 429) return `GitHub ${source} is rate-limited (HTTP 429).`;
  if (status === 408) return `GitHub ${source} timed out while checking CI.`;
  return `GitHub ${source} could not verify CI${detail ? `: ${detail}` : "."}`;
}

export async function checkPrCiIsGreen(
  prNumber: number,
  cwd?: string,
  prUrl?: string,
): Promise<PrCiCheckResult> {
  const restFallback = async (): Promise<PrCiCheckResult> => {
    const match = prUrl?.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!match) return { isGreen: false, status: "pending" };
    try {
      const [, owner, repo, pullNumber] = match;
      const headers = { Accept: "application/vnd.github+json", "User-Agent": "paperclip-orchestrator" };
      const prResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`, {
        headers,
        signal: AbortSignal.timeout(5_000),
      });
      if (!prResponse.ok) return {
        isGreen: false,
        status: "pending",
        accessProblem: describeGitHubAccessProblem(prResponse.status, "rest"),
      };
      const prData = await prResponse.json() as { head?: { sha?: string } };
      const sha = prData.head?.sha;
      if (!sha) return { isGreen: false, status: "pending" };
      const checksResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${sha}/check-runs`, {
        headers,
        signal: AbortSignal.timeout(5_000),
      });
      if (!checksResponse.ok) return {
        isGreen: false,
        status: "pending",
        accessProblem: describeGitHubAccessProblem(checksResponse.status, "rest"),
      };
      const checksData = await checksResponse.json() as { check_runs?: Array<{ status?: string; conclusion?: string }> };
      const checks = checksData.check_runs ?? [];
      if (checks.length === 0) return { isGreen: false, status: "none" };
      if (checks.some((check) => check.status !== "completed")) return { isGreen: false, status: "pending" };
      if (checks.some((check) => check.conclusion !== "success")) return { isGreen: false, status: "failed" };
      return { isGreen: true, status: "success" };
    } catch (error: unknown) {
      return {
        isGreen: false,
        status: "pending",
        accessProblem: describeGitHubAccessProblem(408, "rest", error instanceof Error ? error.message : String(error)),
      };
    }
  };

  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["pr", "checks", String(prNumber), "--json", "state,bucket,name"],
      { cwd: cwd || process.cwd(), timeout: 15000 }
    );
    const checks = JSON.parse(stdout);
    // gh can exit successfully with no rows when its auth/session cannot
    // resolve checks. The URL-backed REST path is still authoritative.
    if (!Array.isArray(checks) || checks.length === 0) return restFallback();
    const hasPending = checks.some(
      (c) => c.state === "PENDING" || c.bucket === "pending"
    );
    if (hasPending) return { isGreen: false, status: "pending" };

    const hasFailed = checks.some(
      (c) => c.state === "FAILURE" || c.bucket === "fail" || c.state === "CANCELLED"
    );
    if (hasFailed) return { isGreen: false, status: "failed" };

    const allPassed = checks.every(
      (c) => c.state === "SUCCESS" || c.bucket === "pass"
    );
    return { isGreen: allPassed, status: allPassed ? "success" : "pending" };
  } catch (err: unknown) {
    // The orchestrator is also used with Paperclip's built-in/local workers,
    // where the service may not have the user's gh credential or even a gh
    // binary. Fall back to GitHub's read-only REST endpoints when the PR URL
    // is known; review scheduling must not depend on a CLI login.
    return restFallback();
  }
}
