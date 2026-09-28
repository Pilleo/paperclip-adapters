// Executed only by vanilla Paperclip's process adapter in the disposable contract host.
import assert from "node:assert/strict";
import { decideNativePlanReviewReconciliation } from "../../src/core/native-plan-review-reconciliation.ts";

const env = process.env;
const config = JSON.parse(env.CONTRACT_FIXTURE);
const base = env.PAPERCLIP_API_URL;
assert.equal(new URL(base).hostname, "127.0.0.1");
assert.ok(env.PAPERCLIP_API_KEY, "host must mint the worker token");
assert.ok(env.PAPERCLIP_RUN_ID, "host must assign the worker run");
const headers = { Authorization: `Bearer ${env.PAPERCLIP_API_KEY}`,
  "X-Paperclip-Run-Id": env.PAPERCLIP_RUN_ID, "Content-Type": "application/json" };
async function request(path, method = "GET", body) {
  const response = await fetch(`${base}/api${path}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(90_000),
  });
  const data = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}
async function event(name, data = {}, wait = false) {
  const response = await fetch(`${base}/__contract/events`, {
    method: "POST", headers, body: JSON.stringify({ name, data, wait }), signal: AbortSignal.timeout(90_000),
  });
  assert.equal(response.status, 200, `barrier ${name}`);
}
const run = await request(`/heartbeat-runs/${env.PAPERCLIP_RUN_ID}`);
assert.equal(run.agentId, env.PAPERCLIP_AGENT_ID);
assert.equal(run.status, "running");
const issueId = run.contextSnapshot.issueId;
const note = () => request(`/issues/${issueId}/comments`, "POST", {
  body: "Contract fixture execution reached its observation checkpoint. Any review decision is recorded only on the typed card.",
});

switch (env.PAPERCLIP_AGENT_ID) {
  case config.julesId: {
    const cards = await request(`/issues/${issueId}/interactions`);
    if (cards.length) {
      assert.equal(cards.length, 1);
      assert.equal(cards[0].status, "answered");
      await event("JULES_STARTED", { issueId, interactionId: cards[0].id });
      await note();
      break;
    }
    const card = await request(`/issues/${issueId}/interactions`, "POST", {
      kind: "request_item_verdicts", addresseeAgentId: config.lunaId,
      idempotencyKey: `jules:plan-review:v2:${issueId}:${config.sessionId}:${config.revisionId}:luna`,
      continuationPolicy: "none", resolverPolicy: "anyone",
      payload: { version: 1, prompt: "Inspect the contract fixture plan", items: [{ id: "plan", label: "Plan" }],
        verdicts: ["approve", "reject"], requireReasonOn: ["reject"],
        target: { type: "issue_document", issueId, documentId: config.documentId, key: "plan",
          revisionId: config.revisionId, revisionNumber: 1 } },
    });
    await event("SOURCE_CARD_READY", { interactionId: card.id });
    // This request may cancel this process. All necessary fixture context precedes it.
    await request(`/issues/${issueId}`, "PATCH", { status: "in_review", executionPolicy: {
      mode: "normal", commentRequired: false,
      stages: [{ id: config.stageId, type: "review", participants: [{ type: "agent", agentId: config.lunaId }] }],
    }, reviewRequest: { instructions: "Inspect the existing typed plan card." } });
    break;
  }
  case config.lunaId: {
    if (issueId === config.blockerIssueId) {
      await event("BLOCKER_STARTED", {}, true);
      await note();
      break;
    }
    const cards = await request(`/issues/${issueId}/interactions`);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].addresseeAgentId, env.PAPERCLIP_AGENT_ID);
    if (run.contextSnapshot.contractCompetitor === true) {
      assert.equal(cards[0].status, "answered");
      await event("COMPETING_REVIEWER_STARTED", { interactionId: cards[0].id }, true);
    } else if (cards[0].status === "pending") {
      const answered = await request(`/issues/${issueId}/interactions/${cards[0].id}/verdicts`, "POST", {
        verdicts: [{ id: "plan", verdict: "approve" }],
      });
      assert.equal(answered.resolvedByRunId, env.PAPERCLIP_RUN_ID);
      await event("VERDICT_WRITTEN", { interactionId: cards[0].id }, true);
    } else {
      await event("REVIEWER_FOLLOWUP", { interactionId: cards[0].id });
    }
    await note();
    break;
  }
  case config.orchestratorId: {
    // Hydrate actual host run details: the list projection omits stage/card context.
    const summaries = await request(`/companies/${config.companyId}/heartbeat-runs?agentId=${config.lunaId}&limit=1000`);
    assert.ok(Array.isArray(summaries) && summaries.length < 1000);
    const details = await Promise.all(summaries.map((summary) => request(`/heartbeat-runs/${summary.id}`)));
    const runs = details.filter((candidate) => candidate.contextSnapshot?.issueId === config.issueId);
    const cards = await request(`/issues/${config.issueId}/interactions`);
    assert.equal(cards.length, 1);
    const sourceRun = await request(`/heartbeat-runs/${cards[0].sourceRunId}`);
    const document = await request(`/issues/${config.issueId}/documents/plan`);
    const issue = await request(`/issues/${config.issueId}`);
    const decision = decideNativePlanReviewReconciliation({
      companyId: config.companyId, issueId: config.issueId, ownerId: config.julesId, reviewerId: config.lunaId,
      sessionId: config.sessionId, issue, cards, document, sourceRun, runs, runsComplete: true,
    });
    await event("EVIDENCE_READ", { decision, owner: issue.assigneeAgentId,
      executionRunId: issue.executionRunId, reviewerRuns: runs.map(({ id, status }) => ({ id, status })) });
    switch (decision.kind) {
      case "return_to_jules": {
        await event("PATCH_READY", { interactionId: decision.interactionId }, true);
        const response = await fetch(`${base}/api/issues/${config.issueId}`, {
          method: "PATCH", headers, body: JSON.stringify({ executionPolicy: null }), signal: AbortSignal.timeout(60_000),
        });
        if (run.contextSnapshot.contractLoseResponse === true) {
          // Discard the response at the transport boundary; do not infer success from its status/body.
          await response.body?.cancel();
          await event("PATCH_RESPONSE_LOST");
        } else {
          const result = await response.json();
          await event("PATCH_RESULT", { status: response.status, issueStatus: result.status,
            assigneeAgentId: result.assigneeAgentId, error: result.code ?? result.details?.code ?? null });
        }
        break;
      }
      case "await_verdict":
      case "await_reviewer_settlement":
      case "verify_jules_continuation":
        break;
      case "conflict":
        throw new Error(`Reconciliation evidence conflict: ${decision.reason}`);
      default:
        throw new Error(`Unknown reconciliation decision ${JSON.stringify(decision)}`);
    }
    await note();
    break;
  }
  default:
    throw new Error("Unknown fixture worker identity");
}
