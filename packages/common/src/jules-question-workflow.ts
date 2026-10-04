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

export type TerminalQuestionDisposition =
  | { readonly action: "not_terminal" }
  | { readonly action: "retain" }
  | { readonly action: "resolved" }
  | { readonly action: "retire" };

/**
 * Provider activity ordering, rather than a coarse terminal state, decides
 * whether terminal cleanup may retire a question. A post-completion question
 * is new provider work and must remain answerable through a typed card.
 */
export function evaluateTerminalQuestionDisposition(input: {
  readonly terminal: boolean;
  readonly followsCompletion: boolean;
  readonly terminalAnswerRecorded: boolean;
}): TerminalQuestionDisposition {
  if (!input.terminal) return { action: "not_terminal" };
  if (input.terminalAnswerRecorded) return { action: "resolved" };
  if (input.followsCompletion) return { action: "retain" };
  return { action: "retire" };
}

export type TerminalQuestionRecoveryCard = "cancelled_terminal" | "cancelled_other" | "pending_generation_one" | "none";
export type TerminalQuestionRecoveryDecision =
  | { readonly action: "recover_generation_one" }
  | { readonly action: "retain_pending" }
  | { readonly action: "resolved" }
  | { readonly action: "retire" }
  | { readonly action: "human_escalation" }
  | { readonly action: "ignore" };

export function evaluateTerminalQuestionRecovery(input: {
  readonly terminal: boolean;
  readonly followsCompletion: boolean;
  readonly answerRecorded: boolean;
  readonly card: TerminalQuestionRecoveryCard;
}): TerminalQuestionRecoveryDecision {
  if (!input.terminal) return { action: "ignore" };
  if (input.answerRecorded) return { action: "resolved" };
  if (!input.followsCompletion) return { action: "retire" };
  switch (input.card) {
    case "cancelled_terminal": return { action: "recover_generation_one" };
    case "pending_generation_one": return { action: "retain_pending" };
    case "cancelled_other": return { action: "human_escalation" };
    case "none": return { action: "ignore" };
    default: {
      const impossible: never = input.card;
      return impossible;
    }
  }
}

/**
 * Parse only Paperclip's structured ask_user_questions result. Reviewer prose
 * in comments is intentionally not a fallback protocol.
 */
export function readQuestionReviewFormDecision(result: unknown): QuestionReviewFormDecision | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const answers = (result as { answers?: unknown }).answers;
  if (!Array.isArray(answers)) return null;
  const reply = answers.find((entry) => entry && typeof entry === "object" &&
    (entry as { questionId?: unknown }).questionId === "reply") as { otherText?: unknown; optionIds?: unknown } | undefined;
  if (reply) {
    if (answers.length !== 1 || !Array.isArray(reply.optionIds) || reply.optionIds.length !== 1 || reply.optionIds[0] !== "response") return null;
    const text = typeof reply.otherText === "string" ? reply.otherText.trim() : "";
    return text ? { kind: "ANSWER", answer: text } : null;
  }
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
