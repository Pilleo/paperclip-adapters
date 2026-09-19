import { describe, expect, it } from "vitest";
import { decideJulesExecutionBlockerRecovery } from "../src/core/jules-execution-blocker-reconciliation.js";

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
