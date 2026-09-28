import assert from "node:assert/strict";

/** Prove that a PR verdict can be issued by the reviewer on an issue it actually owns. */
export async function runPrChildReviewContract({ config, report, db, schema, eq, wake, settle, runRows, issueRow }) {
  await db.insert(schema.issues).values({ id: config.prReviewChildId, companyId: config.companyId,
    identifier: "RACE-9000", title: "Review immutable Jules PR head", description: `Review ${config.prUrl} at ${config.prHeadSha}`,
    status: "backlog", parentId: config.issueId, assigneeAgentId: config.orchestratorId,
    executionPolicy: { mode: "normal", stages: [], commentRequired: false } });
  const before = (await runRows()).length;
  await wake(config.orchestratorId, config.prReviewChildId);
  await settle();
  const [card] = await db.select().from(schema.issueThreadInteractions)
    .where(eq(schema.issueThreadInteractions.issueId, config.prReviewChildId));
  assert.ok(card, "child-scoped, addressed native PR card must be created by its child bootstrap run");
  assert.equal(card.status, "pending", "a parked child must not start the reviewer before parent activation");
  assert.equal(card.addresseeAgentId, config.lunaId);
  assert.equal(card.payload.items[0].id, "pull_request");
  assert.equal((await issueRow()).assigneeAgentId, config.julesId, "parent must keep Jules ownership");
  const child = (await db.select().from(schema.issues).where(eq(schema.issues.id, config.prReviewChildId)))[0];
  assert.equal(child.assigneeAgentId, config.orchestratorId);
  assert.equal(child.status, "backlog");
  // The parent owns the activation transition after the child bootstrap has
  // settled. Its issue-scoped host run transfers only the child to Luna.
  await wake(config.julesId, config.issueId, { contractPrChildActivate: true });
  await settle();
  const [answered] = await db.select().from(schema.issueThreadInteractions)
    .where(eq(schema.issueThreadInteractions.id, card.id));
  assert.equal(answered.status, "answered");
  assert.equal(answered.result.items[0].verdict, "approve");
  assert.equal(answered.sourceRunId, (await runRows()).find((row) => row.agentId === config.orchestratorId &&
    row.contextSnapshot?.issueId === config.prReviewChildId)?.id);
  const reviewerRun = (await runRows()).find((row) => row.id === answered.resolvedByRunId);
  assert.equal(reviewerRun?.status, "succeeded");
  assert.equal(reviewerRun.agentId, config.lunaId);
  assert.equal(reviewerRun.contextSnapshot.issueId, config.prReviewChildId);
  const reviewerRuns = (await runRows()).filter((row) => row.agentId === config.lunaId &&
    row.contextSnapshot?.issueId === config.prReviewChildId && row.startedAt);
  assert.ok(reviewerRuns.length >= 1);
  assert.ok(reviewerRuns.every((row) => row.status === "succeeded"),
    "late host reviewer runs must only observe the already-answered card");
  assert.equal(report.events.filter((event) => event.name === "PR_CHILD_VERDICT_WRITTEN").length, 1,
    "one PR child card may receive exactly one typed verdict even when the host starts an extra observer run");
  assert.equal((await issueRow()).status, "in_progress");
  assert.equal((await db.select().from(schema.issueWorkProducts)
    .where(eq(schema.issueWorkProducts.issueId, config.issueId))).length, 1);
  assert.equal((await db.select().from(schema.issueThreadInteractions)
    .where(eq(schema.issueThreadInteractions.companyId, config.companyId))).length, 3);
  report.observations.push({ label: "pr_child_issue_scoped_verdict", cardId: card.id,
    bootstrapRunId: answered.sourceRunId, reviewerRunId: answered.resolvedByRunId,
    childId: config.prReviewChildId, parentId: config.issueId, startedReviewerRuns: reviewerRuns.length,
    runsAfterBootstrap: (await runRows()).length - before });
}
