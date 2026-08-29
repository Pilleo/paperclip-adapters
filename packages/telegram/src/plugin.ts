import { TelegramPluginConfig, loadTelegramConfig, formatMissingSecretError, formatMissingChatIdWarning, parseAllowedUserIds } from "./config.js";
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
  readonly logger?: {
    readonly info: (msg: string, ...args: any[]) => void;
    readonly warn: (msg: string, ...args: any[]) => void;
    readonly error: (msg: string, ...args: any[]) => void;
  } | undefined;
  readonly options?: {
    readonly allowedUserIds?: string | (number | string)[] | undefined;
    readonly chatId?: string | number | undefined;
    readonly conversationId?: string | number | undefined;
    readonly defaultChatId?: string | number | undefined;
    readonly pollIntervalMs?: number | undefined;
    readonly paperclipCompanyId?: string | undefined;
    readonly botToken?: string | undefined;
  } | undefined;
}

export class PaperclipTelegramPlugin {
  readonly name = "@pilleo/paperclip-telegram-plugin";
  private isRunning = false;
  private botClient: TelegramBotClient | null = null;
  private poller: PaperclipTelegramPoller | null = null;
  private updateOffset: number | undefined = undefined;
  private configured = false;

  isConfigured(): boolean {
    return this.configured;
  }

  hasChatId(): boolean {
    return !!this.poller;
  }

  async register(ctx: PaperclipPluginContext = {}): Promise<void> {
    const baseConfig = loadTelegramConfig();
    const allowedUserIds = ctx.options?.allowedUserIds 
      ? parseAllowedUserIds(ctx.options.allowedUserIds) 
      : baseConfig.allowedUserIds;

    const companyId = ctx.options?.paperclipCompanyId || baseConfig.paperclipCompanyId;
    const targetChatId = ctx.options?.chatId || ctx.options?.defaultChatId || ctx.options?.conversationId || baseConfig.defaultChatId || baseConfig.conversationId;
    const conversationId = ctx.options?.conversationId || baseConfig.conversationId;
    const pollIntervalMs = ctx.options?.pollIntervalMs || baseConfig.pollIntervalMs;

    let token = ctx.options?.botToken || baseConfig.botToken;

    // 1. Resolve token from Paperclip Secrets Vault if secrets client is provided
    if (!token && ctx.secrets && companyId) {
      try {
        const resolved = await ctx.secrets.resolve("TELEGRAM_BOT_TOKEN", { companyId });
        if (resolved && resolved.trim().length > 0) {
          token = resolved.trim();
        }
      } catch {
        // Vault lookup failed or secret not present
      }
    }

    // 2. If token is missing, log actionable error and enter idle awaiting_secret state
    if (!token) {
      const errorMsg = formatMissingSecretError(companyId);
      if (ctx.logger?.warn) {
        ctx.logger.warn(errorMsg);
      }
      this.configured = false;
      return;
    }

    this.configured = true;
    const config: TelegramPluginConfig = {
      botToken: token,
      allowedUserIds,
      defaultChatId: targetChatId,
      conversationId,
      paperclipApiUrl: baseConfig.paperclipApiUrl,
      paperclipApiKey: baseConfig.paperclipApiKey,
      paperclipCompanyId: companyId,
      pollIntervalMs,
    };

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
    } else {
      const warning = formatMissingChatIdWarning(companyId);
      if (ctx.logger?.warn) {
        ctx.logger.warn(warning);
      }
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
    if (this.botClient) {
      try {
        const initial = await this.botClient.getUpdates(undefined, 0);
        if (initial.length > 0) {
          this.updateOffset = Math.max(...initial.map((u) => u.update_id)) + 1;
        }
      } catch {
        // offset init failure non-fatal
      }
    }

    while (this.isRunning && this.botClient) {
      try {
        const updates = await this.botClient.getUpdates(this.updateOffset, 1);
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
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}
