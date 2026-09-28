import assert from "node:assert/strict";

export async function runStableChildContract(fixture) {
  const { config, report, db, schema, eq, heartbeat, wake, waitEvent, until, release, settle, issueRow, runRows, record, deliverReconciledExecutions } = fixture;
  if (config.childReviewLadder) {
    release("CHILD_VERDICT_WRITTEN");
    await wake(config.julesId, config.issueId);
    const consumed = () => new Map(report.events.filter((event) => event.name === "PARENT_CONSUMED_CHILD_VERDICT")
      .map((event) => [event.data.stage, event.data]));
    for (let turn = 0; turn < 12; turn++) {
      await settle();
      if (consumed().size === 2) break;
      const parent = await issueRow();
      assert.equal(parent.assigneeAgentId, config.julesId);
      assert.ok(parent.monitorNextCheckAt, "Jules must retain a durable monitor until both verdicts are consumed");
      await heartbeat.tickTimers(new Date(new Date(parent.monitorNextCheckAt).getTime() + 1));
    }
    await settle();
    assert.deepEqual([...consumed().keys()], ["luna", "terra"]);
    const cards = await db.select().from(schema.issueThreadInteractions).where(eq(schema.issueThreadInteractions.companyId, config.companyId));
    assert.equal(cards.length, 2);
    assert.ok(cards.every((card) => card.status === "answered" && card.payload.target.revisionId === config.revisionId));
    assert.notEqual(cards[0].issueId, cards[1].issueId);
    const runs = await runRows();
    assert.ok(runs.filter((run) => run.agentId === config.julesId).every((run) => run.status === "succeeded"));
    assert.ok(runs.filter((run) => [config.lunaId, config.terraId].includes(run.agentId) && run.startedAt)
      .every((run) => run.status === "succeeded"));
    assert.ok(report.mutations.every((mutation) => mutation.body.status !== "in_review" && mutation.body.assigneeAgentId === undefined));
    report.observations.push({ label: "stable_ladder_final", parentId: config.issueId, ownerId: (await issueRow()).assigneeAgentId,
      sessionId: config.sessionId, consumed: [...consumed().values()], cards: cards.map((card) => ({ id: card.id, childId: card.issueId,
        sourceRunId: card.sourceRunId, resolvedByRunId: card.resolvedByRunId, resolvedByAgentId: card.resolvedByAgentId })) });
    report.outcome = "luna_then_terra_children_consumed_without_parent_or_reviewer_cancellation";
    return;
  }
  await wake(config.julesId, config.issueId);
  await waitEvent("CHILD_CHECKPOINTED");
  await waitEvent("PARENT_MONITOR_ARMED");
  await settle();
  const initialParent = await issueRow();
  await heartbeat.tickTimers(new Date(new Date(initialParent.monitorNextCheckAt).getTime() + 1));
  const created = await waitEvent("CHILD_CARD_CHECKPOINTED");
  await waitEvent("PARENT_MONITOR_ARMED");
  await waitEvent("CHILD_BOOTSTRAP_FINISHED");
  await settle();
  const bootstrapParent = await issueRow();
  await heartbeat.tickTimers(new Date(new Date(bootstrapParent.monitorNextCheckAt).getTime() + 1));
  await waitEvent("CHILD_ASSIGNED_TO_REVIEWER");
  if (config.geminiFirstInitFailure) {
    const failedAttempt = await waitEvent("GEMINI_FIRST_INIT_FAILED");
    await settle();
    const failedRun = (await runRows()).find((run) => run.id === failedAttempt.runId);
    assert.equal(failedRun?.status, "failed", "first reviewer run must end before recovery");
    const [pending] = await db.select().from(schema.issueThreadInteractions)
      .where(eq(schema.issueThreadInteractions.id, created.data.cardId));
    assert.equal(pending.status, "pending");
    assert.equal(pending.payload.target.revisionId, config.revisionId);
    const [action] = await db.select().from(schema.issueRecoveryActions)
      .where(eq(schema.issueRecoveryActions.sourceIssueId, created.data.childId));
    assert.ok(action, "host must record the failed reviewer's recovery action");
    const resolution = await fetch(`${process.env.PAPERCLIP_API_URL}/__contract/board-api/issues/${created.data.childId}/recovery-actions/resolve`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ actionId: action.id, outcome: "restored", sourceIssueStatus: "todo",
        executionReconciliation: { runId: failedRun.id, providerStopped: true, actionOutcome: "not_performed",
          outcomeEvidence: "The first Gemini fixture run exited before any model turn or typed verdict; its process is stopped and the same plan card remains pending." } }),
      signal: AbortSignal.timeout(20_000),
    });
    assert.equal(resolution.status, 200, `native typed recovery must accept verified pre-turn failure (${resolution.status})`);
    const restored = await resolution.json();
    assert.equal(restored.issue.status, "todo");
    await deliverReconciledExecutions(db, (agentId, opts) => heartbeat.wakeup(agentId, opts));
    const recovery = (await runRows()).find((run) => run.agentId === config.lunaId && run.id !== failedRun.id &&
      run.contextSnapshot?.issueId === created.data.childId && ["queued", "running"].includes(run.status));
    assert.ok(recovery, "typed recovery must admit one new reviewer run without replaying failedRunId");
    await deliverReconciledExecutions(db, (agentId, opts) => heartbeat.wakeup(agentId, opts));
    const after = await runRows();
    assert.equal(after.filter((run) => run.agentId === config.lunaId && run.id !== failedRun.id &&
      run.contextSnapshot?.issueId === created.data.childId &&
      run.contextSnapshot?.wakeReason === "issue_recovery_action_restored").length, 1,
    "one typed recovery cannot dispatch twice");
    record("GEMINI_CARD_BOUND_RECOVERY", { cardId: pending.id, failedRunId: failedRun.id, recoveryRunId: recovery.id });
  }
  if (config.geminiReviewer) await waitEvent("GEMINI_MODEL_RUN_STARTED");
  const verdict = await waitEvent("CHILD_VERDICT_WRITTEN", 0, config.geminiReviewer ? 240_000 : 30_000);
  if (config.geminiReviewer) {
    const modelResult = report.events.find((event) => event.name === "GEMINI_MODEL_RESULT");
    assert.equal(modelResult?.data?.exitCode, 0, "Gemini ACP review must return success after the typed verdict");
  }
  await until("parent poll settled while reviewer remains active", async () =>
    (await runRows()).filter((run) => run.agentId === config.julesId).every((run) => !["running", "queued"].includes(run.status)));
  const before = await issueRow();
  assert.equal(before.assigneeAgentId, config.julesId);
  assert.equal(before.status, "in_progress");
  assert.equal(before.executionPolicy.monitor.serviceName, "jules");
  assert.ok((await runRows()).filter((run) => run.agentId === config.julesId).every((run) => run.status === "succeeded"));
  // Advance the host scheduler's clock to the persisted due time; no manual Jules wake.
  const nextCheckAt = new Date(before.monitorNextCheckAt);
  await heartbeat.tickTimers(new Date(nextCheckAt.getTime() + 1));
  await waitEvent("PARENT_CONSUMED_CHILD_VERDICT");
  assert.equal((await runRows()).find((run) => run.id === verdict.runId)?.status, "running");
  release("CHILD_VERDICT_WRITTEN");
  await settle();
  const [card] = await db.select().from(schema.issueThreadInteractions).where(eq(schema.issueThreadInteractions.id, created.data.cardId));
  const [child] = await db.select().from(schema.issues).where(eq(schema.issues.id, created.data.childId));
  const parent = await issueRow();
  const runs = await runRows();
  assert.equal(card.status, "answered");
  if (config.geminiReviewer) assert.ok(["approve", "reject"].includes(card.result.items[0].verdict));
  else assert.equal(card.result.items[0].verdict, config.childReviewVerdict);
  assert.equal(card.sourceRunId, created.runId);
  assert.notEqual(card.sourceRunId, verdict.runId);
  assert.equal(card.resolvedByRunId, verdict.runId);
  assert.equal(card.payload.target.issueId, config.issueId);
  assert.equal(child.parentId, config.issueId);
  assert.equal(child.assigneeAgentId, config.lunaId);
  const relations = await db.select().from(schema.issueRelations).where(eq(schema.issueRelations.companyId, config.companyId));
  assert.equal(relations.filter((relation) => relation.type === "blocks").length, 0);
  assert.equal(parent.assigneeAgentId, config.julesId);
  assert.equal(parent.status, "in_progress");
  assert.ok(runs.filter((run) => run.agentId === config.julesId).every((run) => run.status === "succeeded"));
  assert.ok(report.mutations.every((mutation) => mutation.body.status !== "in_review" && mutation.body.assigneeAgentId === undefined));
  report.observations.push({ label: "stable_child_final", parent: { id: parent.id, status: parent.status, owner: parent.assigneeAgentId },
    child: { id: child.id, status: child.status, owner: child.assigneeAgentId }, relations,
    card: { id: card.id, status: card.status, sourceRunId: card.sourceRunId, resolvedByRunId: card.resolvedByRunId, target: card.payload.target },
    runs: runs.map((run) => ({ id: run.id, agentId: run.agentId, status: run.status, errorCode: run.errorCode, issueId: run.contextSnapshot?.issueId })) });
  record("STABLE_CHILD_PROOF_COMPLETE");
  report.outcome = `${config.childReviewVerdict}_child_card_consumed_while_reviewer_active_without_parent_ownership_transfer`;
}
