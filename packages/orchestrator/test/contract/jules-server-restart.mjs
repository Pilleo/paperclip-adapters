/** Opt-in real-server Jules session restart probe; owns its host, provider fixture, home and database. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, chmod } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createProbe } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createDisposableHost } from "./disposable-host.mjs";
import { createChainGitHubFixture } from "./chain-github-fixture.mjs";
import { createAutonomousObserver } from "./autonomous-observer.mjs";
import { createNativeAcpFixture } from "./native-acp-fixture.mjs";
import { assertPendingMergeWait } from "./pending-merge-wait.mjs";
import { createAcceptedResponseLoss } from "./accepted-response-loss.mjs";
import { createLocalAcpRepairFixture } from "./local-acp-repair-fixture.mjs";

// Preserve the established CI entrypoint while qualifying the corrected,
// adapter-neutral workflow and review continuity in its focused real host lane.
if (process.argv.includes("--autonomous-conflict")) {
  await import("./conflict-recovery-live.mjs");
  process.exit(0);
}

const autonomousDependency = process.argv.includes("--autonomous-dependency");
const autonomousConflict = process.argv.includes("--autonomous-conflict");
const restartLostApproval = process.argv.includes("--autonomous-lost-approval-restart");
const lostApproval = restartLostApproval || process.argv.includes("--autonomous-lost-approval");
const autonomousMerge = autonomousDependency || autonomousConflict || lostApproval || process.argv.includes("--autonomous-merge");
const autonomous = autonomousMerge || process.argv.includes("--autonomous");

const root = await mkdtemp(path.join(tmpdir(), "paperclip-jules-server-restart-"));
const runExternal = promisify(execFile);
const sharedSeed = "module.exports = { increment: n => n + 1 };\n";
const sharedTask = "module.exports = { increment: n => n + 1, decrement: n => n - 1 };\n";
const sharedExternal = "module.exports = { increment: n => n + 1, double: n => n * 2 };\n";
const sharedRepair = "module.exports = { increment: n => n + 1, decrement: n => n - 1, double: n => n * 2 };\n";
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
const chainGitHub = await createChainGitHubFixture(root, { remote: autonomousMerge,
  ...(autonomousConflict ? { initialFiles: { "shared.cjs": sharedSeed, ".gitignore": ".paperclip/\n" } } : {}) });
let pr = autonomousDependency || autonomousConflict || lostApproval ? null : await chainGitHub.openPullRequest("A", "A.txt", "alpha");
const reviewControlToken = randomUUID();
let conflictObserver = null;
let originalConflictHead = null;
let externalBaseAdvance = null;
let repairedPr = null;
let publisherAgentId = null;
let localRepairAgentId = null;
let localRepairs = 0;
let repairPolls = 0;
const oldHeadReviews = new Map();
const feedbackMessages = [];
let releaseBaseBarrier;
const baseBarrier = new Promise((resolve) => { releaseBaseBarrier = resolve; });
const sessionId = randomUUID();
const dependentSessionId = randomUUID();
let dependentIssueId = null;
let dependentCreated = false;
let creates = 0;
let approvals = 0;
let approvedAt = null;
let releaseOutput = false;
const providerRequests = [];
const approvalResponseFault = createAcceptedResponseLoss(lostApproval);
let successfulApprovalObservations = 0;
const provider = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  providerRequests.push(`${request.method} ${url.pathname}`);
  const json = (status, value) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
  if (autonomousConflict && request.method === "POST" && url.pathname === "/v1alpha/fixture/local-repair") {
    try {
      assert.equal(request.headers.authorization, `Bearer ${reviewControlToken}`);
      let body = "";
      for await (const chunk of request) body += chunk;
      const operation = JSON.parse(body);
      assert.equal(operation.issueId, issueId);
      assert.equal(operation.agentId, localRepairAgentId);
      assert.equal((await conflictObserver.get(`/issues/${issueId}`)).assigneeAgentId, localRepairAgentId);
      assert.ok(externalBaseAdvance);
      localRepairs++;
      assert.equal(localRepairs, 1, "local conflict repair must execute once");
      const status = (await runExternal("git", ["status", "--porcelain"], { cwd: chainGitHub.repository })).stdout.trim();
      assert.equal(status, "", "local worker cannot overwrite unrelated dirty changes");
      await runExternal("git", ["checkout", "main"], { cwd: chainGitHub.repository, timeout: 10_000 });
      repairedPr = await chainGitHub.repairPullRequest(pr.url, { "shared.cjs": sharedRepair });
      pr = { ...pr, ...repairedPr };
      const products = await conflictObserver.get(`/issues/${issueId}/work-products`);
      assert.equal(products.length, 1);
      console.log("AUTONOMOUS_CONFLICT_LOCAL_VIBE_REPAIRED", JSON.stringify(repairedPr));
      return json(200, { productId: products[0].id, metadata: { ...products[0].metadata, headSha: repairedPr.headSha },
        publisherAgentId, prUrl: pr.url });
    } catch (error) {
      console.error("CONFLICT_LOCAL_WORKER_FAILED", error.message);
      return json(500, { error: error.message });
    }
  }
  if (autonomousConflict && request.method === "POST" && url.pathname === "/v1alpha/fixture/review") {
    try {
      assert.equal(request.headers.authorization, `Bearer ${reviewControlToken}`);
      let body = "";
      for await (const chunk of request) body += chunk;
      const event = JSON.parse(body);
      assert.equal(event.assignment.prUrl, pr.url);
      const children = await conflictObserver.get(`/companies/${companyId}/issues?parentId=${issueId}&limit=20`);
      const cards = (await Promise.all(children.map((child) => conflictObserver.get(`/issues/${child.id}/interactions`)))).flat();
      const card = cards.find((candidate) => candidate.id === event.assignment.interactionId);
      assert.ok(card, "external model policy must use an actual native assignment");
      if (event.phase === "after") {
        assert.equal(card.status, "answered");
        assert.equal(card.result.items[0].verdict, event.verdict);
        if (event.assignment.headSha === originalConflictHead) oldHeadReviews.set(card.id, event.verdict);
        if (card.addresseeAgentId === reviewerIds[0] && event.assignment.headSha === originalConflictHead && !externalBaseAdvance) {
          assert.equal(event.verdict, "approve");
          const branch = (await runExternal("git", ["branch", "--show-current"], { cwd: chainGitHub.repository, timeout: 10_000 })).stdout.trim();
          assert.equal(branch, "main", "outside contribution must advance the canonical main checkout, not a reviewer branch");
          externalBaseAdvance = await chainGitHub.mergeExternalContribution("shared.cjs", sharedExternal);
          releaseBaseBarrier();
          console.log("AUTONOMOUS_CONFLICT_BASE_ADVANCED", JSON.stringify(externalBaseAdvance));
        }
        return json(200, { recorded: true });
      }
      assert.equal(event.phase, "before");
      if (card.addresseeAgentId === reviewerIds[1] && event.assignment.headSha === originalConflictHead) await baseBarrier;
      const view = JSON.parse((await runExternal(chainGitHub.ghPath, ["pr", "view", pr.url, "--json", "headRefOid,mergeable"], { timeout: 10_000 })).stdout);
      if (view.mergeable === "CONFLICTING") return json(200, { verdict: "reject", reason: "Real Git reports an overlapping shared export conflict after the base advanced; preserve increment, decrement and double." });
      assert.equal(view.headRefOid, event.assignment.headSha);
      return json(200, { verdict: "approve" });
    } catch (error) {
      console.error("CONFLICT_REVIEW_ACTOR_FAILED", error.message);
      return json(500, { error: error.message });
    }
  }
  if (autonomousConflict && request.method === "POST" && url.pathname === `/v1alpha/sessions/${sessionId}:sendMessage`) {
    try {
      let body = "";
      for await (const chunk of request) body += chunk;
      const { prompt } = JSON.parse(body);
      assert.ok(externalBaseAdvance && typeof prompt === "string" && prompt.includes(pr.url));
      feedbackMessages.push({ prompt, at: new Date().toISOString() });
      assert.equal(feedbackMessages.length, 1, "typed conflict rejection must be delivered exactly once");
      repairedPr = await chainGitHub.repairPullRequest(pr.url, { "shared.cjs": sharedRepair });
      pr = { ...pr, ...repairedPr };
      console.log("AUTONOMOUS_CONFLICT_PROVIDER_REPAIRED", JSON.stringify(repairedPr));
      return json(200, {});
    } catch (error) {
      console.error("CONFLICT_PROVIDER_ACTOR_FAILED", error.message);
      return json(500, { error: error.message });
    }
  }
  if (request.method === "GET" && url.pathname.startsWith("/v1alpha/sessions") && approvalResponseFault.observationsHeld) {
    return json(503, { error: "deterministic approval evidence outage" });
  }
  if (request.method === "GET" && approvalResponseFault.responseLost &&
      (url.pathname === `/v1alpha/sessions/${sessionId}` || url.pathname === `/v1alpha/sessions/${sessionId}/activities`)) {
    successfulApprovalObservations++;
  }
  if (request.method === "GET" && url.pathname === "/v1alpha/sources") {
    return json(200, { sources: [{ name: "sources/github/paperclip-contract/fixture",
      githubRepo: { owner: "paperclip-contract", repo: "fixture" } }] });
  }
  if (request.method === "GET" && url.pathname === "/v1alpha/sessions") {
    return json(200, { sessions: creates ? [{ name: `sessions/${sessionId}`,
      state: approvals ? releaseOutput ? "COMPLETED" : "IN_PROGRESS" : "AWAITING_PLAN_APPROVAL" },
      ...(dependentCreated ? [{ name: `sessions/${dependentSessionId}`, state: "IN_PROGRESS" }] : [])] : [] });
  }
  if (request.method === "POST" && url.pathname === "/v1alpha/sessions") {
    if (autonomousDependency && creates === 1) {
      let body = "";
      for await (const chunk of request) body += chunk;
      if (dependentIssueId && body.includes(dependentIssueId)) {
        creates++;
        dependentCreated = true;
        return json(200, { name: `sessions/${dependentSessionId}`, state: "IN_PROGRESS", outputs: [] });
      }
    }
    if (creates++) return json(409, { error: "duplicate provider create after restart" });
    return json(200, { name: `sessions/${sessionId}`, state: "AWAITING_PLAN_APPROVAL", outputs: [] });
  }
  if (request.method === "GET" && url.pathname === `/v1alpha/sessions/${dependentSessionId}`) {
    return json(200, { name: `sessions/${dependentSessionId}`, state: "IN_PROGRESS", outputs: [] });
  }
  if (request.method === "GET" && url.pathname === `/v1alpha/sessions/${dependentSessionId}/activities`) {
    return json(200, { activities: [] });
  }
  if (request.method === "GET" && url.pathname === `/v1alpha/sessions/${sessionId}`) {
    return json(200, { name: `sessions/${sessionId}`,
      state: repairedPr ? repairPolls++ === 0 ? "IN_PROGRESS" : "COMPLETED"
        : approvals ? releaseOutput ? "COMPLETED" : "IN_PROGRESS" : "AWAITING_PLAN_APPROVAL",
      outputs: releaseOutput ? [{ pullRequest: { url: pr.url } }] : [] });
  }
  if (request.method === "GET" && url.pathname === `/v1alpha/sessions/${sessionId}/activities`) {
    return json(200, { activities: [{ id: "restart-plan-activity", createTime: "2026-09-29T00:00:00.000Z",
      planGenerated: { plan: { id: "restart-plan", steps: [{ index: 0, title: "Restart contract" }] } } },
      ...(approvedAt ? [{ id: "restart-plan-approved", createTime: approvedAt,
        planApproved: { planId: "restart-plan" } }] : []),
      ...feedbackMessages.map((message, index) => ({ id: `conflict-feedback-${index}`, createTime: message.at,
        userMessaged: { userMessage: message.prompt } }))] });
  }
  if (request.method === "POST" && url.pathname === `/v1alpha/sessions/${sessionId}:approvePlan`) {
    if (approvals++) return json(409, { error: "duplicate Jules plan approval across server restart" });
    return approvalResponseFault.respond(response, () => { approvedAt = new Date().toISOString(); });
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
  HEARTBEAT_SCHEDULER_INTERVAL_MS: "10000",
  PAPERCLIP_JULES_SESSION_STORE_DIR: path.join(root, "sessions"),
  PAPERCLIP_GH_PATH: chainGitHub.ghPath, PATH: `${root}:${process.env.PATH}` },
readinessTimeoutMs: 60_000 });
const previousStore = process.env.PAPERCLIP_JULES_SESSION_STORE_DIR;
process.env.PAPERCLIP_JULES_SESSION_STORE_DIR = path.join(root, "sessions");
const workspaceRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const packageOverride = process.argv.find((argument) => argument.startsWith("--orchestrator-package="))?.split("=").slice(1).join("=");
const orchestratorPackagePath = packageOverride ?? path.join(workspaceRoot, "packages/orchestrator");
assert.ok(path.isAbsolute(orchestratorPackagePath), "orchestrator package override must be an absolute local path");
const julesPackageOverride = process.argv.find((argument) => argument.startsWith("--jules-package="))?.split("=").slice(1).join("=");
const julesPackagePath = julesPackageOverride ?? path.join(workspaceRoot, "packages/jules");
assert.ok(path.isAbsolute(julesPackagePath), "Jules package override must be an absolute local path");
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
let orchestratorId = null;
const reviewerIds = [];
try {
  await host.start();
  const observer = createAutonomousObserver(host.url);
  conflictObserver = observer;
  const post = autonomous ? observer.setup : async (route, body) => {
    const response = await fetch(`${host.url}/api${route}`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`POST ${route} (${response.status}): ${await response.text()}`);
    return response.json();
  };
  await post("/adapters/install", { packageName: julesPackagePath, isLocalPath: true });
  await waitUntil("daemon startup log loads the exact configured Jules package", async () =>
    (await readFile(path.join(root, "server.log"), "utf8")).includes(`${julesPackagePath}/dist/index.js`));
  if (autonomousMerge) for (const packageName of ["orchestrator", "antigravity", ...(autonomousConflict ? ["vibe"] : [])]) {
    await post("/adapters/install", { packageName: packageName === "orchestrator" ? orchestratorPackagePath
      : path.join(workspaceRoot, "packages", packageName), isLocalPath: true });
  }
  const company = await post("/companies", { name: "Disposable Jules process restart" });
  companyId = company.id;
  const acp = autonomousMerge ? await createNativeAcpFixture(root, autonomousConflict
    ? { reviewDecisionUrl: `${providerUrl}/fixture/review`, reviewDecisionToken: reviewControlToken, finishPrReview: true } : {}) : null;
  const reviewerConfig = autonomousMerge ? { serverPath: acp.serverPath, model: "gemini-3.8-flash-low",
    nativeReview: true, cwd: chainGitHub.repository, permissionMode: "read-only", timeoutSec: 90,
    reviewMcpArgs: [path.join(workspaceRoot, "packages/orchestrator/dist/server/native-review-mcp-stdio.js")] }
    : { command: process.execPath, args: [reviewerScript], cwd: root };
  const managedMetadata = (workerKey) => ({ managedBy: "paperclip-orchestrator", workerKey,
    structuredDecisionCapability: { version: 1, transports: ["mcp_tool"], decisionKinds: ["plan_review", "pull_request_review"] } });
  const reviewer = await post(`/companies/${company.id}/agents`, { name: "Paused plan reviewer", role: "qa",
    adapterType: autonomousMerge ? "antigravity" : "process", adapterConfig: reviewerConfig, status: autonomous ? "idle" : "paused",
    ...(autonomousMerge ? { metadata: managedMetadata("luna_reviewer") } : {}),
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } } });
  const strong = await post(`/companies/${company.id}/agents`, { name: "Paused strong plan reviewer", role: "qa",
    adapterType: autonomousMerge ? "antigravity" : "process", adapterConfig: reviewerConfig, status: autonomous ? "idle" : "paused",
    ...(autonomousMerge ? { metadata: managedMetadata("antigravity") } : {}),
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } } });
  reviewerIds.push(reviewer.id, strong.id);
  const jules = await post(`/companies/${company.id}/agents`, { name: "Jules restart contract", role: "general",
    ...(autonomousMerge ? { metadata: { managedBy: "paperclip-orchestrator", workerKey: "jules" } } : {}),
    adapterType: "jules", adapterConfig: { apiUrl: host.url, repository: "paperclip-contract/fixture",
      source: "sources/github/paperclip-contract/fixture", baseBranch: "main", planApprovalPolicy: "required",
      planReviewerAgentId: reviewer.id, planStrongReviewerAgentId: strong.id,
      planReviewBootstrapMode: "jules_v4", e2eProviderBaseUrl: providerUrl, pollCadenceSeconds: 30,
      continuationCadenceSeconds: 10,
      env: { JULES_API_KEY: "disposable-provider-fixture-token", PATH: `${root}:${process.env.PATH}` } },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } } });
  publisherAgentId = jules.id;
  if (autonomousConflict) {
    const worker = await createLocalAcpRepairFixture(root, `${providerUrl}/fixture/local-repair`, reviewControlToken);
    const vibe = await post(`/companies/${company.id}/agents`, { name: "[Orchestrated] Vibe Local Worker", role: "engineer",
      adapterType: "vibe", adapterConfig: { serverCommand: worker.serverPath, model: "mistral-medium-3.5",
        cwd: chainGitHub.repository, permissionMode: "approve-all", timeoutSec: 90 },
      metadata: { managedBy: "paperclip-orchestrator", workerKey: "vibe" },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    localRepairAgentId = vibe.id;
  }
  let projectId;
  if (autonomousMerge) {
    const project = await post(`/companies/${company.id}/projects`, { name: "Autonomous PR merge fixture" });
    projectId = project.id;
    await post(`/projects/${project.id}/workspaces`, { name: "Local Git fixture", cwd: chainGitHub.repository,
      repoUrl: chainGitHub.repoUrl, defaultRef: "main", isPrimary: true });
    const orchestrator = await post(`/companies/${company.id}/agents`, { name: "Task Orchestrator", role: "pm", adapterType: "orchestrator",
      adapterConfig: { apiUrl: host.url, workspacePath: chainGitHub.repository, backlogDirectory: ".paperclip-contract-empty",
        reconcileFleet: false, julesAgentId: jules.id, lunaReviewerAgentId: reviewer.id,
        ...(localRepairAgentId ? { vibeAgentId: localRepairAgentId } : {}),
        julesPlanApprovalPolicy: "required", maxConcurrentJules: 1, maxConcurrentVibe: localRepairAgentId ? 1 : 0 },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 10, wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    orchestratorId = orchestrator.id;
    assert.match(await readFile(path.join(root, "server.log"), "utf8"), /packages\/orchestrator\/dist\/index\.js/,
      "the autonomous merge lane must load the real built orchestrator adapter");
    assert.ok((await readFile(path.join(root, "server.log"), "utf8")).includes(`${orchestratorPackagePath}/dist/index.js`),
      "the daemon must load the exact configured orchestrator package, including private mutations");
  }
  const issue = await (autonomousDependency ? post : autonomous ? observer.startIssue : post)(`/companies/${company.id}/issues`, { title: "Create one Jules session before server restart",
    description: autonomousDependency
      ? "---\norchestrator_managed: true\nexecutor: jules\ntarget_files: [A.txt]\n---\n\nImplement canary A and preserve its provider session across restart."
      : "---\norchestrator_managed: true\n---\n\nPersist the original Jules provider session across a real control-plane restart.",
    status: autonomousDependency ? "todo" : "in_progress", assigneeAgentId: autonomousDependency ? null : jules.id,
    ...(projectId ? { projectId } : {}) });
  issueId = issue.id;
  const userStartApprovals = [];
  const approveStartAsUser = async (targetId) => {
    assert.ok([issue.id, dependentIssueId].includes(targetId));
    const approval = await waitUntil("addressed native user task-start gate", async () => {
      const cards = (await observer.get(`/companies/${company.id}/approvals`))
        .filter((card) => card.payload?.action === "task_start" && card.payload.issueId === targetId);
      if (!cards.length) return false;
      assert.equal(cards.length, 1);
      assert.equal(cards[0].status, "pending");
      return cards[0];
    }, 90_000);
    // Explicit simulated user actor, never the observation driver's write helper.
    const response = await fetch(`${host.url}/api/approvals/${approval.id}/approve`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ decisionNote: "Disposable user authorizes this exact task start." }),
      signal: AbortSignal.timeout(20_000) });
    assert.ok(response.ok, `Native user start approval failed (${response.status}): ${await response.text()}`);
    userStartApprovals.push(approval.id);
    return approval.id;
  };
  if (autonomousDependency) {
    const dependent = await post(`/companies/${company.id}/issues`, { title: "Dependent task B",
      description: "---\norchestrator_managed: true\nexecutor: jules\ntarget_files: [B.txt]\n---\n\nImplement B only after A merges and the user approves B.",
      projectId, status: "todo", assigneeAgentId: null, blockedByIssueIds: [issue.id] });
    dependentIssueId = dependent.id;
    assert.deepEqual((await observer.get(`/issues/${dependent.id}`)).blockedBy.map((blocker) => blocker.id), [issue.id]);
    observer.beginObservation();
    await approveStartAsUser(issue.id);
  }
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
  for (const candidate of autonomous ? [] : [reviewer, strong]) {
    const resumed = await post(`/agents/${candidate.id}/resume`, {});
    assert.equal(resumed.id, candidate.id);
  }
  if (!autonomous) await post(`/agents/${jules.id}/wakeup`, { source: "automation", triggerDetail: "system",
    reason: "contract_native_plan_capacity_restored", payload: { issueId: issue.id } });
  const monitorWakeKeys = new Set();
  let lostApprovalCardIds = null;
  await waitUntil("one confirmed provider plan approval from typed reviewer runs", async () => {
    assert.ok(approvals <= 1, "provider plan approval POST must never be replayed after uncertain acceptance");
    if (approvals === 1) return true;
    if (autonomous) {
      if (autonomousMerge) {
        const runs = await observer.get(`/companies/${company.id}/heartbeat-runs?limit=100`);
        const failed = runs.find((run) => ["failed", "timed_out"].includes(run.status));
        assert.equal(failed, undefined, `Autonomous run failed: ${failed?.errorCode}: ${failed?.error}`);
      }
      return false;
    }
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
  // The autonomous ladder includes multiple persisted 60-second continuations,
  // each observed by the daemon's real timer. This is only a test observation budget.
  }, autonomous ? 900_000 : 100_000);
  assert.equal(approvals, 1, "one addressed Luna and strong plan ladder must approve the original provider session before restart");
  if (lostApproval) {
    assert.equal(approvalResponseFault.responseLost, true);
    assert.equal(approvalResponseFault.observationsHeld, true);
    const uncertain = await waitUntil("durable started approval effect after remote acceptance", async () => {
      const checkpoint = await loadStoredSession(issue.id, "sources/github/paperclip-contract/fixture", "main");
      const effect = checkpoint?.lifecycleEffectJournal?.effects.find((candidate) => candidate.kind === "approve_plan");
      return effect?.attempt.kind === "started" && { checkpoint, effect };
    });
    assert.equal(uncertain.checkpoint.julesSessionId, sessionId);
    const effectId = uncertain.effect.effectId;
    const children = await observer.get(`/companies/${company.id}/issues?parentId=${issue.id}&limit=20`);
    const cards = (await Promise.all(children.map((child) => observer.get(`/issues/${child.id}/interactions`)))).flat();
    assert.equal(cards.length, 2);
    assert.ok(cards.every((card) => card.status === "answered"));
    lostApprovalCardIds = cards.map((card) => card.id).sort();
    await waitUntil("uncertain provider run settles while observation is held", async () =>
      (await observer.get(`/companies/${company.id}/live-runs?limit=50&minCount=0`)).length === 0, 90_000);
    const heldCheckpoint = await loadStoredSession(issue.id, "sources/github/paperclip-contract/fixture", "main");
    assert.equal(heldCheckpoint?.lifecycleEffectJournal?.effects.find((effect) => effect.effectId === effectId)?.attempt.kind, "started",
      "local acknowledgement cannot be fabricated while provider observation is unavailable");
    console.log("AUTONOMOUS_LOST_APPROVAL_UNCERTAIN", JSON.stringify({ effectId, sessionId,
      responseLost: true, providerApprovals: approvals, nativePlanCardIds: lostApprovalCardIds }));
    if (restartLostApproval) {
      const uncertainPid = host.pid;
      await host.stop();
      await host.start();
      assert.notEqual(host.pid, uncertainPid);
      const checkpoint = await loadStoredSession(issue.id, "sources/github/paperclip-contract/fixture", "main");
      assert.equal(checkpoint?.julesSessionId, sessionId);
      assert.equal(checkpoint?.lifecycleEffectJournal?.effects.find((effect) => effect.effectId === effectId)?.attempt.kind, "started");
      console.log("AUTONOMOUS_UNCERTAIN_APPROVAL_RESTART_CONFIRMED", JSON.stringify({ effectId, sessionId }));
    }
    approvalResponseFault.releaseObservations();
    await waitUntil("normal scheduling reconciles accepted approval from provider evidence", async () => {
      assert.equal(approvals, 1, "uncertain approval recovery cannot issue another provider approval");
      const checkpoint = await loadStoredSession(issue.id, "sources/github/paperclip-contract/fixture", "main");
      return checkpoint?.lifecycleEffectJournal?.effects.find((effect) => effect.effectId === effectId)?.attempt.kind === "confirmed";
    }, 180_000);
    assert.ok(successfulApprovalObservations > 0, "confirmation must follow an actual successful provider observation");
    assert.equal(creates, 1);
    console.log("AUTONOMOUS_LOST_APPROVAL_RECONCILED", JSON.stringify({ effectId, restarted: restartLostApproval,
      providerApprovals: approvals, providerCreates: creates, successfulProviderObservations: successfulApprovalObservations }));
  }
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
    assert.deepEqual(cards.map((card) => autonomousMerge ? card.addresseeAgentId : card.resolvedByAgentId).sort(), [reviewer.id, strong.id].sort());
    for (const card of cards) {
      const source = await fetch(`${host.url}/api/heartbeat-runs/${card.sourceRunId}`).then((response) => response.json());
      const resolved = await fetch(`${host.url}/api/heartbeat-runs/${card.resolvedByRunId}`).then((response) => response.json());
      assert.equal(source.agentId, jules.id);
      assert.equal(source.status, "succeeded");
      assert.equal(resolved.agentId, autonomousMerge ? card.addresseeAgentId : card.resolvedByAgentId);
      assert.equal(resolved.status, "succeeded");
    }
    return cards.map((card) => card.id).sort();
  };
  const originalPlanCardIds = await readReviewEvidence();
  if (lostApprovalCardIds) assert.deepEqual(originalPlanCardIds, lostApprovalCardIds,
    "uncertain-effect recovery must retain the original addressed native plan cards");
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
  if (!pr) pr = await chainGitHub.openPullRequest("A", autonomousConflict ? "shared.cjs" : "A.txt", autonomousConflict ? sharedTask : "alpha");
  if (autonomousConflict) originalConflictHead = pr.headSha;
  releaseOutput = true;
  let woken = false;
  const delivered = await waitUntil("same-session PR product after host restart", async () => {
    const products = await fetch(`${host.url}/api/issues/${issue.id}/work-products`)
      .then((response) => response.json());
    if (products.length === 1) return products[0];
    const live = await fetch(`${host.url}/api/companies/${company.id}/live-runs?limit=50&minCount=0`)
      .then((response) => response.json());
    if (!autonomous && !woken && live.length === 0) {
      woken = true;
      await post(`/agents/${jules.id}/wakeup`, { source: "automation", triggerDetail: "system",
        reason: "contract_original_provider_pr_output_after_restart", payload: { issueId: issue.id } });
    }
    return false;
  }, 80_000);
  assert.equal(delivered.url, pr.url);
  assert.equal(delivered.metadata?.headSha, pr.headSha);
  assert.equal(delivered.status, "ready_for_review");
  if (autonomousMerge) {
    const producer = await waitUntil("native persistence of the immutable terminal PR producer", async () => {
      const run = await observer.get(`/heartbeat-runs/${delivered.createdByRunId}`);
      return run.status === "succeeded" && run;
    });
    assert.equal(producer.resultJson?.provider, "jules");
    assert.equal(producer.resultJson?.julesSessionId, sessionId);
    assert.equal(producer.resultJson?.julesState, "COMPLETED");
    assert.equal(producer.resultJson?.stopReason, "completed");
    assert.equal(producer.resultJson?.handoffPending, true);
    assert.equal(producer.resultJson?.headSha, pr.headSha);
    console.log("AUTONOMOUS_PR_PRODUCER_CONFIRMED", JSON.stringify({ runId: producer.id,
      providerSessionId: sessionId, headSha: pr.headSha }));
  }
  assert.deepEqual(await readReviewEvidence(), originalPlanCardIds,
    "restart must retain the exact two addressed native plan cards without a second reviewer verdict");
  assert.equal(approvals, 1, "a restarted executor must never approve the already-confirmed plan again");
  assert.equal(creates, 1, "a restarted executor must retain the original provider session");
  if (autonomousMerge) {
    const { parsePrReviewChildDescription } = await import("../../dist/core/pr-review-child.js");
    const gate = await waitUntil("autonomous native PR reviews and pending human merge gate", async () => {
      if (autonomousConflict) for (const reviewerId of reviewerIds) {
        const agent = await observer.get(`/agents/${reviewerId}`);
        assert.notEqual(agent.status, "error", "native conflict reviewer entered an unrecovered error state");
      }
      if (autonomousConflict && !repairedPr) return false;
      const children = await observer.get(`/companies/${company.id}/issues?parentId=${issue.id}&limit=20`);
      const reviews = children.map((child) => ({ child, identity: parsePrReviewChildDescription(child.description) }))
        .filter(({ identity }) => identity?.prUrl === pr.url && identity.headSha === pr.headSha);
      if (reviews.length !== 2) return false;
      const evidence = [];
      for (const { child, identity } of reviews) {
        const cards = await observer.get(`/issues/${child.id}/interactions`);
        if (cards.length !== 1 || cards[0].status !== "answered") return false;
        const card = cards[0];
        assert.equal(card.result?.items?.[0]?.verdict, "approve");
        assert.equal(card.addresseeAgentId, identity.reviewerAgentId);
        assert.notEqual(card.sourceRunId, card.resolvedByRunId);
        const source = await observer.get(`/heartbeat-runs/${card.sourceRunId}`);
        const resolved = await observer.get(`/heartbeat-runs/${card.resolvedByRunId}`);
        if (source.status !== "succeeded" || resolved.status !== "succeeded") return false;
        assert.equal(source.agentId, identity.bootstrapAgentId);
        assert.equal(source.agentId, orchestratorId);
        assert.equal(source.contextSnapshot.issueId, child.id);
        assert.equal(resolved.agentId, identity.reviewerAgentId);
        assert.equal(resolved.contextSnapshot.issueId, child.id);
        evidence.push({ stage: identity.stage, reviewerAgentId: identity.reviewerAgentId, verdict: "approve",
          cardId: card.id, sourceRunId: source.id, resolvedByRunId: resolved.id });
      }
      const approvals = await observer.get(`/companies/${company.id}/approvals`);
      const gates = approvals.filter((approval) => approval.payload?.action === "task_merge" && approval.payload.issueId === issue.id);
      if (gates.length === 0) return false;
      assert.equal(gates.length, 1, "normal scheduling must create exactly one native human merge gate");
      assert.equal(gates[0].status, "pending");
      assert.equal(gates[0].payload.prUrl, pr.url);
      assert.equal((await observer.get(`/issues/${issue.id}`)).status, "in_review");
      return { approvalId: gates[0].id, reviews: evidence };
    }, 360_000);
    console.log("AUTONOMOUS_PR_MERGE_GATE_CONFIRMED", JSON.stringify(gate));
    if (autonomousConflict) {
      assert.ok(repairedPr && repairedPr.headSha !== originalConflictHead);
      assert.deepEqual([...oldHeadReviews.values()], ["approve"]);
      assert.ok(gate.reviews.every((review) => !oldHeadReviews.has(review.cardId)));
      assert.equal(localRepairs, 1);
      const code = (await runExternal("git", ["show", `${pr.headSha}:shared.cjs`], { cwd: chainGitHub.repository, timeout: 10_000 })).stdout;
      await runExternal(process.execPath, ["-e", code + "\nconst a=require('node:assert/strict'); a.equal(module.exports.increment(8),9); a.equal(module.exports.decrement(8),7); a.equal(module.exports.double(8),16);"], { timeout: 10_000 });
      console.log("AUTONOMOUS_CONFLICT_NEW_HEAD_REVIEWS_CONFIRMED", JSON.stringify({ oldHeadSha: originalConflictHead,
        newHeadSha: pr.headSha, oldCardIds: [...oldHeadReviews.keys()], freshCardIds: gate.reviews.map((review) => review.cardId) }));
    }
    const expectedWait = { issueId: issue.id, approvalId: gate.approvalId, prUrl: pr.url, headSha: pr.headSha,
      productId: delivered.id, cardIds: [...originalPlanCardIds, ...oldHeadReviews.keys(), ...gate.reviews.map((review) => review.cardId)] };
    const readWait = async () => {
      const children = await observer.get(`/companies/${company.id}/issues?parentId=${issue.id}&limit=20`);
      const snapshot = { issue: await observer.get(`/issues/${issue.id}`),
        approvals: await observer.get(`/companies/${company.id}/approvals`),
        products: await observer.get(`/issues/${issue.id}/work-products`),
        cards: (await Promise.all(children.map((child) => observer.get(`/issues/${child.id}/interactions`)))).flat() };
      return assertPendingMergeWait(snapshot, expectedWait);
    };
    const beforeWait = await observer.get(`/companies/${company.id}/heartbeat-runs?limit=100`);
    const oldRunIds = new Set(beforeWait.map((run) => run.id));
    await waitUntil("three scheduled heartbeats while the human merge remains pending", async () => {
      await readWait();
      const runs = await observer.get(`/companies/${company.id}/heartbeat-runs?limit=100`);
      return runs.filter((run) => run.agentId === orchestratorId && run.status === "succeeded" && !oldRunIds.has(run.id)).length >= 3;
    }, 90_000);
    const { decideObservationWindow } = await import("../../dist/core/stress-observation-budget.js");
    assert.deepEqual(decideObservationWindow((await readWait()).kind, true),
      { action: "stop_waiting_for_user", waitingFor: "awaiting_user_merge" });
    await waitUntil("all addressed runs idle before restarting a human wait", async () =>
      (await observer.get(`/companies/${company.id}/live-runs?limit=50&minCount=0`)).length === 0);
    const waitingPid = host.pid;
    const restartedWaitAt = Date.now();
    await host.stop();
    await host.start();
    assert.notEqual(host.pid, waitingPid);
    await readWait();
    await waitUntil("scheduled reconciliation after human-wait restart", async () => {
      await readWait();
      const runs = await observer.get(`/companies/${company.id}/heartbeat-runs?limit=100`);
      return runs.some((run) => run.agentId === orchestratorId && run.status === "succeeded" &&
        !oldRunIds.has(run.id) && Date.parse(run.startedAt) > restartedWaitAt);
    });
    assert.equal(creates, 1);
    assert.equal(approvals, 1);
    console.log("AUTONOMOUS_HUMAN_MERGE_WAIT_RESTART_CONFIRMED", JSON.stringify({ approvalId: gate.approvalId,
      retainedCardIds: expectedWait.cardIds, observationExpired: true }));
    if (autonomousDependency) {
      const before = await observer.get(`/issues/${dependentIssueId}`);
      assert.equal(before.assigneeAgentId, null);
      assert.deepEqual(before.blockedBy.map((blocker) => blocker.id), [issue.id]);
      const beforeRuns = await observer.get(`/companies/${company.id}/heartbeat-runs?limit=100`);
      assert.ok(!beforeRuns.some((run) => run.agentId === jules.id && run.contextSnapshot?.issueId === dependentIssueId));
      const merged = await chainGitHub.externalMerge(pr.url, { headSha: pr.headSha,
        reviews: [...gate.reviews].sort((left) => left.stage === "luna" ? -1 : 1) });
      console.log("AUTONOMOUS_USER_MERGE_FIXTURE_PUBLISHED", JSON.stringify({ mergeSha: merged.mergeSha, headSha: pr.headSha }));
      await waitUntil("normal heartbeat verifies user merge and releases native dependency", async () => {
        const source = await observer.get(`/issues/${issue.id}`);
        const products = await observer.get(`/issues/${issue.id}/work-products`);
        return source.status === "done" && products.length === 1 && products[0].status === "merged";
      }, 120_000);
      const released = await observer.get(`/issues/${dependentIssueId}`);
      assert.deepEqual(released.blockedBy.map((blocker) => [blocker.id, blocker.status]), [[issue.id, "done"]]);
      assert.equal(released.assigneeAgentId, null, "merge alone cannot bypass B's user start gate");
      assert.equal(creates, 1);
      console.log("AUTONOMOUS_USER_MERGE_NATIVE_RECONCILED", JSON.stringify({ sourceIssueId: issue.id,
        dependentIssueId, blockerStatus: "done" }));
      await approveStartAsUser(dependentIssueId);
      await waitUntil("scheduled B dispatch after its native user start approval", async () => {
        const current = await observer.get(`/issues/${dependentIssueId}`);
        const checkpoint = await loadStoredSession(dependentIssueId, "sources/github/paperclip-contract/fixture", "main");
        return dependentCreated && creates === 2 && checkpoint?.julesSessionId === dependentSessionId &&
          current.status === "in_progress" && current.assigneeAgentId === jules.id;
      }, 120_000);
      const runs = await observer.get(`/companies/${company.id}/heartbeat-runs?limit=100`);
      assert.ok(runs.some((run) => run.agentId === jules.id && run.contextSnapshot?.issueId === dependentIssueId && run.startedAt));
      assert.equal((await observer.get(`/issues/${issue.id}`)).status, "done");
      console.log("AUTONOMOUS_USER_MERGE_DEPENDENCY_RELEASE_CONFIRMED", JSON.stringify({ mergeSha: merged.mergeSha,
        sourceIssueId: issue.id, dependentIssueId, userStartApprovals, providerCreates: creates }));
    }
  }
  const log = await readFile(path.join(root, "server.log"), "utf8");
  assert.ok([...log.matchAll(/packages\/jules\/dist\/index\.js/g)].length >= 2,
    "both Paperclip processes must load the built Jules dist/index.js adapter");
  if (autonomousMerge) for (const packageName of ["orchestrator", "antigravity"]) {
    assert.ok(log.split(`packages/${packageName}/dist/index.js`).length >= 3,
      `both daemon processes must load the built ${packageName} adapter`);
  }
  if (autonomous) {
    assert.equal(observer.trace.filter((entry) => entry.phase === "observing" && entry.method !== "GET").length, 0,
      "the driver must not rescue-wake, reassign or repair state after source start");
    console.log("AUTONOMOUS_JULES_RESTART_CONFIRMED", JSON.stringify({
      providerCreates: creates, providerApprovals: approvals, driverMutationsAfterStart: 0,
      nativePlanCards: originalPlanCardIds, issueId: issue.id, productId: delivered.id }));
  }
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
    id: child.id, status: child.status, owner: child.assigneeAgentId, projectId: child.projectId,
    executionWorkspaceId: child.executionWorkspaceId,
    cards: await fetch(`${host.url}/api/issues/${child.id}/interactions`)
      .then((response) => response.ok ? response.json() : [], () => []),
  })));
  if (autonomousConflict) {
    console.error("CONFLICT_CHECKOUT_DIAGNOSTIC", JSON.stringify({
      branch: (await runExternal("git", ["branch", "--show-current"], { cwd: chainGitHub.repository })).stdout.trim(),
      status: (await runExternal("git", ["status", "--porcelain"], { cwd: chainGitHub.repository })).stdout.trim() }));
    for (const child of review) for (const card of child.cards) {
      if (card.payload?.items?.[0]?.id !== "pull_request" || !card.resolvedByRunId) continue;
      const original = await fetch(`${host.url}/api/heartbeat-runs/${card.resolvedByRunId}`).then((response) => response.json());
      const log = await fetch(`${host.url}/api/heartbeat-runs/${card.resolvedByRunId}/log?offset=0&limitBytes=65536`).then((response) => response.json());
      console.error("CONFLICT_REVIEW_SOURCE_DIAGNOSTIC", JSON.stringify({ runId: original.id, status: original.status,
        executionWorkspace: original.contextSnapshot?.executionWorkspace, contextKeys: Object.keys(original.contextSnapshot ?? {}), log }));
    }
  }
  console.error("JULES_SERVER_RESTART_DIAGNOSTIC", JSON.stringify({ providerCreates: creates,
    issue: issue && { status: issue.status, assigneeAgentId: issue.assigneeAgentId,
      executionBlocker: issue.executionBlocker?.cause ?? null },
    children: review.map((child) => ({ id: child.id, status: child.status, owner: child.owner, projectId: child.projectId,
      executionWorkspaceId: child.executionWorkspaceId,
      cards: child.cards.map((card) => ({ id: card.id, status: card.status, addressee: card.addresseeAgentId })) })),
    reviewerAgents: await Promise.all(reviewerIds.map(async (id) => ({ id,
      status: await fetch(`${host.url}/api/agents/${id}`).then((response) => response.json()).then((agent) => agent.status, () => null) }))),
    runs: (Array.isArray(runs) ? runs : []).map((run) => ({ status: run.status,
      agentId: run.agentId, issueId: run.contextSnapshot?.issueId,
      errorCode: run.errorCode, error: String(run.error ?? "").slice(0, 220),
      summary: run.resultJson?.summary ?? null, resultJson: run.resultJson,
      wakeReason: run.contextSnapshot?.wakeReason ?? null,
      recoveryIntent: run.contextSnapshot?.recoveryIntent ?? null,
      contextKeys: Object.keys(run.contextSnapshot ?? {}).sort() })), providerRequests }));
  throw error;
} finally {
  await host.dispose();
  if (previousStore === undefined) delete process.env.PAPERCLIP_JULES_SESSION_STORE_DIR;
  else process.env.PAPERCLIP_JULES_SESSION_STORE_DIR = previousStore;
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
}
