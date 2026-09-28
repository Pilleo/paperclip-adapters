import assert from "node:assert/strict";

/** Advance a registered Jules PR through the actual orchestrator and addressed native verdicts. */
export async function runChainReviewPhase({ label, issueId, pr, config, chainGitHub,
  db, schema, eq, wake, settle, runRows, record, beforeExternalMerge, onExternalMerge }) {
  const api = process.env.PAPERCLIP_API_URL;
  const issueRow = async () => (await db.select().from(schema.issues).where(eq(schema.issues.id, issueId)))[0];
  const { parsePrReviewChildDescription } = await import("../../src/core/pr-review-child.ts");
  let reviewChildren = [];
  for (let turn = 0; turn < 24; turn++) {
    const pending = (await db.select().from(schema.issueThreadInteractions)
      .where(eq(schema.issueThreadInteractions.issueId, issueId)))
      .filter((card) => card.status === "pending" && card.kind === "request_item_verdicts");
    if (pending.length) {
      assert.equal(pending.length, 1, "one exact pending parent PR authority lock is required");
      const [card] = pending;
      assert.equal(card.createdByAgentId, null);
      assert.equal(card.addresseeAgentId, config.lunaId);
      assert.ok(card.idempotencyKey?.includes(`:${issueId}:${pr.url}:${pr.headSha}:luna`));
      assert.equal((await runRows()).filter((run) => run.agentId === config.lunaId &&
        run.contextSnapshot?.issueId === issueId && ["queued", "scheduled", "running"].includes(run.status)).length, 0,
      "never withdraw a parent PR card with an active addressed reviewer run");
      const response = await fetch(`${api}/api/issues/${issueId}/interactions/${card.id}/withdraw`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: `Superseded original idle ${label} parent PR card for immutable head ${pr.headSha}; issue-scoped child review retains native provenance.` }),
        signal: AbortSignal.timeout(20_000),
      });
      assert.equal(response.status, 200, "only the native typed board withdrawal may retire a historical parent PR card");
      record(`CHAIN_${label}_PARENT_CARD_TYPED_WITHDRAWAL`, { cardId: card.id, headSha: pr.headSha });
    }
    await wake(config.orchestratorId, config.maintenanceIssueId, { contractChainReconcile: true });
    await settle();
    reviewChildren = (await db.select().from(schema.issues).where(eq(schema.issues.parentId, issueId)))
      .map((child) => ({ child, identity: parsePrReviewChildDescription(child.description) }))
      .filter(({ identity }) => identity?.parentIssueId === issueId && identity.prUrl === pr.url && identity.headSha === pr.headSha);
    if (reviewChildren.length === 2) {
      const cards = await Promise.all(reviewChildren.map(({ child }) => db.select().from(schema.issueThreadInteractions)
        .where(eq(schema.issueThreadInteractions.issueId, child.id))));
      if (cards.every((rows) => rows.length === 1 && rows[0].status === "answered")) break;
    }
  }
  assert.equal(reviewChildren.length, 2, `${label} needs distinct immutable-head Luna and strong PR children`);
  assert.deepEqual(reviewChildren.map(({ identity }) => identity.stage).sort(), ["luna", "strong"]);
  const reviews = [];
  for (const { child, identity } of reviewChildren) {
    const [card] = await db.select().from(schema.issueThreadInteractions)
      .where(eq(schema.issueThreadInteractions.issueId, child.id));
    assert.ok(card?.status === "answered", `${label} ${identity.stage} reviewer must answer its original native card`);
    assert.equal(card.result?.items?.[0]?.verdict, "approve");
    assert.equal(card.addresseeAgentId, identity.reviewerAgentId);
    assert.equal(card.resolvedByAgentId, identity.reviewerAgentId);
    assert.ok(card.idempotencyKey?.includes(`:${child.id}:${pr.url}:${pr.headSha}:${identity.stage}`));
    const [source] = await db.select().from(schema.heartbeatRuns).where(eq(schema.heartbeatRuns.id, card.sourceRunId));
    const [reviewer] = await db.select().from(schema.heartbeatRuns).where(eq(schema.heartbeatRuns.id, card.resolvedByRunId));
    assert.equal(source?.agentId, config.orchestratorId);
    assert.equal(source?.status, "succeeded");
    assert.equal(source?.contextSnapshot?.issueId, child.id);
    assert.equal(reviewer?.agentId, identity.reviewerAgentId);
    assert.equal(reviewer?.status, "succeeded");
    assert.equal(reviewer?.contextSnapshot?.issueId, child.id);
    reviews.push({ stage: identity.stage, reviewerAgentId: reviewer.agentId, cardId: card.id,
      sourceRunId: source.id, resolvedByRunId: reviewer.id, verdict: card.result.items[0].verdict });
  }
  assert.equal((await issueRow()).status, "in_review", "an unmerged PR must not be terminal");
  await beforeExternalMerge?.();
  const merge = await chainGitHub.externalMerge(pr.url, { headSha: pr.headSha,
    reviews: reviews.sort((left, right) => left.stage === "luna" ? -1 : right.stage === "luna" ? 1 : 0) });
  record(`CHAIN_${label}_EXTERNAL_MERGE`, { mergeSha: merge.mergeSha, reviewedHeadSha: merge.headSha,
    cardIds: reviews.map((review) => review.cardId) });
  await onExternalMerge?.(merge);
  for (let turn = 0; turn < 8; turn++) {
    await wake(config.orchestratorId, config.maintenanceIssueId, { contractChainReconcile: true });
    await settle();
    const [product] = await db.select().from(schema.issueWorkProducts)
      .where(eq(schema.issueWorkProducts.issueId, issueId));
    if ((await issueRow()).status === "done" && product?.status === "merged") break;
  }
  const [product] = await db.select().from(schema.issueWorkProducts)
    .where(eq(schema.issueWorkProducts.issueId, issueId));
  assert.equal((await issueRow()).status, "done", `only an observed external ${label} merge may terminalize its issue`);
  assert.equal(product?.status, "merged");
  return merge;
}
