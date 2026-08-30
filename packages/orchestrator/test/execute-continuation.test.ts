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

  it("wakes managed Jules with payload.issueId when a live session is due to poll", async () => {
    const wakeupBodies: unknown[] = [];
    const finishedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
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
      if (href.includes("/issues")) {
        return new Response(
          JSON.stringify([
            {
              id: "issue-821",
              identifier: "MAZ-821",
              title: "PROBE: Jules reattach ping",
              status: "in_progress",
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
    expect(wakeupBodies).toEqual([
      {
        source: "on_demand",
        triggerDetail: "ping",
        reason: "Continue live jules session 2024763132299585220",
        forceFreshSession: false,
        payload: { issueId: "issue-821" },
      },
    ]);
    expect(String(result.summary)).toContain("continued 1 live sessions");
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
      if (href.includes("/issues")) {
        return new Response(
          JSON.stringify([
            {
              id: "issue-821",
              title: "ping",
              status: "in_progress",
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
});
