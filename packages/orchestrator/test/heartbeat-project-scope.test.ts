import { describe, expect, it } from "vitest";
import {
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
    ["direct project", { projectId: "project-b" }, { kind: "project", projectId: "project-b" }],
    ["Paperclip issue payload", { issueId: "issue-b" }, { kind: "issue", issueId: "issue-b" }],
    ["Paperclip task payload", { taskId: "issue-b" }, { kind: "issue", issueId: "issue-b" }],
    ["approval wake", { approvalId: "approval-b" }, { kind: "approval", approvalId: "approval-b" }],
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
});
