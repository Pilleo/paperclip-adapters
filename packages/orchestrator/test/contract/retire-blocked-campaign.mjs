/** Installed Paperclip v916 source-retirement qualification; isolated real PostgreSQL only. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const home = await mkdtemp(path.join(tmpdir(), "paperclip-retire-campaign-"));
const install = path.resolve(process.env.PAPERCLIP_CONTRACT_NODE_MODULES ??
  path.join(homedir(), ".paperclip/cli/current/node_modules"));
process.env.PAPERCLIP_HOME = home;
process.env.PAPERCLIP_INSTANCE_ID = "contract";
process.env.PAPERCLIP_AGENT_JWT_SECRET = randomBytes(32).toString("hex");
process.env.PAPERCLIP_AGENT_JWT_DISABLE_LEGACY_FALLBACK = "true";
delete process.env.DATABASE_URL;
const hostRequire = createRequire(path.join(install, "@paperclipai/server/package.json"));
assert.equal(hostRequire("./package.json").version, "2026.916.0");
const load = (name) => import(pathToFileURL(path.join(install, name)).href);
const schema = await load("@paperclipai/db/dist/index.js");
const { eq } = await load("drizzle-orm/index.js");
const { heartbeatService } = await load("@paperclipai/server/dist/services/heartbeat.js");
const { settleUnrecoverableExecutions } = await load("@paperclipai/server/dist/services/execution-recovery-resolution.js");
const { actorMiddleware } = await load("@paperclipai/server/dist/middleware/auth.js");
const { issueRoutes } = await load("@paperclipai/server/dist/routes/issues.js");
const { approvalRoutes } = await load("@paperclipai/server/dist/routes/approvals.js");
const { errorHandler } = await load("@paperclipai/server/dist/middleware/index.js");
const pg = await schema.startEmbeddedPostgresTestDatabase("retire-campaign-contract-");
const db = schema.createDb(pg.connectionString);
const heartbeat = heartbeatService(db);
const express = hostRequire("express");
const app = express();
app.use(express.json());
app.use("/api", actorMiddleware(db, { deploymentMode: "local_trusted" }), issueRoutes(db, {}));
app.use("/api", actorMiddleware(db, { deploymentMode: "local_trusted" }), approvalRoutes(db, {}));
app.use(errorHandler);
const listener = await new Promise((resolve, reject) => {
  const server = app.listen(0, "127.0.0.1", () => resolve(server));
  server.once("error", reject);
});
const base = `http://127.0.0.1:${listener.address().port}`;
const companyId = randomUUID();
const userId = randomUUID();
const agentId = randomUUID();
let retired = false;
const board = async (route, method = "GET", body) => {
  const res = await fetch(`${base}/api${route}`, { method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
  const raw = await res.text();
  if (!res.ok) throw new Error(`${method} ${route} rejected (${res.status}): ${raw.slice(0, 200)}`);
  return raw ? JSON.parse(raw) : null;
};
const until = async (label, check) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
};
try {
  await db.insert(schema.authUsers).values({ id: userId, name: "Contract board owner",
    email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  await db.insert(schema.companies).values({ id: companyId, name: "Retire blocked campaign contract",
    issuePrefix: "RETIRE", issueCounter: 1, defaultResponsibleUserId: userId });
  await db.insert(schema.companyMemberships).values({ companyId, principalType: "user",
    principalId: userId, status: "active", membershipRole: "owner" });
  await db.insert(schema.agents).values({ id: agentId, companyId, name: "Stopped fixture executor",
    role: "general", status: "idle", adapterType: "process", adapterConfig: { command: "false" },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } } });

  const outcomes = [];
  for (const shape of ["blocked_owned", "in_review_unassigned"]) {
    const issueId = randomUUID();
    await db.insert(schema.issues).values({ id: issueId, companyId, identifier: `RETIRE-${outcomes.length + 1}`,
      title: `Stopped source ${shape}`, status: "in_progress", assigneeAgentId: agentId,
      executionPolicy: { mode: "normal", stages: [], commentRequired: false } });
    await heartbeat.wakeup(agentId, { source: "automation", triggerDetail: "system",
      reason: `retirement_${shape}`, payload: { issueId }, contextSnapshot: { issueId } });
    const failed = await until(`${shape} failed run and active recovery`, async () => {
      const runs = await db.select().from(schema.heartbeatRuns).where(eq(schema.heartbeatRuns.companyId, companyId));
      const run = runs.find((entry) => entry.status === "failed" && entry.contextSnapshot?.issueId === issueId);
      const actions = await db.select().from(schema.issueRecoveryActions).where(eq(schema.issueRecoveryActions.sourceIssueId, issueId));
      return run && actions.some((action) => action.status === "active") ? run : null;
    });
    await heartbeat.drainActiveRunExecutions();
    await settleUnrecoverableExecutions(db);
    const [action] = await db.select().from(schema.issueRecoveryActions)
      .where(eq(schema.issueRecoveryActions.sourceIssueId, issueId));
    assert.equal(action.status, "resolved");
    assert.equal(action.evidence.automaticRecovery?.replay, "blocked");
    await board(`/issues/${issueId}/work-products`, "POST", { type: "pull_request", provider: "github",
      title: "Existing unmerged PR", url: `https://github.com/paperclip-contract/fixture/pull/${outcomes.length + 4}`,
      externalId: `https://github.com/paperclip-contract/fixture/pull/${outcomes.length + 4}`,
      status: "ready_for_review", isPrimary: true, metadata: { source: "jules", headSha: "a".repeat(40) } });
    const mergeApproval = await board(`/companies/${companyId}/approvals`, "POST", {
      type: "request_board_approval", issueIds: [issueId], payload: { action: "task_merge", issueId,
        prNumber: outcomes.length + 4, prUrl: `https://github.com/paperclip-contract/fixture/pull/${outcomes.length + 4}` },
    });
    assert.equal(mergeApproval.status, "pending");
    await db.update(schema.issues).set(shape === "blocked_owned"
      ? { status: "blocked", assigneeAgentId: agentId, executionPolicy: null, executionState: null }
      : { status: "in_review", assigneeAgentId: null, executionPolicy: null, executionState: null })
      .where(eq(schema.issues.id, issueId));
    const before = await board(`/issues/${issueId}`);
    assert.equal(before.executionBlocker?.runId, failed.id);
    const rejected = await board(`/approvals/${mergeApproval.id}/reject`, "POST", {
      decisionNote: "Fixture campaign retired after exact native no-replay execution blocker; preserve reviewed PR evidence.",
    });
    assert.equal(rejected.status, "rejected");
    const cancelled = await board(`/issues/${issueId}`, "PATCH", {
      status: "cancelled", assigneeAgentId: null, executionPolicy: null, executionState: null });
    assert.equal(cancelled.status, "cancelled");
    const after = await board(`/issues/${issueId}`);
    assert.equal(after.status, "cancelled");
    const products = await board(`/issues/${issueId}/work-products`);
    assert.equal(products.length, 1);
    assert.equal(products[0].status, "ready_for_review");
    const [settled] = await db.select().from(schema.issueRecoveryActions)
      .where(eq(schema.issueRecoveryActions.sourceIssueId, issueId));
    assert.equal(settled.id, action.id);
    assert.equal(settled.status, "resolved");
    assert.equal(settled.evidence.runId, failed.id);
    outcomes.push({ shape, status: after.status, runId: failed.id, actionId: action.id,
      projectedBlocker: after.executionBlocker?.cause ?? null });
  }
  retired = true;
  console.log("RETIRE_CAMPAIGN_CONTRACT", JSON.stringify({ version: "2026.916.0", outcomes, safe: true }));
} finally {
  await heartbeat.drainActiveRunExecutions();
  listener.closeAllConnections();
  await new Promise((resolve) => listener.close(resolve));
  await pg.cleanup();
  await rm(home, { recursive: true, force: true });
}
if (process.argv.includes("--require-safe") && !retired) process.exit(2);
