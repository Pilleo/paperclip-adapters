/** Opt-in installed-host contract test. Run with pnpm exec tsx; never connects to the live API. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { nativePlanReviewStageId } from "@pilleo/paperclip-adapter-common";
import { assertContractVersion, expectedContractVersion } from "./host-installation.mjs";

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
  const selectedScenarios = process.argv.includes("--stable-child") ? ["stable_child", "stable_child_reject", "stable_child_ladder", "stable_child_executor", "stable_child_jules_v4", "stable_child_jules_v4_executor", "stable_child_jules_v4_paused", "stable_child_executor_pr_probe", "stable_child_executor_pr_withdraw", "stable_child_executor_pr_reject", "stable_child_executor_pr_paused", "stable_child_executor_pr_failed", "stable_child_executor_pr_board"] : scenarios;
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
  const summary = { version: expectedContractVersion(), integrationAllowed,
    scenarios: results.map(({ scenario, result, outcome, error, safetyGate }) => ({ scenario, result, outcome, error, safetyGate })) };
  await writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2));
  console.log("CONTRACT_SUMMARY", JSON.stringify(summary));
  console.log(`Contract reports: ${output}`);
  if (results.some((result) => result.result !== "observed")) process.exitCode = 1;
  else if (process.argv.includes("--require-safe") && !integrationAllowed) process.exitCode = 2;
} else {
  assert.ok([...scenarios, "stable_child", "stable_child_ladder", "stable_child_reject", "stable_child_executor", "stable_child_executor_pr_probe", "stable_child_executor_pr_withdraw", "stable_child_executor_pr_reject", "stable_child_executor_pr_paused", "stable_child_executor_pr_failed", "stable_child_executor_pr_gemini", "stable_child_executor_pr_board", "stable_child_executor_pr_board_reject", "stable_child_executor_pr_producer_conflict", "stable_child_jules_v4", "stable_child_jules_v4_executor", "stable_child_jules_v4_create", "stable_child_jules_v4_revise_message_lost", "stable_child_chain_abc_complete", "stable_child_chain_abc_later_jules_run", "stable_child_chain_abc_recover_auto_blocker", "stable_child_chain_abc_lost_b_create", "stable_child_chain_abc_lost_b_approval", "stable_child_jules_v4_create_lost", "stable_child_jules_v4_paused", "stable_child_gemini", "stable_child_gemini_retry"].includes(scenario), `Unknown scenario ${scenario}`);
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
  let holdLaterJulesProviderGet = false;
  let pendingLaterJulesProviderReply = null;
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
    assertContractVersion(version);
    const load = (name) => import(pathToFileURL(path.join(install, name)).href);
    const express = hostRequire("express");
    const { eq } = await load("drizzle-orm/index.js");
    const schema = await load("@paperclipai/db/dist/index.js");
    const { agents, authUsers, companies, companyMemberships, issues, documents, documentRevisions, issueDocuments,
      heartbeatRuns, issueThreadInteractions, agentWakeupRequests, issueRecoveryActions } = schema;
    const { issueRoutes } = await load("@paperclipai/server/dist/routes/issues.js");
    const { agentRoutes } = await load("@paperclipai/server/dist/routes/agents.js");
    const { approvalRoutes } = await load("@paperclipai/server/dist/routes/approvals.js");
    const { projectRoutes } = await load("@paperclipai/server/dist/routes/projects.js");
    const { activityRoutes } = await load("@paperclipai/server/dist/routes/activity.js");
    const { actorMiddleware } = await load("@paperclipai/server/dist/middleware/auth.js");
    const { errorHandler } = await load("@paperclipai/server/dist/middleware/index.js");
    const { heartbeatService } = await load("@paperclipai/server/dist/services/heartbeat.js");
    const { deliverReconciledExecutions, settleUnrecoverableExecutions } = await load("@paperclipai/server/dist/services/execution-recovery-resolution.js");
    pg = await schema.startEmbeddedPostgresTestDatabase("plan-reconciliation-contract-");
    db = schema.createDb(pg.connectionString);
    heartbeat = heartbeatService(db);
    const config = Object.fromEntries(["companyId", "userId", "managerId", "orchestratorId", "julesId", "lunaId", "terraId", "issueId",
      "maintenanceIssueId", "blockerIssueId", "documentId", "revisionId", "sessionId"].map((key) => [key, randomUUID()]));
    let chainGitHub = null;
    config.stageId = nativePlanReviewStageId(config.issueId, config.revisionId, "luna");
    config.checkpointPath = path.join(home, "child-review-checkpoint.json");
    config.childReviewLadder = ["stable_child_ladder", "stable_child_executor", "stable_child_executor_pr_probe", "stable_child_executor_pr_withdraw", "stable_child_executor_pr_reject", "stable_child_executor_pr_paused", "stable_child_executor_pr_failed", "stable_child_executor_pr_gemini", "stable_child_executor_pr_board", "stable_child_executor_pr_board_reject", "stable_child_executor_pr_producer_conflict", "stable_child_jules_v4", "stable_child_jules_v4_executor", "stable_child_jules_v4_create", "stable_child_jules_v4_revise_message_lost", "stable_child_chain_abc_complete", "stable_child_chain_abc_later_jules_run", "stable_child_chain_abc_recover_auto_blocker", "stable_child_chain_abc_lost_b_create", "stable_child_chain_abc_lost_b_approval", "stable_child_jules_v4_create_lost", "stable_child_jules_v4_paused"].includes(scenario);
    config.realJulesExecutor = ["stable_child_executor", "stable_child_executor_pr_probe", "stable_child_executor_pr_withdraw", "stable_child_executor_pr_reject", "stable_child_executor_pr_paused", "stable_child_executor_pr_failed", "stable_child_executor_pr_gemini", "stable_child_executor_pr_board", "stable_child_executor_pr_board_reject", "stable_child_executor_pr_producer_conflict"].includes(scenario);
    config.producerConflictProbe = scenario === "stable_child_executor_pr_producer_conflict";
    config.prMigrationProbe = ["stable_child_executor_pr_probe", "stable_child_executor_pr_withdraw", "stable_child_executor_pr_reject", "stable_child_executor_pr_paused", "stable_child_executor_pr_failed", "stable_child_executor_pr_gemini", "stable_child_executor_pr_board", "stable_child_executor_pr_board_reject"].includes(scenario);
    config.prBoardProbe = scenario === "stable_child_executor_pr_board" || scenario === "stable_child_executor_pr_board_reject";
    config.prBoardReject = scenario === "stable_child_executor_pr_board_reject";
    config.terminalWaitProbe = process.env.PAPERCLIP_TEST_TERMINAL_HANDOFF_WAIT === "1";
    config.parentCardWithdrawalProbe = scenario === "stable_child_executor_pr_withdraw";
    config.prStrongReject = scenario === "stable_child_executor_pr_reject" || config.prBoardReject;
    config.prStrongPausedAfterCard = scenario === "stable_child_executor_pr_paused";
    config.prStrongGemini = scenario === "stable_child_executor_pr_gemini";
    config.prStrongFirstTurnFailure = scenario === "stable_child_executor_pr_failed";
    config.prStrongRetryMarker = path.join(home, "strong-reviewer-first-turn-failed");
    config.chainBlockedProbe = ["stable_child_chain_abc_complete", "stable_child_chain_abc_later_jules_run", "stable_child_chain_abc_lost_b_create",
      "stable_child_chain_abc_lost_b_approval", "stable_child_chain_abc_recover_auto_blocker"].includes(scenario);
    config.chainLaterJulesRunProbe = scenario === "stable_child_chain_abc_later_jules_run";
    config.chainAutoSettledPrFailure = scenario === "stable_child_chain_abc_recover_auto_blocker";
    if (config.prBoardReject) config.projectId = randomUUID();
    config.chainLostBCreateResponse = scenario === "stable_child_chain_abc_lost_b_create";
    config.chainLostBApprovalResponse = scenario === "stable_child_chain_abc_lost_b_approval";
    if (config.chainBlockedProbe) {
      config.projectId = randomUUID();
      config.strongReviewerId = randomUUID();
      config.bIssueId = randomUUID();
      config.cIssueId = randomUUID();
      config.bSessionId = randomUUID();
      config.cSessionId = randomUUID();
      config.chainGitHubStatePath = path.join(home, "github-state.json");
    }
    config.planRevisionMessageLoss = scenario === "stable_child_jules_v4_revise_message_lost";
    config.createProviderSession = scenario === "stable_child_jules_v4_create" || config.chainBlockedProbe ||
      config.planRevisionMessageLoss || scenario === "stable_child_jules_v4_create_lost";
    config.dropProviderCreateResponse = scenario === "stable_child_jules_v4_create_lost";
    config.julesParentExecutor = config.createProviderSession || scenario === "stable_child_jules_v4_executor" || scenario === "stable_child_jules_v4_paused";
    config.pauseLunaInitially = scenario === "stable_child_jules_v4_paused";
    config.julesOwnedBootstrap = scenario === "stable_child_jules_v4" || config.julesParentExecutor;
    if (config.julesOwnedBootstrap) config.providerBaseUrl = "pending-listener";
    if (config.realJulesExecutor || config.julesParentExecutor) {
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
      if (config.createProviderSession || config.prBoardProbe) {
        const { createChainGitHubFixture } = await import("./chain-github-fixture.mjs");
        chainGitHub = await createChainGitHubFixture(home);
        const pr = await chainGitHub.openPullRequest("A", "A.txt", "alpha");
        config.prUrl = pr.url;
        config.prHeadSha = pr.headSha;
        config.githubPath = `${home}:${process.env.PATH}`;
        config.chainWorkspacePath = chainGitHub.repository;
        config.githubExecutablePath = chainGitHub.ghPath;
        report.observations.push({ label: "real_git_open_pr", url: pr.url, headSha: pr.headSha, baseSha: pr.baseSha });
      }
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
    let providerApproved = false;
    let providerApprovedAt = null;
    let providerCreated = false;
    let providerCreateRequest = null;
    let providerRevised = false;
    let providerRevisionAt = null;
    let boardPrFeedbackPrompt = null;
    const chainProviderSessions = new Map();
    const maybeHoldLaterJulesGet = (reply) => {
      if (!config.chainLaterJulesRunProbe || !holdLaterJulesProviderGet || pendingLaterJulesProviderReply) return false;
      pendingLaterJulesProviderReply = reply;
      record("CHAIN_LATER_JULES_PROVIDER_GET_HELD", { issueId: config.issueId });
      return true;
    };
    const app = express();
    app.use(express.json());
    if (config.realJulesExecutor || config.julesOwnedBootstrap) {
      app.use("/__contract/jules/v1alpha", (req, res) => {
        record("PROVIDER_REQUEST", { method: req.method, path: req.path });
        if (config.chainBlockedProbe) {
          if (req.path === "/sources" && req.method === "GET") return res.json({ sources: [{
            name: "sources/github/paperclip-contract/fixture", githubRepo: { owner: "paperclip-contract", repo: "fixture" },
          }] });
          if (req.path === "/sessions" && req.method === "POST") {
            assert.equal(req.body.sourceContext?.source, "sources/github/paperclip-contract/fixture");
            assert.equal(req.body.sourceContext?.githubRepoContext?.startingBranch, "main");
            assert.equal(req.body.requirePlanApproval, true);
            const label = /Canary B/i.test(req.body.prompt) ? "B" : /Canary C/i.test(req.body.prompt) ? "C" : "A";
            const sessionId = label === "B" ? config.bSessionId : label === "C" ? config.cSessionId : config.sessionId;
            if (chainProviderSessions.has(sessionId)) return res.status(409).json({ error: "duplicate provider session" });
            chainProviderSessions.set(sessionId, { label, request: req.body, approved: false });
            if (label === "A") { providerCreated = true; providerCreateRequest = req.body; }
            record("CHAIN_PROVIDER_SESSION_CREATED", { label, sessionId });
            if (label === "B" && config.chainLostBCreateResponse) {
              record("CHAIN_B_PROVIDER_CREATE_RESPONSE_LOST", { sessionId });
              req.socket.destroy();
              return;
            }
            return res.json({ name: `sessions/${sessionId}`, prompt: req.body.prompt,
              sourceContext: req.body.sourceContext, state: "AWAITING_PLAN_APPROVAL", outputs: [] });
          }
          const approvalId = /^\/sessions\/([^/]+):approvePlan$/.exec(req.path)?.[1];
          if (approvalId && req.method === "POST") {
            const stored = chainProviderSessions.get(approvalId);
            if (!stored || stored.approved) return res.status(409).json({ error: "missing or already approved plan" });
            stored.approved = true;
            stored.approvedAt = new Date().toISOString();
            if (approvalId === config.sessionId) providerApproved = true;
            if (approvalId === config.bSessionId && config.chainLostBApprovalResponse) {
              record("CHAIN_B_PROVIDER_APPROVAL_RESPONSE_LOST", { sessionId: approvalId });
              req.socket.destroy();
              return;
            }
            return res.json({});
          }
          const stateOf = (sessionId, stored) => ({ name: `sessions/${sessionId}`,
            prompt: stored.request.prompt, sourceContext: stored.request.sourceContext,
            state: stored.approved ? "COMPLETED" : "AWAITING_PLAN_APPROVAL",
            outputs: stored.approved ? [{ pullRequest: { url: stored.label === "A" ? config.prUrl :
              `https://github.com/paperclip-contract/fixture/pull/${stored.label === "B" ? 2 : 3}` } }] : [],
          });
          if (req.path === "/sessions" && req.method === "GET") {
            const reply = () => res.json({ sessions: [...chainProviderSessions]
              .map(([id, stored]) => stateOf(id, stored)) });
            if (maybeHoldLaterJulesGet(reply)) return;
            return reply();
          }
          const activitiesId = /^\/sessions\/([^/]+)\/activities$/.exec(req.path)?.[1];
          if (activitiesId && req.method === "GET") {
            const stored = chainProviderSessions.get(activitiesId);
            if (!stored) return res.status(404).json({ error: "session absent" });
            return res.json({ activities: [{ id: "fixture-plan-activity", createTime: "2026-09-27T01:00:00.000Z",
              planGenerated: { plan: { id: "fixture-plan", steps: [{ index: 0, title: `Contract plan ${stored.label}` }] } } },
              ...(stored.approved ? [{ id: "fixture-approved-activity", createTime: stored.approvedAt,
                planApproved: { planId: "fixture-plan" } }] : [])] });
          }
          const sessionId = /^\/sessions\/([^/]+)$/.exec(req.path)?.[1];
          if (sessionId && req.method === "GET") {
            const stored = chainProviderSessions.get(sessionId);
            if (!stored) return res.status(404).json({ error: "session absent" });
            const reply = () => res.json(stateOf(sessionId, stored));
            if (maybeHoldLaterJulesGet(reply)) return;
            return reply();
          }
          return res.status(404).json({ error: "unsupported chain provider operation" });
        }
        if (config.createProviderSession && req.method === "POST" && req.path === "/sessions") {
          if (providerCreated) return res.status(409).json({ error: "duplicate session creation" });
          assert.equal(req.body.sourceContext?.source, "sources/github/paperclip-contract/fixture");
          assert.equal(req.body.sourceContext?.githubRepoContext?.startingBranch, "main");
          assert.equal(req.body.requirePlanApproval, true);
          providerCreated = true;
          providerCreateRequest = req.body;
          if (config.dropProviderCreateResponse) {
            record("PROVIDER_CREATE_RESPONSE_LOST", { sessionId: config.sessionId });
            req.socket.destroy();
            return;
          }
          return res.json({ name: `sessions/${config.sessionId}`, prompt: req.body.prompt,
            sourceContext: req.body.sourceContext, state: "AWAITING_PLAN_APPROVAL", outputs: [] });
        }
        if (config.julesParentExecutor && req.method === "POST" && req.path === `/sessions/${config.sessionId}:approvePlan`) {
          if (config.createProviderSession && !providerCreated) return res.status(409).json({ error: "session absent" });
          if (providerApproved) return res.status(409).json({ error: "duplicate plan approval" });
          providerApproved = true;
          providerApprovedAt = new Date().toISOString();
          return res.json({});
        }
        if (config.planRevisionMessageLoss && req.method === "POST" &&
            req.path === `/sessions/${config.sessionId}:sendMessage`) {
          if (providerRevised) return res.status(409).json({ error: "duplicate same-session plan revision request" });
          assert.equal(typeof req.body?.prompt, "string");
          providerRevised = true;
          providerRevisionAt = new Date().toISOString();
          record("PROVIDER_REVISION_MESSAGE_RESPONSE_LOST", { sessionId: config.sessionId });
          req.socket.destroy();
          return;
        }
        if (config.prBoardReject && req.method === "POST" &&
            req.path === `/sessions/${config.sessionId}:sendMessage`) {
          if (boardPrFeedbackPrompt) return res.status(409).json({ error: "duplicate native PR rejection feedback" });
          assert.ok(req.body?.prompt?.includes(config.prUrl) &&
            req.body.prompt.includes(config.prHeadSha) && req.body.prompt.includes("native Paperclip code review"),
          "only exact head-bound native PR feedback may reach the original provider session");
          boardPrFeedbackPrompt = req.body.prompt;
          record("BOARD_PR_CHILD_FEEDBACK_SENT", { sessionId: config.sessionId, prUrl: config.prUrl,
            headSha: config.prHeadSha });
          return res.json({});
        }
        if (req.method !== "GET") return res.status(405).json({ error: "provider writes forbidden in resumed-session contract" });
        if (config.julesOwnedBootstrap && !config.julesParentExecutor) return res.status(404).json({ error: "child bootstrap must not access Jules provider" });
        if (req.path === "/sessions") return res.json({ sessions: config.createProviderSession && !providerCreated ? [] : [{
          name: `sessions/${config.sessionId}`, prompt: providerCreateRequest?.prompt,
          sourceContext: providerCreateRequest?.sourceContext, state: boardPrFeedbackPrompt ? "IN_PROGRESS" : providerApproved ? "COMPLETED" : "AWAITING_PLAN_APPROVAL",
          outputs: providerApproved ? [{ pullRequest: { url: config.prUrl } }] : [],
        }] });
        if (config.createProviderSession && !providerCreated && req.path === `/sessions/${config.sessionId}`) {
          return res.status(404).json({ error: "session absent" });
        }
        if (req.path === `/sessions/${config.sessionId}`) return res.json({ name: `sessions/${config.sessionId}`,
          state: boardPrFeedbackPrompt ? "IN_PROGRESS" : config.julesParentExecutor && !providerApproved ? "AWAITING_PLAN_APPROVAL" : "COMPLETED",
          outputs: config.julesParentExecutor && !providerApproved ? [] : [{ pullRequest: { url: config.prUrl } }] });
        if (req.path === `/sessions/${config.sessionId}/activities`) return res.json({ activities: [{
          id: "fixture-plan-activity", createTime: "2026-09-27T01:00:00.000Z",
          planGenerated: { plan: { id: "fixture-plan", steps: [{ index: 0, title: "Contract plan" }] } },
        }, ...(providerRevised ? [{ id: "fixture-user-revision-request", createTime: providerRevisionAt,
          userMessaged: { userMessage: "Please revise the exact rejected plan." } },
          { id: "fixture-plan-activity-revised", createTime: new Date(Date.parse(providerRevisionAt) + 10).toISOString(),
            planGenerated: { plan: { id: "fixture-plan-revised", steps: [{ index: 0, title: "Revised contract plan" }] } } }] : []),
        ...(config.julesParentExecutor && !providerApproved ? [] : [{ id: "fixture-approved-activity", createTime: providerApprovedAt ?? "2026-09-27T01:01:00.000Z",
          planApproved: { planId: providerRevised ? "fixture-plan-revised" : "fixture-plan" } }]),
        ...(boardPrFeedbackPrompt ? [{ id: "fixture-native-pr-feedback-echo", createTime: new Date().toISOString(),
          userMessaged: { userMessage: boardPrFeedbackPrompt } }] : []) ] });
        if (req.path === "/sources") return res.json({ sources: config.createProviderSession ? [{
          name: "sources/github/paperclip-contract/fixture", githubRepo: { owner: "paperclip-contract", repo: "fixture" },
        }] : [] });
        return res.status(404).json({ error: "unknown provider fixture route" });
      });
    }
    // Use the host's real local-trusted board actor only for the typed recovery
    // route. Reviewer, bootstrap, and parent requests remain authenticated.
    if (config.geminiFirstInitFailure || config.parentCardWithdrawalProbe || config.prStrongFirstTurnFailure || config.prBoardProbe || config.dropProviderCreateResponse) {
      app.use("/__contract/board-api", actorMiddleware(db, { deploymentMode: "local_trusted" }), issueRoutes(db, {}), agentRoutes(db, {}), activityRoutes(db));
    }
    app.use(actorMiddleware(db, { deploymentMode: config.chainBlockedProbe || config.prBoardReject ? "local_trusted" : "authenticated" }));
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
      if (config.chainLaterJulesRunProbe) record("CHAIN_SOURCE_ISSUE_PATCH_OBSERVED", {
        actorType: req.actor.type, actorId: req.actor.agentId ?? null, runId: req.actor.runId ?? null,
        status: req.body.status ?? null, assigneeAgentId: req.body.assigneeAgentId ?? null,
        fieldNames: Object.keys(req.body),
      });
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
    app.use("/api", approvalRoutes(db, {}));
    app.use("/api", projectRoutes(db));
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
    if (config.realJulesExecutor || config.julesOwnedBootstrap) config.providerBaseUrl = `${process.env.PAPERCLIP_API_URL}/__contract/jules/v1alpha`;
    await db.insert(authUsers).values({ id: config.userId, name: "Contract operator", email: `${config.userId}@example.test`,
      emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    if (config.chainBlockedProbe || config.prBoardReject) await db.insert(authUsers).values({ id: "local-board",
      name: "Disposable local-trusted board operator", email: "local-board@contract.invalid",
      emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: config.companyId, name: "Disposable concurrency contract", issuePrefix: "RACE",
      issueCounter: config.chainBlockedProbe ? 5 : 3, defaultResponsibleUserId: config.userId });
    await db.insert(companyMemberships).values({ companyId: config.companyId, principalType: "user", principalId: config.userId, status: "active", membershipRole: "owner" });
    if (config.chainBlockedProbe || config.prBoardReject) await db.insert(companyMemberships).values({ companyId: config.companyId,
      principalType: "user", principalId: "local-board", status: "active", membershipRole: "owner" });
    const worker = fileURLToPath(new URL(scenario.startsWith("stable_child") ? "./native-child-plan-worker.mjs" : "./native-plan-worker.mjs", import.meta.url));
    const runtimeConfig = { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } };
    report.runtimeConfig = runtimeConfig;
    const adapterConfig = { command: process.execPath, args: ["--import", require.resolve("tsx"), worker],
      cwd: home, env: { CONTRACT_FIXTURE: JSON.stringify(config), ...(config.realJulesExecutor || config.julesOwnedBootstrap ? {
        PAPERCLIP_ADAPTER_E2E: "1", PAPERCLIP_JULES_SESSION_STORE_DIR: config.sessionStoreDir,
      } : {}) }, timeoutSec: config.geminiReviewer || config.prStrongGemini ? 240 : 100, graceSec: 1 };
    await db.insert(agents).values([
      { id: config.managerId, companyId: config.companyId, name: "Manager", role: "ceo", status: "paused", adapterType: "process", adapterConfig: { command: "true" } },
      { id: config.orchestratorId, companyId: config.companyId, name: "Reconciler", role: "general", reportsTo: config.managerId,
        permissions: { canAssignTasks: true, canCreateAgents: true, canCreateSkills: true }, status: "idle", adapterType: "process", adapterConfig, runtimeConfig },
      ...[config.julesId, config.lunaId, config.terraId, ...(config.chainBlockedProbe ? [config.strongReviewerId] : [])].map((id) => ({ id, companyId: config.companyId,
          name: id === config.julesId ? "Jules fixture" : id === config.lunaId ? "Luna fixture" : id === config.terraId ? "Terra fixture" : "Antigravity strong reviewer fixture",
          reportsTo: config.orchestratorId, status: config.pauseLunaInitially && id === config.lunaId ? "paused" : "idle",
           ...(config.chainBlockedProbe || config.prBoardReject ? { metadata: { managedBy: "paperclip-orchestrator",
            workerKey: id === config.julesId ? "jules" : id === config.lunaId ? "luna_reviewer" : id === config.terraId ? "terra_reviewer" : "antigravity",
            ...(id === config.julesId ? {} : { structuredDecisionCapability: { version: 1,
              transports: ["mcp_tool"], decisionKinds: ["plan_review", "pull_request_review"] } }) } } : {}),
          adapterType: id === config.strongReviewerId ? "antigravity" : "process", adapterConfig, runtimeConfig })),
    ]);
    if (config.chainBlockedProbe || config.prBoardReject) {
      const repoUrl = "https://github.com/paperclip-contract/fixture.git";
      await db.insert(schema.projects).values({ id: config.projectId, companyId: config.companyId,
        name: "Disposable A B C repository", status: "in_progress" });
      await db.insert(schema.projectWorkspaces).values({ companyId: config.companyId, projectId: config.projectId,
        name: "Shared clean Git checkout", sourceType: "local_path", cwd: chainGitHub.repository,
        repoUrl, repoRef: "main", defaultRef: "main", isPrimary: true });
      execFileSync("git", ["-C", chainGitHub.repository, "config",
        `url.file://${chainGitHub.repository}.insteadOf`, repoUrl], { timeout: 8_000 });
    }
    await db.insert(issues).values([
      { id: config.issueId, companyId: config.companyId, identifier: "RACE-1", title: "Plan review", status: "in_progress", assigneeAgentId: config.julesId,
         ...(config.chainBlockedProbe || config.prBoardReject ? { projectId: config.projectId, description: "---\norchestrator_managed: true\n---\n\nImplement canary A." } : {}) },
      { id: config.maintenanceIssueId, companyId: config.companyId, identifier: "RACE-2", title: "Maintenance", status: "in_progress", assigneeAgentId: config.orchestratorId,
        ...(config.chainBlockedProbe || config.prBoardReject ? { projectId: config.projectId } : {}) },
      { id: config.blockerIssueId, companyId: config.companyId, identifier: "RACE-3", title: "Other reviewer work", status: "in_progress", assigneeAgentId: config.lunaId },
    ].map((issue) => ({ ...issue, executionPolicy: { mode: "normal", stages: [], commentRequired: false } })));
    if (config.chainBlockedProbe) {
      await db.insert(issues).values([
        { id: config.bIssueId, companyId: config.companyId, identifier: "RACE-4", title: "Canary B",
          status: "todo", assigneeAgentId: null, projectId: config.projectId,
          description: "---\norchestrator_managed: true\n---\n\nImplement canary B after A merges." },
        { id: config.cIssueId, companyId: config.companyId, identifier: "RACE-5", title: "Canary C",
          status: "todo", assigneeAgentId: null, projectId: config.projectId,
          description: "---\norchestrator_managed: true\n---\n\nImplement canary C after B merges." },
      ].map((issue) => ({ ...issue, executionPolicy: { mode: "normal", stages: [], commentRequired: false } })));
      await db.insert(schema.issueRelations).values([
        { companyId: config.companyId, issueId: config.issueId, relatedIssueId: config.bIssueId, type: "blocks" },
        { companyId: config.companyId, issueId: config.bIssueId, relatedIssueId: config.cIssueId, type: "blocks" },
      ]);
    }
    await db.insert(documents).values({ id: config.documentId, companyId: config.companyId, title: "Plan", format: "markdown",
      latestBody: "# Contract plan", latestRevisionId: config.revisionId, latestRevisionNumber: 1 });
    await db.insert(documentRevisions).values({ id: config.revisionId, companyId: config.companyId, documentId: config.documentId,
      revisionNumber: 1, title: "Plan", format: "markdown", body: "# Contract plan" });
    await db.insert(issueDocuments).values({ companyId: config.companyId, issueId: config.issueId, documentId: config.documentId, key: "plan" });
    if (config.julesParentExecutor && !config.createProviderSession) {
      process.env.PAPERCLIP_JULES_SESSION_STORE_DIR = config.sessionStoreDir;
      const { saveStoredSession } = await import("../../../jules/src/server/session-store.ts");
      await saveStoredSession({ version: 1, paperclipIssueId: config.issueId, promptHash: "fixture-prompt", promptHashVersion: 2,
        repository: "paperclip-contract/fixture", source: "sources/github/paperclip-contract/fixture", baseBranch: "main",
        phase: "RUNNING", sessionId: config.sessionId, julesSessionId: config.sessionId,
        attempt: 1, failedSessions: [], createdAt: new Date().toISOString() });
    }
    const unauthenticated = await fetch(`${process.env.PAPERCLIP_API_URL}/api/issues/${config.issueId}`);
    const anonymousActor = await fetch(`${process.env.PAPERCLIP_API_URL}/__contract/actor`).then((response) => response.json());
    assert.equal(anonymousActor.type, config.chainBlockedProbe || config.prBoardReject ? "board" : "none",
      "only real-project host probes emulate Paperclip's local-trusted board actor");
    if (config.chainBlockedProbe || config.prBoardReject) assert.equal(unauthenticated.status, 200);
    else assert.ok([401, 403, 404].includes(unauthenticated.status),
      `existing fixture issue must deny or conceal anonymous access (${unauthenticated.status})`);
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
    failureSnapshot = async () => {
      await snapshot("failure");
      if (config.chainLostBApprovalResponse) {
        const previousStore = process.env.PAPERCLIP_JULES_SESSION_STORE_DIR;
        process.env.PAPERCLIP_JULES_SESSION_STORE_DIR = config.sessionStoreDir;
        try {
          const { loadStoredSession } = await import("../../../jules/src/server/session-store.ts");
          const stored = await loadStoredSession(config.bIssueId, "sources/github/paperclip-contract/fixture", "main");
          report.observations.push({ label: "b_approval_lost_checkpoint", sessionId: stored?.julesSessionId ?? null,
            planStage: stored?.childPlanReview?.identity.stage ?? null,
            effects: stored?.lifecycleEffectJournal?.effects.map((effect) => ({ effectId: effect.effectId,
              attempt: effect.attempt.kind })) ?? [] });
        } finally {
          if (previousStore === undefined) delete process.env.PAPERCLIP_JULES_SESSION_STORE_DIR;
          else process.env.PAPERCLIP_JULES_SESSION_STORE_DIR = previousStore;
        }
      }
    };
    async function settle() {
      const timeoutMs = config.prStrongGemini ? 240_000 : 60_000;
      await until("all run executions and PATCH handlers settled", async () => activeMutations === 0 && (await runRows()).every((run) => !live(run)), timeoutMs);
      await heartbeat.drainActiveRunExecutions();
      await until("late host runs settled", async () => activeMutations === 0 && (await runRows()).every((run) => !live(run)), timeoutMs);
      // Process workers call the actual external executors; map their returned
      // result into terminal host rows just as the external adapter host does.
      for (const event of report.events.filter((event) =>
        ["REAL_JULES_PARENT_RESULT", "REAL_JULES_EXECUTOR_RESULT"].includes(event.name) && event.data?.adapterResult)) {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, event.runId));
        if (run?.status === "succeeded") {
          const returned = { ...run.resultJson, ...event.data.adapterResult, stopReason: "completed" };
          if (run.id === config.legacyProducerRunId) {
            // Model the old result schema on a genuinely completed producer;
            // later actual runs retain their full new head-bound evidence.
            delete returned.julesState;
            delete returned.handoffPending;
          }
          await db.update(heartbeatRuns).set({ resultJson: returned }).where(eq(heartbeatRuns.id, run.id));
        }
      }
    }
    const handbacks = () => report.mutations.filter((mutation) => mutation.actorId === config.orchestratorId);
    if (config.chainBlockedProbe) {
      const [project] = await db.select().from(schema.projects)
        .where(eq(schema.projects.id, config.projectId));
      const [workspace] = await db.select().from(schema.projectWorkspaces)
        .where(eq(schema.projectWorkspaces.projectId, config.projectId));
      assert.ok(project && workspace, "a shared real-project A B C gate needs one authoritative Paperclip project workspace");
      assert.equal(workspace.cwd, chainGitHub.repository);
      const operatorMemberships = await db.select().from(schema.companyMemberships)
        .where(eq(schema.companyMemberships.companyId, config.companyId));
      assert.ok(operatorMemberships.some((membership) => membership.principalType === "user" &&
        membership.principalId === "local-board" && membership.status === "active"),
      "local-trusted board operator must be a real active company member before it approves an agent task_start");
      for (const id of [config.bIssueId, config.cIssueId]) {
        const [dependent] = await db.select().from(issues).where(eq(issues.id, id));
        assert.equal(dependent.assigneeAgentId, null,
          "blocked dependent tasks must begin unassigned until their native task_start gate is approved");
      }
      const earlyRuns = (await runRows()).filter((run) =>
        [config.bIssueId, config.cIssueId].includes(run.contextSnapshot?.issueId) && run.startedAt);
      assert.equal(earlyRuns.length, 0, "B/C provider work must not start while native predecessor blockers remain unresolved");
      record("CHAIN_DEPENDENTS_HELD", { bIssueId: config.bIssueId, cIssueId: config.cIssueId });
    }
    if (scenario.startsWith("stable_child")) {
      const { runStableChildContract } = await import("./native-child-plan-contract.mjs");
      if (config.pauseLunaInitially) {
        await wake(config.julesId, config.issueId);
        await settle();
        const pending = await issueRow();
        assert.ok(pending.monitorNextCheckAt);
        await heartbeat.tickTimers(new Date(new Date(pending.monitorNextCheckAt).getTime() + 1));
        await settle();
        const child = (await db.select().from(schema.issues).where(eq(schema.issues.parentId, config.issueId)))[0];
        assert.ok(child && child.status === "backlog", "paused reviewer must leave one durable parked child");
        assert.equal((await db.select().from(schema.issueThreadInteractions)
          .where(eq(schema.issueThreadInteractions.issueId, child.id))).length, 0,
        "no native review card or provider approval is spent while Luna is paused");
        assert.equal(report.events.filter((event) => event.name === "PROVIDER_REQUEST" && event.method !== "GET").length, 0);
        await db.update(agents).set({ status: "idle" }).where(eq(agents.id, config.lunaId));
        record("PAUSED_REVIEWER_RESUMED", { childId: child.id });
      }
      await runStableChildContract({ config, report, db, schema, eq, heartbeat, wake, waitEvent, until, release, settle, issueRow, runRows, record, deliverReconciledExecutions });
      if (config.julesOwnedBootstrap) {
        const childRuns = (await runRows()).filter((run) => run.agentId === config.julesId && run.contextSnapshot?.issueId !== config.issueId);
        assert.equal(childRuns.filter((run) => run.status === "succeeded").length,
          config.planRevisionMessageLoss ? 3 : 2,
        "each distinct original/revised plan child must bootstrap on Jules's own child-scoped run");
        assert.equal((await runRows()).filter((run) => run.agentId === config.orchestratorId).length, 0,
          "Jules plan ladder must run without an orchestrator bootstrap or reconciliation heartbeat");
        if (config.julesParentExecutor) {
          for (let turn = 0; turn < 12; turn++) {
            if ((await db.select().from(schema.issueWorkProducts)
              .where(eq(schema.issueWorkProducts.issueId, config.issueId))).length) break;
            const parent = await issueRow();
            assert.ok(parent.monitorNextCheckAt, "Jules must retain a monitor until the verified PR is registered");
            await heartbeat.tickTimers(new Date(new Date(parent.monitorNextCheckAt).getTime() + 1));
            await settle();
          }
          assert.equal(report.events.filter((event) => event.name === "PROVIDER_REQUEST" && event.method === "POST" &&
            event.path === `/sessions/${config.sessionId}:approvePlan`).length, 1,
          "one Jules provider approval must follow the actual parent executor's Luna/Terra typed ladder");
          assert.deepEqual(report.events.filter((event) => event.name === "PROVIDER_REQUEST" && event.method !== "GET")
            .map((event) => event.path), config.planRevisionMessageLoss
            ? ["/sessions", `/sessions/${config.sessionId}:sendMessage`, `/sessions/${config.sessionId}:approvePlan`]
            : config.createProviderSession
              ? ["/sessions", `/sessions/${config.sessionId}:approvePlan`] : [`/sessions/${config.sessionId}:approvePlan`],
          "the provider create and approval must each be accepted once, never replayed");
          if (config.dropProviderCreateResponse) {
            const lost = report.events.find((event) => event.name === "PROVIDER_CREATE_RESPONSE_LOST");
            const remoteLookup = report.events.find((event) => event.name === "PROVIDER_REQUEST" &&
              event.method === "GET" && event.path === "/sessions" && event.sequence > lost?.sequence);
            const typedRecovery = report.events.find((event) => event.name === "JULES_CREATE_TYPED_RECOVERY");
            assert.ok(lost && remoteLookup && typedRecovery,
              "the original accepted create must be reconciled by remote session lookup and typed host recovery");
            assert.equal(lost.sessionId, config.sessionId);
          }
          if (config.planRevisionMessageLoss) {
            const lost = report.events.find((event) => event.name === "PROVIDER_REVISION_MESSAGE_RESPONSE_LOST");
            const activities = report.events.find((event) => event.name === "PROVIDER_REQUEST" &&
              event.method === "GET" && event.path === `/sessions/${config.sessionId}/activities` &&
              event.sequence > lost?.sequence);
            const approved = report.events.find((event) => event.name === "PROVIDER_REQUEST" &&
              event.method === "POST" && event.path === `/sessions/${config.sessionId}:approvePlan`);
            assert.ok(lost && activities && approved && lost.sessionId === config.sessionId &&
              lost.sequence < activities.sequence && activities.sequence < approved.sequence,
            "lost sendMessage must be reconciled by same-session provider activities before approving revised plan");
          }
          const products = await db.select().from(schema.issueWorkProducts)
            .where(eq(schema.issueWorkProducts.issueId, config.issueId));
          assert.equal(products.length, 1, "the real parent Jules executor must deliver its PR after both v4 child verdicts");
          assert.equal(products[0].url, config.prUrl);
          assert.equal(products[0].metadata.headSha, config.prHeadSha);
          assert.equal(products[0].status, "ready_for_review");
          assert.equal((await issueRow()).assigneeAgentId, config.julesId);
          if (config.chainLaterJulesRunProbe && process.env.PAPERCLIP_TEST_LEGACY_PRODUCER === "1") {
            config.legacyProducerRunId = products[0].createdByRunId;
            assert.ok(config.legacyProducerRunId);
            const [producer] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, config.legacyProducerRunId));
            const historical = { ...producer.resultJson };
            delete historical.julesState;
            delete historical.handoffPending;
            await db.update(heartbeatRuns).set({ resultJson: historical }).where(eq(heartbeatRuns.id, producer.id));
          }
          if (config.chainLaterJulesRunProbe) {
            holdLaterJulesProviderGet = true;
            const laterWake = await wake(config.julesId, config.issueId, { contractLaterJulesMonitor: true });
            await waitEvent("CHAIN_LATER_JULES_PROVIDER_GET_HELD", 0, 60_000);
            const [later] = (await runRows()).filter((run) => run.agentId === config.julesId &&
              run.contextSnapshot?.issueId === config.issueId && run.id !== laterWake?.id && run.status === "running")
              .sort((a, b) => b.createdAt - a.createdAt);
            const inFlight = later ?? (await runRows()).find((run) => run.agentId === config.julesId &&
              run.contextSnapshot?.issueId === config.issueId && run.status === "running");
            assert.ok(inFlight, "a later same-issue Jules run must remain genuinely running before PR handoff");
            const orchestratorWake = await wake(config.orchestratorId, config.maintenanceIssueId,
              { contractChainReconcile: true });
            await until("orchestrator tick holds later Jules execution", async () => {
              const runs = await runRows();
              return runs.some((run) => run.id === orchestratorWake.id && run.status === "succeeded");
            }, 60_000);
            const stillRunning = (await runRows()).find((run) => run.id === inFlight.id);
            assert.equal(stillRunning?.status, "running", "handoff must not cancel the newer Jules run");
            assert.equal((await issueRow()).assigneeAgentId, config.julesId);
            const held = await fetch(`${process.env.PAPERCLIP_API_URL}/api/issues/${config.issueId}`)
              .then((response) => response.json());
            assert.equal(held.executionBlocker ?? null, null, "no issue_reassigned blocker may be manufactured");
            record("CHAIN_LATER_JULES_HANDOFF_HELD", { laterRunId: inFlight.id, prUrl: config.prUrl });
            holdLaterJulesProviderGet = false;
            const releaseProvider = pendingLaterJulesProviderReply;
            pendingLaterJulesProviderReply = null;
            releaseProvider?.();
            await settle();
          }
          if (config.chainBlockedProbe) {
            if (config.chainAutoSettledPrFailure) {
              await wake(config.julesId, config.issueId, { contractFailAfterRegisteredPr: true });
              await settle();
              const [failed] = (await runRows()).filter((run) => run.agentId === config.julesId &&
                run.contextSnapshot?.issueId === config.issueId && run.status === "failed");
              assert.ok(failed, "host must record exactly one failed A run after its prior PR was registered");
              assert.ok(report.events.some((event) => event.name === "CHAIN_A_FAILED_RUN_BEFORE_NEW_PROVIDER_EFFECT" &&
                event.runId === failed.id));
              const beforeWrites = report.events.filter((event) => event.name === "PROVIDER_REQUEST" && event.method === "POST").length;
              await settleUnrecoverableExecutions(db);
              const [action] = await db.select().from(schema.issueRecoveryActions)
                .where(eq(schema.issueRecoveryActions.sourceIssueId, config.issueId));
              assert.equal(action?.status, "resolved");
              assert.equal(action?.outcome, "blocked");
              assert.equal(action?.evidence?.automaticRecovery?.replay, "blocked");
              assert.equal(action?.evidence?.runId, failed.id);
              const blocked = await fetch(`${process.env.PAPERCLIP_API_URL}/api/issues/${config.issueId}`)
                .then((response) => response.json());
              assert.equal(blocked.status, "blocked");
              assert.equal(blocked.assigneeAgentId, config.julesId);
              assert.equal(blocked.executionBlocker?.runId, failed.id);
              await wake(config.orchestratorId, config.maintenanceIssueId, { contractChainReconcile: true });
              await settle();
              const stillHeld = await fetch(`${process.env.PAPERCLIP_API_URL}/api/issues/${config.issueId}`)
                .then((response) => response.json());
              assert.equal(stillHeld.status, "blocked", "auto-settled failure must not hand Jules's PR to reviewers");
              assert.equal(stillHeld.assigneeAgentId, config.julesId,
                "preserve original owner until exact board-authorized typed failed-run reconciliation");
              assert.equal((await db.select().from(issues).where(eq(issues.parentId, config.issueId)))
                .filter((child) => child.description?.startsWith("<!-- paperclip-pr-review-child:")).length, 0);
              assert.equal(report.events.filter((event) => event.name === "PROVIDER_REQUEST" && event.method === "POST").length,
                beforeWrites, "no provider mutation may be replayed while automatic no-replay hold is active");
              record("CHAIN_A_AUTO_SETTLED_HOLD_VERIFIED", { failedRunId: failed.id, actionId: action.id,
                headSha: config.prHeadSha });
              const resolution = await fetch(`${process.env.PAPERCLIP_API_URL}/api/issues/${config.issueId}/recovery-actions/resolve`, {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ actionId: action.id, outcome: "restored", sourceIssueStatus: "todo",
                  executionReconciliation: { runId: failed.id, providerStopped: true, actionOutcome: "not_performed",
                    outcomeEvidence: `The exact failed fixture run ${failed.id} exited before any new provider action; the previous session and PR ${config.prUrl} at ${config.prHeadSha} were already registered and remain intact.` } }),
                signal: AbortSignal.timeout(20_000),
              });
              assert.equal(resolution.status, 200, `native typed auto-settled recovery failed (${resolution.status}): ${await resolution.text()}`);
              const unblocked = await fetch(`${process.env.PAPERCLIP_API_URL}/api/issues/${config.issueId}`)
                .then((response) => response.json());
              assert.equal(unblocked.executionBlocker ?? null, null);
              await deliverReconciledExecutions(db, (agentId, options) => heartbeat.wakeup(agentId, options));
              await settle();
              record("CHAIN_A_TYPED_FAILED_RUN_RECONCILED", { failedRunId: failed.id, actionId: action.id });
            }
            const dependentRuns = (await runRows()).filter((run) =>
              [config.bIssueId, config.cIssueId].includes(run.contextSnapshot?.issueId) && run.startedAt);
            assert.equal(dependentRuns.length, 0, "B/C cannot execute before A has a verified merge");
            for (const id of [config.bIssueId, config.cIssueId]) {
              const [dependent] = await db.select().from(issues).where(eq(issues.id, id));
              assert.equal(dependent.status, "todo");
              assert.equal((await db.select().from(schema.issueWorkProducts)
                .where(eq(schema.issueWorkProducts.issueId, id))).length, 0);
            }
            const relations = await db.select().from(schema.issueRelations)
              .where(eq(schema.issueRelations.companyId, config.companyId));
            assert.deepEqual(relations.map((edge) => [edge.issueId, edge.relatedIssueId]), [
              [config.issueId, config.bIssueId], [config.bIssueId, config.cIssueId],
            ]);
            await wake(config.orchestratorId, config.maintenanceIssueId, { contractChainReconcile: true });
            await settle();
            assert.equal((await issueRow()).status, "in_review",
              "the actual orchestrator must promote A's registered Jules PR into native review before external merge");
            const parentCards = await db.select().from(schema.issueThreadInteractions)
              .where(eq(schema.issueThreadInteractions.issueId, config.issueId));
            const pendingPr = parentCards.filter((card) => card.status === "pending" &&
              card.kind === "request_item_verdicts" && card.createdByAgentId === null &&
              card.addresseeAgentId === config.lunaId &&
              card.idempotencyKey?.includes(`:${config.issueId}:${config.prUrl}:${config.prHeadSha}:luna`));
            assert.ok(pendingPr.length <= 1, "more than one parent PR card has ambiguous native review authority");
            const [registeredPr] = await db.select().from(schema.issueWorkProducts)
              .where(eq(schema.issueWorkProducts.issueId, config.issueId));
            assert.equal(registeredPr?.url, config.prUrl);
            assert.equal(registeredPr?.metadata?.headSha, config.prHeadSha);
            assert.equal(registeredPr?.isPrimary, true, "Jules PR must be the primary registered work product");
            assert.equal(registeredPr?.status, "ready_for_review");
            assert.ok(registeredPr?.metadata?.source === "jules" || registeredPr?.metadata?.producer === "paperclip-jules-adapter",
              `registered Jules PR producer metadata is missing: ${JSON.stringify(registeredPr?.metadata)}`);
            if (pendingPr.length === 1) {
              assert.equal(parentCards.filter((card) => card.status === "pending").length, 1,
                "an unrelated pending card must not be retired as the original PR card");
              assert.equal((await runRows()).filter((run) => run.agentId === config.lunaId &&
                run.contextSnapshot?.issueId === config.issueId && ["queued", "scheduled", "running"].includes(run.status)).length, 0,
              "a live addressed reviewer run forbids parent card withdrawal");
              const withdrawal = await fetch(`${process.env.PAPERCLIP_API_URL}/api/issues/${config.issueId}/interactions/${pendingPr[0].id}/withdraw`, {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ reason: `Original idle parent PR card for immutable head ${config.prHeadSha} is superseded by issue-scoped child review; no verdict is inferred.` }),
                signal: AbortSignal.timeout(20_000),
              });
              assert.equal(withdrawal.status, 200, "the board must use native typed withdrawal, not a status PATCH");
              const [retired] = await db.select().from(schema.issueThreadInteractions)
                .where(eq(schema.issueThreadInteractions.id, pendingPr[0].id));
              assert.equal(retired.status, "cancelled");
              record("CHAIN_PARENT_CARD_TYPED_WITHDRAWAL", { cardId: retired.id, headSha: config.prHeadSha });
            } else assert.equal(parentCards.filter((card) => card.status === "pending").length, 0,
              "a child-scoped PR review must not bypass an unknown pending parent card");
            for (let turn = 0; turn < 20; turn++) {
              await wake(config.orchestratorId, config.maintenanceIssueId, { contractChainReconcile: true });
              await settle();
              const created = (await db.select().from(issues).where(eq(issues.parentId, config.issueId)))
                .filter((child) => child.description?.startsWith("<!-- paperclip-pr-review-child:v1\n"));
              if (created.length === 2) {
                const childCards = await Promise.all(created.map((child) => db.select().from(schema.issueThreadInteractions)
                  .where(eq(schema.issueThreadInteractions.issueId, child.id))));
                if (childCards.every((cards) => cards.length === 1 && cards[0].status === "answered")) break;
              }
            }
            const allReviewChildren = await db.select().from(issues).where(eq(issues.parentId, config.issueId));
            record("CHAIN_REVIEW_CHILD_OBSERVATION", { children: allReviewChildren.map((child) => ({
              id: child.id, status: child.status, createdByAgentId: child.createdByAgentId,
              descriptor: child.description?.split("\n", 1)[0] ?? null,
            })) });
            const reviewChildren = allReviewChildren
              .filter((child) => child.description?.startsWith("<!-- paperclip-pr-review-child:v1\n"));
            const { parsePrReviewChildDescription } = await import("../../src/core/pr-review-child.ts");
            const reviewIdentities = reviewChildren.map((child) => parsePrReviewChildDescription(child.description));
            assert.equal(reviewChildren.length, 2,
              "the actual orchestrator must create distinct Luna and strong native PR children before any merge");
            assert.deepEqual(reviewIdentities.map((identity) => identity?.stage).sort(), ["luna", "strong"]);
            assert.ok(reviewIdentities.every((identity) => identity?.headSha === config.prHeadSha &&
              identity.prUrl === config.prUrl && identity.parentIssueId === config.issueId));
            assert.equal((await runRows()).filter((run) =>
              [config.bIssueId, config.cIssueId].includes(run.contextSnapshot?.issueId) && run.startedAt).length, 0,
            "neither B nor C may start while A's PR remains unmerged");
            const reviewedEvidence = [];
            for (const [index, child] of reviewChildren.entries()) {
              const [card] = await db.select().from(schema.issueThreadInteractions)
                .where(eq(schema.issueThreadInteractions.issueId, child.id));
              assert.ok(card && card.status === "answered", `${reviewIdentities[index]?.stage} child requires an addressed typed verdict`);
              assert.equal(card.result.items[0].verdict, "approve");
              assert.equal(card.resolvedByAgentId, reviewIdentities[index].reviewerAgentId);
              assert.ok(card.idempotencyKey.includes(`:${child.id}:${config.prUrl}:${config.prHeadSha}:${reviewIdentities[index].stage}`));
              const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, card.sourceRunId));
              const [reviewer] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, card.resolvedByRunId));
              assert.equal(source?.agentId, config.orchestratorId);
              assert.equal(source?.status, "succeeded");
              assert.equal(source?.contextSnapshot?.issueId, child.id);
              assert.equal(reviewer?.agentId, reviewIdentities[index].reviewerAgentId);
              assert.equal(reviewer?.status, "succeeded");
              assert.equal(reviewer?.contextSnapshot?.issueId, child.id);
              reviewedEvidence.push({ stage: reviewIdentities[index].stage,
                reviewerAgentId: reviewer.agentId, cardId: card.id,
                sourceRunId: source.id, resolvedByRunId: reviewer.id, verdict: card.result.items[0].verdict });
            }
            const merged = await chainGitHub.externalMerge(config.prUrl, { headSha: config.prHeadSha,
              reviews: reviewedEvidence.sort((left, right) => left.stage === "luna" ? -1 : right.stage === "luna" ? 1 : 0) });
            record("CHAIN_A_EXTERNAL_MERGE", { mergeSha: merged.mergeSha, reviewedHeadSha: merged.headSha,
              cardIds: reviewedEvidence.map((evidence) => evidence.cardId) });
            const bPullRequest = await chainGitHub.openPullRequest("B", "B.txt", "beta");
            assert.equal(bPullRequest.baseSha, merged.mergeSha, "B's disposable PR must start from the verified A merge");
            record("CHAIN_B_PR_FIXTURE_PREPARED", { baseSha: bPullRequest.baseSha, headSha: bPullRequest.headSha });
            const remotePr = JSON.parse(execFileSync(chainGitHub.ghPath,
              ["pr", "view", config.prUrl, "--json", "state,headRefOid,mergeCommit"], { encoding: "utf8", timeout: 8_000 }));
            assert.equal(remotePr.state, "MERGED", "the separate external actor must merge A only after both native verdicts");
            assert.equal(remotePr.headRefOid, config.prHeadSha);
            assert.equal(remotePr.mergeCommit.oid, merged.mergeSha);
            for (let turn = 0; turn < 8; turn++) {
              await wake(config.orchestratorId, config.maintenanceIssueId, { contractChainReconcile: true });
              await settle();
              const [observed] = await db.select().from(schema.issueWorkProducts)
                .where(eq(schema.issueWorkProducts.issueId, config.issueId));
              if ((await issueRow()).status === "done" && observed?.status === "merged") break;
            }
            const [productAfterExternalMerge] = await db.select().from(schema.issueWorkProducts)
              .where(eq(schema.issueWorkProducts.issueId, config.issueId));
            assert.equal((await issueRow()).status, "done",
              "the real orchestrator must reconcile external Git merge before B is released");
            assert.equal(productAfterExternalMerge.status, "merged");
            const bDetail = await fetch(`${process.env.PAPERCLIP_API_URL}/api/issues/${config.bIssueId}`)
              .then((response) => response.json());
            const cDetail = await fetch(`${process.env.PAPERCLIP_API_URL}/api/issues/${config.cIssueId}`)
              .then((response) => response.json());
            const { evaluateAuthoritativeDependencies } = await import("../../src/core/dependency-gate.ts");
            assert.deepEqual(bDetail.blockedBy?.map(({ id, status }) => [id, status]), [[config.issueId, "done"]]);
            assert.deepEqual(evaluateAuthoritativeDependencies(bDetail), { safe: true });
            assert.deepEqual(cDetail.blockedBy?.map(({ id }) => id), [config.bIssueId]);
            assert.equal(evaluateAuthoritativeDependencies(cDetail).safe, false);
            assert.equal((await runRows()).filter((run) => run.contextSnapshot?.issueId === config.cIssueId && run.startedAt).length, 0,
              "C must remain blocked after A alone merges");
            const pendingApprovals = await db.select().from(schema.approvals)
              .where(eq(schema.approvals.companyId, config.companyId));
            record("CHAIN_B_APPROVAL_SNAPSHOT", { approvals: pendingApprovals.map((approval) => ({
              id: approval.id, status: approval.status, type: approval.type,
              action: approval.payload?.action ?? null, issueId: approval.payload?.issueId ?? null,
              requestedByAgentId: approval.requestedByAgentId,
            })) });
            const bStart = pendingApprovals.filter((approval) => approval.status === "pending" &&
              approval.payload?.action === "task_start" && approval.payload?.issueId === config.bIssueId);
            assert.equal(bStart.length, 1, "operator must approve only B's addressed native task_start card");
            assert.ok(pendingApprovals.some((approval) => approval.status === "pending" &&
              approval.payload?.action === "task_start" && approval.payload?.issueId === config.cIssueId),
            "C's task_start must remain undecided while B is unfinished");
            const started = await fetch(`${process.env.PAPERCLIP_API_URL}/api/approvals/${bStart[0].id}/approve`, {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ decisionNote: "Disposable A merge verified; authorize only B to start." }),
              signal: AbortSignal.timeout(20_000),
            });
            assert.equal(started.status, 200, "B start must use the native typed board approval route");
            const [approvedStart] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, bStart[0].id));
            assert.equal(approvedStart.status, "approved");
            record("CHAIN_B_TASK_START_APPROVED", { approvalId: approvedStart.id, aMergeSha: merged.mergeSha });
            await wake(config.orchestratorId, config.maintenanceIssueId, { contractChainReconcile: true });
            await settle();
            const bBeforeWake = await fetch(`${process.env.PAPERCLIP_API_URL}/api/issues/${config.bIssueId}`)
              .then((response) => response.json());
            record("CHAIN_B_AFTER_APPROVED_START", { status: bBeforeWake.status,
              assigneeAgentId: bBeforeWake.assigneeAgentId, executionBlocker: bBeforeWake.executionBlocker ?? null,
              executionPolicy: bBeforeWake.executionPolicy ?? null });
            assert.equal((await runRows()).filter((run) => run.agentId === config.julesId &&
              run.contextSnapshot?.issueId === config.bIssueId && ["queued", "scheduled", "running"].includes(run.status)).length, 0,
            "do not duplicate an active addressed B Jules run after task_start approval");
            if (config.chainLostBCreateResponse) {
              const failedB = (await runRows()).filter((run) => run.agentId === config.julesId &&
                run.contextSnapshot?.issueId === config.bIssueId && run.status === "failed");
              assert.equal(failedB.length, 1, "one B run must fail closed after an accepted create loses its receipt");
              assert.ok(report.events.some((event) => event.name === "CHAIN_B_PROVIDER_CREATE_RESPONSE_LOST" &&
                event.sessionId === config.bSessionId));
              assert.equal(chainProviderSessions.get(config.bSessionId)?.approved, false);
              const actions = await db.select().from(schema.issueRecoveryActions)
                .where(eq(schema.issueRecoveryActions.sourceIssueId, config.bIssueId));
              assert.equal(actions.length, 1, "host must retain the exact B failed-run recovery action");
              assert.equal(actions[0].status, "active");
              const resolution = await fetch(`${process.env.PAPERCLIP_API_URL}/api/issues/${config.bIssueId}/recovery-actions/resolve`, {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ actionId: actions[0].id, outcome: "restored", sourceIssueStatus: "todo",
                  executionReconciliation: { runId: failedB[0].id, providerStopped: true, actionOutcome: "completed",
                    outcomeEvidence: `Original B provider create accepted sessions/${config.bSessionId}; its response was lost, the failed process stopped, and the same remote session is observable. No second create is authorized.` } }),
                signal: AbortSignal.timeout(20_000),
              });
              assert.equal(resolution.status, 200, `B typed execution recovery failed (${resolution.status}): ${await resolution.text()}`);
              await deliverReconciledExecutions(db, (agentId, options) => heartbeat.wakeup(agentId, options));
              await settle();
              record("CHAIN_B_CREATE_TYPED_RECOVERY", { failedRunId: failedB[0].id, actionId: actions[0].id });
            } else {
              await wake(config.julesId, config.bIssueId, { contractChainApprovedStart: approvedStart.id });
              await settle();
            }
            const bCreated = report.events.filter((event) => event.name === "CHAIN_PROVIDER_SESSION_CREATED" && event.label === "B");
            assert.equal(bCreated.length, 1, "released B must create exactly one own Jules provider session");
            assert.equal(bCreated[0].sessionId, config.bSessionId);
            assert.ok(bCreated[0].sequence > report.events.find((event) => event.name === "CHAIN_A_EXTERNAL_MERGE")?.sequence &&
              bCreated[0].sequence > report.events.find((event) => event.name === "CHAIN_B_TASK_START_APPROVED")?.sequence,
            "B provider creation requires both verified A merge and native task_start approval");
            assert.equal(report.events.filter((event) => event.name === "CHAIN_PROVIDER_SESSION_CREATED" && event.label === "C").length, 0);
            const bFailures = (await runRows()).filter((run) => run.contextSnapshot?.issueId === config.bIssueId && run.status === "failed");
            assert.deepEqual(bFailures.map((run) => run.id), config.chainLostBCreateResponse
              ? [report.events.find((event) => event.name === "CHAIN_B_CREATE_TYPED_RECOVERY")?.failedRunId] : [],
            "the original uncertain create is the only permitted failed B run");
            for (let turn = 0; turn < 20; turn++) {
              const products = await db.select().from(schema.issueWorkProducts)
                .where(eq(schema.issueWorkProducts.issueId, config.bIssueId));
              if (products.length) break;
              const [currentB] = await db.select().from(issues).where(eq(issues.id, config.bIssueId));
              assert.ok(currentB.monitorNextCheckAt,
                `B must retain a durable Jules monitor until its PR is registered (status ${currentB.status})`);
              await heartbeat.tickTimers(new Date(new Date(currentB.monitorNextCheckAt).getTime() + 1));
              await settle();
            }
            const bProducts = await db.select().from(schema.issueWorkProducts)
              .where(eq(schema.issueWorkProducts.issueId, config.bIssueId));
            assert.equal(bProducts.length, 1, "B must finish its own typed plan approvals and register its PR");
            assert.equal(bProducts[0].url, bPullRequest.url);
            assert.equal(bProducts[0].metadata?.headSha, bPullRequest.headSha);
            assert.equal(bProducts[0].metadata?.producer, "paperclip-jules-adapter");
            assert.equal(bProducts[0].status, "ready_for_review");
            assert.deepEqual(report.events.filter((event) => event.name === "PROVIDER_REQUEST" &&
              event.method === "POST" && event.path === `/sessions/${config.bSessionId}:approvePlan`).map((event) => event.path),
            [`/sessions/${config.bSessionId}:approvePlan`]);
            const bPlanChildren = await db.select().from(issues).where(eq(issues.parentId, config.bIssueId));
            const bPlanCards = (await Promise.all(bPlanChildren.map((child) => db.select().from(schema.issueThreadInteractions)
              .where(eq(schema.issueThreadInteractions.issueId, child.id))))).flat()
              .filter((card) => card.payload?.target?.type === "issue_document");
            assert.equal(bPlanCards.length, 2, "B requires its own distinct Luna and strong typed plan cards");
            assert.ok(bPlanCards.every((card) => card.status === "answered" &&
              card.result?.items?.[0]?.verdict === "approve" && card.payload.target.issueId === config.bIssueId &&
              card.sourceRunId && card.resolvedByRunId && card.sourceRunId !== card.resolvedByRunId));
            assert.equal((await runRows()).filter((run) => run.contextSnapshot?.issueId === config.cIssueId && run.startedAt).length, 0,
              "C must stay unstarted until B's external merge is reconciled");
            record("CHAIN_B_PR_REGISTERED", { sessionId: config.bSessionId, headSha: bPullRequest.headSha,
              planCardIds: bPlanCards.map((card) => card.id) });
            const { runChainReviewPhase } = await import("./native-chain-review-phase.mjs");
            let cPullRequest;
            const bMerge = await runChainReviewPhase({ label: "B", issueId: config.bIssueId,
              pr: bPullRequest, config, chainGitHub, db, schema, eq, wake, settle, runRows, record,
              beforeExternalMerge: async () => {
                assert.equal((await runRows()).filter((run) => run.contextSnapshot?.issueId === config.cIssueId && run.startedAt).length, 0,
                  "C must not start during B's PR review before B merges");
              },
              onExternalMerge: async (merge) => {
                cPullRequest = await chainGitHub.openPullRequest("C", "C.txt", "gamma");
                assert.equal(cPullRequest.baseSha, merge.mergeSha,
                  "C's provider PR must begin on the verified external B merge");
              },
            });
            assert.ok(cPullRequest);
            assert.notEqual(bMerge.mergeSha, merged.mergeSha);
            const [bAfterReview] = await db.select().from(issues).where(eq(issues.id, config.bIssueId));
            assert.equal(bAfterReview.status, "done", "B's own typed PR reviews and external merge must complete before C starts");
            const [mergedBProduct] = await db.select().from(schema.issueWorkProducts)
              .where(eq(schema.issueWorkProducts.issueId, config.bIssueId));
            assert.equal(mergedBProduct.status, "merged");
            const cReady = await fetch(`${process.env.PAPERCLIP_API_URL}/api/issues/${config.cIssueId}`)
              .then((response) => response.json());
            assert.deepEqual(cReady.blockedBy?.map(({ id, status }) => [id, status]), [[config.bIssueId, "done"]]);
            assert.deepEqual(evaluateAuthoritativeDependencies(cReady), { safe: true });
            const cStartCandidates = (await db.select().from(schema.approvals)
              .where(eq(schema.approvals.companyId, config.companyId)))
              .filter((approval) => approval.status === "pending" && approval.payload?.action === "task_start" &&
                approval.payload.issueId === config.cIssueId);
            assert.equal(cStartCandidates.length, 1, "only C's own pending native task_start may be approved after B merges");
            const cStarted = await fetch(`${process.env.PAPERCLIP_API_URL}/api/approvals/${cStartCandidates[0].id}/approve`, {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ decisionNote: "Disposable B merge verified; authorize only C to start." }),
              signal: AbortSignal.timeout(20_000),
            });
            assert.equal(cStarted.status, 200, "C start must resolve its actual board approval card");
            record("CHAIN_C_TASK_START_APPROVED", { approvalId: cStartCandidates[0].id, bMergeSha: bMerge.mergeSha });
            for (let turn = 0; turn < 6; turn++) {
              if (report.events.some((event) => event.name === "CHAIN_PROVIDER_SESSION_CREATED" && event.label === "C")) break;
              await wake(config.orchestratorId, config.maintenanceIssueId, { contractChainReconcile: true });
              await settle();
            }
            const cCreates = report.events.filter((event) => event.name === "CHAIN_PROVIDER_SESSION_CREATED" && event.label === "C");
            assert.equal(cCreates.length, 1, "the unblocked C task must create exactly one provider session");
            assert.equal(cCreates[0].sessionId, config.cSessionId);
            assert.ok(cCreates[0].sequence > report.events.find((event) => event.name === "CHAIN_B_EXTERNAL_MERGE")?.sequence &&
              cCreates[0].sequence > report.events.find((event) => event.name === "CHAIN_C_TASK_START_APPROVED")?.sequence);
            assert.equal((await runRows()).filter((run) => run.contextSnapshot?.issueId === config.cIssueId && run.status === "failed").length, 0);
            for (let turn = 0; turn < 20; turn++) {
              const products = await db.select().from(schema.issueWorkProducts)
                .where(eq(schema.issueWorkProducts.issueId, config.cIssueId));
              if (products.length) break;
              const [currentC] = await db.select().from(issues).where(eq(issues.id, config.cIssueId));
              assert.ok(currentC.monitorNextCheckAt,
                `C must retain a Jules monitor until its typed plan review delivers a PR (status ${currentC.status})`);
              await heartbeat.tickTimers(new Date(new Date(currentC.monitorNextCheckAt).getTime() + 1));
              await settle();
            }
            const cProducts = await db.select().from(schema.issueWorkProducts)
              .where(eq(schema.issueWorkProducts.issueId, config.cIssueId));
            assert.equal(cProducts.length, 1);
            assert.equal(cProducts[0].url, cPullRequest.url);
            assert.equal(cProducts[0].metadata?.headSha, cPullRequest.headSha);
            assert.equal(cProducts[0].metadata?.producer, "paperclip-jules-adapter");
            const cPlanChildren = await db.select().from(issues).where(eq(issues.parentId, config.cIssueId));
            const cPlanCards = (await Promise.all(cPlanChildren.map((child) => db.select().from(schema.issueThreadInteractions)
              .where(eq(schema.issueThreadInteractions.issueId, child.id))))).flat()
              .filter((card) => card.payload?.target?.type === "issue_document");
            assert.equal(cPlanCards.length, 2, "C must receive distinct Luna and strong typed plan verdicts");
            assert.ok(cPlanCards.every((card) => card.status === "answered" &&
              card.result?.items?.[0]?.verdict === "approve" && card.payload.target.issueId === config.cIssueId &&
              card.sourceRunId && card.resolvedByRunId && card.sourceRunId !== card.resolvedByRunId));
            assert.deepEqual(report.events.filter((event) => event.name === "PROVIDER_REQUEST" && event.method === "POST" &&
              event.path === `/sessions/${config.cSessionId}:approvePlan`).map((event) => event.path),
            [`/sessions/${config.cSessionId}:approvePlan`]);
            record("CHAIN_C_PR_REGISTERED", { sessionId: config.cSessionId, headSha: cPullRequest.headSha,
              planCardIds: cPlanCards.map((card) => card.id) });
            const cMerge = await runChainReviewPhase({ label: "C", issueId: config.cIssueId,
              pr: cPullRequest, config, chainGitHub, db, schema, eq, wake, settle, runRows, record });
            assert.notEqual(cMerge.mergeSha, bMerge.mergeSha);
            const [cAfterBMerge] = await db.select().from(issues).where(eq(issues.id, config.cIssueId));
            assert.equal(cAfterBMerge.status, "done", "C must complete only after the verified B merge releases it");
            for (const [id, expected] of [[config.issueId, "alpha"], [config.bIssueId, "beta"], [config.cIssueId, "gamma"]]) {
              const [terminal] = await db.select().from(issues).where(eq(issues.id, id));
              const products = await db.select().from(schema.issueWorkProducts)
                .where(eq(schema.issueWorkProducts.issueId, id));
              const projected = await fetch(`${process.env.PAPERCLIP_API_URL}/api/issues/${id}`)
                .then((response) => response.json());
              assert.equal(terminal.status, "done");
              assert.equal(projected.status, "done");
              assert.equal(projected.executionBlocker ?? null, null,
                "terminal issues cannot retain an actionable failed-run recovery blocker");
              assert.equal(products.length, 1);
              assert.equal(products[0].status, "merged");
              assert.equal((await readFile(path.join(chainGitHub.repository, `${id === config.issueId ? "A" : id === config.bIssueId ? "B" : "C"}.txt`), "utf8")), expected);
            }
            assert.equal((await db.select().from(schema.approvals)
              .where(eq(schema.approvals.companyId, config.companyId)))
              .filter((approval) => approval.status === "pending" && approval.payload?.action === "task_merge" &&
                [config.issueId, config.bIssueId, config.cIssueId].includes(approval.payload.issueId)).length, 0,
            "no terminal PR may retain an actionable operator merge approval");
            const createdSessions = report.events.filter((event) => event.name === "CHAIN_PROVIDER_SESSION_CREATED");
            assert.deepEqual(createdSessions.map((event) => event.label), ["A", "B", "C"]);
            assert.equal(new Set(createdSessions.map((event) => event.sessionId)).size, 3);
            assert.equal(report.events.filter((event) => event.name === "PROVIDER_REQUEST" && event.method === "POST" &&
              event.path === "/sessions").length, 3, "each issue must create exactly one durable Jules provider session");
            for (const sessionId of [config.sessionId, config.bSessionId, config.cSessionId]) {
              assert.equal(report.events.filter((event) => event.name === "PROVIDER_REQUEST" && event.method === "POST" &&
                event.path === `/sessions/${sessionId}:approvePlan`).length, 1);
            }
            if (config.chainLostBCreateResponse) {
              const lost = report.events.find((event) => event.name === "CHAIN_B_PROVIDER_CREATE_RESPONSE_LOST");
              const unverified = report.events.find((event) => event.name === "CHAIN_B_CREATE_OUTCOME_UNVERIFIED");
              const lookup = report.events.find((event) => event.name === "PROVIDER_REQUEST" &&
                event.method === "GET" && event.path === "/sessions" && event.sequence > lost?.sequence);
              const recovered = report.events.find((event) => event.name === "CHAIN_B_CREATE_TYPED_RECOVERY");
              const approval = report.events.find((event) => event.name === "PROVIDER_REQUEST" &&
                event.method === "POST" && event.path === `/sessions/${config.bSessionId}:approvePlan`);
              assert.ok(lost && unverified && lookup && recovered && approval &&
                lost.sequence < unverified.sequence && unverified.sequence < lookup.sequence &&
                lookup.sequence < approval.sequence && recovered.sequence < approval.sequence,
              "B must reconcile the original accepted session by GET after its failed run and typed recovery, not replay create");
            }
            if (config.chainLostBApprovalResponse) {
              const lost = report.events.find((event) => event.name === "CHAIN_B_PROVIDER_APPROVAL_RESPONSE_LOST");
              const activityRead = report.events.find((event) => event.name === "PROVIDER_REQUEST" &&
                event.method === "GET" && event.path === `/sessions/${config.bSessionId}/activities` &&
                event.sequence > lost?.sequence);
              const bPr = report.events.find((event) => event.name === "CHAIN_B_PR_REGISTERED");
              assert.ok(lost && activityRead && bPr && lost.sessionId === config.bSessionId &&
                lost.sequence < activityRead.sequence && activityRead.sequence < bPr.sequence,
              "the accepted B approval must be verified from same-session activity after its reply was lost, not posted twice");
            }
            if (config.chainAutoSettledPrFailure) {
              const hold = report.events.find((event) => event.name === "CHAIN_A_AUTO_SETTLED_HOLD_VERIFIED");
              const recovered = report.events.find((event) => event.name === "CHAIN_A_TYPED_FAILED_RUN_RECONCILED");
              const merge = report.events.find((event) => event.name === "CHAIN_A_EXTERNAL_MERGE");
              assert.ok(hold && recovered && merge && hold.actionId === recovered.actionId &&
                hold.failedRunId === recovered.failedRunId && hold.sequence < recovered.sequence &&
                recovered.sequence < merge.sequence,
              "native typed recovery must clear the exact auto-settled failed Jules run before A PR review or merge");
              const [action] = await db.select().from(schema.issueRecoveryActions)
                .where(eq(schema.issueRecoveryActions.id, hold.actionId));
              assert.equal(action?.status, "resolved");
              assert.equal(action?.evidence?.executionReconciliation?.runId, hold.failedRunId);
              assert.equal(action?.evidence?.executionReconciliation?.actionOutcome, "not_performed");
              assert.equal(action?.evidence?.automaticRecovery, undefined);
            }
            report.outcome = config.chainAutoSettledPrFailure
              ? "shared_host_abc_auto_settled_jules_run_typed_recovery_then_external_merges"
              : "shared_host_a_b_c_provider_native_reviews_external_merges_and_terminal_reconciliation";
            record("CHAIN_B_RELEASED_C_HELD", { aMergeSha: merged.mergeSha,
              bIssueId: config.bIssueId, cIssueId: config.cIssueId,
              bStatus: bDetail.status,
              bStartedRuns: (await runRows()).filter((run) =>
                run.contextSnapshot?.issueId === config.bIssueId && run.startedAt).map((run) => ({ id: run.id, status: run.status })) });
          }
          report.outcome = config.chainBlockedProbe ? report.outcome
            : config.planRevisionMessageLoss ? "actual_jules_v4_rejected_plan_revised_once_after_lost_send_message"
              : "actual_jules_executor_self_bootstraps_v4_ladder_approves_once_and_delivers_pr";
        } else {
          assert.equal(report.events.filter((event) => event.name === "PROVIDER_REQUEST").length, 0,
            "child bootstrap must never create or query a Jules cloud session");
          report.outcome = "jules_v4_self_bootstraps_both_plan_children_without_orchestrator_runs";
        }
      }
      if (config.realJulesExecutor) {
        const { runJulesExecutorRecoveryContract } = await import("./native-jules-executor-contract.mjs");
        await runJulesExecutorRecoveryContract({ config, report, db, schema, eq, wake, settle, runRows, issueRow, heartbeat });
        if (config.producerConflictProbe) {
          const { saveStoredSession } = await import("../../../jules/src/server/session-store.ts");
          const previousStore = process.env.PAPERCLIP_JULES_SESSION_STORE_DIR;
          process.env.PAPERCLIP_JULES_SESSION_STORE_DIR = config.sessionStoreDir;
          const wrong = { version: 1, paperclipIssueId: config.issueId, promptHash: "fixture-prompt",
            source: "sources/github/paperclip-contract/fixture", repository: "paperclip-contract/fixture",
            baseBranch: "main", phase: "RUNNING", sessionId: "accidental-second-session",
            julesSessionId: "accidental-second-session", attempt: 2, failedSessions: [], createdAt: new Date().toISOString() };
          try { await saveStoredSession(wrong); }
          finally {
            if (previousStore === undefined) delete process.env.PAPERCLIP_JULES_SESSION_STORE_DIR;
            else process.env.PAPERCLIP_JULES_SESSION_STORE_DIR = previousStore;
          }
          await writeFile(config.staleSessionPath, JSON.stringify(wrong), { mode: 0o600 });
          const [product] = await db.select().from(schema.issueWorkProducts)
            .where(eq(schema.issueWorkProducts.issueId, config.issueId));
          assert.ok(product);
          await db.update(schema.issueWorkProducts).set({ metadata: { ...product.metadata,
            providerSessionId: config.sessionId } }).where(eq(schema.issueWorkProducts.id, product.id));
          const beforeWrites = report.events.filter((event) => event.name === "PROVIDER_REQUEST" && event.method !== "GET").length;
          await wake(config.julesId, config.issueId, { contractJulesExecute: true });
          await settle();
          const rejected = (await runRows()).filter((run) => run.agentId === config.julesId &&
            run.contextSnapshot?.issueId === config.issueId && run.status === "failed");
          assert.equal(rejected.length, 1, "actual Jules executor must reject an accidental provider session with another PR producer");
          assert.ok(String(rejected[0].resultJson?.stderr ?? "").includes("Registered PR producer session differs"));
          assert.equal(report.events.filter((event) => event.name === "PROVIDER_REQUEST" && event.method !== "GET").length, beforeWrites,
            "the producer conflict must not trigger a new create, approve or message");
          report.outcome = "jules_executor_refused_to_graft_original_pr_onto_accidental_provider_session";
        }
        if (config.prBoardProbe) {
          await db.update(issues).set({ status: "in_review", assigneeAgentId: null,
            executionPolicy: null, executionState: null, monitorNextCheckAt: null })
            .where(eq(issues.id, config.issueId));
          const { ensurePrReviewChild, activatePrReviewChild } = await import("../../src/core/pr-review-child.ts");
          const boardApi = {
            get: async (path) => {
              const response = await fetch(`${process.env.PAPERCLIP_API_URL}/__contract/board-api${path}`, { signal: AbortSignal.timeout(20_000) });
              assert.equal(response.status, 200, `board PR child GET ${path} must be authorized`);
              return response.json();
            },
            post: async (path, body) => {
              const response = await fetch(`${process.env.PAPERCLIP_API_URL}/__contract/board-api${path}`, {
                method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
              });
              assert.ok(path.endsWith("/wakeup") ? [200, 201, 202].includes(response.status) : response.status === 201,
                `board PR child POST ${path} must be authorized (${response.status})`);
              return response.json();
            },
            patch: async (path, body) => {
              const response = await fetch(`${process.env.PAPERCLIP_API_URL}/__contract/board-api${path}`, {
                method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
              });
              assert.equal(response.status, 200, `board PR child PATCH ${path} must be authorized`);
              return response.json();
            },
          };
          const identity = { version: 2, creatorPrincipal: "board", companyId: config.companyId, parentIssueId: config.issueId,
            prUrl: config.prUrl, headSha: config.prHeadSha, stage: "luna",
            reviewerAgentId: config.lunaId, bootstrapAgentId: config.orchestratorId };
          const childId = await ensurePrReviewChild({ identity, api: boardApi });
          const child = await boardApi.get(`/issues/${childId}`);
          assert.equal(child.createdByAgentId, null);
          assert.equal(child.parentId, config.issueId);
          assert.equal(child.assigneeAgentId, config.orchestratorId);
          const activatedForBootstrap = await boardApi.patch(`/issues/${child.id}`, {
            status: "todo", assigneeAgentId: config.orchestratorId,
          });
          assert.equal(activatedForBootstrap.assigneeAgentId, config.orchestratorId);
          await settle();
          const [card] = await db.select().from(schema.issueThreadInteractions)
            .where(eq(schema.issueThreadInteractions.issueId, child.id));
          assert.equal(card?.status, "pending", "actual orchestrator must bootstrap one addressed card on the board-owned child");
          const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, card.sourceRunId));
          assert.equal(source.status, "succeeded");
          assert.equal(source.contextSnapshot.issueId, child.id);
          assert.equal(await activatePrReviewChild({ identity, childId, api: boardApi }), "activated");
          await settle();
          const [answered] = await db.select().from(schema.issueThreadInteractions)
            .where(eq(schema.issueThreadInteractions.id, card.id));
          assert.equal(answered.status, "answered", "addressed Luna must give a typed child PR verdict");
          assert.equal(answered.result.items[0].verdict, "approve");
          const [reviewer] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, answered.resolvedByRunId));
          assert.equal(reviewer.agentId, config.lunaId);
          assert.equal(reviewer.status, "succeeded");
          assert.equal(reviewer.contextSnapshot.issueId, child.id);
          assert.equal((await issueRow()).status, "in_review");
          assert.equal((await issueRow()).assigneeAgentId, null);
          assert.equal((await runRows()).filter((run) => run.agentId === config.orchestratorId &&
            run.contextSnapshot?.issueId === config.maintenanceIssueId).length, 0);
          const { inspectPrReviewChildren } = await import("../../src/core/pr-review-child.ts");
          const afterLuna = await inspectPrReviewChildren({ companyId: config.companyId,
            parentIssueId: config.issueId, prUrl: config.prUrl, headSha: config.prHeadSha,
            bootstrapAgentId: config.orchestratorId, lunaAgentId: config.lunaId,
            strongAgentId: config.terraId, protocolVersion: 2, api: boardApi });
          assert.equal(afterLuna.kind, "dispatch");
          assert.equal(afterLuna.stage, "strong");
          assert.equal(afterLuna.projections.length, 1);
          const strongIdentity = { ...identity, stage: "strong", reviewerAgentId: config.terraId };
          const strongId = await ensurePrReviewChild({ identity: strongIdentity, api: boardApi });
          const strongChild = await boardApi.get(`/issues/${strongId}`);
          assert.equal(strongChild.createdByAgentId, null);
          assert.equal((await boardApi.patch(`/issues/${strongId}`, {
            status: "todo", assigneeAgentId: config.orchestratorId,
          })).assigneeAgentId, config.orchestratorId);
          await settle();
          const [strongCard] = await db.select().from(schema.issueThreadInteractions)
            .where(eq(schema.issueThreadInteractions.issueId, strongId));
          assert.equal(strongCard?.status, "pending");
          assert.equal(strongCard.addresseeAgentId, config.terraId);
          assert.equal(await activatePrReviewChild({ identity: strongIdentity, childId: strongId, api: boardApi }), "activated");
          await settle();
          const [strongVerdict] = await db.select().from(schema.issueThreadInteractions)
            .where(eq(schema.issueThreadInteractions.id, strongCard.id));
          assert.equal(strongVerdict.status, "answered");
          if (config.prBoardReject) {
            assert.equal(strongVerdict.result.items[0].verdict, "reject",
              "addressed strong PR child must produce a typed rejection, not issue prose");
            assert.ok(strongVerdict.result.items[0].reason);
            const { inspectPrReviewChildren: inspectBoardRejection } = await import("../../src/core/pr-review-child.ts");
            const verified = await inspectBoardRejection({ companyId: config.companyId, parentIssueId: config.issueId,
              prUrl: config.prUrl, headSha: config.prHeadSha, bootstrapAgentId: config.orchestratorId,
              lunaAgentId: config.lunaId, strongAgentId: config.terraId,
              protocolVersion: 2, allowRemediationStatus: true, api: boardApi });
            assert.equal(verified.kind, "rejected", "actual v2 child verdict must be reviewable before orchestrator handback");
            assert.ok(verified.projections.some((projection) => projection.id === strongCard.id));
            const pendingParent = (await db.select().from(schema.issueThreadInteractions)
              .where(eq(schema.issueThreadInteractions.issueId, config.issueId)))
              .filter((card) => card.status === "pending" && card.kind === "request_item_verdicts");
            assert.ok(pendingParent.length <= 1, "ambiguous original parent PR review authority");
            if (pendingParent.length) {
              assert.equal((await runRows()).filter((run) => run.agentId === pendingParent[0].addresseeAgentId &&
                run.contextSnapshot?.issueId === config.issueId && ["queued", "running"].includes(run.status)).length, 0,
              "do not withdraw a live addressed parent reviewer card");
              const withdrawal = await fetch(`${process.env.PAPERCLIP_API_URL}/__contract/board-api/issues/${config.issueId}/interactions/${pendingParent[0].id}/withdraw`, {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ reason: `Idle parent PR card superseded by answered native strong child ${strongCard.id} on head ${config.prHeadSha}; no verdict is inferred.` }),
                signal: AbortSignal.timeout(20_000),
              });
              assert.equal(withdrawal.status, 200, "only typed board withdrawal may retire the old parent PR authority lock");
              record("BOARD_IDLE_PARENT_CARD_TYPED_WITHDRAWAL", { cardId: pendingParent[0].id });
            }
            // The fixture executed Terra's typed verdict under the process
            // adapter. Model the production managed Codex reviewer identity
            // only after that terminal run, before orchestrator resolution;
            // resolveManagedFleet correctly rejects process as Terra.
            await db.update(agents).set({ adapterType: "codex_local" }).where(eq(agents.id, config.terraId));
            const before = report.events.filter((event) => event.name === "PROVIDER_REQUEST" &&
              event.method === "POST" && event.path === `/sessions/${config.sessionId}:sendMessage`).length;
            assert.equal(before, 0);
            await wake(config.orchestratorId, config.maintenanceIssueId, { contractBoardChildPrReject: true });
            await settle();
            for (let turn = 0; turn < 5; turn++) {
              if (report.events.some((event) => event.name === "BOARD_PR_CHILD_FEEDBACK_SENT")) break;
              const source = await issueRow();
              if (!source.monitorNextCheckAt) break;
              await heartbeat.tickTimers(new Date(new Date(source.monitorNextCheckAt).getTime() + 1));
              await settle();
            }
            const after = report.events.filter((event) => event.name === "PROVIDER_REQUEST" &&
              event.method === "POST" && event.path === `/sessions/${config.sessionId}:sendMessage`);
            assert.equal(after.length, 1, "real orchestrator must relay exactly one immutable-head v2 child rejection to original Jules session");
            assert.ok(report.events.some((event) => event.name === "BOARD_PR_CHILD_FEEDBACK_SENT" &&
              event.sessionId === config.sessionId && event.headSha === config.prHeadSha));
            assert.equal((await issueRow()).assigneeAgentId, config.julesId);
            await wake(config.orchestratorId, config.maintenanceIssueId, { contractBoardChildPrRejectReplay: true });
            await settle();
            assert.equal(report.events.filter((event) => event.name === "PROVIDER_REQUEST" &&
              event.method === "POST" && event.path === `/sessions/${config.sessionId}:sendMessage`).length, 1,
            "repeated orchestrator reconciliation must not replay same PR feedback");
            report.outcome = "board_owned_v2_strong_rejection_delivered_once_to_original_jules_session";
          } else {
          assert.equal(strongVerdict.result.items[0].verdict, "approve");
          const inspected = await inspectPrReviewChildren({ companyId: config.companyId,
            parentIssueId: config.issueId, prUrl: config.prUrl, headSha: config.prHeadSha,
            bootstrapAgentId: config.orchestratorId, lunaAgentId: config.lunaId,
            strongAgentId: config.terraId, protocolVersion: 2, api: boardApi });
          assert.equal(inspected.kind, "approved");
          assert.equal(inspected.projections.length, 2);
          assert.equal((await issueRow()).assigneeAgentId, null);
          assert.equal((await runRows()).filter((run) => run.agentId === config.orchestratorId &&
            run.contextSnapshot?.issueId === config.maintenanceIssueId).length, 0);
          assert.ok(chainGitHub, "the reviewed PR must belong to the disposable real Git repository");
          const [strongSource] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, strongVerdict.sourceRunId));
          const [strongReviewer] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, strongVerdict.resolvedByRunId));
          assert.equal(source.agentId, config.orchestratorId);
          assert.equal(strongSource?.agentId, config.orchestratorId);
          assert.equal(strongSource?.status, "succeeded");
          assert.equal(strongSource?.contextSnapshot?.issueId, strongId);
          assert.equal(strongReviewer?.agentId, config.terraId);
          assert.equal(strongReviewer?.status, "succeeded");
          assert.equal(strongReviewer?.contextSnapshot?.issueId, strongId);
          assert.ok(answered.idempotencyKey.includes(`:${childId}:${config.prUrl}:${config.prHeadSha}:luna`));
          assert.ok(strongVerdict.idempotencyKey.includes(`:${strongId}:${config.prUrl}:${config.prHeadSha}:strong`));
          const merge = await chainGitHub.externalMerge(config.prUrl, { headSha: config.prHeadSha, reviews: [
            { stage: "luna", reviewerAgentId: config.lunaId, cardId: answered.id,
              sourceRunId: source.id, resolvedByRunId: reviewer.id, verdict: answered.result.items[0].verdict },
            { stage: "strong", reviewerAgentId: config.terraId, cardId: strongVerdict.id,
              sourceRunId: strongSource.id, resolvedByRunId: strongReviewer.id, verdict: strongVerdict.result.items[0].verdict },
          ] });
          record("EXTERNAL_MERGE_VERIFIED", { headSha: merge.headSha, mergeSha: merge.mergeSha,
            cardIds: [answered.id, strongVerdict.id] });
          assert.ok(report.events.some((event) => event.name === "EXTERNAL_MERGE_VERIFIED" &&
            event.headSha === config.prHeadSha),
          "the external Git actor must merge the exact host-reviewed PR head only after both native child verdicts");
          report.outcome = "board_initiated_pr_children_luna_and_strong_approved_without_maintenance_issue";
          }
        }
        if (config.prMigrationProbe && !config.prBoardProbe) {
          await db.update(issues).set({ status: "in_review", assigneeAgentId: null }).where(eq(issues.id, config.issueId));
          if (config.parentCardWithdrawalProbe) {
            const { buildReviewInteractionRequest } = await import("../../src/core/review-interaction-state.ts");
            const request = buildReviewInteractionRequest({ issueId: config.issueId, prUrl: config.prUrl,
              headSha: config.prHeadSha, stage: "luna", reviewerAgentId: config.lunaId });
            const sourceRun = (await runRows()).find((run) => run.agentId === config.julesId &&
              run.contextSnapshot?.issueId === config.issueId && run.status === "succeeded");
            assert.ok(sourceRun);
            const [pending] = await db.insert(schema.issueThreadInteractions).values({
              companyId: config.companyId, issueId: config.issueId, kind: request.kind,
              status: "pending", continuationPolicy: request.continuationPolicy,
              idempotencyKey: request.idempotencyKey, title: request.title,
              sourceRunId: sourceRun.id, createdByAgentId: null,
              addresseeAgentId: config.lunaId, payload: request.payload,
            }).returning();
            assert.equal(pending.status, "pending");
            const reviewerRuns = (await runRows()).filter((run) => run.agentId === config.lunaId &&
              run.contextSnapshot?.issueId === config.issueId && ["queued", "running", "scheduled"].includes(run.status));
            assert.equal(reviewerRuns.length, 0);
            const withdrawn = await fetch(`${process.env.PAPERCLIP_API_URL}/__contract/board-api/issues/${config.issueId}/interactions/${pending.id}/withdraw`, {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ reason: `Superseded by a child-scoped native PR reviewer lane for immutable head ${config.prHeadSha}; no addressed reviewer run is active.` }),
              signal: AbortSignal.timeout(20_000),
            });
            assert.equal(withdrawn.status, 200, "only a board-authorized typed withdrawal can retire a board-created parent card");
            const [retired] = await db.select().from(schema.issueThreadInteractions)
              .where(eq(schema.issueThreadInteractions.id, pending.id));
            assert.equal(retired.status, "cancelled", "pending native parent PR card must be withdrawn through the typed host route");
            assert.equal(retired.sourceRunId, pending.sourceRunId);
            assert.equal((await runRows()).filter((run) => run.agentId === config.lunaId &&
              run.contextSnapshot?.issueId === config.issueId && run.startedAt).length, 0);
            record("PR_PARENT_CARD_RETIRED", { interactionId: retired.id, sourceRunId: retired.sourceRunId });
          }
          await wake(config.orchestratorId, config.maintenanceIssueId, { contractPrMigrationProbe: true });
          await settle();
          const children = await db.select().from(issues).where(eq(issues.parentId, config.issueId));
          assert.equal(children.filter((child) => child.createdByAgentId === config.orchestratorId).length, 1,
            "authenticated orchestrator maintenance run must create one child under unassigned PR parent");
          const child = children.find((candidate) => candidate.createdByAgentId === config.orchestratorId);
          assert.ok(child);
          await wake(config.orchestratorId, child.id, { contractPrMigrationBootstrap: true });
          await settle();
          assert.ok(report.events.some((event) => event.name === "PR_MIGRATION_PRODUCTION_BOOTSTRAP" &&
            event.data.childId === child.id && event.data.exitCode === 0),
          "the actual orchestrator adapter must bootstrap the child-scoped PR card");
          const [card] = await db.select().from(schema.issueThreadInteractions)
            .where(eq(schema.issueThreadInteractions.issueId, child.id));
          assert.ok(card, "the child-scoped orchestrator run must create its own addressed PR verdict card");
          assert.equal(card.status, "pending");
          assert.equal(card.addresseeAgentId, config.lunaId);
          assert.equal(card.payload.items[0].id, "pull_request");
          await wake(config.orchestratorId, config.maintenanceIssueId, { contractPrMigrationActivateChildId: child.id });
          await settle();
          const [answered] = await db.select().from(schema.issueThreadInteractions)
            .where(eq(schema.issueThreadInteractions.id, card.id));
          assert.equal(answered.status, "answered", "Luna must resolve the child-owned PR card with a typed verdict");
          assert.equal(answered.result.items[0].verdict, "approve");
          const [reviewerRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, answered.resolvedByRunId));
          assert.equal(reviewerRun.agentId, config.lunaId);
          assert.equal(reviewerRun.contextSnapshot.issueId, child.id);
          assert.equal(reviewerRun.status, "succeeded");
          assert.equal((await issueRow()).assigneeAgentId, null);
          assert.equal((await issueRow()).status, "in_review");
          await wake(config.orchestratorId, config.maintenanceIssueId, { contractPrMigrationProbe: "terra" });
          await settle();
          const prChildren = (await db.select().from(issues).where(eq(issues.parentId, config.issueId)))
            .filter((candidate) => candidate.createdByAgentId === config.orchestratorId);
          assert.equal(prChildren.length, 2, "one Luna approval must create one distinct strong-review child for the same head");
          const strongChild = prChildren.find((candidate) => candidate.id !== child.id);
          assert.ok(strongChild && strongChild.status === "backlog");
          await wake(config.orchestratorId, strongChild.id, { contractPrMigrationBootstrap: true });
          await settle();
          const [strongCard] = await db.select().from(schema.issueThreadInteractions)
            .where(eq(schema.issueThreadInteractions.issueId, strongChild.id));
          assert.ok(strongCard && (strongCard.status === "pending" || (config.prStrongGemini && strongCard.status === "answered")));
          assert.equal(strongCard.addresseeAgentId, config.terraId);
          if (config.prStrongPausedAfterCard) {
            await db.update(agents).set({ status: "paused" }).where(eq(agents.id, config.terraId));
            await wake(config.orchestratorId, config.maintenanceIssueId, { contractPrMigrationActivateChildId: strongChild.id });
            await settle();
            const [held] = await db.select().from(issues).where(eq(issues.id, strongChild.id));
            assert.equal(held.status, "backlog");
            assert.equal(held.assigneeAgentId, config.orchestratorId);
            const [heldCard] = await db.select().from(schema.issueThreadInteractions)
              .where(eq(schema.issueThreadInteractions.id, strongCard.id));
            assert.equal(heldCard.status, "pending");
            assert.equal((await runRows()).filter((run) => run.agentId === config.terraId &&
              run.contextSnapshot?.issueId === strongChild.id && run.startedAt).length, 0,
            "no model review run may start while the addressed strong reviewer is paused");
            await db.update(agents).set({ status: "idle" }).where(eq(agents.id, config.terraId));
            record("PR_STRONG_REVIEWER_RESUMED", { childId: strongChild.id });
          }
          if (strongCard.status === "pending") {
            if (config.prStrongGemini) assert.equal((await runRows()).find((run) => run.agentId === config.terraId &&
              run.contextSnapshot?.issueId === strongChild.id && run.startedAt &&
              ["failed", "cancelled", "timed_out"].includes(run.status)), undefined,
            "a terminal Gemini reviewer run requires typed recovery, never another wake");
            await wake(config.orchestratorId, config.maintenanceIssueId, { contractPrMigrationActivateChildId: strongChild.id });
            if (config.prStrongFirstTurnFailure) await waitEvent("PR_STRONG_REVIEWER_FIRST_INIT_FAILED", 0, 30_000);
            if (config.prStrongGemini) await waitEvent("PR_MIGRATION_VERDICT_WRITTEN", 0, 240_000);
            await settle();
          }
          if (config.prStrongFirstTurnFailure) {
            const [stillPending] = await db.select().from(schema.issueThreadInteractions)
              .where(eq(schema.issueThreadInteractions.id, strongCard.id));
            assert.equal(stillPending.status, "pending", "failed reviewer did not submit a typed verdict");
            const failed = (await runRows()).find((run) => run.agentId === config.terraId &&
              run.contextSnapshot?.issueId === strongChild.id && run.startedAt && run.status === "failed");
            assert.ok(failed, "one addressed reviewer failed before its model turn");
            const [action] = await db.select().from(schema.issueRecoveryActions)
              .where(eq(schema.issueRecoveryActions.sourceIssueId, strongChild.id));
            assert.ok(action, "host must record the original failed reviewer run as a typed recovery action");
            const response = await fetch(`${process.env.PAPERCLIP_API_URL}/__contract/board-api/issues/${strongChild.id}/recovery-actions/resolve`, {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ actionId: action.id, outcome: "restored", sourceIssueStatus: "todo",
                executionReconciliation: { runId: failed.id, providerStopped: true, actionOutcome: "not_performed",
                  outcomeEvidence: "The first strong reviewer fixture exited before any model turn or typed verdict; the process stopped and the same PR card remains pending." } }),
              signal: AbortSignal.timeout(20_000),
            });
            assert.equal(response.status, 200, "board-authorized typed recovery must accept verified pre-turn failure");
            await deliverReconciledExecutions(db, (agentId, opts) => heartbeat.wakeup(agentId, opts));
            await waitEvent("PR_MIGRATION_VERDICT_WRITTEN", 0, 60_000);
            await settle();
            const reviewerRuns = (await runRows()).filter((run) => run.agentId === config.terraId &&
              run.contextSnapshot?.issueId === strongChild.id && run.startedAt);
            assert.equal(reviewerRuns.filter((run) => run.status === "failed").length, 1);
            assert.equal(reviewerRuns.filter((run) => run.status === "succeeded").length, 1);
            assert.equal((await db.select().from(schema.issueThreadInteractions)
              .where(eq(schema.issueThreadInteractions.issueId, strongChild.id))).length, 1,
            "recovery must reuse the original pending PR card");
            record("PR_STRONG_REVIEWER_TYPED_RECOVERY", { cardId: strongCard.id,
              failedRunId: failed.id, restoredRunId: reviewerRuns.find((run) => run.status === "succeeded")?.id });
          }
          const [strongVerdict] = await db.select().from(schema.issueThreadInteractions)
            .where(eq(schema.issueThreadInteractions.id, strongCard.id));
          assert.equal(strongVerdict.status, "answered", "strong reviewer must issue its own typed PR verdict");
          if (config.prStrongGemini) assert.ok(["approve", "reject"].includes(strongVerdict.result.items[0].verdict));
          else assert.equal(strongVerdict.result.items[0].verdict, config.prStrongReject ? "reject" : "approve");
          if (config.prStrongReject || strongVerdict.result.items[0].verdict === "reject") assert.ok(strongVerdict.result.items[0].reason);
          const [strongRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, strongVerdict.resolvedByRunId));
          assert.equal(strongRun.agentId, config.terraId);
          assert.equal(strongRun.contextSnapshot.issueId, strongChild.id);
          assert.equal(strongRun.status, "succeeded");
          if (config.prStrongGemini) {
            const model = report.events.find((event) => event.name === "PR_MIGRATION_GEMINI_MODEL_RESULT" &&
              event.data.childId === strongChild.id);
            assert.equal(model?.data.exitCode, 0, "actual Gemini ACP PR reviewer must complete its typed native verdict");
          }
          assert.notEqual(card.id, strongCard.id);
          assert.equal((await issueRow()).status, "in_review");
          assert.equal((await issueRow()).assigneeAgentId, null);
          await wake(config.orchestratorId, config.maintenanceIssueId, { contractPrMigrationInspect: true });
          await settle();
          const expectedInspection = config.prStrongReject || strongVerdict.result.items[0].verdict === "reject" ? "rejected" : "approved";
          assert.ok(report.events.some((event) => event.name === "PR_MIGRATION_LADDER_INSPECTED" &&
            event.data.kind === expectedInspection && event.data.projections === 2),
          "production PR child inspection must attribute the strong reviewer verdict before any merge gate");
          report.outcome = config.prStrongGemini ? `gemini_native_strong_pr_${strongVerdict.result.items[0].verdict}`
            : config.prStrongReject ? "orchestrator_child_owned_strong_rejection_without_merge"
            : "orchestrator_child_owned_luna_then_strong_verdicts_on_unassigned_parent";
        }
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
    pendingLaterJulesProviderReply?.();
    pendingLaterJulesProviderReply = null;
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
