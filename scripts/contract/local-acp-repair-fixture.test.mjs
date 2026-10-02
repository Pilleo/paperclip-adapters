import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { createLocalAcpRepairFixture } from "../../packages/orchestrator/test/contract/local-acp-repair-fixture.mjs";

test("local ACP worker publishes the repaired head and delegates its owned task using native run credentials", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "local-acp-repair-test-"));
  const writes = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    let result;
    if (request.url === "/provider/repair") result = { productId: "product", metadata: { headSha: "b".repeat(40) }, publisherAgentId: "jules", prUrl: "https://github.com/fixture/repo/pull/1" };
    else {
      assert.equal(request.headers.authorization, "Bearer worker-token");
      assert.equal(request.headers["x-paperclip-run-id"], "worker-run");
      if (request.url === "/api/heartbeat-runs/worker-run") result = { agentId: "vibe", contextSnapshot: { issueId: "source" } };
      else if (request.method === "GET") result = { id: "source", assigneeAgentId: "vibe" };
      else { writes.push([request.method, request.url, JSON.parse(body)]); result = { id: "source" }; }
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let child;
  try {
    const fixture = await createLocalAcpRepairFixture(root, `${base}/provider/repair`, "fixture-control");
    child = spawn(process.execPath, [fixture.serverPath], { env: { ...process.env, PAPERCLIP_API_URL: base,
      PAPERCLIP_API_KEY: "worker-token", PAPERCLIP_RUN_ID: "worker-run", PAPERCLIP_AGENT_ID: "vibe" }, stdio: ["pipe", "pipe", "pipe"] });
    const lines = readline.createInterface({ input: child.stdout });
    const pending = new Map();
    lines.on("line", (line) => { const message = JSON.parse(line); pending.get(message.id)?.(message); });
    const request = (id, method, params = {}) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`ACP ${method} timed out`)), 5000);
      pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    await request(1, "initialize");
    const session = await request(2, "session/new");
    assert.equal((await request(3, "session/prompt", { sessionId: session.result.sessionId })).result.stopReason, "end_turn");
    assert.equal(writes[0][1], "/api/work-products/product");
    assert.equal(writes[0][2].metadata.headSha, "b".repeat(40));
    assert.equal(writes[1][1], "/api/issues/source/comments");
    assert.deepEqual(writes[2], ["PATCH", "/api/issues/source", { status: "in_progress", assigneeAgentId: "jules" }]);
    lines.close();
  } finally {
    if (child) { const closed = new Promise((resolve) => child.once("close", resolve)); child.kill(); await closed; }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
