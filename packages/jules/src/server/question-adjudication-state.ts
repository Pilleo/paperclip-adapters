import { parseQuestionAdjudication, type QuestionAdjudication } from "./question-adjudication.js";

export type QuestionAdjudicationChildState = "waiting" | "answer" | "escalate" | "protocol_error";

export interface QuestionAdjudicationChildEvaluation {
  readonly state: QuestionAdjudicationChildState;
  readonly decision: QuestionAdjudication | null;
}

/**
 * The child status is scheduling metadata, not the reviewer protocol. A child
 * is complete only after its assigned reviewer has posted exactly one valid
 * JSON decision. In particular, prose followed by `done` is a protocol error,
 * not an approval and never authorizes a provider message.
 */
export function evaluateQuestionAdjudicationChild(input: {
  status: string | undefined;
  reviewerAgentId: string;
  comments: ReadonlyArray<{ authorAgentId?: string | null; body: string }>;
}): QuestionAdjudicationChildEvaluation {
  const decision = [...input.comments]
    .reverse()
    .filter((comment) => comment.authorAgentId === input.reviewerAgentId)
    .map((comment) => parseQuestionAdjudication(comment.body))
    .find((candidate): candidate is QuestionAdjudication => candidate !== null) ?? null;

  if (decision?.kind === "ANSWER") return { state: "answer", decision };
  if (decision?.kind === "ESCALATE") return { state: "escalate", decision };
  if (input.status === "done") return { state: "protocol_error", decision: null };
  return { state: "waiting", decision: null };
}
