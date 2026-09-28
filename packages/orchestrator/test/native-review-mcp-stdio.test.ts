import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { nativePlanReviewStageId } from "@pilleo/paperclip-adapter-common";

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

  it("serves one typed tool, returns a plan to Jules, and completes a card through the run-scoped API", async () => {
    const stageId = nativePlanReviewStageId("issue-1", "revision-1", "luna");
    const pendingPlanCard = {
      id: "card-1", kind: "request_item_verdicts", status: "pending", addresseeAgentId: "luna-1",
      idempotencyKey: "jules:plan-review:v2:issue-1:session-1:revision-1:luna", sourceRunId: "jules-run-1",
      payload: {
        items: [{ id: "plan" }], detailsMarkdown: "# Plan\n\nAdd coverage.",
        target: { type: "issue_document", issueId: "issue-1", documentId: "document-1", key: "plan", revisionId: "revision-1", revisionNumber: 1 },
      },
    };
    const answeredPlanCard = {
      ...pendingPlanCard, status: "answered", resolvedByAgentId: "luna-1", resolvedByRunId: "luna-run-1",
      result: { outcome: "resolved", complete: true, items: [{ id: "plan", verdict: "approve" }] },
    };
    const reviewIssue = {
      id: "issue-1", status: "in_review", assigneeAgentId: "luna-1",
      executionPolicy: { stages: [{ id: stageId, type: "review", participants: [{ type: "agent", agentId: "luna-1" }] }] },
      executionState: {
        status: "pending", currentStageId: stageId, currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "luna-1" },
        returnAssignee: { type: "agent", agentId: "jules-1" },
      },
    };
    const received: Array<{ method: string | undefined; authorization: string | undefined; body: unknown }> = [];
    let interactionListCount = 0;
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
        if (request.method === "GET" && request.url === "/api/issues/issue-1/interactions") {
          interactionListCount += 1;
          if (interactionListCount === 4) {
            response.end(JSON.stringify([{
              id: "question-card-1", kind: "ask_user_questions", status: "pending", addresseeAgentId: "luna-1",
            }]));
            return;
          }
          response.end(JSON.stringify([interactionListCount <= 2 ? pendingPlanCard : answeredPlanCard]));
          return;
        }
        if (request.method === "GET" && request.url === "/api/issues/issue-1") {
          response.end(JSON.stringify(reviewIssue));
          return;
        }
        if (request.method === "GET" && request.url === "/api/issues/issue-1/documents/plan") {
          response.end(JSON.stringify({ id: "document-1", latestRevisionId: "revision-1", latestRevisionNumber: 1 }));
          return;
        }
        if (request.method === "GET" && request.url === "/api/heartbeat-runs/jules-run-1") {
          response.end(JSON.stringify({ id: "jules-run-1", agentId: "jules-1", contextSnapshot: { issueId: "issue-1" } }));
          return;
        }
        if (request.method === "GET" && request.url === "/api/heartbeat-runs/luna-run-1") {
          response.end(JSON.stringify({ id: "luna-run-1", agentId: "luna-1", contextSnapshot: { issueId: "issue-1", interactionId: "card-1" } }));
          return;
        }
        if (request.method === "PATCH" && request.url === "/api/issues/issue-1") {
          response.end(JSON.stringify({ id: "issue-1", status: "in_progress", assigneeAgentId: "jules-1" }));
          return;
        }
        response.end(JSON.stringify(request.url?.endsWith("/respond")
          ? { id: "question-card-1", status: "answered" }
          : { id: "card-1", status: "answered", result: { items: [{ id: "plan", verdict: "approve" }] } }));
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
        PAPERCLIP_RUN_ID: "luna-run-1",
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
      params: { name: "get_current_native_review_assignment", arguments: {} },
    })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "submit_native_review_verdict", arguments: { verdict: "approve" } },
    })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 5, method: "tools/call",
      params: { name: "submit_jules_question_decision", arguments: { decision: "answer", response: "Proceed." } },
    })}\n`);

    await waitFor(() => responses.some((response) => response.id === 3) && responses.some((response) => response.id === 4) && responses.some((response) => response.id === 5));
    const toolList = responses.find((response) => response.id === 2)?.result as { tools?: unknown[] } | undefined;
    expect(toolList?.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "submit_native_review_verdict" }),
      expect.objectContaining({ name: "get_current_native_review_assignment" }),
      expect.objectContaining({ name: "submit_jules_question_decision" }),
    ]));
    expect(responses.find((response) => response.id === 3)).toMatchObject({
      result: { isError: false, structuredContent: { kind: "plan", interactionId: "card-1", itemId: "plan" } },
    });
    expect(responses.find((response) => response.id === 4)).toMatchObject({
      result: { isError: false, structuredContent: { verdict: "approve" } },
    });
    expect(responses.find((response) => response.id === 5)).toMatchObject({
      result: { isError: false, structuredContent: { interactionId: "question-card-1", decision: "answer" } },
    });
    expect(received).toEqual([
      { method: "GET", authorization: "Bearer run-token", body: null },
      { method: "GET", authorization: "Bearer run-token", body: null },
      { method: "POST", authorization: "Bearer run-token", body: { verdicts: [{ id: "plan", verdict: "approve" }] } },
      { method: "GET", authorization: "Bearer run-token", body: null },
      { method: "GET", authorization: "Bearer run-token", body: null },
      { method: "GET", authorization: "Bearer run-token", body: null },
      { method: "GET", authorization: "Bearer run-token", body: null },
      { method: "GET", authorization: "Bearer run-token", body: null },
      { method: "PATCH", authorization: "Bearer run-token", body: { executionPolicy: null } },
      { method: "GET", authorization: "Bearer run-token", body: null },
      { method: "POST", authorization: "Bearer run-token", body: {
        answers: [
          { questionId: "resolution", optionIds: ["answer"] },
          { questionId: "response", optionIds: ["response"], otherText: "Proceed." },
        ],
      } },
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

  it("ignores legacy task/run fields in CODEX_HOME and resolves current run state", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "native-review-runtime-"));
    temporaryHomes.push(home);
    const received: string[] = [];
    const api = createServer((request, response) => {
      received.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/companies/company-1/live-runs?limit=100") {
        response.end(JSON.stringify([{ id: "current-run", agentId: "terra-1", status: "running" }]));
        return;
      }
      if (request.url === "/api/heartbeat-runs/current-run") {
        response.end(JSON.stringify({ contextSnapshot: { issueId: "current-issue", interactionId: "current-card" } }));
        return;
      }
      if (request.method === "GET") {
        response.end(JSON.stringify([{
          id: "current-card", kind: "request_item_verdicts", status: "pending", addresseeAgentId: "terra-1",
          payload: { items: [{ id: "review" }] },
        }]));
        return;
      }
      response.end(JSON.stringify({ id: "current-card", status: "answered", result: { items: [{ id: "review", verdict: "approve" }] } }));
    });
    servers.push(api);
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    const address = api.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP address");
    await fs.writeFile(path.join(home, "paperclip-native-review-runtime.json"), JSON.stringify({
      apiBase: `http://127.0.0.1:${address.port}/api`, companyId: "company-1",
      issueId: "stale-issue", agentId: "terra-1", runId: "stale-run",
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
      "GET /api/companies/company-1/live-runs?limit=100",
      "GET /api/heartbeat-runs/current-run",
      "GET /api/issues/current-issue/interactions",
      "POST /api/issues/current-issue/interactions/current-card/verdicts",
    ]);
  });

  it("resolves the issue from the authoritative heartbeat run when Paperclip omits task context", async () => {
    const received: string[] = [];
    const runHeaders: string[] = [];
    const api = createServer((request, response) => {
      received.push(`${request.method} ${request.url}`);
      if (request.url !== "/api/heartbeat-runs/run-1") {
        runHeaders.push(String(request.headers["x-paperclip-run-id"] ?? ""));
      }
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/heartbeat-runs/run-1") {
        response.end(JSON.stringify({ contextSnapshot: { issueId: "issue-1", interactionId: "card-1" } }));
        return;
      }
      if (request.method === "GET") {
        response.end(JSON.stringify([{
          id: "card-1", kind: "request_item_verdicts", status: "pending", addresseeAgentId: "luna-1",
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

    const child = spawn(process.execPath, ["--import", "tsx", serverScript], {
      cwd: path.resolve(testDir, ".."),
      env: {
        ...process.env,
        PAPERCLIP_API_URL: `http://127.0.0.1:${address.port}`,
        PAPERCLIP_AGENT_ID: "luna-1",
        PAPERCLIP_RUN_ID: "run-1",
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
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "submit_native_review_verdict", arguments: { verdict: "approve" } } })}\n`);
    await waitFor(() => responses.some((response) => response.id === 1));

    expect(responses[0]).toMatchObject({ result: { isError: false, structuredContent: { verdict: "approve" } } });
    expect(received).toEqual([
      "GET /api/heartbeat-runs/run-1",
      "GET /api/issues/issue-1/interactions",
      "POST /api/issues/issue-1/interactions/card-1/verdicts",
    ]);
    expect(runHeaders).toEqual(["run-1", "run-1"]);
  });

  it("submits the sole owned card from an anchored reviewer wake whose host context omits interactionId", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "native-review-partial-env-"));
    temporaryHomes.push(home);
    const received: string[] = [];
    const liveRunReadyAt = Date.now() + 100;
    const api = createServer((request, response) => {
      received.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/companies/company-1/live-runs?limit=100") {
        response.end(JSON.stringify(Date.now() < liveRunReadyAt ? [] : [{ id: "run-1", agentId: "luna-1", status: "running" }]));
        return;
      }
      if (request.url === "/api/heartbeat-runs/run-1") {
        // Paperclip v831's comment-backed wake preserves the issue but drops
        // interactionId. The adapter must still resolve only the single card
        // owned by this reviewer, not guess from shared CODEX_HOME state.
        response.end(JSON.stringify({ contextSnapshot: { issueId: "issue-1" } }));
        return;
      }
      if (request.method === "GET") {
        response.end(JSON.stringify([{
          id: "card-1", kind: "request_item_verdicts", status: "pending", addresseeAgentId: "luna-1",
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
    const apiBase = `http://127.0.0.1:${address.port}`;
    await fs.writeFile(path.join(home, "paperclip-native-review-runtime.json"), JSON.stringify({
      apiBase, companyId: "company-1", agentId: "luna-1",
    }));

    const child = spawn(process.execPath, ["--import", "tsx", serverScript], {
      cwd: path.resolve(testDir, ".."),
      env: { ...process.env, CODEX_HOME: home, PAPERCLIP_API_URL: apiBase, PAPERCLIP_AGENT_ID: "luna-1" },
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
    await new Promise((resolve) => setTimeout(resolve, 150));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "submit_native_review_verdict", arguments: { verdict: "approve" } } })}\n`);
    await waitFor(() => responses.some((response) => response.id === 1));

    expect(responses[0]).toMatchObject({ result: { isError: false, structuredContent: { verdict: "approve" } } });
    expect(received).toEqual([
      "GET /api/companies/company-1/live-runs?limit=100",
      "GET /api/heartbeat-runs/run-1",
      "GET /api/issues/issue-1/interactions",
      "POST /api/issues/issue-1/interactions/card-1/verdicts",
    ]);
  });

  it("returns a reviewed Jules plan to Jules before reporting reviewer success", async () => {
    const stageId = nativePlanReviewStageId("plan-issue-1", "plan-rev-1", "luna");
    const pendingCard = {
      id: "card-plan-1", kind: "request_item_verdicts", status: "pending", addresseeAgentId: "luna-1",
      payload: { items: [{ id: "plan" }] },
    };
    const answeredCard = {
      id: "card-plan-1", kind: "request_item_verdicts", status: "answered", addresseeAgentId: "luna-1",
      idempotencyKey: "jules:plan-review:v2:plan-issue-1:session-1:plan-rev-1:luna",
      resolvedByAgentId: "luna-1", resolvedByRunId: "luna-run-1", sourceRunId: "jules-run-1",
      payload: {
        items: [{ id: "plan", label: "Plan" }],
        target: { type: "issue_document", issueId: "plan-issue-1", documentId: "doc-1", key: "plan", revisionId: "plan-rev-1", revisionNumber: 1 },
      },
      result: { outcome: "resolved", complete: true, items: [{ id: "plan", verdict: "approve" }] },
    };
    const reviewIssue = {
      id: "plan-issue-1", status: "in_review", assigneeAgentId: "luna-1",
      executionPolicy: { stages: [{ id: stageId, type: "review", participants: [{ type: "agent", agentId: "luna-1" }] }] },
      executionState: {
        status: "pending", currentStageId: stageId, currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "luna-1" },
        returnAssignee: { type: "agent", agentId: "jules-1" },
      },
    };
    const received: string[] = [];
    const patchBodies: unknown[] = [];
    let interactionsCalls = 0;
    const api = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push(`${request.method} ${request.url}`);
        response.setHeader("content-type", "application/json");
        if (request.method === "GET" && request.url === "/api/issues/plan-issue-1/interactions") {
          interactionsCalls += 1;
          response.end(JSON.stringify([interactionsCalls === 1 ? pendingCard : answeredCard]));
          return;
        }
        if (request.method === "POST" && request.url === "/api/issues/plan-issue-1/interactions/card-plan-1/verdicts") {
          response.end(JSON.stringify({ id: "card-plan-1", status: "answered", result: { items: [{ id: "plan", verdict: "approve" }] } }));
          return;
        }
        if (request.method === "GET" && request.url === "/api/issues/plan-issue-1") {
          response.end(JSON.stringify(reviewIssue));
          return;
        }
        if (request.method === "GET" && request.url === "/api/issues/plan-issue-1/documents/plan") {
          response.end(JSON.stringify({ id: "doc-1", latestRevisionId: "plan-rev-1", latestRevisionNumber: 1 }));
          return;
        }
        if (request.method === "GET" && request.url === "/api/heartbeat-runs/jules-run-1") {
          response.end(JSON.stringify({ id: "jules-run-1", agentId: "jules-1", contextSnapshot: { issueId: "plan-issue-1" } }));
          return;
        }
        if (request.method === "GET" && request.url === "/api/heartbeat-runs/luna-run-1") {
          response.end(JSON.stringify({ id: "luna-run-1", agentId: "luna-1", contextSnapshot: { issueId: "plan-issue-1", interactionId: "card-plan-1" } }));
          return;
        }
        if (request.method === "PATCH" && request.url === "/api/issues/plan-issue-1") {
          patchBodies.push(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null);
          response.end(JSON.stringify({ id: "plan-issue-1", status: "in_progress", assigneeAgentId: "jules-1" }));
          return;
        }
        response.statusCode = 404;
        response.end(JSON.stringify({ error: `Unexpected ${request.method} ${request.url}` }));
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
        PAPERCLIP_TASK_ID: "plan-issue-1",
        PAPERCLIP_AGENT_ID: "luna-1",
        PAPERCLIP_RUN_ID: "luna-run-1",
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
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "submit_native_review_verdict", arguments: { verdict: "approve" } } })}\n`);
    await waitFor(() => responses.some((response) => response.id === 1));

    expect(responses[0]).toMatchObject({
      result: { isError: false, structuredContent: { interactionId: "card-plan-1", itemId: "plan", verdict: "approve" } },
    });
    expect(received).toEqual([
      "GET /api/issues/plan-issue-1/interactions",
      "POST /api/issues/plan-issue-1/interactions/card-plan-1/verdicts",
      "GET /api/issues/plan-issue-1",
      "GET /api/issues/plan-issue-1/interactions",
      "GET /api/issues/plan-issue-1/documents/plan",
      "GET /api/heartbeat-runs/jules-run-1",
      "GET /api/heartbeat-runs/luna-run-1",
      "PATCH /api/issues/plan-issue-1",
    ]);
    expect(patchBodies).toEqual([{ executionPolicy: null }]);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for MCP response");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
