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
      chatId: {
        type: "string",
        title: "Telegram Chat ID (TELEGRAM_CHAT_ID)",
        description: "Target chat or channel ID where notifications & approval cards are posted",
      },
      pollIntervalMs: {
        type: "number",
        title: "Polling Interval (ms)",
        description: "Interval to check Paperclip for pending approvals (default: 3000ms)",
        default: 3000,
      },
    },
    required: ["chatId"],
  },
};

export default manifest;
