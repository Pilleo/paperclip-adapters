/**
 * Compile-time branded types and pure formatting functions for Paperclip card prompts and summaries.
 * Guarantees that no prompt exceeding Paperclip Zod schema limits (max 500 for prompt, max 1000 for helpText, max 200 for summary)
 * reaches Paperclip API constructors.
 */

declare const SafeCardPromptBrand: unique symbol;
export type SafeCardPrompt = string & { readonly [SafeCardPromptBrand]: true };

declare const SafeCardSummaryBrand: unique symbol;
export type SafeCardSummary = string & { readonly [SafeCardSummaryBrand]: true };

export const MAX_CARD_PROMPT_LENGTH = 490;
export const MAX_CARD_HELP_TEXT_LENGTH = 900;
export const MAX_CARD_SUMMARY_LENGTH = 190;

/**
 * Split a long question cleanly between prompt (<=490 chars) and helpText (<=990 chars)
 * so the user sees the complete context without truncation.
 */
export function formatCardPromptAndHelpText(raw: string): { prompt: SafeCardPrompt; helpText?: string | undefined } {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) {
    return { prompt: "Please provide input." as SafeCardPrompt };
  }
  if (trimmed.length <= MAX_CARD_PROMPT_LENGTH) {
    return { prompt: trimmed as SafeCardPrompt };
  }

  // Find a clean split point (e.g. newline or period)
  let splitIdx = trimmed.lastIndexOf("\n", MAX_CARD_PROMPT_LENGTH);
  if (splitIdx < 100) {
    splitIdx = trimmed.lastIndexOf(". ", MAX_CARD_PROMPT_LENGTH);
    if (splitIdx > 0) splitIdx += 1;
  }
  if (splitIdx < 100) {
    splitIdx = MAX_CARD_PROMPT_LENGTH;
  }

  const promptPart = trimmed.slice(0, splitIdx).trim();
  const rest = trimmed.slice(splitIdx).trim();
  const helpText = rest.slice(0, MAX_CARD_HELP_TEXT_LENGTH);

  return {
    prompt: promptPart as SafeCardPrompt,
    helpText: helpText || undefined,
  };
}

/**
 * Pure function to format a question/prompt safely within Paperclip card limits.
 * Truncates cleanly with ellipsis if length exceeds maxLen.
 */
export function formatCardPrompt(raw: string, maxLen = MAX_CARD_PROMPT_LENGTH): SafeCardPrompt {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) {
    return "Please provide input." as SafeCardPrompt;
  }
  if (trimmed.length <= maxLen) {
    return trimmed as SafeCardPrompt;
  }
  return `${trimmed.slice(0, maxLen - 3)}...` as SafeCardPrompt;
}

/**
 * Pure function to format a summary safely within Paperclip card limits.
 */
export function formatCardSummary(raw: string, maxLen = MAX_CARD_SUMMARY_LENGTH): SafeCardSummary {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) {
    return "Question from Jules" as SafeCardSummary;
  }
  if (trimmed.length <= maxLen) {
    return trimmed as SafeCardSummary;
  }
  return `${trimmed.slice(0, maxLen - 3)}...` as SafeCardSummary;
}
