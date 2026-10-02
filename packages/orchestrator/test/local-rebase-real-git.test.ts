import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { rebasePrBranchLocally } from "../src/core/local-rebase.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function repository(overlap: boolean) {
  const root = await mkdtemp(path.join(tmpdir(), "conflict-git-test-")); roots.push(root);
  const cwd = path.join(root, "project"); await mkdir(cwd);
  const git = async (...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();
  await git("init", "-b", "main"); await git("config", "user.name", "Test author"); await git("config", "user.email", "test@example.test");
  await writeFile(path.join(cwd, "shared.txt"), "seed\n"); await git("add", "."); await git("commit", "-m", "seed");
  await git("clone", "--bare", cwd, path.join(root, "remote.git")); await git("remote", "add", "origin", path.join(root, "remote.git"));
  await git("checkout", "-b", "feature"); await writeFile(path.join(cwd, overlap ? "shared.txt" : "feature.txt"), "feature\n");
  await git("add", "."); await git("commit", "-m", "feature"); const head = await git("rev-parse", "HEAD"); await git("push", "origin", "feature");
  await git("checkout", "main"); await writeFile(path.join(cwd, "shared.txt"), "base\n"); await git("add", "."); await git("commit", "-m", "base");
  const base = await git("rev-parse", "HEAD"); await git("push", "origin", "main");
  return { cwd, git, head, base, info: { prNumber: 1, mergeable: overlap ? "CONFLICTING" : "MERGEABLE",
    headRefName: "feature", baseRefName: "main", headRefOid: head, baseRefOid: base } };
}

describe("isolated real Git integration", () => {
  it("integrates cleanly without touching a dirty project checkout or its index", async () => {
    const r = await repository(false);
    await writeFile(path.join(r.cwd, "shared.txt"), "user's unstaged work\n");
    await writeFile(path.join(r.cwd, "staged.txt"), "user's staged work\n"); await r.git("add", "staged.txt");
    const before = await r.git("status", "--porcelain"); const index = await r.git("write-tree");
    const result = await rebasePrBranchLocally(r.info, r.cwd);
    expect(result.ok).toBe(true);
    expect(await r.git("branch", "--show-current")).toBe("main");
    expect(await r.git("rev-parse", "HEAD")).toBe(r.base);
    expect(await r.git("status", "--porcelain")).toBe(before);
    expect(await r.git("write-tree")).toBe(index);
    const remote = await r.git("ls-remote", "origin", "refs/heads/feature");
    expect(remote.split(/\s/)[0]).not.toBe(r.head);
  });

  it("reports an actual conflict while leaving the original branch and remote head untouched", async () => {
    const r = await repository(true);
    const result = await rebasePrBranchLocally(r.info, r.cwd);
    expect(result.ok).toBe(false);
    expect(await r.git("branch", "--show-current")).toBe("main");
    expect(await r.git("status", "--porcelain")).toBe("");
    expect((await r.git("ls-remote", "origin", "refs/heads/feature")).split(/\s/)[0]).toBe(r.head);
  });

  it("rejects a stale expected head before publishing any integration", async () => {
    const r = await repository(false);
    const result = await rebasePrBranchLocally({ ...r.info, headRefOid: "c".repeat(40) }, r.cwd);
    expect(result.ok).toBe(false);
    expect((await r.git("ls-remote", "origin", "refs/heads/feature")).split(/\s/)[0]).toBe(r.head);
    expect(await r.git("branch", "--show-current")).toBe("main");
  });

  it("observes a remotely accepted push after response loss without pushing twice", async () => {
    const r = await repository(false);
    let pushes = 0;
    const transport = async (command: string, args: readonly string[], options: Parameters<typeof exec>[2]) => {
      const result = await exec(command, [...args], options);
      if (args[0] === "push") { pushes++; throw new Error("acknowledgement lost after remote acceptance"); }
      return result;
    };
    const result = await rebasePrBranchLocally(r.info, r.cwd, transport as typeof exec);
    expect(result.ok).toBe(true);
    expect(pushes).toBe(1);
    expect((await r.git("ls-remote", "origin", "refs/heads/feature")).split(/\s/)[0]).toBe(result.headSha);
  });
});
