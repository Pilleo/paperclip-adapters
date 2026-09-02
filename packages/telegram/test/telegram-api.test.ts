import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramBotClient } from "../src/telegram-api.js";

describe("TelegramBotClient message delivery", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("retries a Markdown entity rejection as plain text with the same keyboard", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, description: "Bad Request: can't parse entities" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { message_id: 17 } }), { status: 200 }),
      );
    globalThis.fetch = fetchMock as typeof fetch;

    const keyboard = { inline_keyboard: [[{ text: "Approve", callback_data: "approve:1" }]] };
    const bot = new TelegramBotClient("test-token");
    const result = await bot.sendMessage({
      chat_id: "chat-1",
      text: "*unsafe [title] with _markdown_",
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });

    expect(result.message_id).toBe(17);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body));
    expect(secondBody).toEqual({ chat_id: "chat-1", text: "*unsafe [title] with _markdown_", reply_markup: keyboard });
  });
});
