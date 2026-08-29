import { describe, it, expect, vi, beforeEach } from "vitest";
import { reconcileManagedFleet, MANAGED_FLEET_DEFINITIONS } from "../src/core/fleet-manager.js";

describe("Orchestrator Managed Fleet Manager", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("provisions missing managed workers with pollCadenceSeconds: 0 and idle status", async () => {
    const mockAgents: any[] = [];
    const createdCalls: any[] = [];

    global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/agents") && (!init || init.method === "GET")) {
        return {
          ok: true,
          json: async () => mockAgents,
        };
      }
      if (url.endsWith("/agents") && init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        createdCalls.push(body);
        const newAgent = { id: `agent-${createdCalls.length}`, ...body };
        mockAgents.push(newAgent);
        return {
          ok: true,
          json: async () => newAgent,
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    const result = await reconcileManagedFleet("http://127.0.0.1:3100", "company-1", {
      repository: "Pilleo/mazewall",
      baseBranch: "master",
    });

    expect(result.provisionedCount).toBe(4);
    expect(createdCalls).toHaveLength(4);
    for (const call of createdCalls) {
      expect(call.adapterConfig.pollCadenceSeconds).toBe(0);
      expect(call.status).toBe("idle");
      expect(call.metadata.managedBy).toBe("paperclip-orchestrator");
    }
    expect(result.julesAgentId).toBeDefined();
    expect(result.vibeAgentId).toBeDefined();
    expect(result.reviewerAgentId).toBeDefined();
  });

  it("patches existing misconfigured agents to enforce pollCadenceSeconds: 0", async () => {
    const mockAgents = [
      {
        id: "existing-jules",
        name: "[Orchestrated] Jules Async Worker",
        adapterType: "jules",
        status: "running", // Misconfigured
        adapterConfig: { pollCadenceSeconds: 300 }, // Misconfigured
      },
    ];

    const patchCalls: any[] = [];

    global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/agents") && (!init || init.method === "GET")) {
        return {
          ok: true,
          json: async () => mockAgents,
        };
      }
      if (init?.method === "PATCH") {
        const body = JSON.parse(init.body as string);
        patchCalls.push({ url, body });
        return { ok: true, json: async () => ({}) };
      }
      if (init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        return { ok: true, json: async () => ({ id: `new-${Date.now()}`, ...body }) };
      }
      return { ok: true, json: async () => ({}) };
    });

    const result = await reconcileManagedFleet("http://127.0.0.1:3100", "company-1");
    expect(result.julesAgentId).toBe("existing-jules");
    expect(patchCalls.length).toBeGreaterThanOrEqual(1);
    expect(patchCalls[0]?.body.status).toBe("idle");
    expect(patchCalls[0]?.body.adapterConfig.pollCadenceSeconds).toBe(0);
  });
});
