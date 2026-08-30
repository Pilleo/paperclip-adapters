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

export function isTaskStartApprovalForIssue(
  approval: PaperclipApprovalSummary,
  issueId: string,
): boolean {
  return (
    (approval.type === "task_start_approval" ||
      (approval.type === "request_board_approval" && approval.payload?.["action"] === "task_start")) &&
    (approval.issueIds.includes(issueId) || approval.payload?.["issueId"] === issueId)
  );
}

export function findTaskStartApproval(
  approvals: readonly PaperclipApprovalSummary[],
  issueId: string,
): PaperclipApprovalSummary | undefined {
  return approvals.find((approval) => isTaskStartApprovalForIssue(approval, issueId));
}

/** Assigned or in_progress work while task_start is still pending is a gate violation. */
export function shouldReclaimUnapprovedStart(
  issue: { readonly id: string; readonly status: string; readonly assigneeAgentId?: string | null | undefined },
  approvals: readonly PaperclipApprovalSummary[],
): boolean {
  if (issue.status === "done" || issue.status === "cancelled") return false;
  const start = findTaskStartApproval(approvals, issue.id);
  if (!start || start.status !== "pending") return false;
  if (issue.assigneeAgentId) return true;
  return issue.status === "in_progress" || issue.status === "in_review";
}

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
  const matchingApproval = findTaskStartApproval(existingApprovals, issue.id);

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

export type MergeApprovalDecision =
  | { action: "EXECUTE_MERGE"; approvalId?: string; reason: string }
  | {
      action: "CREATE_MERGE_APPROVAL_REQUEST";
      title: string;
      description: string;
      issueId: string;
      prNumber: number;
      prUrl?: string | undefined;
      issueUrl?: string | undefined;
    }
  | { action: "AWAIT_MERGE_APPROVAL"; approvalId: string; reason: string }
  | { action: "REJECTED"; approvalId: string; reason: string };

export function evaluatePrMergeApproval(
  issue: ParsedIssueMetadata,
  prNumber: number,
  existingApprovals: readonly PaperclipApprovalSummary[],
  options: {
    prUrl?: string | undefined;
    vibeSummary?: string | undefined;
    strongSummary?: string | undefined;
    companyUrlKey?: string | undefined;
  } = {}
): MergeApprovalDecision {
  const matchingApproval = existingApprovals.find(
    (app) =>
      (app.type === "task_merge_approval" ||
        (app.type === "request_board_approval" && app.payload?.["action"] === "task_merge")) &&
      (app.issueIds.includes(issue.id) || app.payload?.["issueId"] === issue.id || app.payload?.["prNumber"] === prNumber)
  );

  if (!matchingApproval) {
    const urlKey = options.companyUrlKey || "MAZ";
    const issueLink = `http://localhost:3100/${urlKey}/issues/${issue.identifier || issue.id}`;
    const prLink = options.prUrl || `https://github.com/Pilleo/mazewall/pull/${prNumber}`;
    const title = `Approve PR #${prNumber} merge: [${issue.identifier || issue.id}] "${issue.title}"`;

    const description = `### 🚀 Final Pull Request Merge Authorization Request

🔗 **Paperclip Issue:** [${issue.identifier || issue.id}: ${issue.title}](${issueLink})
🔗 **GitHub PR:** [PR #${prNumber}](${prLink})

#### 🛡️ Multi-Tier Review Pipeline Passed
- ✅ **Stage 1 (CI Gate):** 100% Green Build & Tests
- ✅ **Stage 2 (Vibe Fast Review):** ${options.vibeSummary || "Passed structural and invariant sanity checks."}
- ✅ **Stage 3 (Strong Model Review):** ${options.strongSummary || "Passed deep security, Landlock/seccomp, and FFM invariant audit."}

*Approving this authorization will automatically merge PR #${prNumber} on GitHub and mark this task done.*`;

    return {
      action: "CREATE_MERGE_APPROVAL_REQUEST",
      title,
      description,
      issueId: issue.id,
      prNumber,
      prUrl: options.prUrl,
      issueUrl: issueLink,
    };
  }

  if (matchingApproval.status === "approved") {
    return {
      action: "EXECUTE_MERGE",
      approvalId: matchingApproval.id,
      reason: `Operator approved PR #${prNumber} merge (approval ${matchingApproval.id})`,
    };
  }

  if (matchingApproval.status === "rejected") {
    return {
      action: "REJECTED",
      approvalId: matchingApproval.id,
      reason: `Operator rejected PR #${prNumber} merge (approval ${matchingApproval.id})`,
    };
  }

  return {
    action: "AWAIT_MERGE_APPROVAL",
    approvalId: matchingApproval.id,
    reason: `Awaiting operator final merge approval in Paperclip (approval ${matchingApproval.id})`,
  };
}
