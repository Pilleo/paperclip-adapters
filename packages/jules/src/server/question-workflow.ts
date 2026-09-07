/**
 * Pure protocol state for a provider question.
 *
 * The reviewer child owns only the adjudication decision. The parent Jules
 * run owns the parent interaction and provider relay. Keeping those effects
 * separate prevents a child checkout lock from causing a parent 409.
 */
export type QuestionWorkflowInput = {
  readonly parentIssueId: string;
  readonly sessionId: string;
  readonly activityId: string;
  readonly parentCard:
    | { readonly state: "pending"; readonly id: string }
    | { readonly state: "answered"; readonly id: string };
  readonly reviewerChild:
    | { readonly state: "waiting"; readonly id: string }
    | { readonly state: "answered"; readonly id: string; readonly answer: string }
    | { readonly state: "escalated"; readonly id: string; readonly reason: string };
};

export type QuestionWorkflowDecision =
  | { readonly action: "await_reviewer" }
  | { readonly action: "relay_answer"; readonly answer: string }
  | { readonly action: "escalate_parent"; readonly reason: string }
  | { readonly action: "complete" };

export type QuestionReviewFormDecision =
  | { readonly kind: "ANSWER"; readonly answer: string }
  | { readonly kind: "ESCALATE"; readonly reason: string };

export type NativeQuestionReviewState =
  | { readonly state: "pending" }
  | { readonly state: "answered"; readonly decision: QuestionReviewFormDecision }
  | { readonly state: "answered"; readonly decision: "malformed" };

/**
 * Parse only Paperclip's structured ask_user_questions result. Reviewer prose
 * in comments is intentionally not a fallback protocol.
 */
export function readQuestionReviewFormDecision(result: unknown): QuestionReviewFormDecision | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const answers = (result as { answers?: unknown }).answers;
  if (!Array.isArray(answers)) return null;
  const resolution = answers.find((entry) => entry && typeof entry === "object" &&
    (entry as { questionId?: unknown }).questionId === "resolution") as { optionIds?: unknown } | undefined;
  const response = answers.find((entry) => entry && typeof entry === "object" &&
    (entry as { questionId?: unknown }).questionId === "response") as { otherText?: unknown } | undefined;
  const choice = Array.isArray(resolution?.optionIds) && typeof resolution.optionIds[0] === "string"
    ? resolution.optionIds[0]
    : null;
  const text = typeof response?.otherText === "string" ? response.otherText.trim() : "";
  if (!text) return null;
  if (choice === "answer") return { kind: "ANSWER", answer: text };
  if (choice === "escalate") return { kind: "ESCALATE", reason: text };
  return null;
}

/** Normalize the interaction once so callers can use an exhaustive switch. */
export function classifyNativeQuestionReview(
  status: string | undefined,
  result: unknown,
): NativeQuestionReviewState {
  switch (status) {
    case "pending":
      return { state: "pending" };
    case "answered": {
      const decision = readQuestionReviewFormDecision(result);
      return decision
        ? { state: "answered", decision }
        : { state: "answered", decision: "malformed" };
    }
    default:
      return { state: "pending" };
  }
}

/**
 * Paperclip expires an interaction with this result when its host issue is
 * completed.  It identifies the historical child-activation race precisely:
 * the reviewer completed the child before its typed decision form could be
 * answered.  This is not reviewer input and must never be interpreted as one.
 */
export function isExpiredQuestionBridge(result: unknown, status: string | undefined): boolean {
  if (status !== "expired" || !result || typeof result !== "object" || Array.isArray(result)) return false;
  return (result as { outcome?: unknown }).outcome === "issue_closed";
}

export function reduceQuestionWorkflow(input: QuestionWorkflowInput): QuestionWorkflowDecision {
  if (input.parentCard.state === "answered") return { action: "complete" };
  if (input.reviewerChild.state === "answered") {
    return { action: "relay_answer", answer: input.reviewerChild.answer };
  }
  if (input.reviewerChild.state === "escalated") {
    return { action: "escalate_parent", reason: input.reviewerChild.reason };
  }
  return { action: "await_reviewer" };
}
