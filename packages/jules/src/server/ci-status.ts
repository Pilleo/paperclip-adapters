import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export type CiCheckStatus = "success" | "pending" | "stalled" | "failed" | "unknown";
export const CI_STALL_TIMEOUT_MS = 90 * 60 * 1_000;
export type PullRequestState = "OPEN" | "MERGED" | "CLOSED" | "UNKNOWN";

export interface CheckItem {
  name?: string;
  state?: string;
  bucket?: string;
  workflow?: string;
  startedAt?: string;
}

export type MergeableStatus = "mergeable" | "conflicting" | "unknown";

export interface PullRequestDetails {
  state: PullRequestState;
  merged: boolean;
  ciStatus: CiCheckStatus;
  mergeableStatus?: MergeableStatus;
  /** Immutable GitHub head used to fence review decisions to one revision. */
  headSha?: string;
  /** PR branch that remediation must continue on instead of the repository default branch. */
  headRefName?: string;
}

export function evaluateChecks(checks: CheckItem[], now = Date.now()): CiCheckStatus {
  if (!Array.isArray(checks) || checks.length === 0) {
    return "pending";
  }

  let hasPending = false;
  let hasFreshPending = false;
  for (const check of checks) {
    const bucket = (check.bucket || "").toLowerCase();
    const state = (check.state || "").toUpperCase();

    if (bucket === "fail" || state === "FAILURE" || state === "ERROR" || state === "CANCELLED") {
      return "failed";
    }
    if (bucket === "pending" || state === "PENDING" || state === "IN_PROGRESS" || state === "QUEUED") {
      hasPending = true;
      const startedAt = typeof check.startedAt === "string" ? Date.parse(check.startedAt) : NaN;
      if (!Number.isFinite(startedAt) || now - startedAt < CI_STALL_TIMEOUT_MS) hasFreshPending = true;
    }
  }

  if (hasPending && !hasFreshPending) return "stalled";
  if (hasPending) return "pending";
  return "success";
}

export async function listPullRequestChangedFiles(prUrl: string, cwd?: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync(`gh pr diff "${prUrl}" --name-only`, {
      cwd: cwd || process.cwd(),
      timeout: 5_000,
    });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Full PR patch for symbol-level scope checks. Empty when `gh` is unavailable. */
export async function getPullRequestPatch(prUrl: string, cwd?: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`gh pr diff "${prUrl}"`, {
      cwd: cwd || process.cwd(),
      timeout: 8_000,
    });
    return stdout;
  } catch {
    return "";
  }
}

export async function getPullRequestDetails(
  prUrl: string,
  cwd?: string,
): Promise<PullRequestDetails> {
  let prState: PullRequestState = "UNKNOWN";
  let isMerged = false;
  let prHeadSha: string | undefined;
  let prHeadRefName: string | undefined;

  // 1. Check PR State via gh CLI
  try {
    const { stdout } = await execAsync(
      `gh pr view "${prUrl}" --json state,mergedAt,mergeable,mergeStateStatus,headRefOid,headRefName`,
      { cwd: cwd || process.cwd(), timeout: 3_000 },
    );
    const parsed = JSON.parse(stdout.trim());
    if (parsed && typeof parsed.state === "string") {
      prState = parsed.state.toUpperCase() as PullRequestState;
      isMerged = prState === "MERGED" || Boolean(parsed.mergedAt);
      const mergeable = String(parsed.mergeable || "").toUpperCase();
      const mergeableStatus: MergeableStatus = mergeable === "CONFLICTING" ? "conflicting" : mergeable === "MERGEABLE" ? "mergeable" : "unknown";
      const headSha = typeof parsed.headRefOid === "string" && parsed.headRefOid.trim()
        ? parsed.headRefOid.trim()
        : undefined;
      if (isMerged) {
        return {
          state: "MERGED",
          merged: true,
          ciStatus: "success",
          mergeableStatus: "mergeable",
          ...(headSha ? { headSha } : {}),
        };
      }
      prHeadSha = headSha;
      prHeadRefName = typeof parsed.headRefName === "string" && parsed.headRefName.trim()
        ? parsed.headRefName.trim()
        : undefined;
    }
  } catch {
    // Fall back to checks or REST API
  }

  // 2. Check CI Checks via gh CLI
  try {
    const { stdout } = await execAsync(
      `gh pr checks "${prUrl}" --json bucket,state,name,workflow,startedAt`,
      { cwd: cwd || process.cwd(), timeout: 3_000 },
    );
    const parsed = JSON.parse(stdout.trim());
    if (Array.isArray(parsed)) {
      return {
        state: prState,
        merged: isMerged,
        ciStatus: evaluateChecks(parsed),
        mergeableStatus: (typeof (parsed as any).mergeableStatus === "string" ? (parsed as any).mergeableStatus : undefined),
        ...(prHeadSha ? { headSha: prHeadSha } : {}),
        ...(prHeadRefName ? { headRefName: prHeadRefName } : {}),
      };
    }
  } catch {
    // gh CLI checks might fail
  }

  // 3. Fallback to GitHub REST API
  const match = prUrl.match(/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
  if (match) {
    const [, owner, repo, pullNumber] = match;
    try {
      const headers: Record<string, string> = {
        "User-Agent": "paperclip-jules-adapter",
        Accept: "application/vnd.github+json",
      };
      const prRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`,
        { headers, signal: AbortSignal.timeout(3_000) },
      );
      if (prRes.ok) {
        const prData: any = await prRes.json();
        if (prData?.merged === true || prData?.state === "closed") {
          return {
            state: prData?.merged ? "MERGED" : "CLOSED",
            merged: Boolean(prData?.merged),
            ciStatus: "success",
            ...(typeof prData?.head?.sha === "string" ? { headSha: prData.head.sha } : {}),
            ...(typeof prData?.head?.ref === "string" ? { headRefName: prData.head.ref } : {}),
          };
        }
        const headSha = prData?.head?.sha;
        if (headSha) {
          const checkRunsRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/commits/${headSha}/check-runs`,
            { headers, signal: AbortSignal.timeout(3_000) },
          );
          if (checkRunsRes.ok) {
            const checkData: any = await checkRunsRes.json();
            const checkRuns = checkData?.check_runs || [];
            if (checkRuns.length === 0) {
              return { state: "OPEN", merged: false, ciStatus: "pending", headSha,
                ...(typeof prData?.head?.ref === "string" ? { headRefName: prData.head.ref } : {}) };
            }
            const items: CheckItem[] = checkRuns.map((cr: any) => ({
              name: cr.name,
              state: (cr.conclusion || cr.status || "").toUpperCase(),
              bucket: cr.conclusion === "success" ? "pass" : cr.status === "completed" ? "fail" : "pending",
              startedAt: cr.started_at,
            }));
            return {
              state: "OPEN",
              merged: false,
              ciStatus: evaluateChecks(items),
              headSha,
              ...(typeof prData?.head?.ref === "string" ? { headRefName: prData.head.ref } : {}),
            };
          }
        }
      }
    } catch {
      // Ignore network errors
    }
  }

  return {
    state: prState,
    merged: isMerged,
    ciStatus: isMerged ? "success" : "pending",
  };
}

export async function getPullRequestCiStatus(
  prUrl: string,
  cwd?: string,
): Promise<CiCheckStatus> {
  const details = await getPullRequestDetails(prUrl, cwd);
  return details.ciStatus;
}
