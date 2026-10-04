import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { createNativeAcpFixture } from "../../packages/orchestrator/test/contract/native-acp-fixture.mjs";

for (const { controlled, permissionsAllowed } of [
  { controlled: false, permissionsAllowed: true }, { controlled: true, permissionsAllowed: true },
  { controlled: false, permissionsAllowed: false },
]) test(`ACP provider native verdict (controlled=${controlled}, permissions=${permissionsAllowed})`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "native-acp-fixture-test-"));
  const calls = [];
  const phases = [];
  const dispositions = [];
  const permissions = [];
  let submitted;
  const assignment = { kind: "pull_request", interactionId: "native-card", prUrl: "https://github.com/fixture/repo/pull/1", headSha: "a".repeat(40) };
  const policy = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    phases.push(message.phase);
    assert.deepEqual(message.assignment, assignment);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ verdict: "reject", reason: "Real Git conflict" }));
  });
  await new Promise((resolve) => policy.listen(0, "127.0.0.1", resolve));
  const server = createServer(async (request, response) => {
    if (request.url.startsWith("/api/")) {
      assert.equal(request.headers.authorization, "Bearer runtime-token");
      assert.equal(request.headers["x-paperclip-run-id"], "review-run");
      let result;
      if (request.url === "/api/heartbeat-runs/review-run") result = { agentId: "reviewer", contextSnapshot: { issueId: "review-child" } };
      else if (request.url === "/api/issues/review-child/interactions") result = [{ id: "native-card", status: "answered", addresseeAgentId: "reviewer", resolvedByRunId: "review-run" }];
      else {
        assert.equal(request.url, "/api/issues/review-child");
        assert.equal(request.method, "PATCH");
        let body = "";
        for await (const chunk of request) body += chunk;
        const patch = JSON.parse(body);
        assert.deepEqual(patch, { status: "done" });
        dispositions.push(patch);
        result = { id: "review-child", status: "done" };
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
      return;
    }
    assert.equal(request.headers.authorization, "Bearer fixture-bridge-token");
    let body = "";
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    calls.push(message.method === "tools/call" ? message.params.name : message.method);
    if (message.params?.name === "submit_native_review_verdict") submitted = message.params.arguments;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "native receipt" }],
      ...(message.params?.name === "get_current_native_review_assignment" ? { structuredContent: assignment } : {}) } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let child;
  try {
    const fixture = await createNativeAcpFixture(root, controlled ? { reviewDecisionUrl: `http://127.0.0.1:${policy.address().port}`, finishPrReview: true } : {});
    child = spawn(process.execPath, [fixture.serverPath, "--uid="], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env,
      PAPERCLIP_API_URL: `http://127.0.0.1:${server.address().port}`, PAPERCLIP_API_KEY: "runtime-token",
      PAPERCLIP_RUN_ID: "review-run", PAPERCLIP_AGENT_ID: "reviewer" } });
    const lines = readline.createInterface({ input: child.stdout });
    const responses = new Map();
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "session/request_permission") {
        assert.equal(message.params.toolCall.kind, "other");
        permissions.push(message.params.toolCall.title);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: message.id,
          result: { outcome: { outcome: "selected", optionId: permissionsAllowed ? "allow-once" : "reject-once" } } }) + "\n");
      } else if (message.id) responses.get(message.id)?.(message);
    });
    const request = (id, method, params = {}) => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`ACP ${method} timed out`)), 5000);
      responses.set(id, (message) => { clearTimeout(timeout); resolve(message); });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    assert.equal((await request(1, "initialize")).result.protocolVersion, 1);
    const session = await request(2, "session/new", { mcpServers: [{ type: "http", name: "paperclip_review",
      url: `http://127.0.0.1:${server.address().port}/mcp`, headers: [{ name: "Authorization", value: "Bearer fixture-bridge-token" }] }] });
    assert.equal(calls.length, 0, "opening an ACP session cannot resolve a card before a model turn");
    const configured = await request(5, "session/set_config_option", { sessionId: session.result.sessionId,
      configId: "model", value: "gemini-3.8-flash-low" });
    assert.equal(configured.result?.configOptions?.[0]?.currentValue, "gemini-3.8-flash-low");
    const prompt = await request(3, "session/prompt", { sessionId: session.result.sessionId });
    if (permissionsAllowed) assert.equal(prompt.result.stopReason, "end_turn");
    else assert.match(prompt.error.message, /Native ACP permission denied/);
    assert.deepEqual(calls, permissionsAllowed ? ["initialize", "get_current_native_review_assignment", "submit_native_review_verdict"] : ["initialize"]);
    assert.deepEqual(permissions, permissionsAllowed ? ["paperclip_review_get_current_native_review_assignment",
      "paperclip_review_submit_native_review_verdict"] : ["paperclip_review_get_current_native_review_assignment"]);
    assert.deepEqual(submitted, !permissionsAllowed ? undefined : controlled ? { verdict: "reject", reason: "Real Git conflict" } : { verdict: "approve" });
    assert.deepEqual(phases, controlled ? ["before", "after"] : []);
    assert.deepEqual(dispositions, controlled ? [{ status: "done" }] : []);
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
    policy.closeAllConnections();
    await new Promise((resolve) => policy.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
