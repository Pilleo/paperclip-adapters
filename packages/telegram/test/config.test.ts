import { describe, it, expect } from "vitest";
import { isUserAuthorized, loadTelegramConfig } from "../src/config.js";

describe("Telegram Config & Security Whitelist", () => {
  it("authorizes only users in whitelist", () => {
    const whitelist = [12345, 67890];
    expect(isUserAuthorized(12345, whitelist)).toBe(true);
    expect(isUserAuthorized(67890, whitelist)).toBe(true);
    expect(isUserAuthorized(99999, whitelist)).toBe(false);
    expect(isUserAuthorized(undefined, whitelist)).toBe(false);
  });

  it("fails closed when whitelist is empty", () => {
    expect(isUserAuthorized(12345, [])).toBe(false);
  });

  it("parses comma-separated allowed user IDs from env", () => {
    const cfg = loadTelegramConfig({
      TELEGRAM_BOT_TOKEN: "mock-token",
      TELEGRAM_ALLOWED_USER_IDS: " 111, 222 , 333 ",
      TELEGRAM_CHAT_ID: "-1001234",
    });

    expect(cfg.botToken).toBe("mock-token");
    expect(cfg.allowedUserIds).toEqual([111, 222, 333]);
    expect(cfg.defaultChatId).toBe("-1001234");
  });
});
