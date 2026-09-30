/** Characterize a 65-deep locked queue and qualify exact never-started host-run retirement. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const home = await mkdtemp(path.join(tmpdir(), "paperclip-queued-ancestry-"));
const install = path.resolve(process.env.PAPERCLIP_CONTRACT_NODE_MODULES ??
  path.join(homedir(), ".paperclip/cli/current/node_modules"));
process.env.PAPERCLIP_HOME = home;
process.env.PAPERCLIP_INSTANCE_ID = "queued-ancestry-contract";
process.env.PAPERCLIP_AGENT_JWT_SECRET = randomBytes(32).toString("hex");
process.env.PAPERCLIP_AGENT_JWT_DISABLE_LEGACY_FALLBACK = "true";
delete process.env.DATABASE_URL;
const require = createRequire(path.join(install, "@paperclipai/server/package.json"));
assert.equal(require("./package.json").version, "2026.916.0");
const load = (file) => import(pathToFileURL(path.join(install, file)).href);
const schema = await load("@paperclipai/db/dist/index.js");
const { eq } = await load("drizzle-orm/index.js");
const { heartbeatService } = await load("@paperclipai/server/dist/services/heartbeat.js");
const { readChatControlRecoveryStop } = await load("@paperclipai/server/dist/services/chat-control-recovery-stop.js");
const { actorMiddleware } = await load("@paperclipai/server/dist/middleware/auth.js");
const { agentRoutes } = await load("@paperclipai/server/dist/routes/agents.js");
const { errorHandler } = await load("@paperclipai/server/dist/middleware/index.js");
const pg = await schema.startEmbeddedPostgresTestDatabase("queued-ancestry-contract-");
const db = schema.createDb(pg.connectionString);
const heartbeat = heartbeatService(db);
const app = require("express")();
app.use(require("express").json());
app.use("/api", actorMiddleware(db, { deploymentMode: "local_trusted" }), agentRoutes(db));
app.use(errorHandler);
const listener = await new Promise((resolve) => { const server = app.listen(0, "127.0.0.1", () => resolve(server)); });
const base = `http://127.0.0.1:${listener.address().port}`;
const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = randomUUID();
const until = async (label, check) => {
  for (let i = 0; i < 400; i++) { const result = await check(); if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error(`Timed out: ${label}`);
};
try {
  await db.insert(schema.authUsers).values({ id: userId, name: "Board recovery owner", email: `${userId}@example.test`,
    emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  await db.insert(schema.companies).values({ id: companyId, name: "Ancestry recovery", issuePrefix: "QUE",
    issueCounter: 1, defaultResponsibleUserId: userId });
  await db.insert(schema.companyMemberships).values({ companyId, principalType: "user", principalId: userId,
    status: "active", membershipRole: "owner" });
  await db.insert(schema.agents).values({ id: agentId, companyId, name: "Original executor", role: "general",
    status: "idle", adapterType: "process", adapterConfig: { command: "true" },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } } });
  await db.insert(schema.issues).values({ id: issueId, companyId, identifier: "QUE-1", title: "Original queued source",
    status: "in_progress", assigneeAgentId: agentId,
    executionPolicy: { mode: "normal", stages: [], commentRequired: false } });
  let prior = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual",
    requestedByActorType: "user", requestedByActorId: userId, manualUserWake: true,
    payload: { issueId }, contextSnapshot: { issueId } });
  assert.ok(prior);
  await heartbeat.drainActiveRunExecutions();
  for (let depth = 2; depth <= 65; depth++) {
    // Age only completed fixture timestamps outside the unrelated wake
    // cooldown. Every success still comes from a real dispatched process.
    await db.update(schema.heartbeatRuns).set({ finishedAt: new Date(Date.now() - 86_400_000) })
      .where(eq(schema.heartbeatRuns.companyId, companyId));
    const run = await heartbeat.wakeup(agentId, { source: "automation", triggerDetail: "system",
      reason: "issue_continuation_needed", requestedByActorType: "system", requestedByActorId: null,
      idempotencyKey: `automatic-ancestry:${issueId}:${depth}`,
      payload: { issueId, retryOfRunId: prior.id }, contextSnapshot: { issueId, retryOfRunId: prior.id } });
    if (!run) {
      const receipts = await db.select().from(schema.agentWakeupRequests)
        .where(eq(schema.agentWakeupRequests.companyId, companyId));
      throw new Error(`Ancestry ${depth} not admitted: ${JSON.stringify(receipts.slice(-2).map(({ status, reason, error }) => ({ status, reason, error })))}`);
    }
    await heartbeat.drainActiveRunExecutions();
    const current = await heartbeat.getRun(run.id);
    assert.equal(current.status, depth === 65 ? "queued" : "succeeded", `ancestry ${depth}`);
    assert.equal(current.retryOfRunId, prior.id);
    prior = current;
  }
  assert.equal(prior.startedAt, null);
  const proof = await readChatControlRecoveryStop(db, { companyId, issueId, agentId, sourceRunId: prior.id });
  assert.equal(proof.kind, "unresolved");
  // The live historical queue retains its old issue execution lock. Current
  // host lazy-lock admission does not stamp a queued row; model that legacy
  // persisted lock, not a provider run or completion receipt.
  await db.update(schema.issues).set({ executionRunId: prior.id })
    .where(eq(schema.issues.id, issueId));
  const response = await fetch(`${base}/api/agents/${agentId}/wakeup`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({
      source: "on_demand", triggerDetail: "manual", reason: "resume_original_queued_ancestry",
      payload: { issueId }, idempotencyKey: `board-queue-recovery:${prior.id}`,
    }), signal: AbortSignal.timeout(30_000) });
  assert.equal(response.status, 202);
  const receipt = await response.json();
  console.log("BOARD_QUEUE_RECEIPT", JSON.stringify({ id: receipt.id ?? receipt.runId, status: receipt.status,
    reason: receipt.reason, expectedRunId: prior.id }));
  await heartbeat.resumeQueuedRuns();
  console.log("BOARD_QUEUE_PROOF", JSON.stringify({ proof: await readChatControlRecoveryStop(db,
    { companyId, issueId, agentId, sourceRunId: prior.id }),
    originalStatus: (await heartbeat.getRun(prior.id))?.status,
    wakes: (await db.select().from(schema.agentWakeupRequests).where(eq(schema.agentWakeupRequests.companyId, companyId)))
      .slice(-3).map((wake) => ({ status: wake.status, runId: wake.runId, actor: wake.requestedByActorType, reason: wake.reason })) }));
  assert.equal(receipt.status, "skipped");
  assert.equal(receipt.reason, "issue_execution_deferred");
  assert.equal((await heartbeat.getRun(prior.id)).status, "queued");
  const stop = await fetch(`${base}/api/heartbeat-runs/${prior.id}/cancel`, { method: "POST",
    headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(30_000) });
  assert.equal(stop.status, 200);
  const stopped = await stop.json();
  assert.equal(stopped.id, prior.id);
  assert.equal(stopped.status, "cancelled");
  assert.equal(stopped.startedAt, null, "the retired host run must never have dispatched a provider");
  // Cancellation releases the exact lock and promotes the already durable
  // fresh Board request. Do not post a second wake after the release.
  const next = await until("original fresh Board wake promoted", async () => {
    const wakes = await db.select().from(schema.agentWakeupRequests)
      .where(eq(schema.agentWakeupRequests.companyId, companyId));
    const wake = wakes.find((row) => row.idempotencyKey === `board-queue-recovery:${prior.id}`);
    return wake?.runId && wake.runId !== prior.id ? { id: wake.runId } : null;
  });
  await until("fresh issue-scoped run finishes", async () => (await heartbeat.getRun(next.id))?.status === "succeeded");
  await heartbeat.drainActiveRunExecutions();
  const after = await db.select().from(schema.heartbeatRuns).where(eq(schema.heartbeatRuns.companyId, companyId));
  assert.equal(after.filter((run) => run.status === "cancelled").length, 1);
  const continued = await heartbeat.getRun(next.id);
  assert.equal(continued.contextSnapshot.issueId, issueId);
  const [source] = await db.select().from(schema.issues).where(eq(schema.issues.id, issueId));
  assert.equal(source.assigneeAgentId, agentId);
  assert.equal(source.status, "in_progress");
  console.log("QUEUED_ANCESTRY_RECOVERY", JSON.stringify({ version: "2026.916.0", safe: true,
    ancestryLength: 65, retiredUnstartedRunId: prior.id, continuedRunId: next.id,
    runCount: after.length, cancelledRuns: 1, sameIssueAndOwner: true }));
} finally {
  await heartbeat.drainActiveRunExecutions();
  listener.closeAllConnections();
  await new Promise((resolve) => listener.close(resolve));
  await pg.cleanup();
  await rm(home, { recursive: true, force: true });
}
