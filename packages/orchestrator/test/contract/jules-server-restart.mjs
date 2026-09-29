/** Opt-in real-server Jules session restart probe; owns its host, provider fixture, home and database. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, chmod } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createProbe } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDisposableHost } from "./disposable-host.mjs";
import { createChainGitHubFixture } from "./chain-github-fixture.mjs";

const root = await mkdtemp(path.join(tmpdir(), "paperclip-jules-server-restart-"));
const reviewerScript = path.join(root, "native-plan-reviewer.mjs");
await writeFile(reviewerScript, `const env = process.env;
const base = env.PAPERCLIP_API_URL;
const headers = { Authorization: 'Bearer ' + env.PAPERCLIP_API_KEY,
  'X-Paperclip-Run-Id': env.PAPERCLIP_RUN_ID, 'Content-Type': 'application/json' };
const read = async (route) => {
  const response = await fetch(base + '/api' + route, { headers, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error('Native reviewer GET ' + route + ' (' + response.status + ')');
  return response.json();
};
const run = await read('/heartbeat-runs/' + env.PAPERCLIP_RUN_ID);
const issueId = run.contextSnapshot.issueId;
const cards = await read('/issues/' + issueId + '/interactions');
const pending = cards.filter((card) => card.kind === 'request_item_verdicts' && card.status === 'pending' &&
  card.addresseeAgentId === env.PAPERCLIP_AGENT_ID && card.payload?.target?.type === 'issue_document');
if (pending.length !== 1 || !pending[0].sourceRunId) throw new Error('Expected one addressed and bootstrapped native plan card');
const card = pending[0];
const response = await fetch(base + '/api/issues/' + issueId + '/interactions/' + card.id + '/verdicts', {
  method: 'POST', headers, body: JSON.stringify({ verdicts: [{ id: card.payload.items[0].id, verdict: 'approve' }] }),
  signal: AbortSignal.timeout(12000),
});
if (!response.ok) throw new Error('Native typed verdict rejected (' + response.status + '): ' + await response.text());
`);
await chmod(reviewerScript, 0o700);
const chainGitHub = await createChainGitHubFixture(root);
const pr = await chainGitHub.openPullRequest("A", "A.txt", "alpha");
const sessionId = randomUUID();
let creates = 0;
let approvals = 0;
let approvedAt = null;
let releaseOutput = false;
const provider = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const json = (status, value) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
  if (request.method === "GET" && url.pathname === "/v1alpha/sources") {
    return json(200, { sources: [{ name: "sources/github/paperclip-contract/fixture",
      githubRepo: { owner: "paperclip-contract", repo: "fixture" } }] });
  }
  if (request.method === "GET" && url.pathname === "/v1alpha/sessions") {
    return json(200, { sessions: creates ? [{ name: `sessions/${sessionId}`,
      state: approvals ? releaseOutput ? "COMPLETED" : "IN_PROGRESS" : "AWAITING_PLAN_APPROVAL" }] : [] });
  }
  if (request.method === "POST" && url.pathname === "/v1alpha/sessions") {
    if (creates++) return json(409, { error: "duplicate provider create after restart" });
    return json(200, { name: `sessions/${sessionId}`, state: "AWAITING_PLAN_APPROVAL", outputs: [] });
  }
  if (request.method === "GET" && url.pathname === `/v1alpha/sessions/${sessionId}`) {
    return json(200, { name: `sessions/${sessionId}`,
      state: approvals ? releaseOutput ? "COMPLETED" : "IN_PROGRESS" : "AWAITING_PLAN_APPROVAL",
      outputs: releaseOutput ? [{ pullRequest: { url: pr.url } }] : [] });
  }
  if (request.method === "GET" && url.pathname === `/v1alpha/sessions/${sessionId}/activities`) {
    return json(200, { activities: [{ id: "restart-plan-activity", createTime: "2026-09-29T00:00:00.000Z",
      planGenerated: { plan: { id: "restart-plan", steps: [{ index: 0, title: "Restart contract" }] } } },
      ...(approvedAt ? [{ id: "restart-plan-approved", createTime: approvedAt,
        planApproved: { planId: "restart-plan" } }] : [])] });
  }
  if (request.method === "POST" && url.pathname === `/v1alpha/sessions/${sessionId}:approvePlan`) {
    if (approvals++) return json(409, { error: "duplicate Jules plan approval across server restart" });
    approvedAt = new Date().toISOString();
    return json(200, {});
  }
  json(404, { error: "unsupported provider request" });
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerUrl = `http://127.0.0.1:${provider.address().port}/v1alpha`;
const portProbe = createProbe();
await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
const port = portProbe.address().port;
await new Promise((resolve) => portProbe.close(resolve));
const host = createDisposableHost({ root, command: "paperclipai", args: ["onboard",
  "--config", path.join(root, "home", "config.json"), "--data-dir", path.join(root, "home"),
  "--bind", "loopback", "--yes", "--no-install-service"], port,
environment: { PAPERCLIP_ADAPTER_E2E: "1", PAPERCLIP_API_URL: `http://127.0.0.1:${port}`,
  PAPERCLIP_JULES_SESSION_STORE_DIR: path.join(root, "sessions"),
  PAPERCLIP_GH_PATH: chainGitHub.ghPath, PATH: `${root}:${process.env.PATH}` },
readinessTimeoutMs: 60_000 });
const previousStore = process.env.PAPERCLIP_JULES_SESSION_STORE_DIR;
process.env.PAPERCLIP_JULES_SESSION_STORE_DIR = path.join(root, "sessions");
const workspaceRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const waitUntil = async (label, probe, timeoutMs = 45_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
};
let companyId = null;
let issueId = null;
const reviewerIds = [];
try {
  await host.start();
  const post = async (route, body) => {
    const response = await fetch(`${host.url}/api${route}`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`POST ${route} (${response.status}): ${await response.text()}`);
    return response.json();
  };
  await post("/adapters/install", { packageName: path.join(workspaceRoot, "packages/jules"), isLocalPath: true });
  const company = await post("/companies", { name: "Disposable Jules process restart" });
  companyId = company.id;
  const reviewerConfig = { command: process.execPath, args: [reviewerScript], cwd: root };
  const reviewer = await post(`/companies/${company.id}/agents`, { name: "Paused plan reviewer", role: "qa",
    adapterType: "process", adapterConfig: reviewerConfig, status: "paused",
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } } });
  const strong = await post(`/companies/${company.id}/agents`, { name: "Paused strong plan reviewer", role: "qa",
    adapterType: "process", adapterConfig: reviewerConfig, status: "paused",
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } } });
  reviewerIds.push(reviewer.id, strong.id);
  const jules = await post(`/companies/${company.id}/agents`, { name: "Jules restart contract", role: "general",
    adapterType: "jules", adapterConfig: { apiUrl: host.url, repository: "paperclip-contract/fixture",
      source: "sources/github/paperclip-contract/fixture", baseBranch: "main", planApprovalPolicy: "required",
      planReviewerAgentId: reviewer.id, planStrongReviewerAgentId: strong.id,
      planReviewBootstrapMode: "jules_v4", e2eProviderBaseUrl: providerUrl,
      env: { JULES_API_KEY: "disposable-provider-fixture-token", PATH: `${root}:${process.env.PATH}` } },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } } });
  const issue = await post(`/companies/${company.id}/issues`, { title: "Create one Jules session before server restart",
    description: "---\norchestrator_managed: true\n---\n\nPersist the original Jules provider session across a real control-plane restart.",
    status: "in_progress", assigneeAgentId: jules.id });
  issueId = issue.id;
  const initialSession = await waitUntil("one actual Jules provider session", () => creates === 1 && sessionId);
  assert.equal(initialSession, sessionId);
  await waitUntil("company fleet idle before Paperclip restart", async () => {
    const response = await fetch(`${host.url}/api/companies/${company.id}/live-runs?limit=50&minCount=0`);
    return response.ok && (await response.json()).length === 0;
  });
  assert.equal(creates, 1);
  const { loadStoredSession } = await import("../../../jules/dist/server/session-store.js");
  const persisted = await loadStoredSession(issue.id, "sources/github/paperclip-contract/fixture", "main");
  assert.equal(persisted?.julesSessionId, sessionId,
    "actual Jules executor must checkpoint the original provider session before server restart");
  for (const candidate of [reviewer, strong]) {
    const resumed = await post(`/agents/${candidate.id}/resume`, {});
    assert.equal(resumed.id, candidate.id);
  }
  await post(`/agents/${jules.id}/wakeup`, { source: "automation", triggerDetail: "system",
    reason: "contract_native_plan_capacity_restored", payload: { issueId: issue.id } });
  const monitorWakeKeys = new Set();
  await waitUntil("one confirmed provider plan approval from typed reviewer runs", async () => {
    if (approvals === 1) return true;
    const children = await fetch(`${host.url}/api/companies/${company.id}/issues?parentId=${issue.id}&limit=20`)
      .then((response) => response.json());
    for (const child of children) {
      const cards = await fetch(`${host.url}/api/issues/${child.id}/interactions`)
        .then((response) => response.json());
      const card = cards.find((candidate) => candidate.kind === "request_item_verdicts");
      if (!card || !(card.status === "answered" || (card.status === "pending" && child.status === "backlog"))) continue;
      const key = `${child.id}:${card.id}:${card.status}:${child.status}`;
      if (monitorWakeKeys.has(key)) continue;
      const live = await fetch(`${host.url}/api/companies/${company.id}/live-runs?limit=50&minCount=0`)
        .then((response) => response.json());
      if (live.length) continue;
      monitorWakeKeys.add(key);
      await post(`/agents/${jules.id}/wakeup`, { source: "automation", triggerDetail: "system",
        reason: `contract_native_plan_monitor:${key}`, payload: { issueId: issue.id } });
    }
    return false;
  }, 100_000);
  assert.equal(approvals, 1, "one addressed Luna and strong plan ladder must approve the original provider session before restart");
  await waitUntil("company fleet idle after confirmed plan approval", async () => {
    const response = await fetch(`${host.url}/api/companies/${company.id}/live-runs?limit=50&minCount=0`);
    return response.ok && (await response.json()).length === 0;
  });
  const approvedCheckpoint = await loadStoredSession(issue.id, "sources/github/paperclip-contract/fixture", "main");
  assert.equal(approvedCheckpoint?.julesSessionId, sessionId);
  assert.equal(approvedCheckpoint?.lifecycleEffectJournal?.effects.filter((effect) =>
    effect.kind === "approve_plan" && effect.attempt.kind === "confirmed").length, 1,
  "Jules must durably confirm exactly one provider plan approval before Paperclip restarts");
  const readReviewEvidence = async () => {
    const children = await fetch(`${host.url}/api/companies/${company.id}/issues?parentId=${issue.id}&limit=20`)
      .then((response) => response.json());
    const planChildren = children.filter((child) => child.description?.startsWith("<!-- paperclip-child-plan-review:v4\n"));
    assert.equal(planChildren.length, 2, "exactly two Jules-owned plan-review children must exist");
    const cards = (await Promise.all(planChildren.map((child) => fetch(`${host.url}/api/issues/${child.id}/interactions`)
      .then((response) => response.json())))).flat();
    assert.equal(cards.length, 2);
    assert.ok(cards.every((card) => card.status === "answered" && card.result?.items?.[0]?.verdict === "approve" &&
      card.sourceRunId && card.resolvedByRunId && card.sourceRunId !== card.resolvedByRunId));
    assert.deepEqual(cards.map((card) => card.resolvedByAgentId).sort(), [reviewer.id, strong.id].sort());
    for (const card of cards) {
      const source = await fetch(`${host.url}/api/heartbeat-runs/${card.sourceRunId}`).then((response) => response.json());
      const resolved = await fetch(`${host.url}/api/heartbeat-runs/${card.resolvedByRunId}`).then((response) => response.json());
      assert.equal(source.agentId, jules.id);
      assert.equal(source.status, "succeeded");
      assert.equal(resolved.agentId, card.resolvedByAgentId);
      assert.equal(resolved.status, "succeeded");
    }
    return cards.map((card) => card.id).sort();
  };
  const originalPlanCardIds = await readReviewEvidence();
  const beforeProducts = await fetch(`${host.url}/api/issues/${issue.id}/work-products`)
    .then((response) => response.json());
  assert.equal(beforeProducts.length, 0, "restart must occur before Jules registers the PR");
  const firstPid = host.pid;
  await host.stop();
  await host.start();
  assert.notEqual(host.pid, firstPid);
  const current = await fetch(`${host.url}/api/issues/${issue.id}`).then((response) => response.json());
  assert.equal(current.id, issue.id);
  const restored = await loadStoredSession(issue.id, "sources/github/paperclip-contract/fixture", "main");
  assert.equal(restored?.julesSessionId, sessionId,
    "restarted Paperclip must retain the original durable Jules provider checkpoint");
  assert.equal(creates, 1, "host restart cannot silently repeat the provider create mutation");
  releaseOutput = true;
  let woken = false;
  const delivered = await waitUntil("same-session PR product after host restart", async () => {
    const products = await fetch(`${host.url}/api/issues/${issue.id}/work-products`)
      .then((response) => response.json());
    if (products.length === 1) return products[0];
    const live = await fetch(`${host.url}/api/companies/${company.id}/live-runs?limit=50&minCount=0`)
      .then((response) => response.json());
    if (!woken && live.length === 0) {
      woken = true;
      await post(`/agents/${jules.id}/wakeup`, { source: "automation", triggerDetail: "system",
        reason: "contract_original_provider_pr_output_after_restart", payload: { issueId: issue.id } });
    }
    return false;
  }, 80_000);
  assert.equal(delivered.url, pr.url);
  assert.equal(delivered.metadata?.headSha, pr.headSha);
  assert.equal(delivered.status, "ready_for_review");
  assert.deepEqual(await readReviewEvidence(), originalPlanCardIds,
    "restart must retain the exact two addressed native plan cards without a second reviewer verdict");
  assert.equal(approvals, 1, "a restarted executor must never approve the already-confirmed plan again");
  assert.equal(creates, 1, "a restarted executor must retain the original provider session");
  const log = await readFile(path.join(root, "server.log"), "utf8");
  assert.ok([...log.matchAll(/packages\/jules\/dist\/index\.js/g)].length >= 2,
    "both Paperclip processes must load the built Jules dist/index.js adapter");
  console.log("JULES_SERVER_RESTART_CONFIRMED", JSON.stringify({ issueId: issue.id,
    sessionId, providerCreates: creates, providerApprovals: approvals, typedPlanCards: originalPlanCardIds.length }));
} catch (error) {
  const runs = companyId ? await fetch(`${host.url}/api/companies/${companyId}/heartbeat-runs?limit=20`)
    .then((response) => response.ok ? response.json() : [], () => []) : [];
  const issue = issueId ? await fetch(`${host.url}/api/issues/${issueId}`)
    .then((response) => response.ok ? response.json() : null, () => null) : null;
  const children = issueId && companyId ? await fetch(`${host.url}/api/companies/${companyId}/issues?parentId=${issueId}&limit=20`)
    .then((response) => response.ok ? response.json() : [], () => []) : [];
  const review = await Promise.all((Array.isArray(children) ? children : []).map(async (child) => ({
    id: child.id, status: child.status, owner: child.assigneeAgentId,
    cards: await fetch(`${host.url}/api/issues/${child.id}/interactions`)
      .then((response) => response.ok ? response.json() : [], () => []),
  })));
  console.error("JULES_SERVER_RESTART_DIAGNOSTIC", JSON.stringify({ providerCreates: creates,
    issue: issue && { status: issue.status, assigneeAgentId: issue.assigneeAgentId,
      executionBlocker: issue.executionBlocker?.cause ?? null },
    children: review.map((child) => ({ id: child.id, status: child.status, owner: child.owner,
      cards: child.cards.map((card) => ({ id: card.id, status: card.status, addressee: card.addresseeAgentId })) })),
    reviewerAgents: await Promise.all(reviewerIds.map(async (id) => ({ id,
      status: await fetch(`${host.url}/api/agents/${id}`).then((response) => response.json()).then((agent) => agent.status, () => null) }))),
    runs: (Array.isArray(runs) ? runs : []).map((run) => ({ status: run.status,
      agentId: run.agentId, issueId: run.contextSnapshot?.issueId,
      errorCode: run.errorCode, error: String(run.error ?? "").slice(0, 220),
      wakeReason: run.contextSnapshot?.wakeReason ?? null,
      recoveryIntent: run.contextSnapshot?.recoveryIntent ?? null,
      contextKeys: Object.keys(run.contextSnapshot ?? {}).sort() })) }));
  throw error;
} finally {
  await host.dispose();
  if (previousStore === undefined) delete process.env.PAPERCLIP_JULES_SESSION_STORE_DIR;
  else process.env.PAPERCLIP_JULES_SESSION_STORE_DIR = previousStore;
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
}
