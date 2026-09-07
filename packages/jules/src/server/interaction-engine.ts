/**
 * Pure, side-effect-free interaction and session transition engine for the Jules adapter.
 * Enforces all state transition rules, answer deduplication, and Paperclip issue status policies.
 */

import { JulesAdapterSessionV1, SessionPhase } from "./session.js";
import { PaperclipInteraction } from "./paperclip-client.js";
import { formatCardSummary, SafeCardPrompt, SafeCardSummary } from "./card-prompt.js";
import { parsePlanReviewVerdictResult } from "./plan-review-protocol.js";
import { createHash } from "node:crypto";

export type PlanStepFingerprintInput = {
  readonly index?: number | undefined;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
};

/** Fingerprints only typed plan steps; generated prose and review comments are excluded. */
export function fingerprintPlanSteps(steps: readonly PlanStepFingerprintInput[]): string {
  const canonical = [...steps]
    .map((step) => ({ index: step.index ?? null, title: step.title?.trim() ?? "", description: step.description?.trim() ?? "" }))
    .sort((left, right) => (left.index ?? Number.MAX_SAFE_INTEGER) - (right.index ?? Number.MAX_SAFE_INTEGER));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export type InteractionAction =
  | { type: "RELAY_FEEDBACK"; answer: string; interactionId: string }
  | { type: "RELAY_PLAN_APPROVAL"; planRevisionId: string; interactionId: string }
  | { type: "CREATE_FEEDBACK_CARD"; question: SafeCardPrompt | string; summary: SafeCardSummary; attempt: number }
  | { type: "CREATE_AGENT_ADJUDICATION"; question: string }
  | { type: "CREATE_PLAN_CARD"; planMarkdown: string; revisionNumber: number }
  | { type: "WAIT_FOR_HUMAN"; interactionId?: string; summary: string }
  | { type: "CONTINUE_POLLING" }
  | { type: "RESOLVE_COMPLETION_WITH_PR"; prUrl: string }
  | { type: "CONFIRM_NO_PR_COMPLETION"; sessionId: string }
  | { type: "RESET_PAUSED_SESSION"; sessionId: string; reason: string };

export type PlanReviewVerdict =
  | { readonly decision: "approve" }
  | { readonly decision: "reject"; readonly reason: string };

/** Reads only Paperclip's typed verdict result; comments are not input. */
export function extractPlanReviewVerdict(interaction: PaperclipInteraction | undefined): PlanReviewVerdict | null {
  if (!interaction) return null;
  if (interaction.kind === "request_item_verdicts" && interaction.status === "answered") {
    const verdict = parsePlanReviewVerdictResult(interaction.result);
    if (!verdict) return null;
    return verdict.kind === "approve" ? { decision: "approve" } : { decision: "reject", reason: verdict.reason! };
  }
  if (interaction.kind !== "request_confirmation" ||
      (interaction.status !== "accepted" && interaction.status !== "rejected")) return null;
  const result = interaction.result;
  if (interaction.status === "accepted") return { decision: "approve" };
  const reason = result && typeof result === "object" ? (result as { reason?: unknown }).reason : undefined;
  return typeof reason === "string" && reason.trim() ? { decision: "reject", reason: reason.trim() } : null;
}

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
  rawQuestionActivityId?: string,
): InteractionAction {
  // Plan availability is supplied by the provider activity/state machine.
  // Never infer a transition by matching Jules-generated prose: wording is
  // not a stable protocol and can cause an unrelated message to open a plan
  // gate.
  const effectiveState = julesState;

  // 1. Jules is awaiting plan approval
  if (effectiveState === "AWAITING_PLAN_APPROVAL") {
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

    const acceptedPlan = existingInteractions.find(
      (i) => i.kind === "request_confirmation" && i.status === "accepted"
    );
    if (acceptedPlan) {
      return {
        type: "RELAY_PLAN_APPROVAL",
        planRevisionId:
          (acceptedPlan.result as { planRevisionId?: string } | undefined)?.planRevisionId ?? "accepted",
        interactionId: acceptedPlan.id,
      };
    }

    return {
      type: "CREATE_PLAN_CARD",
      planMarkdown: rawQuestionText ?? "Proposed execution plan from Jules.",
      revisionNumber: 1,
    };
  }

  // 2. Jules is awaiting user feedback
  if (effectiveState === "AWAITING_USER_FEEDBACK") {
    if (session.pendingInteraction?.type === "agent_adjudication") {
      return { type: "WAIT_FOR_HUMAN", summary: "Jules question is being adjudicated by the assigned reviewer." };
    }
    if (rawQuestionActivityId && session.deliveredFeedbackActivityId === rawQuestionActivityId) {
      return { type: "CONTINUE_POLLING" };
    }
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

    // Agent-adjudication records deliberately use Paperclip's question form
    // so their question and final answer are visible on the parent issue.
    // They are not human cards, however.  A stale or historical reviewer
    // record must never suppress a newer provider question; only a real
    // user-feedback card may hold this state machine at a human boundary.
    const anyPending = existingInteractions.find(
      (i) => i.kind === "ask_user_questions" &&
        i.status === "pending" &&
        !i.idempotencyKey?.startsWith("jules:agent-adjudication:")
    );
    if (anyPending) {
      return {
        type: "WAIT_FOR_HUMAN",
        interactionId: anyPending.id,
        summary: `Jules session ${session.julesSessionId} awaits feedback in Paperclip.`,
      };
    }

    return { type: "CREATE_AGENT_ADJUDICATION", question: rawQuestionText ?? "Jules is awaiting user feedback." };
  }

  // 3. Terminal / Success states
  if (effectiveState === "COMPLETED") {
    if (session.currentPrUrl) {
      return { type: "RESOLVE_COMPLETION_WITH_PR", prUrl: session.currentPrUrl };
    }
    return { type: "CONFIRM_NO_PR_COMPLETION", sessionId: session.julesSessionId ?? "" };
  }

  // 4. Operator paused/archived session
  if (effectiveState === "PAUSED") {
    return {
      type: "RESET_PAUSED_SESSION",
      sessionId: session.julesSessionId ?? "",
      reason: "operator_paused",
    };
  }

  // 5. Active coding states
  if (effectiveState === "QUEUED" || effectiveState === "PLANNING" || effectiveState === "IN_PROGRESS") {
    return { type: "CONTINUE_POLLING" };
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
    deliveredFeedbackActivityId: session.pendingInteraction?.type === "user_feedback"
      ? session.pendingInteraction.julesActivityId
      : session.deliveredFeedbackActivityId,
    pendingInteraction: undefined,
    phase: "RUNNING",
  };
}

/**
 * Pure state updater: records that plan approval was sent to Jules.
 */
export function recordPlanApprovalRelayed(
  session: JulesAdapterSessionV1,
  planActivityId?: string,
): JulesAdapterSessionV1 {
  return {
    ...session,
    planApprovedAt: new Date().toISOString(),
    ...(planActivityId ? { planApprovedActivityId: planActivityId } : {}),
    pendingInteraction: undefined,
    phase: "RUNNING",
  };
}

/**
 * A plan gate is a property of one provider plan activity, not of the whole
 * Jules session. The activity identity makes polling/restarts idempotent while
 * still reopening the gate for a genuinely regenerated plan. Sessions written
 * before this field existed retain the old approved-session behavior.
 */
export function isPlanApprovalRequired(input: {
  requirePlanApproval: boolean;
  planActivityId?: string | undefined;
  planApprovedAt?: string | undefined;
  planApprovedActivityId?: string | undefined;
  supersededPlanActivityId?: string | undefined;
  planFingerprint?: string | undefined;
  supersededPlanFingerprint?: string | undefined;
}): boolean {
  if (!input.requirePlanApproval || !input.planActivityId) return false;
  if (input.supersededPlanActivityId === input.planActivityId) return false;
  if (input.planFingerprint && input.supersededPlanFingerprint === input.planFingerprint) return false;
  if (!input.planApprovedAt) return true;
  if (!input.planApprovedActivityId) return false;
  return input.planApprovedActivityId !== input.planActivityId;
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
