import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { saveStoredSession, loadStoredSession } from "../../../jules/src/server/session-store.ts";

/** Run the real Jules executor twice against isolated, authenticated Paperclip and PostgreSQL. */
export async function runJulesExecutorRecoveryContract({ config, report, db, schema, eq, wake, settle, runRows, issueRow, heartbeat }) {
  const oldStore = process.env.PAPERCLIP_JULES_SESSION_STORE_DIR;
  process.env.PAPERCLIP_JULES_SESSION_STORE_DIR = config.sessionStoreDir;
  try {
    const checkpoint = JSON.parse(await readFile(config.checkpointPath, "utf8"));
    assert.equal(checkpoint.identity.stage, "terra");
    assert.ok(checkpoint.childId);
    const [card] = await db.select().from(schema.issueThreadInteractions)
      .where(eq(schema.issueThreadInteractions.issueId, checkpoint.childId));
    assert.equal(card.status, "answered");
    assert.equal(card.result.items[0].verdict, "approve");
    const session = {
      version: 1, paperclipIssueId: config.issueId, promptHash: "fixture-prompt", promptHashVersion: 2,
      source: "sources/github/paperclip-contract/fixture", repository: "paperclip-contract/fixture", baseBranch: "main",
      phase: "WAITING_FOR_PLAN_APPROVAL", sessionId: config.sessionId, julesSessionId: config.sessionId,
      attempt: 1, failedSessions: [], createdAt: new Date().toISOString(),
      childPlanReview: { identity: checkpoint.identity, childId: checkpoint.childId },
      lifecycleEffectJournal: { version: 1, effects: [{
        effectId: `approve:${config.sessionId}:${config.revisionId}`, kind: "approve_plan",
        attempt: { kind: "confirmed", receipt: "provider:fixture-approved-activity" },
      }] },
    };
    await saveStoredSession(session);
    await writeFile(config.staleSessionPath, JSON.stringify(session), { mode: 0o600 });
    const priorRuns = (await runRows()).filter((row) => row.agentId === config.julesId).length;
    await wake(config.julesId, config.issueId, { contractJulesExecute: true });
    await settle();
    const first = (await runRows()).filter((row) => row.agentId === config.julesId).slice(priorRuns);
    assert.equal(first.length, 1, "exactly one resumed Jules executor run must be admitted");
    assert.equal(first[0].status, "succeeded", JSON.stringify(first[0].resultJson));
    const saved = await loadStoredSession(config.issueId, session.source, session.baseBranch);
    assert.ok(saved, "real executor must checkpoint the original session");
    assert.equal(saved.julesSessionId, config.sessionId);
    assert.equal(saved.childPlanReview, undefined, "answered Terra gate is retired after matching confirmed approval");
    assert.equal(saved.lifecycleEffectJournal.effects.length, 1);
    assert.equal((await db.select().from(schema.issueWorkProducts)
      .where(eq(schema.issueWorkProducts.issueId, config.issueId))).length, 0, "restart must precede PR registration");

    // A fresh host run deliberately supplies the same stale runtime envelope.
    // The executor must merge the durable checkpoint rather than replay a verdict or approval.
    await wake(config.julesId, config.issueId, { contractJulesExecute: true });
    await settle();
    const resumed = (await runRows()).filter((row) => row.agentId === config.julesId).slice(priorRuns);
    assert.equal(resumed.length, 2);
    assert.equal(resumed[1].status, "succeeded", JSON.stringify(resumed[1].resultJson));
    // The process fixture invokes the real external executor but its host
    // wrapper otherwise stores only process stdout, not AdapterExecutionResult.
    // Preserve exactly the actual returned evidence for producer hydration.
    const actualResult = report.events.filter((event) => event.name === "REAL_JULES_EXECUTOR_RESULT").at(-1)?.data.adapterResult;
    assert.ok(actualResult?.handoffPending && actualResult.julesState === "COMPLETED");
    await db.update(schema.heartbeatRuns).set({ resultJson: { ...resumed[1].resultJson, ...actualResult,
      stopReason: "completed" } }).where(eq(schema.heartbeatRuns.id, resumed[1].id));
    const products = await db.select().from(schema.issueWorkProducts)
      .where(eq(schema.issueWorkProducts.issueId, config.issueId));
    assert.equal(products.length, 1, "real Jules executor registers one PR work product");
    assert.equal(products[0].url, config.prUrl);
    assert.equal(products[0].status, "ready_for_review");
    report.observations.push({ label: "executor_pr_evidence", metadata: products[0].metadata,
      summary: products[0].summary, runResult: resumed[1].resultJson });
    assert.equal(products[0].metadata.headSha, config.prHeadSha);
    assert.equal((await issueRow()).status, "in_progress", "orchestrator owns the later typed PR-review transition");
    if (process.env.PAPERCLIP_TEST_TERMINAL_HANDOFF_WAIT === "1") {
      assert.ok((await issueRow()).monitorNextCheckAt,
        "terminal PR must keep a durable handoff wait until orchestrator routing");
      const before = await runRows();
      for (let sweep = 0; sweep < 3; sweep++) await heartbeat.reconcileStrandedAssignedIssues();
      await settle();
      assert.equal((await runRows()).filter((run) => !before.some((old) => old.id === run.id) &&
        run.contextSnapshot?.issueId === config.issueId &&
        run.contextSnapshot?.wakeReason === "issue_continuation_needed").length, 0,
      "normal host recovery sweeps must not enqueue terminal PR continuation churn");
      const terminalResult = report.events.filter((event) => event.name === "REAL_JULES_EXECUTOR_RESULT").at(-1);
      assert.equal(terminalResult.data.julesState, "COMPLETED");
      assert.equal(terminalResult.data.handoffPending, true);
      const monitor = await issueRow();
      await heartbeat.tickTimers(new Date(new Date(monitor.monitorNextCheckAt).getTime() + 1));
      await settle();
      assert.ok((await issueRow()).monitorNextCheckAt,
        "delayed orchestrator handoff must renew a bounded monitor after one original-session poll");
      assert.equal((await db.select().from(schema.issueWorkProducts)
        .where(eq(schema.issueWorkProducts.issueId, config.issueId))).length, 1);
      assert.equal(report.events.filter((event) => event.name === "PROVIDER_REQUEST" && event.method !== "GET").length, 0);
    }
    const providerRequests = report.events.filter((event) => event.name === "PROVIDER_REQUEST");
    assert.ok(providerRequests.length > 0, "both runs must inspect the provider state");
    assert.ok(providerRequests.every((event) => event.method === "GET"), "never repeat a provider mutation");
    assert.equal((await db.select().from(schema.issueThreadInteractions)
      .where(eq(schema.issueThreadInteractions.companyId, config.companyId))).length, 2, "no duplicate native cards");
    if (!config.prMigrationProbe && !config.producerConflictProbe) {
      const { runPrChildReviewContract } = await import("./native-pr-child-review-contract.mjs");
      await runPrChildReviewContract({ config, report, db, schema, eq, wake, settle, runRows, issueRow });
    }
    report.observations.push({ label: "real_jules_executor_restart", runIds: resumed.map((row) => row.id),
      sessionId: config.sessionId, cardId: card.id, productId: products[0].id,
      providerReads: providerRequests.length, providerWrites: 0 });
    report.outcome = config.prMigrationProbe ? "actual_jules_executor_restart_pr_registered_for_child_creation_probe"
      : "actual_jules_executor_restart_pr_registered_and_child_scoped_pr_review_resolved";
  } finally {
    if (oldStore === undefined) delete process.env.PAPERCLIP_JULES_SESSION_STORE_DIR;
    else process.env.PAPERCLIP_JULES_SESSION_STORE_DIR = oldStore;
  }
}
