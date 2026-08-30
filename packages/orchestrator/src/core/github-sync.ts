import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitHubPullRequest, GitHubSyncStatus, ParsedIssueMetadata } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Pure helper to match a GitHub PR to a Paperclip issue by UUID, identifier, issue number, or PR URL.
 */
export function matchPrToIssue(pr: GitHubPullRequest, issue: ParsedIssueMetadata): boolean {
  const prText = `${pr.title} ${pr.headRefName} ${pr.url}`.toLowerCase();
  if (issue.id && prText.includes(issue.id.toLowerCase())) return true;
  if (issue.identifier && new RegExp(`\\b${issue.identifier.toLowerCase()}\\b`).test(prText)) return true;
  if (issue.issueNumber && new RegExp(`\\bissue-${issue.issueNumber}\\b`, "i").test(prText)) return true;

  const rawDesc = typeof issue.rawIssue["description"] === "string" ? (issue.rawIssue["description"] as string).toLowerCase() : "";
  if (rawDesc.includes(pr.url.toLowerCase()) || rawDesc.includes(`/pull/${pr.number}`)) return true;

  return false;
}

export interface RawPullRequestItem {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly headRefName: string;
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
        "number,title,state,headRefName,baseRefName,mergedAt,url,files",
      ],
      { cwd: workspacePath, timeout: 30000 }
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

export interface PrCiCheckResult {
  readonly isGreen: boolean;
  readonly status: "success" | "pending" | "failed" | "none";
}

export async function checkPrCiIsGreen(
  prNumber: number,
  cwd?: string
): Promise<PrCiCheckResult> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["pr", "checks", String(prNumber), "--json", "state,bucket,name"],
      { cwd: cwd || process.cwd(), timeout: 15000 }
    );
    const checks = JSON.parse(stdout);
    if (!Array.isArray(checks) || checks.length === 0) {
      return { isGreen: false, status: "none" };
    }
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
    return { isGreen: false, status: "pending" };
  }
}
