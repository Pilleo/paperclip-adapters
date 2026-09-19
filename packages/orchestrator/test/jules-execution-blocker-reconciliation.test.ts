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
      reason: "terminal Jules polling run left a durable provider continuation behind a legacy execution hold",
    });
  });

  it.each([
    ["issue is not blocked", { issueStatus: "in_progress" }],
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
});
