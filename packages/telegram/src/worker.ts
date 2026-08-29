import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { PaperclipTelegramPlugin } from "./plugin.js";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("Starting Paperclip Telegram Operator Companion Worker...");
    const telegramPlugin = new PaperclipTelegramPlugin();

    // Register with Paperclip event emitter context
    await telegramPlugin.register({
      events: ctx.events,
      options: {},
    });

    ctx.logger.info("Paperclip Telegram Operator Companion Worker active.");
  },

  async onHealth() {
    return { status: "ok" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
