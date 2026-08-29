import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WorkspaceConsistencyReport {
  readonly isClean: boolean;
  readonly currentBranch: string;
  readonly headSha: string;
  readonly isConsistent: boolean;
  readonly warning?: string;
}

/**
 * Pure evaluation of workspace consistency.
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
    });
  }

  return Object.freeze({
    isClean: true,
    currentBranch,
    headSha,
    isConsistent: true,
  });
}

/**
 * Read-only workspace check: inspects git status and branch without mutating files.
 */
export async function checkWorkspaceConsistency(workspacePath: string): Promise<WorkspaceConsistencyReport> {
  try {
    const [branchRes, headRes, statusRes] = await Promise.all([
      execFileAsync("git", ["branch", "--show-current"], { cwd: workspacePath }).catch(() => ({ stdout: "" })),
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspacePath }).catch(() => ({ stdout: "" })),
      execFileAsync("git", ["status", "--porcelain"], { cwd: workspacePath }).catch(() => ({ stdout: "" })),
    ]);

    const currentBranch = branchRes.stdout.trim();
    const headSha = headRes.stdout.trim();
    const isClean = statusRes.stdout.trim().length === 0;

    return evaluateWorkspaceConsistency({ isClean, currentBranch, headSha });
  } catch (err: any) {
    return Object.freeze({
      isClean: false,
      currentBranch: "unknown",
      headSha: "",
      isConsistent: false,
      warning: `Failed to inspect workspace consistency: ${err.message}`,
    });
  }
}
