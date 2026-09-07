import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.resolve(testDir, "../src/server/native-review-mcp-stdio.ts");

describe("native reviewer stdio MCP process", () => {
  const children: ReturnType<typeof spawn>[] = [];
  const servers: ReturnType<typeof createServer>[] = [];
  const temporaryHomes: string[] = [];

  afterEach(async () => {
    for (const child of children) child.kill();
    await Promise.all(servers.map(async (server) => {
      server.close();
      await once(server, "close");
    }));
    await Promise.all(temporaryHomes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
  });

  it("serves one typed tool and completes a card through the run-scoped API", async () => {
    const received: Array<{ method: string | undefined; authorization: string | undefined; body: unknown }> = [];
    const api = createServer((request, response) => {
      const body: Buffer[] = [];
      request.on("data", (chunk: Buffer) => body.push(chunk));
      request.on("end", () => {
        received.push({
          method: request.method,
          authorization: request.headers.authorization,
          body: body.length ? JSON.parse(Buffer.concat(body).toString("utf8")) : null,
        });
        response.setHeader("content-type", "application/json");
        if (request.method === "GET") {
          response.end(JSON.stringify([{
            id: "card-1", kind: "request_item_verdicts", status: "pending", addresseeAgentId: "luna-1",
            payload: { items: [{ id: "review" }] },
          }]));
          return;
        }
        response.end(JSON.stringify({
          id: "card-1", status: "answered", result: { items: [{ id: "review", verdict: "approve" }] },
        }));
      });
    });
    servers.push(api);
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    const address = api.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP address");

    const child = spawn(process.execPath, ["--import", "tsx", serverScript], {
      cwd: path.resolve(testDir, ".."),
      env: {
        ...process.env,
        PAPERCLIP_API_URL: `http://127.0.0.1:${address.port}/api`,
        PAPERCLIP_API_KEY: "run-token",
        PAPERCLIP_TASK_ID: "issue-1",
        PAPERCLIP_AGENT_ID: "luna-1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    const responses: Array<{ id?: number; result?: unknown }> = [];
    let pending = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) responses.push(JSON.parse(line));
    });

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "submit_native_review_verdict", arguments: { verdict: "approve" } },
    })}\n`);

    await waitFor(() => responses.some((response) => response.id === 3));
    expect(responses.find((response) => response.id === 2)).toMatchObject({
      result: { tools: [{ name: "submit_native_review_verdict" }] },
    });
    expect(responses.find((response) => response.id === 3)).toMatchObject({
      result: { isError: false, structuredContent: { verdict: "approve" } },
    });
    expect(received).toEqual([
      { method: "GET", authorization: "Bearer run-token", body: null },
      { method: "POST", authorization: "Bearer run-token", body: { verdicts: [{ id: "review", verdict: "approve" }] } },
    ]);
  });

  it("exits non-zero after a control-plane failure instead of reporting a successful reviewer run", async () => {
    const api = createServer((_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end('{"error":"temporarily unavailable"}');
    });
    servers.push(api);
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    const address = api.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP address");

    const child = spawn(process.execPath, ["--import", "tsx", serverScript], {
      cwd: path.resolve(testDir, ".."),
      env: {
        ...process.env,
        PAPERCLIP_API_URL: `http://127.0.0.1:${address.port}/api`,
        PAPERCLIP_API_KEY: "run-token",
        PAPERCLIP_TASK_ID: "issue-1",
        PAPERCLIP_AGENT_ID: "luna-1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    const exit = new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "submit_native_review_verdict", arguments: { verdict: "approve" } } })}\n`);

    await expect(exit).resolves.toBe(1);
  });

  it("recovers its non-secret review identity from the dedicated CODEX_HOME when Paperclip strips MCP env", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "native-review-runtime-"));
    temporaryHomes.push(home);
    const received: string[] = [];
    const api = createServer((request, response) => {
      received.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      if (request.method === "GET") {
        response.end(JSON.stringify([{
          id: "card-1", kind: "request_item_verdicts", status: "pending", addresseeAgentId: "terra-1",
          payload: { items: [{ id: "review" }] },
        }]));
        return;
      }
      response.end(JSON.stringify({ id: "card-1", status: "answered", result: { items: [{ id: "review", verdict: "approve" }] } }));
    });
    servers.push(api);
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    const address = api.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP address");
    await fs.writeFile(path.join(home, "paperclip-native-review-runtime.json"), JSON.stringify({
      apiBase: `http://127.0.0.1:${address.port}/api`, issueId: "issue-1", agentId: "terra-1", runId: "run-1",
    }));

    const child = spawn(process.execPath, ["--import", "tsx", serverScript], {
      cwd: path.resolve(testDir, ".."),
      env: { ...process.env, CODEX_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    const responses: Array<{ id?: number; result?: unknown }> = [];
    let pending = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) responses.push(JSON.parse(line));
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "submit_native_review_verdict", arguments: { verdict: "approve" } } })}\n`);
    await waitFor(() => responses.some((response) => response.id === 1));

    expect(responses[0]).toMatchObject({ result: { isError: false, structuredContent: { verdict: "approve" } } });
    expect(received).toEqual([
      "GET /api/issues/issue-1/interactions",
      "POST /api/issues/issue-1/interactions/card-1/verdicts",
    ]);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for MCP response");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
