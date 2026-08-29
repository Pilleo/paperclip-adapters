import { TelegramPluginConfig, loadTelegramConfig } from "./config.js";
import { TelegramBotClient } from "./telegram-api.js";
import { PaperclipTelegramPoller } from "./poller.js";
import { handleTelegramCallback, handleTelegramMessage } from "./handlers.js";
import { PaperclipApiClient } from "./paperclip-client.js";

export interface PaperclipPluginContext {
  readonly events?: {
    readonly on: (event: string, handler: (...args: any[]) => void) => void;
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
    if (!config.botToken) {
      return;
    }

    this.botClient = new TelegramBotClient(config.botToken);
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
