/** Real Paperclip v916/PostgreSQL admission barrier across the idle/restart window. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { drainAndRestart } from "../../../../scripts/fleet/task-drain-reload.mjs";

const home = await mkdtemp(path.join(tmpdir(), "paperclip-drain-reload-"));
const install = path.resolve(process.env.PAPERCLIP_CONTRACT_NODE_MODULES ??
  path.join(homedir(), ".paperclip/cli/current/node_modules"));
process.env.PAPERCLIP_HOME = home;
process.env.PAPERCLIP_INSTANCE_ID = "drain-reload-contract";
process.env.PAPERCLIP_AGENT_JWT_SECRET = randomBytes(32).toString("hex");
process.env.PAPERCLIP_AGENT_JWT_DISABLE_LEGACY_FALLBACK = "true";
delete process.env.DATABASE_URL;
const require = createRequire(path.join(install, "@paperclipai/server/package.json"));
assert.equal(require("./package.json").version, "2026.916.0");
const load = (name) => import(pathToFileURL(path.join(install, name)).href);
const schema = await load("@paperclipai/db/dist/index.js");
const { eq } = await load("drizzle-orm/index.js");
const { heartbeatService } = await load("@paperclipai/server/dist/services/heartbeat.js");
const { actorMiddleware } = await load("@paperclipai/server/dist/middleware/auth.js");
const { instanceSettingsRoutes } = await load("@paperclipai/server/dist/routes/instance-settings.js");
const { agentRoutes } = await load("@paperclipai/server/dist/routes/agents.js");
const { companyRoutes } = await load("@paperclipai/server/dist/routes/companies.js");
const { errorHandler } = await load("@paperclipai/server/dist/middleware/index.js");
const pg = await schema.startEmbeddedPostgresTestDatabase("task-drain-reload-");
const db = schema.createDb(pg.connectionString);
const heartbeat = heartbeatService(db);
const app = require("express")();
app.use(require("express").json());
app.use("/api", actorMiddleware(db, { deploymentMode: "local_trusted" }),
  instanceSettingsRoutes(db), agentRoutes(db));
app.use("/api/companies", actorMiddleware(db, { deploymentMode: "local_trusted" }), companyRoutes(db));
app.use(errorHandler);
const listener = await new Promise((resolve) => { const server = app.listen(0, "127.0.0.1", () => resolve(server)); });
const base = `http://127.0.0.1:${listener.address().port}`;
const companyId = randomUUID(), userId = randomUUID(), agentId = randomUUID();
const request = async (method, route, body) => {
  const response = await fetch(`${base}${route}`, { method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw Error(`${method} ${route} returned ${response.status}`);
  return response.json();
};
const runRows = () => db.select().from(schema.heartbeatRuns).where(eq(schema.heartbeatRuns.companyId, companyId));
try {
  await db.insert(schema.authUsers).values({ id: userId, name: "Drain contract owner", email: `${userId}@example.test`,
    emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  await db.insert(schema.companies).values({ id: companyId, name: "Drain reload contract", issuePrefix: "DRAIN",
    defaultResponsibleUserId: userId });
  await db.insert(schema.companyMemberships).values({ companyId, principalType: "user", principalId: userId,
    status: "active", membershipRole: "owner" });
  await db.insert(schema.agents).values({ id: agentId, companyId, name: "Real scheduled process", role: "general",
    status: "idle", adapterType: "process", adapterConfig: { command: process.execPath,
      args: ["-e", "setTimeout(()=>console.log('original work finished'),400)"] },
    runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true, maxConcurrentRuns: 1 } } });
  const original = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual",
    requestedByActorType: "user", requestedByActorId: userId, manualUserWake: true });
  assert.ok(original);
  let stoppedRunCount = 0;
  await drainAndRestart({ request, waitMs: 30_000, pollMs: 50, restart: async () => {
    const state = await request("GET", "/api/instance/task-drain");
    assert.equal(state.draining, true);
    assert.equal(state.quiescent, true);
    const settled = await heartbeat.getRun(original.id);
    assert.equal(settled.status, "succeeded", "existing worker must finish rather than be cancelled for reload");
    stoppedRunCount = (await runRows()).length;
    // Force the timer precisely after idle reads and before simulated process
    // replacement. This is the window that previously lost a heartbeat.
    await heartbeat.tickTimers(new Date(Date.now() + 120_000));
    await heartbeat.drainActiveRunExecutions();
    assert.equal((await runRows()).length, stoppedRunCount, "task drain must block the racing scheduler admission");
    assert.equal((await request("GET", "/api/instance/task-drain")).draining, true);
    // A new Paperclip process resets the process-local drain. Model that reset
    // only after the old-process stop boundary; no restart of the live service.
    heartbeat.stopTaskDrain();
  } });
  await heartbeat.tickTimers(new Date(Date.now() + 120_000));
  await heartbeat.drainActiveRunExecutions();
  const after = await runRows();
  assert.ok(after.length > stoppedRunCount, "scheduler must resume after replacement-process drain reset");
  assert.equal(after.filter((run) => run.errorCode === "process_lost" || run.status === "cancelled").length, 0);
  console.log("TASK_DRAIN_RELOAD_CONTRACT", JSON.stringify({ version: "2026.916.0", safe: true,
    originalRunId: original.id, admissionBlockedBeforeRestart: true, resumedAfterReset: true }));
} finally {
  heartbeat.stopTaskDrain();
  await heartbeat.drainActiveRunExecutions();
  listener.closeAllConnections();
  await new Promise((resolve) => listener.close(resolve));
  await pg.cleanup();
  await rm(home, { recursive: true, force: true });
}
