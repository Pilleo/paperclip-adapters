/** Real daemon, PostgreSQL, native reviews and exact configured local/remote repair actors. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createProbe } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createDisposableHost } from "./disposable-host.mjs";
import { createChainGitHubFixture } from "./chain-github-fixture.mjs";
import { createAutonomousObserver } from "./autonomous-observer.mjs";
import { createNativeAcpFixture } from "./native-acp-fixture.mjs";
import { createConflictRepairAgent } from "./conflict-repair-agent.mjs";
import { resolveContractHost } from "./host-installation.mjs";

const argument = (key) => process.argv.find((value) => value.startsWith(key + "="))?.slice(key.length + 1);
const mode = argument("--conflict-recovery-mode") ?? "agent";
const adapter = argument("--repair-agent-adapter") ?? "process";
const shape = argument("--conflict-shape") ?? "overlap";
const initialNoPr = process.argv.includes("--initial-no-pr");
const installation = resolveContractHost();
assert.ok(["manual", "git_only", "agent", "default"].includes(mode));
assert.ok(["process", "jules"].includes(adapter));
assert.ok(["overlap", "disjoint"].includes(shape));
const workspace = fileURLToPath(new URL("../../../..", import.meta.url));
const orchestratorPackage = argument("--orchestrator-package") ?? path.join(workspace, "packages/orchestrator");
assert.ok(path.isAbsolute(orchestratorPackage));
const root = await mkdtemp(path.join(tmpdir(), "paperclip-conflict-policy-"));
const run = promisify(execFile);
const github = await createChainGitHubFixture(root, { remote: true, observePublishedHeads: shape === "disjoint",
  enforceUpToDate: shape === "disjoint", initialFiles: {
  "shared.cjs": "module.exports = { increment: n => n + 1 };\n", ".gitignore": ".paperclip/\n" } });
let pr = initialNoPr ? null : await github.openPullRequest("source", "shared.cjs", "module.exports = { increment: n => n + 1, decrement: n => n - 1 };\n");
let originalHead = pr?.headSha;
let requiredPrMessages = 0;
let requiredPrMessage = null;
let requiredPrEcho = null;
let baseAdvanced = null;
let repaired = null;
let repairOperations = 0;
let observer, host, companyId, sourceId, resolverId, orchestratorId;
let dependentId, dependentSessionId;
let repairPublishedAt = null;
const reviewIds = [];
const originalCards = new Map();
const sessions = new Map();
const createRequests = [];
const operationToken = randomUUID();
const wait = async (label, probe, budget = 180_000) => {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    const value = await probe(); if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out: ${label}`);
};
const repairAsActor = async (taskId, agentId, nativeRunId = null) => {
  const task = await observer.get(`/issues/${taskId}`);
  assert.equal(task.parentId, sourceId); assert.equal(task.assigneeAgentId, resolverId); assert.equal(agentId, resolverId);
  if (nativeRunId) {
    const actualRun = await observer.get(`/heartbeat-runs/${nativeRunId}`);
    assert.equal(actualRun.contextSnapshot.issueId, taskId); assert.equal(actualRun.agentId, resolverId);
  }
  const start = task.description.indexOf("\n") + 1;
  const assignment = JSON.parse(task.description.slice(start, task.description.indexOf("\n-->")));
  assert.equal(assignment.previousHeadSha, originalHead); assert.equal(assignment.prUrl, pr.url);
  assert.equal(++repairOperations, 1);
  repaired = await github.repairPullRequest(pr.url, {
    "shared.cjs": "module.exports = { increment: n => n + 1, decrement: n => n - 1, double: n => n * 2 };\n" });
  pr = { ...pr, ...repaired };
  repairPublishedAt = Date.now();
  return { ...repaired, attemptId: assignment.attemptId };
};
const provider = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const reply = (code, body) => { response.writeHead(code, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
  try {
    let text = ""; for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : {};
    if (url.pathname === "/review") {
      assert.equal(request.headers.authorization, `Bearer ${operationToken}`);
      if (body.phase === "before") return reply(200, { verdict: "approve" });
      assert.equal(body.phase, "after");
      assert.equal(body.assignment.headSha, originalHead);
      const children = await observer.get(`/companies/${companyId}/issues?parentId=${sourceId}&limit=100`);
      const cards = (await Promise.all(children.map((child) => observer.get(`/issues/${child.id}/interactions`)))).flat();
      const card = cards.find((item) => item.id === body.assignment.interactionId);
      assert.ok(card); assert.equal(card.status, "answered"); assert.equal(card.result.items[0].verdict, "approve");
      originalCards.set(body.assignment.interactionId, body.assignment);
      if (card.addresseeAgentId === reviewIds[1] && !baseAdvanced) {
        baseAdvanced = await github.mergeExternalContribution(shape === "disjoint" ? "external.cjs" : "shared.cjs",
          shape === "disjoint" ? "module.exports = { double: n => n * 2 };\n" : "module.exports = { increment: n => n + 1, double: n => n * 2 };\n");
      }
      return reply(200, { recorded: true });
    }
    if (url.pathname === "/repair") {
      assert.equal(request.headers.authorization, `Bearer ${operationToken}`);
      return reply(200, await repairAsActor(body.issueId, body.agentId, body.runId));
    }
    if (url.pathname === "/v1alpha/sources") return reply(200, { sources: [{ name: "sources/github/paperclip-contract/fixture", githubRepo: { owner: "paperclip-contract", repo: "fixture" } }] });
    const continuation = url.pathname.match(/^\/v1alpha\/sessions\/([^/]+):sendMessage$/);
    if (request.method === "POST" && continuation && initialNoPr) {
      assert.ok(sessions.has(continuation[1]));
      assert.equal(++requiredPrMessages, 1, "Adapter required-PR continuation must be sent once");
      assert.ok(body.prompt.includes("[paperclip:required-pr:") && body.prompt.includes(sourceId));
      assert.ok(body.prompt.includes("exactly one pull request"));
      requiredPrMessage = body.prompt;
      requiredPrEcho = { id: "required-pr-message-echo", createTime: new Date().toISOString(), userMessaged: { userMessage: body.prompt } };
      pr = await github.openPullRequest("source", "shared.cjs", "module.exports = { increment: n => n + 1, decrement: n => n - 1 };\n");
      originalHead = pr.headSha;
      sessions.set(continuation[1], { name: `sessions/${continuation[1]}`, state: "COMPLETED", outputs: [{ pullRequest: { url: pr.url } }] });
      return reply(200, {});
    }
    if (request.method === "POST" && url.pathname === "/v1alpha/sessions") {
      createRequests.push(body);
      if (body.prompt.includes("<!-- paperclip-conflict-repair:v1\n")) {
        const marker = "<!-- paperclip-conflict-repair:v1\n";
        const start = body.prompt.indexOf(marker) + marker.length;
        const assignment = JSON.parse(body.prompt.slice(start, body.prompt.indexOf("\n-->", start)));
        const children = await observer.get(`/companies/${companyId}/issues?parentId=${sourceId}&limit=100`);
        const task = children.find((child) => child.description?.includes(assignment.attemptId));
        assert.ok(task); assert.equal(body.sourceContext.githubRepoContext.startingBranch, assignment.headRef);
        await repairAsActor(task.id, resolverId);
      }
      const id = randomUUID();
      const dependent = dependentId && body.prompt.includes(dependentId);
      if (dependent) dependentSessionId = id;
      sessions.set(id, { name: `sessions/${id}`, state: dependent ? "IN_PROGRESS" : "COMPLETED",
        outputs: dependent || (initialNoPr && !pr) ? [] : [{ pullRequest: { url: pr.url } }] });
      return reply(200, sessions.get(id));
    }
    if (url.pathname === "/v1alpha/sessions") return reply(200, { sessions: [...sessions.values()] });
    const match = url.pathname.match(/^\/v1alpha\/sessions\/([^/]+)(\/activities)?$/);
    if (match && sessions.has(match[1])) return reply(200, match[2] ? { activities: requiredPrEcho ? [requiredPrEcho] : [] } : sessions.get(match[1]));
    return reply(404, { error: "Unsupported provider operation" });
  } catch (error) { console.error("CONFLICT_ACTOR_ERROR", error); reply(500, { error: error.message }); }
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerOrigin = `http://127.0.0.1:${provider.address().port}`;
const probe = createProbe(); await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
host = createDisposableHost({ root, command: installation.command, args: [...installation.args, "onboard", "--config", path.join(root, "home/config.json"),
  "--data-dir", path.join(root, "home"), "--bind", "loopback", "--yes", "--no-install-service"], port,
  environment: { PAPERCLIP_ADAPTER_E2E: "1", HEARTBEAT_SCHEDULER_INTERVAL_MS: "10000",
    PAPERCLIP_API_URL: `http://127.0.0.1:${port}`, PAPERCLIP_JULES_SESSION_STORE_DIR: path.join(root, "sessions"),
    PAPERCLIP_GH_PATH: github.ghPath, PATH: `${root}:${process.env.PATH}` }, readinessTimeoutMs: 60_000 });
try {
  await host.start(); observer = createAutonomousObserver(host.url);
  for (const name of ["jules", "antigravity", "orchestrator"]) {
    await observer.setup("/adapters/install", { packageName: name === "orchestrator" ? orchestratorPackage : path.join(workspace, "packages", name), isLocalPath: true });
  }
  const company = await observer.setup("/companies", { name: "Conflict policy qualification" }); companyId = company.id;
  const project = await observer.setup(`/companies/${companyId}/projects`, { name: "Conflict policy repository" });
  await observer.setup(`/projects/${project.id}/workspaces`, { name: "Owned Git fixture", cwd: github.repository, repoUrl: github.repoUrl, defaultRef: "main", isPrimary: true });
  const model = await createNativeAcpFixture(root, { finishPrReview: true, reviewDecisionUrl: `${providerOrigin}/review`, reviewDecisionToken: operationToken });
  const capability = { version: 1, transports: ["mcp_tool"], decisionKinds: ["plan_review", "pull_request_review"] };
  for (const key of ["luna_reviewer", "antigravity"]) {
    const agent = await observer.setup(`/companies/${companyId}/agents`, { name: key, role: "qa", adapterType: "antigravity",
      adapterConfig: { serverPath: model.serverPath, nativeReview: true, cwd: github.repository,
        reviewMcpArgs: [path.join(workspace, "packages/orchestrator/dist/server/native-review-mcp-stdio.js")],
        model: "gemini-3.8-flash-low", permissionMode: "read-only", timeoutSec: 90 },
      metadata: { managedBy: "paperclip-orchestrator", workerKey: key, structuredDecisionCapability: capability },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    reviewIds.push(agent.id);
  }
  const julesConfig = { apiUrl: host.url, repository: "paperclip-contract/fixture", source: "sources/github/paperclip-contract/fixture",
    baseBranch: "main", planApprovalPolicy: "trusted_opt_out", e2eProviderBaseUrl: `${providerOrigin}/v1alpha`,
    pollCadenceSeconds: 30, continuationCadenceSeconds: 10, env: { JULES_API_KEY: "owned-fixture-key", PATH: `${root}:${process.env.PATH}` } };
  const publisher = await observer.setup(`/companies/${companyId}/agents`, { name: "Original Jules publisher", role: "engineer", adapterType: "jules",
    adapterConfig: julesConfig, metadata: { managedBy: "paperclip-orchestrator", workerKey: "jules" },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } } });
  const processConfig = await createConflictRepairAgent(root, `${providerOrigin}/repair`, operationToken);
  const resolver = await observer.setup(`/companies/${companyId}/agents`, { name: "Explicit independent resolver", role: "engineer", adapterType: adapter,
    adapterConfig: adapter === "jules" ? julesConfig : processConfig,
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } } }); resolverId = resolver.id;
  const orchestrator = await observer.setup(`/companies/${companyId}/agents`, { name: "Task Orchestrator", role: "pm", adapterType: "orchestrator",
    adapterConfig: { apiUrl: host.url, workspacePath: github.repository, backlogDirectory: ".empty-backlog", reconcileFleet: false,
      julesAgentId: publisher.id, lunaReviewerAgentId: reviewIds[0], julesPlanApprovalPolicy: "trusted_opt_out",
      conflictRecoveryAgentId: resolver.id, ...(mode !== "default" ? { conflictRecoveryMode: mode } : {}), maxConcurrentJules: 1, maxConcurrentVibe: 0 },
    runtimeConfig: { heartbeat: { enabled: true, intervalSec: 10, wakeOnDemand: true, maxConcurrentRuns: 1 } } }); orchestratorId = orchestrator.id;
  const source = await observer.setup(`/companies/${companyId}/issues`, { title: "Implement shared exports",
    description: "---\norchestrator_managed: true\n---\nImplement increment and decrement in the existing repository. Create exactly one PR for this task.", projectId: project.id, status: "todo" }); sourceId = source.id;
  const dependent = await observer.setup(`/companies/${companyId}/issues`, { title: "Dependent task B",
    description: "---\norchestrator_managed: true\nexecutor: jules\ntarget_files: [B.txt]\n---\nImplement B only after the repaired predecessor merges and the user approves B.",
    projectId: project.id, status: "todo", assigneeAgentId: null, blockedByIssueIds: [sourceId] }); dependentId = dependent.id;
  observer.beginObservation();
  // Explicit user start actor; subsequent observation driver operations remain GET-only.
  const started = await fetch(`${host.url}/api/issues/${source.id}`, { method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "in_progress", assigneeAgentId: publisher.id }) }); assert.ok(started.ok);
  await wait("original native reviews and real base conflict", () => originalCards.size === 2 && baseAdvanced);
  assert.ok((await readFile(path.join(root, "server.log"), "utf8")).includes(`${orchestratorPackage}/dist/index.js`),
    "The daemon must load the exact configured package, including private compiled mutations");
  const originalCardIds = [...originalCards.keys()].sort();
  const readChildren = () => observer.get(`/companies/${companyId}/issues?parentId=${sourceId}&limit=100`);
  if (mode === "manual" || mode === "default" || (mode === "git_only" && shape === "overlap")) {
    const card = await wait("native manual conflict wait", async () => {
      const cards = await observer.get(`/companies/${companyId}/approvals`);
      assert.ok(!cards.some((item) => item.payload?.action === "task_merge" && item.payload.issueId === sourceId),
        "manual_conflict_wait_bypassed_into_merge_gate");
      return cards.find((item) => item.payload?.action === "conflict_resolution" && item.payload.issueId === sourceId);
    });
    assert.equal((await readChildren()).filter((item) => item.description?.startsWith("<!-- paperclip-conflict-repair:v1\n")).length, 0);
    const initialRuns = new Set((await observer.get(`/companies/${companyId}/heartbeat-runs?limit=100`)).map((item) => item.id));
    await wait("three scheduled manual wait ticks", async () => (await observer.get(`/companies/${companyId}/heartbeat-runs?limit=100`))
      .filter((item) => item.agentId === orchestratorId && item.status === "succeeded" && !initialRuns.has(item.id)).length >= 3);
    await wait("idle before manual wait restart", async () => !(await observer.get(`/companies/${companyId}/live-runs?minCount=0&limit=50`)).length);
    await host.stop(); await host.start();
    assert.equal((await observer.get(`/companies/${companyId}/approvals`)).filter((item) => item.payload?.action === "conflict_resolution")[0].id, card.id);
    // Explicit external human repair actor; no Paperclip state/product patch.
    repaired = await github.repairPullRequest(pr.url, { "shared.cjs": "module.exports = { increment: n => n + 1, decrement: n => n - 1, double: n => n * 2 };\n" }); pr = { ...pr, ...repaired }; repairPublishedAt = Date.now();
  }
  const gate = await wait("preserved reviews and resolved-head user merge gate", async () => {
    const children = await readChildren();
    const cards = (await Promise.all(children.map((child) => observer.get(`/issues/${child.id}/interactions`)))).flat();
    const reviewCards = cards.filter((card) => card.payload?.items?.[0]?.id === "pull_request");
    assert.equal(reviewCards.length, 2, "conflict repair must not create additional native review cards");
    assert.deepEqual(reviewCards.map((card) => card.id).sort(), originalCardIds);
    const mergeGate = (await observer.get(`/companies/${companyId}/approvals`))
      .find((card) => card.payload?.action === "task_merge" && card.payload.issueId === sourceId);
    if (!mergeGate) return false;
    // The coordinator can persist repair provenance before synchronizing the
    // product head. Assert the final checkpoint only after its merge gate exists,
    // then read the product so sequential API reads cannot observe an earlier tick.
    const products = await observer.get(`/issues/${sourceId}/work-products`);
    if (mode === "git_only" && shape === "disjoint" && products[0]?.metadata?.conflictRecovery?.phase === "resolved") {
      repaired = { url: pr.url, headSha: products[0].metadata.headSha, baseSha: products[0].metadata.conflictRecovery.baseSha };
      pr = { ...pr, ...repaired };
      repairPublishedAt ??= Date.now();
    }
    assert.ok(repaired, "merge gate must follow a proved conflict repair");
    assert.equal(products[0]?.metadata?.conflictRecovery?.phase, "resolved",
      "merge gate must follow resolved repair provenance");
    assert.equal(products[0].metadata.headSha, repaired.headSha);
    assert.equal(products[0].metadata.conflictRecovery.reviewHeadSha, originalHead);
    return mergeGate;
  });
  assert.equal(gate.status, "pending");
  const nativeRuns = await observer.get(`/companies/${companyId}/heartbeat-runs?limit=100`);
  assert.equal(nativeRuns.filter((item) => reviewIds.includes(item.agentId) && item.startedAt &&
    Date.parse(item.startedAt) > repairPublishedAt).length, 0, "resolution must not start another reviewer run");
  const code = (await run("git", ["--git-dir", path.join(root, "remote.git"), "show", `${repaired.headSha}:shared.cjs`], { cwd: github.repository })).stdout;
  await run(process.execPath, ["-e", code + "\nconst a=require('node:assert/strict'); a.equal(module.exports.increment(8),9); a.equal(module.exports.decrement(8),7);" +
    (shape === "overlap" ? " a.equal(module.exports.double(8),16);" : "")]);
  assert.equal((await observer.get(`/issues/${dependentId}`)).assigneeAgentId, null);
  await wait("idle before pending merge restart", async () => !(await observer.get(`/companies/${companyId}/live-runs?minCount=0&limit=50`)).length);
  await host.stop(); await host.start();
  const retained = (await observer.get(`/companies/${companyId}/approvals`)).find((item) => item.id === gate.id);
  assert.equal(retained.status, "pending");
  assert.equal((await observer.get(`/issues/${sourceId}`)).status, "in_review");
  const approved = await fetch(`${host.url}/api/approvals/${gate.id}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisionNote: "User approves merge with preserved reviews and repair provenance." }) });
  assert.ok(approved.ok);
  const before = new Set((await observer.get(`/companies/${companyId}/heartbeat-runs?limit=100`)).map((item) => item.id));
  await wait("approved gate waits for actual user merge", async () => (await observer.get(`/companies/${companyId}/heartbeat-runs?limit=100`))
    .some((item) => item.agentId === orchestratorId && item.status === "succeeded" && !before.has(item.id)));
  assert.equal((await observer.get(`/issues/${sourceId}`)).status, "in_review");
  const children = await readChildren(); const evidence = [];
  for (const child of children) {
    const cards = await observer.get(`/issues/${child.id}/interactions`);
    for (const card of cards.filter((item) => originalCards.has(item.id))) evidence.push({
      stage: card.addresseeAgentId === reviewIds[0] ? "luna" : "strong", reviewerAgentId: card.addresseeAgentId,
      verdict: card.result.items[0].verdict, cardId: card.id, sourceRunId: card.sourceRunId, resolvedByRunId: card.resolvedByRunId });
  }
  const merged = await github.externalMerge(pr.url, { headSha: repaired.headSha, reviewedHeadSha: originalHead,
    conflictResolution: (await observer.get(`/issues/${sourceId}/work-products`))[0].metadata.conflictRecovery,
    reviews: evidence.sort((left) => left.stage === "luna" ? -1 : 1) });
  await wait("normal remote merge reconciliation", async () => (await observer.get(`/issues/${sourceId}`)).status === "done" &&
    (await observer.get(`/issues/${sourceId}/work-products`))[0].status === "merged");
  const released = await observer.get(`/issues/${dependentId}`);
  assert.equal(released.assigneeAgentId, null, "merge alone cannot bypass the dependent's user start gate");
  assert.deepEqual(released.blockedBy.map((blocker) => [blocker.id, blocker.status]), [[sourceId, "done"]]);
  const startGate = await wait("dependent native start approval", async () => (await observer.get(`/companies/${companyId}/approvals`))
    .find((item) => item.payload?.action === "task_start" && item.payload.issueId === dependentId && item.status === "pending"));
  const startedB = await fetch(`${host.url}/api/approvals/${startGate.id}/approve`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ decisionNote: "User starts the released dependent." }) });
  assert.ok(startedB.ok);
  await wait("normal dispatch of separately approved dependent", async () => dependentSessionId &&
    (await observer.get(`/issues/${dependentId}`)).assigneeAgentId === publisher.id);
  assert.equal(createRequests.filter((item) => item.prompt.includes("Paperclip Issue ID: " + sourceId + ";")).length, 1,
    "repair and restart must retain the original implementation session");
  assert.equal(observer.trace.filter((item) => item.phase === "observing" && item.method !== "GET").length, 0);
  assert.equal((await readFile(path.join(root, "server.log"), "utf8")).includes(`${orchestratorPackage}/dist/index.js`), true);
  assert.equal(repairOperations, mode === "agent" ? 1 : 0);
  if (initialNoPr) {
    assert.equal(requiredPrMessages, 1);
    assert.ok(requiredPrMessage.includes(sourceId));
    console.log("ADAPTER_REQUIRED_PR_RECOVERY_CONFIRMED", JSON.stringify({ sourceId, originalSessionRetained: true, messages: requiredPrMessages }));
  }
  console.log("CONFLICT_RECOVERY_CONFIRMED", JSON.stringify({ version: installation.version, mode, adapter, shape, sourceId, resolverId, originalHead,
    resolvedHead: repaired.headSha, preservedReviewCardIds: originalCardIds, repairOperations, providerCreates: createRequests.length,
    mergeSha: merged.mergeSha, dependentId, dependentSessionId, retainedMergeGateId: gate.id, driverWrites: 0, root }));
} catch (error) {
  console.error("CONFLICT_RECOVERY_DIAGNOSTIC", root);
  if (sourceId) console.error(JSON.stringify({ source: await observer.get(`/issues/${sourceId}`),
    children: await observer.get(`/companies/${companyId}/issues?parentId=${sourceId}&limit=100`),
    runs: await observer.get(`/companies/${companyId}/heartbeat-runs?limit=30`) }));
  throw error;
} finally { await host.stop(); await new Promise((resolve) => provider.close(resolve)); }
