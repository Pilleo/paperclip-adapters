/** Real daemon/PostgreSQL: a user response overlaps a live worker and continues exactly once. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDisposableHost } from "./disposable-host.mjs";
import { resolveContractHost } from "./host-installation.mjs";

const installation = resolveContractHost();
const kind = process.argv.find((arg) => arg.startsWith("--kind="))?.slice(7) ?? "confirmation";
assert.ok(["confirmation", "question"].includes(kind));
const root = await mkdtemp(path.join(tmpdir(), "paperclip-queued-response-"));
const receiptFile = path.join(root, "worker-receipts.jsonl");
const report = { version: installation.version, scenario: `queued_${kind}_while_running`, safe: false };
let host, heldResponse, heldRunId;
const until = async (label, probe, timeout = 30_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await probe(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error(`Timed out waiting for ${label}`);
};
const api = async (route, method = "GET", body) => {
  const response = await fetch(`${host.url}/api${route}`, { method, signal: AbortSignal.timeout(12_000),
    headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${method} ${route} returned ${response.status}`);
  return response.json();
};
const barrier = createServer(async (request, response) => {
  try {
    const runId = request.headers["x-paperclip-run-id"];
    const nativeResponse = await fetch(`${host.url}/api/heartbeat-runs/${runId}`, {
      headers: { authorization: request.headers.authorization }, signal: AbortSignal.timeout(12_000) });
    assert.equal(nativeResponse.status, 200);
    const run = await nativeResponse.json();
    assert.equal(run.status, "running");
    assert.equal(run.agentId, report.agentId);
    assert.equal(run.contextSnapshot.issueId, report.issueId);
    assert.equal(heldResponse, undefined, "only the original worker may occupy the barrier");
    heldResponse = response; heldRunId = runId;
  } catch { response.writeHead(403); response.end(); }
});
await new Promise((resolve) => barrier.listen(0, "127.0.0.1", resolve));
const probe = createServer(); await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
const worker = path.join(root, "response-worker.mjs");
await writeFile(worker, `import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
const env = process.env;
const headers = { authorization: 'Bearer ' + env.PAPERCLIP_API_KEY, 'x-paperclip-run-id': env.PAPERCLIP_RUN_ID, 'content-type': 'application/json' };
const api = async (route, method = 'GET', body) => {
  const r = await fetch(env.PAPERCLIP_API_URL + '/api' + route, {method,headers,...(body ? {body:JSON.stringify(body)} : {})});
  assert.ok(r.ok, 'Worker API ' + r.status); return r.json();
};
const run = await api('/heartbeat-runs/' + env.PAPERCLIP_RUN_ID);
const context = run.contextSnapshot;
const issueId = context.issueId;
if (context.interactionId) {
  const cards = await api('/issues/' + issueId + '/interactions');
  const card = cards.find(c => c.id === context.interactionId);
  assert.equal(card.status, ${JSON.stringify(kind === "confirmation" ? "accepted" : "answered")});
  assert.equal(card.sourceRunId, context.sourceRunId);
  await appendFile(${JSON.stringify(receiptFile)}, JSON.stringify({phase:'continuation',runId:run.id,cardId:card.id,status:card.status,result:card.result})+'\\n', {mode:0o600});
} else {
  const payload = ${JSON.stringify(kind === "confirmation" ? { version: 1, prompt: "Approve only the original bounded task", acceptLabel: "Continue", rejectLabel: "Reject", rejectRequiresReason: false } : { version: 1, questions: [{ id: "scope", prompt: "Which scope?", selectionMode: "single", required: true, options: [{ id: "original", label: "Original scope" }, { id: "other", label: "Different scope" }] }] })};
  const card = await api('/issues/' + issueId + '/interactions', 'POST', {kind:${JSON.stringify(kind === "confirmation" ? "request_confirmation" : "ask_user_questions")},idempotencyKey:'queued-response:'+issueId,title:'Exact response while running',continuationPolicy:'wake_assignee',payload});
  await appendFile(${JSON.stringify(receiptFile)}, JSON.stringify({phase:'source',runId:run.id,cardId:card.id})+'\\n', {mode:0o600});
  const held = await fetch(${JSON.stringify(`http://127.0.0.1:${barrier.address().port}/hold`)}, {method:'POST',headers});
  assert.ok(held.ok);
}
await api('/issues/' + issueId + '/comments', 'POST', {body:'Completed the bounded native-response test turn.'});
console.log('Native queued-response worker completed');
`, { mode: 0o600 });
host = createDisposableHost({ root, command: installation.command, args: [...installation.args, "onboard",
  "--config", path.join(root, "home/config.json"), "--data-dir", path.join(root, "home"), "--bind", "loopback", "--yes", "--no-install-service"],
  port, environment: { PAPERCLIP_API_URL: `http://127.0.0.1:${port}` }, readinessTimeoutMs: 60_000 });
try {
  await host.start();
  const company = await api("/companies", "POST", { name: "Queued response upgrade contract" }); report.companyId = company.id;
  const agent = await api(`/companies/${company.id}/agents`, "POST", { name: "Original response worker", role: "engineer",
    status: "idle", adapterType: "process", adapterConfig: { command: process.execPath, args: [worker] },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } } }); report.agentId = agent.id;
  const issue = await api(`/companies/${company.id}/issues`, "POST", { title: "Respond while the original worker is active", status: "todo",
    executionPolicy: { mode: "normal", stages: [], commentRequired: false } }); report.issueId = issue.id;
  await api(`/issues/${issue.id}`, "PATCH", { status: "in_progress", assigneeAgentId: agent.id });
  await until("authenticated source worker barrier", () => heldResponse);
  const [card] = await api(`/issues/${issue.id}/interactions`);
  assert.equal(card.sourceRunId, heldRunId);
  report.sourceRunId = heldRunId; report.cardId = card.id;
  const body = kind === "confirmation" ? {} : { answers: [{ questionId: "scope", optionIds: ["original"] }] };
  const settled = await api(`/issues/${issue.id}/interactions/${card.id}/${kind === "confirmation" ? "accept" : "respond"}`, "POST", body);
  assert.equal(settled.status, kind === "confirmation" ? "accepted" : "answered");
  assert.equal((await api(`/heartbeat-runs/${heldRunId}`)).status, "running", "response must not interrupt the original run implicitly");
  const queue = await api(`/issues/${issue.id}/queued-comments`);
  const entry = queue.entries.find((entry) => entry.source?.interactionId === card.id);
  assert.ok(entry, "resolved native response must appear in the immutable run queue");
  assert.equal(entry.canEdit, false); assert.equal(entry.canDiscard, false);
  const queued = JSON.parse(entry.comment.body.slice(entry.comment.body.indexOf("\n\n") + 2));
  assert.deepEqual(queued.payload, settled.payload); assert.deepEqual(queued.result, settled.result);
  const edit = await fetch(`${host.url}/api/issues/${issue.id}/queued-comments/${card.id}`, { method: "PATCH",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ queueId: queue.queueId, revision: queue.revision, body: "Changed decision" }) });
  assert.equal(edit.status, 409, "a recorded response must not be editable as a queued comment");
  heldResponse.end("released"); heldResponse = undefined;
  const receipts = await until("exactly attributed response continuation", async () => {
    const rows = (await readFile(receiptFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    return rows.some((row) => row.phase === "continuation") ? rows : null;
  });
  const continuations = receipts.filter((row) => row.phase === "continuation");
  assert.equal(continuations.length, 1); assert.equal(continuations[0].cardId, card.id);
  assert.deepEqual(continuations[0].result, settled.result);
  const continuation = await until("settled continuation", async () => {
    const run = await api(`/heartbeat-runs/${continuations[0].runId}`); return run.finishedAt ? run : null;
  });
  const source = await api(`/heartbeat-runs/${heldRunId}`);
  assert.equal(source.status, "succeeded"); assert.equal(continuation.status, "succeeded");
  assert.ok(Date.parse(continuation.startedAt) >= Date.parse(source.finishedAt), "response execution must wait for the original run to finish");
  const rows = await api(`/companies/${company.id}/heartbeat-runs?agentId=${agent.id}&limit=50`);
  const runs = await Promise.all(rows.map((run) => api(`/heartbeat-runs/${run.id}`)));
  assert.equal(runs.filter((run) => run.contextSnapshot?.interactionId === card.id).length, 1);
  assert.equal((await api(`/issues/${issue.id}/queued-comments`)).entries.length, 0);
  report.safe = true; report.continuationRunId = continuation.id; report.immutableResponse = true; report.overlapProven = true;
  console.log("QUEUED_RESPONSE_CONTRACT", JSON.stringify(report));
} finally {
  heldResponse?.end("teardown");
  try {
    await writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
    if (process.env.CONTRACT_REPORT_DIR) {
      await mkdir(process.env.CONTRACT_REPORT_DIR, { recursive: true });
      await writeFile(path.join(process.env.CONTRACT_REPORT_DIR, `${report.scenario}.json`), JSON.stringify(report, null, 2), { mode: 0o600, flag: "wx" });
    }
    console.log(`Queued response evidence: ${root}`);
  } finally {
    await host.stop(); barrier.closeAllConnections(); await new Promise((resolve) => barrier.close(resolve));
  }
}
