import { afterEach, describe, expect, it, vi } from "vitest";
import { executeAllProjects } from "../src/server/execute.js";
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

    const calls: Array<{ projectId: string; jules: number; vibe: number }> = [];
    const runProject = vi.fn(async (context: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
      const rawConfig = context.config as Record<string, unknown>;
      calls.push({
        projectId: String((context.context as Record<string, unknown>).projectId),
        jules: Number(rawConfig["maxConcurrentJules"]),
        vibe: Number(rawConfig["maxConcurrentVibe"]),
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
      { projectId: "project-a", jules: 1, vibe: 0 },
      { projectId: "project-b", jules: 2, vibe: 1 },
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("Processed 2 project(s), skipped 1");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
