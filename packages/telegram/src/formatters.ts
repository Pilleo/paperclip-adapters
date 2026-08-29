import { InlineKeyboardButton, InlineKeyboardMarkup } from "./telegram-api.js";

export interface PendingApprovalData {
  readonly approvalId: string;
  readonly action?: string | undefined;
  readonly issueIdentifier: string;
  readonly issueTitle: string;
  readonly description?: string | undefined;
  readonly reason?: string | undefined;
  readonly priority?: string | undefined;
  readonly prNumber?: number | undefined;
  readonly prUrl?: string | undefined;
  readonly reviewVerdict?: string | undefined;
  readonly requestedBy?: string | undefined;
}

export function compactDescription(desc: string | undefined, maxLen = 280): string {
  if (!desc || typeof desc !== "string") return "";

  const cleaned = desc
    .replace(/^(\s*#+\s*.*$)+/gm, "")
    .replace(/Component:\s*[^\n]*\n?/gi, "")
    .replace(/Priority:\s*[^\n]*\n?/gi, "")
    .replace(/Planned Agent:\s*[^\n]*\n?/gi, "")
    .replace(/Routed to:\s*[^\n]*\n?/gi, "")
    .trim();

  if (!cleaned) return "";

  const truncated = cleaned.length > maxLen ? `${cleaned.slice(0, maxLen).trim()}...` : cleaned;
  const quoteLines = truncated
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n> ");

  return `\n\n> 📝 _${quoteLines}_`;
}

export function formatApprovalCard(data: PendingApprovalData): {
  readonly text: string;
  readonly replyMarkup: InlineKeyboardMarkup;
} {
  const isTaskStart = data.action === "task_start" || (!data.prUrl && !data.reviewVerdict);
  const isPrMerge = !!data.prUrl || data.action === "pr_merge";

  let header = "⚖️ *Operator Decision Required*";
  let actionDetails = "";
  const buttons: InlineKeyboardButton[][] = [];

  if (isTaskStart) {
    header = `🚀 *Task Execution Approval*`;
    const prioStr = data.priority ? ` (\`${data.priority.toUpperCase()}\`)` : "";
    const descStr = compactDescription(data.description);
    actionDetails = `• *Task:* [${data.issueIdentifier}] ${data.issueTitle}${prioStr}${descStr}`;

    buttons.push([
      { text: "▶️ Start Task", callback_data: `approve:${data.approvalId}` },
      { text: "⏸️ Skip / Defer", callback_data: `reject:${data.approvalId}` },
    ]);
  } else if (isPrMerge) {
    header = `📋 *Pull Request Merge Approval*`;
    const prLine = data.prUrl
      ? `\n• *PR:* [#${data.prNumber || "Link"}](${data.prUrl})`
      : "";
    const verdictLine = data.reviewVerdict
      ? `\n\n*Review Verdict:*\n${data.reviewVerdict}`
      : "";
    const descStr = compactDescription(data.description);
    actionDetails = `• *Task:* [${data.issueIdentifier}] ${data.issueTitle}${prLine}${descStr}${verdictLine}`;

    buttons.push([
      { text: "🚢 Approve & Merge", callback_data: `approve:${data.approvalId}` },
      { text: "✏️ Request Changes", callback_data: `reject:${data.approvalId}` },
    ]);

    if (data.prUrl) {
      buttons.push([{ text: "🔍 View PR on GitHub", url: data.prUrl }]);
    }
  } else {
    const descStr = compactDescription(data.description);
    actionDetails = `• *Task:* [${data.issueIdentifier}] ${data.issueTitle}${descStr}`;
    buttons.push([
      { text: "✅ Approve", callback_data: `approve:${data.approvalId}` },
      { text: "❌ Reject", callback_data: `reject:${data.approvalId}` },
    ]);
  }

  const requester = data.requestedBy ? `\n• *Requested By:* ${data.requestedBy}` : "";
  const text = `${header}\n\n${actionDetails}${requester}`;

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
