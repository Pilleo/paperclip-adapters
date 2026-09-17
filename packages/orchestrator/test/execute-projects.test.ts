import { afterEach, describe, expect, it, vi } from "vitest";
import { executeAllProjects } from "../src/server/execute.js";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";

describe("executeAllProjects", () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env["PAPERCLIP_API_KEY"];
  const schedulerRun = (id: string) => ({
    id,
    agentId: "orchestrator",
    contextSnapshot: { source: "scheduler", reason: "interval_elapsed" },
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env["PAPERCLIP_API_KEY"];
    else process.env["PAPERCLIP_API_KEY"] = originalToken;
  });

  it("uses the authoritative run snapshot when the invocation omits a project scope", async () => {
    process.env["PAPERCLIP_API_KEY"] = "test-token";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/heartbeat-runs/run-scoped")) {
        return new Response(JSON.stringify({
          id: "run-scoped",
          agentId: "orchestrator",
          contextSnapshot: {
            wakeSource: "on_demand",
            wakeReason: "paperclip-orchestrator-scope/v1/project/project-b",
          },
        }), { status: 200 });
      }
      if (url.includes("/api/companies/company-1/projects")) {
        return new Response(JSON.stringify([
          { id: "project-a", primaryWorkspace: { cwd: process.cwd() } },
          { id: "project-b", primaryWorkspace: { cwd: "/tmp" } },
        ]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const runProject = vi.fn(async (): Promise<AdapterExecutionResult> => ({
      exitCode: 0, signal: null, timedOut: false, summary: "ok",
    }));

    const onLog = vi.fn().mockResolvedValue(undefined);
    const result = await executeAllProjects({
      runId: "run-scoped",
      agent: { id: "orchestrator", companyId: "company-1", name: "Orchestrator", adapterConfig: {} },
      config: {},
      context: { companyId: "company-1" },
      runtime: { sessionId: null, sessionParams: null },
      onLog,
    } as AdapterExecutionContext, runProject);

    expect(result.exitCode).toBe(0);
    expect(runProject).toHaveBeenCalledOnce();
    expect((runProject.mock.calls[0]?.[0].context as Record<string, unknown>)["projectId"]).toBe("project-b");
    expect(onLog).toHaveBeenCalledWith(
      "stdout",
      expect.stringContaining('"wakeSource":"on_demand"'),
    );
  });

  it.each([
    {
      name: "cannot load the authoritative run",
      run: new Response("unavailable", { status: 503 }),
    },
    {
      name: "receives an unscoped on-demand run",
      run: new Response(JSON.stringify({
        id: "run-invalid",
        agentId: "orchestrator",
        contextSnapshot: { wakeSource: "on_demand", wakeReason: "manual" },
      }), { status: 200 }),
    },
    {
      name: "receives conflicting invocation and run scopes",
      run: new Response(JSON.stringify({
        id: "run-invalid",
        agentId: "orchestrator",
        contextSnapshot: { projectId: "project-b" },
      }), { status: 200 }),
      invocationContext: { companyId: "company-1", projectId: "project-a" },
    },
  ])("does not enumerate projects when it $name", async ({ run, invocationContext = { companyId: "company-1" } }) => {
    process.env["PAPERCLIP_API_KEY"] = "test-token";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/heartbeat-runs/run-invalid")) return run.clone();
      if (url.includes("/api/companies/company-1/projects")) return new Response(JSON.stringify([]), { status: 200 });
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const runProject = vi.fn(async (): Promise<AdapterExecutionResult> => ({
      exitCode: 0, signal: null, timedOut: false, summary: "unexpected",
    }));

    const result = await executeAllProjects({
      runId: "run-invalid",
      agent: { id: "orchestrator", companyId: "company-1", name: "Orchestrator", adapterConfig: {} },
      config: {},
      context: invocationContext,
      runtime: { sessionId: null, sessionParams: null },
      onLog: vi.fn().mockResolvedValue(undefined),
    } as AdapterExecutionContext, runProject);

    expect(result.exitCode).toBe(1);
    expect(runProject).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/projects"))).toBe(false);
  });

  it("runs one project-scoped state machine per runnable project with bounded capacity", async () => {
    process.env["PAPERCLIP_API_KEY"] = "test-token";
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/heartbeat-runs/heartbeat-1")) return new Response(JSON.stringify(schedulerRun("heartbeat-1")), { status: 200 });
      return new Response(JSON.stringify([
        { id: "project-a", primaryWorkspace: { cwd: process.cwd() } },
        { id: "project-b", primaryWorkspace: { cwd: "/tmp" } },
        { id: "project-no-checkout" },
      ]), { status: 200 });
    }) as typeof fetch;

    const calls: Array<{ projectId: string; jules: number; vibe: number; reconcileFleet: boolean }> = [];
    const runProject = vi.fn(async (context: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
      const rawConfig = context.config as Record<string, unknown>;
      calls.push({
        projectId: String((context.context as Record<string, unknown>).projectId),
        jules: Number(rawConfig["maxConcurrentJules"]),
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
      { projectId: "project-a", jules: 1, vibe: 0, reconcileFleet: true },
      { projectId: "project-b", jules: 2, vibe: 1, reconcileFleet: false },
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("Processed 2 project(s), skipped 1");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map(([input]) => String(input))).toEqual([
      "http://127.0.0.1:3100/api/heartbeat-runs/heartbeat-1",
      "http://127.0.0.1:3100/api/companies/company-1/projects",
    ]);
  });

  it("preserves an explicit fleet reconciliation opt-out for every project", async () => {
    process.env["PAPERCLIP_API_KEY"] = "test-token";
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/heartbeat-runs/heartbeat-2")) return new Response(JSON.stringify(schedulerRun("heartbeat-2")), { status: 200 });
      return new Response(JSON.stringify([
        { id: "project-a", primaryWorkspace: { cwd: process.cwd() } },
        { id: "project-b", primaryWorkspace: { cwd: "/tmp" } },
      ]), { status: 200 });
    }) as typeof fetch;
    const calls: boolean[] = [];
    const runProject = vi.fn(async (context: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
      calls.push((context.config as Record<string, unknown>)["reconcileFleet"] === true);
      return { exitCode: 0, signal: null, timedOut: false, summary: "ok" };
    });
    await executeAllProjects({
      runId: "heartbeat-2",
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
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/heartbeat-runs/heartbeat-3")) return new Response(JSON.stringify(schedulerRun("heartbeat-3")), { status: 200 });
      return new Response(JSON.stringify([
        { id: "project-a", primaryWorkspace: { cwd: process.cwd() } },
        { id: "project-a", primaryWorkspace: { cwd: process.cwd() } },
      ]), { status: 200 });
    }) as typeof fetch;
    const calls: string[] = [];
    const runProject = vi.fn(async (context: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
      calls.push(String((context.context as Record<string, unknown>)["projectId"]));
      return { exitCode: 0, signal: null, timedOut: false, summary: "ok" };
    });
    const result = await executeAllProjects({
      runId: "heartbeat-3",
      agent: { id: "orchestrator", companyId: "company-1", name: "Orchestrator", adapterConfig: {} },
      config: { reconcileFleet: false },
      context: { companyId: "company-1" },
      runtime: { sessionId: null, sessionParams: null },
      onLog: vi.fn().mockResolvedValue(undefined),
    } as AdapterExecutionContext, runProject);
    expect(calls).toEqual(["project-a"]);
    expect(result.summary).toContain("Processed 1 project(s)");
  });

  it("runs only the requested project instead of expanding an issue-bound heartbeat to the company", async () => {
    process.env["PAPERCLIP_API_KEY"] = "test-token";
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/heartbeat-runs/heartbeat-4")) {
        return new Response(JSON.stringify({
          id: "heartbeat-4",
          agentId: "orchestrator",
          contextSnapshot: { projectId: "project-b" },
        }), { status: 200 });
      }
      return new Response(JSON.stringify([
        { id: "project-a", primaryWorkspace: { cwd: process.cwd() } },
        { id: "project-b", primaryWorkspace: { cwd: "/tmp" } },
      ]), { status: 200 });
    }) as typeof fetch;
    const calls: Array<{ projectId: string; jules: number; vibe: number }> = [];
    const runProject = vi.fn(async (context: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
      const config = context.config as Record<string, unknown>;
      calls.push({
        projectId: String((context.context as Record<string, unknown>)["projectId"]),
        jules: Number(config["maxConcurrentJules"]),
        vibe: Number(config["maxConcurrentVibe"]),
      });
      return { exitCode: 0, signal: null, timedOut: false, summary: "ok" };
    });

    const result = await executeAllProjects({
      runId: "heartbeat-4",
      agent: { id: "orchestrator", companyId: "company-1", name: "Orchestrator", adapterConfig: {} },
      config: { maxConcurrentJules: 3, maxConcurrentVibe: 1 },
      context: { companyId: "company-1", projectId: "project-b" },
      runtime: { sessionId: null, sessionParams: null },
      onLog: vi.fn().mockResolvedValue(undefined),
    } as AdapterExecutionContext, runProject);

    expect(calls).toEqual([{ projectId: "project-b", jules: 3, vibe: 1 }]);
    expect(result.summary).toContain("Processed 1 project(s)");
  });

  it("passes a managed git project to its project runner before its checkout exists", async () => {
    process.env["PAPERCLIP_API_KEY"] = "test-token";
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/heartbeat-runs/heartbeat-5")) return new Response(JSON.stringify(schedulerRun("heartbeat-5")), { status: 200 });
      return new Response(JSON.stringify([
        {
          id: "project-managed-git",
          primaryWorkspace: {
            sourceType: "git_repo",
            repoUrl: "git@github.com:Pilleo/disposable.git",
            defaultRef: "master",
          },
          codebase: {
            effectiveLocalFolder: "/tmp/paperclip-checkout-created-during-run",
          },
        },
      ]), { status: 200 });
    }) as typeof fetch;
    const runProject = vi.fn(async (): Promise<AdapterExecutionResult> => ({
      exitCode: 0, signal: null, timedOut: false, summary: "ok",
    }));

    const result = await executeAllProjects({
      runId: "heartbeat-5",
      agent: { id: "orchestrator", companyId: "company-1", name: "Orchestrator", adapterConfig: {} },
      config: { reconcileFleet: false },
      context: { companyId: "company-1" },
      runtime: { sessionId: null, sessionParams: null },
      onLog: vi.fn().mockResolvedValue(undefined),
    } as AdapterExecutionContext, runProject);

    expect(result.exitCode).toBe(0);
    expect(runProject).toHaveBeenCalledOnce();
  });
});
