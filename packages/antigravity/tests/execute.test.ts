import { describe, it, expect, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "../src/server/index.js";

const captured: { context?: Record<string, unknown>; config?: Record<string, unknown> } = {};
vi.mock("@paperclipai/adapter-utils/acpx-engine/execute", () => {
  return {
    createAcpxEngineExecutor: () => async (ctx: AdapterExecutionContext) => {
      captured.context = ctx.context as Record<string, unknown>;
      captured.config = ctx.config as Record<string, unknown>;
      return { exitCode: 0, signal: null, timedOut: false, summary: "ok" };
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

  it("injects Codanna/diff guidance into the ACP context", async () => {
    await execute({
      agent: { id: "agy-1", companyId: "c-1", name: "AGY", adapterType: "antigravity" },
      context: { task: { id: "MAZ-1", title: "t" }, paperclipTaskMarkdown: "Fix the leak." },
      config: {},
    } as unknown as AdapterExecutionContext);

    expect(String(captured.context?.["paperclipTaskMarkdown"])).toContain("codanna retrieve describe");
    expect(String(captured.context?.["paperclipTaskMarkdown"])).toContain("Fix the leak.");
  });
});
