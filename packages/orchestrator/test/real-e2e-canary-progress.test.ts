import { describe, expect, it } from "vitest";
import { evaluateCanaryDependencyProgress, parseCanaryIssueSnapshot } from "../src/core/real-e2e-canary-progress.js";

const issue = (id: string, status: string, overrides: Record<string, unknown> = {}) => ({
  id,
  title: `Canary ${id}`,
  status,
  description: `---\norchestrator_managed: true\n---\n<!-- paperclip-adapters:e2e-run:test -->`,
  orchestratorManaged: true,
  blockedBy: [],
  assigneeAgentId: null,
  executionRunId: null,
  workProducts: [],
  ...overrides,
});

const completed = (id: string, status: string) => status === "done"
  ? { workProducts: [{ type: "pull_request", status: "merged", url: `https://example.test/${id}` }] }
  : {};

const chain = (aStatus: string, bStatus: string, cStatus: string) => ({
  julesAgentId: "jules",
  a: issue("a", aStatus, completed("a", aStatus)),
  b: issue("b", bStatus, { blockedBy: [{ id: "a", status: aStatus }], ...completed("b", bStatus) }),
  c: issue("c", cStatus, { blockedBy: [{ id: "b", status: bStatus }], ...completed("c", cStatus) }),
});

describe("evaluateCanaryDependencyProgress", () => {
  it("parses a persisted issue only when its managed metadata and blocker projection are valid", () => {
    expect(parseCanaryIssueSnapshot(issue("a", "todo"))).toMatchObject({
      id: "a",
      orchestratorManaged: true,
      blockedBy: [],
      workProducts: [],
    });
    expect(parseCanaryIssueSnapshot({ id: "missing", status: "todo" })).toEqual({
      kind: "invalid_snapshot",
      reason: "missing_description",
    });
  });

  it("holds both descendants before A is terminal", () => {
    expect(evaluateCanaryDependencyProgress(chain("in_progress", "todo", "backlog"))).toEqual({
      kind: "await_a",
      activeIssueId: "a",
    });
  });

  it("releases only B after A is done", () => {
    expect(evaluateCanaryDependencyProgress(chain("done", "in_progress", "todo"))).toEqual({
      kind: "await_b",
      activeIssueId: "b",
    });
  });

  it("releases only C after B is done", () => {
    expect(evaluateCanaryDependencyProgress(chain("done", "done", "in_progress"))).toEqual({
      kind: "await_c",
      activeIssueId: "c",
    });
  });

  it("rejects an early Jules-owned dependent", () => {
    expect(evaluateCanaryDependencyProgress({
      ...chain("in_progress", "in_progress", "todo"),
      b: issue("b", "in_progress", { blockedBy: [{ id: "a", status: "in_progress" }], assigneeAgentId: "jules" }),
    })).toEqual({ kind: "invalid", reason: "b_started_before_a_terminal" });
  });

  it("requires every terminal canary to have exactly one merged PR", () => {
    const completedChain = chain("done", "done", "done");
    expect(evaluateCanaryDependencyProgress({ ...completedChain, a: { ...completedChain.a, workProducts: [] } })).toEqual({
      kind: "invalid",
      reason: "a_missing_merged_pull_request",
    });
  });

  it("refuses to report a completed chain while a terminal issue has an actionable failed-run hold", () => {
    const finished = chain("done", "done", "done");
    const persisted = parseCanaryIssueSnapshot({
      ...finished.c,
      executionBlocker: {
        runId: "failed-jules-run",
        cause: "legacy_execution_requires_reconciliation",
        nextAction: "Automatic recovery stopped",
      },
    });
    expect(persisted).not.toHaveProperty("kind", "invalid_snapshot");
    expect(evaluateCanaryDependencyProgress({ ...finished, c: persisted as typeof finished.c })).toEqual({
      kind: "invalid",
      reason: "c_done_with_actionable_execution_blocker",
    });
  });

  it("does not release B when A has a terminal failed-run hold", () => {
    const current = chain("done", "todo", "backlog");
    expect(evaluateCanaryDependencyProgress({
      ...current,
      a: { ...current.a, executionBlocker: { runId: "failed-a", cause: "legacy_execution_requires_reconciliation" } },
    })).toEqual({ kind: "invalid", reason: "a_done_with_actionable_execution_blocker" });
  });

  it("rejects malformed execution blockers at the transport boundary", () => {
    expect(parseCanaryIssueSnapshot(issue("a", "done", { executionBlocker: { cause: "legacy_execution_requires_reconciliation" } })))
      .toEqual({ kind: "invalid_snapshot", reason: "malformed_execution_blocker" });
  });
});
