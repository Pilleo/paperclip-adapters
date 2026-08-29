import dotenv from "dotenv";

dotenv.config();

export interface TelegramPluginConfig {
  readonly botToken?: string | undefined;
  readonly allowedUserIds: readonly (number | string)[];
  readonly defaultChatId?: string | number | undefined;
  readonly paperclipApiUrl: string;
  readonly paperclipApiKey?: string | undefined;
  readonly paperclipCompanyId?: string | undefined;
  readonly pollIntervalMs: number;
}

export function isUserAuthorized(
  userId: number | string | undefined,
  chatId: number | string | undefined,
  allowedUserIds: readonly (number | string)[]
): boolean {
  if (!Array.isArray(allowedUserIds) || allowedUserIds.length === 0) {
    return true;
  }

  const normalizedWhitelist = allowedUserIds.map((id) => String(id).trim());
  if (normalizedWhitelist.includes("all") || normalizedWhitelist.includes("*")) {
    return true;
  }

  if (userId !== undefined && normalizedWhitelist.includes(String(userId).trim())) {
    return true;
  }

  if (chatId !== undefined && normalizedWhitelist.includes(String(chatId).trim())) {
    return true;
  }

  return false;
}

export function parseAllowedUserIds(raw: string | (number | string)[] | undefined): (number | string)[] {
  if (Array.isArray(raw)) {
    return raw.map((id) => (typeof id === "string" ? id.trim() : id)).filter(Boolean);
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => {
        const num = Number(s);
        return isNaN(num) ? s : num;
      });
  }
  return [];
}

export function loadTelegramConfig(env: NodeJS.ProcessEnv = process.env): TelegramPluginConfig {
  const allowedUserIds = parseAllowedUserIds(env["TELEGRAM_ALLOWED_USER_IDS"]);
  const chatId = env["TELEGRAM_CHAT_ID"] || env["CONVERSATION_ID"] || env["TELEGRAM_CONVERSATION_ID"];

  return {
    botToken: env["TELEGRAM_BOT_TOKEN"],
    allowedUserIds,
    defaultChatId: chatId,
    paperclipApiUrl: env["PAPERCLIP_API_URL"] || "http://127.0.0.1:3100",
    paperclipApiKey: env["PAPERCLIP_API_KEY"] || env["PAPERCLIP_AGENT_TOKEN"],
    paperclipCompanyId: env["PAPERCLIP_COMPANY_ID"] || "8f4ef932-d769-43b2-981a-d273ed715162",
    pollIntervalMs: parseInt(env["TELEGRAM_POLL_INTERVAL_MS"] || "1000", 10),
  };
}

export function formatMissingSecretError(companyId?: string): string {
  const companyFlag = companyId ? ` --company-id ${companyId}` : "";
  return [
    `❌ [TELEGRAM COMPANION] Missing secret: "TELEGRAM_BOT_TOKEN" is not configured in Paperclip Secret Vault.`,
    `👉 To resolve, add the secret via Paperclip Web UI (Settings -> Secrets & Keys) or execute:`,
    `   npx paperclipai secrets create${companyFlag} --name "TELEGRAM_BOT_TOKEN" --value "<YOUR_BOTFATHER_TOKEN>"`,
  ].join("\n");
}
