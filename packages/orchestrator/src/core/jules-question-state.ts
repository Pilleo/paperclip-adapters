/** A native provider-question wait is business state, not orphaned implementation work. */
export function hasPendingJulesQuestion(issueId: string, interactions: readonly Readonly<Record<string, unknown>>[]): boolean {
  return interactions.some(card => card["kind"] === "ask_user_questions" && card["status"] === "pending" &&
    typeof card["idempotencyKey"] === "string" && ["agent-adjudication", "human-escalation", "user-feedback"]
      .some(kind => (card["idempotencyKey"] as string).startsWith(`jules:${kind}:${issueId}:`)));
}

/** Advance only adapter-authored scoped question children while the provider parent remains blocked. */
export async function coordinateJulesQuestionChild(input: {
  childId: string; description: string; api: ChildReviewApi;
}): Promise<{ kind: "waiting" | "parent_answered"; parentId: string } |
  { kind: "wake_owner"; parentId: string; ownerId: string; proofId: string }> {
  const identity = parseQuestionBootstrap(input.description);
  if (!identity) throw new Error("Question coordination has no typed bootstrap identity");
  const parentRoot = `/issues/${encodeURIComponent(identity.parentIssueId)}`;
  const raw = await input.api.get(`${parentRoot}/interactions`);
  if (!Array.isArray(raw)) throw new Error("Question parent interaction listing is incomplete");
  const expectedKey = `jules:agent-adjudication:${identity.parentIssueId}:${identity.sessionId}:${identity.activityId}:presentation:v2`;
  const parents = raw.filter(c => c && typeof c === "object" && c.kind === "ask_user_questions" && c.idempotencyKey === expectedKey);
  if (parents.length !== 1) throw new Error("Question coordination has no single exact parent form");
  const parent = parents[0];
  if (parent.status === "answered") return { kind: "parent_answered", parentId: identity.parentIssueId };
  if (parent.status !== "pending") return { kind: "waiting", parentId: identity.parentIssueId };
  // Reconcile the generation's registry first: malformed legacy creation
  // receipts can leave provably unstarted identical children before an ID was checkpointed.
  const observed = await observeQuestionChild({ identity, api: input.api });
  if (observed.kind === "failed") return { kind: "wake_owner", parentId: identity.parentIssueId, ownerId: identity.bootstrapAgentId, proofId: observed.runId };
  if (observed.kind === "answered") {
    const decision = readQuestionReviewFormDecision(observed.result);
    if (!decision) throw new Error("Question reviewer result is malformed");
    if (decision.kind === "ESCALATE") return { kind: "wake_owner", parentId: identity.parentIssueId, ownerId: identity.bootstrapAgentId, proofId: observed.cardId };
    await input.api.post(`${parentRoot}/interactions/${encodeURIComponent(parent.id)}/respond`, {
      answers: [{ questionId: "reply", optionIds: ["response"], otherText: decision.answer }],
      summaryMarkdown: `Automated answer from native question card ${observed.cardId}, reviewer run ${observed.reviewerRunId}.`,
    });
    return { kind: "parent_answered", parentId: identity.parentIssueId };
  }
  return { kind: "waiting", parentId: identity.parentIssueId };
}
import { observeQuestionChild, parseQuestionBootstrap, readQuestionReviewFormDecision, type ChildReviewApi } from "@pilleo/paperclip-adapter-common";
