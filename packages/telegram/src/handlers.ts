import { TelegramBotClient, TelegramCallbackQuery, TelegramMessage } from "./telegram-api.js";
import { isUserAuthorized } from "./config.js";
import { formatFleetStatusCard, formatTaskQueueCard } from "./formatters.js";
import { PaperclipApiClient } from "./paperclip-client.js";

export interface HandlerDependencies {
  readonly botClient: TelegramBotClient;
  readonly paperclipClient: PaperclipApiClient;
  readonly allowedUserIds: readonly (number | string)[];
  readonly companyId?: string | undefined;
}

export async function handleTelegramCallback(
  callback: TelegramCallbackQuery,
  deps: HandlerDependencies
): Promise<void> {
  const userId = callback.from.id;
  const chatId = callback.message?.chat?.id;

  if (!isUserAuthorized(userId, chatId, deps.allowedUserIds)) {
    await deps.botClient.answerCallbackQuery(
      callback.id,
      `Unauthorized (User ID: ${userId})`,
      true
    );
    return;
  }

  const data = callback.data || "";
  let action = "";
  let targetId = "";

  if (data.startsWith("pcapprove:")) {
    action = "approve";
    targetId = data.slice("pcapprove:".length);
  } else if (data.startsWith("pcreject:")) {
    action = "reject";
    targetId = data.slice("pcreject:".length);
  } else {
    const parts = data.split(":");
    action = parts[0] || "";
    targetId = parts[1] || "";
  }

  if (action === "approve" && targetId) {
    try {
      if (deps.companyId) {
        await deps.paperclipClient.postJson(`/api/approvals/${targetId}/approve`, {
          actor: `telegram:${userId}`,
        });
      }
      await deps.botClient.answerCallbackQuery(callback.id, "Approved!");
      if (callback.message) {
        await deps.botClient.editMessageText(
          callback.message.chat.id,
          callback.message.message_id,
          `✅ *Approved & Merged* by @${callback.from.username || userId}`
        );
      }
    } catch (err: any) {
      await deps.botClient.answerCallbackQuery(callback.id, `Approval failed: ${err.message}`, true);
    }
    return;
  }

  if (action === "reject" && targetId) {
    try {
      if (deps.companyId) {
        await deps.paperclipClient.postJson(`/api/approvals/${targetId}/reject`, {
          reason: `Rejected by operator via Telegram (@${callback.from.username || userId})`,
        });
      }
      await deps.botClient.answerCallbackQuery(callback.id, "Changes requested.");
      if (callback.message) {
        await deps.botClient.editMessageText(
          callback.message.chat.id,
          callback.message.message_id,
          `❌ *Changes Requested* by @${callback.from.username || userId}`
        );
      }
    } catch (err: any) {
      await deps.botClient.answerCallbackQuery(callback.id, `Rejection failed: ${err.message}`, true);
    }
    return;
  }

  await deps.botClient.answerCallbackQuery(callback.id, "Acknowledged");
}

export async function handleTelegramMessage(
  msg: TelegramMessage,
  deps: HandlerDependencies
): Promise<void> {
  const userId = msg.from?.id;
  const chatId = msg.chat.id;

  if (!isUserAuthorized(userId, chatId, deps.allowedUserIds)) {
    await deps.botClient.sendMessage({
      chat_id: chatId,
      text: `🔒 *Unauthorized Telegram Access*\n• User ID: \`${userId}\`\n• Chat ID: \`${chatId}\``,
      parse_mode: "Markdown",
    });
    return;
  }

  const text = (msg.text || "").trim();

  // 1. Threaded Clarification Reply Handling
  const replyToText = msg.reply_to_message?.text;
  if (replyToText && replyToText.includes("Clarification Question")) {
    const match = replyToText.match(/\[([A-Z0-9_-]+)\]/);
    if (match && match[1]) {
      const issueIdentifier = match[1];
      try {
        if (deps.companyId) {
          await deps.paperclipClient.postJson(`/api/companies/${deps.companyId}/issues/${issueIdentifier}/comments`, {
            content: `**[Telegram Operator Reply from @${msg.from?.username || userId}]:**\n${text}`,
          });
        }
        await deps.botClient.sendMessage({
          chat_id: chatId,
          text: `✅ Instruction forwarded to agent working on *[${issueIdentifier}]*.`,
          reply_to_message_id: msg.message_id,
          parse_mode: "Markdown",
        });
      } catch (err: any) {
        await deps.botClient.sendMessage({
          chat_id: chatId,
          text: `⚠️ Failed to forward instruction: ${err.message}`,
          reply_to_message_id: msg.message_id,
        });
      }
      return;
    }
  }

  // 2. Slash Commands
  if (text === "/status" || text.startsWith("/status")) {
    try {
      let issues: any[] = [];
      let approvals: any[] = [];
      if (deps.companyId) {
        const issuesRes = await deps.paperclipClient.getJson<any>(`/api/companies/${deps.companyId}/issues?limit=500`);
        issues = issuesRes?.issues || (Array.isArray(issuesRes) ? issuesRes : []);
        const appRes = await deps.paperclipClient.getJson<any>(`/api/companies/${deps.companyId}/approvals`);
        approvals = Array.isArray(appRes) ? appRes : appRes?.approvals || [];
      }

      const active = issues.filter((i) => i.status === "in_progress").length;
      const inReview = issues.filter((i) => i.status === "in_review").length;
      const todo = issues.filter((i) => i.status === "todo" || i.status === "backlog").length;
      const pendingApp = approvals.filter((a) => a.status === "pending").length;

      const card = formatFleetStatusCard({
        activeSessions: active,
        maxConcurrent: 15,
        dailySpendEstimate: 0.05 * active,
        dailySpendBudget: 25.0,
        openIssuesCount: todo,
        inReviewCount: inReview,
        pendingApprovalsCount: pendingApp,
      });

      await deps.botClient.sendMessage({
        chat_id: chatId,
        text: card,
        parse_mode: "Markdown",
      });
    } catch (err: any) {
      await deps.botClient.sendMessage({
        chat_id: chatId,
        text: `⚠️ Failed to fetch status: ${err.message}`,
      });
    }
    return;
  }

  if (text === "/queue" || text.startsWith("/queue")) {
    try {
      let issues: any[] = [];
      if (deps.companyId) {
        const res = await deps.paperclipClient.getJson<any>(`/api/companies/${deps.companyId}/issues?status=todo,backlog&limit=10`);
        issues = res?.issues || (Array.isArray(res) ? res : []);
      }
      const tasks = issues.map((i) => ({
        identifier: i.identifier || i.id,
        title: i.title,
        priority: i.priority || "medium",
      }));
      await deps.botClient.sendMessage({
        chat_id: chatId,
        text: formatTaskQueueCard(tasks),
        parse_mode: "Markdown",
      });
    } catch (err: any) {
      await deps.botClient.sendMessage({
        chat_id: chatId,
        text: `⚠️ Failed to fetch queue: ${err.message}`,
      });
    }
    return;
  }

  if (text === "/help" || text === "/start" || text.startsWith("/start") || text.startsWith("/help")) {
    await deps.botClient.sendMessage({
      chat_id: chatId,
      text: `🤖 *Paperclip Operator Companion*

Commands:
• \`/status\` - View fleet health, active workers, and spend.
• \`/queue\` - View top unblocked tasks ready for dispatch.
• \`/help\` - Show available commands.

_You will automatically receive cards with buttons when approvals or agent questions require attention._`,
      parse_mode: "Markdown",
    });
  }
}
