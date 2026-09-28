import assert from "node:assert/strict";
import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { observeJulesChildPlanReview } from "../../../jules/src/server/paperclip-client.ts";
import { executeChildPlanBootstrap } from "../../src/core/child-plan-bootstrap.ts";
import { buildReviewInteractionRequest } from "../../src/core/review-interaction-state.ts";
import { ensurePrReviewChild, activatePrReviewChild,
  observePrReviewChild, inspectPrReviewChildren, parsePrReviewChildDescription,
  prReviewChildKey, prReviewChildApi } from "../../src/core/pr-review-child.ts";
import { createPaperclipHttp } from "../../src/core/paperclip-http.ts";
import { readNativeReviewAssignmentFromRuntime, submitNativeReviewVerdictFromRuntime } from "../../src/core/native-review-submission.ts";
import { submitPlanVerdictAndReturnToJules, readPlanReviewAssignmentAndReconcileHandback } from "../../src/core/native-plan-review-handback.ts";

const env = process.env;
const config = JSON.parse(env.CONTRACT_FIXTURE);
let identity = { version: 3, companyId: config.companyId, parentIssueId: config.issueId,
  sessionId: config.sessionId, activityId: "fixture-plan-activity", documentId: config.documentId,
  revisionId: config.revisionId, revisionNumber: 1, stage: "luna", reviewerAgentId: config.lunaId,
  bootstrapAgentId: config.orchestratorId, julesAgentId: config.julesId };
if (config.julesOwnedBootstrap) identity = { ...identity, version: 4, bootstrapAgentId: config.julesId };
const base = env.PAPERCLIP_API_URL;
assert.equal(new URL(base).hostname, "127.0.0.1");
assert.ok(env.PAPERCLIP_API_KEY);
const headers = { Authorization: `Bearer ${env.PAPERCLIP_API_KEY}`, "X-Paperclip-Run-Id": env.PAPERCLIP_RUN_ID,
  "Content-Type": "application/json" };
const scopedPrApi = () => prReviewChildApi(createPaperclipHttp({
  apiUrl: base, authToken: env.PAPERCLIP_API_KEY, runId: env.PAPERCLIP_RUN_ID, localTrustedBoardWrites: false,
}));
async function request(path, method = "GET", body) {
  const response = await fetch(`${base}/api${path}`, { method, headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000) });
  const data = await response.json();
  if (!response.ok) await event("CHILD_REQUEST_FAILED", { method, path, status: response.status, error: data.error, code: data.code ?? data.details?.code });
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}
async function event(name, data = {}, wait = false) {
  const response = await fetch(`${base}/__contract/events`, { method: "POST", headers,
    body: JSON.stringify({ name, data, wait }), signal: AbortSignal.timeout(90_000) });
  assert.equal(response.status, 200);
}
const run = await request(`/heartbeat-runs/${env.PAPERCLIP_RUN_ID}`);
assert.equal(run.status, "running");
assert.equal(run.agentId, env.PAPERCLIP_AGENT_ID);
const issueId = run.contextSnapshot.issueId;
if (env.PAPERCLIP_AGENT_ID === config.julesId) {
  if (config.julesOwnedBootstrap && issueId !== config.issueId) {
    const child = await request(`/issues/${issueId}`);
    assert.equal(child.parentId, config.issueId);
    assert.equal(child.assigneeAgentId, config.julesId);
    const { execute } = await import("../../../jules/src/server/execute.ts");
    const julesConfig = { repository: "paperclip-contract/fixture", baseBranch: "main", planApprovalPolicy: "required",
      e2eProviderBaseUrl: config.providerBaseUrl };
    const result = await execute({
      runId: env.PAPERCLIP_RUN_ID, authToken: env.PAPERCLIP_API_KEY,
      agent: { id: config.julesId, companyId: config.companyId, name: "Jules child bootstrap", adapterType: "jules", adapterConfig: julesConfig },
      config: { ...julesConfig, env: { JULES_API_KEY: "fixture-provider-token" } },
      runtime: { sessionId: null, sessionParams: null, taskKey: issueId },
      context: { issueId, companyId: config.companyId, task: { id: issueId, title: child.title, description: child.description ?? "" } },
      onLog: async (stream, chunk) => (stream === "stderr" ? process.stderr : process.stdout).write(chunk),
    });
    await event("JULES_OWNED_CHILD_RESULT", { childId: issueId, exitCode: result.exitCode, errorCode: result.errorCode ?? null });
    assert.equal(result.exitCode, 0, JSON.stringify({ errorCode: result.errorCode, errorMessage: result.errorMessage }));
    process.exit(0);
  }
  const parent = await request(`/issues/${issueId}`);
  assert.equal(parent.assigneeAgentId, config.julesId);
  if (config.julesParentExecutor) {
    const { execute } = await import("../../../jules/src/server/execute.ts");
    const { sessionCodec } = await import("../../../jules/src/server/session.ts");
    const { loadStoredSession } = await import("../../../jules/src/server/session-store.ts");
    const source = "sources/github/paperclip-contract/fixture";
    const prior = await loadStoredSession(issueId, source, "main");
    assert.ok(prior || config.createProviderSession,
      "parent Jules session must remain durable across plan-review child restarts");
    const julesConfig = { repository: "paperclip-contract/fixture", baseBranch: "main", planApprovalPolicy: "required",
      planReviewerAgentId: config.lunaId, planStrongReviewerAgentId: config.terraId,
      planReviewBootstrapMode: "jules_v4", e2eProviderBaseUrl: config.providerBaseUrl };
    const result = await execute({
      runId: env.PAPERCLIP_RUN_ID, authToken: env.PAPERCLIP_API_KEY,
      agent: { id: config.julesId, companyId: config.companyId, name: "Jules parent executor", adapterType: "jules", adapterConfig: julesConfig },
      config: { ...julesConfig, env: { JULES_API_KEY: "fixture-provider-token", PATH: config.githubPath } },
      runtime: { sessionId: prior ? config.sessionId : null,
        sessionParams: prior ? sessionCodec.encode(prior) : null, taskKey: issueId },
      context: { issueId, companyId: config.companyId, task: { id: issueId, title: parent.title, description: parent.description ?? "" } },
      onLog: async (stream, chunk) => (stream === "stderr" ? process.stderr : process.stdout).write(chunk),
    });
    const saved = await loadStoredSession(issueId, source, "main");
    if (saved?.childPlanReview?.childId) {
      await writeFile(config.checkpointPath, JSON.stringify({ childId: saved.childPlanReview.childId,
        sessionId: config.sessionId, identity: saved.childPlanReview.identity }), { mode: 0o600 });
    }
    const previousStage = prior?.childPlanReview?.identity.stage;
    if (previousStage && (saved?.childPlanReview?.identity.stage !== previousStage || !saved?.childPlanReview)) {
      await event("PARENT_CONSUMED_CHILD_VERDICT", { stage: previousStage, sessionId: config.sessionId });
    }
    await event("REAL_JULES_PARENT_RESULT", { exitCode: result.exitCode,
      errorCode: result.errorCode ?? null, stage: saved?.childPlanReview?.identity.stage ?? null });
    assert.equal(result.exitCode, 0, JSON.stringify({ errorCode: result.errorCode, errorMessage: result.errorMessage }));
    process.exit(0);
  }
  if (config.realJulesExecutor && run.contextSnapshot.contractPrChildActivate) {
    const child = await request(`/issues/${config.prReviewChildId}`);
    const [card] = await request(`/issues/${config.prReviewChildId}/interactions`);
    assert.equal(child.parentId, issueId);
    assert.equal(child.status, "backlog");
    assert.equal(card.status, "pending");
    assert.equal(card.addresseeAgentId, config.lunaId);
    const assigned = await request(`/issues/${config.prReviewChildId}`, "PATCH", {
      status: "todo", assigneeAgentId: config.lunaId,
    });
    assert.equal(assigned.assigneeAgentId, config.lunaId);
    await event("PR_CHILD_ACTIVATED_BY_PARENT", { childId: child.id, cardId: card.id });
    process.exit(0);
  }
  if (run.contextSnapshot.contractJulesExecute && config.realJulesExecutor) {
    const { execute } = await import("../../../jules/src/server/execute.ts");
    const { sessionCodec } = await import("../../../jules/src/server/session.ts");
    const stale = JSON.parse(await readFile(config.staleSessionPath, "utf8"));
    const julesConfig = { repository: stale.repository, source: stale.source, baseBranch: stale.baseBranch,
      planApprovalPolicy: "required", planReviewerAgentId: config.lunaId,
      planStrongReviewerAgentId: config.terraId, e2eProviderBaseUrl: config.providerBaseUrl };
    const result = await execute({
      runId: env.PAPERCLIP_RUN_ID, authToken: env.PAPERCLIP_API_KEY,
      agent: { id: config.julesId, companyId: config.companyId, name: "Jules executor contract", adapterType: "jules", adapterConfig: julesConfig },
      config: { ...julesConfig, env: { JULES_API_KEY: "fixture-provider-token", PATH: config.githubPath } },
      runtime: { sessionId: config.sessionId, sessionParams: sessionCodec.encode(stale), taskKey: issueId },
      context: { issueId, companyId: config.companyId, task: { id: issueId, title: parent.title, description: parent.description ?? "" } },
      onLog: async (stream, chunk) => (stream === "stderr" ? process.stderr : process.stdout).write(chunk),
    });
    await event("REAL_JULES_EXECUTOR_RESULT", { exitCode: result.exitCode, errorCode: result.errorCode ?? null,
      issueStatus: result.resultJson?.issueStatus ?? null, clearSession: result.clearSession ?? false });
    assert.equal(result.exitCode, 0, JSON.stringify({ errorCode: result.errorCode, errorMessage: result.errorMessage }));
    process.exit(0);
  }
  let checkpoint;
  try { checkpoint = JSON.parse(await readFile(config.checkpointPath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (checkpoint?.identity) identity = checkpoint.identity;
  const observation = await observeJulesChildPlanReview(identity, checkpoint?.childId, env.PAPERCLIP_API_KEY, env.PAPERCLIP_RUN_ID);
  await writeFile(config.checkpointPath, JSON.stringify({ childId: observation.childId, sessionId: config.sessionId, identity }), { mode: 0o600 });
  await event("CHILD_CHECKPOINTED", { childId: observation.childId });
  if (observation.kind === "answered") {
    assert.equal(checkpoint.sessionId, config.sessionId);
    await event("PARENT_CONSUMED_CHILD_VERDICT", { ...observation, stage: identity.stage, sessionId: checkpoint.sessionId });
    if (config.childReviewLadder && identity.stage === "luna") {
      identity = { ...identity, stage: "terra", reviewerAgentId: config.terraId };
      await writeFile(config.checkpointPath, JSON.stringify({ sessionId: config.sessionId, identity }), { mode: 0o600 });
    }
  }
  if (observation.kind === "waiting" || (config.childReviewLadder && observation.kind === "answered" && identity.stage === "terra" && checkpoint.identity?.stage !== "terra")) {
    const child = await request(`/issues/${observation.childId}`);
    if ([config.lunaId, config.terraId].includes(child.assigneeAgentId)) await event("CHILD_ASSIGNED_TO_REVIEWER", { childId: child.id });
    await request(`/issues/${issueId}`, "PATCH", { executionPolicy: { mode: "normal", stages: [], commentRequired: false,
      monitor: { kind: "external_service", serviceName: "jules", externalRef: config.sessionId,
        scheduledBy: "assignee", nextCheckAt: new Date(Date.now() + 60_000).toISOString(),
        timeoutAt: new Date(Date.now() + 300_000).toISOString(), recoveryPolicy: "wake_owner" } } });
    await event("PARENT_MONITOR_ARMED");
  }
} else if (env.PAPERCLIP_AGENT_ID === config.orchestratorId) {
  const inspectPrLadder = async () => {
    const inspected = await inspectPrReviewChildren({ companyId: config.companyId, parentIssueId: config.issueId,
      prUrl: config.prUrl, headSha: config.prHeadSha, bootstrapAgentId: config.orchestratorId,
      lunaAgentId: config.lunaId, strongAgentId: config.terraId, api: scopedPrApi() });
    await event("PR_MIGRATION_LADDER_INSPECTED", { kind: inspected.kind, projections: inspected.projections.length });
    return inspected;
  };
  if (config.prMigrationProbe && run.contextSnapshot.contractPrMigrationInspect) {
    const inspected = await inspectPrLadder();
    if (config.prStrongGemini) assert.ok(["approved", "rejected"].includes(inspected.kind));
    else assert.equal(inspected.kind, config.prStrongReject ? "rejected" : "approved");
    process.exit(0);
  }
  let activationChildId = run.contextSnapshot.contractPrMigrationActivateChildId;
  if (config.prMigrationProbe && issueId === config.maintenanceIssueId && !run.contextSnapshot.contractPrMigrationProbe &&
      !activationChildId) {
    const candidates = (await request(`/companies/${config.companyId}/issues?limit=1000&parentId=${config.issueId}`))
      .filter((candidate) => candidate.createdByAgentId === config.orchestratorId &&
        candidate.assigneeAgentId === config.orchestratorId && candidate.status === "backlog" &&
        parsePrReviewChildDescription(candidate.description)?.prUrl === config.prUrl &&
        parsePrReviewChildDescription(candidate.description)?.headSha === config.prHeadSha);
    assert.ok(candidates.length <= 1, "two matching PR review children are ambiguous");
    for (const candidate of candidates) {
      const cards = await request(`/issues/${candidate.id}/interactions`);
      if (cards.length === 1 && cards[0].status === "pending") activationChildId = candidate.id;
    }
    if (!activationChildId) {
      const allChildren = await request(`/companies/${config.companyId}/issues?limit=1000&parentId=${config.issueId}`);
      const strongChild = allChildren.find((candidate) => candidate.createdByAgentId === config.orchestratorId &&
        parsePrReviewChildDescription(candidate.description)?.stage === "strong");
      const strongCards = strongChild ? await request(`/issues/${strongChild.id}/interactions`) : [];
      if (strongCards.length === 1 && strongCards[0].status === "answered") {
        const inspected = await inspectPrLadder();
        if (config.prStrongGemini) assert.ok(["approved", "rejected"].includes(inspected.kind));
        else assert.equal(inspected.kind, config.prStrongReject ? "rejected" : "approved");
        process.exit(0);
      }
      const lunaChild = allChildren.find((candidate) => candidate.createdByAgentId === config.orchestratorId &&
        parsePrReviewChildDescription(candidate.description)?.stage === "luna");
      const lunaCards = lunaChild ? await request(`/issues/${lunaChild.id}/interactions`) : [];
      if (lunaCards.length === 1 && lunaCards[0].status === "answered" && lunaCards[0].result?.items?.[0]?.verdict === "approve") {
        run.contextSnapshot.contractPrMigrationProbe = "strong";
      } else {
        await event("PR_MIGRATION_AWAIT_CHILD_BOOTSTRAP");
        process.exit(0);
      }
    }
  }
  if (config.prMigrationProbe && typeof activationChildId === "string") {
    const childId = activationChildId;
    const child = await request(`/issues/${childId}`);
    const identity = parsePrReviewChildDescription(child.description);
    assert.ok(identity);
    const action = await activatePrReviewChild({ identity, childId, api: scopedPrApi() });
    await event("PR_MIGRATION_CHILD_ACTIVATED", { childId, action });
    process.exit(0);
  }
  if (config.prMigrationProbe && run.contextSnapshot.contractPrMigrationProbe) {
    const api = scopedPrApi();
    const previous = (await request(`/companies/${config.companyId}/issues?limit=1000&parentId=${config.issueId}`))
      .filter((candidate) => candidate.createdByAgentId === config.orchestratorId &&
        parsePrReviewChildDescription(candidate.description)?.stage === "luna");
    assert.ok(previous.length <= 1);
    if (previous[0]) {
      const lunaIdentity = parsePrReviewChildDescription(previous[0].description);
      assert.ok(lunaIdentity);
      const verdict = await observePrReviewChild({ identity: lunaIdentity, childId: previous[0].id, api });
      assert.equal(verdict.kind, "answered");
      assert.equal(verdict.verdict, "approve");
    }
    const stage = previous.length ? "strong" : "luna";
    const identity = { version: 1, companyId: config.companyId, parentIssueId: config.issueId,
      prUrl: config.prUrl, headSha: config.prHeadSha, stage,
      reviewerAgentId: stage === "strong" ? config.terraId : config.lunaId, bootstrapAgentId: config.orchestratorId };
    const childId = await ensurePrReviewChild({ identity, api });
    const created = await request(`/issues/${childId}`);
    assert.equal(created.parentId, config.issueId);
    assert.equal(created.createdByAgentId, config.orchestratorId);
    assert.equal(prReviewChildKey(parsePrReviewChildDescription(created.description)), prReviewChildKey(identity));
    await event("PR_MIGRATION_CHILD_CREATED", { childId: created.id, parentId: created.parentId });
    process.exit(0);
  }
  const child = await request(`/issues/${issueId}`);
  assert.equal(child.parentId, config.issueId);
  assert.equal(child.assigneeAgentId, config.orchestratorId);
  if (config.prMigrationProbe && run.contextSnapshot.contractPrMigrationActivate) {
    assert.equal(child.status, "backlog");
    const [card] = await request(`/issues/${issueId}/interactions`);
    assert.equal(card.status, "pending");
    assert.equal(card.addresseeAgentId, config.lunaId);
    const source = await request(`/heartbeat-runs/${card.sourceRunId}`);
    assert.equal(source.status, "succeeded");
    assert.equal(source.contextSnapshot.issueId, issueId);
    const assigned = await request(`/issues/${issueId}`, "PATCH", { status: "todo", assigneeAgentId: config.lunaId });
    assert.equal(assigned.assigneeAgentId, config.lunaId);
    await event("PR_MIGRATION_CHILD_ACTIVATED", { childId: issueId, cardId: card.id });
    process.exit(0);
  }
  if (config.prMigrationProbe && (run.contextSnapshot.contractPrMigrationBootstrap ||
      (config.prBoardProbe && parsePrReviewChildDescription(child.description)?.version === 2))) {
    const descriptor = parsePrReviewChildDescription(child.description);
    assert.ok(descriptor);
    const { executeAllProjects } = await import("../../src/server/execute.ts");
    const result = await executeAllProjects({
      runId: env.PAPERCLIP_RUN_ID, authToken: env.PAPERCLIP_API_KEY,
      agent: { id: config.orchestratorId, companyId: config.companyId, name: "PR child bootstrap", adapterType: "process",
        adapterConfig: { apiUrl: base } },
      config: { apiUrl: base }, runtime: { sessionId: null, sessionParams: null, taskKey: issueId },
      context: { issueId, companyId: config.companyId, task: { id: issueId, title: child.title, description: child.description } },
      onLog: async (stream, chunk) => (stream === "stderr" ? process.stderr : process.stdout).write(chunk),
    });
    await event("PR_MIGRATION_PRODUCTION_BOOTSTRAP", { childId: issueId, exitCode: result.exitCode,
      errorCode: result.errorCode ?? null, errorMessage: result.errorMessage ?? null });
    assert.equal(result.exitCode, 0, result.errorMessage ?? "PR child adapter bootstrap failed");
    process.exit(0);
  }
  if (config.realJulesExecutor && issueId === config.prReviewChildId) {
    const card = await request(`/issues/${issueId}/interactions`, "POST", buildReviewInteractionRequest({
      issueId, prUrl: config.prUrl, headSha: config.prHeadSha, stage: "luna", reviewerAgentId: config.lunaId,
    }));
    assert.equal(card.status, "pending");
    await event("PR_CHILD_CARD_CHECKPOINTED", { childId: issueId, cardId: card.id });
    const parked = await request(`/issues/${issueId}`, "PATCH", { status: "backlog" });
    assert.equal(parked.assigneeAgentId, config.orchestratorId);
    await event("PR_CHILD_PARKED", { childId: issueId, cardId: card.id });
    process.exit(0);
  }
  const receipt = await executeChildPlanBootstrap({ apiBase: base, issueId, description: child.description,
    agentId: env.PAPERCLIP_AGENT_ID, runId: env.PAPERCLIP_RUN_ID, token: env.PAPERCLIP_API_KEY });
  assert.ok(receipt);
  await event("CHILD_CARD_CHECKPOINTED", { childId: issueId, cardId: receipt.cardId, sourceRunId: env.PAPERCLIP_RUN_ID });
  await event("CHILD_BOOTSTRAP_FINISHED", { childId: issueId });
} else if ([config.lunaId, config.terraId].includes(env.PAPERCLIP_AGENT_ID)) {
  const child = await request(`/issues/${issueId}`);
  assert.equal(child.parentId, config.issueId);
  assert.equal(child.assigneeAgentId, env.PAPERCLIP_AGENT_ID);
  if (config.prMigrationProbe) {
    const [card] = await request(`/issues/${issueId}/interactions`);
    if (card?.payload?.items?.[0]?.id === "pull_request") {
      if (config.prStrongFirstTurnFailure && env.PAPERCLIP_AGENT_ID === config.terraId && card.status === "pending") {
        let attempted = false;
        try { await readFile(config.prStrongRetryMarker, "utf8"); attempted = true; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        if (!attempted) {
          await writeFile(config.prStrongRetryMarker, "strong reviewer failed before a typed decision", { flag: "wx", mode: 0o600 });
          await event("PR_STRONG_REVIEWER_FIRST_INIT_FAILED", { childId: issueId, cardId: card.id });
          throw new Error("fixture_strong_review_transport_init_failed_before_model_turn");
        }
      }
      if (config.prStrongGemini && env.PAPERCLIP_AGENT_ID === config.terraId && card.status === "pending") {
        const { execute } = await import("../../../antigravity/src/server/index.ts");
        const adapterConfig = {
          model: "gemini-3.8-flash-low", serverPath: config.geminiServerPath,
          permissionMode: "read-only", nativeReview: true, cwd: process.cwd(), timeoutSec: 180,
          reviewMcpCommand: process.execPath,
          reviewMcpArgs: [fileURLToPath(new URL("../../dist/server/native-review-mcp-stdio.js", import.meta.url))],
          promptTemplate: `You are the addressed read-only strong PR reviewer. Call paperclip_review.get_current_native_review_assignment first. Review the exact PR URL and immutable head SHA in its native card against the parent task contract. Then call paperclip_review.submit_native_review_verdict exactly once with approve or reject and an actionable reason on reject. The typed Paperclip verdict is the only decision; never submit a GitHub-thread review, ordinary issue comment or status/assignment PATCH.`,
        };
        const projectTools = http.createServer(async (request, response) => {
          if (request.method !== "POST" || request.url !== "/mcp") { response.writeHead(404).end(); return; }
          try {
            let body = "";
            for await (const chunk of request) body += chunk;
            const message = JSON.parse(body);
            if (message.id === undefined) { response.writeHead(202).end(); return; }
            const result = message.method === "initialize"
              ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "project-tools-contract", version: "1.0" } }
              : message.method === "tools/list" ? { tools: [] } : null;
            response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result
              ? { jsonrpc: "2.0", id: message.id, result }
              : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }));
          } catch { response.writeHead(400).end(); }
        });
        await new Promise((resolve, reject) => {
          projectTools.once("error", reject);
          projectTools.listen(0, "127.0.0.1", resolve);
        });
        const address = projectTools.address();
        assert.ok(address && typeof address !== "string");
        let result;
        try { result = await execute({
          runId: env.PAPERCLIP_RUN_ID, authToken: env.PAPERCLIP_API_KEY,
          agent: { id: config.terraId, companyId: config.companyId, name: "Gemini Strong PR Reviewer",
            adapterType: "antigravity", adapterConfig },
          runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: issueId },
          config: adapterConfig,
          runtimeMcp: { getServers: () => [{ name: "Paperclip projects", url: `http://127.0.0.1:${address.port}/mcp`,
            token: env.PAPERCLIP_API_KEY, connectionId: "paperclip-project-tools" }] },
          context: { issueId, taskId: issueId, task: { id: issueId, title: child.title, description: child.description },
            paperclipTaskMarkdown: `Review the one addressed native PR card on child ${issueId}. Inspect PR ${config.prUrl} at ${config.prHeadSha} and issue ${config.issueId}; return your typed decision via paperclip_review.` },
          onLog: async (stream, chunk) => (stream === "stderr" ? process.stderr : process.stdout).write(chunk),
        }); } finally {
          projectTools.closeAllConnections();
          await new Promise((resolve) => projectTools.close(resolve));
        }
        await event("PR_MIGRATION_GEMINI_MODEL_RESULT", { childId: issueId, exitCode: result.exitCode,
          errorCode: result.errorCode ?? null });
        const [answered] = await request(`/issues/${issueId}/interactions`);
        assert.equal(answered.status, "answered", "Gemini must resolve its own addressed typed PR card");
        assert.ok(["approve", "reject"].includes(answered.result?.items?.[0]?.verdict));
        assert.equal(result.exitCode, 0, JSON.stringify({ errorCode: result.errorCode, errorMessage: result.errorMessage }));
        await event("PR_MIGRATION_VERDICT_WRITTEN", { childId: issueId, cardId: card.id });
        process.exit(0);
      }
      const expectedVerdict = config.prStrongReject && env.PAPERCLIP_AGENT_ID === config.terraId ? "reject" : "approve";
      if (card.status === "answered") {
        assert.equal(card.resolvedByAgentId, env.PAPERCLIP_AGENT_ID);
        assert.equal(card.result.items[0].verdict, expectedVerdict);
        await event("PR_MIGRATION_ALREADY_ANSWERED", { cardId: card.id });
        process.exit(0);
      }
      const runtime = { apiBase: base, issueId, agentId: env.PAPERCLIP_AGENT_ID,
        token: env.PAPERCLIP_API_KEY, runId: env.PAPERCLIP_RUN_ID };
      const assignment = await readNativeReviewAssignmentFromRuntime(runtime);
      assert.equal(assignment.ok, true, JSON.stringify(assignment));
      assert.equal(assignment.assignment.kind, "pull_request");
      assert.equal(assignment.assignment.prUrl, config.prUrl);
      assert.equal(assignment.assignment.headSha, config.prHeadSha);
      const result = await submitNativeReviewVerdictFromRuntime({ ...runtime,
        interactionId: assignment.assignment.interactionId, verdict: expectedVerdict,
        ...(expectedVerdict === "reject" ? { reason: "The strong review found a missing boundary-case test." } : {}) });
      assert.equal(result.ok, true, JSON.stringify(result));
      await event("PR_MIGRATION_VERDICT_WRITTEN", { childId: issueId, cardId: result.interactionId });
      process.exit(0);
    }
  }
  if (config.realJulesExecutor && issueId === config.prReviewChildId) {
    const [card] = await request(`/issues/${issueId}/interactions`);
    if (card?.status === "answered") {
      assert.equal(card.resolvedByAgentId, config.lunaId);
      assert.equal(card.result?.items?.[0]?.verdict, "approve");
      await event("PR_CHILD_ALREADY_ANSWERED", { childId: issueId, cardId: card.id });
      process.exit(0);
    }
    const runtime = { apiBase: base, issueId, agentId: env.PAPERCLIP_AGENT_ID,
      token: env.PAPERCLIP_API_KEY, runId: env.PAPERCLIP_RUN_ID };
    const assignment = await readNativeReviewAssignmentFromRuntime(runtime);
    assert.equal(assignment.ok, true, JSON.stringify(assignment));
    assert.equal(assignment.assignment.kind, "pull_request");
    assert.equal(assignment.assignment.prUrl, config.prUrl);
    assert.equal(assignment.assignment.headSha, config.prHeadSha);
    const result = await submitNativeReviewVerdictFromRuntime({ ...runtime, verdict: "approve",
      interactionId: assignment.assignment.interactionId });
    assert.equal(result.ok, true, JSON.stringify(result));
    await event("PR_CHILD_VERDICT_WRITTEN", { childId: issueId, cardId: result.interactionId });
    process.exit(0);
  }
  const cards = await request(`/issues/${issueId}/interactions`);
  assert.equal(cards.length, 1);
  const card = cards[0];
  assert.equal(card.payload.target.issueId, config.issueId);
  const parentPlan = await request(`/issues/${config.issueId}/documents/plan`);
  assert.equal(parentPlan.latestRevisionId, card.payload.target.revisionId);
  if (config.geminiReviewer && env.PAPERCLIP_AGENT_ID === config.lunaId) {
    assert.equal(card.status, "pending");
    if (config.geminiFirstInitFailure) {
      let attempted = false;
      try { await readFile(config.geminiRetryMarker, "utf8"); attempted = true; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (!attempted) {
        await writeFile(config.geminiRetryMarker, "failed before model turn", { flag: "wx", mode: 0o600 });
        await event("GEMINI_FIRST_INIT_FAILED", { childId: issueId, cardId: card.id });
        throw new Error("fixture_acp_session_init_failed_before_model_turn");
      }
    }
    const { execute } = await import("../../../antigravity/src/server/index.ts");
    const adapterConfig = {
      model: "gemini-3.8-flash-low", serverPath: config.geminiServerPath, permissionMode: "read-only", nativeReview: true,
      reviewMcpCommand: process.execPath,
      reviewMcpArgs: [fileURLToPath(new URL("../../dist/server/native-review-mcp-stdio.js", import.meta.url))],
      cwd: process.cwd(), timeoutSec: 180,
      promptTemplate: `You are the addressed, read-only plan reviewer. First call paperclip_review.get_current_native_review_assignment with no arguments. Inspect the parent plan revision and then call paperclip_review.submit_native_review_verdict exactly once, choosing approve or reject with a concrete reason. The structured Paperclip verdict is the only decision; do not post comments, edit files, or answer with free text instead of the tool.`,
    };
    const projectTools = http.createServer(async (request, response) => {
      if (request.method !== "POST" || request.url !== "/mcp") { response.writeHead(404).end(); return; }
      try {
        let body = "";
        for await (const chunk of request) body += chunk;
        const message = JSON.parse(body);
        if (message.id === undefined) { response.writeHead(202).end(); return; }
        const result = message.method === "initialize"
          ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "project-tools-contract", version: "1.0" } }
          : message.method === "tools/list" ? { tools: [] } : null;
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result
          ? { jsonrpc: "2.0", id: message.id, result }
          : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }));
      } catch { response.writeHead(400).end(); }
    });
    await new Promise((resolve, reject) => {
      projectTools.once("error", reject);
      projectTools.listen(0, "127.0.0.1", resolve);
    });
    const address = projectTools.address();
    assert.ok(address && typeof address !== "string");
    await event("GEMINI_MODEL_RUN_STARTED", { childId: issueId, model: adapterConfig.model });
    let result;
    try { result = await execute({
      runId: env.PAPERCLIP_RUN_ID, authToken: env.PAPERCLIP_API_KEY,
      agent: { id: config.lunaId, companyId: config.companyId, name: "Gemini Strong Reviewer", adapterType: "antigravity", adapterConfig },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: issueId },
      config: adapterConfig,
      runtimeMcp: { getServers: () => [{ name: "Paperclip projects", url: `http://127.0.0.1:${address.port}/mcp`,
        token: env.PAPERCLIP_API_KEY, connectionId: "paperclip-project-tools" }] },
      context: { issueId, taskId: issueId, task: { id: issueId, title: child.title, description: child.description },
        paperclipTaskMarkdown: `Review the one addressed native Paperclip plan card on child issue ${issueId}. Obtain the assignment and submit the typed verdict through paperclip_review.` },
      onLog: async (stream, chunk) => { (stream === "stderr" ? process.stderr : process.stdout).write(chunk); },
    }); } finally {
      projectTools.closeAllConnections();
      await new Promise((resolve) => projectTools.close(resolve));
    }
    await event("GEMINI_MODEL_RESULT", { childId: issueId, exitCode: result.exitCode, errorCode: result.errorCode ?? null });
    const [answered] = await request(`/issues/${issueId}/interactions`);
    assert.equal(answered?.status, "answered", "Gemini must resolve the addressed typed card");
    assert.ok(["approve", "reject"].includes(answered.result?.items?.[0]?.verdict));
    await event("CHILD_VERDICT_WRITTEN", { childId: issueId, cardId: answered.id, sourceRunId: answered.sourceRunId }, true);
  } else if (card.status === "pending") {
    const assignment = await readPlanReviewAssignmentAndReconcileHandback({ apiBase: base, issueId, agentId: env.PAPERCLIP_AGENT_ID,
      runId: env.PAPERCLIP_RUN_ID, token: env.PAPERCLIP_API_KEY });
    assert.equal(assignment.ok, true, JSON.stringify(assignment));
    assert.equal(assignment.assignment.kind, "plan");
    assert.equal(assignment.assignment.target.issueId, config.issueId);
    assert.ok(assignment.assignment.detailsMarkdown.includes("Contract plan"));
    const result = await submitPlanVerdictAndReturnToJules({ apiBase: base, issueId, agentId: env.PAPERCLIP_AGENT_ID,
      runId: env.PAPERCLIP_RUN_ID, token: env.PAPERCLIP_API_KEY, verdict: config.childReviewVerdict,
      ...(config.childReviewVerdict === "reject" ? { reason: "Add boundary-case verification." } : {}) });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.planReviewProtocol, config.julesOwnedBootstrap ? "child_v4" : "child_v3");
    await event("CHILD_VERDICT_WRITTEN", { childId: issueId, cardId: card.id, sourceRunId: card.sourceRunId }, true);
  } else {
    const result = await readPlanReviewAssignmentAndReconcileHandback({ apiBase: base, issueId, agentId: env.PAPERCLIP_AGENT_ID,
      runId: env.PAPERCLIP_RUN_ID, token: env.PAPERCLIP_API_KEY });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.assignment.kind, "plan_review_recorded");
    await event("CHILD_REVIEW_ALREADY_ANSWERED", { cardId: card.id });
  }
} else throw new Error("Unexpected child review worker");
await request(`/issues/${issueId}/comments`, "POST", {
  body: "Stable-ownership contract observation recorded. Review decisions are recorded only on the native typed card.",
});
