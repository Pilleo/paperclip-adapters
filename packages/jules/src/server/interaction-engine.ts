/**
 * Pure, side-effect-free interaction and session transition engine for the Jules adapter.
 * Enforces all state transition rules, answer deduplication, and Paperclip issue status policies.
 */

import { JulesAdapterSessionV1, SessionPhase } from "./session.js";
import { PaperclipInteraction } from "./paperclip-client.js";
import { formatCardPrompt, formatCardSummary, SafeCardPrompt, SafeCardSummary } from "./card-prompt.js";

export type InteractionAction =
  | { type: "RELAY_FEEDBACK"; answer: string; interactionId: string }
  | { type: "RELAY_PLAN_APPROVAL"; planRevisionId: string; interactionId: string }
  | { type: "CREATE_FEEDBACK_CARD"; question: SafeCardPrompt | string; summary: SafeCardSummary; attempt: number }
  | { type: "CREATE_PLAN_CARD"; planMarkdown: string; revisionNumber: number }
  | { type: "WAIT_FOR_HUMAN"; interactionId?: string; summary: string }
  | { type: "CONTINUE_POLLING" }
  | { type: "RESOLVE_COMPLETION_WITH_PR"; prUrl: string }
  | { type: "CONFIRM_NO_PR_COMPLETION"; sessionId: string }
  | { type: "RESET_PAUSED_SESSION"; sessionId: string; reason: string };

/**
 * Extracts a human feedback answer from an answered Paperclip interaction payload.
 */
export function extractFeedbackAnswer(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const answers = (result as { answers?: Array<{ otherText?: string; optionId?: string }> }).answers;
  if (!Array.isArray(answers) || answers.length === 0) return null;
  const first = answers[0];
  if (typeof first?.otherText === "string" && first.otherText.trim().length > 0) {
    return first.otherText.trim();
  }
  if (typeof first?.optionId === "string" && first.optionId.trim().length > 0) {
    if (first.optionId.trim() === "response" || first.optionId.trim() === "reply") {
      return null; // Placeholder option IDs require freeText otherText
    }
    return first.optionId.trim();
  }
  return null;
}

/**
 * Pure reducer that determines what action the adapter should perform given the current session,
 * the polled Jules state, and any existing Paperclip interactions on the issue.
 */
export function evaluateInteractionAction(
  session: JulesAdapterSessionV1,
  julesState: string,
  existingInteractions: PaperclipInteraction[] = [],
  rawQuestionText?: string,
): InteractionAction {
  // 1. Terminal / Success states
  if (julesState === "COMPLETED") {
    if (session.currentPrUrl) {
      return { type: "RESOLVE_COMPLETION_WITH_PR", prUrl: session.currentPrUrl };
    }
    return { type: "CONFIRM_NO_PR_COMPLETION", sessionId: session.julesSessionId ?? "" };
  }

  // 2. Operator paused/archived session
  if (julesState === "PAUSED") {
    return {
      type: "RESET_PAUSED_SESSION",
      sessionId: session.julesSessionId ?? "",
      reason: "operator_paused",
    };
  }

  // 3. Active coding states
  if (julesState === "QUEUED" || julesState === "PLANNING" || julesState === "IN_PROGRESS") {
    return { type: "CONTINUE_POLLING" };
  }

  // 3. Jules is awaiting user feedback
  if (julesState === "AWAITING_USER_FEEDBACK") {
    const currentCardId = session.pendingInteraction?.type === "user_feedback"
      ? session.pendingInteraction.paperclipInteractionId
      : null;

    if (currentCardId) {
      const currentCard = existingInteractions.find((i) => i.id === currentCardId);
      if (currentCard && currentCard.status === "answered") {
        const answer = extractFeedbackAnswer(currentCard.result);
        if (answer && session.deliveredFeedbackInteractionId !== currentCard.id) {
          return {
            type: "RELAY_FEEDBACK",
            answer,
            interactionId: currentCard.id,
          };
        }
        return {
          type: "WAIT_FOR_HUMAN",
          interactionId: currentCard.id,
          summary: `Jules session ${session.julesSessionId} is processing relayed user feedback.`,
        };
      }
      if (currentCard && currentCard.status === "pending") {
        return {
          type: "WAIT_FOR_HUMAN",
          interactionId: currentCard.id,
          summary: `Jules session ${session.julesSessionId} awaits feedback in Paperclip.`,
        };
      }
    }

    // Check if there is any other active pending card
    const anyPending = existingInteractions.find(
      (i) => i.kind === "ask_user_questions" && i.status === "pending"
    );
    if (anyPending) {
      return {
        type: "WAIT_FOR_HUMAN",
        interactionId: anyPending.id,
        summary: `Jules session ${session.julesSessionId} awaits feedback in Paperclip.`,
      };
    }

    // No valid pending or un-relayed card exists for current state: create a new card
    const question = rawQuestionText ?? "Jules is awaiting user feedback.";
    const summary = formatCardSummary(rawQuestionText ?? "Question from Jules");
    const attempt = (session.feedbackInteractionAttempt ?? 0) + 1;

    return {
      type: "CREATE_FEEDBACK_CARD",
      question,
      summary,
      attempt,
    };
  }

  // 4. Jules is awaiting plan approval
  if (julesState === "AWAITING_PLAN_APPROVAL") {
    if (session.planApprovedAt) {
      return {
        type: "WAIT_FOR_HUMAN",
        summary: `Jules session ${session.julesSessionId} is processing plan approval.`,
      };
    }

    const currentCardId = session.pendingInteraction?.type === "plan_approval"
      ? session.pendingInteraction.paperclipInteractionId
      : null;

    if (currentCardId) {
      const currentCard = existingInteractions.find((i) => i.id === currentCardId);
      if (currentCard && currentCard.status === "accepted") {
        return {
          type: "RELAY_PLAN_APPROVAL",
          planRevisionId: (currentCard.result as { planRevisionId?: string })?.planRevisionId ?? "accepted",
          interactionId: currentCard.id,
        };
      }
      if (currentCard && currentCard.status === "pending") {
        return {
          type: "WAIT_FOR_HUMAN",
          interactionId: currentCard.id,
          summary: `Jules session ${session.julesSessionId} awaits plan approval in Paperclip.`,
        };
      }
    }

    const anyPending = existingInteractions.find(
      (i) => i.kind === "request_confirmation" && i.status === "pending"
    );
    if (anyPending) {
      return {
        type: "WAIT_FOR_HUMAN",
        interactionId: anyPending.id,
        summary: `Jules session ${session.julesSessionId} awaits plan approval in Paperclip.`,
      };
    }

    return {
      type: "CREATE_PLAN_CARD",
      planMarkdown: rawQuestionText ?? "Proposed execution plan from Jules.",
      revisionNumber: 1,
    };
  }

  return { type: "CONTINUE_POLLING" };
}

/**
 * Pure state updater: records that feedback for a specific interaction was sent to Jules.
 */
export function recordFeedbackRelayed(
  session: JulesAdapterSessionV1,
  interactionId: string,
): JulesAdapterSessionV1 {
  return {
    ...session,
    deliveredFeedbackInteractionId: interactionId,
    pendingInteraction: undefined,
    phase: "RUNNING",
  };
}

/**
 * Pure state updater: records that plan approval was sent to Jules.
 */
export function recordPlanApprovalRelayed(
  session: JulesAdapterSessionV1,
): JulesAdapterSessionV1 {
  return {
    ...session,
    planApprovedAt: new Date().toISOString(),
    pendingInteraction: undefined,
    phase: "RUNNING",
  };
}

export interface PaperclipIssueStatePolicy {
  status: "in_progress" | "in_review" | "done" | "blocked";
  unblockDescriptor: null;
}

/**
 * Pure status mapper: guarantees that interactive user wait states NEVER emit status: "blocked"
 * or unblock descriptors, preventing supervisor/Chief-of-Staff intervention loops.
 */
export function determinePaperclipIssueStatus(phase: SessionPhase): PaperclipIssueStatePolicy {
  switch (phase) {
    case "WAITING_FOR_FEEDBACK":
    case "WAITING_FOR_PLAN_APPROVAL":
    case "RUNNING":
    case "STARTING":
    case "PR_CREATED":
    case "RETRY_SCHEDULED":
      return { status: "in_progress", unblockDescriptor: null };
    case "COMPLETED":
      return { status: "in_review", unblockDescriptor: null };
    case "FAILED":
      return { status: "blocked", unblockDescriptor: null };
    default:
      return { status: "in_progress", unblockDescriptor: null };
  }
}
