/** Installed Paperclip 2026.916 no-PR card reissue and settled failed-run recovery. Real PostgreSQL. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertContractVersion } from "../../../orchestrator/test/contract/host-installation.mjs";

const home = await mkdtemp(path.join(tmpdir(), "paperclip-no-pr-recovery-"));
const install = path.resolve(process.env.PAPERCLIP_CONTRACT_NODE_MODULES ??
  path.join(homedir(), ".paperclip/cli/current/node_modules"));
process.env.PAPERCLIP_HOME = home;
process.env.PAPERCLIP_INSTANCE_ID = "no-pr-recovery-contract";
process.env.PAPERCLIP_AGENT_JWT_SECRET = randomBytes(32).toString("hex");
process.env.PAPERCLIP_AGENT_JWT_DISABLE_LEGACY_FALLBACK = "true";
delete process.env.DATABASE_URL;
const hostRequire = createRequire(path.join(install, "@paperclipai/server/package.json"));
const version = assertContractVersion(hostRequire("./package.json").version);
const load = (name) => import(pathToFileURL(path.join(install, name)).href);
const schema = await load("@paperclipai/db/dist/index.js");
const { eq } = await load("drizzle-orm/index.js");
const { heartbeatService } = await load("@paperclipai/server/dist/services/heartbeat.js");
const { settleUnrecoverableExecutions, deliverReconciledExecutions } =
  await load("@paperclipai/server/dist/services/execution-recovery-resolution.js");
const { actorMiddleware } = await load("@paperclipai/server/dist/middleware/auth.js");
const { issueRoutes } = await load("@paperclipai/server/dist/routes/issues.js");
const { agentRoutes } = await load("@paperclipai/server/dist/routes/agents.js");
const { errorHandler } = await load("@paperclipai/server/dist/middleware/index.js");
const pg = await schema.startEmbeddedPostgresTestDatabase("no-pr-recovery-contract-");
const db = schema.createDb(pg.connectionString);
const heartbeat = heartbeatService(db);
const express = hostRequire("express");
const app = express();
app.use(express.json());
app.use("/api", actorMiddleware(db, { deploymentMode: "local_trusted" }), issueRoutes(db, {}));
app.use("/api", actorMiddleware(db, { deploymentMode: "local_trusted" }), agentRoutes(db));
app.use(errorHandler);
const listener = await new Promise((resolve, reject) => {
  const server = app.listen(0, "127.0.0.1", () => resolve(server));
  server.once("error", reject);
});
const base = `http://127.0.0.1:${listener.address().port}`;
process.env.PAPERCLIP_API_URL = base;
const companyId = randomUUID(), issueId = randomUUID(), userId = randomUUID(), agentId = randomUUID();
let safe = false;
const board = async (route, method = "GET", body) => {
  const response = await fetch(`${base}/api${route}`, { method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${text.slice(0, 160)}`);
  return text ? JSON.parse(text) : null;
};
const until = async (label, check) => {
  for (let attempt = 0; attempt < 500; attempt++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
};
try {
  await db.insert(schema.authUsers).values({ id: userId, name: "No PR recovery owner",
    email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  await db.insert(schema.companies).values({ id: companyId, name: "No PR recovery", issuePrefix: "NPR",
    issueCounter: 1, defaultResponsibleUserId: userId });
  await db.insert(schema.companyMemberships).values({ companyId, principalType: "user", principalId: userId,
    status: "active", membershipRole: "owner" });
  await db.insert(schema.agents).values({ id: agentId, companyId, name: "Original worker", role: "general",
    status: "idle", adapterType: "process", adapterConfig: { command: "false" },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } } });
  await db.insert(schema.issues).values({ id: issueId, companyId, identifier: "NPR-1", title: "Required PR missing",
    status: "in_progress", assigneeAgentId: agentId,
    executionPolicy: { mode: "normal", stages: [], commentRequired: false } });
  await heartbeat.wakeup(agentId, { source: "automation", triggerDetail: "system", reason: "contract_no_pr_failure",
    payload: { issueId }, contextSnapshot: { issueId } });
  const failed = await until("original failed source and active recovery", async () => {
    const [run] = await db.select().from(schema.heartbeatRuns).where(eq(schema.heartbeatRuns.companyId, companyId));
    const [action] = await db.select().from(schema.issueRecoveryActions)
      .where(eq(schema.issueRecoveryActions.sourceIssueId, issueId));
    return run?.status === "failed" && action?.status === "active" ? { run, action } : null;
  });
  await heartbeat.drainActiveRunExecutions();
  await settleUnrecoverableExecutions(db);
  const [settled] = await db.select().from(schema.issueRecoveryActions)
    .where(eq(schema.issueRecoveryActions.sourceIssueId, issueId));
  assert.equal(settled.id, failed.action.id);
  assert.equal(settled.evidence.automaticRecovery?.replay, "blocked");
  await db.update(schema.issues).set({ status: "blocked", assigneeAgentId: agentId })
    .where(eq(schema.issues.id, issueId));
  const { createNoPrCompletionInteraction } = await import("../../src/server/paperclip-client.ts");
  const sessionId = "1234567890123456789";
  const original = await board(`/issues/${issueId}/interactions`, "POST", {
    kind: "request_confirmation", idempotencyKey: `jules:no-pr-completion:${issueId}:${sessionId}`,
    title: "Original Jules completion confirmation", summary: "No pull request was created.",
    continuationPolicy: "wake_assignee", payload: { version: 1,
      prompt: "Jules completed without a PR. Is this task complete?", acceptLabel: "Mark done",
      rejectLabel: "Keep blocked", rejectRequiresReason: false },
  });
  assert.equal(original.status, "pending");
  await board(`/issues/${issueId}/interactions/${original.id}/withdraw`, "POST", {
    reason: "Superseded by an unresolved Jules provider question",
  });
  await assert.rejects(() => createNoPrCompletionInteraction(issueId, sessionId, undefined, undefined),
    /409.*Interaction idempotency key already exists for a different request/);
  const reissued = await createNoPrCompletionInteraction(issueId, sessionId, undefined, undefined, undefined, original.id);
  assert.equal(reissued.status, "pending");
  assert.notEqual(reissued.id, original.id);
  const cards = await board(`/issues/${issueId}/interactions`);
  assert.deepEqual(cards.filter((card) => card.status === "pending").map((card) => card.id), [reissued.id]);
  assert.equal(cards.find((card) => card.id === original.id)?.status, "cancelled");
  await db.update(schema.agents).set({ adapterConfig: { command: "true" } }).where(eq(schema.agents.id, agentId));
  const recovered = await board(`/issues/${issueId}/recovery-actions/resolve`, "POST", {
    actionId: settled.id, outcome: "restored", sourceIssueStatus: "todo",
    executionReconciliation: { runId: failed.run.id, providerStopped: true,
      actionOutcome: "completed", outcomeEvidence: "The exact failed worker has exited. Its original interaction is cancelled; a distinct pending native card is now bound to this issue. No external provider mutation was attempted." },
  });
  assert.equal(recovered.issue?.id ?? recovered.id, issueId);
  await deliverReconciledExecutions(db, (id, options) => heartbeat.wakeup(id, options));
  await heartbeat.drainActiveRunExecutions();
  const issue = await board(`/issues/${issueId}`);
  const [action] = await db.select().from(schema.issueRecoveryActions)
    .where(eq(schema.issueRecoveryActions.id, settled.id));
  assert.equal(action.evidence.executionReconciliation.runId, failed.run.id);
  assert.equal(issue.executionBlocker, null);
  assert.equal(cards.find((card) => card.id === reissued.id)?.status, "pending");
  safe = true;
  console.log("NO_PR_RECOVERY_CONTRACT", JSON.stringify({ version, safe,
    oldCardStatus: "cancelled", newCardStatus: "pending", actionId: action.id,
    failedRunId: failed.run.id, issueStatus: issue.status }));
} finally {
  await heartbeat.drainActiveRunExecutions();
  listener.closeAllConnections();
  await new Promise((resolve) => listener.close(resolve));
  await pg.cleanup();
  await rm(home, { recursive: true, force: true });
}
if (process.argv.includes("--require-safe") && !safe) process.exit(2);
