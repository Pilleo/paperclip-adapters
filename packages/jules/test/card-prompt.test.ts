import { describe, it, expect } from "vitest";
import {
  formatCardPrompt,
  formatCardSummary,
  MAX_CARD_PROMPT_LENGTH,
  MAX_CARD_SUMMARY_LENGTH,
} from "../src/server/card-prompt.js";

describe("card-prompt pure formatting", () => {
  it("handles empty or whitespace strings with sensible fallbacks", () => {
    expect(formatCardPrompt("")).toBe("Please provide input.");
    expect(formatCardPrompt("   \n  ")).toBe("Please provide input.");
    expect(formatCardSummary("")).toBe("Question from Jules");
    expect(formatCardSummary("   ")).toBe("Question from Jules");
  });

  it("preserves short prompts within length boundary", () => {
    const text = "What would you like me to do next?";
    expect(formatCardPrompt(text)).toBe(text);
    expect(formatCardSummary(text)).toBe(text);
  });

  it("truncates prompt exactly at max boundary with ellipsis", () => {
    const longText = "a".repeat(600);
    const formatted = formatCardPrompt(longText);
    expect(formatted.length).toBe(MAX_CARD_PROMPT_LENGTH);
    expect(formatted.endsWith("...")).toBe(true);
    expect(formatted).toBe("a".repeat(MAX_CARD_PROMPT_LENGTH - 3) + "...");
  });

  it("truncates summary exactly at max boundary with ellipsis", () => {
    const longText = "b".repeat(300);
    const formatted = formatCardSummary(longText);
    expect(formatted.length).toBe(MAX_CARD_SUMMARY_LENGTH);
    expect(formatted.endsWith("...")).toBe(true);
    expect(formatted).toBe("b".repeat(MAX_CARD_SUMMARY_LENGTH - 3) + "...");
  });

  it("handles multi-line markdown cleanly without overflowing limits", () => {
    const md = "# Title\n\nHere is a list:\n" + "- item\n".repeat(100);
    const formatted = formatCardPrompt(md);
    expect(formatted.length).toBeLessThanOrEqual(MAX_CARD_PROMPT_LENGTH);
    expect(formatted.endsWith("...")).toBe(true);
  });
});
