import { describe, it, expect } from "vitest";
import { isUserAuthorized, loadTelegramConfig, formatMissingSecretError, formatMissingChatIdWarning, parseAllowedUserIds } from "../src/config.js";

describe("Telegram Config & Security Whitelist", () => {
  it("authorizes user by user ID or chat/conversation ID", () => {
    const whitelist = [12345, "chat-999"];
    expect(isUserAuthorized(12345, 12345, whitelist)).toBe(true);
    expect(isUserAuthorized(undefined, "chat-999", whitelist)).toBe(true);
    expect(isUserAuthorized(99999, "unknown-chat", whitelist)).toBe(false);
  });

  it("denies users when whitelist is empty unless TELEGRAM_ALLOW_UNRESTRICTED is set", () => {
    const prev = process.env["TELEGRAM_ALLOW_UNRESTRICTED"];
    delete process.env["TELEGRAM_ALLOW_UNRESTRICTED"];
    expect(isUserAuthorized(12345, 12345, [])).toBe(false);
    process.env["TELEGRAM_ALLOW_UNRESTRICTED"] = "true";
    expect(isUserAuthorized(12345, 12345, [])).toBe(true);
    if (prev === undefined) delete process.env["TELEGRAM_ALLOW_UNRESTRICTED"];
    else process.env["TELEGRAM_ALLOW_UNRESTRICTED"] = prev;
    expect(isUserAuthorized(12345, 12345, ["*"])).toBe(true);
    expect(isUserAuthorized(12345, 12345, ["all"])).toBe(true);
  });

  it("parses comma-separated allowed user IDs from env or string", () => {
    expect(parseAllowedUserIds(" 111, 222 , 333 ")).toEqual([111, 222, 333]);
    expect(parseAllowedUserIds([444, 555])).toEqual([444, 555]);
    expect(parseAllowedUserIds("")).toEqual([]);
    expect(parseAllowedUserIds(undefined)).toEqual([]);
  });

  it("formats a clear, actionable error message when secret is missing", () => {
    const msgWithCompany = formatMissingSecretError("comp-123");
    expect(msgWithCompany).toContain("TELEGRAM_BOT_TOKEN");
    expect(msgWithCompany).toContain("Settings -> Secrets & Keys");
    expect(msgWithCompany).toContain("paperclipai secrets create --company-id comp-123");

    const msgWithoutCompany = formatMissingSecretError();
    expect(msgWithoutCompany).toContain("paperclipai secrets create --name \"TELEGRAM_BOT_TOKEN\"");
  });

  it("formats a clear, actionable warning when TELEGRAM_CHAT_ID is missing", () => {
    const warning = formatMissingChatIdWarning("comp-123");
    expect(warning).toContain("TELEGRAM_CHAT_ID");
    expect(warning).toContain("chatId");
  });
});
