import { afterEach, describe, expect, it, vi } from "vitest";
import { execute, executeAllProjects } from "../src/server/execute.js";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";

describe("executeAllProjects", () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env["PAPERCLIP_API_KEY"];

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env["PAPERCLIP_API_KEY"];
    else process.env["PAPERCLIP_API_KEY"] = originalToken;
  });

  it("runs one project-scoped state machine per runnable project with bounded capacity", async () => {
    process.env["PAPERCLIP_API_KEY"] = "test-token";
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify([
      { id: "project-a", primaryWorkspace: { cwd: process.cwd() } },
      { id: "project-b", primaryWorkspace: { cwd: "/tmp" } },
      { id: "project-no-checkout" },
    ]), { status: 200 })) as typeof fetch;

    const calls: Array<{ projectId: string; julesAdmissions: number; vibe: number; reconcileFleet: boolean }> = [];
    const runProject = vi.fn(async (context: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
      const rawConfig = context.config as Record<string, unknown>;
      calls.push({
        projectId: String((context.context as Record<string, unknown>).projectId),
        julesAdmissions: Number(rawConfig["maxNewJulesSessionsPerHeartbeat"]),
        vibe: Number(rawConfig["maxConcurrentVibe"]),
        reconcileFleet: rawConfig["reconcileFleet"] === true,
      });
      return { exitCode: 0, signal: null, timedOut: false, summary: "ok" };
    });

    const result = await executeAllProjects({
      runId: "heartbeat-1",
      agent: { id: "orchestrator", companyId: "company-1", name: "Orchestrator", adapterConfig: {} },
      config: { maxConcurrentJules: 3, maxConcurrentVibe: 1 },
      context: { companyId: "company-1" },
      runtime: { sessionId: null, sessionParams: null },
      onLog: vi.fn().mockResolvedValue(undefined),
    } as AdapterExecutionContext, runProject);

    expect(calls).toEqual([
      { projectId: "project-a", julesAdmissions: 2, vibe: 0, reconcileFleet: true },
      { projectId: "project-b", julesAdmissions: 1, vibe: 1, reconcileFleet: false },
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("Processed 2 project(s), skipped 1");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("passes a company-wide Jules new-session admission budget to each project", async () => {
    process.env["PAPERCLIP_API_KEY"] = "test-token";
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify([
      { id: "project-a", primaryWorkspace: { cwd: process.cwd() } },
      { id: "project-b", primaryWorkspace: { cwd: "/tmp" } },
    ]), { status: 200 })) as typeof fetch;

    const budgets: Array<{ projectId: string; budget: number }> = [];
    await executeAllProjects({
      runId: "heartbeat-1",
      agent: { id: "orchestrator", companyId: "company-1", name: "Orchestrator", adapterConfig: {} },
      config: { maxNewJulesSessionsPerHeartbeat: 3, maxConcurrentVibe: 1 },
      context: { companyId: "company-1" },
      runtime: { sessionId: null, sessionParams: null },
      onLog: vi.fn().mockResolvedValue(undefined),
    } as AdapterExecutionContext, async (context) => {
      const rawConfig = context.config as Record<string, unknown>;
      budgets.push({
        projectId: String((context.context as Record<string, unknown>).projectId),
        budget: Number(rawConfig["maxNewJulesSessionsPerHeartbeat"]),
      });
      return { exitCode: 0, signal: null, timedOut: false, summary: "ok" };
    });

    expect(budgets).toEqual([
      { projectId: "project-a", budget: 2 },
      { projectId: "project-b", budget: 1 },
    ]);
  });

  it("propagates emergency freeze mode to every project without changing capacity allocation", async () => {
    process.env["PAPERCLIP_API_KEY"] = "test-token";
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify([
      { id: "project-a", primaryWorkspace: { cwd: process.cwd() } },
      { id: "project-b", primaryWorkspace: { cwd: "/tmp" } },
    ]), { status: 200 })) as typeof fetch;

    const modes: string[] = [];
    await executeAllProjects({
      agent: { id: "orchestrator", companyId: "company-1", name: "Orchestrator", adapterConfig: {} },
      config: { reconciliationMode: "freeze" },
      context: { companyId: "company-1" },
      runtime: { sessionId: null, sessionParams: null },
      onLog: vi.fn().mockResolvedValue(undefined),
    } as AdapterExecutionContext, async (context) => {
      modes.push(String((context.config as Record<string, unknown>)["reconciliationMode"]));
      return { exitCode: 0, signal: null, timedOut: false, summary: "ok" };
    });

    expect(modes).toEqual(["freeze", "freeze"]);
  });

  it("does not contact or mutate Paperclip when freeze mode is active", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("freeze mode must not call the control plane");
    }) as typeof fetch;
    const onLog = vi.fn().mockResolvedValue(undefined);

    const result = await execute({
      runId: "freeze-run",
      agent: { id: "orchestrator", companyId: "company-1", name: "Orchestrator", adapterConfig: {} },
      config: { reconciliationMode: "freeze" },
      context: { companyId: "company-1" },
      runtime: { sessionId: null, sessionParams: null },
      onLog,
    } as AdapterExecutionContext);

    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("frozen");
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(onLog).toHaveBeenCalledWith("stdout", expect.stringContaining("frozen"));
  });

  it("preserves an explicit fleet reconciliation opt-out for every project", async () => {
    process.env["PAPERCLIP_API_KEY"] = "test-token";
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify([
      { id: "project-a", primaryWorkspace: { cwd: process.cwd() } },
      { id: "project-b", primaryWorkspace: { cwd: "/tmp" } },
    ]), { status: 200 })) as typeof fetch;
    const calls: boolean[] = [];
    const runProject = vi.fn(async (context: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
      calls.push((context.config as Record<string, unknown>)["reconcileFleet"] === true);
      return { exitCode: 0, signal: null, timedOut: false, summary: "ok" };
    });
    await executeAllProjects({
      agent: { id: "orchestrator", companyId: "company-1", name: "Orchestrator", adapterConfig: {} },
      config: { reconcileFleet: false },
      context: { companyId: "company-1" },
      runtime: { sessionId: null, sessionParams: null },
      onLog: vi.fn().mockResolvedValue(undefined),
    } as AdapterExecutionContext, runProject);
    expect(calls).toEqual([false, false]);
  });

  it("runs a duplicated Paperclip project projection only once", async () => {
    process.env["PAPERCLIP_API_KEY"] = "test-token";
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify([
      { id: "project-a", primaryWorkspace: { cwd: process.cwd() } },
      { id: "project-a", primaryWorkspace: { cwd: process.cwd() } },
    ]), { status: 200 })) as typeof fetch;
    const calls: string[] = [];
    const runProject = vi.fn(async (context: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
      calls.push(String((context.context as Record<string, unknown>)["projectId"]));
      return { exitCode: 0, signal: null, timedOut: false, summary: "ok" };
    });
    const result = await executeAllProjects({
      agent: { id: "orchestrator", companyId: "company-1", name: "Orchestrator", adapterConfig: {} },
      config: { reconcileFleet: false },
      context: { companyId: "company-1" },
      runtime: { sessionId: null, sessionParams: null },
      onLog: vi.fn().mockResolvedValue(undefined),
    } as AdapterExecutionContext, runProject);
    expect(calls).toEqual(["project-a"]);
    expect(result.summary).toContain("Processed 1 project(s)");
  });
});
