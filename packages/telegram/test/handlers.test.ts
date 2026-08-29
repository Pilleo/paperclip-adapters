import { describe, it, expect, vi } from "vitest";
import { handleTelegramCallback, handleTelegramMessage } from "../src/handlers.js";
import { TelegramBotClient } from "../src/telegram-api.js";
import { PaperclipApiClient } from "../src/paperclip-client.js";

describe("Telegram Message & Callback Handlers", () => {
  it("replies with helpful ID instructions when unauthorized user messages bot", async () => {
    const mockBot = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 10 }),
    } as unknown as TelegramBotClient;

    const mockPc = {} as unknown as PaperclipApiClient;

    await handleTelegramMessage(
      {
        message_id: 1,
        chat: { id: 88888 },
        from: { id: 999 },
        text: "/status",
      },
      {
        botClient: mockBot,
        paperclipClient: mockPc,
        allowedUserIds: [100, 200],
      }
    );

    expect(mockBot.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_id: 88888,
        text: expect.stringContaining("Unauthorized Telegram Access"),
      })
    );
  });

  it("approves pending requests when operator clicks approve button", async () => {
    const mockBot = {
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
      editMessageText: vi.fn().mockResolvedValue(true),
    } as unknown as TelegramBotClient;

    const mockPc = {
      postJson: vi.fn().mockResolvedValue({ success: true }),
    } as unknown as PaperclipApiClient;

    await handleTelegramCallback(
      {
        id: "cb-2",
        from: { id: 100, username: "lead_dev" },
        data: "approve:app-123",
        message: {
          message_id: 55,
          chat: { id: 12345 },
        },
      },
      {
        botClient: mockBot,
        paperclipClient: mockPc,
        allowedUserIds: [100],
        companyId: "comp-1",
      }
    );

    expect(mockPc.postJson).toHaveBeenCalledWith("/api/approvals/app-123/approve", {
      actor: "telegram:100",
    });
    expect(mockBot.answerCallbackQuery).toHaveBeenCalledWith("cb-2", "Approved!");
    expect(mockBot.editMessageText).toHaveBeenCalledWith(
      12345,
      55,
      expect.stringContaining("Approved")
    );
  });

  it("forwards operator replies to clarification questions into Paperclip comments", async () => {
    const mockBot = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 60 }),
    } as unknown as TelegramBotClient;

    const mockPc = {
      postJson: vi.fn().mockResolvedValue({ success: true }),
    } as unknown as PaperclipApiClient;

    await handleTelegramMessage(
      {
        message_id: 59,
        chat: { id: 12345 },
        from: { id: 100, username: "architect" },
        text: "Use 64-bit alignment only.",
        reply_to_message: {
          message_id: 58,
          chat: { id: 12345 },
          text: '❓ Clarification Question from Jules\n• Issue: [MAZ-105] Clarify layout\n"Should we support 32-bit?"',
        },
      },
      {
        botClient: mockBot,
        paperclipClient: mockPc,
        allowedUserIds: [100],
        companyId: "comp-1",
      }
    );

    expect(mockPc.postJson).toHaveBeenCalledWith(
      "/api/companies/comp-1/issues/MAZ-105/comments",
      {
        content: expect.stringContaining("Use 64-bit alignment only."),
      }
    );
    expect(mockBot.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Instruction forwarded to agent"),
      })
    );
  });
});
