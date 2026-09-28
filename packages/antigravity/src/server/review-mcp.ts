import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AdapterExecutionContext, AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";

const MAX_MESSAGE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

/** One authenticated HTTP-to-stdio MCP transport per reviewer invocation. */
export async function withNativeReviewMcp(ctx: AdapterExecutionContext, command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<{ ctx: AdapterExecutionContext; close: () => Promise<void> }> {
  if (!ctx.authToken || !ctx.runId || !ctx.agent.id || !ctx.agent.companyId) throw new Error("Native review requires run-scoped credentials");
  const token = randomBytes(32).toString("hex");
  const child = spawn(command, [...args], { env, stdio: ["pipe", "pipe", "pipe"] });
  type Pending = { resolve: (line: string) => void; reject: () => void; timer: NodeJS.Timeout };
  const pending = new Map<number, Pending>();
  let nextId = 0;
  let buffer = "";
  let stopped = false;
  const failPending = () => {
    stopped = true;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(); }
    pending.clear();
  };
  child.once("error", failPending);
  child.once("exit", failPending);
  child.stderr.resume(); // A full stderr pipe must never deadlock the review tool.
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_MESSAGE_BYTES) { child.kill(); return; }
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let response: Record<string, unknown>;
      try { response = JSON.parse(line) as Record<string, unknown>; } catch { child.kill(); return; }
      const id = response["id"];
      if (typeof id !== "number") continue;
      const request = pending.get(id);
      if (!request) continue;
      pending.delete(id);
      clearTimeout(request.timer);
      request.resolve(line);
    }
  });

  const server = http.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/mcp") { response.writeHead(404).end(); return; }
    const actual = request.headers.authorization;
    const expected = `Bearer ${token}`;
    if (typeof actual !== "string" || actual.length !== expected.length ||
        !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) { response.writeHead(401).end(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_MESSAGE_BYTES) { response.writeHead(413).end(); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (size > MAX_MESSAGE_BYTES) return;
      let message: Record<string, unknown>;
      try { message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; }
      catch { response.writeHead(400).end(); return; }
      if (!message || message["jsonrpc"] !== "2.0" || typeof message["method"] !== "string" || stopped) {
        response.writeHead(stopped ? 502 : 400).end(); return;
      }
      const id = message["id"];
      if (id === undefined) {
        child.stdin.write(`${JSON.stringify(message)}\n`);
        response.writeHead(202).end();
        return;
      }
      if ((typeof id !== "string" && typeof id !== "number") || pending.size >= 64) { response.writeHead(400).end(); return; }
      const forwardedId = ++nextId;
      message["id"] = forwardedId;
      const timer = setTimeout(() => {
        pending.delete(forwardedId);
        if (!response.writableEnded) response.writeHead(504).end();
      }, REQUEST_TIMEOUT_MS);
      pending.set(forwardedId, {
        timer,
        resolve(line) {
          if (response.writableEnded) return;
          const reply = JSON.parse(line) as Record<string, unknown>;
          reply["id"] = id;
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
        },
        reject() { if (!response.writableEnded) response.writeHead(502).end(); },
      });
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => { if (error) failPending(); });
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) { child.kill(); throw error; }
  const address = server.address();
  if (!address || typeof address === "string") { child.kill(); throw new Error("Review MCP bridge did not bind"); }
  const review: AdapterRuntimeMcpServer = { name: "paperclip_review", url: `http://127.0.0.1:${address.port}/mcp`, token, connectionId: `paperclip-review:${ctx.runId}` };
  const prior = ctx.runtimeMcp?.getServers() ?? [];
  return {
    ctx: { ...ctx, runtimeMcp: { getServers: () => [...prior, review] } },
    close: async () => {
      failPending();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (child.exitCode === null && child.signalCode === null) {
        const settled = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill();
        await settled;
      }
    },
  };
}

export function reviewMcpEnv(ctx: AdapterExecutionContext): NodeJS.ProcessEnv {
  if (!ctx.authToken || !ctx.runId || !ctx.agent.id || !ctx.agent.companyId) throw new Error("Native review requires run-scoped credentials");
  const context = (ctx.context ?? {}) as Record<string, unknown>;
  const issueId = typeof context["issueId"] === "string" ? context["issueId"] : typeof context["taskId"] === "string" ? context["taskId"] : "";
  return {
    ...process.env,
    PAPERCLIP_API_URL: process.env["PAPERCLIP_API_URL"] ?? "http://127.0.0.1:3100",
    PAPERCLIP_COMPANY_ID: ctx.agent.companyId,
    PAPERCLIP_AGENT_ID: ctx.agent.id,
    PAPERCLIP_RUN_ID: ctx.runId,
    PAPERCLIP_API_KEY: ctx.authToken,
    ...(issueId ? { PAPERCLIP_TASK_ID: issueId } : {}),
  };
}
