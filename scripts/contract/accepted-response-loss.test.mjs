import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createAcceptedResponseLoss } from "../../packages/orchestrator/test/contract/accepted-response-loss.mjs";

test("remote approval is accepted before its response is lost and observations can be released", async () => {
  const fault = createAcceptedResponseLoss(true);
  let accepted = 0;
  const server = createServer((request, response) => {
    if (request.method === "POST") return fault.respond(response, () => { accepted++; });
    response.writeHead(fault.observationsHeld ? 503 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify({ state: accepted ? "IN_PROGRESS" : "AWAITING_PLAN_APPROVAL" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(fetch(url, { method: "POST" }), /fetch failed/);
    assert.equal(accepted, 1);
    assert.equal(fault.responseLost, true);
    assert.equal((await fetch(url)).status, 503, "remote evidence must remain unavailable until the boundary is inspected");
    fault.releaseObservations();
    assert.deepEqual(await (await fetch(url)).json(), { state: "IN_PROGRESS" });
    assert.equal(accepted, 1, "releasing observation cannot repeat the provider mutation");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("disabled fault acknowledges the accepted mutation normally", async () => {
  const fault = createAcceptedResponseLoss(false);
  let accepted = 0;
  const server = createServer((request, response) => fault.respond(response, () => { accepted++; }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}`, { method: "POST" })).status, 200);
    assert.equal(accepted, 1);
    assert.equal(fault.observationsHeld, false);
    assert.equal(fault.responseLost, false);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
