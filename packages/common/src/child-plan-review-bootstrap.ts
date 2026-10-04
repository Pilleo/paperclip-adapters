import { z } from "zod";
import { childPlanReviewKey, parseChildPlanReviewDescription, type ChildPlanReviewIdentity } from "./child-plan-review.js";

export interface ChildReviewApi {
  readonly get: (path: string) => Promise<unknown>;
  readonly post: (path: string, body: unknown) => Promise<unknown>;
  readonly patch: (path: string, body: unknown) => Promise<unknown>;
}

const Child = z.object({ id: z.string(), companyId: z.string(), parentId: z.string(), createdByAgentId: z.string(),
  assigneeAgentId: z.string(), status: z.string(), description: z.string(),
  executionPolicy: z.object({ stages: z.array(z.unknown()).length(0), monitor: z.null().optional() }).nullable(),
  executionBlocker: z.null().optional(),
});
const Parent = z.object({ id: z.string(), companyId: z.string(), assigneeAgentId: z.string(), status: z.string(), executionBlocker: z.unknown().optional() });
const Document = z.object({ id: z.string(), latestRevisionId: z.string(), latestRevisionNumber: z.number(), latestBody: z.string().optional(), body: z.string().optional() });
const Run = z.object({ id: z.string(), companyId: z.string(), agentId: z.string(), status: z.string(), contextSnapshot: z.object({ issueId: z.string() }) });
const Reviewer = z.object({ id: z.string(), companyId: z.string(), status: z.string() });

export class ReviewerUnavailableError extends Error {
  constructor(readonly reviewerId: string) { super("Addressed reviewer is unavailable"); }
}

/** All writes are child-scoped and attributed to the bootstrap agent's actual run. */
export async function bootstrapChildPlanReview(input: {
  readonly identity: ChildPlanReviewIdentity; readonly childId: string;
  readonly agentId: string; readonly runId: string; readonly api: ChildReviewApi;
}): Promise<{ readonly childId: string; readonly cardId: string } |
  { readonly kind: "reviewer_unavailable"; readonly childId: string; readonly reviewerId: string }> {
  const { identity, childId, api } = input;
  if (input.agentId !== identity.bootstrapAgentId || !input.runId) throw new Error("Invalid bootstrap run identity");
  const root = `/issues/${encodeURIComponent(childId)}`;
  const [rawChild, rawParent, rawDocument, rawRun] = await Promise.all([
    api.get(root), api.get(`/issues/${encodeURIComponent(identity.parentIssueId)}`),
    api.get(`/issues/${encodeURIComponent(identity.parentIssueId)}/documents/plan`),
    api.get(`/heartbeat-runs/${encodeURIComponent(input.runId)}`),
  ]);
  const child = Child.parse(rawChild);
  const parent = Parent.parse(rawParent);
  const document = Document.parse(rawDocument);
  const run = Run.parse(rawRun);
  const descriptor = parseChildPlanReviewDescription(child.description);
  const key = childPlanReviewKey(identity);
  if (child.id !== childId || child.companyId !== identity.companyId || child.parentId !== identity.parentIssueId ||
      child.createdByAgentId !== identity.julesAgentId || child.assigneeAgentId !== input.agentId ||
      !["todo", "in_progress", "backlog"].includes(child.status) || !descriptor || childPlanReviewKey(descriptor) !== key) {
    throw new Error("Child bootstrap issue identity mismatch");
  }
  if (parent.id !== identity.parentIssueId || parent.companyId !== identity.companyId ||
      parent.assigneeAgentId !== identity.julesAgentId || parent.executionBlocker != null) throw new Error("Parent ownership or execution hold changed during child bootstrap");
  if (parent.status !== "in_progress") {
    if (parent.status !== "blocked") throw new Error("Parent ownership changed during child bootstrap");
    const questions = z.array(z.object({ kind: z.string(), status: z.string(), idempotencyKey: z.string().nullish(), sourceRunId: z.string().nullish() }))
      .parse(await api.get(`/issues/${encodeURIComponent(identity.parentIssueId)}/interactions`));
    const question = questions.find(q => q.kind === "ask_user_questions" && q.status === "pending" &&
      q.idempotencyKey?.startsWith(`jules:agent-adjudication:${identity.parentIssueId}:${identity.sessionId}:`));
    if (!question?.sourceRunId) throw new Error("Blocked parent has no verified native question wait");
    const source = Run.parse(await api.get(`/heartbeat-runs/${encodeURIComponent(question.sourceRunId)}`));
    if (source.companyId !== identity.companyId || source.agentId !== identity.julesAgentId || source.contextSnapshot.issueId !== identity.parentIssueId) {
      throw new Error("Blocked parent question provenance changed");
    }
  }
  if (document.id !== identity.documentId || document.latestRevisionId !== identity.revisionId ||
      document.latestRevisionNumber !== identity.revisionNumber) throw new Error("Parent plan revision changed during child bootstrap");
  if (run.id !== input.runId || run.agentId !== input.agentId || run.companyId !== identity.companyId ||
      run.status !== "running" || run.contextSnapshot.issueId !== childId) throw new Error("Bootstrap must use a running child-scoped run");
  const cards = z.array(z.object({ id: z.string(), idempotencyKey: z.string().nullish(), status: z.string(),
    kind: z.string(), addresseeAgentId: z.string().nullish(), sourceRunId: z.string().nullish() })).parse(await api.get(`${root}/interactions`));
  if (cards.length > 1) throw new Error("Ambiguous child review cards");
  const card = cards[0];
  let cardId: string;
  if (card && (card.idempotencyKey !== key || card.kind !== "request_item_verdicts" || card.addresseeAgentId !== identity.reviewerAgentId ||
      card.status !== "pending")) throw new Error("Existing child review card conflicts with bootstrap");
  if (card) {
    if (!card.sourceRunId) throw new Error("Existing child card has no source run");
    const source = Run.parse(await api.get(`/heartbeat-runs/${encodeURIComponent(card.sourceRunId)}`));
    if (source.companyId !== identity.companyId || source.agentId !== input.agentId || source.contextSnapshot.issueId !== childId) {
      throw new Error("Existing child card has invalid source run provenance");
    }
    cardId = card.id;
  } else {
    const reviewer = Reviewer.parse(await api.get(`/agents/${encodeURIComponent(identity.reviewerAgentId)}`));
    if (reviewer.id !== identity.reviewerAgentId || reviewer.companyId !== identity.companyId) throw new Error("Child reviewer identity changed");
    if (["paused", "terminated", "pending_approval"].includes(reviewer.status)) {
      const parked = Child.parse(await api.patch(root, { status: "backlog" }));
      if (parked.id !== childId || parked.status !== "backlog") throw new Error("Unable to park unavailable reviewer child");
      return { kind: "reviewer_unavailable", childId, reviewerId: reviewer.id };
    }
    let created: unknown;
    try { created = await api.post(`${root}/interactions`, {
      kind: "request_item_verdicts", idempotencyKey: key, addresseeAgentId: identity.reviewerAgentId,
      continuationPolicy: "none", resolverPolicy: "anyone", title: `Review Jules plan (${identity.stage})`,
      payload: { version: 1, prompt: `Review the parent plan revision ${identity.revisionNumber}. Reject with a concrete reason if changes are required.`,
        detailsMarkdown: (document.latestBody ?? document.body ?? "").slice(0, 20_000),
        items: [{ id: "plan", label: "Plan" }], verdicts: ["approve", "reject"], requireReasonOn: ["reject"],
        providerActivityId: identity.activityId, supersedeOnUserComment: false,
        target: { type: "issue_document", issueId: identity.parentIssueId, key: "plan", documentId: identity.documentId,
          revisionId: identity.revisionId, revisionNumber: identity.revisionNumber } },
    }); } catch (error) {
      if (!(error instanceof ReviewerUnavailableError) || error.reviewerId !== identity.reviewerAgentId) throw error;
      const parked = Child.parse(await api.patch(root, { status: "backlog" }));
      if (parked.id !== childId || parked.status !== "backlog") throw new Error("Unable to park unavailable reviewer child");
      return { kind: "reviewer_unavailable", childId, reviewerId: error.reviewerId };
    }
    const receipt = z.object({ id: z.string().min(1), status: z.literal("pending"), sourceRunId: z.string() }).parse(created);
    if (receipt.sourceRunId !== input.runId) throw new Error("Created child card was not attributed to the bootstrap run");
    cardId = receipt.id;
  }
  // Parking the bootstrap task prevents ordinary scheduling before the parent
  // observes the receipt and the settled bootstrap run. It never alters the parent.
  const parked = Child.parse(await api.patch(root, { status: "backlog" }));
  if (parked.id !== childId || parked.status !== "backlog" || parked.assigneeAgentId !== identity.bootstrapAgentId) {
    throw new Error("Host did not park the bootstrapped child");
  }
  return { childId, cardId };
}
