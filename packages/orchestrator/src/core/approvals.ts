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
  | {
      action: "CREATE_APPROVAL_REQUEST";
      title: string;
      description: string;
      issueId: string;
      targetAgentId: string;
      issueUrl?: string | undefined;
    }
  | { action: "AWAIT_APPROVAL"; approvalId: string; reason: string }
  | { action: "SKIP_REJECTED"; approvalId: string; reason: string };

export function evaluateTaskStartApproval(
  issue: ParsedIssueMetadata,
  targetAgentId: string,
  existingApprovals: readonly PaperclipApprovalSummary[],
  requireApproval: boolean = true,
  options: { companyUrlKey?: string; apiUrl?: string } = {}
): ApprovalDecision {
  if (!requireApproval) {
    return { action: "DISPATCH", reason: "Approval gate disabled" };
  }

  // Find existing start approval for this issue
  const matchingApproval = existingApprovals.find(
    (app) =>
      (app.type === "task_start_approval" ||
        (app.type === "request_board_approval" && app.payload?.["action"] === "task_start")) &&
      (app.issueIds.includes(issue.id) || app.payload?.["issueId"] === issue.id)
  );

  if (!matchingApproval) {
    const urlKey = options.companyUrlKey || "MAZ";
    const issueLink = `http://localhost:3100/${urlKey}/issues/${issue.identifier || issue.id}`;
    const title = `Start task [${issue.identifier || issue.id}]: "${issue.title}"`;

    const symbolsDesc =
      issue.targetSymbols && issue.targetSymbols.length > 0
        ? `\n**Target Symbols:** ${issue.targetSymbols.map((s) => `\`${s}\``).join(", ")}`
        : "";

    const filesDesc =
      issue.targetFiles && issue.targetFiles.length > 0
        ? `\n**Target Files:**\n${issue.targetFiles.map((f) => `- \`${f}\``).join("\n")}`
        : "";

    const description = `### 📋 Task Start Authorization Request

🔗 **Paperclip Issue:** [${issue.identifier || issue.id}: ${issue.title}](${issueLink})

| Attribute | Value |
|---|---|
| **Issue Identifier** | \`${issue.identifier || issue.id}\` |
| **Priority** | **${issue.priority.toUpperCase()}** |
| **Component** | \`${issue.component || "core"}\` |
| **Target Worker** | \`${targetAgentId}\` |
${symbolsDesc}${filesDesc}

*Approving this authorization will dispatch the worker to begin implementation.*`;

    return {
      action: "CREATE_APPROVAL_REQUEST",
      title,
      description,
      issueId: issue.id,
      targetAgentId,
      issueUrl: issueLink,
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
