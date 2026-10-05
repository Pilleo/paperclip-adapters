import { describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { reviewMcpEnv, withNativeReviewMcp } from "../src/server/review-mcp.js";

const ctx = {
  runId: "run-a", authToken: "run-scoped-secret",
  agent: { id: "gemini-reviewer", companyId: "company-a", adapterType: "antigravity", name: "Gemini reviewer" },
  context: { issueId: "review-child" }, runtimeMcp: { getServers: () => [] },
} as unknown as AdapterExecutionContext;

const fixture = `let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { buffer += chunk; const lines = buffer.split("\\n"); buffer = lines.pop();
  for (const line of lines) { const request = JSON.parse(line); if (request.id === undefined) continue;
    process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result:request.method === "initialize"
      ? {protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"paperclip_review",version:"1"}}
      : {tools:[{name:"submit_native_review_verdict"}]}}) + "\\n");
  }
});`;

describe("run-scoped Antigravity review MCP bridge", () => {
  it("requires the run bearer token, supports initialize and accepts notifications", async () => {
    const bridge = await withNativeReviewMcp(ctx, process.execPath, ["-e", fixture], reviewMcpEnv(ctx));
    try {
      const server = bridge.ctx.runtimeMcp?.getServers().find((entry) => entry.name === "paperclip_review");
      expect(server).toBeDefined();
      const url = server!.url;
      const message = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } };
      expect((await fetch(url, { method: "POST", body: JSON.stringify(message) })).status).toBe(401);
      const headers = { Authorization: `Bearer ${server!.token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" };
      const initialized = await fetch(url, { method: "POST", headers, body: JSON.stringify(message), signal: AbortSignal.timeout(3000) });
      expect(initialized.status).toBe(200);
      expect((await initialized.json()).result.serverInfo.name).toBe("paperclip_review");
      const notification = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), signal: AbortSignal.timeout(3000) });
      expect(notification.status).toBe(202);
    } finally { await bridge.close(); }
  });

  it("passes only the current run credentials and refuses an unbound invocation", () => {
    expect(reviewMcpEnv(ctx)).toMatchObject({ PAPERCLIP_AGENT_ID: "gemini-reviewer", PAPERCLIP_RUN_ID: "run-a",
      PAPERCLIP_TASK_ID: "review-child", PAPERCLIP_API_KEY: "run-scoped-secret" });
    expect(() => reviewMcpEnv({ ...ctx, authToken: undefined } as AdapterExecutionContext)).toThrow(/credentials/);
  });
  it("forwards resolved run-scoped GitHub read credentials without allowing native identity overrides", () => {
    const env = reviewMcpEnv({ ...ctx, config: { env: { PAPERCLIP_GH_PATH: "/run/scoped/gh", GH_TOKEN: "github-run-token",
      PAPERCLIP_API_KEY: "foreign-token", PAPERCLIP_AGENT_ID: "foreign-agent" } } } as AdapterExecutionContext);
    expect(env).toMatchObject({ PAPERCLIP_GH_PATH: "/run/scoped/gh", GH_TOKEN: "github-run-token",
      PAPERCLIP_API_KEY: "run-scoped-secret", PAPERCLIP_AGENT_ID: "gemini-reviewer" });
  });
});
