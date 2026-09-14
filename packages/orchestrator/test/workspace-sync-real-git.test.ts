import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { reconcileWorkspaceSync } from "../src/core/workspace-sync.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

async function commitAndPush(repository: string, content: string): Promise<string> {
  await writeFile(join(repository, "canary.txt"), content, "utf8");
  await git(repository, "add", "canary.txt");
  await git(repository, "commit", "-m", content);
  await git(repository, "push", "origin", "master");
  return git(repository, "rev-parse", "HEAD");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("workspace synchronization with real Git", () => {
  it("fast-forwards from the configured project remote, not local origin", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-workspace-sync-"));
    temporaryDirectories.push(root);
    const remote = join(root, "configured.git");
    const checkout = join(root, "checkout");
    const writer = join(root, "writer");
    await git(root, "init", "--bare", remote);
    await execFileAsync("git", ["clone", remote, checkout]);
    await git(checkout, "config", "user.email", "workspace-sync@example.test");
    await git(checkout, "config", "user.name", "Workspace Sync Test");
    await commitAndPush(checkout, "initial");
    await execFileAsync("git", ["clone", remote, writer]);
    await git(writer, "config", "user.email", "workspace-sync@example.test");
    await git(writer, "config", "user.name", "Workspace Sync Test");
    const configuredRemoteHead = await commitAndPush(writer, "remote-only");
    await git(checkout, "remote", "set-url", "origin", join(root, "incorrect-origin.git"));

    const decision = await reconcileWorkspaceSync({
      workspacePath: checkout,
      policy: { repoUrl: remote, defaultRef: "master" },
    });

    expect(decision).toEqual({ action: "ready" });
    await expect(git(checkout, "rev-parse", "HEAD")).resolves.toBe(configuredRemoteHead);
  });
});
