import { JulesAdapterSessionV1 } from "./session.js";
import { PaperclipInteraction } from "./paperclip-client.js";
import { readContextRecord, readContextString } from "./session-lifecycle.js";

export type ResolvedInteractionType = "plan_approval" | "user_feedback" | "completion_confirmation" | "none";

export interface ResolvedInteraction {
  type: ResolvedInteractionType;
  interactionId: string | null;
  kind: string | null;
  status: "accepted" | "rejected" | "answered" | "pending" | "cancelled" | null;
  answer?: string | undefined;
  isAccepted: boolean;
  isRejected: boolean;
  isAnswered: boolean;
}

export function extractResolvedInteraction(
  rawContext: Record<string, unknown>,
  session: JulesAdapterSessionV1 | null
): ResolvedInteraction {
  const paperclipWake = readContextRecord(rawContext, "paperclipWake");
  const contextSnapshot = readContextRecord(rawContext, "contextSnapshot");
  const planReviewInteraction = readContextRecord(rawContext, "planReviewInteraction") ||
    readContextRecord(contextSnapshot, "planReviewInteraction");

  let interactionId = readContextString(rawContext, "interactionId") ??
    readContextString(paperclipWake, "interactionId") ??
    readContextString(planReviewInteraction, "id");

  let interactionKind = readContextString(rawContext, "interactionKind") ??
    readContextString(paperclipWake, "interactionKind") ??
    readContextString(planReviewInteraction, "kind");

  let interactionStatus = readContextString(rawContext, "interactionStatus") ??
    readContextString(paperclipWake, "interactionStatus") ??
    readContextString(planReviewInteraction, "status");

  if (!interactionStatus && planReviewInteraction && Object.keys(planReviewInteraction).length > 0) {
    const res = readContextRecord(planReviewInteraction, "result");
    const outcome = readContextString(res, "outcome");
    if (outcome === "accepted" || outcome === "rejected") {
      interactionStatus = outcome;
    }
  }

  // Check interactionResponse for answer payload
  let answer: string | undefined;
  const interactionResponse = rawContext["interactionResponse"];
  if (typeof interactionResponse === "string") {
    answer = interactionResponse;
    interactionStatus = "answered";
  } else if (typeof interactionResponse === "object" && interactionResponse !== null) {
    const respObj = interactionResponse as Record<string, unknown>;
    if (typeof respObj["answer"] === "string") {
      answer = respObj["answer"];
      interactionStatus = "answered";
    }
  }

  const isAccepted = interactionStatus === "accepted";
  const isRejected = interactionStatus === "rejected";
  const isAnswered = interactionStatus === "answered" || Boolean(answer);

  let type: ResolvedInteractionType = "none";
  if (session?.pendingInteraction) {
    type = session.pendingInteraction.type;
  } else if (planReviewInteraction && Object.keys(planReviewInteraction).length > 0) {
    type = "plan_approval";
  }

  return {
    type,
    interactionId,
    kind: interactionKind,
    status: (interactionStatus as ResolvedInteraction["status"]) ?? null,
    answer,
    isAccepted,
    isRejected,
    isAnswered
  };
}

export function formatClarifyingQuestionCard(agentMessage: string): { questionText: string; title: string } {
  return {
    title: "Clarification Needed from Jules",
    questionText: agentMessage.trim()
  };
}
