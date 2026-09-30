import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createAutonomousObserver } from "../../packages/orchestrator/test/contract/autonomous-observer.mjs";

async function withHost(run, failStart = false) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(failStart && request.method === "POST" ? 503 : 200,
      { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "source-issue", status: "in_progress" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(createAutonomousObserver(`http://127.0.0.1:${server.address().port}`), requests);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("starting the source closes setup before dispatch and blocks rescue mutations", async () => {
  await withHost(async (observer, requests) => {
    await observer.setup("/companies", { name: "Isolated autonomous contract" });
    await observer.startIssue("/companies/company-1/issues", { title: "Source", status: "in_progress" });
    await assert.rejects(observer.setup("/agents/jules/wakeup", {}), /read-only/);
    await assert.rejects(observer.startIssue("/companies/company-1/issues", {}), /read-only/);
    assert.equal((await observer.get("/issues/source-issue")).status, "in_progress");
    assert.deepEqual(requests, ["POST /api/companies", "POST /api/companies/company-1/issues",
      "GET /api/issues/source-issue"]);
    assert.equal(observer.trace.filter((entry) => entry.phase === "observing" && entry.method !== "GET").length, 0);
  });
});

test("a failed start cannot reopen setup for a hidden retry or wake", async () => {
  await withHost(async (observer, requests) => {
    await assert.rejects(observer.startIssue("/companies/company-1/issues", {}), /503/);
    await assert.rejects(observer.setup("/agents/jules/wakeup", {}), /read-only/);
    assert.deepEqual(requests, ["POST /api/companies/company-1/issues"]);
  }, true);
});

test("start boundary cannot be used to dispatch an agent wake", async () => {
  await withHost(async (observer, requests) => {
    await assert.rejects(observer.startIssue("/agents/jules/wakeup", {}), /source issue/);
    assert.deepEqual(requests, []);
  });
});
