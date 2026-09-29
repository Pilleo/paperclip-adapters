import { createServer } from "node:http";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

const issue = (id: string, status: string, blockedBy: { id: string; status: string }[] = []) => ({
  id,
  title: `Canary ${id}`,
  description: "---\norchestrator_managed: true\n---\n<!-- paperclip-adapters:e2e-run:test -->",
  status,
  blockedBy,
  workProducts: status === "done" ? [{ type: "pull_request", status: "merged", url: `https://github.com/example/canary/pull/${id}` }] : [],
});

async function verify(snapshots: Record<string, unknown> | ((id: string, requestNumber: number) => unknown), args: string[], ghResponses?: Record<string, unknown>): Promise<{ code: number | null; stdout: string; stderr: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const id = req.url?.match(/^\/api\/issues\/([^/]+)$/)?.[1];
    const snapshot = id && (typeof snapshots === "function" ? snapshots(id, requests.length) : snapshots[id]);
    res.writeHead(snapshot ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(snapshot ?? null));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback port");
  const bin = await mkdtemp(path.join(tmpdir(), "canary-gh-"));
  const fixture = path.join(bin, "gh");
  await writeFile(fixture, `#!/usr/bin/env node
const responses = JSON.parse(process.env.CANARY_GH_RESPONSES || '{}');
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'view') {
  if (!(args[2] in responses)) process.exit(1);
  console.log(JSON.stringify(responses[args[2]]));
} else if (args[0] === 'api' && args[1]?.startsWith('repos/')) {
  const match = Object.values(responses).find((pr) => pr.mergeCommit?.oid === args[1].split('/').at(-1));
  if (!match) process.exit(1);
  console.log(JSON.stringify({ parents: match.parents || [{ sha: 'a'.repeat(40) }, { sha: match.headRefOid }] }));
} else process.exit(1);
`);
  await chmod(fixture, 0o700);
  try {
    const child = spawn(process.execPath, ["--import", "tsx", "packages/orchestrator/scripts/e2e-real-project-canary-verify.ts", ...args], {
      cwd: new URL("../../../", import.meta.url).pathname,
      env: {
        ...process.env,
        PAPERCLIP_REAL_E2E: "1",
        PAPERCLIP_TEST_API_URL: `http://127.0.0.1:${address.port}`,
        PAPERCLIP_E2E_JULES_AGENT_ID: "jules",
        PAPERCLIP_E2E_CANARY_A_ID: "a",
        PAPERCLIP_E2E_CANARY_B_ID: "b",
        PAPERCLIP_E2E_CANARY_C_ID: "c",
        PAPERCLIP_GH_PATH: fixture,
        CANARY_GH_RESPONSES: JSON.stringify(ghResponses ?? {}),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    let timer: NodeJS.Timeout | undefined;
    const code = await Promise.race([
      new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("canary verifier exceeded 15-second CLI test bound"));
        }, 15_000);
      }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    return { code, stdout, stderr, requests };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(bin, { recursive: true, force: true });
  }
}

describe("read-only A→B→C canary verifier", () => {
  it("does not return success for a valid intermediate observation in completion mode", async () => {
    const snapshots = { a: issue("a", "in_progress"), b: issue("b", "todo", [{ id: "a", status: "in_progress" }]),
      c: issue("c", "backlog", [{ id: "b", status: "todo" }]) };
    const result = await verify(snapshots, ["--require-complete"]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain('"kind": "await_a"');
    expect(result.requests).toEqual(["GET /api/issues/a", "GET /api/issues/b", "GET /api/issues/c"]);
  });

  it("preserves read-only snapshot mode for nonterminal observations", async () => {
    const result = await verify({ a: issue("a", "in_progress"), b: issue("b", "todo", [{ id: "a", status: "in_progress" }]),
      c: issue("c", "backlog", [{ id: "b", status: "todo" }]) }, []);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"kind": "await_a"');
    expect(result.requests.every((request) => request.startsWith("GET "))).toBe(true);
  });

  it("requires authoritative GitHub merges before accepting three terminal Paperclip work products", async () => {
    const result = await verify({ a: issue("a", "done"), b: issue("b", "done", [{ id: "a", status: "done" }]),
      c: issue("c", "done", [{ id: "b", status: "done" }]) }, ["--require-complete"]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain('"kind": "complete"');
    expect(result.stderr).toMatch(/GitHub|merge/i);
    expect(result.requests.every((request) => request.startsWith("GET "))).toBe(true);
  });

  it("accepts exact merged GitHub heads for three terminal Paperclip work products", async () => {
    const snapshots = Object.fromEntries((["a", "b", "c"] as const).map((id, index) => [id, {
      ...issue(id, "done", index === 0 ? [] : [{ id: index === 1 ? "a" : "b", status: "done" }]),
      workProducts: [{ type: "pull_request", status: "merged", url: `https://github.com/example/canary/pull/${index + 1}`,
        metadata: { headSha: `${index + 1}`.repeat(40) } }],
    }]));
    const ghResponses = Object.fromEntries((["a", "b", "c"] as const).map((_, index) => [
      `https://github.com/example/canary/pull/${index + 1}`,
      { state: "MERGED", headRefOid: `${index + 1}`.repeat(40), mergeCommit: { oid: `${index + 4}`.repeat(40) } },
    ]));
    const result = await verify(snapshots, ["--require-complete"], ghResponses);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"kind": "complete"');
    expect(result.stdout).toContain('"result":"passed"');
  });

  it("rejects a merged PR whose reviewed head differs from Paperclip registration", async () => {
    const snapshots = Object.fromEntries((["a", "b", "c"] as const).map((id, index) => [id, {
      ...issue(id, "done", index === 0 ? [] : [{ id: index === 1 ? "a" : "b", status: "done" }]),
      workProducts: [{ type: "pull_request", status: "merged", url: `https://github.com/example/canary/pull/${index + 1}`,
        metadata: { headSha: `${index + 1}`.repeat(40) } }],
    }]));
    const ghResponses = Object.fromEntries((["a", "b", "c"] as const).map((_, index) => [
      `https://github.com/example/canary/pull/${index + 1}`,
      { state: "MERGED", headRefOid: index === 1 ? "f".repeat(40) : `${index + 1}`.repeat(40),
        mergeCommit: { oid: `${index + 4}`.repeat(40) } },
    ]));
    const result = await verify(snapshots, ["--require-complete"], ghResponses);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/head/i);
  });

  it("rejects squash-like GitHub merge commit without a reviewed-head second parent", async () => {
    const snapshots = Object.fromEntries((["a", "b", "c"] as const).map((id, index) => [id, {
      ...issue(id, "done", index === 0 ? [] : [{ id: index === 1 ? "a" : "b", status: "done" }]),
      workProducts: [{ type: "pull_request", status: "merged", url: `https://github.com/example/canary/pull/${index + 1}`,
        metadata: { headSha: `${index + 1}`.repeat(40) } }],
    }]));
    const ghResponses = Object.fromEntries((["a", "b", "c"] as const).map((_, index) => [
      `https://github.com/example/canary/pull/${index + 1}`,
      { state: "MERGED", headRefOid: `${index + 1}`.repeat(40), mergeCommit: { oid: `${index + 4}`.repeat(40) },
        parents: index === 1 ? [{ sha: "a".repeat(40) }] : undefined },
    ]));
    const result = await verify(snapshots, ["--require-complete"], ghResponses);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/parent|merge commit/i);
  });

  it("does not pass a GitHub-verified terminal chain that retains a failed Jules run blocker", async () => {
    const snapshots = Object.fromEntries((["a", "b", "c"] as const).map((id, index) => [id, {
      ...issue(id, "done", index === 0 ? [] : [{ id: index === 1 ? "a" : "b", status: "done" }]),
      ...(id === "c" ? { executionBlocker: { runId: "failed-jules-run", cause: "legacy_execution_requires_reconciliation" } } : {}),
      workProducts: [{ type: "pull_request", status: "merged", url: `https://github.com/example/canary/pull/${index + 1}`,
        metadata: { headSha: `${index + 1}`.repeat(40) } }],
    }]));
    const ghResponses = Object.fromEntries((["a", "b", "c"] as const).map((_, index) => [
      `https://github.com/example/canary/pull/${index + 1}`,
      { state: "MERGED", headRefOid: `${index + 1}`.repeat(40), mergeCommit: { oid: `${index + 4}`.repeat(40) } },
    ]));
    const result = await verify(snapshots, ["--require-complete"], ghResponses);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("c_done_with_actionable_execution_blocker");
  });

  it("reports a bounded failure rather than accepting a still-running chain", async () => {
    const result = await verify({ a: issue("a", "in_progress"), b: issue("b", "todo", [{ id: "a", status: "in_progress" }]),
      c: issue("c", "backlog", [{ id: "b", status: "todo" }]) },
    ["--wait-for-completion", "--timeout-ms=200", "--interval-ms=25"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/timeout|not complete/i);
    // A loaded CI worker can consume the 200ms budget before a second poll;
    // the separate convergence test requires polling beyond this first GET trio.
    expect(result.requests.length).toBeGreaterThanOrEqual(3);
    expect(result.requests.every((request) => request.startsWith("GET "))).toBe(true);
  });

  it("waits for terminal convergence and GitHub ancestry before reporting passed", async () => {
    const final = Object.fromEntries((["a", "b", "c"] as const).map((id, index) => [id, {
      ...issue(id, "done", index === 0 ? [] : [{ id: index === 1 ? "a" : "b", status: "done" }]),
      workProducts: [{ type: "pull_request", status: "merged", url: `https://github.com/example/canary/pull/${index + 1}`,
        metadata: { headSha: `${index + 1}`.repeat(40) } }],
    }]));
    const initial = { a: issue("a", "in_progress"), b: issue("b", "todo", [{ id: "a", status: "in_progress" }]),
      c: issue("c", "backlog", [{ id: "b", status: "todo" }]) };
    const ghResponses = Object.fromEntries((["a", "b", "c"] as const).map((_, index) => [
      `https://github.com/example/canary/pull/${index + 1}`,
      { state: "MERGED", headRefOid: `${index + 1}`.repeat(40), mergeCommit: { oid: `${index + 4}`.repeat(40) } },
    ]));
    const result = await verify((id, requestNumber) => (requestNumber <= 3 ? initial : final)[id],
      ["--wait-for-completion", "--timeout-ms=1500", "--interval-ms=25"], ghResponses);
    expect(result.code).toBe(0, result.stderr);
    expect(result.requests.length).toBeGreaterThan(3);
    expect(result.stdout).toContain('"result":"passed"');
  });
});
