import { describe, expect, it, vi } from "vitest";
import { reconcileManagedFleet } from "../src/core/fleet-manager.js";

describe("managed native reviewer instructions", () => {
  it("distinguishes a Jules plan card from a pull-request card", async () => {
    const created: Array<Record<string, unknown>> = [];
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/agents") && (!init?.method || init.method === "GET")) {
        return { ok: true, json: async () => [{ id: "orch-1", name: "Task Orchestrator", adapterType: "orchestrator" }] };
      }
      if (url.endsWith("/agents") && init?.method === "POST") {
        const agent = JSON.parse(String(init.body)) as Record<string, unknown>;
        created.push(agent);
        return { ok: true, json: async () => ({ id: `agent-${created.length}`, ...agent }) };
      }
      return { ok: true, json: async () => ({}) };
    }) as typeof fetch;

    await reconcileManagedFleet("http://127.0.0.1:3100", "company-1", { orchestratorAgentId: "orch-1" });

    const luna = created.find((agent) => agent.name === "[Orchestrated] Luna Fast Reviewer");
    const bundle = luna?.instructionsBundle as { files?: Record<string, string> } | undefined;
    const instructions = bundle?.files?.["AGENTS.md"] ?? "";

    expect(instructions).toContain("issue_document");
    expect(instructions).toContain("Jules plan");
    expect(instructions).toContain("Do not require a PR URL or head SHA for a plan card");
    expect(instructions).toContain("immutable head SHA");
    expect(instructions).toContain("paperclip_review.submit_native_review_verdict");
  });
});
