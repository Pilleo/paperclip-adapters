import { describe, it, expect, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "../src/server/index.js";

const captured: { config?: Record<string, unknown>; context?: Record<string, unknown> } = {};
vi.mock("@paperclipai/adapter-utils/acpx-engine/execute", () => {
  return {
    createAcpxEngineExecutor: () => async (ctx: AdapterExecutionContext) => {
      captured.config = ctx.config as Record<string, unknown>;
      captured.context = ctx.context as Record<string, unknown>;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: `Vibe ACP execution succeeded for ${(ctx.config as any)?.agentCommand}`,
      };
    },
  };
});

describe("Vibe Adapter Execution", () => {
  it("executes vibe-acp via ACP engine executor", async () => {
    const result = await execute({
      agent: { id: "vibe-1", companyId: "c-1", name: "Vibe", adapterType: "vibe-acp" },
      context: { task: { id: "MAZ-189", title: "Conduct task interview" } },
      config: {
        serverCommand: "vibe-acp",
        env: { MISTRAL_API_KEY: "test-key" },
      },
    } as unknown as AdapterExecutionContext);

    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("vibe-acp");
  });

  it("does not bypass tool permissions unless permissionMode is approve-all", async () => {
    await execute({
      agent: { id: "vibe-1", companyId: "c-1", name: "Vibe", adapterType: "vibe-acp" },
      context: { task: { id: "MAZ-1", title: "t" } },
      config: {
        serverCommand: "vibe-acp",
        permissionMode: "prompt-on-write",
        thinking: "off",
        timeoutSec: 12,
      },
    } as unknown as AdapterExecutionContext);

    const env = captured.config?.["env"] as Record<string, unknown>;
    expect(env["VIBE_BYPASS_TOOL_PERMISSIONS"]).toBeUndefined();
    expect(captured.config?.["thinkingEffort"]).toBe("off");
    expect(captured.config?.["timeoutSec"]).toBe(12);
  });

  it("injects the local-agent tool budget into the task context", async () => {
    await execute({
      agent: { id: "vibe-1", companyId: "c-1", name: "Vibe", adapterType: "vibe-acp" },
      context: { task: { id: "MAZ-1", title: "t" }, paperclipTaskMarkdown: "Fix the leak." },
      config: { serverCommand: "vibe-acp" },
    } as unknown as AdapterExecutionContext);

    expect(String(captured.context?.["paperclipTaskMarkdown"])).toContain("codanna retrieve describe");
    expect(String(captured.context?.["paperclipTaskMarkdown"])).toContain("Fix the leak.");
    expect(String(captured.config?.["promptTemplate"] ?? "")).not.toContain("Jules");
  });
});
