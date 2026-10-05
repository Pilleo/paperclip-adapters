import { describe, expect, it } from "vitest";
import { buildJulesExecutionReconciliationPayload, decideJulesExecutionBlockerRecovery } from "../src/core/jules-execution-blocker-reconciliation.js";
import { childPlanReviewDescription, childPlanReviewKey } from "@pilleo/paperclip-adapter-common";

const actionId = "9e44e46e-a8eb-422f-a35a-236e3cad1cc0";
const runId = "c3c1a60e-12b1-4a7e-8cc3-79498b705f27";

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    issueStatus: "blocked",
    assigneeAgentId: "jules-orch",
    julesAgentId: "jules-orch",
    providerSessionId: "jules-session-1535",
    executionBlocker: {
      recoveryActionId: actionId,
      runId,
      agentId: "jules-orch",
      cause: "legacy_execution_requires_reconciliation",
    },
    failedRun: {
      id: runId,
      status: "failed",
      agentId: "jules-orch",
      errorCode: "jules_polling_error",
      finishedAt: "2026-09-18T02:39:12.896Z",
    },
    ...overrides,
  };
}

describe("Jules execution blocker reconciliation", () => {
  function observationSnapshot() {
    const identity = { version: 4 as const, companyId: "company", parentIssueId: "issue", sessionId: "jules-session-1535",
      activityId: "activity", documentId: "document", revisionId: "revision", revisionNumber: 1,
      stage: "terra" as const, julesAgentId: "jules-orch", bootstrapAgentId: "jules-orch", reviewerAgentId: "strong" };
    return { ...snapshot(), issueId: "issue", companyId: "company",
      failedRun: { id: runId, companyId: "company", agentId: "jules-orch", status: "failed",
        errorCode: "native_child_plan_provider_state_conflict",
        error: "Cannot continue the typed plan review (unverified_progress); same-session reconciliation is required.",
        contextSnapshot: { issueId: "issue" }, finishedAt: "2026-10-04T21:00:52Z" },
      planObservationEvidence: {
        taskSession: { companyId: "company", agentId: "jules-orch", adapterType: "jules", taskKey: "issue", lastRunId: runId,
          sessionParamsJson: { paperclipIssueId: "issue", julesSessionId: identity.sessionId, sessionId: identity.sessionId,
            phase: "WAITING_FOR_PLAN_APPROVAL", julesState: "IN_PROGRESS",
            activityCheckpoint: { id: identity.activityId }, childPlanReview: { identity, childId: "child" },
            mutationCheckpoint: { operation: "save_plan_document", status: "succeeded", issueId: "issue",
              sessionId: identity.sessionId, activityId: identity.activityId } } },
        document: { id: identity.documentId, latestRevisionId: identity.revisionId, latestRevisionNumber: 1 },
        child: { id: "child", companyId: "company", parentId: "issue", createdByAgentId: "jules-orch",
          assigneeAgentId: "jules-orch", status: "backlog", executionBlocker: null,
          description: childPlanReviewDescription(identity) },
        cards: [] as Record<string, unknown>[], runs: [] as Record<string, unknown>[],
      },
    };
  }

  it("automatically returns an exact legacy provider-observation hold to its original session without declaring effects absent", () => {
    const decision = decideJulesExecutionBlockerRecovery(observationSnapshot());
    expect(decision).toMatchObject({ action: "resolve_to_todo", recoveryBasis: "plan_observation", runId });
    if (decision.action !== "resolve_to_todo") return;
    expect(buildJulesExecutionReconciliationPayload(decision)).toMatchObject({
      executionReconciliation: { runId, providerStopped: true, actionOutcome: "mixed",
        outcomeEvidence: expect.stringContaining("provider mutations remain gated") },
    });
  });

  it("does not mistake a generic activity-delivery cursor for the exact reviewed plan identity", () => {
    const s = observationSnapshot();
    s.planObservationEvidence.taskSession.sessionParamsJson.activityCheckpoint.id = "later-progress-update";
    expect(decideJulesExecutionBlockerRecovery(s)).toMatchObject({ action: "resolve_to_todo", recoveryBasis: "plan_observation" });
  });

  it.each(["pending", "answered", "bootstrapped"])("retains an original %s reviewer card during legacy observation convergence", phase => {
    const status = phase === "bootstrapped" ? "pending" : phase;
    const s = observationSnapshot();
    const e = s.planObservationEvidence;
    const identity = e.taskSession.sessionParamsJson.childPlanReview.identity;
    e.child.assigneeAgentId = phase === "bootstrapped" ? identity.bootstrapAgentId : identity.reviewerAgentId;
    e.child.status = status === "answered" ? "done" : "backlog";
    e.cards.push({ id: "card", companyId: "company", issueId: "child", kind: "request_item_verdicts", status,
      idempotencyKey: childPlanReviewKey(identity), addresseeAgentId: identity.reviewerAgentId,
      sourceRunId: "bootstrap-run", payload: { target: { type: "issue_document", issueId: "issue", key: "plan",
        documentId: identity.documentId, revisionId: identity.revisionId, revisionNumber: 1 } },
      ...(status === "answered" ? { resolvedByRunId: "reviewer-run", result: { outcome: "resolved", complete: true,
        items: [{ id: "plan", verdict: "approve" }] } } : {}) });
    e.runs.push({ id: "bootstrap-run", companyId: "company", agentId: "jules-orch", status: "succeeded", contextSnapshot: { issueId: "child" } });
    if (status === "answered") e.runs.push({ id: "reviewer-run", companyId: "company", agentId: "strong", status: "succeeded", contextSnapshot: { issueId: "child" } });
    expect(decideJulesExecutionBlockerRecovery(s)).toMatchObject({ action: "resolve_to_todo", recoveryBasis: "plan_observation" });
    e.runs.push({ id: "active-reviewer", companyId: "company", agentId: "strong", status: "running", contextSnapshot: { issueId: "child" } });
    expect(decideJulesExecutionBlockerRecovery(s)).toMatchObject({ action: "preserve" });
  });

  it.each(["session", "owner", "revision", "effect", "mutation", "child", "run", "output", "state", "reason"])(
    "preserves the hold when observation migration has a conflicting %s", conflict => {
      const s = observationSnapshot();
      const evidence = s.planObservationEvidence;
      const p = evidence.taskSession.sessionParamsJson as Record<string, unknown>;
      if (conflict === "session") p.julesSessionId = "foreign";
      if (conflict === "owner") evidence.taskSession.agentId = "foreign";
      if (conflict === "revision") evidence.document.latestRevisionId = "foreign";
      if (conflict === "effect") p.lifecycleEffectJournal = { version: 1, effects: [{ attempt: { kind: "started" } }] };
      if (conflict === "mutation") evidence.taskSession.sessionParamsJson.mutationCheckpoint.status = "pending";
      if (conflict === "child") evidence.child.createdByAgentId = "foreign";
      if (conflict === "run") evidence.taskSession.lastRunId = "foreign";
      if (conflict === "output") p.currentPrUrl = "https://github.com/example/repo/pull/1";
      if (conflict === "state") p.julesState = "COMPLETED";
      if (conflict === "reason") s.failedRun.error = "Cannot apply the typed verdict (unverified_progress).";
      expect(decideJulesExecutionBlockerRecovery(s)).toMatchObject({ action: "preserve" });
    });

  it("returns one typed recovery command for a terminal polling run with a durable session", () => {
    expect(decideJulesExecutionBlockerRecovery(snapshot())).toEqual({
      action: "resolve_to_todo",
      actionId,
      runId,
      providerSessionId: "jules-session-1535",
      recoveryBasis: "polling_failure",
      reason: "terminal Jules polling run left a durable provider continuation behind a legacy execution hold",
    });
  });

  it("acknowledges Paperclip's terminal execution while retaining the durable provider handle", () => {
    const decision = decideJulesExecutionBlockerRecovery(snapshot());
    expect(decision.action).toBe("resolve_to_todo");
    if (decision.action !== "resolve_to_todo") return;
    expect(buildJulesExecutionReconciliationPayload(decision)).toMatchObject({
      executionReconciliation: {
        providerStopped: true,
        actionOutcome: "mixed",
      },
    });
  });

  it("reconciles a non-polling legacy failure after a newer successful run continued the same issue", () => {
    expect(decideJulesExecutionBlockerRecovery(snapshot({
      issueId: "issue-1543",
      failedRun: {
        id: runId,
        status: "failed",
        agentId: "jules-orch",
        errorCode: "paperclip_completion_interaction_failed",
        finishedAt: "2026-09-19T18:47:11.012Z",
      },
      supersedingRuns: [{
        id: "3b7d25a5-1ae2-4068-84f0-3a07f3672a6b",
        status: "succeeded",
        agentId: "jules-orch",
        issueId: "issue-1543",
        startedAt: "2026-09-19T20:51:28.760Z",
        finishedAt: "2026-09-19T20:51:40.556Z",
      }],
    }))).toMatchObject({
      action: "resolve_to_todo",
      recoveryBasis: "superseding_success",
    });
  });

  it("reconciles an interrupted monitor run caused by a graceful Paperclip restart", () => {
    expect(decideJulesExecutionBlockerRecovery(snapshot({
      failedRun: {
        id: runId,
        status: "interrupted",
        agentId: "jules-orch",
        errorCode: "server_shutdown_interrupted",
        finishedAt: "2026-09-20T18:00:01.000Z",
      },
    }))).toMatchObject({
      action: "resolve_to_todo",
      recoveryBasis: "server_shutdown",
    });
  });

  it.each([
    ["another issue", { issueId: "other-issue" }],
    ["another owner", { agentId: "other-agent" }],
    ["a non-success", { status: "failed" }],
    ["an older run", { startedAt: "2026-09-19T18:46:00.000Z", finishedAt: "2026-09-19T18:46:30.000Z" }],
  ])("does not let %s supersede a non-polling blocker", (_name, successorOverride) => {
    expect(decideJulesExecutionBlockerRecovery(snapshot({
      issueId: "issue-1543",
      failedRun: {
        id: runId,
        status: "failed",
        agentId: "jules-orch",
        errorCode: "paperclip_completion_interaction_failed",
        finishedAt: "2026-09-19T18:47:11.012Z",
      },
      supersedingRuns: [{
        id: "successor-run",
        status: "succeeded",
        agentId: "jules-orch",
        issueId: "issue-1543",
        startedAt: "2026-09-19T20:51:28.760Z",
        finishedAt: "2026-09-19T20:51:40.556Z",
        ...successorOverride,
      }],
    }))).toMatchObject({ action: "preserve" });
  });

  it.each([
    ["issue is outside implementation recovery", { issueStatus: "in_review" }],
    ["assignee is not Jules", { assigneeAgentId: "other-agent" }],
    ["provider session is absent", { providerSessionId: null }],
    ["blocker cause is unrelated", { executionBlocker: { recoveryActionId: actionId, runId, agentId: "jules-orch", cause: "reviewer_unavailable" } }],
    ["blocker action id is malformed", { executionBlocker: { recoveryActionId: "bad", runId, agentId: "jules-orch", cause: "legacy_execution_requires_reconciliation" } }],
    ["run id is malformed", { executionBlocker: { recoveryActionId: actionId, runId: "bad", agentId: "jules-orch", cause: "legacy_execution_requires_reconciliation" } }],
    ["run identity differs", { failedRun: { id: "4d114d60-f118-430f-99fe-d0f05479641a", status: "failed", agentId: "jules-orch", errorCode: "jules_polling_error", finishedAt: "2026-09-18T02:39:12.896Z" } }],
    ["run is not terminal", { failedRun: { id: runId, status: "running", agentId: "jules-orch", errorCode: "jules_polling_error", finishedAt: null } }],
    ["run owner differs", { failedRun: { id: runId, status: "failed", agentId: "other-agent", errorCode: "jules_polling_error", finishedAt: "2026-09-18T02:39:12.896Z" } }],
    ["failure is not polling", { failedRun: { id: runId, status: "failed", agentId: "jules-orch", errorCode: "unknown_failure", finishedAt: "2026-09-18T02:39:12.896Z" } }],
  ])("preserves state when %s", (_name, overrides) => {
    expect(decideJulesExecutionBlockerRecovery(snapshot(overrides))).toMatchObject({ action: "preserve" });
  });

  it.each(["blocked", "todo", "in_progress"])("reconciles the hold from Paperclip's %s projection", (issueStatus) => {
    expect(decideJulesExecutionBlockerRecovery(snapshot({ issueStatus }))).toMatchObject({
      action: "resolve_to_todo",
      actionId,
      runId,
    });
  });
});
