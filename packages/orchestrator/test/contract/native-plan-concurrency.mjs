/** Opt-in installed-host contract test. Run with pnpm exec tsx; never connects to the live API. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { nativePlanReviewStageId } from "@pilleo/paperclip-adapter-common";

const require = createRequire(import.meta.url);
const scenarios = ["baseline", "active_before_read", "queued_before_read", "starts_after_read", "queued_after_read", "overlapping", "lost_response"];
const scenario = process.argv.find((arg) => arg.startsWith("--scenario="))?.split("=")[1];
const output = path.resolve(process.env.CONTRACT_REPORT_DIR ?? await mkdtemp(path.join(tmpdir(), "paperclip-handback-results-")));
class ObservationTimeout extends Error {
  constructor(label) { super(`Timed out waiting for ${label}`); this.label = label; }
}
await mkdir(output, { recursive: true });
if (!scenario) {
  const results = [];
  const selectedScenarios = process.argv.includes("--stable-child") ? ["stable_child", "stable_child_reject", "stable_child_ladder", "stable_child_executor"] : scenarios;
  for (const name of selectedScenarios) {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", require.resolve("tsx"), fileURLToPath(import.meta.url), `--scenario=${name}`], {
        env: { ...process.env, CONTRACT_REPORT_DIR: output }, stdio: "inherit",
      });
      child.once("error", reject);
      child.once("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
    });
    results.push(JSON.parse(await readFile(path.join(output, `${name}.json`), "utf8")));
    if (code !== 0) process.exitCode = 1;
  }
  const integrationAllowed = results.every((result) => result.result === "observed" && result.safetyGate === "pass");
  const summary = { version: "2026.916.0", integrationAllowed,
    scenarios: results.map(({ scenario, result, outcome, error, safetyGate }) => ({ scenario, result, outcome, error, safetyGate })) };
  await writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2));
  console.log("CONTRACT_SUMMARY", JSON.stringify(summary));
  console.log(`Contract reports: ${output}`);
  if (results.some((result) => result.result !== "observed")) process.exitCode = 1;
  else if (process.argv.includes("--require-safe") && !integrationAllowed) process.exitCode = 2;
} else {
  assert.ok([...scenarios, "stable_child", "stable_child_ladder", "stable_child_reject", "stable_child_executor", "stable_child_gemini", "stable_child_gemini_retry"].includes(scenario), `Unknown scenario ${scenario}`);
  await runScenario();
}

async function runScenario() {
  const home = await mkdtemp(path.join(tmpdir(), "paperclip-plan-race-"));
  const install = path.resolve(process.env.PAPERCLIP_CONTRACT_NODE_MODULES ?? path.join(homedir(), ".paperclip/cli/current/node_modules"));
  // These overrides are process-local and precede all installed-host imports.
  process.env.PAPERCLIP_HOME = home;
  process.env.PAPERCLIP_INSTANCE_ID = "contract";
  process.env.PAPERCLIP_AGENT_JWT_SECRET = randomBytes(32).toString("hex");
  process.env.PAPERCLIP_AGENT_JWT_DISABLE_LEGACY_FALLBACK = "true";
  delete process.env.PAPERCLIP_CONFIG;
  delete process.env.DATABASE_URL;
  const report = { scenario, result: "incomplete", outcome: null, version: null, events: [], mutations: [], observations: [] };
  let db, pg, heartbeat, listener, failureSnapshot;
  const pending = new Map();
  const released = new Set();
  let closing = false;
  let activeMutations = 0;
  const events = report.events;
  const record = (name, data = {}) => events.push({ sequence: events.length + 1, at: new Date().toISOString(), name, ...data });
  const release = (name) => {
    released.add(name);
    for (const [key, entry] of pending) if (entry.name === name) {
      entry.response.json({ ok: true }); pending.delete(key);
    }
  };
  async function until(label, probe, timeout = 30_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await probe();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new ObservationTimeout(label);
  }
    const waitEvent = (name, after = 0, timeout = 30_000) => until(name, () => events.find((event) => event.name === name && event.sequence > after), timeout);
  try {
    const hostRequire = createRequire(path.join(install, "@paperclipai/server/package.json"));
    const version = hostRequire("./package.json").version;
    report.version = version;
    assert.equal(version, "2026.916.0", "This is a version-pinned contract; qualify other host versions separately");
    const load = (name) => import(pathToFileURL(path.join(install, name)).href);
    const express = hostRequire("express");
    const { eq } = await load("drizzle-orm/index.js");
    const schema = await load("@paperclipai/db/dist/index.js");
    const { agents, authUsers, companies, companyMemberships, issues, documents, documentRevisions, issueDocuments,
      heartbeatRuns, issueThreadInteractions, agentWakeupRequests, issueRecoveryActions } = schema;
    const { issueRoutes } = await load("@paperclipai/server/dist/routes/issues.js");
    const { agentRoutes } = await load("@paperclipai/server/dist/routes/agents.js");
    const { activityRoutes } = await load("@paperclipai/server/dist/routes/activity.js");
    const { actorMiddleware } = await load("@paperclipai/server/dist/middleware/auth.js");
    const { errorHandler } = await load("@paperclipai/server/dist/middleware/index.js");
    const { heartbeatService } = await load("@paperclipai/server/dist/services/heartbeat.js");
    const { deliverReconciledExecutions } = await load("@paperclipai/server/dist/services/execution-recovery-resolution.js");
    pg = await schema.startEmbeddedPostgresTestDatabase("plan-reconciliation-contract-");
    db = schema.createDb(pg.connectionString);
    heartbeat = heartbeatService(db);
    const config = Object.fromEntries(["companyId", "userId", "managerId", "orchestratorId", "julesId", "lunaId", "terraId", "issueId",
      "maintenanceIssueId", "blockerIssueId", "documentId", "revisionId", "sessionId"].map((key) => [key, randomUUID()]));
    config.stageId = nativePlanReviewStageId(config.issueId, config.revisionId, "luna");
    config.checkpointPath = path.join(home, "child-review-checkpoint.json");
    config.childReviewLadder = scenario === "stable_child_ladder" || scenario === "stable_child_executor";
    config.realJulesExecutor = scenario === "stable_child_executor";
    if (config.realJulesExecutor) {
      config.prReviewChildId = randomUUID();
      config.staleSessionPath = path.join(home, "jules-stale-session.json");
      config.sessionStoreDir = path.join(home, "jules-sessions");
      config.providerBaseUrl = "pending-listener";
      config.prUrl = "https://github.com/paperclip-contract/fixture/pull/7";
      config.prHeadSha = "1".repeat(40);
      const bin = path.join(home, "bin");
      await mkdir(bin);
      const ghPath = path.join(bin, "gh");
      await writeFile(ghPath, `#!/bin/sh\ncase "$1 $2" in\n  "pr view") printf '%s\\n' '{"state":"OPEN","mergedAt":null,"mergeable":"MERGEABLE","headRefOid":"${config.prHeadSha}","headRefName":"contract-head"}' ;;\n  "pr checks") printf '%s\\n' '[{"bucket":"pass","state":"SUCCESS","name":"contract"}]' ;;\n  "pr diff") printf '%s\\n' 'src/contract.ts' ;;\n  *) exit 1 ;;\nesac\n`);
      await chmod(ghPath, 0o700);
      config.githubPath = `${bin}:${process.env.PATH}`;
    }
    config.childReviewVerdict = scenario === "stable_child_reject" ? "reject" : "approve";
    config.geminiReviewer = scenario === "stable_child_gemini" || scenario === "stable_child_gemini_retry";
    config.geminiFirstInitFailure = scenario === "stable_child_gemini_retry";
    config.geminiRetryMarker = path.join(home, "gemini-first-init-failed");
    if (config.geminiReviewer || config.prStrongGemini) {
      config.geminiServerPath = process.env.PAPERCLIP_GEMINI_ACP_SERVER;
      assert.ok(config.geminiServerPath?.endsWith("/agy_acp_server.par"), "Gemini proof requires an explicit installed ACP server");
    }
    const runRows = () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, config.companyId));
    const cardRows = () => db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, config.issueId));
    const issueRow = async () => (await db.select().from(issues).where(eq(issues.id, config.issueId)))[0];
    const live = (run) => ["queued", "running", "scheduled"].includes(run.status);
    const app = express();
    app.use(express.json());
    if (config.realJulesExecutor) {
      app.use("/__contract/jules/v1alpha", (req, res) => {
        record("PROVIDER_REQUEST", { method: req.method, path: req.path });
        if (req.method !== "GET") return res.status(405).json({ error: "provider writes forbidden in resumed-session contract" });
        if (req.path === `/sessions/${config.sessionId}`) return res.json({ name: `sessions/${config.sessionId}`,
          state: "COMPLETED", outputs: [{ pullRequest: { url: config.prUrl } }] });
        if (req.path === `/sessions/${config.sessionId}/activities`) return res.json({ activities: [{
          id: "fixture-plan-activity", createTime: "2026-09-27T01:00:00.000Z",
          planGenerated: { plan: { id: "fixture-plan", steps: [{ index: 0, title: "Contract plan" }] } },
        }, { id: "fixture-approved-activity", createTime: "2026-09-27T01:01:00.000Z",
          planApproved: { planId: "fixture-plan" } }] });
        if (req.path === "/sources") return res.json({ sources: [] });
        return res.status(404).json({ error: "unknown provider fixture route" });
      });
    }
    // Use the host's real local-trusted board actor only for the typed recovery
    // route. Reviewer, bootstrap, and parent requests remain authenticated.
    if (config.geminiFirstInitFailure || config.parentCardWithdrawalProbe || config.prStrongFirstTurnFailure) {
      app.use("/__contract/board-api", actorMiddleware(db, { deploymentMode: "local_trusted" }), issueRoutes(db, {}));
    }
    app.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    app.get("/__contract/actor", (req, res) => res.json({ type: req.actor.type }));
    app.post("/__contract/events", async (req, res, next) => {
      try {
        assert.equal(req.actor.type, "agent");
        assert.equal(req.actor.companyId, config.companyId);
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, req.actor.runId));
        assert.equal(run?.agentId, req.actor.agentId);
        assert.equal(run.status, "running");
        const { name, data = {}, wait = false } = req.body;
        record(name, { runId: run.id, agentId: run.agentId, data });
        if (wait && !closing && !released.has(name)) {
          pending.set(`${run.id}:${name}`, { name, response: res });
          res.once("close", () => pending.delete(`${run.id}:${name}`));
        } else res.json({ ok: true });
      } catch (error) { next(error); }
    });
    app.use((req, res, next) => {
      if (req.method !== "PATCH" || req.path !== `/api/issues/${config.issueId}`) return next();
      activeMutations++;
      const mutation = { actorId: req.actor.agentId, runId: req.actor.runId, body: req.body, status: null, returnedStatus: null };
      report.mutations.push(mutation);
      // Observe handler completion, not socket close: reassignment may kill the caller first.
      const original = res.json.bind(res);
      let completed = false;
      res.json = (body) => {
        if (!completed) {
          completed = true; activeMutations--;
          mutation.status = res.statusCode; mutation.returnedStatus = body?.status ?? null;
        }
        return original(body);
      };
      next();
    });
    app.use("/api", issueRoutes(db, {}));
    app.use("/api", agentRoutes(db, {}));
    app.use("/api", activityRoutes(db));
    app.use((error, req, res, next) => {
      if (scenario.startsWith("stable_child")) record("FIXTURE_HTTP_ERROR", { path: req.path,
        message: error.cause?.message ?? error.message, code: error.cause?.code });
      next(error);
    });
    app.use(errorHandler);
    listener = await new Promise((resolve, reject) => {
      const server = app.listen(0, "127.0.0.1", () => resolve(server)); server.once("error", reject);
    });
    process.env.PAPERCLIP_API_URL = `http://127.0.0.1:${listener.address().port}`;
    if (config.realJulesExecutor) config.providerBaseUrl = `${process.env.PAPERCLIP_API_URL}/__contract/jules/v1alpha`;
    await db.insert(authUsers).values({ id: config.userId, name: "Contract operator", email: `${config.userId}@example.test`,
      emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: config.companyId, name: "Disposable concurrency contract", issuePrefix: "RACE", issueCounter: 3, defaultResponsibleUserId: config.userId });
    await db.insert(companyMemberships).values({ companyId: config.companyId, principalType: "user", principalId: config.userId, status: "active", membershipRole: "owner" });
    const worker = fileURLToPath(new URL(scenario.startsWith("stable_child") ? "./native-child-plan-worker.mjs" : "./native-plan-worker.mjs", import.meta.url));
    const runtimeConfig = { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } };
    report.runtimeConfig = runtimeConfig;
    const adapterConfig = { command: process.execPath, args: ["--import", require.resolve("tsx"), worker],
      cwd: home, env: { CONTRACT_FIXTURE: JSON.stringify(config), ...(config.realJulesExecutor ? {
        PAPERCLIP_ADAPTER_E2E: "1", PAPERCLIP_JULES_SESSION_STORE_DIR: config.sessionStoreDir,
      } : {}) }, timeoutSec: config.geminiReviewer || config.prStrongGemini ? 240 : 100, graceSec: 1 };
    await db.insert(agents).values([
      { id: config.managerId, companyId: config.companyId, name: "Manager", role: "ceo", status: "paused", adapterType: "process", adapterConfig: { command: "true" } },
      { id: config.orchestratorId, companyId: config.companyId, name: "Reconciler", role: "general", reportsTo: config.managerId,
        permissions: { canAssignTasks: true, canCreateAgents: true, canCreateSkills: true }, status: "idle", adapterType: "process", adapterConfig, runtimeConfig },
      ...[config.julesId, config.lunaId, config.terraId].map((id) => ({ id, companyId: config.companyId, name: id === config.julesId ? "Jules fixture" : id === config.lunaId ? "Luna fixture" : "Terra fixture",
        reportsTo: config.orchestratorId, status: "idle", adapterType: "process", adapterConfig, runtimeConfig })),
    ]);
    await db.insert(issues).values([
      { id: config.issueId, companyId: config.companyId, identifier: "RACE-1", title: "Plan review", status: "in_progress", assigneeAgentId: config.julesId },
      { id: config.maintenanceIssueId, companyId: config.companyId, identifier: "RACE-2", title: "Maintenance", status: "in_progress", assigneeAgentId: config.orchestratorId },
      { id: config.blockerIssueId, companyId: config.companyId, identifier: "RACE-3", title: "Other reviewer work", status: "in_progress", assigneeAgentId: config.lunaId },
    ].map((issue) => ({ ...issue, executionPolicy: { mode: "normal", stages: [], commentRequired: false } })));
    await db.insert(documents).values({ id: config.documentId, companyId: config.companyId, title: "Plan", format: "markdown",
      latestBody: "# Contract plan", latestRevisionId: config.revisionId, latestRevisionNumber: 1 });
    await db.insert(documentRevisions).values({ id: config.revisionId, companyId: config.companyId, documentId: config.documentId,
      revisionNumber: 1, title: "Plan", format: "markdown", body: "# Contract plan" });
    await db.insert(issueDocuments).values({ companyId: config.companyId, issueId: config.issueId, documentId: config.documentId, key: "plan" });
    const unauthenticated = await fetch(`${process.env.PAPERCLIP_API_URL}/api/issues/${config.issueId}`);
    const anonymousActor = await fetch(`${process.env.PAPERCLIP_API_URL}/__contract/actor`).then((response) => response.json());
    assert.equal(anonymousActor.type, "none", "fixture must not fall back to the local board actor");
    assert.ok([401, 403, 404].includes(unauthenticated.status), `existing fixture issue must deny or conceal anonymous access (${unauthenticated.status})`);
    report.anonymousAccess = { actorType: anonymousActor.type, issueStatus: unauthenticated.status };
    const invalidToken = await fetch(`${process.env.PAPERCLIP_API_URL}/api/issues/${config.issueId}`, {
      headers: { Authorization: "Bearer invalid-contract-token" },
    });
    assert.equal(invalidToken.status, 401, "actual host middleware must reject invalid bearer credentials");

    async function wake(agentId, issueId, extras = {}) {
      // Normal host admission creates every run; no active run rows or auth actors are fabricated.
      return heartbeat.wakeup(agentId, { source: "automation", triggerDetail: "system", reason: "contract_scheduler",
        payload: { issueId }, contextSnapshot: { issueId, ...extras } });
    }
    async function snapshot(label) {
      const issue = await issueRow();
      const cards = await cardRows();
      const runs = await runRows();
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, config.companyId));
      const holds = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, config.companyId));
      const observation = { label, issue: { status: issue.status, owner: issue.assigneeAgentId, executionRunId: issue.executionRunId,
        policy: issue.executionPolicy, state: issue.executionState },
      cards: cards.map(({ id, status, resolvedByAgentId, resolvedByRunId, sourceRunId }) => ({ id, status, resolvedByAgentId, resolvedByRunId, sourceRunId })),
      runs: runs.map((run) => ({ id: run.id, agentId: run.agentId, status: run.status, errorCode: run.errorCode,
        ...(scenario.startsWith("stable_child") && run.status === "failed" ? { error: run.error, fixtureError: run.resultJson?.stderr?.slice(-1800) } : {}),
        issueId: run.contextSnapshot?.issueId, wakeReason: run.contextSnapshot?.wakeReason,
        startedAt: run.startedAt, finishedAt: run.finishedAt })),
      wakes: wakes.map(({ id, agentId, status, reason, runId, error }) => ({ id, agentId, status, reason, runId, error })),
      holds: holds.map(({ id, status, cause }) => ({ id, status, cause })) };
      report.observations.push(observation);
      return observation;
    }
    failureSnapshot = () => snapshot("failure");
    async function settle() {
      const timeoutMs = config.prStrongGemini ? 240_000 : 60_000;
      await until("all run executions and PATCH handlers settled", async () => activeMutations === 0 && (await runRows()).every((run) => !live(run)), timeoutMs);
      await heartbeat.drainActiveRunExecutions();
      await until("late host runs settled", async () => activeMutations === 0 && (await runRows()).every((run) => !live(run)), timeoutMs);
    }
    const handbacks = () => report.mutations.filter((mutation) => mutation.actorId === config.orchestratorId);
    if (scenario.startsWith("stable_child")) {
      const { runStableChildContract } = await import("./native-child-plan-contract.mjs");
      await runStableChildContract({ config, report, db, schema, eq, heartbeat, wake, waitEvent, until, release, settle, issueRow, runRows, record, deliverReconciledExecutions });
      if (config.realJulesExecutor) {
        const { runJulesExecutorRecoveryContract } = await import("./native-jules-executor-contract.mjs");
        await runJulesExecutorRecoveryContract({ config, report, db, schema, eq, wake, settle, runRows, issueRow });
      }
    } else {
    await wake(config.julesId, config.issueId);
    const verdict = await waitEvent("VERDICT_WRITTEN");
    if (scenario === "active_before_read") {
      await wake(config.orchestratorId, config.maintenanceIssueId);
      const read = await waitEvent("EVIDENCE_READ");
      assert.equal(read.data.decision.kind, "await_reviewer_settlement");
      assert.equal(handbacks().length, 0);
      report.outcome = "guard_waits_for_active_reviewer";
      release("VERDICT_WRITTEN");
    } else {
      release("VERDICT_WRITTEN");
      await settle();
      const [answered] = await cardRows();
      assert.equal(answered.status, "answered");
      assert.equal(answered.resolvedByRunId, verdict.runId);
      assert.equal((await runRows()).find((run) => run.id === verdict.runId)?.status, "succeeded");
      record("VERDICT_SETTLED");
      await snapshot("settled_verdict");
      if (scenario === "queued_before_read" || scenario === "queued_after_read") {
        await wake(config.lunaId, config.blockerIssueId);
        await waitEvent("BLOCKER_STARTED");
      }
      if (scenario === "queued_before_read") {
        await wake(config.lunaId, config.issueId, { contractCompetitor: true });
        await until("competing reviewer queued", async () => (await runRows()).some((run) => run.agentId === config.lunaId && run.contextSnapshot?.issueId === config.issueId && run.status === "queued"));
      }
      await wake(config.orchestratorId, config.maintenanceIssueId, scenario === "lost_response" ? { contractLoseResponse: true } : {});
      const read = await waitEvent("EVIDENCE_READ");
      if (scenario === "queued_before_read") {
        assert.equal(read.data.decision.kind, "await_reviewer_settlement");
        assert.equal(handbacks().length, 0);
        report.outcome = "guard_waits_for_queued_reviewer";
        release("COMPETING_REVIEWER_STARTED"); release("BLOCKER_STARTED");
      } else {
        assert.equal(read.data.decision.kind, "return_to_jules", JSON.stringify(read.data));
        await waitEvent("PATCH_READY");
        let competitorId;
        if (scenario === "starts_after_read" || scenario === "queued_after_read") {
          await wake(config.lunaId, config.issueId, { contractCompetitor: true });
          if (scenario === "starts_after_read") {
            const competitor = await waitEvent("COMPETING_REVIEWER_STARTED");
            competitorId = competitor.runId;
            assert.equal((await runRows()).find((run) => run.id === competitorId)?.status, "running");
          } else {
            competitorId = await until("competing reviewer queued after read", async () =>
              (await runRows()).find((run) => run.agentId === config.lunaId && run.contextSnapshot?.issueId === config.issueId && run.status === "queued")?.id);
          }
          await snapshot("competitor_admitted_after_final_read");
        }
        if (scenario === "overlapping") {
          await wake(config.orchestratorId, config.maintenanceIssueId);
          const overlap = await snapshot("second_reconciliation_admission");
          assert.ok(overlap.runs.filter((run) => run.agentId === config.orchestratorId && run.status === "running").length <= 1);
        }
        release("PATCH_READY");
        await waitEvent(scenario === "lost_response" ? "PATCH_RESPONSE_LOST" : "PATCH_RESULT");
        if (scenario === "queued_after_read") release("BLOCKER_STARTED");
        if (competitorId) {
          const competitor = await until("competing reviewer terminal or PATCH rejected", async () => {
            const run = (await runRows()).find((item) => item.id === competitorId);
            const mutation = handbacks()[0];
            return (run && !live(run)) || (mutation?.status >= 400) ? run : null;
          });
          report.outcome = competitor.status === "cancelled"
            ? scenario === "starts_after_read" ? "unsafe_stale_patch_cancelled_running_reviewer" : "host_cancelled_stale_queued_reviewer"
            : "host_rejected_stale_handback";
          if (competitor.status === "cancelled") {
            assert.ok(["issue_reassigned", "issue_assignee_changed"].includes(competitor.errorCode),
              `Cancellation must be attributable to the handback: ${competitor.errorCode}`);
          }
          release("COMPETING_REVIEWER_STARTED"); release("BLOCKER_STARTED");
        } else report.outcome = "handback_and_jules_continuation";
        try {
          await waitEvent("JULES_STARTED");
          report.continuation = "run_started";
        } catch (error) {
          if (!(error instanceof ObservationTimeout) || error.label !== "JULES_STARTED" ||
              !["starts_after_read", "queued_after_read"].includes(scenario)) throw error;
          // Missing continuation is a measured contract failure, not a successful handback.
          report.continuation = "not_observed_within_30_seconds";
          report.outcome += "_without_observed_jules_continuation";
          record("JULES_CONTINUATION_NOT_OBSERVED", { observationWindowMs: 30_000 });
        }
        await settle();
        if (scenario === "lost_response" || scenario === "overlapping") {
          const after = events.length;
          await wake(config.orchestratorId, config.maintenanceIssueId);
          const replay = await waitEvent("EVIDENCE_READ", after);
          assert.equal(replay.data.decision.kind, "verify_jules_continuation");
          await settle();
          assert.equal(handbacks().length, 1);
          report.outcome = scenario === "lost_response" ? "lost_response_reconciled_without_second_patch" : "host_serialized_reconciler_wakes";
        }
      }
    }
    await settle();
    const final = await snapshot("final");
    assert.equal(final.cards.length, 1);
    assert.equal(final.cards[0].resolvedByRunId, verdict.runId);
    assert.equal(final.cards[0].status, "answered");
    if (scenario !== "active_before_read" && scenario !== "queued_before_read") {
      assert.equal(final.issue.owner, config.julesId);
      assert.equal(final.issue.status, "in_progress");
      assert.equal(final.issue.policy, null);
      if (report.continuation !== "not_observed_within_30_seconds") {
        assert.ok(events.some((event) => event.name === "JULES_STARTED"));
      }
    } else {
      assert.equal(final.issue.owner, config.lunaId);
      assert.equal(final.issue.status, "in_review");
      assert.equal(handbacks().length, 0);
    }
    }
    report.result = "observed";
    report.safetyGate = report.outcome.startsWith("unsafe_") || report.continuation === "not_observed_within_30_seconds" ? "fail" : "pass";
    console.log("CONTRACT_RESULT", JSON.stringify({ scenario, result: report.result, outcome: report.outcome }));
  } catch (error) {
    report.result = "harness_failure";
    report.safetyGate = "not_established";
    report.error = error instanceof Error ? error.message : String(error);
    if (error instanceof Error && error.cause) report.errorCause = error.cause instanceof Error ? error.cause.message : String(error.cause);
    if (error instanceof assert.AssertionError) {
      report.errorSite = error.stack?.split("\n").find((line) => line.includes("native-child-plan-contract.mjs"))?.trim() ?? null;
    }
    process.exitCode = 1;
    console.error("CONTRACT_FAILURE", scenario, report.error);
    if (failureSnapshot) {
      try { await failureSnapshot(); } catch (snapshotError) { report.snapshotError = String(snapshotError); }
    }
  } finally {
    closing = true;
    for (const { response } of pending.values()) response.json({ ok: true });
    pending.clear();
    if (heartbeat) {
      try {
        await Promise.race([heartbeat.drainActiveRunExecutions(), new Promise((_, reject) => setTimeout(() => reject(new Error("host teardown did not drain")), 110_000).unref())]);
        await until("PATCH handlers finish before database teardown", () => activeMutations === 0);
      } catch (error) {
        report.cleanupError = String(error); report.result = "harness_failure"; report.safetyGate = "not_established"; process.exitCode = 1;
      }
    }
    if (listener) {
      listener.closeIdleConnections();
      await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    }
    if (pg) await pg.cleanup();
    await writeFile(path.join(output, `${scenario}.json`), JSON.stringify(report, null, 2));
    await rm(home, { recursive: true, force: true });
  }
  // Installed-host teardown may change process.exitCode. Decide the harness result last.
  if (report.result === "harness_failure") throw new Error(`Contract scenario ${scenario} failed: ${report.error ?? report.cleanupError}`);
  if (process.argv.includes("--require-safe") && report.safetyGate !== "pass") process.exitCode = 2;
}
