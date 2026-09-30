import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { createNativeAcpFixture } from "../../packages/orchestrator/test/contract/native-acp-fixture.mjs";

test("ACP provider submits through the supplied authenticated native MCP transport", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "native-acp-fixture-test-"));
  const calls = [];
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer fixture-bridge-token");
    let body = "";
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    calls.push(message.method === "tools/call" ? message.params.name : message.method);
    if (message.params?.name === "submit_native_review_verdict") assert.deepEqual(message.params.arguments, { verdict: "approve" });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "native receipt" }] } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let child;
  try {
    const fixture = await createNativeAcpFixture(root);
    child = spawn(process.execPath, [fixture.serverPath, "--uid="], { stdio: ["pipe", "pipe", "pipe"] });
    const lines = readline.createInterface({ input: child.stdout });
    const responses = new Map();
    lines.on("line", (line) => { const message = JSON.parse(line); if (message.id) responses.get(message.id)?.(message); });
    const request = (id, method, params = {}) => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`ACP ${method} timed out`)), 5000);
      responses.set(id, (message) => { clearTimeout(timeout); resolve(message); });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    assert.equal((await request(1, "initialize")).result.protocolVersion, 1);
    const session = await request(2, "session/new", { mcpServers: [{ type: "http", name: "paperclip_review",
      url: `http://127.0.0.1:${server.address().port}/mcp`, headers: [{ name: "Authorization", value: "Bearer fixture-bridge-token" }] }] });
    assert.equal(calls.length, 0, "opening an ACP session cannot resolve a card before a model turn");
    assert.equal((await request(3, "session/prompt", { sessionId: session.result.sessionId })).result.stopReason, "end_turn");
    assert.deepEqual(calls, ["initialize", "get_current_native_review_assignment", "submit_native_review_verdict"]);
    assert.equal((await request(4, "unsupported/method")).error.code, -32601);
    lines.close();
  } finally {
    if (child) {
      const closed = new Promise((resolve) => child.once("close", resolve));
      child.kill();
      await closed;
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
