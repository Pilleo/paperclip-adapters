import { ParsedIssueMetadata } from "./types.js";

export interface PaperclipApprovalSummary {
  id: string;
  type: string;
  status: "pending" | "approved" | "rejected";
  issueIds: string[];
  title?: string;
  description?: string;
  payload?: Record<string, unknown>;
}

export type ApprovalDecision =
  | { action: "DISPATCH"; reason: string }
  | { action: "CREATE_APPROVAL_REQUEST"; title: string; description: string; issueId: string; targetAgentId: string }
  | { action: "AWAIT_APPROVAL"; approvalId: string; reason: string }
  | { action: "SKIP_REJECTED"; approvalId: string; reason: string };

export function evaluateTaskStartApproval(
  issue: ParsedIssueMetadata,
  targetAgentId: string,
  existingApprovals: readonly PaperclipApprovalSummary[],
  requireApproval: boolean = true
): ApprovalDecision {
  if (!requireApproval) {
    return { action: "DISPATCH", reason: "Approval gate disabled" };
  }

  // Find existing start approval for this issue
  const matchingApproval = existingApprovals.find(
    (app) => app.type === "task_start_approval" && app.issueIds.includes(issue.id)
  );

  if (!matchingApproval) {
    const title = `Start task [${issue.identifier || issue.id}]: "${issue.title}"`;
    const filesDesc = issue.targetFiles.length > 0 ? `\nTarget Files: ${issue.targetFiles.join(", ")}` : "";
    const description = `The task is prioritized and ready for dispatch.\n\nComponent: ${issue.component || "core"}\nPriority: ${issue.priority}${filesDesc}\nPlanned Agent: ${targetAgentId}`;
    return {
      action: "CREATE_APPROVAL_REQUEST",
      title,
      description,
      issueId: issue.id,
      targetAgentId,
    };
  }

  if (matchingApproval.status === "approved") {
    return {
      action: "DISPATCH",
      reason: `Operator approved task start (approval ${matchingApproval.id})`,
    };
  }

  if (matchingApproval.status === "rejected") {
    return {
      action: "SKIP_REJECTED",
      approvalId: matchingApproval.id,
      reason: `Operator rejected task start (approval ${matchingApproval.id})`,
    };
  }

  return {
    action: "AWAIT_APPROVAL",
    approvalId: matchingApproval.id,
    reason: `Awaiting operator start approval in Paperclip (approval ${matchingApproval.id})`,
  };
}
