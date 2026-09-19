import { describe, expect, it } from "vitest";
import {
  classifyAuthoritativeHeartbeatScope,
  parseHeartbeatScopeReference,
  resolveHeartbeatProjectSelection,
  type ApprovalScopeRecord,
} from "../src/core/heartbeat-project-scope.js";
import type { PaperclipProjectRecord } from "../src/core/parser.js";

const projects: readonly PaperclipProjectRecord[] = [
  { id: "project-a", primaryWorkspace: { cwd: "/tmp/project-a" } },
  { id: "project-b", primaryWorkspace: { cwd: "/tmp/project-b" } },
];

describe("heartbeat project scope", () => {
  it.each([
    {
      name: "recovers a project scope from the run when the invocation omits it",
      runId: "run-1",
      agentId: "orch-1",
      invocationContext: { companyId: "company-1" },
      run: {
        id: "run-1",
        agentId: "orch-1",
        contextSnapshot: {
          wakeSource: "on_demand",
          wakeReason: "paperclip-orchestrator-scope/v1/project/project-b",
        },
      },
      expected: { kind: "resolved", reference: { kind: "project", projectId: "project-b" } },
    },
    {
      name: "permits all projects only for an authoritative scheduler timer",
      runId: "run-1",
      agentId: "orch-1",
      invocationContext: {},
      run: {
        id: "run-1",
        agentId: "orch-1",
        contextSnapshot: { source: "scheduler", reason: "interval_elapsed" },
      },
      expected: { kind: "resolved", reference: { kind: "unscoped_timer" } },
    },
    {
      name: "rejects an unscoped on-demand wake",
      runId: "run-1",
      agentId: "orch-1",
      invocationContext: {},
      run: {
        id: "run-1",
        agentId: "orch-1",
        contextSnapshot: { wakeSource: "on_demand", wakeReason: "manual" },
      },
      expected: { kind: "invalid", reason: "unscoped_on_demand" },
    },
    {
      name: "rejects a heartbeat record for another run",
      runId: "run-1",
      agentId: "orch-1",
      invocationContext: {},
      run: { id: "run-2", agentId: "orch-1", contextSnapshot: {} },
      expected: { kind: "invalid", reason: "run_identity_mismatch" },
    },
    {
      name: "rejects a heartbeat record for another agent",
      runId: "run-1",
      agentId: "orch-1",
      invocationContext: {},
      run: { id: "run-1", agentId: "other-agent", contextSnapshot: {} },
      expected: { kind: "invalid", reason: "agent_identity_mismatch" },
    },
    {
      name: "rejects conflicting invocation and authoritative project scopes",
      runId: "run-1",
      agentId: "orch-1",
      invocationContext: { projectId: "project-a" },
      run: { id: "run-1", agentId: "orch-1", contextSnapshot: { projectId: "project-b" } },
      expected: { kind: "invalid", reason: "scope_conflict" },
    },
    {
      name: "rejects a missing run id",
      runId: "",
      agentId: "orch-1",
      invocationContext: { projectId: "project-a" },
      run: {},
      expected: { kind: "invalid", reason: "missing_run_id" },
    },
    {
      name: "rejects a run without a context snapshot",
      runId: "run-1",
      agentId: "orch-1",
      invocationContext: {},
      run: { id: "run-1", agentId: "orch-1" },
      expected: { kind: "invalid", reason: "missing_context_snapshot" },
    },
    {
      name: "rejects a malformed reserved scope envelope",
      runId: "run-1",
      agentId: "orch-1",
      invocationContext: {},
      run: {
        id: "run-1",
        agentId: "orch-1",
        contextSnapshot: {
          wakeSource: "on_demand",
          wakeReason: "paperclip-orchestrator-scope/v1/project/",
        },
      },
      expected: { kind: "invalid", reason: "malformed_explicit_scope" },
    },
    {
      name: "accepts matching issue scope evidence",
      runId: "run-1",
      agentId: "orch-1",
      invocationContext: { issueId: "issue-a" },
      run: { id: "run-1", agentId: "orch-1", contextSnapshot: { issueId: "issue-a" } },
      expected: { kind: "resolved", reference: { kind: "issue", issueId: "issue-a" } },
    },
    {
      name: "accepts an approval scope from the authoritative snapshot",
      runId: "run-1",
      agentId: "orch-1",
      invocationContext: {},
      run: { id: "run-1", agentId: "orch-1", contextSnapshot: { approvalId: "approval-a" } },
      expected: { kind: "resolved", reference: { kind: "approval", approvalId: "approval-a" } },
    },
  ] as const)("$name", ({ runId, agentId, invocationContext, run, expected }) => {
    expect(classifyAuthoritativeHeartbeatScope({ runId, agentId, invocationContext, run })).toEqual(expected);
  });

  it.each([
    ["direct project", { projectId: "project-b" }, { kind: "project", projectId: "project-b" }],
    ["Paperclip issue payload", { issueId: "issue-b" }, { kind: "issue", issueId: "issue-b" }],
    ["Paperclip task payload", { taskId: "issue-b" }, { kind: "issue", issueId: "issue-b" }],
    ["approval wake", { approvalId: "approval-b" }, { kind: "approval", approvalId: "approval-b" }],
    [
      "preserved explicit project wake",
      {
        wakeSource: "on_demand",
        wakeReason: "paperclip-orchestrator-scope/v1/project/project-b",
      },
      { kind: "project", projectId: "project-b" },
    ],
    ["unscoped timer", {}, { kind: "unscoped_timer" }],
  ] as const)("parses %s without widening scope", (_name, context, expected) => {
    expect(parseHeartbeatScopeReference(context)).toEqual(expected);
  });

  it("resolves an approval-only wake from its payload issue id", async () => {
    const approvals: readonly ApprovalScopeRecord[] = [{
      id: "approval-b",
      issueIds: [],
      payload: { issueId: "issue-b" },
    }];
    const result = await resolveHeartbeatProjectSelection({
      projects,
      reference: { kind: "approval", approvalId: "approval-b" },
      approvals,
      getIssue: async (id) => ({ id, projectId: "project-b" }),
    });
    expect(result).toEqual({ kind: "scoped", project: projects[1] });
  });

  it("fails closed when an approval spans projects", async () => {
    const result = await resolveHeartbeatProjectSelection({
      projects,
      reference: { kind: "approval", approvalId: "approval-cross" },
      approvals: [{ id: "approval-cross", issueIds: ["issue-a", "issue-b"] }],
      getIssue: async (id) => ({ id, projectId: id.endsWith("a") ? "project-a" : "project-b" }),
    });
    expect(result).toEqual({ kind: "invalid", reason: "cross_project_approval" });
  });

  it("keeps an unscoped timer as the only all-project case", async () => {
    const result = await resolveHeartbeatProjectSelection({
      projects,
      reference: { kind: "unscoped_timer" },
      approvals: [],
      getIssue: async () => ({ id: "unused", projectId: "project-a" }),
    });
    expect(result).toEqual({ kind: "all_projects", projects });
  });

  it("fails closed instead of widening a malformed explicit project wake", async () => {
    const reference = parseHeartbeatScopeReference({
      wakeSource: "on_demand",
      wakeReason: "paperclip-orchestrator-scope/v1/project/",
    });
    expect(reference).toEqual({ kind: "invalid_explicit_scope" });

    const result = await resolveHeartbeatProjectSelection({
      projects,
      reference,
      approvals: [],
      getIssue: async () => ({ id: "unused", projectId: "project-a" }),
    });
    expect(result).toEqual({ kind: "invalid", reason: "invalid_explicit_scope" });
  });
});
