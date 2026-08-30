import { TelegramBotClient } from "./telegram-api.js";
import { formatApprovalCard } from "./formatters.js";
import { PaperclipApiClient } from "./paperclip-client.js";

export interface StatePollerConfig {
  readonly botClient: TelegramBotClient;
  readonly paperclipClient: PaperclipApiClient;
  readonly defaultChatId: string | number;
  readonly companyId?: string | undefined;
  readonly pollIntervalMs: number;
}

export class PaperclipTelegramPoller {
  private isRunning = false;
  private readonly notifiedApprovalIds = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly config: StatePollerConfig) {}

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.pollLoop();
  }

  stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async pollLoop(): Promise<void> {
    if (!this.isRunning) return;

    try {
      await this.checkPendingApprovals();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[telegram] approval poll failed: ${msg}`);
    }

    if (this.isRunning) {
      this.timer = setTimeout(() => this.pollLoop(), this.config.pollIntervalMs);
    }
  }

  async checkPendingApprovals(): Promise<number> {
    if (!this.config.companyId) return 0;

    const res = await this.config.paperclipClient.getJson<any>(
      `/api/companies/${this.config.companyId}/approvals`
    );
    const approvals: any[] = Array.isArray(res) ? res : res?.approvals || [];
    let notifiedCount = 0;

    for (const app of approvals) {
      if (app.status === "pending" && !this.notifiedApprovalIds.has(app.id)) {
        const payload = app.payload || {};
        const { text, replyMarkup } = formatApprovalCard({
          approvalId: app.id,
          action: payload.action || app.action,
          issueIdentifier: payload.identifier || app.issueIdentifier || app.issueId || "TASK",
          issueTitle: payload.issueTitle || payload.title || app.issueTitle || app.title || "Pending Operation",
          description: payload.description || app.description,
          reason: payload.reason,
          priority: payload.priority,
          prNumber: payload.prNumber || app.prNumber,
          prUrl: payload.prUrl || app.prUrl,
          reviewVerdict: payload.reviewVerdict || app.reviewVerdict,
          requestedBy: app.requestedBy || (app.requestedByUserId ? "Paperclip Board" : undefined),
        });

        await this.config.botClient.sendMessage({
          chat_id: this.config.defaultChatId,
          text,
          parse_mode: "Markdown",
          reply_markup: replyMarkup,
        });

        this.notifiedApprovalIds.add(app.id);
        notifiedCount++;
      }
    }

    return notifiedCount;
  }
}
