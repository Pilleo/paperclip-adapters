import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildRecoveryCanaryWorkspace, createRecoveryCanaryCheckout } from "../src/core/recovery-canary-workspace.js";
import { resolveProjectMetadata } from "../src/core/parser.js";
import { checkWorkspaceConsistency } from "../src/core/consistency.js";

const run = promisify(execFile);

describe("pinned-host recovery canary workspace", () => {
  it("registers the real local repository metadata required before native PR review", () => {
    const workspace = buildRecoveryCanaryWorkspace("/tmp/disposable-clean-checkout", "master");
    expect(workspace).toMatchObject({
      sourceType: "local_path",
      cwd: "/tmp/disposable-clean-checkout",
      repoUrl: "https://github.com/pilleo/paperclip-adapters.git",
      defaultRef: "master",
    });
    expect(resolveProjectMetadata({ id: "disposable-project", primaryWorkspace: workspace })).toMatchObject({
      ok: true,
      repoUrl: "https://github.com/pilleo/paperclip-adapters.git",
      defaultRef: "master",
    });
  });

  it("uses a separate clean Git checkout at the pinned remote head without modifying the development checkout", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "canary-workspace-test-"));
    const remote = path.join(home, "origin.git");
    const developer = path.join(home, "developer");
    try {
      await run("git", ["init", "--bare", "--initial-branch=master", remote]);
      await run("git", ["clone", remote, developer]);
      await run("git", ["-C", developer, "config", "user.email", "canary@example.test"]);
      await run("git", ["-C", developer, "config", "user.name", "Canary"]);
      await run("git", ["-C", developer, "commit", "--allow-empty", "-m", "initial"]);
      await run("git", ["-C", developer, "push", "origin", "master"]);
      await run("git", ["-C", developer, "commit", "--allow-empty", "-m", "local unpushed"]);
      const ahead = (await run("git", ["-C", developer, "rev-parse", "HEAD"])).stdout.trim();
      const checkout = await createRecoveryCanaryCheckout(home, remote, "master");
      expect(checkout).not.toBe(developer);
      const remoteHead = (await run("git", ["-C", checkout, "rev-parse", "HEAD"])).stdout.trim();
      expect(remoteHead).not.toBe(ahead);
      expect((await checkWorkspaceConsistency(checkout, remote, "master")).status).toBe("healthy");
      expect((await run("git", ["-C", developer, "rev-parse", "HEAD"])).stdout.trim()).toBe(ahead);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
