import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execute } from "../src/server/execute.js";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

function ctx(): AdapterExecutionContext {
  return {
    runId: "run-orch",
    agent: {
      id: "orch-1",
      companyId: "co-1",
      name: "Task Orchestrator",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null },
    config: { workspacePath: process.cwd() },
    context: { companyId: "co-1" },
    onLog: vi.fn().mockResolvedValue(undefined),
  } as AdapterExecutionContext;
}

describe("orchestrator live session continuation", () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env["PAPERCLIP_API_KEY"];

  beforeEach(() => {
    process.env["PAPERCLIP_API_KEY"] = "test-token";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env["PAPERCLIP_API_KEY"];
    else process.env["PAPERCLIP_API_KEY"] = originalKey;
  });

  it("requests an issue-scoped managed Jules continuation when the poll is due", async () => {
    const wakeupBodies: unknown[] = [];
    const finishedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const method = (init?.method || "GET").toUpperCase();
      if (href.includes("/agents") && href.includes("/wakeup") && method === "POST") {
        wakeupBodies.push(JSON.parse(String(init?.body || "{}")));
        return new Response("{}", { status: 202 });
      }
      if (href.includes("/heartbeat-runs")) {
        return new Response(
          JSON.stringify([
            {
              id: "hb-1",
              agentId: "jules-orch",
              status: "succeeded",
              startedAt: finishedAt,
              finishedAt,
              sessionIdBefore: "2024763132299585220",
              sessionIdAfter: "2024763132299585220",
              contextSnapshot: { issueId: "issue-821" },
              resultJson: { julesSessionId: "2024763132299585220", pending: true },
            },
          ]),
          { status: 200 }
        );
      }
      if (href.endsWith("/agents") || href.includes("/agents?")) {
        return new Response(
          JSON.stringify([
            {
              id: "jules-orch",
              name: "[Orchestrated] Jules Async Worker",
              adapterType: "jules",
              status: "idle",
              reportsTo: "orch-1",
              metadata: { managedBy: "paperclip-orchestrator", workerKey: "jules" },
            },
          ]),
          { status: 200 }
        );
      }
      if (href.includes("/projects")) {
        return new Response(JSON.stringify([
          { id: "project-1", name: "paperclip-adapters", primaryWorkspace: { cwd: process.cwd() } },
        ]), { status: 200 });
      }
      if (method === "GET" && href.endsWith("/api/issues/issue-821")) {
        return new Response(JSON.stringify({
          id: "issue-821",
          identifier: "MAZ-821",
          title: "PROBE: Jules reattach ping",
          status: "in_progress",
          projectId: "project-1",
          assigneeAgentId: "jules-orch",
          updatedAt: finishedAt,
        }), { status: 200 });
      }
      if (href.includes("/issues")) {
        return new Response(
          JSON.stringify([
            {
              id: "issue-821",
              identifier: "MAZ-821",
              title: "PROBE: Jules reattach ping",
              status: "in_progress",
              projectId: "project-1",
              assigneeAgentId: "jules-orch",
              updatedAt: finishedAt,
            },
          ]),
          { status: 200 }
        );
      }
      if (href.includes("/approvals")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (method === "POST" || method === "PATCH") {
        return new Response("{}", { status: 200 });
      }
      return new Response("[]", { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await execute(ctx());
    expect(result.exitCode).toBe(0);
    expect(wakeupBodies).toEqual([{
      source: "on_demand",
      triggerDetail: "ping",
      reason: "Poll supervised Jules session 2024763132299585220",
      forceFreshSession: false,
      payload: { issueId: "issue-821", resumeFromRunId: "hb-1" },
    }]);
    // The Jules adapter performed the explicit resume wake first, so the
    // generic continuation pass correctly finds no second session to wake.
    expect(String(result.summary)).toContain("continued 0 live sessions");
  });

  it("does not wake when retryNotBefore is still in the future", async () => {
    const wakeupUrls: string[] = [];
    const finishedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const retryNotBefore = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const method = (init?.method || "GET").toUpperCase();
      if (href.includes("/wakeup")) {
        wakeupUrls.push(href);
        return new Response("{}", { status: 202 });
      }
      if (href.includes("/heartbeat-runs")) {
        return new Response(
          JSON.stringify([
            {
              id: "hb-1",
              agentId: "jules-orch",
              status: "succeeded",
              finishedAt,
              sessionIdAfter: "sess-live",
              contextSnapshot: { issueId: "issue-821" },
              resultJson: { julesSessionId: "sess-live", retryNotBefore },
            },
          ]),
          { status: 200 }
        );
      }
      if (href.includes("/agents")) {
        return new Response(
          JSON.stringify([
            {
              id: "jules-orch",
              name: "[Orchestrated] Jules Async Worker",
              adapterType: "jules",
              status: "idle",
              reportsTo: "orch-1",
              metadata: { managedBy: "paperclip-orchestrator" },
            },
          ]),
          { status: 200 }
        );
      }
      if (href.includes("/projects")) {
        return new Response(JSON.stringify([
          { id: "project-1", name: "paperclip-adapters", primaryWorkspace: { cwd: process.cwd() } },
        ]), { status: 200 });
      }
      if (href.includes("/issues")) {
        return new Response(
          JSON.stringify([
            {
              id: "issue-821",
              title: "ping",
              status: "in_progress",
              projectId: "project-1",
              assigneeAgentId: "jules-orch",
              updatedAt: finishedAt,
            },
          ]),
          { status: 200 }
        );
      }
      if (href.includes("/approvals")) return new Response("[]", { status: 200 });
      return new Response("[]", { status: 200 });
    }) as typeof fetch;

    const result = await execute(ctx());
    expect(result.exitCode).toBe(0);
    expect(wakeupUrls).toEqual([]);
    expect(String(result.summary)).toContain("continued 0 live sessions");
  });

  it("reattaches an expired native Jules monitor without creating a provider session", async () => {
    const patches: Array<Record<string, unknown>> = [];
    const expired = new Date(Date.now() - 60_000).toISOString();
    const issue = {
      id: "issue-836",
      identifier: "MAZ-836",
      title: "native monitor canary",
      status: "blocked",
      projectId: "project-1",
      assigneeAgentId: "jules-orch",
      updatedAt: expired,
      executionPolicy: {
        mode: "normal",
        stages: [],
        monitor: {
          nextCheckAt: expired,
          timeoutAt: expired,
          serviceName: "jules",
          externalRef: "jules-session-836",
        },
      },
    };
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const method = (init?.method || "GET").toUpperCase();
      if (method === "PATCH" && href.includes("/api/issues/issue-836")) {
        const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
        patches.push(body);
        Object.assign(issue, body);
        return new Response("{}", { status: 200 });
      }
      if (href.includes("/heartbeat-runs")) return new Response("[]", { status: 200 });
      if (href.endsWith("/agents") || href.includes("/agents?")) {
        return new Response(JSON.stringify([{
          id: "jules-orch",
          name: "[Orchestrated] Jules Async Worker",
          adapterType: "jules",
          status: "idle",
          reportsTo: "orch-1",
          metadata: { managedBy: "paperclip-orchestrator", workerKey: "jules" },
        }]), { status: 200 });
      }
      if (href.includes("/projects")) return new Response(JSON.stringify([
        { id: "project-1", name: "paperclip-adapters", primaryWorkspace: { cwd: process.cwd() } },
      ]), { status: 200 });
      if (method === "GET" && href.endsWith("/api/issues/issue-836")) return new Response(JSON.stringify(issue), { status: 200 });
      if (href.includes("/issues")) return new Response(JSON.stringify([issue]), { status: 200 });
      if (href.includes("/approvals")) return new Response("[]", { status: 200 });
      return new Response("[]", { status: 200 });
    }) as typeof fetch;

    const result = await execute(ctx());
    expect(result.exitCode).toBe(0);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ status: "in_progress" });
    const monitor = (patches[0]?.executionPolicy as Record<string, unknown>)?.monitor as Record<string, unknown>;
    expect(monitor).toMatchObject({ serviceName: "jules", externalRef: "jules-session-836" });
    expect(Date.parse(String(monitor.nextCheckAt))).toBeGreaterThan(Date.now());
    expect(String(result.summary)).toContain("0 new dev tasks dispatched");

    await execute(ctx());
    expect(patches).toHaveLength(1);
  });
});
