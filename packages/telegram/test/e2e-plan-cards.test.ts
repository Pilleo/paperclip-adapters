import { describe, it, expect, vi } from "vitest";
import { formatPlanApprovalCard } from "../src/formatters.js";
import { handleTelegramCallback } from "../src/handlers.js";
import { TelegramBotClient } from "../src/telegram-api.js";
import { PaperclipApiClient } from "../src/paperclip-client.js";

describe("Telegram Plan Card & Approval E2E", () => {
  it("formats architectural plan approval card with structured steps and approve/revise buttons", () => {
    const card = formatPlanApprovalCard({
      planId: "plan-141",
      issueIdentifier: "MAZ-141",
      issueTitle: "Cap SandboxDispatcher poolCache growth",
      agentName: "Jules",
      planMarkdown: "1. Create PoolKey projection\n2. Add bounded LRU cache with shutdown",
    });

    expect(card.text).toContain("Architectural Plan Approval");
    expect(card.text).toContain("[MAZ-141] Cap SandboxDispatcher poolCache growth");
    expect(card.text).toContain("Create PoolKey projection");
    expect(card.text).toContain("Add bounded LRU cache with shutdown");
    expect(card.replyMarkup.inline_keyboard[0]![0]!.text).toBe("✅ Approve Plan");
    expect(card.replyMarkup.inline_keyboard[0]![1]!.text).toBe("✏️ Request Revision");
  });

  it("handles plan approval callback by resolving interaction in Paperclip and waking up the agent", async () => {
    const mockBot = {
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
      editMessageText: vi.fn().mockResolvedValue(true),
    } as unknown as TelegramBotClient;

    const mockPc = {
      postJson: vi.fn().mockResolvedValue({ success: true }),
      getJson: vi.fn().mockResolvedValue([
        { id: "agent-orch-1", adapterType: "orchestrator", name: "Task Orchestrator" },
        { id: "agent-jules-1", adapterType: "jules", name: "Jules" },
      ]),
    } as unknown as PaperclipApiClient;

    await handleTelegramCallback(
      {
        id: "cb-plan-1",
        from: { id: 100, username: "lead_dev" },
        data: "approve:plan:plan-141",
        message: {
          message_id: 88,
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

    // Must resolve approval in Paperclip
    expect(mockPc.postJson).toHaveBeenCalledWith(
      "/api/approvals/plan-141/approve",
      expect.objectContaining({ actor: "telegram:100" })
    );

    expect(mockPc.postJson).toHaveBeenCalledWith(
      "/api/agents/agent-orch-1/wakeup",
      expect.objectContaining({ reason: "plan_approved" })
    );
    expect(mockPc.postJson).not.toHaveBeenCalledWith(
      "/api/agents/agent-jules-1/wakeup",
      expect.anything()
    );

    // Must update message text on Telegram
    expect(mockBot.editMessageText).toHaveBeenCalledWith(
      12345,
      88,
      expect.stringContaining("Plan Approved")
    );
  });
});
