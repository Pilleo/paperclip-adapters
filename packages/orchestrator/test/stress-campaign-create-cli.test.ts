import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const repo = "ssh://git@github.com/Pilleo/paperclip-adapters-e2e-20260923-vanilla-review.git";
const project = { id: "campaign-id", name: "Disposable stress [stress:stress-20260929-a]",
  description: "<!-- paperclip-adapters:stress-project:v1 -->",
  primaryWorkspace: { sourceType: "git_repo", repoUrl: repo, defaultRef: "master" },
  codebase: { effectiveLocalFolder: "/tmp/campaign-managed" } };
const old = { id: "d53718c7-90c3-462b-b8bb-4ff7d54fa37e", codebase: { effectiveLocalFolder: "/tmp/old-managed" } };
const workspace = { id: "ws", isPrimary: true, sourceType: "git_repo", repoUrl: repo, defaultRef: "master" };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("disposable stress campaign operator CLI", () => {
  it("dry-runs offline without requiring board configuration", async () => {
    const { stdout } = await exec("pnpm", ["exec", "tsx", "scripts/stress-campaign-create.ts", "--dry-run", "--run-key", "stress-20260929-a"], {
      cwd: process.cwd(), timeout: 20_000,
      env: { ...process.env, PAPERCLIP_TEST_API_URL: "", PAPERCLIP_STRESS_JOURNAL_DIR: "" },
    });
    const result = JSON.parse(stdout) as { graph: readonly unknown[] };
    expect(result.graph).toHaveLength(20);
  });

  it("reuses one exact project/workspace through read-only HTTP and journals the verified identity", async () => {
    const methods: string[] = [];
    const server = createServer((request, response) => {
      methods.push(request.method ?? "missing");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(request.url?.endsWith("/projects") ? [old, project] : [workspace]));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback listener");
    const dir = await mkdtemp(path.join(tmpdir(), "paperclip-stress-cli-"));
    dirs.push(dir);
    await chmod(dir, 0o700);
    try {
      const { stdout } = await exec("pnpm", ["exec", "tsx", "scripts/stress-campaign-create.ts", "--provision", "--run-key", "stress-20260929-a"], {
        cwd: process.cwd(), timeout: 20_000,
        env: { ...process.env, PAPERCLIP_TEST_API_URL: `http://127.0.0.1:${address.port}`,
          PAPERCLIP_E2E_COMPANY_ID: "company", PAPERCLIP_STRESS_JOURNAL_DIR: `${dir}/` },
      });
      expect(JSON.parse(stdout)).toMatchObject({ projectId: "campaign-id", stage: "provisioned" });
      expect(methods.length).toBeGreaterThan(0);
      expect(new Set(methods)).toEqual(new Set(["GET"]));
      const journal = await readFile(path.join(dir, "paperclip-stress-stress-20260929-a.jsonl"), "utf8");
      expect(journal).toContain('"event":"workspace_verified"');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not repeat an ambiguous project POST across invocations", async () => {
    let posts = 0;
    const server = createServer((request, response) => {
      if (request.method === "POST") {
        posts += 1;
        request.socket.destroy();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify([old]));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback listener");
    const dir = await mkdtemp(path.join(tmpdir(), "paperclip-stress-lost-post-"));
    dirs.push(dir);
    await chmod(dir, 0o700);
    try {
      const run = () => exec("pnpm", ["exec", "tsx", "scripts/stress-campaign-create.ts", "--provision", "--run-key", "stress-20260929-b"], {
        cwd: process.cwd(), timeout: 20_000,
        env: { ...process.env, PAPERCLIP_TEST_API_URL: `http://127.0.0.1:${address.port}`,
          PAPERCLIP_E2E_COMPANY_ID: "company", PAPERCLIP_STRESS_JOURNAL_DIR: `${dir}/` },
      });
      await expect(run()).rejects.toThrow();
      await expect(run()).rejects.toThrow(/Unresolved project creation intent/);
      expect(posts).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reuses the marked project for a new pilot only after old stress issues are terminal", async () => {
    let oldStatus = "blocked";
    const methods: string[] = [];
    const server = createServer((request, response) => {
      methods.push(request.method ?? "missing");
      response.setHeader("content-type", "application/json");
      const url = new URL(request.url ?? "/", "http://localhost");
      const payload = url.pathname.endsWith("/projects") ? [old, project]
        : url.pathname.endsWith("/workspaces") ? [workspace]
        : [{ id: "old-stress-issue", status: oldStatus,
          description: "<!-- paperclip-adapters:stress-run:stress-20260929-a -->" }];
      response.end(JSON.stringify(payload));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback listener");
    const dir = await mkdtemp(path.join(tmpdir(), "paperclip-stress-reuse-"));
    dirs.push(dir);
    await chmod(dir, 0o700);
    const execute = () => exec("pnpm", ["exec", "tsx", "scripts/stress-campaign-create.ts", "--provision", "--run-key", "stress-20260929-pilot-b"], {
      cwd: process.cwd(), timeout: 20_000,
      env: { ...process.env, PAPERCLIP_TEST_API_URL: `http://127.0.0.1:${address.port}`,
        PAPERCLIP_E2E_COMPANY_ID: "company", PAPERCLIP_STRESS_JOURNAL_DIR: `${dir}/`,
        PAPERCLIP_STRESS_PROJECT_ID: "campaign-id", PAPERCLIP_STRESS_KIND: "pilot" },
    });
    try {
      await expect(execute()).rejects.toThrow(/unfinished.*stress|previous.*nonterminal/i);
      oldStatus = "cancelled";
      const { stdout } = await execute();
      expect(JSON.parse(stdout)).toMatchObject({ projectId: "campaign-id", stage: "provisioned" });
      expect(new Set(methods)).toEqual(new Set(["GET"]));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
