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
    // Vibe supports `thinking`, but ACPX 2026.722 maps thinkingEffort to the
    // unsupported generic `effort` option. It must not be passed through.
    expect(captured.config?.["thinkingEffort"]).toBeUndefined();
    expect(captured.config?.["effort"]).toBeUndefined();
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

  it("gives the read-only review identity the authoritative issue id and review directive", async () => {
    await execute({
      agent: { id: "vibe-review", companyId: "c-1", name: "Vibe Fast Reviewer", adapterType: "vibe" },
      context: { paperclipIssue: { id: "issue-42" }, paperclipTaskMarkdown: "Original implementation task." },
      config: { serverCommand: "vibe-acp", permissionMode: "read-only" },
    } as unknown as AdapterExecutionContext);

    const env = captured.config?.["env"] as Record<string, unknown>;
    expect(env["PAPERCLIP_TASK_ID"]).toBe("issue-42");
    expect(env["PAPERCLIP_REVIEW_MODE"]).toBe("true");
    expect(env["VIBE_BYPASS_TOOL_PERMISSIONS"]).toBeUndefined();
    expect(captured.config?.["agentCommand"]).toBe("vibe-acp");
    const markdown = String(captured.context?.["paperclipTaskMarkdown"]);
    expect(markdown).toContain("Execution role: pull-request reviewer");
    expect(markdown).toContain("review dialog");
    expect(markdown).toContain("Do not post a review disposition in an issue comment");
  });

  it("uses the plan-review contract for delegated Jules review children", async () => {
    await execute({
      agent: { id: "vibe-review", companyId: "c-1", name: "Vibe Fast Reviewer", adapterType: "vibe" },
      context: {
        paperclipIssue: { id: "issue-43" },
        paperclipTaskMarkdown: "<!-- paperclip-delegation kind=jules-plan-review stage=vibe -->\nReview this plan.",
      },
      config: { serverCommand: "vibe-acp", permissionMode: "read-only" },
    } as unknown as AdapterExecutionContext);

    const markdown = String(captured.context?.["paperclipTaskMarkdown"]);
    expect(markdown).toContain("Execution role: Jules plan reviewer");
    expect(markdown).not.toContain("Execution role: pull-request reviewer");
    expect(markdown).not.toContain("PAPERCLIP_REVIEW_DECISION {\"decision\"");
  });
});
