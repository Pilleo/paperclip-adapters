import { InlineKeyboardButton, InlineKeyboardMarkup } from "./telegram-api.js";

export interface PendingApprovalData {
  readonly approvalId: string;
  readonly issueIdentifier: string;
  readonly issueTitle: string;
  readonly prNumber?: number | undefined;
  readonly prUrl?: string | undefined;
  readonly reviewVerdict?: string | undefined;
  readonly requestedBy?: string | undefined;
}

export function formatApprovalCard(data: PendingApprovalData): {
  readonly text: string;
  readonly replyMarkup: InlineKeyboardMarkup;
} {
  const prLine = data.prUrl
    ? `• *PR:* [#${data.prNumber || "Link"}](${data.prUrl})`
    : `• *Action:* Direct Issue Execution Approval`;

  const verdictLine = data.reviewVerdict
    ? `\n\n*Review Verdict:*\n${data.reviewVerdict}`
    : "";

  const text = `🚨 *Operator Decision Required*

• *Task:* [${data.issueIdentifier}] ${data.issueTitle}
${prLine}
• *Requested by:* ${data.requestedBy || "Autonomous Agent"}${verdictLine}`;

  const buttons: InlineKeyboardButton[][] = [
    [
      { text: "✅ Approve & Merge", callback_data: `approve:${data.approvalId}` },
      { text: "❌ Request Changes", callback_data: `reject:${data.approvalId}` },
    ],
  ];

  if (data.prUrl) {
    buttons.push([{ text: "🔍 Open PR on GitHub", url: data.prUrl }]);
  }

  return {
    text,
    replyMarkup: { inline_keyboard: buttons },
  };
}

export function formatClarificationQuestionCard(params: {
  readonly issueIdentifier: string;
  readonly issueTitle: string;
  readonly question: string;
  readonly agentName: string;
}): string {
  return `❓ *Clarification Question from ${params.agentName}*

• *Issue:* [${params.issueIdentifier}] ${params.issueTitle}

"${params.question}"

_Reply directly to this message to provide instructions to the agent._`;
}

export function formatFleetStatusCard(params: {
  readonly activeSessions: number;
  readonly maxConcurrent: number;
  readonly dailySpendEstimate: number;
  readonly dailySpendBudget: number;
  readonly openIssuesCount: number;
  readonly inReviewCount: number;
  readonly pendingApprovalsCount: number;
}): string {
  const spendPct = params.dailySpendBudget > 0 
    ? Math.round((params.dailySpendEstimate / params.dailySpendBudget) * 100)
    : 0;

  return `📊 *Paperclip Fleet Live Telemetry*

• *Active Workers:* \`${params.activeSessions} / ${params.maxConcurrent}\`
• *Daily Spend:* \`$${params.dailySpendEstimate.toFixed(3)} / $${params.dailySpendBudget.toFixed(2)}\` (${spendPct}%)
• *Pending Approvals:* \`${params.pendingApprovalsCount}\`
• *In-Review PRs:* \`${params.inReviewCount}\`
• *Open Backlog:* \`${params.openIssuesCount}\``;
}

export function formatTaskQueueCard(
  tasks: readonly { readonly identifier: string; readonly title: string; readonly priority: string }[]
): string {
  if (tasks.length === 0) {
    return "📭 *Task Queue is Empty* (No unblocked tasks ready for dispatch).";
  }

  const items = tasks.slice(0, 10).map((t, idx) => `${idx + 1}. *[${t.identifier}]* ${t.title} (\`${t.priority}\`)`);
  return `📋 *Top Unblocked Tasks (${tasks.length} ready)*\n\n${items.join("\n")}`;
}
