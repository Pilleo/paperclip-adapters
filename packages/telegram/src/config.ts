import dotenv from "dotenv";

dotenv.config();

export interface TelegramPluginConfig {
  readonly botToken: string;
  readonly allowedUserIds: readonly number[];
  readonly defaultChatId?: number | string | undefined;
  readonly paperclipApiUrl: string;
  readonly paperclipApiKey?: string | undefined;
  readonly paperclipCompanyId?: string | undefined;
  readonly pollIntervalMs: number;
}

export function loadTelegramConfig(env: Record<string, string | undefined> = process.env): TelegramPluginConfig {
  const botToken = env["TELEGRAM_BOT_TOKEN"] || "";
  
  const rawAllowedUsers = env["TELEGRAM_ALLOWED_USER_IDS"] || "";
  const allowedUserIds = rawAllowedUsers
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => parseInt(s, 10))
    .filter((n) => !isNaN(n));

  const defaultChatId = env["TELEGRAM_CHAT_ID"] ? env["TELEGRAM_CHAT_ID"].trim() : undefined;
  const paperclipApiUrl = env["PAPERCLIP_API_URL"] || "http://127.0.0.1:3100";
  const paperclipApiKey = env["PAPERCLIP_API_KEY"];
  const paperclipCompanyId = env["PAPERCLIP_COMPANY_ID"];

  const pollIntervalMs = env["TELEGRAM_POLL_INTERVAL_MS"] 
    ? parseInt(env["TELEGRAM_POLL_INTERVAL_MS"], 10) 
    : 3000;

  return Object.freeze({
    botToken,
    allowedUserIds: Object.freeze(allowedUserIds),
    defaultChatId,
    paperclipApiUrl,
    paperclipApiKey,
    paperclipCompanyId,
    pollIntervalMs: isNaN(pollIntervalMs) ? 3000 : pollIntervalMs,
  });
}

export function isUserAuthorized(userId: number | undefined, allowedUserIds: readonly number[]): boolean {
  if (typeof userId !== "number") return false;
  if (allowedUserIds.length === 0) return false; // Fail closed: if no allowed users configured, reject all
  return allowedUserIds.includes(userId);
}
