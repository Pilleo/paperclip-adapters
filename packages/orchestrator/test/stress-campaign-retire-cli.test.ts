import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildStressIssue, stressTasks } from "../src/core/stress-campaign-manifest.js";

const exec = promisify(execFile);
const runKey = "stress-20260929-20pr-a";
const companyId = "8f4ef932-d769-43b2-981a-d273ed715162";
const projectId = "db166929-2e4e-454d-aee9-25f5380543c4";
const prUrl = "https://github.com/Pilleo/paperclip-adapters-e2e-20260923-vanilla-review/pull/4";
const tasks = stressTasks(runKey);
const ids = new Map(tasks.map((task) => [task.key, `fixture-${task.key}`]));
const issues = tasks.map((task) => ({ id: ids.get(task.key),
  ...buildStressIssue(task, projectId, task.predecessors.map((key) => ids.get(key)!)),
  status: task.key === "01" ? "in_review" : task.key === "03" ? "blocked" : "todo",
  assigneeAgentId: task.key === "03" ? "jules-agent" : null,
  blockedBy: task.predecessors.map((key) => ({ id: ids.get(key) })),
  workProducts: task.key === "01" ? [{ id: "pr4", type: "pull_request", isPrimary: true,
    status: "ready_for_review", url: prUrl }] : [],
  ...(task.key === "01" || task.key === "03" ? { executionBlocker: { runId: `stopped-${task.key}` } } : {}),
}));

describe("stress campaign native retirement transport", () => {
  it("dry-runs exact 20 original issues in descendant-first order with GET only", async () => {
    const methods: string[] = [];
    const server = createServer((request, response) => {
      methods.push(request.method ?? "unknown");
      response.setHeader("content-type", "application/json");
      const url = new URL(request.url ?? "/", "http://localhost");
      const issueId = url.pathname.match(/^\/api\/issues\/([^/]+)$/)?.[1];
      const body = url.pathname.endsWith("/approvals")
        ? [{ id: "merge-01", status: "pending", type: "request_board_approval",
          payload: { action: "task_merge", issueId: ids.get("01"), prUrl } }]
        : url.pathname.includes("/live-runs") ? []
        : url.pathname === "/api/companies" ? [{ id: companyId }]
        : url.searchParams.has("parentId") || url.pathname.endsWith("/interactions") ? []
        : issueId ? issues.find((issue) => issue.id === issueId) ?? null : issues;
      response.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No loopback listener");
    try {
      const { stdout } = await exec("pnpm", ["exec", "tsx", "scripts/stress-campaign-retire.ts", "--dry-run"], {
        cwd: process.cwd(), timeout: 30_000,
        env: { ...process.env, PAPERCLIP_TEST_API_URL: `http://127.0.0.1:${address.port}`,
          PAPERCLIP_E2E_COMPANY_ID: companyId, PAPERCLIP_STRESS_PROJECT_ID: projectId,
          PAPERCLIP_STRESS_RUN_KEY: runKey },
      });
      const report = JSON.parse(stdout) as { originalIssues: number; retirementOrder: readonly string[]; pendingMergeGate: string };
      expect(report.originalIssues).toBe(20);
      expect(report.retirementOrder).toEqual(Array.from({ length: 20 }, (_, i) => String(20 - i).padStart(2, "0")));
      expect(report.pendingMergeGate).toBe("merge-01");
      expect(new Set(methods)).toEqual(new Set(["GET"]));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("never repeats an uncertain task cancellation across operator process invocations", async () => {
    const attempts: string[] = [];
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "PATCH") {
        attempts.push(url.pathname);
        request.socket.destroy();
        return;
      }
      response.setHeader("content-type", "application/json");
      const issueId = url.pathname.match(/^\/api\/issues\/([^/]+)$/)?.[1];
      const result = url.pathname.endsWith("/approvals")
        ? [{ id: "merge-01", status: "rejected", type: "request_board_approval", payload: {
          action: "task_merge", issueId: ids.get("01"), prUrl } }]
        : url.pathname.endsWith("/recovery-actions") ? { active: null, actions: [] }
        : url.pathname === "/api/companies" ? [{ id: companyId }]
        : url.pathname.endsWith("/live-runs") || url.searchParams.has("parentId") || url.pathname.endsWith("/interactions") ? []
        : issueId ? issues.find((issue) => issue.id === issueId) ?? null : issues;
      response.end(JSON.stringify(result));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No loopback listener");
    const dir = await mkdtemp(path.join(tmpdir(), "stress-retirement-journal-"));
    await chmod(dir, 0o700);
    await writeFile(path.join(dir, `paperclip-stress-${runKey}.jsonl`),
      tasks.map((task) => JSON.stringify({ runKey, event: "issue_verified", task: task.key, issueId: ids.get(task.key) })).join("\n") + "\n", { mode: 0o600 });
    try {
      const run = () => exec("pnpm", ["exec", "tsx", "scripts/stress-campaign-retire.ts", "--retire"], {
        cwd: process.cwd(), timeout: 30_000, env: { ...process.env,
          PAPERCLIP_TEST_API_URL: `http://127.0.0.1:${address.port}`,
          PAPERCLIP_E2E_COMPANY_ID: companyId, PAPERCLIP_STRESS_PROJECT_ID: projectId,
          PAPERCLIP_STRESS_RUN_KEY: runKey, PAPERCLIP_STRESS_JOURNAL_DIR: `${dir}/` },
      });
      await expect(run()).rejects.toThrow();
      await expect(run()).rejects.toThrow(/unresolved cancellation intent/i);
      expect(attempts).toEqual([`/api/issues/${ids.get("20")}`]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });
});
