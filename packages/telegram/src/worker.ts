import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { PaperclipTelegramPlugin } from "./plugin.js";

const telegramPlugin = new PaperclipTelegramPlugin();

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("Initializing Paperclip Telegram Operator Companion Worker...");

    await telegramPlugin.register({
      events: ctx.events,
      secrets: ctx.secrets,
      logger: ctx.logger,
      options: {},
    });

    if (telegramPlugin.isConfigured()) {
      ctx.logger.info("Paperclip Telegram Operator Companion Worker active & connected.");
    } else {
      ctx.logger.warn("Telegram Companion Worker running in standby mode. Awaiting TELEGRAM_BOT_TOKEN in Paperclip Secret Vault.");
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
