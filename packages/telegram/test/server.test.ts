import { describe, it, expect, vi, afterEach } from "vitest";
import {
  TelegramConfigSchema,
  telegramAdapterConfigSchema,
  testEnvironment,
  createServerAdapter,
} from "../src/server/index.js";

describe("Paperclip Idiomatic Server Adapter & Configuration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("validates TelegramConfigSchema using Zod", () => {
    const valid = TelegramConfigSchema.parse({
      botToken: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
      allowedUserIds: [123456789],
      defaultChatId: "-100123456789",
    });

    expect(valid.botToken).toBe("123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11");
    expect(valid.allowedUserIds).toEqual([123456789]);
    expect(valid.pollIntervalMs).toBe(3000);
    expect(valid.notifications.approvals).toBe(true);

    expect(() =>
      TelegramConfigSchema.parse({
        botToken: "",
        allowedUserIds: [],
      })
    ).toThrow();
  });

  it("exposes UI-renderable configuration fields", () => {
    expect(telegramAdapterConfigSchema.fields.some((f) => f.key === "botToken")).toBe(true);
    expect(telegramAdapterConfigSchema.fields.some((f) => f.key === "allowedUserIds")).toBe(true);
  });

  it("tests environment and passes when Telegram getMe responds ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          result: { username: "mazewall_operator_bot", first_name: "Mazewall Bot" },
        }),
      })
    );

    const result = await testEnvironment({
      adapterType: "telegram",
      adapterConfig: { botToken: "valid-token" },
    } as any);

    expect(result.status).toBe("pass");
    expect(result.checks[0]?.message).toContain("@mazewall_operator_bot");
  });

  it("tests environment and fails when bot token is missing", async () => {
    const result = await testEnvironment({
      adapterType: "telegram",
      adapterConfig: {},
    } as any);

    expect(result.status).toBe("fail");
    expect(result.checks[0]?.code).toBe("telegram_token_missing");
  });

  it("creates Paperclip server adapter module", () => {
    const adapter = createServerAdapter();
    expect(adapter.type).toBe("telegram");
    expect(typeof adapter.execute).toBe("function");
    expect(typeof adapter.testEnvironment).toBe("function");
    expect(adapter.getConfigSchema()).toBe(telegramAdapterConfigSchema);
  });
});
