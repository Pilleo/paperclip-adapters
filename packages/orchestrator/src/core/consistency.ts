import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gitCommandOptions } from "./git-command-timeout.js";

const execFileAsync = promisify(execFile);

export type SyncObservation =
  | { readonly type: "missing_repo_url" }
  | { readonly type: "missing_default_ref"; readonly repoUrl: string }
  | { readonly type: "command_failure"; readonly error: string; readonly repoUrl?: string; readonly defaultRef?: string }
  | { readonly type: "remote_unavailable"; readonly error: string; readonly repoUrl: string; readonly defaultRef: string }
  | { readonly type: "dirty"; readonly localBranch: string; readonly localSha: string; readonly repoUrl: string; readonly defaultRef: string }
  | { readonly type: "non_default_branch"; readonly localBranch: string; readonly localSha: string; readonly repoUrl: string; readonly defaultRef: string }
  | { readonly type: "diverged"; readonly localSha: string; readonly remoteSha: string; readonly repoUrl: string; readonly defaultRef: string }
  | { readonly type: "up_to_date"; readonly localSha: string; readonly remoteSha: string; readonly repoUrl: string; readonly defaultRef: string }
  | { readonly type: "clean_fast_forwardable"; readonly localSha: string; readonly remoteSha: string; readonly repoUrl: string; readonly defaultRef: string }
  | { readonly type: "pull_failed"; readonly localSha: string; readonly remoteSha: string; readonly error: string; readonly repoUrl: string; readonly defaultRef: string }
  | { readonly type: "post_pull_verification_failed"; readonly localSha: string; readonly remoteSha: string; readonly postPullSha: string; readonly repoUrl: string; readonly defaultRef: string };

export type SyncDisposition =
  | { readonly status: "healthy"; readonly observation: Extract<SyncObservation, { type: "up_to_date" | "clean_fast_forwardable" }> }
  | { readonly status: "unhealthy"; readonly observation: Exclude<SyncObservation, { type: "up_to_date" | "clean_fast_forwardable" }> };

/**
 * Backward compatible report wrapper.
 */
export interface WorkspaceConsistencyReport {
  readonly isClean: boolean;
  readonly currentBranch: string;
  readonly headSha: string;
  readonly isConsistent: boolean;
  readonly warning?: string;
  readonly status: "healthy" | "unhealthy";
  readonly observation: SyncObservation;
}

/**
 * Thorough workspace verification and synchronization.
 */
export async function checkWorkspaceConsistency(workspacePath: string, repoUrl?: string, defaultRef?: string): Promise<WorkspaceConsistencyReport> {
  const evaluate = (status: "healthy" | "unhealthy", observation: SyncObservation, overrides: { isClean?: boolean; currentBranch?: string; headSha?: string; isConsistent?: boolean; warning?: string } = {}): WorkspaceConsistencyReport => {
    return Object.freeze({
      isClean: overrides.isClean ?? false,
      currentBranch: overrides.currentBranch ?? "unknown",
      headSha: overrides.headSha ?? "",
      isConsistent: overrides.isConsistent ?? (status === "healthy"),
      ...(overrides.warning !== undefined ? { warning: overrides.warning } : {}),
      status,
      observation,
    });
  };

  if (!repoUrl) {
    return evaluate("unhealthy", { type: "missing_repo_url" }, { warning: "Missing repoUrl in Project metadata." });
  }
  if (!defaultRef) {
    return evaluate("unhealthy", { type: "missing_default_ref", repoUrl }, { warning: "Missing defaultRef in Project metadata." });
  }

  let localBranch = "unknown";
  let localSha = "";
  let isClean = false;

  try {
    const [branchRes, headRes, statusRes] = await Promise.all([
      execFileAsync("git", ["branch", "--show-current"], { cwd: workspacePath, ...gitCommandOptions() }),
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspacePath, ...gitCommandOptions() }),
      execFileAsync("git", ["status", "--porcelain"], { cwd: workspacePath, ...gitCommandOptions() }),
    ]);
    localBranch = branchRes.stdout.trim();
    localSha = headRes.stdout.trim();
    isClean = statusRes.stdout.trim().length === 0;
  } catch (err: any) {
    return evaluate("unhealthy", { type: "command_failure", error: err.message, repoUrl, defaultRef }, { warning: `Failed to inspect local workspace: ${err.message}` });
  }

  if (!isClean) {
    return evaluate("unhealthy", { type: "dirty", localBranch, localSha, repoUrl, defaultRef }, { isClean, currentBranch: localBranch, headSha: localSha, isConsistent: true, warning: "Local workspace has uncommitted changes; worker adapter will manage its own workspace isolation." });
  }

  if (localBranch !== defaultRef) {
    return evaluate("unhealthy", { type: "non_default_branch", localBranch, localSha, repoUrl, defaultRef }, { isClean, currentBranch: localBranch, headSha: localSha, isConsistent: false, warning: `Workspace is on ${localBranch}, expected ${defaultRef}.` });
  }

  let remoteSha = "";
  try {
    const lsRemote = await execFileAsync("git", ["ls-remote", repoUrl, defaultRef], { cwd: workspacePath, ...gitCommandOptions() });
    const output = lsRemote.stdout.trim();
    if (!output) {
      return evaluate("unhealthy", { type: "remote_unavailable", error: "Empty output from ls-remote", repoUrl, defaultRef }, { isClean, currentBranch: localBranch, headSha: localSha, isConsistent: false, warning: `Remote ref ${defaultRef} not found.` });
    }
    remoteSha = output.split(/\s+/)[0] || "";
    if (!remoteSha) {
      return evaluate("unhealthy", { type: "remote_unavailable", error: "Unable to parse ls-remote output", repoUrl, defaultRef }, { isClean, currentBranch: localBranch, headSha: localSha, isConsistent: false, warning: `Failed to parse remote ref ${defaultRef}.` });
    }
  } catch (err: any) {
    return evaluate("unhealthy", { type: "remote_unavailable", error: err.message, repoUrl, defaultRef }, { isClean, currentBranch: localBranch, headSha: localSha, isConsistent: false, warning: `Failed to fetch remote state: ${err.message}` });
  }

  if (localSha === remoteSha) {
    return evaluate("healthy", { type: "up_to_date", localSha, remoteSha, repoUrl, defaultRef }, { isClean, currentBranch: localBranch, headSha: localSha, isConsistent: true });
  }

  try {
    await execFileAsync("git", ["fetch", repoUrl, defaultRef], { cwd: workspacePath, ...gitCommandOptions() });
    const mergeBase = await execFileAsync("git", ["merge-base", "HEAD", "FETCH_HEAD"], { cwd: workspacePath, ...gitCommandOptions() });
    if (mergeBase.stdout.trim() !== localSha) {
      return evaluate("unhealthy", { type: "diverged", localSha, remoteSha, repoUrl, defaultRef }, { isClean, currentBranch: localBranch, headSha: localSha, isConsistent: false, warning: `Workspace has diverged from ${defaultRef}.` });
    }
  } catch (err: any) {
    return evaluate("unhealthy", { type: "command_failure", error: err.message, repoUrl, defaultRef }, { isClean, currentBranch: localBranch, headSha: localSha, isConsistent: false, warning: `Failed to fetch/compare remote state: ${err.message}` });
  }

  try {
    await execFileAsync("git", ["pull", "--ff-only", repoUrl, defaultRef], { cwd: workspacePath, ...gitCommandOptions() });
    const postHead = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspacePath, ...gitCommandOptions() });
    const postPullSha = postHead.stdout.trim();
    if (postPullSha !== remoteSha) {
      return evaluate("unhealthy", { type: "post_pull_verification_failed", localSha, remoteSha, postPullSha, repoUrl, defaultRef }, { isClean, currentBranch: localBranch, headSha: postPullSha, isConsistent: false, warning: `HEAD mismatch after pull: expected ${remoteSha}, got ${postPullSha}` });
    }
    return evaluate("healthy", { type: "clean_fast_forwardable", localSha, remoteSha, repoUrl, defaultRef }, { isClean, currentBranch: localBranch, headSha: postPullSha, isConsistent: true });
  } catch (err: any) {
    return evaluate("unhealthy", { type: "pull_failed", localSha, remoteSha, error: err.message, repoUrl, defaultRef }, { isClean, currentBranch: localBranch, headSha: localSha, isConsistent: false, warning: `Failed to fast-forward workspace: ${err.message}` });
  }
}

/**
 * Pure evaluation of workspace consistency (backward compatibility wrapper).
 */
export function evaluateWorkspaceConsistency(params: {
  readonly isClean: boolean;
  readonly currentBranch: string;
  readonly headSha: string;
}): WorkspaceConsistencyReport {
  const { isClean, currentBranch, headSha } = params;

  if (!isClean) {
    return Object.freeze({
      isClean: false,
      currentBranch,
      headSha,
      isConsistent: true, // Non-fatal, local edits preserved
      warning: "Local workspace has uncommitted changes; worker adapter will manage its own workspace isolation.",
      status: "unhealthy" as const,
      observation: { type: "dirty" as const, localBranch: currentBranch, localSha: headSha, repoUrl: "unknown", defaultRef: "unknown" },
    });
  }

  return Object.freeze({
    isClean: true,
    currentBranch,
    headSha,
    isConsistent: true,
    status: "unhealthy" as const, // Legacy tests assume we pass backwards check, but without repo config we are missing it
    observation: { type: "missing_repo_url" as const },
  });
}
