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
});
