import { z } from "zod";
import { ParsedIssueMetadata, IssueStatus } from "./types.js";

export const PaperclipBoardApprovalPayloadSchema = z.object({
  action: z.enum(["task_start", "task_cancel", "task_clarify"]),
  title: z.string().min(1),
  description: z.string().optional(),
  issueId: z.string().min(1),
  identifier: z.string().optional(),
  targetAgentId: z.string().optional(),
  priority: z.string().optional(),
  component: z.string().optional(),
  targetFiles: z.array(z.string()).optional(),
  reason: z.string().optional(),
});

export type PaperclipBoardApprovalPayload = z.infer<typeof PaperclipBoardApprovalPayloadSchema>;

export const UpdateIssuePayloadSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("in_progress"),
    assigneeAgentId: z.string().min(1, "in_progress issues require an explicit assigneeAgentId"),
  }),
  z.object({
    status: z.literal("in_review"),
    assigneeAgentId: z.string().optional(),
  }),
  z.object({
    status: z.literal("done"),
    assigneeAgentId: z.string().optional(),
  }),
  z.object({
    status: z.literal("todo"),
    assigneeAgentId: z.string().optional(),
  }),
  z.object({
    status: z.literal("backlog"),
    assigneeAgentId: z.string().optional(),
  }),
  z.object({
    status: z.literal("blocked"),
    assigneeAgentId: z.string().optional(),
  }),
  z.object({
    status: z.literal("cancelled"),
    assigneeAgentId: z.string().optional(),
  }),
]);

export type UpdateIssuePayload = z.infer<typeof UpdateIssuePayloadSchema>;

export function createUpdateIssuePayload(status: IssueStatus, assigneeAgentId?: string | null): UpdateIssuePayload {
  if (status === "in_progress") {
    if (!assigneeAgentId || assigneeAgentId.trim().length === 0) {
      throw new Error("Cannot transition issue to in_progress without a non-empty assigneeAgentId");
    }
    return { status: "in_progress", assigneeAgentId };
  }
  return { status, ...(assigneeAgentId ? { assigneeAgentId } : {}) };
}
