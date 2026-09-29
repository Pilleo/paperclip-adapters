/** Opt-in Paperclip v916 automatic no-replay blocker characterization; never connects to a live board. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const home = await mkdtemp(path.join(tmpdir(), "paperclip-auto-settled-terminal-"));
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
const { errorHandler } = await load("@paperclipai/server/dist/middleware/index.js");
const pg = await schema.startEmbeddedPostgresTestDatabase("terminal-auto-blocker-contract-");
const db = schema.createDb(pg.connectionString);
const heartbeat = heartbeatService(db);
const express = hostRequire("express");
const app = express();
app.use(express.json());
app.use("/api", actorMiddleware(db, { deploymentMode: "local_trusted" }), issueRoutes(db, {}));
app.use(errorHandler);
const listener = await new Promise((resolve, reject) => {
  const server = app.listen(0, "127.0.0.1", () => resolve(server));
  server.once("error", reject);
});
const url = `http://127.0.0.1:${listener.address().port}`;
const companyId = randomUUID();
const ownerId = randomUUID();
const agentId = randomUUID();
const issueId = randomUUID();
let terminalSafe = false;
const until = async (label, probe, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
};
const board = async (route, method = "GET", body) => {
  const response = await fetch(`${url}/api${route}`, { method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${method} ${route} failed (${response.status}): ${await response.text()}`);
  return response.json();
};
try {
  await db.insert(schema.authUsers).values({ id: ownerId, name: "Contract owner",
    email: `${ownerId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  await db.insert(schema.companies).values({ id: companyId, name: "Auto-settled failure contract",
    issuePrefix: "AUTO", issueCounter: 1, defaultResponsibleUserId: ownerId });
  await db.insert(schema.companyMemberships).values({ companyId, principalType: "user",
    principalId: ownerId, status: "active", membershipRole: "owner" });
  await db.insert(schema.agents).values({ id: agentId, companyId, name: "Fail before external effect",
    role: "general", status: "idle", adapterType: "process", adapterConfig: { command: "false" },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } } });
  await db.insert(schema.issues).values({ id: issueId, companyId, identifier: "AUTO-1",
    title: "Historically failed but later terminal PR task", status: "in_progress", assigneeAgentId: agentId,
    executionPolicy: { mode: "normal", stages: [], commentRequired: false } });
  await heartbeat.wakeup(agentId, { source: "automation", triggerDetail: "system",
    reason: "contract_fail_one_issue_run", payload: { issueId }, contextSnapshot: { issueId } });
  const failed = await until("real host-created failed run and active recovery action", async () => {
    const runs = await db.select().from(schema.heartbeatRuns)
      .where(eq(schema.heartbeatRuns.companyId, companyId));
    const run = runs.find((entry) => entry.status === "failed" && entry.contextSnapshot?.issueId === issueId);
    const actions = await db.select().from(schema.issueRecoveryActions)
      .where(eq(schema.issueRecoveryActions.sourceIssueId, issueId));
    return run && actions.some((action) => action.status === "active") ? run : null;
  });
  await heartbeat.drainActiveRunExecutions();
  await settleUnrecoverableExecutions(db);
  const [settled] = await db.select().from(schema.issueRecoveryActions)
    .where(eq(schema.issueRecoveryActions.sourceIssueId, issueId));
  assert.equal(settled.status, "resolved");
  assert.equal(settled.outcome, "blocked");
  assert.equal(settled.evidence.automaticRecovery?.replay, "blocked");
  assert.equal(settled.evidence.runId, failed.id);
  const before = await board(`/issues/${issueId}`);
  assert.equal(before.executionBlocker?.runId, failed.id);
  await board(`/issues/${issueId}/work-products`, "POST", { type: "pull_request", provider: "github",
    title: "Disposable externally completed PR", url: "https://github.com/paperclip-contract/fixture/pull/7",
    externalId: "https://github.com/paperclip-contract/fixture/pull/7", status: "merged", isPrimary: true,
    metadata: { source: "jules", headSha: "a".repeat(40) } });
  await board(`/issues/${issueId}`, "PATCH", {
    status: "done", assigneeAgentId: null, executionPolicy: null, executionState: null });
  const terminal = await board(`/issues/${issueId}`);
  assert.equal(terminal.status, "done");
  const blocker = terminal.executionBlocker ?? null;
  terminalSafe = blocker === null;
  const summary = { version: "2026.916.0", terminalIssueId: issueId, failedRunId: failed.id,
    automaticReplay: settled.evidence.automaticRecovery.replay,
    terminalBlockerCause: blocker?.cause ?? null, safe: terminalSafe };
  console.log("TERMINAL_AUTOMATIC_BLOCKER", JSON.stringify(summary));
} finally {
  await heartbeat.drainActiveRunExecutions();
  listener.closeAllConnections();
  await new Promise((resolve) => listener.close(resolve));
  await pg.cleanup();
  await rm(home, { recursive: true, force: true });
}
// The installed host's embedded PostgreSQL cleanup may reset process.exitCode.
// All owned resources have settled above; preserve the strict contract result.
if (process.argv.includes("--require-safe") && !terminalSafe) process.exit(2);
