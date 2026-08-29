import { describe, it, expect } from "vitest";
import {
  createUpdateIssuePayload,
  PaperclipBoardApprovalPayloadSchema,
  UpdateIssuePayloadSchema,
} from "../src/core/paperclip-orchestrator-client.js";

describe("Paperclip Orchestrator Client Type Safety", () => {
  describe("createUpdateIssuePayload", () => {
    it("throws a type/runtime error when transition to in_progress lacks an assignee", () => {
      expect(() => createUpdateIssuePayload("in_progress", null)).toThrowError(
        "Cannot transition issue to in_progress without a non-empty assigneeAgentId"
      );
      expect(() => createUpdateIssuePayload("in_progress", "")).toThrowError(
        "Cannot transition issue to in_progress without a non-empty assigneeAgentId"
      );
    });

    it("generates valid in_progress payload when assignee is present", () => {
      const payload = createUpdateIssuePayload("in_progress", "agent-123");
      expect(payload).toEqual({ status: "in_progress", assigneeAgentId: "agent-123" });
      expect(UpdateIssuePayloadSchema.parse(payload)).toEqual(payload);
    });

    it.each(["todo", "backlog", "in_review", "done", "blocked", "cancelled"] as const)(
      "generates valid payload for status: %s without mandatory assignee",
      (status) => {
        const payload = createUpdateIssuePayload(status);
        expect(payload).toEqual({ status });
        expect(UpdateIssuePayloadSchema.parse(payload)).toEqual(payload);
      }
    );
  });

  describe("PaperclipBoardApprovalPayloadSchema", () => {
    it("validates compliant board approval payload", () => {
      const valid = {
        action: "task_start" as const,
        title: "Start Task [MAZ-101]",
        issueId: "issue-uuid-1",
        identifier: "MAZ-101",
        targetAgentId: "agent-jules",
      };
      expect(PaperclipBoardApprovalPayloadSchema.parse(valid)).toEqual(valid);
    });

    it("rejects board approval payload missing mandatory action, title, or issueId", () => {
      expect(() =>
        PaperclipBoardApprovalPayloadSchema.parse({
          action: "invalid_action",
          title: "Title",
          issueId: "id",
        })
      ).toThrow();
      expect(() =>
        PaperclipBoardApprovalPayloadSchema.parse({
          action: "task_start",
          title: "",
          issueId: "id",
        })
      ).toThrow();
    });
  });
});
