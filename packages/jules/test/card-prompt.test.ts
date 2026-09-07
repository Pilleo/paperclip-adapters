import { describe, it, expect } from "vitest";
import {
  formatCardPrompt,
  appendCardHelpText,
  formatCardSummary,
  formatConfirmationDetails,
  MAX_CONFIRMATION_DETAILS_LENGTH,
  MAX_CARD_PROMPT_LENGTH,
  MAX_CARD_SUMMARY_LENGTH,
  MAX_CARD_HELP_TEXT_SCHEMA_LENGTH,
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

  it.each([0, 10, 900, 5_000])(
    "keeps composed provider context and protocol instructions within the host helpText limit (%i chars)",
    (providerLength) => {
      const instructions = "Submit the native form with the exact structured answer.";
      const result = appendCardHelpText("q".repeat(providerLength), instructions);
      expect(result.length).toBeLessThanOrEqual(MAX_CARD_HELP_TEXT_SCHEMA_LENGTH);
      expect(result).toContain(instructions);
    },
  );

  it("preserves ordinary plan details and deterministically bounds oversized details", () => {
    const ordinary = "# Plan\n\n" + "- step\n".repeat(100);
    const ordinaryDetails = formatConfirmationDetails(ordinary, 3);
    expect(ordinaryDetails).toBe(`Review target: plan revision 3\n\n${ordinary.trim()}`);

    const oversizedDetails = formatConfirmationDetails("x".repeat(30_000), 3);
    expect(oversizedDetails.length).toBe(MAX_CONFIRMATION_DETAILS_LENGTH);
    expect(oversizedDetails).toContain("Review target: plan revision 3");
    expect(oversizedDetails).toContain("review the linked immutable plan document");
  });
});
