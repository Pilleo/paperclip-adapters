export const manifest = {
  id: "telegram",
  apiVersion: 1 as const,
  version: "0.1.0",
  displayName: "Telegram Operator Companion",
  description: "Real-time Telegram notifications, interactive PR approval cards, and agent clarifications.",
  author: "Pilleo",
  categories: ["connector" as const, "automation" as const],
  capabilities: [
    "companies.read" as const,
    "issues.read" as const,
    "issue.comments.read" as const,
    "issue.comments.create" as const,
    "issue.comments.create_human_attributed" as const,
    "approvals.read" as const,
    "approvals.respond" as const,
    "events.subscribe" as const,
    "http.outbound" as const,
    "secrets.read-ref" as const,
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      conversationId: {
        type: "string",
        title: "Telegram Conversation / Chat ID",
        description: "Target conversation or chat ID where notifications & approval cards are posted (matches TELEGRAM_CHAT_ID)",
      },
      pollIntervalMs: {
        type: "number",
        title: "Polling Interval (ms)",
        description: "Interval to check Paperclip for pending approvals (default: 3000ms)",
        default: 3000,
      },
    },
    required: ["conversationId"],
  },
};

export default manifest;
