import { describe, expect, it } from "vitest";
import { evaluateIssueScopedRun } from "../src/server/issue-scoped-run.js";

describe("evaluateIssueScopedRun", () => {
  it.each([
    [{ runId: "run-1", context: { issueId: "issue-1" }, issueId: "issue-1" }, { kind: "scoped", runId: "run-1" }],
    [{ runId: "run-1", context: { taskId: "issue-1" }, issueId: "issue-1" }, { kind: "scoped", runId: "run-1" }],
    [{ runId: "run-1", context: { task: { id: "issue-1" } }, issueId: "issue-1" }, { kind: "scoped", runId: "run-1" }],
    [{ runId: "run-1", context: { paperclipIssue: { id: "issue-1" } }, issueId: "issue-1" }, { kind: "scoped", runId: "run-1" }],
    [{ runId: "run-1", context: { issueId: "issue-2" }, issueId: "issue-1" }, { kind: "unscoped", code: "issue_context_mismatch" }],
    [{ runId: "run-1", context: {}, issueId: "issue-1" }, { kind: "unscoped", code: "issue_context_missing" }],
    [{ runId: "", context: { issueId: "issue-1" }, issueId: "issue-1" }, { kind: "unscoped", code: "run_id_missing" }],
  ] as const)("classifies %j", (input, expected) => {
    expect(evaluateIssueScopedRun(input)).toMatchObject(expected);
  });
});
