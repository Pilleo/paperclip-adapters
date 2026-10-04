import { z } from "zod";
import { childPlanReviewDescription, childPlanReviewKey, parseChildPlanReviewDescription, type ChildPlanReviewIdentity } from "./child-plan-review.js";
import type { ChildReviewApi } from "./child-plan-review-bootstrap.js";

const Issue = z.object({ id: z.string(), companyId: z.string(), parentId: z.string().nullable().optional(),
  createdByAgentId: z.string().nullable().optional(), status: z.string(), assigneeAgentId: z.string().nullable(),
  description: z.string().nullable().optional(), executionBlocker: z.unknown().optional() });
const Run = z.object({ id: z.string(), companyId: z.string(), agentId: z.string(), status: z.string(),
  contextSnapshot: z.object({ issueId: z.string().optional() }), startedAt: z.string().nullish(), resultJson: z.unknown().optional() });
const IssueRun = z.object({ runId: z.string(), status: z.string(), agentId: z.string(), contextIssueId: z.string().nullable() });
const activeRun = (status: string): boolean => ["queued", "running", "scheduled", "scheduled_retry"].includes(status);
const Document = z.object({ id: z.string(), latestRevisionId: z.string(), latestRevisionNumber: z.number() });
const Card = z.object({ id: z.string(), kind: z.literal("request_item_verdicts"), status: z.string(), idempotencyKey: z.string(),
  companyId: z.string(), issueId: z.string(), addresseeAgentId: z.string(), sourceRunId: z.string(),
  resolvedByAgentId: z.string().nullish(), resolvedByRunId: z.string().nullish(),
  payload: z.object({ target: z.object({ type: z.literal("issue_document"), issueId: z.string(), key: z.literal("plan"), documentId: z.string(), revisionId: z.string(), revisionNumber: z.number() }) }),
  result: z.unknown().optional() });
const Verdict = z.object({ outcome: z.literal("resolved"), complete: z.literal(true),
  items: z.array(z.object({ id: z.literal("plan"), verdict: z.enum(["approve", "reject"]), reason: z.string().optional() })).length(1) });
const policy = { mode: "normal", stages: [], commentRequired: false } as const;
export type ChildPlanReviewObservation =
  | { readonly kind: "waiting"; readonly childId: string }
  | { readonly kind: "answered"; readonly childId: string; readonly cardId: string; readonly reviewerRunId: string;
      readonly verdict: "approve" | "reject"; readonly reason?: string };

/** Parent polling owns activation and verdict consumption; it never changes parent ownership. */
export async function reconcileChildPlanReview(input: {
  readonly identity: ChildPlanReviewIdentity; readonly childId?: string; readonly api: ChildReviewApi;
}): Promise<ChildPlanReviewObservation> {
  const { identity, api } = input;
  const key = childPlanReviewKey(identity);
  const parentRoot = `/issues/${encodeURIComponent(identity.parentIssueId)}`;
  const [rawParent, rawDocument] = await Promise.all([api.get(parentRoot), api.get(`${parentRoot}/documents/plan`)]);
  const parent = Issue.parse(rawParent);
  const document = Document.parse(rawDocument);
  if (parent.id !== identity.parentIssueId || parent.companyId !== identity.companyId || parent.assigneeAgentId !== identity.julesAgentId ||
      parent.status !== "in_progress" || parent.executionBlocker != null) throw new Error("Child review parent ownership or execution hold changed");
  if (document.id !== identity.documentId || document.latestRevisionId !== identity.revisionId || document.latestRevisionNumber !== identity.revisionNumber) {
    throw new Error("Child review parent plan revision changed");
  }
  let childId = input.childId;
  if (!childId) {
    const issues = z.array(Issue).parse(await api.get(`/companies/${encodeURIComponent(identity.companyId)}/issues?limit=1000&parentId=${encodeURIComponent(identity.parentIssueId)}`));
    if (issues.length >= 1000) throw new Error("Incomplete child review issue index");
    const matches = issues.filter((issue) => {
      const descriptor = parseChildPlanReviewDescription(issue.description);
      return issue.parentId === identity.parentIssueId && descriptor && childPlanReviewKey(descriptor) === key;
    });
    if (matches.length > 1) throw new Error("Duplicate child review issues");
    childId = matches[0]?.id;
    if (!childId) {
      const created = Issue.parse(await api.post(`${parentRoot}/children`, {
        title: `Review Jules plan (${identity.stage}, revision ${identity.revisionNumber})`,
        description: childPlanReviewDescription(identity), status: "backlog", assigneeAgentId: identity.bootstrapAgentId,
        blockParentUntilDone: false, executionPolicy: policy,
      }));
      if (created.companyId !== identity.companyId || created.parentId !== identity.parentIssueId ||
          created.assigneeAgentId !== identity.bootstrapAgentId || created.createdByAgentId !== identity.julesAgentId) throw new Error("Child review create receipt mismatch");
      // The caller checkpoints this ID before a later poll activates the child.
      return { kind: "waiting", childId: created.id };
    }
  }
  const childRoot = `/issues/${encodeURIComponent(childId)}`;
  const child = Issue.parse(await api.get(childRoot));
  const descriptor = parseChildPlanReviewDescription(child.description);
  if (child.id !== childId || child.companyId !== identity.companyId || child.parentId !== identity.parentIssueId ||
      child.createdByAgentId !== identity.julesAgentId || !descriptor || childPlanReviewKey(descriptor) !== key) {
    throw new Error("Child review identity or execution hold mismatch");
  }
  const cards = z.array(Card).parse(await api.get(`${childRoot}/interactions`));
  if (cards.length > 1) throw new Error("Duplicate child review cards");
  const card = cards[0];
  if (child.executionBlocker != null && card?.status !== "answered") throw new Error("Child review execution is held before a typed verdict");
  if (card) {
    const target = card.payload.target;
    if (card.companyId !== identity.companyId || card.issueId !== childId || card.idempotencyKey !== key || card.addresseeAgentId !== identity.reviewerAgentId ||
        target.issueId !== identity.parentIssueId || target.documentId !== identity.documentId || target.revisionId !== identity.revisionId || target.revisionNumber !== identity.revisionNumber) {
      throw new Error("Child review card target mismatch");
    }
  }
  if (child.assigneeAgentId === identity.bootstrapAgentId) {
    const reviewer = z.object({ id: z.string(), companyId: z.string(), status: z.string() })
      .parse(await api.get(`/agents/${encodeURIComponent(identity.reviewerAgentId)}`));
    if (reviewer.id !== identity.reviewerAgentId || reviewer.companyId !== identity.companyId) throw new Error("Child reviewer identity changed");
    if (["paused", "terminated", "pending_approval"].includes(reviewer.status)) return { kind: "waiting", childId };
    const runs = z.array(IssueRun).parse(await api.get(`${childRoot}/runs`));
    if (runs.some((run) => run.contextIssueId === childId && activeRun(run.status))) return { kind: "waiting", childId };
    if (child.status !== "backlog") throw new Error("Settled child bootstrap did not park itself");
    if (card) {
      const source = Run.parse(await api.get(`/heartbeat-runs/${encodeURIComponent(card.sourceRunId)}`));
      if (source.companyId !== identity.companyId || source.agentId !== identity.bootstrapAgentId || source.contextSnapshot.issueId !== childId || source.status !== "succeeded") {
        throw new Error("Child bootstrap source run is not successfully settled");
      }
    }
    const updated = Issue.parse(await api.patch(childRoot, { status: "todo", assigneeAgentId: card ? identity.reviewerAgentId : identity.bootstrapAgentId,
      blockParentUntilDone: false, executionPolicy: policy }));
    if (updated.id !== childId || updated.assigneeAgentId !== (card ? identity.reviewerAgentId : identity.bootstrapAgentId)) throw new Error("Child activation receipt mismatch");
    return { kind: "waiting", childId };
  }
  if (child.assigneeAgentId !== identity.reviewerAgentId || !card) throw new Error("Child reviewer ownership or card missing");
  if (card.status === "pending") {
    if (!["blocked", "backlog"].includes(child.status)) return { kind: "waiting", childId };
    const runs = z.array(IssueRun).parse(await api.get(`${childRoot}/runs`));
    const ownRuns = runs.filter(run => run.contextIssueId === childId);
    if (ownRuns.some(run => activeRun(run.status))) return { kind: "waiting", childId };
    const source = Run.parse(await api.get(`/heartbeat-runs/${encodeURIComponent(card.sourceRunId)}`));
    if (source.id !== card.sourceRunId || source.companyId !== identity.companyId ||
        source.agentId !== identity.bootstrapAgentId || source.contextSnapshot.issueId !== childId || source.status !== "succeeded") {
      throw new Error("Idle child review bootstrap source is not successfully settled");
    }
    for (const row of ownRuns.filter(run => run.agentId === identity.reviewerAgentId)) {
      const run = Run.parse(await api.get(`/heartbeat-runs/${encodeURIComponent(row.runId)}`));
      if (run.id !== row.runId || run.companyId !== identity.companyId || run.agentId !== identity.reviewerAgentId ||
          run.contextSnapshot.issueId !== childId || run.status !== "cancelled" || run.startedAt !== null) {
        throw new Error("Pending child review has terminal execution evidence; only verified unstarted cancellations may resume");
      }
    }
    const reviewer = z.object({ id: z.string(), companyId: z.string(), status: z.string() })
      .parse(await api.get(`/agents/${encodeURIComponent(identity.reviewerAgentId)}`));
    if (reviewer.id !== identity.reviewerAgentId || reviewer.companyId !== identity.companyId) throw new Error("Idle child reviewer identity changed");
    if (["paused", "terminated", "pending_approval", "running"].includes(reviewer.status)) return { kind: "waiting", childId };
    const updated = Issue.parse(await api.patch(childRoot, { status: "todo", assigneeAgentId: identity.reviewerAgentId,
      blockParentUntilDone: false, executionPolicy: policy }));
    if (updated.id !== childId || updated.status !== "todo" || updated.assigneeAgentId !== identity.reviewerAgentId) {
      throw new Error("Idle child reviewer activation receipt mismatch");
    }
    return { kind: "waiting", childId };
  }
  const verdict = Verdict.parse(card.result).items[0];
  const boardStamped = card.resolvedByAgentId == null;
  if (card.status !== "answered" || !verdict || !card.resolvedByRunId ||
      (!boardStamped && card.resolvedByAgentId !== identity.reviewerAgentId) ||
      (verdict.verdict === "reject" && !verdict.reason?.trim())) throw new Error("Child verdict is not attributable to its reviewer");
  const [source, reviewer] = await Promise.all([api.get(`/heartbeat-runs/${encodeURIComponent(card.sourceRunId)}`).then((raw) => Run.parse(raw)),
    api.get(`/heartbeat-runs/${encodeURIComponent(card.resolvedByRunId)}`).then((raw) => Run.parse(raw))]);
  if (source.companyId !== identity.companyId || source.agentId !== identity.bootstrapAgentId || source.contextSnapshot.issueId !== childId ||
      reviewer.companyId !== identity.companyId || reviewer.agentId !== identity.reviewerAgentId || reviewer.contextSnapshot.issueId !== childId) throw new Error("Child verdict run provenance mismatch");
  return { kind: "answered", childId, cardId: card.id, reviewerRunId: reviewer.id, verdict: verdict.verdict,
    ...(verdict.verdict === "reject" ? { reason: verdict.reason?.trim() ?? "" } : {}) };
}
