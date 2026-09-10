import { describe, test, expect, afterEach } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(__dirname, "../scripts/e2e-jules-recovery.ts");

describe("Recovery Canary Cleanup sequence", () => {
  let server: ReturnType<typeof createServer> | null = null;

  afterEach(() => {
    if (server) {
      server.close();
      server = null;
    }
  });

  async function startMockServer(handler: (req: any, res: any, state: any) => void) {
    const state: any = {};
    server = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        req._body = body;
        handler(req, res, state);
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Invalid address");
    return `http://127.0.0.1:${address.port}`;
  }

  function handleStandardCanaryFlow(req: any, res: any, state: any) {
    // Provide a baseline mock that lets the canary script progress
    const url = req.url;
    const method = req.method;

    if (method === "GET" && url === "/api/health") return res.end(JSON.stringify({ status: "ok" }));
    if (method === "GET" && url === "/api/adapters") return res.end(JSON.stringify([{ type: "orchestrator" }, { type: "jules" }, { type: "vibe" }]));
    if (method === "POST" && url === "/api/companies") return res.end(JSON.stringify({ id: "comp-1" }));
    if (method === "POST" && url === "/api/companies/comp-1/projects") return res.end(JSON.stringify({ id: "proj-1" }));
    if (method === "POST" && url === "/api/projects/proj-1/workspaces") {
      const body = JSON.parse(req._body || "{}");
      return res.end(JSON.stringify({ id: "workspace-1", cwd: body.cwd || "/test", isPrimary: true }));
    }
    if (method === "GET" && url === "/api/companies/comp-1/projects/proj-1/workspaces/workspace-1") return res.end(JSON.stringify({ id: "workspace-1", cwd: "/test", isPrimary: true }));
    if (method === "POST" && url === "/api/companies/comp-1/agents") {
      state.agentCount = (state.agentCount || 0) + 1;
      return res.end(JSON.stringify({ id: "agent-" + state.agentCount, apiToken: "tok" }));
    }
    if (method === "GET" && url === "/api/companies/comp-1/agents") return res.end(JSON.stringify([{ id: "agent-1" }, { id: "agent-2" }, { id: "agent-3" }, { id: "agent-4" }]));
    if (method === "DELETE" && url.includes("/api/agents/")) return res.end(JSON.stringify({ ok: true }));
    if (method === "POST" && url === "/api/companies/comp-1/issues") {
      state.issueCount = (state.issueCount || 0) + 1;
      return res.end(JSON.stringify({ id: "issue-" + state.issueCount }));
    }
    if (method === "POST" && url === "/api/issues/issue-1/interactions") return res.end(JSON.stringify({ id: "interaction-1" }));
    if (method === "POST" && url.includes("/verdicts")) {
      state.lunaApproved = true;
      return res.end(JSON.stringify({}));
    }
    if (method === "GET" && url.includes("/interactions")) {
      const cards: any[] = [
        { kind: "request_item_verdicts", status: "pending", idempotencyKey: "test:luna", addresseeAgentId: "agent-4", id: "card-1", continuationPolicy: "none" },
        { id: "interaction-1", status: "cancelled" }
      ];
      if (state.lunaApproved) {
        cards.push({ kind: "request_item_verdicts", status: "pending", idempotencyKey: "test:terra", addresseeAgentId: "agent-5", id: "card-2", continuationPolicy: "none" });
      }
      return res.end(JSON.stringify(cards));
    }
    if (method === "GET" && url.includes("/api/issues/") && !url.includes("interactions") && !url.includes("work-products") && !url.includes("comments")) return res.end(JSON.stringify({ id: url.split("/").pop()?.split("?")[0], status: url.includes("issue-1") ? "in_review" : "done", assigneeAgentId: "agent-4" }));
    if (method === "PATCH" && url === "/api/issues/issue-1") return res.end(JSON.stringify({ id: "issue-1" }));
    if (method === "POST" && url.includes("/wakeup")) return res.end(JSON.stringify({ id: "run-1" }));
    if (method === "GET" && url.includes("/api/heartbeat-runs/run-1")) return res.end(JSON.stringify({ status: "succeeded" }));
    if (method === "GET" && url.includes("/issues?parentId=")) return res.end(JSON.stringify([{ id: "child-1" }]));
    if (method === "GET" && url.includes("/work-products")) return res.end(JSON.stringify([]));
    if (method === "GET" && url.includes("/approvals")) return res.end(JSON.stringify([{ type: "task_merge_approval", payload: { issueId: "issue-1" } }]));
    if (method === "GET" && url.includes("/heartbeat-runs")) {
      return res.end(JSON.stringify([
        {
          id: "run-1",
          // Orchestrator
          agentId: "agent-1",
          events: [{ message: "GITHUB ACCESS UNAVAILABLE" }]
        },
        {
          id: "run-2",
          // Note: agent-2 is jules in the test, so we use a different agent ID like agent-100 or simply empty array
          // In the real code we verify that jules (agent-2) didn't execute
          agentId: "agent-100"
        }
      ]));
    }
  }

  test("asserts non-success responses fail the canary on company deletion", async () => {
    const apiUrl = await startMockServer((req, res, state) => {
      if (req.method === "DELETE" && req.url === "/api/companies/comp-1") {
        res.statusCode = 500;
        return res.end(JSON.stringify({ error: "constraint violation" }));
      }
      handleStandardCanaryFlow(req, res, state);
      // Fallback 200 for any unmatched routes
      if (!res.writableEnded) res.end(JSON.stringify({}));
    });

    try {
      const { JULES_API_KEY, ...cleanEnv } = process.env;
      await execFileAsync("tsx", [scriptPath], {
        env: { ...cleanEnv, PAPERCLIP_TEST_API_URL: apiUrl, PAPERCLIP_E2E_GH_FIXTURE: "server" }
      });
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.code).toBe(1);
      expect(error.stderr).toContain("disposable company comp-1 may remain: company deletion returned HTTP 500");
    }
  });

  test("asserts non-success responses fail the canary on agent deletion", async () => {
    const apiUrl = await startMockServer((req, res, state) => {
      if (req.method === "DELETE" && req.url === "/api/agents/agent-1") {
        res.statusCode = 403;
        return res.end(JSON.stringify({ error: "Forbidden" }));
      }
      handleStandardCanaryFlow(req, res, state);
      if (!res.writableEnded) res.end(JSON.stringify({}));
    });

    try {
      const { JULES_API_KEY, ...cleanEnv } = process.env;
      await execFileAsync("tsx", [scriptPath], {
        env: { ...cleanEnv, PAPERCLIP_TEST_API_URL: apiUrl, PAPERCLIP_E2E_GH_FIXTURE: "server" }
      });
      expect.fail("Should have thrown");
    } catch (error: any) {
      expect(error.code).toBe(1);
      expect(error.stderr).toContain("disposable company comp-1 may remain: agent deletion returned HTTP 403 for agent agent-1");
    }
  });

  test("succeeds when agent deletion and company deletion are successful", async () => {
    const apiUrl = await startMockServer((req, res, state) => {
      if (req.method === "DELETE" && req.url === "/api/companies/comp-1") {
        return res.end(JSON.stringify({ ok: true }));
      }
      handleStandardCanaryFlow(req, res, state);
      if (!res.writableEnded) res.end(JSON.stringify({}));
    });

    const { JULES_API_KEY, ...cleanEnv } = process.env;
    const { stdout } = await execFileAsync("tsx", [scriptPath], {
      env: { ...cleanEnv, PAPERCLIP_TEST_API_URL: apiUrl, PAPERCLIP_E2E_GH_FIXTURE: "server" }
    });

    expect(stdout).toContain("Jules recovery canary passed");
  });
});
