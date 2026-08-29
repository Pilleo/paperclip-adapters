export interface InlineKeyboardButton {
  readonly text: string;
  readonly callback_data?: string | undefined;
  readonly url?: string | undefined;
}

export interface InlineKeyboardMarkup {
  readonly inline_keyboard: readonly (readonly InlineKeyboardButton[])[];
}

export interface ForceReplyMarkup {
  readonly force_reply: true;
  readonly selective?: boolean | undefined;
}

export type ReplyMarkup = InlineKeyboardMarkup | ForceReplyMarkup;

export interface SendMessageOptions {
  readonly chat_id: number | string;
  readonly text: string;
  readonly parse_mode?: "Markdown" | "HTML" | undefined;
  readonly reply_markup?: ReplyMarkup | undefined;
  readonly reply_to_message_id?: number | undefined;
}

export interface TelegramMessage {
  readonly message_id: number;
  readonly chat: { readonly id: number | string };
  readonly text?: string | undefined;
  readonly from?: { readonly id: number; readonly username?: string; readonly first_name?: string } | undefined;
  readonly reply_to_message?: TelegramMessage | undefined;
}

export interface TelegramCallbackQuery {
  readonly id: string;
  readonly from: { readonly id: number; readonly username?: string; readonly first_name?: string };
  readonly message?: TelegramMessage | undefined;
  readonly data?: string | undefined;
}

export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage | undefined;
  readonly callback_query?: TelegramCallbackQuery | undefined;
}

export interface TelegramResponse<T> {
  readonly ok: boolean;
  readonly result?: T | undefined;
  readonly description?: string | undefined;
  readonly error_code?: number | undefined;
}

export class TelegramBotClient {
  private readonly baseUrl: string;

  constructor(private readonly botToken: string) {
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
  }

  async sendMessage(options: SendMessageOptions): Promise<TelegramMessage> {
    const res = await this.postJson<TelegramMessage>("sendMessage", options);
    if (!res.ok || !res.result) {
      throw new Error(`Telegram sendMessage failed: ${res.description || "Unknown error"}`);
    }
    return res.result;
  }

  async editMessageText(
    chatId: number | string,
    messageId: number,
    text: string,
    replyMarkup?: InlineKeyboardMarkup
  ): Promise<TelegramMessage | boolean> {
    const res = await this.postJson<TelegramMessage | boolean>("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "Markdown",
      reply_markup: replyMarkup,
    });
    if (!res.ok) {
      throw new Error(`Telegram editMessageText failed: ${res.description || "Unknown error"}`);
    }
    return res.result!;
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string, showAlert = false): Promise<boolean> {
    const res = await this.postJson<boolean>("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
      show_alert: showAlert,
    });
    return res.ok;
  }

  async getUpdates(offset?: number, timeoutSeconds = 20): Promise<readonly TelegramUpdate[]> {
    const url = `${this.baseUrl}/getUpdates?timeout=${timeoutSeconds}${offset ? `&offset=${offset}` : ""}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Telegram getUpdates HTTP error ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as TelegramResponse<TelegramUpdate[]>;
    if (!data.ok || !data.result) {
      throw new Error(`Telegram getUpdates failed: ${data.description || "Unknown error"}`);
    }
    return data.result;
  }

  private async postJson<T>(method: string, body: unknown): Promise<TelegramResponse<T>> {
    const url = `${this.baseUrl}/${method}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as TelegramResponse<T>;
  }
}
