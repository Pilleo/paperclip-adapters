import { describe, it, expect, vi, beforeEach } from "vitest";
import { reconcileManagedFleet, MANAGED_FLEET_DEFINITIONS } from "../src/core/fleet-manager.js";

describe("Orchestrator Managed Fleet Manager", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("provisions missing managed workers with supported heartbeat policy and reportsTo orchestrator", async () => {
    const mockAgents: any[] = [
      {
        id: "orch-1",
        name: "Task Orchestrator",
        adapterType: "orchestrator",
      },
    ];
    const createdCalls: any[] = [];

    global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/agents") && (!init || !init.method || init.method === "GET")) {
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
      orchestratorAgentId: "orch-1",
      repository: "Pilleo/mazewall",
      baseBranch: "master",
      julesPlanApprovalPolicy: "trusted_opt_out",
    });

    expect(result.provisionedCount).toBe(6);
    expect(createdCalls).toHaveLength(6);
    for (const call of createdCalls) {
      expect(call.adapterConfig.pollCadenceSeconds).toBe(call.adapterType === "jules" ? 300 : 0);
      if (call.adapterType === "jules") {
        expect(call.adapterConfig.planApprovalPolicy).toBe("trusted_opt_out");
        expect(call.runtimeConfig.heartbeat).toEqual({
          enabled: true,
          intervalSec: 300,
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        });
      } else if (["[Orchestrated] Luna Fast Reviewer", "[Orchestrated] Terra Strong Reviewer", "[Orchestrated] Terra Jules Question Adjudicator"].includes(call.name)) {
        expect(call.runtimeConfig.heartbeat).toEqual({
          enabled: false,
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
          skipTimerWhenNoActionableWork: true,
        });
      }
      expect(call.status).toBe("idle");
      expect(call.reportsTo).toBe("orch-1");
      expect(call.metadata.managedBy).toBe("paperclip-orchestrator");
    }
    expect(result.julesAgentId).toBeDefined();
    expect(result.vibeAgentId).toBeDefined();
    expect(result.lunaReviewerAgentId).toBeDefined();
    expect(result.terraReviewerAgentId).toBeDefined();
    expect(result.terraAdjudicatorAgentId).toBeDefined();
    const luna = createdCalls.find((call) => call.name === "[Orchestrated] Luna Fast Reviewer");
    expect(luna?.adapterType).toBe("codex_local");
    expect(luna?.adapterConfig.model).toBe("gpt-5.6-luna");
    expect(luna?.adapterConfig.permissionMode).toBe("read-only");
    expect(luna?.adapterConfig.dangerouslyBypassApprovalsAndSandbox).toBe(false);
    expect(createdCalls.find((call) => call.name === "[Orchestrated] Terra Strong Reviewer")?.adapterConfig.model).toBe("gpt-5.6-terra");
    const jules = createdCalls.find((call) => call.name === "[Orchestrated] Jules Async Worker");
    expect(jules?.adapterConfig.planReviewerAgentId).toBe(result.lunaReviewerAgentId);
    expect(jules?.adapterConfig.planStrongReviewerAgentId).toBe(result.terraReviewerAgentId);
    expect(jules?.adapterConfig.questionReviewerAgentId).toBe(result.terraReviewerAgentId);
  });

  it("patches existing Jules to enable timer heartbeats and reportsTo", async () => {
    const mockAgents = [
      {
        id: "orch-1",
        name: "Task Orchestrator",
        adapterType: "orchestrator",
      },
      {
        id: "existing-jules",
        name: "[Orchestrated] Jules Async Worker",
        adapterType: "jules",
        status: "running", // Misconfigured
        reportsTo: null, // Misconfigured
        adapterConfig: { pollCadenceSeconds: 0 }, // Misconfigured
        runtimeConfig: { heartbeat: { enabled: false } }, // Misconfigured
      },
    ];

    const patchCalls: any[] = [];

    global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/agents") && (!init || !init.method || init.method === "GET")) {
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

    const result = await reconcileManagedFleet("http://127.0.0.1:3100", "company-1", {
      orchestratorAgentId: "orch-1",
    });
    expect(result.julesAgentId).toBe("existing-jules");
    expect(patchCalls.length).toBeGreaterThanOrEqual(1);
    expect(patchCalls[0]?.body.status).toBeUndefined();
    expect(patchCalls[0]?.body.reportsTo).toBe("orch-1");
    expect(patchCalls[0]?.body.adapterConfig.pollCadenceSeconds).toBe(300);
    expect(patchCalls[0]?.body.runtimeConfig.heartbeat).toEqual({
      enabled: true,
      intervalSec: 300,
      wakeOnDemand: true,
      maxConcurrentRuns: 1,
    });
  });

  it("does not resolve an independent Luna agent as the managed reviewer", async () => {
    const agents = [
      { id: "orch-1", name: "Task Orchestrator", adapterType: "orchestrator" },
      { id: "independent-luna", name: "Implementation software developer (OpenAI Luna)", adapterType: "codex_local", adapterConfig: { model: "gpt-5.6-luna", dangerouslyBypassApprovalsAndSandbox: true } },
    ];
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => agents });
    const result = await reconcileManagedFleet("http://127.0.0.1:3100", "company-1", { orchestratorAgentId: "orch-1" });
    expect(result.lunaReviewerAgentId).not.toBe("independent-luna");
  });

  it("reports a create authorization denial without touching a personal Luna", async () => {
    const agents: any[] = [
      { id: "orch-1", name: "Task Orchestrator", adapterType: "orchestrator" },
      { id: "independent-luna", name: "Implementation software developer (OpenAI Luna)", adapterType: "codex_local", adapterConfig: { model: "gpt-5.6-luna", dangerouslyBypassApprovalsAndSandbox: true }, metadata: {} },
    ];
    const calls: any[] = [];
    global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (!init || !init.method || init.method === "GET") return { ok: true, json: async () => agents };
      if (init.method === "POST") return { ok: false, status: 403, text: async () => "create denied" };
      return { ok: true, json: async () => ({}) };
    });
    const result = await reconcileManagedFleet("http://127.0.0.1:3100", "company-1", { orchestratorAgentId: "orch-1", authToken: "token" });
    expect(result.lunaReviewerAgentId).toBeUndefined();
    expect(result.authorizationFailures).toContainEqual(expect.objectContaining({ capability: "agents:create", status: 403 }));
    expect(calls.some((call) => call.url.endsWith("/agents/independent-luna"))).toBe(false);
  });

  it("still provisions reviewers when an unrelated managed worker cannot be configured", async () => {
    const agents: any[] = [
      { id: "orch-1", name: "Task Orchestrator", adapterType: "orchestrator" },
      {
        id: "existing-jules",
        name: "[Orchestrated] Jules Async Worker",
        adapterType: "jules",
        title: "old title",
        capabilities: "old capabilities",
        reportsTo: null,
        adapterConfig: { pollCadenceSeconds: 0 },
        runtimeConfig: { heartbeat: { enabled: false } },
        metadata: { managedBy: "paperclip-orchestrator", workerKey: "jules" },
      },
      {
        id: "independent-luna",
        name: "Implementation software developer (OpenAI Luna)",
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-5.6-luna", dangerouslyBypassApprovalsAndSandbox: true },
      },
    ];
    const createdNames: string[] = [];
    global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (!init || !init.method || init.method === "GET") {
        return { ok: true, json: async () => agents };
      }
      if (init.method === "PATCH" && url.endsWith("/agents/existing-jules")) {
        return { ok: false, status: 403, text: async () => "configure denied" };
      }
      if (init.method === "POST") {
        const body = JSON.parse(init.body as string);
        createdNames.push(body.name);
        const created = { id: `created-${createdNames.length}`, ...body };
        agents.push(created);
        return { ok: true, json: async () => created };
      }
      return { ok: true, json: async () => ({}) };
    });

    const result = await reconcileManagedFleet("http://127.0.0.1:3100", "company-1", {
      orchestratorAgentId: "orch-1",
      authToken: "token",
    });

    expect(createdNames).toContain("[Orchestrated] Luna Fast Reviewer");
    expect(result.lunaReviewerAgentId).toBeDefined();
  });

  it("does not retry a worker whose capability circuit is already open", async () => {
    const agents: any[] = [
      { id: "orch-1", name: "Task Orchestrator", adapterType: "orchestrator" },
      {
        id: "luna-1",
        name: "[Orchestrated] Luna Fast Reviewer",
        adapterType: "codex_local",
        title: "stale",
        capabilities: "stale",
        adapterConfig: { model: "old" },
        metadata: { managedBy: "paperclip-orchestrator", workerKey: "luna_reviewer" },
      },
    ];
    const patchUrls: string[] = [];
    global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (!init || !init.method || init.method === "GET") return { ok: true, json: async () => agents };
      if (init.method === "PATCH") {
        patchUrls.push(url);
        return { ok: true, json: async () => ({}) };
      }
      if (init.method === "POST") return { ok: true, json: async () => ({ id: "created" }) };
      return { ok: true, json: async () => ({}) };
    });

    const result = await reconcileManagedFleet("http://127.0.0.1:3100", "company-1", {
      orchestratorAgentId: "orch-1",
      skipWorkerKeys: ["luna_reviewer"],
    });

    expect(result.lunaReviewerAgentId).toBe("luna-1");
    expect(patchUrls).not.toContain("http://127.0.0.1:3100/api/agents/luna-1");
  });
});
