import { createHash } from "node:crypto";
import { z } from "zod";
import type { ChildReviewApi } from "@pilleo/paperclip-adapter-common";
import type { PaperclipHttp } from "./paperclip-http.js";
import { buildReviewInteractionRequest, reviewInteractionIdempotencyKey } from "./review-interaction-state.js";
import type { NativeReviewInteraction } from "./review-interaction-state.js";

export const PR_REVIEW_CHILD_PREFIX = "<!-- paperclip-pr-review-child:v1\n";
export const PrReviewChildIdentitySchema = z.object({
  version: z.literal(1), companyId: z.string().min(1), parentIssueId: z.string().min(1),
  prUrl: z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*$/),
  headSha: z.string().regex(/^[0-9a-f]{40}$/i), stage: z.enum(["luna", "terra", "strong"]),
  reviewerAgentId: z.string().min(1), bootstrapAgentId: z.string().min(1),
}).strict().refine((identity) => identity.reviewerAgentId !== identity.bootstrapAgentId,
  "Native PR review must be performed by a distinct reviewer");
export type PrReviewChildIdentity = z.infer<typeof PrReviewChildIdentitySchema>;

export function prReviewChildDescription(identity: PrReviewChildIdentity): string {
  return `${PR_REVIEW_CHILD_PREFIX}${JSON.stringify(PrReviewChildIdentitySchema.parse(identity))}\n-->\n\n` +
    "Review only the referenced PR commit through the addressed native Paperclip verdict card. " +
    "Do not submit a GitHub-thread review or infer a decision from a comment.";
}

export function parsePrReviewChildDescription(description: unknown): PrReviewChildIdentity | null {
  if (typeof description !== "string" || !description.startsWith(PR_REVIEW_CHILD_PREFIX)) return null;
  const end = description.indexOf("\n-->", PR_REVIEW_CHILD_PREFIX.length);
  if (end < 0) return null;
  let raw: unknown;
  try { raw = JSON.parse(description.slice(PR_REVIEW_CHILD_PREFIX.length, end)); }
  catch { return null; }
  const parsed = PrReviewChildIdentitySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function isPrReviewChild(value: unknown): boolean {
  const issue = z.object({ companyId: z.string(), parentId: z.string(), createdByAgentId: z.string(),
    description: z.string() }).safeParse(value);
  if (!issue.success) return false;
  const identity = parsePrReviewChildDescription(issue.data.description);
  return !!identity && identity.companyId === issue.data.companyId &&
    identity.parentIssueId === issue.data.parentId && identity.bootstrapAgentId === issue.data.createdByAgentId;
}

/** A board-created historical parent card is an authority lock, not a reviewer-wake hint. */
export function shouldHoldLegacyParentPrCard(input: {
  readonly issueId: string; readonly status: string; readonly assigneeAgentId: string | null;
  readonly prUrl: string; readonly headSha: string; readonly workProductSource: string | null;
  readonly cards: readonly { readonly kind?: string; readonly status?: string;
    readonly idempotencyKey?: string; readonly createdByAgentId?: string | null }[];
}): boolean {
  if (!['todo', 'in_review'].includes(input.status) || input.assigneeAgentId !== null ||
      input.workProductSource !== 'jules') return false;
  const immutablePrefix = `:${input.issueId}:${input.prUrl}:${input.headSha}:`;
  return input.cards.some((card) => card.kind === "request_item_verdicts" && card.status === "pending" &&
    card.createdByAgentId === null && card.idempotencyKey?.startsWith("pr-review:v") &&
    card.idempotencyKey.includes(immutablePrefix));
}

export function prReviewChildKey(identity: PrReviewChildIdentity): string {
  return `pr-review:child:v1:${createHash("sha256").update(JSON.stringify(PrReviewChildIdentitySchema.parse(identity))).digest("hex")}`;
}

const Issue = z.object({ id: z.string(), companyId: z.string(), parentId: z.string().nullish(),
  status: z.string(), assigneeAgentId: z.string().nullish(), createdByAgentId: z.string().nullish(),
  description: z.string().nullish() });
const WorkProduct = z.object({ url: z.string(), type: z.string(), isPrimary: z.boolean(), status: z.string(),
  metadata: z.object({ headSha: z.string().optional() }).nullish() });
const ParentCard = z.object({ kind: z.string(), status: z.string(), idempotencyKey: z.string().nullish() });

/** Authoritatively locate or create one PR/head-bound reviewer child from a scoped orchestrator run. */
export async function ensurePrReviewChild(input: {
  readonly identity: PrReviewChildIdentity; readonly api: ChildReviewApi;
}): Promise<string> {
  const identity = PrReviewChildIdentitySchema.parse(input.identity);
  const root = `/issues/${encodeURIComponent(identity.parentIssueId)}`;
  const [parent, rawProducts, rawChildren, parentCards] = await Promise.all([
    input.api.get(root).then((item) => Issue.parse(item)),
    input.api.get(`${root}/work-products`).then((items) => z.array(WorkProduct).parse(items)),
    input.api.get(`/companies/${encodeURIComponent(identity.companyId)}/issues?limit=1000&parentId=${encodeURIComponent(identity.parentIssueId)}`)
      .then((items) => z.array(Issue).parse(items)),
    input.api.get(`${root}/interactions`).then((items) => z.array(ParentCard).parse(items)),
  ]);
  if (parent.id !== identity.parentIssueId || parent.companyId !== identity.companyId ||
      parent.status !== "in_review" || parent.assigneeAgentId != null) {
    throw new Error("PR review parent is not unassigned in_review under the expected company");
  }
  if (rawProducts.filter((product) => product.type === "pull_request" && product.url === identity.prUrl &&
      product.metadata?.headSha === identity.headSha && product.isPrimary && product.status === "ready_for_review").length !== 1) {
    throw new Error("PR review parent has no unique primary work product at the expected immutable head");
  }
  if (parentCards.some((card) => card.kind === "request_item_verdicts" &&
      ["pending", "answered"].includes(card.status) && card.idempotencyKey?.startsWith("pr-review:v") &&
      card.idempotencyKey.includes(`:${identity.parentIssueId}:${identity.prUrl}:${identity.headSha}:`))) {
    throw new Error("An authoritative native parent PR card is pending or already answered for this head");
  }
  if (rawChildren.length >= 1000) throw new Error("PR review child listing is incomplete");
  const key = prReviewChildKey(identity);
  const matches = rawChildren.filter((child) => {
    const descriptor = parsePrReviewChildDescription(child.description);
    return child.companyId === identity.companyId && child.parentId === identity.parentIssueId &&
      descriptor && prReviewChildKey(descriptor) === key;
  });
  if (matches.length > 1) throw new Error("Duplicate PR review children for one immutable review stage");
  const prior = matches[0];
  if (prior) {
    if (prior.createdByAgentId !== identity.bootstrapAgentId) throw new Error("PR review child provenance changed");
    return prior.id;
  }
  const created = Issue.parse(await input.api.post(`${root}/children`, {
    title: `Review pull request (${identity.stage})`, description: prReviewChildDescription(identity),
    status: "backlog", assigneeAgentId: identity.bootstrapAgentId, blockParentUntilDone: false,
    executionPolicy: { mode: "normal", stages: [], commentRequired: false },
  }));
  const createdIdentity = parsePrReviewChildDescription(created.description);
  if (created.companyId !== identity.companyId || created.parentId !== identity.parentIssueId ||
      created.assigneeAgentId !== identity.bootstrapAgentId || created.createdByAgentId !== identity.bootstrapAgentId ||
      !createdIdentity || prReviewChildKey(createdIdentity) !== key) {
    throw new Error("PR review child creation receipt does not match its immutable parent, stage or author");
  }
  return created.id;
}

const Card = z.object({ id: z.string(), kind: z.literal("request_item_verdicts"), status: z.string(),
  idempotencyKey: z.string(), addresseeAgentId: z.string(), sourceRunId: z.string(),
  resolvedByAgentId: z.string().nullish(), resolvedByRunId: z.string().nullish(), result: z.unknown().optional() });
const Run = z.object({ id: z.string(), companyId: z.string(), agentId: z.string(), status: z.string(),
  contextSnapshot: z.object({ issueId: z.string() }) });

function assertChildIdentity(identity: PrReviewChildIdentity, child: z.infer<typeof Issue>, childId: string): void {
  const descriptor = parsePrReviewChildDescription(child.description);
  if (!descriptor || prReviewChildKey(descriptor) !== prReviewChildKey(identity) ||
      child.id !== childId || child.companyId !== identity.companyId || child.parentId !== identity.parentIssueId ||
      child.createdByAgentId !== identity.bootstrapAgentId) throw new Error("PR review child identity or author changed");
}

async function assertRegisteredParent(identity: PrReviewChildIdentity, api: ChildReviewApi): Promise<void> {
  const root = `/issues/${encodeURIComponent(identity.parentIssueId)}`;
  const [parent, products] = await Promise.all([
    api.get(root).then((item) => Issue.parse(item)),
    api.get(`${root}/work-products`).then((items) => z.array(WorkProduct).parse(items)),
  ]);
  if (parent.id !== identity.parentIssueId || parent.companyId !== identity.companyId ||
      parent.status !== "in_review" || parent.assigneeAgentId != null ||
      products.filter((product) => product.type === "pull_request" && product.isPrimary &&
        product.url === identity.prUrl && product.metadata?.headSha === identity.headSha &&
        product.status === "ready_for_review").length !== 1) {
    throw new Error("PR review parent or immutable primary work product changed");
  }
}

/** The reviewer card must be born on the child bootstrap run, never a maintenance or parent run. */
export async function bootstrapPrReviewChild(input: {
  readonly identity: PrReviewChildIdentity; readonly childId: string; readonly agentId: string;
  readonly runId: string; readonly api: ChildReviewApi;
}): Promise<{ readonly kind: "card"; readonly cardId: string } |
  { readonly kind: "reviewer_unavailable"; readonly childId: string; readonly reviewerId: string }> {
  const identity = PrReviewChildIdentitySchema.parse(input.identity);
  if (input.agentId !== identity.bootstrapAgentId) throw new Error("PR child bootstrap principal changed");
  const root = `/issues/${encodeURIComponent(input.childId)}`;
  const [child, run, rawCards] = await Promise.all([
    input.api.get(root).then((item) => Issue.parse(item)),
    input.api.get(`/heartbeat-runs/${encodeURIComponent(input.runId)}`).then((item) => Run.parse(item)),
    input.api.get(`${root}/interactions`).then((items) => z.array(Card).parse(items)),
    assertRegisteredParent(identity, input.api),
  ]);
  assertChildIdentity(identity, child, input.childId);
  if (child.assigneeAgentId !== identity.bootstrapAgentId || !["backlog", "todo", "in_progress"].includes(child.status) ||
      run.id !== input.runId || run.agentId !== input.agentId || run.companyId !== identity.companyId ||
      run.status !== "running" || run.contextSnapshot.issueId !== input.childId || rawCards.length > 1) {
    throw new Error("PR child bootstrap requires one own active child-scoped run and an unambiguous card");
  }
  const request = buildReviewInteractionRequest({ issueId: input.childId, prUrl: identity.prUrl,
    headSha: identity.headSha, stage: identity.stage, reviewerAgentId: identity.reviewerAgentId });
  const previous = rawCards[0];
  if (previous && (previous.status !== "pending" || previous.idempotencyKey !== request.idempotencyKey ||
      previous.addresseeAgentId !== identity.reviewerAgentId)) throw new Error("Conflicting PR child review card");
  let cardId = previous?.id;
  if (!cardId) {
    const reviewer = z.object({ id: z.string(), companyId: z.string(), status: z.string() })
      .parse(await input.api.get(`/agents/${encodeURIComponent(identity.reviewerAgentId)}`));
    if (reviewer.id !== identity.reviewerAgentId || reviewer.companyId !== identity.companyId) {
      throw new Error("PR child reviewer identity changed");
    }
    if (reviewer.status === "paused" || reviewer.status === "error") {
      const parked = Issue.parse(await input.api.patch(root, { status: "backlog" }));
      if (parked.id !== input.childId || parked.status !== "backlog" || parked.assigneeAgentId !== identity.bootstrapAgentId) {
        throw new Error("Unavailable PR reviewer child could not be parked");
      }
      return { kind: "reviewer_unavailable", childId: input.childId, reviewerId: reviewer.id };
    }
    const created = Card.parse(await input.api.post(`${root}/interactions`, request));
    if (created.status !== "pending" || created.idempotencyKey !== request.idempotencyKey ||
        created.addresseeAgentId !== identity.reviewerAgentId || created.sourceRunId !== input.runId) {
      throw new Error("PR child card was not attributed to the child bootstrap run");
    }
    cardId = created.id;
  } else {
    const source = Run.parse(await input.api.get(`/heartbeat-runs/${encodeURIComponent(previous!.sourceRunId)}`));
    if (source.companyId !== identity.companyId || source.agentId !== identity.bootstrapAgentId ||
        source.contextSnapshot.issueId !== input.childId) throw new Error("Existing PR child card source run changed");
  }
  const parked = Issue.parse(await input.api.patch(root, { status: "backlog" }));
  if (parked.id !== input.childId || parked.status !== "backlog" || parked.assigneeAgentId !== identity.bootstrapAgentId) {
    throw new Error("PR child bootstrap did not park its own child");
  }
  return { kind: "card", cardId };
}

/** A separate maintenance-scoped run activates only a settled child bootstrap card. */
export async function activatePrReviewChild(input: {
  readonly identity: PrReviewChildIdentity; readonly childId: string; readonly api: ChildReviewApi;
}): Promise<"activated" | "waiting"> {
  const identity = PrReviewChildIdentitySchema.parse(input.identity);
  const root = `/issues/${encodeURIComponent(input.childId)}`;
  const [child, rawCards] = await Promise.all([
    input.api.get(root).then((item) => Issue.parse(item)),
    input.api.get(`${root}/interactions`).then((items) => z.array(Card).parse(items)),
    assertRegisteredParent(identity, input.api),
  ]);
  assertChildIdentity(identity, child, input.childId);
  if (rawCards.length !== 1) throw new Error("PR review child requires exactly one native card");
  const card = rawCards[0]!;
  if (card.idempotencyKey !== reviewInteractionIdempotencyKey({ issueId: input.childId, prUrl: identity.prUrl,
    headSha: identity.headSha, stage: identity.stage }) || card.addresseeAgentId !== identity.reviewerAgentId) {
    throw new Error("PR child card is for a different stage or immutable head");
  }
  if (child.assigneeAgentId === identity.reviewerAgentId) return "waiting";
  if (child.status !== "backlog" || child.assigneeAgentId !== identity.bootstrapAgentId || card.status !== "pending") {
    throw new Error("PR child activation conflicts with an active or terminal review");
  }
  const [source, rawRuns] = await Promise.all([
    input.api.get(`/heartbeat-runs/${encodeURIComponent(card.sourceRunId)}`).then((item) => Run.parse(item)),
    input.api.get(`${root}/runs`).then((items) => z.array(z.object({ agentId: z.string(), status: z.string() })).parse(items)),
  ]);
  if (source.companyId !== identity.companyId || source.agentId !== identity.bootstrapAgentId ||
      source.contextSnapshot.issueId !== input.childId || source.status !== "succeeded") {
    throw new Error("PR child bootstrap run has not settled successfully");
  }
  if (rawRuns.some((run) => run.agentId === identity.reviewerAgentId &&
      ["queued", "running", "scheduled"].includes(run.status))) return "waiting";
  const reviewer = z.object({ id: z.string(), companyId: z.string(), status: z.string() })
    .parse(await input.api.get(`/agents/${encodeURIComponent(identity.reviewerAgentId)}`));
  if (reviewer.id !== identity.reviewerAgentId || reviewer.companyId !== identity.companyId) {
    throw new Error("PR child reviewer identity changed before activation");
  }
  if (reviewer.status === "paused" || reviewer.status === "error") return "waiting";
  const activated = Issue.parse(await input.api.patch(root, { status: "todo", assigneeAgentId: identity.reviewerAgentId }));
  if (activated.id !== input.childId || activated.assigneeAgentId !== identity.reviewerAgentId || activated.status !== "todo") {
    throw new Error("PR child reviewer activation receipt mismatched");
  }
  return "activated";
}

/** Read one child-owned structured PR decision; free-text comments cannot satisfy this gate. */
export async function observePrReviewChild(input: {
  readonly identity: PrReviewChildIdentity; readonly childId: string; readonly api: ChildReviewApi;
}): Promise<
  | { readonly kind: "waiting"; readonly childId: string }
  | { readonly kind: "answered"; readonly childId: string; readonly cardId: string; readonly reviewerRunId: string;
      readonly verdict: "approve" | "reject"; readonly reason?: string }
> {
  const identity = PrReviewChildIdentitySchema.parse(input.identity);
  const root = `/issues/${encodeURIComponent(input.childId)}`;
  const [child, cards] = await Promise.all([
    input.api.get(root).then((item) => Issue.parse(item)),
    input.api.get(`${root}/interactions`).then((items) => z.array(Card).parse(items)),
    assertRegisteredParent(identity, input.api),
  ]);
  assertChildIdentity(identity, child, input.childId);
  if (cards.length !== 1) throw new Error("PR reviewer child must have exactly one native card");
  const card = cards[0]!;
  if (card.idempotencyKey !== reviewInteractionIdempotencyKey({ issueId: input.childId, prUrl: identity.prUrl,
    headSha: identity.headSha, stage: identity.stage }) || card.addresseeAgentId !== identity.reviewerAgentId) {
    throw new Error("PR reviewer card does not match child stage and head");
  }
  if (card.status === "pending") return { kind: "waiting", childId: input.childId };
  if (card.status !== "answered" || !card.resolvedByRunId ||
      (card.resolvedByAgentId != null && card.resolvedByAgentId !== identity.reviewerAgentId) ||
      child.assigneeAgentId !== identity.reviewerAgentId) {
    throw new Error("PR reviewer card has no attributable typed verdict");
  }
  const result = z.object({ outcome: z.literal("resolved"), complete: z.literal(true),
    items: z.array(z.object({ id: z.literal("pull_request"), verdict: z.enum(["approve", "reject"]),
      reason: z.string().optional() })).length(1) }).parse(card.result);
  const verdict = result.items[0]!;
  if (verdict.verdict === "reject" && !verdict.reason?.trim()) throw new Error("PR rejection requires an actionable native reason");
  const [source, reviewer] = await Promise.all([
    input.api.get(`/heartbeat-runs/${encodeURIComponent(card.sourceRunId)}`).then((item) => Run.parse(item)),
    input.api.get(`/heartbeat-runs/${encodeURIComponent(card.resolvedByRunId)}`).then((item) => Run.parse(item)),
  ]);
  if (source.companyId !== identity.companyId || source.agentId !== identity.bootstrapAgentId ||
      source.status !== "succeeded" || source.contextSnapshot.issueId !== input.childId ||
      reviewer.companyId !== identity.companyId || reviewer.agentId !== identity.reviewerAgentId ||
      reviewer.status !== "succeeded" || reviewer.contextSnapshot.issueId !== input.childId) {
    throw new Error("PR child card source or reviewer run provenance failed");
  }
  return { kind: "answered", childId: input.childId, cardId: card.id, reviewerRunId: reviewer.id,
    verdict: verdict.verdict, ...(verdict.verdict === "reject" ? { reason: verdict.reason!.trim() } : {}) };
}

/** Adapter-only view of a verified child verdict for the existing parent PR-review reducer. */
export function projectPrChildVerdict(
  identityInput: PrReviewChildIdentity,
  observation: Extract<Awaited<ReturnType<typeof observePrReviewChild>>, { kind: "answered" }>,
): NativeReviewInteraction {
  const identity = PrReviewChildIdentitySchema.parse(identityInput);
  if (!observation.childId || !observation.cardId || !observation.reviewerRunId ||
      (observation.verdict === "reject" && !observation.reason?.trim())) {
    throw new Error("PR child verdict projection lacks its exact typed card/run identity");
  }
  return {
    id: observation.cardId, kind: "request_item_verdicts", status: "answered",
    idempotencyKey: reviewInteractionIdempotencyKey({ issueId: identity.parentIssueId, prUrl: identity.prUrl,
      headSha: identity.headSha, stage: identity.stage }), addresseeAgentId: identity.reviewerAgentId,
    result: { outcome: "resolved", complete: true,
      items: [{ id: "pull_request", verdict: observation.verdict,
        ...(observation.verdict === "reject" ? { reason: observation.reason!.trim() } : {}) }] },
  };
}

export type PrChildReviewInspection =
  | { readonly kind: "dispatch"; readonly stage: "luna" | "strong"; readonly reviewerAgentId: string;
      readonly projections: readonly NativeReviewInteraction[] }
  | { readonly kind: "bootstrap" | "activate" | "waiting"; readonly stage: "luna" | "strong";
      readonly childId: string; readonly identity: PrReviewChildIdentity;
      readonly projections: readonly NativeReviewInteraction[] }
  | { readonly kind: "rejected"; readonly stage: "luna" | "strong"; readonly childId: string;
      readonly reason: string; readonly projections: readonly NativeReviewInteraction[] }
  | { readonly kind: "approved"; readonly projections: readonly NativeReviewInteraction[] };

/** Read only: never synthesize a parent verdict until a child card and both run identities are verified. */
export async function inspectPrReviewChildren(input: {
  readonly companyId: string; readonly parentIssueId: string; readonly prUrl: string; readonly headSha: string;
  readonly bootstrapAgentId: string; readonly lunaAgentId: string; readonly strongAgentId: string;
  readonly api: ChildReviewApi;
}): Promise<PrChildReviewInspection> {
  const base = { version: 1 as const, companyId: input.companyId, parentIssueId: input.parentIssueId,
    prUrl: input.prUrl, headSha: input.headSha, bootstrapAgentId: input.bootstrapAgentId };
  const children = z.array(Issue).parse(await input.api.get(
    `/companies/${encodeURIComponent(input.companyId)}/issues?limit=1000&parentId=${encodeURIComponent(input.parentIssueId)}`,
  ));
  if (children.length >= 1000) throw new Error("PR child review history is incomplete");
  const stages = [{ stage: "luna" as const, reviewerAgentId: input.lunaAgentId },
    { stage: "strong" as const, reviewerAgentId: input.strongAgentId }];
  const projections: NativeReviewInteraction[] = [];
  for (const { stage, reviewerAgentId } of stages) {
    const identity = PrReviewChildIdentitySchema.parse({ ...base, stage, reviewerAgentId });
    const key = prReviewChildKey(identity);
    const matches = children.filter((child) => {
      const descriptor = parsePrReviewChildDescription(child.description);
      return child.companyId === input.companyId && child.parentId === input.parentIssueId &&
        descriptor && prReviewChildKey(descriptor) === key;
    });
    if (matches.length > 1) throw new Error("Multiple native PR child reviews share one immutable stage");
    const child = matches[0];
    if (!child) {
      if (stage === "luna" && children.some((candidate) => {
        const descriptor = parsePrReviewChildDescription(candidate.description);
        return descriptor?.parentIssueId === input.parentIssueId && descriptor.prUrl === input.prUrl &&
          descriptor.headSha === input.headSha && descriptor.stage === "strong";
      })) throw new Error("Strong PR review exists without its Luna prerequisite");
      return { kind: "dispatch", stage, reviewerAgentId, projections };
    }
    assertChildIdentity(identity, child, child.id);
    const cards = z.array(Card).parse(await input.api.get(`/issues/${encodeURIComponent(child.id)}/interactions`));
    if (cards.length > 1) throw new Error("Ambiguous PR child native cards");
    if (cards.length === 0) {
      if (child.assigneeAgentId !== input.bootstrapAgentId || child.status !== "backlog") {
        throw new Error("PR child has no card but changed bootstrap ownership");
      }
      return { kind: "bootstrap", stage, childId: child.id, identity, projections };
    }
    const card = cards[0]!;
    if (card.status === "pending") {
      if (child.assigneeAgentId === input.bootstrapAgentId && child.status === "backlog") {
        return { kind: "activate", stage, childId: child.id, identity, projections };
      }
      if (child.assigneeAgentId === reviewerAgentId) {
        return { kind: "waiting", stage, childId: child.id, identity, projections };
      }
      throw new Error("PR child pending card has no authorized reviewer or bootstrap owner");
    }
    const observed = await observePrReviewChild({ identity, childId: child.id, api: input.api });
    if (observed.kind !== "answered") throw new Error("Terminal PR child card has no typed reviewer verdict");
    projections.push(projectPrChildVerdict(identity, observed));
    if (observed.verdict === "reject") return { kind: "rejected", stage, childId: child.id,
      reason: observed.reason!, projections };
  }
  return { kind: "approved", projections };
}

export function prReviewChildApi(client: PaperclipHttp): ChildReviewApi {
  const mutate = async (path: string, method: "POST" | "PATCH", body: unknown): Promise<unknown> => {
    const receipt = await client.sendJson(`/api${path}`, method, body);
    if (!receipt.ok || receipt.data === undefined) {
      throw new Error(`Authenticated PR child ${method} ${path} failed (${receipt.status}): ${receipt.text}`);
    }
    return receipt.data;
  };
  return { get: (path) => client.getJson<unknown>(`/api${path}`),
    post: (path, body) => mutate(path, "POST", body),
    patch: (path, body) => mutate(path, "PATCH", body) };
}
