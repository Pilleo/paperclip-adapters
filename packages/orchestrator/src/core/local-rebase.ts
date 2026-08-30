import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PrMergeabilityInfo } from "./git-safety.js";

const execFileAsync = promisify(execFile);

export interface LocalRebaseResult {
  readonly ok: boolean;
  readonly message: string;
}

/**
 * Resolve merge conflicts on the PR branch in the local workspace.
 * A new Jules session cannot rebase a dirty GitHub branch; this must happen on the host.
 */
export async function rebasePrBranchLocally(
  info: PrMergeabilityInfo,
  cwd: string,
  execFn: typeof execFileAsync = execFileAsync
): Promise<LocalRebaseResult> {
  const head = info.headRefName;
  const base = info.baseRefName || "master";
  if (!head) {
    return { ok: false, message: "PR head ref is unknown; cannot rebase locally." };
  }

  try {
    await execFn("git", ["fetch", "origin", head, base], { cwd });
    await execFn("git", ["checkout", head], { cwd });
    await execFn("git", ["rebase", `origin/${base}`], { cwd });
    await execFn("git", ["push", "--force-with-lease", "origin", head], { cwd });
    return {
      ok: true,
      message: `Rebased \`${head}\` onto origin/${base} locally and pushed.`,
    };
  } catch (err: unknown) {
    try {
      await execFn("git", ["rebase", "--abort"], { cwd });
    } catch {
      // already not in a rebase
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Local rebase of \`${head}\` onto origin/${base} failed: ${msg}` };
  }
}
