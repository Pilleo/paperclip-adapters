import { z } from "zod";
import { createHash } from "node:crypto";
import type { ChildReviewApi } from "./child-plan-review-bootstrap.js";

export const QUESTION_BOOTSTRAP_PREFIX = "<!-- jules-question-bootstrap:v1\n";
export const QuestionBootstrapIdentitySchema = z.object({
  version: z.literal(1), companyId: z.string().min(1), parentIssueId: z.string().min(1),
  sessionId: z.string().min(1), activityId: z.string().min(1), reviewerAgentId: z.string().min(1),
  bootstrapAgentId: z.string().min(1), question: z.string().min(1), generation: z.number().int().min(0).max(10),
  approvedPlanActivityId: z.string().optional(), approvedPlanRevisionId: z.string().optional(),
  latestPlanActivityId: z.string().optional(),
}).strict().refine(value => value.bootstrapAgentId !== value.reviewerAgentId, "Question reviewer must be independent of its bootstrap worker");
export type QuestionBootstrapIdentity = z.infer<typeof QuestionBootstrapIdentitySchema>;
const Issue = z.object({ id: z.string(), companyId: z.string(), parentId: z.string().nullish(),
  createdByAgentId: z.string().nullish(), assigneeAgentId: z.string().nullish(), status: z.string(),
  description: z.string().nullish(), projectId: z.string().nullish(), executionBlocker: z.unknown().optional() });
const Run = z.object({ id: z.string(), companyId: z.string(), agentId: z.string(), status: z.string(),
  contextSnapshot: z.object({ issueId: z.string() }) });
const Card = z.object({ id: z.string(), status: z.string(), kind: z.literal("ask_user_questions"),
  companyId: z.string(), issueId: z.string(),
  idempotencyKey: z.string(), addresseeAgentId: z.string(), sourceRunId: z.string(),
  resolvedByRunId: z.string().nullish(), resolvedByAgentId: z.string().nullish(), result: z.unknown().optional() });
const policy = { mode: "normal", stages: [], commentRequired: false } as const;
const live = (status: string) => ["queued", "running", "scheduled"].includes(status);

function key(identity: QuestionBootstrapIdentity): string {
  return `jules:question-bootstrap:${identity.parentIssueId}:${identity.sessionId}:${identity.activityId}:${identity.generation}`;
}

export function questionBootstrapDescription(identity: QuestionBootstrapIdentity): string {
  const { question, ...fields } = QuestionBootstrapIdentitySchema.parse(identity);
  // Paperclip normalizes escaped description newlines. URI encoding keeps
  // quoted provider text opaque to that formatter and to marker boundaries.
  const serialized = JSON.stringify({ ...fields, questionEncoded: encodeURIComponent(question) });
  const correlation = "<!-- jules-question-adjudication:bootstrap -->";
  return `${QUESTION_BOOTSTRAP_PREFIX}${serialized}\n-->\n${correlation}\n\nBootstrap the exact native Jules question card on this child's own run. Do not create a Jules provider session or modify a checkout.`;
}

export function parseQuestionBootstrap(description: string | null | undefined): QuestionBootstrapIdentity | null {
  if (!description?.startsWith(QUESTION_BOOTSTRAP_PREFIX)) return null;
  const end = description.indexOf("\n-->", QUESTION_BOOTSTRAP_PREFIX.length);
  if (end < 0) return null;
  try {
    const text = description.slice(QUESTION_BOOTSTRAP_PREFIX.length, end);
    let repaired = "", quoted = false, escaped = false;
    for (const char of text) {
      if (quoted && char.charCodeAt(0) < 32) { repaired += JSON.stringify(char).slice(1, -1); continue; }
      repaired += char;
      if (escaped) { escaped = false; continue; }
      if (quoted && char === "\\") { escaped = true; continue; }
      if (char === '"') quoted = !quoted;
    }
    const wire = JSON.parse(repaired);
    if (typeof wire.questionEncoded === "string") {
      if (wire.question !== undefined) return null;
      const { questionEncoded, ...fields } = wire;
      return QuestionBootstrapIdentitySchema.safeParse({ ...fields, question: decodeURIComponent(questionEncoded) }).data ?? null;
    }
    // Read only the old normalized representation; new descriptions never emit it.
    return QuestionBootstrapIdentitySchema.safeParse(wire).data ?? null;
  }
  catch { return null; }
}

function verifyParent(parent: z.infer<typeof Issue>, identity: QuestionBootstrapIdentity): void {
  if (parent.id !== identity.parentIssueId || parent.companyId !== identity.companyId ||
      parent.assigneeAgentId !== identity.bootstrapAgentId || !["in_progress", "blocked"].includes(parent.status) || parent.executionBlocker != null) {
    throw new Error("Question parent ownership or execution hold changed");
  }
}

function verifyChild(child: z.infer<typeof Issue>, identity: QuestionBootstrapIdentity): void {
  const descriptor = parseQuestionBootstrap(child.description);
  if (child.companyId !== identity.companyId || (child.parentId != null && child.parentId !== identity.parentIssueId) ||
      child.createdByAgentId !== identity.bootstrapAgentId || !descriptor || key(descriptor) !== key(identity) ||
      descriptor.question !== identity.question || descriptor.reviewerAgentId !== identity.reviewerAgentId ||
      descriptor.bootstrapAgentId !== identity.bootstrapAgentId) throw new Error("Question child identity changed");
}

/** Only a real child-scoped Jules invocation can create the reviewer's executable form. */
export async function bootstrapQuestionChild(input: {
  identity: QuestionBootstrapIdentity; childId: string; runId: string; agentId: string; api: ChildReviewApi;
}): Promise<{ childId: string; cardId: string }> {
  const { identity, api, childId } = input;
  const root = `/issues/${encodeURIComponent(childId)}`;
  const [child, parent, run] = await Promise.all([
    api.get(root).then(x => Issue.parse(x)), api.get(`/issues/${encodeURIComponent(identity.parentIssueId)}`).then(x => Issue.parse(x)),
    api.get(`/heartbeat-runs/${encodeURIComponent(input.runId)}`).then(x => Run.parse(x)),
  ]);
  verifyParent(parent, identity); verifyChild(child, identity);
  if (input.agentId !== identity.bootstrapAgentId || child.assigneeAgentId !== input.agentId ||
      run.id !== input.runId || run.companyId !== identity.companyId || run.agentId !== input.agentId ||
      run.contextSnapshot.issueId !== childId || run.status !== "running" || child.executionBlocker != null ||
      !["todo", "in_progress", "backlog"].includes(child.status)) throw new Error("Question bootstrap requires a running child-scoped run");
  const reviewer = z.object({ id: z.string(), companyId: z.string(), status: z.string() }).parse(await api.get(`/agents/${encodeURIComponent(identity.reviewerAgentId)}`));
  if (reviewer.id !== identity.reviewerAgentId || reviewer.companyId !== identity.companyId) throw new Error("Question reviewer identity changed");
  let approval = "No current native plan approval is recorded in this question context.";
  if (identity.approvedPlanActivityId) {
    approval = `Native approval is recorded for provider plan activity ${identity.approvedPlanActivityId}.`;
    if (identity.latestPlanActivityId) approval += identity.latestPlanActivityId === identity.approvedPlanActivityId
      ? " This is the provider's current plan; another human approval is not required to perform the original task."
      : ` The current provider plan is ${identity.latestPlanActivityId}, which is not covered by that approval. Do not authorize new implementation before its native plan review.`;
  }
  if (identity.approvedPlanActivityId && identity.approvedPlanRevisionId) {
    const doc = z.object({ latestRevisionId: z.string() }).parse(await api.get(`/issues/${encodeURIComponent(identity.parentIssueId)}/documents/plan`));
    if (doc.latestRevisionId !== identity.approvedPlanRevisionId) throw new Error("Question's approved plan revision changed");
    approval += ` Native document revision: ${identity.approvedPlanRevisionId}. Approval applies only to the original task scope.`;
  }
  const cards = z.array(Card).parse(await api.get(`${root}/interactions`));
  if (cards.length > 1) throw new Error("Ambiguous question bootstrap cards");
  let card = cards[0];
  if (card) {
    const source = Run.parse(await api.get(`/heartbeat-runs/${encodeURIComponent(card.sourceRunId)}`));
    if (card.companyId !== identity.companyId || card.issueId !== childId || card.idempotencyKey !== key(identity) || card.addresseeAgentId !== identity.reviewerAgentId || card.status !== "pending" ||
        source.contextSnapshot.issueId !== childId || source.agentId !== input.agentId || source.companyId !== identity.companyId) {
      throw new Error("Existing question card has invalid source provenance");
    }
  } else {
    card = Card.parse(await api.post(`${root}/interactions`, {
      kind: "ask_user_questions", idempotencyKey: key(identity), addresseeAgentId: identity.reviewerAgentId,
      title: "Adjudicate Jules question", summary: "Automated reviewer decision; human questions use a separate direct-answer form.",
      continuationPolicy: "none", resolverPolicy: "anyone",
      payload: { version: 1, title: "Adjudicate Jules question", submitLabel: "Submit reviewer decision", supersedeOnUserComment: false,
        questions: [
          { id: "resolution", prompt: "Answer the provider question or identify a concrete decision requiring human input.",
            selectionMode: "single", required: true, allowOther: false,
            options: [{ id: "answer", label: "Answer Jules" }, { id: "escalate", label: "Request a human decision" }] },
          { id: "response", prompt: identity.question, selectionMode: "single", required: true, allowOther: false,
            options: [{ id: "response", label: "Reviewer response", freeText: true }] },
        ] },
    }));
    if (card.sourceRunId !== input.runId || card.issueId !== childId || card.companyId !== identity.companyId) throw new Error("Question form was not attributed to its bootstrap run");
  }
  const description = `${questionBootstrapDescription(identity)}\n\nYou are the question adjudicator. Use only the parent task instructions, native approval facts and quoted question. Do not inspect or modify repository files. Answer operational requests already authorized by the task; request a human decision only for concrete ambiguity. Use paperclip_review.submit_jules_question_decision once, then finish this child.\n\nParent task instructions:\n${parent.description ?? ""}\n\nNative plan facts:\n${approval}\n\nProvider question:\n${identity.question}`;
  await api.patch(root, { status: "backlog", description });
  return { childId, cardId: card.id };
}

export type QuestionChildObservation =
  | { kind: "waiting"; childId: string; cardId?: string }
  | { kind: "answered"; childId: string; cardId: string; result: unknown; reviewerRunId: string }
  | { kind: "failed"; childId: string; runId: string; status: string; cardId?: string };

/** Parent polls checkpoint creation before activation, then require a settled bootstrap and exact reviewer. */
export async function observeQuestionChild(input: {
  identity: QuestionBootstrapIdentity; childId?: string; api: ChildReviewApi;
}): Promise<QuestionChildObservation> {
  const { identity, api } = input;
  const parentRoot = `/issues/${encodeURIComponent(identity.parentIssueId)}`;
  const parent = Issue.parse(await api.get(parentRoot)); verifyParent(parent, identity);
  let childId = input.childId;
  if (!childId) {
    const children = z.array(Issue).parse(await api.get(`/companies/${encodeURIComponent(identity.companyId)}/issues?limit=1000&parentId=${encodeURIComponent(identity.parentIssueId)}`));
    if (children.length >= 1000) throw new Error("Incomplete question child listing");
    const matches = children.filter(c => { const x = parseQuestionBootstrap(c.description); return c.status !== "cancelled" && x && key(x) === key(identity); });
    if (matches.length > 1) {
      // A rejected legacy multiline creation receipt could leave identical,
      // still-deferred children. Retire only provably unstarted duplicates.
      for (const duplicate of matches) {
        verifyChild(duplicate, identity);
        if (duplicate.status !== "backlog" || duplicate.assigneeAgentId !== identity.bootstrapAgentId || duplicate.executionBlocker != null) throw new Error("Ambiguous active question bootstrap children");
        const cards = await api.get(`/issues/${encodeURIComponent(duplicate.id)}/interactions`);
        const runs = await api.get(`/issues/${encodeURIComponent(duplicate.id)}/runs`);
        if (!Array.isArray(cards) || cards.length || !Array.isArray(runs) || runs.some(r => r.contextIssueId === duplicate.id)) throw new Error("Question duplicate has execution or decision history");
      }
      matches.sort((a,b)=>a.id.localeCompare(b.id));
      for (const duplicate of matches.slice(1)) await api.patch(`/issues/${encodeURIComponent(duplicate.id)}`, { status: "cancelled" });
    }
    childId = matches[0]?.id;
    if (!childId) {
      const body = { title: "Adjudicate Jules provider question", description: questionBootstrapDescription(identity),
        status: "backlog", assigneeAgentId: identity.bootstrapAgentId, blockParentUntilDone: false, executionPolicy: policy };
      try {
        const child = Issue.parse(await api.post(`${parentRoot}/children`, body));
        verifyChild(child, identity); return { kind: "waiting", childId: child.id };
      } catch (error) {
        const failure = error as { status?: unknown; message?: unknown };
        if (failure?.status !== 422 || typeof failure.message !== "string" || !/maximum\s+25\s+child\s+issues/i.test(failure.message)) throw error;
        const title = `Adjudicate Jules question [${createHash("sha256").update(key(identity)).digest("hex").slice(0,16)}]`;
        const registry = z.array(Issue).parse(await api.get(`/companies/${encodeURIComponent(identity.companyId)}/issues?limit=1000&q=${encodeURIComponent(title)}`));
        if (registry.length >= 1000) throw new Error("Standalone question registry is incomplete");
        const matches = registry.filter(c => { const d=parseQuestionBootstrap(c.description); return c.status !== "cancelled" && d && key(d)===key(identity); });
        if (matches.length>1) throw new Error("Ambiguous standalone question helpers");
        if (matches[0]) { verifyChild(matches[0],identity); childId=matches[0].id; }
        else {
          const child=Issue.parse(await api.post(`/companies/${encodeURIComponent(identity.companyId)}/issues`, {
            ...body,title,...(parent.projectId?{projectId:parent.projectId}:{}),allowDuplicate:true,
          }));
          verifyChild(child,identity); return {kind:"waiting",childId:child.id};
        }
      }
    }
  }
  const root = `/issues/${encodeURIComponent(childId)}`;
  const child = Issue.parse(await api.get(root)); verifyChild(child, identity);
  if (child.status === "cancelled") throw new Error("Question bootstrap child was cancelled; explicit cancellation is not activation authority");
  const cards = z.array(Card).parse(await api.get(`${root}/interactions`));
  if (cards.length > 1) throw new Error("Duplicate question review cards");
  const card = cards[0];
  if (card && (card.companyId !== identity.companyId || card.issueId !== childId || card.idempotencyKey !== key(identity) || card.addresseeAgentId !== identity.reviewerAgentId)) throw new Error("Question review target changed");
  const rows = z.array(z.object({ runId: z.string(), agentId: z.string(), status: z.string(), contextIssueId: z.string().nullish() }))
    .parse(await api.get(`${root}/runs`));
  const ownRuns = rows.filter(r => r.contextIssueId === childId);
  if (ownRuns.some(r => live(r.status))) return { kind: "waiting", childId, ...(card ? { cardId: card.id } : {}) };
  if (card?.status === "answered") {
    if (!card.resolvedByRunId) throw new Error("Question decision lacks reviewer run attribution");
    const [source, reviewerRun] = await Promise.all([
      api.get(`/heartbeat-runs/${encodeURIComponent(card.sourceRunId)}`).then(x => Run.parse(x)),
      api.get(`/heartbeat-runs/${encodeURIComponent(card.resolvedByRunId)}`).then(x => Run.parse(x)),
    ]);
    if (source.companyId !== identity.companyId || source.agentId !== identity.bootstrapAgentId || source.contextSnapshot.issueId !== childId ||
        reviewerRun.companyId !== identity.companyId || reviewerRun.agentId !== identity.reviewerAgentId || reviewerRun.contextSnapshot.issueId !== childId ||
        source.status !== "succeeded" || reviewerRun.status !== "succeeded" || (card.resolvedByAgentId != null && card.resolvedByAgentId !== identity.reviewerAgentId)) {
      throw new Error("Question decision provenance failed");
    }
    return { kind: "answered", childId, cardId: card.id, result: card.result, reviewerRunId: reviewerRun.id };
  }
  const latestAttempt = ownRuns.find(r => r.agentId === (child.assigneeAgentId === identity.bootstrapAgentId ? identity.bootstrapAgentId : identity.reviewerAgentId));
  const failed = latestAttempt && ["failed", "timed_out", "cancelled"].includes(latestAttempt.status) ? latestAttempt : undefined;
  if (failed) return { kind: "failed", childId, runId: failed.runId, status: failed.status, ...(card ? { cardId: card.id } : {}) };
  if (card?.status === "pending" && latestAttempt?.agentId === identity.reviewerAgentId && latestAttempt.status === "succeeded") {
    return { kind: "failed", childId, runId: latestAttempt.runId, status: "missing_typed_decision", cardId: card.id };
  }
  if (child.executionBlocker != null) throw new Error("Question child execution is held");
  if (child.assigneeAgentId === identity.bootstrapAgentId) {
    if (card) {
      const source = Run.parse(await api.get(`/heartbeat-runs/${encodeURIComponent(card.sourceRunId)}`));
      if (source.companyId !== identity.companyId || source.agentId !== identity.bootstrapAgentId || source.contextSnapshot.issueId !== childId || source.status !== "succeeded") throw new Error("Question bootstrap is not successfully settled");
    }
    const reviewer = z.object({ status: z.string() }).parse(await api.get(`/agents/${encodeURIComponent(identity.reviewerAgentId)}`));
    // Error is a last-run outcome, not an administrative pause. The host admits
    // fresh scoped runs for errored agents; never change its pause/approval state.
    if (["paused", "terminated", "pending_approval"].includes(reviewer.status)) return { kind: "waiting", childId, ...(card ? { cardId: card.id } : {}) };
    await api.patch(root, { status: "todo", assigneeAgentId: card ? identity.reviewerAgentId : identity.bootstrapAgentId, executionPolicy: policy, blockParentUntilDone: false });
  } else if (child.assigneeAgentId !== identity.reviewerAgentId || !card) throw new Error("Question reviewer ownership changed");
  return { kind: "waiting", childId, ...(card ? { cardId: card.id } : {}) };
}

/** A terminal legacy reviewer is evidence for a fresh scoped generation, never a run to replay. */
export async function failedLegacyQuestionRun(input: {
  identity: QuestionBootstrapIdentity; childId: string; cardId: string; api: ChildReviewApi;
}): Promise<string | null> {
  const { identity, childId, api } = input;
  const child = Issue.parse(await api.get(`/issues/${encodeURIComponent(childId)}`));
  if (child.companyId !== identity.companyId || child.parentId !== identity.parentIssueId || child.createdByAgentId !== identity.bootstrapAgentId ||
      child.assigneeAgentId !== identity.reviewerAgentId || child.status === "cancelled") throw new Error("Legacy question child identity changed or was cancelled");
  const cards = z.array(Card).parse(await api.get(`/issues/${encodeURIComponent(childId)}/interactions`));
  const card = cards.find(c => c.id === input.cardId);
  if (!card) throw new Error("Legacy question card is missing");
  const expiredByHost = card.status === "expired" && card.result && typeof card.result === "object" &&
    (card.result as { outcome?: unknown }).outcome === "issue_closed";
  if (card.status !== "pending" && !expiredByHost) return null;
  const expected = `jules:question-review:${childId}:${identity.parentIssueId}:${identity.sessionId}:${identity.activityId}`;
  if (card.id !== input.cardId || card.companyId !== identity.companyId || card.issueId !== childId ||
      card.idempotencyKey !== expected || card.addresseeAgentId !== identity.reviewerAgentId) throw new Error("Legacy question card target changed");
  const rows = z.array(z.object({ runId: z.string(), agentId: z.string(), status: z.string(), contextIssueId: z.string().nullish() }))
    .parse(await api.get(`/issues/${encodeURIComponent(childId)}/runs`));
  const actual = rows.filter(r => r.contextIssueId === childId && r.agentId === identity.reviewerAgentId);
  if (actual.some(r => live(r.status))) return null;
  const terminal = actual[0];
  if (!terminal || !["failed", "timed_out"].includes(terminal.status)) return null;
  const run = Run.parse(await api.get(`/heartbeat-runs/${encodeURIComponent(terminal.runId)}`));
  if (run.companyId !== identity.companyId || run.agentId !== identity.reviewerAgentId || run.contextSnapshot.issueId !== childId || run.status !== terminal.status) {
    throw new Error("Legacy question failure provenance failed");
  }
  return run.id;
}
