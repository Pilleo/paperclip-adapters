import { TelegramPluginConfig, loadTelegramConfig } from "./config.js";
import { TelegramBotClient } from "./telegram-api.js";
import { PaperclipTelegramPoller } from "./poller.js";
import { handleTelegramCallback, handleTelegramMessage } from "./handlers.js";
import { PaperclipApiClient } from "./paperclip-client.js";

export interface PaperclipPluginContext {
  readonly events?: {
    readonly on: (event: any, handler: (...args: any[]) => any) => any;
  } | undefined;
  readonly secrets?: {
    readonly resolve: (secretRef: any, options?: { companyId?: string }) => Promise<string>;
  } | undefined;
  readonly options?: Partial<TelegramPluginConfig> | undefined;
}

export class PaperclipTelegramPlugin {
  readonly name = "@pilleo/paperclip-telegram-plugin";
  private isRunning = false;
  private botClient: TelegramBotClient | null = null;
  private poller: PaperclipTelegramPoller | null = null;
  private updateOffset: number | undefined = undefined;

  async register(ctx: PaperclipPluginContext = {}): Promise<void> {
    const config = { ...loadTelegramConfig(), ...(ctx.options || {}) };

    let token = config.botToken;
    // Attempt secret resolution via Paperclip Secrets Vault if configured as secret_ref or if empty
    if (ctx.secrets && config.paperclipCompanyId) {
      if (typeof token === "object" || !token) {
        try {
          const resolved = await ctx.secrets.resolve(
            typeof token === "object" ? token : "TELEGRAM_BOT_TOKEN",
            { companyId: config.paperclipCompanyId }
          );
          if (resolved) {
            token = resolved;
          }
        } catch {
          // Fall back to env token
        }
      }
    }

    if (!token) {
      return;
    }

    this.botClient = new TelegramBotClient(token);
    const paperclipClient = new PaperclipApiClient(config.paperclipApiUrl, config.paperclipApiKey);

    if (config.defaultChatId && config.paperclipCompanyId) {
      this.poller = new PaperclipTelegramPoller({
        botClient: this.botClient,
        paperclipClient,
        defaultChatId: config.defaultChatId,
        companyId: config.paperclipCompanyId,
        pollIntervalMs: config.pollIntervalMs,
      });
      this.poller.start();
    }

    this.isRunning = true;
    this.startUpdateLoop(config, paperclipClient);
  }

  async unregister(): Promise<void> {
    this.isRunning = false;
    if (this.poller) {
      this.poller.stop();
      this.poller = null;
    }
  }

  private async startUpdateLoop(config: TelegramPluginConfig, paperclipClient: PaperclipApiClient): Promise<void> {
    while (this.isRunning && this.botClient) {
      try {
        const updates = await this.botClient.getUpdates(this.updateOffset, 15);
        for (const update of updates) {
          this.updateOffset = update.update_id + 1;

          if (update.callback_query) {
            await handleTelegramCallback(update.callback_query, {
              botClient: this.botClient,
              paperclipClient,
              allowedUserIds: config.allowedUserIds,
              companyId: config.paperclipCompanyId,
            });
          }

          if (update.message) {
            await handleTelegramMessage(update.message, {
              botClient: this.botClient,
              paperclipClient,
              allowedUserIds: config.allowedUserIds,
              companyId: config.paperclipCompanyId,
            });
          }
        }
      } catch {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
}
