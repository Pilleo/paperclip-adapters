import { describe, it, expect, vi } from "vitest";
import { PaperclipTelegramPoller } from "../src/poller.js";
import { TelegramBotClient } from "../src/telegram-api.js";
import { PaperclipApiClient } from "../src/paperclip-client.js";

describe("Paperclip Telegram Poller", () => {
  it("detects pending approvals and posts cards once without duplicating", async () => {
    const mockBot = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 10 }),
    } as unknown as TelegramBotClient;

    const mockApprovals = [
      {
        id: "app-1",
        status: "pending",
        issueIdentifier: "MAZ-200",
        issueTitle: "Implement Landlock ABI V5",
        prNumber: 99,
        prUrl: "https://github.com/pilleo/mazewall/pull/99",
      },
    ];

    const mockPc = {
      getJson: vi.fn().mockResolvedValue(mockApprovals),
    } as unknown as PaperclipApiClient;

    const poller = new PaperclipTelegramPoller({
      botClient: mockBot,
      paperclipClient: mockPc,
      defaultChatId: "-100999",
      companyId: "comp-123",
      pollIntervalMs: 5000,
    });

    const firstCount = await poller.checkPendingApprovals();
    expect(firstCount).toBe(1);
    expect(mockBot.sendMessage).toHaveBeenCalledTimes(1);
    expect(mockBot.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_id: "-100999",
        text: expect.stringContaining("MAZ-200"),
      })
    );

    const secondCount = await poller.checkPendingApprovals();
    expect(secondCount).toBe(0);
    expect(mockBot.sendMessage).toHaveBeenCalledTimes(1);
  });
});
