export type ReviewDecision =
  | { readonly decision: "all_good"; readonly comment?: string }
  | { readonly decision: "needs_work"; readonly comment: string };

export const REVIEW_DECISION_PREFIX = "PAPERCLIP_REVIEW_DECISION ";

/** Validates an already decoded reviewer decision without accepting prose. */
export function validateReviewDecision(value: unknown): ReviewDecision | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const comment = typeof record["comment"] === "string" ? record["comment"].trim() : "";
  if (record["decision"] === "all_good") return comment ? { decision: "all_good", comment } : { decision: "all_good" };
  if (record["decision"] === "needs_work" && comment) return { decision: "needs_work", comment };
  return null;
}

export function parseReviewDecisionComment(body: string): ReviewDecision | null {
  const firstLine = body.trim().split("\n", 1)[0] ?? "";
  if (!firstLine.startsWith(REVIEW_DECISION_PREFIX)) return null;
  try {
    const value = JSON.parse(firstLine.slice(REVIEW_DECISION_PREFIX.length)) as Record<string, unknown>;
    return validateReviewDecision(value);
  } catch {
    // Invalid machine decisions are deliberately ignored.
  }
  return null;
}
