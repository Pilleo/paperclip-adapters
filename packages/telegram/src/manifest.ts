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
      allowedUserIds: {
        type: "string",
        title: "Allowed Operator User IDs",
        description: "Comma-separated list of authorized Telegram user IDs (e.g. 123456789)",
      },
      defaultChatId: {
        type: "string",
        title: "Default Chat / Channel ID",
        description: "Telegram chat or channel ID where notifications will be posted",
      },
      pollIntervalMs: {
        type: "number",
        title: "Polling Interval (ms)",
        description: "Interval to check Paperclip for pending approvals (default: 3000ms)",
        default: 3000,
      },
    },
    required: ["allowedUserIds"],
  },
};

export default manifest;
