import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

  it("counts only the two original marked pilot roots while retaining GET-only observation", async () => {
    const methods: string[] = [];
    const pilotRows = rows.filter((issue) => issue.title.startsWith("Stress 03:") || issue.title.startsWith("Stress 04:"));
    const server = createServer((request, response) => {
      methods.push(request.method ?? "missing");
      response.setHeader("content-type", "application/json");
      const url = new URL(request.url ?? "/", "http://localhost");
      const issueId = url.pathname.startsWith("/api/issues/") ? url.pathname.split("/")[3] : null;
      const payload = url.pathname.endsWith("/approvals")
        ? pilotRows.map((issue) => ({ id: `approval-${issue.id}`, status: "pending", payload: { action: "task_start", issueId: issue.id } }))
        : url.pathname.endsWith("/documents") || url.pathname.includes("/interactions") || url.searchParams.has("parentId") ? []
        : issueId ? pilotRows.find((issue) => issue.id === issueId) ?? null : pilotRows;
      response.end(JSON.stringify(payload));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No loopback listener");
    try {
      const { stdout } = await exec("pnpm", ["exec", "tsx", "scripts/stress-campaign-verify.ts", "--run-key", key, "--project-id", projectId], {
        cwd: process.cwd(), timeout: 30_000, env: { ...process.env,
          PAPERCLIP_TEST_API_URL: `http://127.0.0.1:${address.port}`, PAPERCLIP_E2E_COMPANY_ID: "company",
          PAPERCLIP_STRESS_KIND: "pilot" },
      });
      const report = JSON.parse(stdout) as { issues: readonly unknown[]; progress: { kind: string } };
      expect(report.issues).toHaveLength(2);
      expect(report.progress.kind).toBe("awaiting_user_start");
      expect(new Set(methods)).toEqual(new Set(["GET"]));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports the original Jules session from a head-bound document when PR metadata omits providerSessionId", async () => {
    const methods: string[] = [];
    const prUrl = "https://github.com/Pilleo/paperclip-adapters-e2e-20260923-vanilla-review/pull/4";
    const headSha = "a".repeat(40);
    const first = rows[0]!;
    const server = createServer((request, response) => {
      methods.push(request.method ?? "missing");
      response.setHeader("content-type", "application/json");
      const url = new URL(request.url ?? "/", "http://localhost");
      const issueId = url.pathname.startsWith("/api/issues/") ? url.pathname.split("/")[3] : null;
      const data = url.pathname.endsWith("/approvals")
        ? rows.map((issue) => ({ id: `approval-${issue.id}`, status: "approved", payload: { action: "task_start", issueId: issue.id } }))
        : url.pathname.endsWith(`/api/issues/${first.id}/documents`)
          ? [{ id: "session-document", key: "jules-session", createdAt: "2026-09-29T11:57:46Z",
            body: `julesSessionId: 16402543279556714488\nprUrl: ${prUrl}\nprHeadSha: ${headSha}\n` }]
        : url.pathname.endsWith("/documents") || url.pathname.includes("/interactions") || url.searchParams.has("parentId") ? []
        : issueId === first.id
          ? { ...first, status: "in_review", workProducts: [{ id: "registered-pr", type: "pull_request", isPrimary: true,
            status: "ready_for_review", url: prUrl, metadata: { source: "jules", headSha } }] }
        : issueId ? rows.find((issue) => issue.id === issueId) ?? null : rows;
      response.end(JSON.stringify(data));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback listener");
    const bin = await mkdtemp(path.join(tmpdir(), "stress-gh-"));
    const gh = path.join(bin, "gh");
    await writeFile(gh, `#!/usr/bin/env node
if (process.argv[2] !== 'pr' || process.argv[3] !== 'view') process.exit(1);
console.log(JSON.stringify({state:'OPEN',headRefOid:'${headSha}',mergedAt:null,mergeCommit:null}));
`);
    await chmod(gh, 0o700);
    try {
      const { stdout } = await exec("pnpm", ["exec", "tsx", "scripts/stress-campaign-verify.ts", "--run-key", key, "--project-id", projectId], {
        cwd: process.cwd(), timeout: 30_000,
        env: { ...process.env, PAPERCLIP_TEST_API_URL: `http://127.0.0.1:${address.port}`,
          PAPERCLIP_E2E_COMPANY_ID: "company", PAPERCLIP_GH_PATH: gh },
      });
      const report = JSON.parse(stdout) as { issues: readonly { providerSessionId?: string }[] };
      expect(report.issues[0]?.providerSessionId).toBe("16402543279556714488");
      expect(new Set(methods)).toEqual(new Set(["GET"]));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(bin, { recursive: true, force: true });
    }
  });

  it("rejects a registered PR if the existing Jules session handle names a different head", async () => {
    const prUrl = "https://github.com/Pilleo/paperclip-adapters-e2e-20260923-vanilla-review/pull/4";
    const first = rows[0]!;
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      const url = new URL(request.url ?? "/", "http://localhost");
      const issueId = url.pathname.startsWith("/api/issues/") ? url.pathname.split("/")[3] : null;
      const data = url.pathname.endsWith("/approvals") ? rows.map((issue) => ({ id: `approval-${issue.id}`,
        status: "approved", payload: { action: "task_start", issueId: issue.id } }))
        : url.pathname.endsWith(`/api/issues/${first.id}/documents`)
          ? [{ key: "jules-session", createdAt: "2026-09-29T11:57:46Z",
            body: `julesSessionId: 16402543279556714488\nprUrl: ${prUrl}\nprHeadSha: ${"b".repeat(40)}\n` }]
        : url.pathname.endsWith("/documents") || url.pathname.includes("/interactions") || url.searchParams.has("parentId") ? []
        : issueId === first.id ? { ...first, status: "in_review", workProducts: [{ type: "pull_request", isPrimary: true,
          status: "ready_for_review", url: prUrl, metadata: { headSha: "a".repeat(40) } }] }
        : issueId ? rows.find((issue) => issue.id === issueId) ?? null : rows;
      response.end(JSON.stringify(data));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback listener");
    try {
      await expect(exec("pnpm", ["exec", "tsx", "scripts/stress-campaign-verify.ts", "--run-key", key, "--project-id", projectId], {
        cwd: process.cwd(), timeout: 30_000,
        env: { ...process.env, PAPERCLIP_TEST_API_URL: `http://127.0.0.1:${address.port}`, PAPERCLIP_E2E_COMPANY_ID: "company" },
      })).rejects.toThrow(/session handle does not bind/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
