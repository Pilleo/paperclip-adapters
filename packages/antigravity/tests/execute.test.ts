import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "../src/server/index.js";

const captured = vi.hoisted(() => ({} as { context?: Record<string, unknown>; config?: Record<string, unknown>;
  runtimeFactory?: (options: Record<string, unknown>) => unknown;
  runtimeOptions?: Record<string, unknown> }));
vi.mock("acpx/runtime", () => ({
  createAcpRuntime: (options: Record<string, unknown>) => {
    captured.runtimeOptions = options;
    return { ensureSession: async () => { throw { code: -32602, data: { errors: [
      { loc: ["mcpServers", 0, "headers", 0, "value"], type: "missing", input: "secret-value" },
    ] } }; } };
  },
}));
vi.mock("@paperclipai/adapter-utils/acpx-engine/execute", () => {
  return {
    createAcpxEngineExecutor: (options?: { createRuntime?: (input: Record<string, unknown>) => unknown }) => {
      captured.runtimeFactory = options?.createRuntime;
      return async (ctx: AdapterExecutionContext) => {
      captured.context = ctx.context as Record<string, unknown>;
      captured.config = ctx.config as Record<string, unknown>;
      (captured as { runtimeMcp?: AdapterExecutionContext["runtimeMcp"] }).runtimeMcp = ctx.runtimeMcp;
      return { exitCode: 0, signal: null, timedOut: false, summary: "ok" };
      };
    },
  };
});

describe("Antigravity local-agent tool budget", () => {
  it("starts the current AGY CLI without unsupported legacy uid or debug flags", async () => {
    await execute({
      agent: { id: "agy-1", companyId: "c-1", name: "AGY", adapterType: "antigravity" },
      context: {},
      config: { serverPath: "/opt/agy", uid: "legacy-user", debug: true },
    } as unknown as AdapterExecutionContext);

    expect(captured.config?.["agentCommand"]).toBe("/opt/agy");
  });

  it("launches the ACP server with its required empty uid flag", async () => {
    await execute({ agent: { id: "agy-1", companyId: "c-1", name: "AGY", adapterType: "antigravity" },
      context: {}, config: { serverPath: "/opt/antigravity/agy_acp_server.par" },
    } as unknown as AdapterExecutionContext);
    expect(captured.config?.["agentCommand"]).toBe("/opt/antigravity/agy_acp_server.par --uid=");
  });

  it("exposes the installed Node CLI directory to AGY MCP subprocesses without dropping the configured PATH", async () => {
    await execute({ agent: { id: "agy-1", companyId: "c-1", name: "AGY", adapterType: "antigravity" },
      context: {}, config: { serverPath: "/opt/antigravity/agy_acp_server.par",
        env: { PATH: "/custom/mcp/bin:/usr/bin", USER_SETTING: "retained" } },
    } as unknown as AdapterExecutionContext);
    const env = captured.config?.["env"] as Record<string, string>;
    expect(env.PATH.split(path.delimiter)).toEqual([path.dirname(process.execPath), "/custom/mcp/bin", "/usr/bin"]);
    expect(env.USER_SETTING).toBe("retained");
  });
  it("refuses an interactive agy CLI for a native typed review", async () => {
    await expect(execute({ agent: { id: "agy-1", companyId: "c-1", name: "AGY", adapterType: "antigravity" },
      context: {}, config: { serverPath: "agy", nativeReview: true },
    } as unknown as AdapterExecutionContext)).rejects.toThrow(/requires an AGY ACP server/);
  });

  it("injects Codanna/diff guidance into the ACP context", async () => {
    await execute({
      agent: { id: "agy-1", companyId: "c-1", name: "AGY", adapterType: "antigravity" },
      context: { task: { id: "MAZ-1", title: "t" }, paperclipTaskMarkdown: "Fix the leak." },
      config: {},
    } as unknown as AdapterExecutionContext);

    expect(String(captured.context?.["paperclipTaskMarkdown"])).toContain("codanna retrieve describe");
    expect(String(captured.context?.["paperclipTaskMarkdown"])).toContain("Fix the leak.");
  });

  it("exposes the typed review tool to a Gemini Flash 3.8 reviewer session", async () => {
    const hostMcp = { name: "Paperclip projects", url: "http://127.0.0.1:3100/api/mcp/project-tools",
      token: "run-only-token", connectionId: "paperclip-project-tools" };
    await execute({
      runId: "run-1",
      authToken: "review-run-token",
      agent: { id: "agy-1", companyId: "c-1", name: "AGY", adapterType: "antigravity" },
      context: { issueId: "issue-1" },
      config: { model: "gemini-3.8-flash-low", serverPath: "/opt/antigravity/agy_acp_server.par", nativeReview: true, permissionMode: "read-only",
        reviewMcpCommand: process.execPath, reviewMcpArgs: ["-e", "process.stdin.resume()"] },
      runtimeMcp: { getServers: () => [hostMcp] },
    } as unknown as AdapterExecutionContext);
    const servers = (captured as { runtimeMcp?: { getServers: () => Array<{ name: string; url: string }> } }).runtimeMcp?.getServers() ?? [];
    expect(servers.map((server) => server.name)).toContain("paperclip_review");
    expect(servers.map((server) => server.name)).toContain("paperclip_projects");
    expect(hostMcp.name).toBe("Paperclip projects");
    expect(servers.find((server) => server.name === "paperclip_review")?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(captured.config?.["permissionMode"]).toBe("approve-reads");
    captured.runtimeFactory?.({ permissionMode: "approve-reads" });
    const permission = captured.runtimeOptions?.["onPermissionRequest"];
    expect(permission).toBeTypeOf("function");
    if (typeof permission !== "function") throw new Error("Native review permission callback missing");
    expect(await permission({ sessionId: "session", raw: { options: [{ kind: "allow_once", optionId: "once", name: "Allow once" }], toolCall: {
      title: "paperclip_review_get_current_native_review_assignment", kind: "other",
    } } }, { signal: new AbortController().signal })).toEqual({ outcome: "allow_once" });
    captured.runtimeFactory?.({ permissionMode: "approve-reads",
      onPermissionRequest: async () => ({ outcome: "reject_once" }) });
    const hostRestrictedPermission = captured.runtimeOptions?.["onPermissionRequest"];
    if (typeof hostRestrictedPermission !== "function") throw new Error("Native review callback missing");
    expect(await hostRestrictedPermission({ sessionId: "session", raw: {
      options: [{ kind: "allow_once", optionId: "once", name: "Allow once" }],
      toolCall: { title: "paperclip_review_get_current_native_review_assignment", kind: "other" },
    } }, { signal: new AbortController().signal })).toEqual({ outcome: "reject_once" });
  });

  it("records only safe validation fields when the ACP server rejects session/new", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const runtime = captured.runtimeFactory?.({}) as { ensureSession: () => Promise<unknown> } | undefined;
      expect(runtime).toBeDefined();
      await expect(runtime!.ensureSession()).rejects.toMatchObject({ code: -32602 });
      expect(warning).toHaveBeenCalledOnce();
      const output = warning.mock.calls[0]?.map(String).join(" ") ?? "";
      expect(output).toContain("mcpServers[0].headers[0].value");
      expect(output).toContain("-32602");
      expect(output).not.toContain("secret-value");
    } finally {
      warning.mockRestore();
    }
  });
});
