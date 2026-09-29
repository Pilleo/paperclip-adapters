import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { stressTasks } from "../src/core/stress-campaign-manifest.js";

const exec = promisify(execFile);
const projectId = "00000000-0000-4000-8000-000000000001";
const key = "stress-20260929-a";
const tasks = stressTasks(key);
const rows = tasks.map((task) => ({ id: `issue-${task.key}`,
  title: `Stress ${task.key}: ${task.exportName} [stress:${key}:${task.key}]`,
  description: `<!-- paperclip-adapters:stress-run:${key} -->`, projectId, status: "todo",
  assigneeAgentId: null, executionRunId: null, executionBlocker: null, workProducts: [],
  blockedBy: task.predecessors.map((previous) => ({ id: `issue-${previous}` })) }));

describe("stress verifier transport", () => {
  it("reports 20 approved-but-pending starts using GET-only Paperclip reads", async () => {
    const methods: string[] = [];
    const server = createServer((request, response) => {
      methods.push(request.method ?? "missing");
      response.setHeader("content-type", "application/json");
      const url = new URL(request.url ?? "/", "http://localhost");
      const issueId = url.pathname.startsWith("/api/issues/") ? url.pathname.split("/")[3] : null;
      const body = url.pathname.endsWith("/approvals")
        ? rows.map((issue) => ({ id: `approval-${issue.id}`, status: "pending", payload: { action: "task_start", issueId: issue.id } }))
        : url.pathname.endsWith("/documents") || url.pathname.includes("/interactions") || url.searchParams.has("parentId") ? []
        : issueId ? rows.find((issue) => issue.id === issueId) ?? null : rows;
      response.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback listener");
    try {
      const { stdout } = await exec("pnpm", ["exec", "tsx", "scripts/stress-campaign-verify.ts", "--run-key", key, "--project-id", projectId], {
        cwd: process.cwd(), timeout: 30_000,
        env: { ...process.env, PAPERCLIP_TEST_API_URL: `http://127.0.0.1:${address.port}`,
          PAPERCLIP_E2E_COMPANY_ID: "company" },
      });
      const report = JSON.parse(stdout) as { issues: readonly unknown[]; progress: { kind: string } };
      expect(report.issues).toHaveLength(20);
      expect(report.progress.kind).toBe("awaiting_user_start");
      expect(methods.length).toBeGreaterThan(40);
      expect(new Set(methods)).toEqual(new Set(["GET"]));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
