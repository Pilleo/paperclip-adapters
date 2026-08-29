import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { PaperclipTelegramPlugin } from "./plugin.js";
import { PaperclipApiClient } from "./paperclip-client.js";

const telegramPlugin = new PaperclipTelegramPlugin();

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("Initializing Paperclip Telegram Operator Companion Worker...");

    // 1. Resolve company context
    const companies = await ctx.companies.list().catch(() => []);
    const companyId = companies[0]?.id || process.env["PAPERCLIP_COMPANY_ID"] || "8f4ef932-d769-43b2-981a-d273ed715162";

    // 2. Load company-scoped plugin configuration from Paperclip
    const companyConfig = (await ctx.config.get(companyId).catch(() => ({}))) as Record<string, any>;
    const allowedUserIds = companyConfig?.["allowedUserIds"] || process.env["TELEGRAM_ALLOWED_USER_IDS"];
    const defaultChatId = companyConfig?.["defaultChatId"] || process.env["TELEGRAM_CHAT_ID"];
    const pollIntervalMs = companyConfig?.["pollIntervalMs"] || process.env["TELEGRAM_POLL_INTERVAL_MS"];

    let resolvedToken: string | undefined = process.env["TELEGRAM_BOT_TOKEN"];

    // 3. Resolve secret from Paperclip Secret Vault if not set in process environment
    if (!resolvedToken && ctx.secrets && companyId) {
      try {
        const client = new PaperclipApiClient(process.env["PAPERCLIP_API_URL"] || "http://127.0.0.1:3100");
        const secretsList = await client.getJson<any[]>(`/api/companies/${companyId}/secrets`);
        const telegramSecret = secretsList.find(
          (s) => s.name === "TELEGRAM_BOT_TOKEN" || s.key === "telegram_bot_token"
        );

        if (telegramSecret?.id) {
          ctx.logger.info(`Resolving secret "${telegramSecret.name}" from Paperclip Secret Vault (ID: ${telegramSecret.id})...`);
          const tokenVal = await ctx.secrets.resolve({
            type: "secret_ref",
            secretId: telegramSecret.id,
          }, { companyId });

          if (tokenVal && tokenVal.trim().length > 0) {
            resolvedToken = tokenVal.trim();
            ctx.logger.info("Telegram Bot Token successfully resolved from Paperclip Secret Vault.");
          }
        }
      } catch (err: any) {
        ctx.logger.warn(`Failed to resolve TELEGRAM_BOT_TOKEN from Secret Vault: ${err.message}`);
      }
    }

    // 4. Register and start plugin loops
    await telegramPlugin.register({
      events: ctx.events,
      secrets: ctx.secrets,
      logger: ctx.logger,
      options: {
        paperclipCompanyId: companyId,
        ...(resolvedToken ? { botToken: resolvedToken } : {}),
        ...(allowedUserIds ? { allowedUserIds } : {}),
        ...(defaultChatId ? { defaultChatId } : {}),
        ...(pollIntervalMs ? { pollIntervalMs: Number(pollIntervalMs) } : {}),
      },
    });

    if (telegramPlugin.isConfigured()) {
      ctx.logger.info("Paperclip Telegram Operator Companion Worker active & connected.");
    } else {
      ctx.logger.warn("Telegram Companion Worker in standby mode: TELEGRAM_BOT_TOKEN secret not yet available.");
    }
  },

  async onHealth() {
    return {
      status: "ok",
      details: {
        configured: telegramPlugin.isConfigured(),
        message: telegramPlugin.isConfigured()
          ? "Connected to Telegram Bot"
          : "Standby: TELEGRAM_BOT_TOKEN secret not yet configured in Secret Vault",
      },
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
