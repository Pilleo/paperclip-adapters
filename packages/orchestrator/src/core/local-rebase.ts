import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { PrMergeabilityInfo } from "./git-safety.js";

const execFileAsync = promisify(execFile);
export interface LocalRebaseResult {
  readonly ok: boolean;
  readonly message: string;
  readonly headSha?: string;
  readonly baseSha?: string;
  readonly uncertain?: boolean;
}

/** Only the owned clone is mutated; the project worktree/index/branches are untouched. */
export async function rebasePrBranchLocally(
  info: PrMergeabilityInfo, cwd: string, execFn: typeof execFileAsync = execFileAsync,
  beforePush?: (headSha: string, baseSha: string) => Promise<void>,
): Promise<LocalRebaseResult> {
  const head = info.headRefName;
  const base = info.baseRefName;
  if (!head || !base) return { ok: false, message: "PR branch identity unavailable; integration held." };
  const root = await mkdtemp(path.join(tmpdir(), "paperclip-conflict-integration-"));
  const clone = path.join(root, "repository");
  const git = async (args: string[], directory = clone) =>
    (await execFn("git", args, { cwd: directory, timeout: 30_000 })).stdout.trim();
  try {
    await git(["check-ref-format", `refs/heads/${head}`], cwd);
    await git(["check-ref-format", `refs/heads/${base}`], cwd);
    const origin = await git(["remote", "get-url", "origin"], cwd);
    if (!origin) throw new Error("Configured project origin is unavailable");
    await git(["clone", "--no-hardlinks", "--no-checkout", "--single-branch", "--branch", head, "--", origin, clone], cwd);
    await git(["fetch", "origin", `refs/heads/${base}:refs/remotes/origin/${base}`]);
    const oldHead = await git(["rev-parse", `refs/remotes/origin/${head}`]);
    const baseSha = await git(["rev-parse", `refs/remotes/origin/${base}`]);
    if ((info.headRefOid && oldHead !== info.headRefOid) || (info.baseRefOid && baseSha !== info.baseRefOid)) {
      return { ok: false, message: "PR head/base changed before integration; publication held." };
    }
    await git(["checkout", "--detach", oldHead]);
    await git(["config", "user.name", "Paperclip conflict integration"]);
    await git(["config", "user.email", "paperclip-integration@localhost"]);
    try { await git(["rebase", baseSha]); }
    catch (error) {
      const unresolved = await git(["diff", "--name-only", "--diff-filter=U"]);
      if (!unresolved) throw error;
      try { await git(["rebase", "--abort"]); }
      catch (abortError) { throw new Error(`Integration failed (${String(error)}); abort failed (${String(abortError)})`); }
      return { ok: false, message: `Unresolved conflicts in ${unresolved.replace(/\n/g, ", ")}; isolated rebase aborted.` };
    }
    const candidate = await git(["rev-parse", "HEAD"]);
    const refs = await git(["ls-remote", "--heads", "origin", `refs/heads/${head}`, `refs/heads/${base}`]);
    const observed = new Map(refs.split("\n").filter(Boolean).map((line) => {
      const [sha, ref] = line.split(/\s+/); return [ref!, sha!] as const;
    }));
    if (observed.get(`refs/heads/${head}`) !== oldHead || observed.get(`refs/heads/${base}`) !== baseSha) {
      return { ok: false, message: "Remote head/base changed during integration; publication held." };
    }
    await beforePush?.(candidate, baseSha);
    try {
      await git(["push", `--force-with-lease=refs/heads/${head}:${oldHead}`, "origin", `${candidate}:refs/heads/${head}`]);
    } catch (error) {
      const remote = await git(["ls-remote", "--heads", "origin", `refs/heads/${head}`]);
      if (remote.split(/\s+/)[0] !== candidate) return { ok: false, uncertain: true, headSha: candidate, baseSha,
        message: `Push outcome requires observation: ${String(error)}` };
    }
    const published = await git(["ls-remote", "--heads", "origin", `refs/heads/${head}`]);
    if (published.split(/\s+/)[0] !== candidate) return { ok: false, uncertain: true, headSha: candidate, baseSha,
      message: "Publication acknowledgement does not match the observed remote head" };
    return { ok: true, headSha: candidate, baseSha, message: `Integrated ${head} onto ${base} in an isolated clone and published with an explicit head lease.` };
  } catch (error) {
    return { ok: false, message: `Isolated integration failed: ${String(error)}` };
  } finally {
    // Cleanup errors propagate; never claim a clean recovery after a failed cleanup.
    await rm(root, { recursive: true, force: true });
  }
}
