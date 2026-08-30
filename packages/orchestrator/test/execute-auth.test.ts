import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execute } from "../src/server/execute.js";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

function ctx(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
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
    ...overrides,
  } as AdapterExecutionContext;
}

describe("orchestrator execute fail-closed auth", () => {
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

  it("sends Authorization on agent list and fails closed without a token", async () => {
    delete process.env["PAPERCLIP_API_KEY"];
    delete process.env["PAPERCLIP_AGENT_TOKEN"];
    const result = await execute(ctx());
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage || result.summary).toMatch(/token/i);
  });

  it("does not fall back to independent Jules when listing agents", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/agents")) {
        return new Response(
          JSON.stringify([
            {
              id: "indie-jules",
              name: "Async software developer",
              adapterType: "jules",
              status: "idle",
              reportsTo: "ceo",
            },
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
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (href.includes("/approvals")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await execute(ctx());
    expect(result.exitCode).toBe(0);
    const agentCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/agents"));
    expect(agentCall?.[1]?.headers).toMatchObject({
      Authorization: "Bearer test-token",
    });
    expect(JSON.stringify(result.summary)).not.toContain("indie-jules");
  });
});
