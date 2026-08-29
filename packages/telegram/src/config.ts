import dotenv from "dotenv";

dotenv.config();

export interface TelegramPluginConfig {
  readonly botToken?: string | undefined;
  readonly allowedUserIds: readonly number[];
  readonly defaultChatId?: string | number | undefined;
  readonly paperclipApiUrl: string;
  readonly paperclipApiKey?: string | undefined;
  readonly paperclipCompanyId?: string | undefined;
  readonly pollIntervalMs: number;
}

export function isUserAuthorized(userId: number | undefined, allowedUserIds: readonly number[]): boolean {
  if (!userId || !Array.isArray(allowedUserIds) || allowedUserIds.length === 0) {
    return false;
  }
  return allowedUserIds.includes(userId);
}

export function parseAllowedUserIds(raw: string | number[] | undefined): number[] {
  if (Array.isArray(raw)) {
    return raw.filter((id) => typeof id === "number" && !isNaN(id));
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n));
  }
  return [];
}

export function loadTelegramConfig(env: NodeJS.ProcessEnv = process.env): TelegramPluginConfig {
  const allowedUserIds = parseAllowedUserIds(env["TELEGRAM_ALLOWED_USER_IDS"]);

  return {
    botToken: env["TELEGRAM_BOT_TOKEN"],
    allowedUserIds,
    defaultChatId: env["TELEGRAM_CHAT_ID"],
    paperclipApiUrl: env["PAPERCLIP_API_URL"] || "http://127.0.0.1:3100",
    paperclipApiKey: env["PAPERCLIP_API_KEY"] || env["PAPERCLIP_AGENT_TOKEN"],
    paperclipCompanyId: env["PAPERCLIP_COMPANY_ID"],
    pollIntervalMs: parseInt(env["TELEGRAM_POLL_INTERVAL_MS"] || "3000", 10),
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
