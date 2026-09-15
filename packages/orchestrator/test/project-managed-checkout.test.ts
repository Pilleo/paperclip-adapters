import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureManagedProjectCheckout,
  managedProjectCheckoutPath,
} from "../src/core/project-managed-checkout.js";

const execFileAsync = promisify(execFile);

describe("managed project checkout compatibility", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("atomically materializes a missing exact Paperclip-managed checkout from the project repository", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-managed-checkout-"));
    roots.push(root);
    const source = path.join(root, "source");
    const remote = path.join(root, "origin.git");
    const instanceRoot = path.join(root, "instance");
    const workspacePath = managedProjectCheckoutPath({
      instanceRoot,
      companyId: "company-1",
      projectId: "project-1",
      repoUrl: remote,
    });

    await fs.mkdir(source);
    await execFileAsync("git", ["init", "--initial-branch=master"], { cwd: source });
    await execFileAsync("git", ["config", "user.email", "canary@example.invalid"], { cwd: source });
    await execFileAsync("git", ["config", "user.name", "Canary"], { cwd: source });
    await fs.writeFile(path.join(source, "README.md"), "# disposable canary\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: source });
    await execFileAsync("git", ["commit", "-m", "seed"], { cwd: source });
    await execFileAsync("git", ["clone", "--bare", source, remote]);

    await expect(ensureManagedProjectCheckout({
      instanceRoot,
      companyId: "company-1",
      projectId: "project-1",
      workspacePath,
      repoUrl: remote,
      defaultRef: "master",
    })).resolves.toEqual({ status: "materialized", workspacePath });

    await expect(execFileAsync("git", ["rev-parse", "--verify", "HEAD"], { cwd: workspacePath })).resolves.toMatchObject({
      stdout: expect.stringMatching(/^[0-9a-f]{40}/),
    });
  });

  it("refuses to clone into a project path Paperclip does not own", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-managed-checkout-"));
    roots.push(root);

    await expect(ensureManagedProjectCheckout({
      instanceRoot: path.join(root, "instance"),
      companyId: "company-1",
      projectId: "project-1",
      workspacePath: path.join(root, "arbitrary-local-folder"),
      repoUrl: "https://example.invalid/acme/widget.git",
      defaultRef: "master",
    })).resolves.toEqual({ status: "rejected", reason: "not_paperclip_managed_path" });
  });
});
