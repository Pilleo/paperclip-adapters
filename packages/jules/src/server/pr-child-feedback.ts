import { z } from "zod";
import { nativePrRejectionDeliveryId, parseWorkerFeedback } from "@pilleo/paperclip-adapter-common";
import { getPaperclipJson } from "./paperclip-client.js";

const marker = "<!-- paperclip-pr-review-child:v2\n";
const Identity = z.object({
  version: z.literal(2), creatorPrincipal: z.literal("board"),
  companyId: z.string().min(1), parentIssueId: z.string().min(1),
  prUrl: z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*$/),
  headSha: z.string().regex(/^[0-9a-f]{40}$/i), stage: z.enum(["luna", "terra", "strong"]),
  reviewerAgentId: z.string().min(1), bootstrapAgentId: z.string().min(1),
}).strict().refine((value) => value.reviewerAgentId !== value.bootstrapAgentId);
const Child = z.object({ id: z.string(), companyId: z.string(), parentId: z.string().nullish(),
  createdByAgentId: z.string().nullish(), assigneeAgentId: z.string().nullish(),
  description: z.string().nullish() });
const Card = z.object({ id: z.string(), kind: z.string(), status: z.string(), idempotencyKey: z.string().nullish(),
  addresseeAgentId: z.string().nullish(), sourceRunId: z.string().nullish(),
  resolvedByRunId: z.string().nullish(), resolvedByAgentId: z.string().nullish(), result: z.unknown() });
const Run = z.object({ id: z.string(), companyId: z.string(), agentId: z.string(), status: z.string(),
  contextSnapshot: z.object({ issueId: z.string() }) });
const Verdict = z.object({ outcome: z.literal("resolved"), complete: z.literal(true),
  items: z.array(z.object({ id: z.literal("pull_request"), verdict: z.literal("reject"),
    reason: z.string().min(1) })).length(1) });

function identityFrom(description: string | null | undefined): z.infer<typeof Identity> | null {
  if (!description?.startsWith(marker)) return null;
  const end = description.indexOf("\n-->", marker.length);
  if (end < 0) return null;
  try {
    return Identity.safeParse(JSON.parse(description.slice(marker.length, end))).data ?? null;
  } catch { return null; }
}

/** Recover only a proved, head-bound board-created native PR child verdict after a deferred worker wake. */
export async function recoverBoardPrChildRejection(input: {
  companyId: string; issueId: string; prUrl: string; headSha: string;
  authToken?: string | undefined; runId?: string | undefined;
}): Promise<ReturnType<typeof parseWorkerFeedback>> {
  const get = (path: string) => getPaperclipJson<unknown>(`/api${path}`, input.authToken, input.runId);
  const children = z.array(Child).parse(await get(
    `/companies/${encodeURIComponent(input.companyId)}/issues?limit=1000&parentId=${encodeURIComponent(input.issueId)}`,
  ));
  if (children.length >= 1000) throw new Error("PR child feedback listing is incomplete");
  const matches = children.map((child) => ({ child, identity: identityFrom(child.description) }))
    .filter((match) => match.identity?.companyId === input.companyId &&
      match.identity.parentIssueId === input.issueId && match.identity.prUrl === input.prUrl &&
      match.identity.headSha === input.headSha && match.child.companyId === input.companyId &&
      match.child.parentId === input.issueId && match.child.createdByAgentId === null);
  for (const { child, identity } of matches) {
    if (!identity) continue;
    const cards = z.array(Card).parse(await get(`/issues/${encodeURIComponent(child.id)}/interactions`));
    if (cards.length !== 1) throw new Error("PR reviewer child must have exactly one native card");
    const card = cards[0]!;
    if (card.kind !== "request_item_verdicts" || card.status !== "answered") continue;
    if (card.idempotencyKey !== `pr-review:v13:${child.id}:${identity.prUrl}:${identity.headSha}:${identity.stage}` ||
        card.addresseeAgentId !== identity.reviewerAgentId || child.assigneeAgentId !== identity.reviewerAgentId ||
        !card.sourceRunId || !card.resolvedByRunId ||
        (card.resolvedByAgentId != null && card.resolvedByAgentId !== identity.reviewerAgentId)) {
      throw new Error("PR child rejection card is not attributable to the addressed reviewer and head");
    }
    const verdict = Verdict.safeParse(card.result);
    if (!verdict.success) continue;
    const [source, reviewer] = await Promise.all([
      get(`/heartbeat-runs/${encodeURIComponent(card.sourceRunId)}`).then((value) => Run.parse(value)),
      get(`/heartbeat-runs/${encodeURIComponent(card.resolvedByRunId)}`).then((value) => Run.parse(value)),
    ]);
    if (source.companyId !== identity.companyId || source.agentId !== identity.bootstrapAgentId ||
        source.status !== "succeeded" || source.contextSnapshot.issueId !== child.id ||
        reviewer.companyId !== identity.companyId || reviewer.agentId !== identity.reviewerAgentId ||
        reviewer.status !== "succeeded" || reviewer.contextSnapshot.issueId !== child.id) {
      throw new Error("PR child rejection source or reviewer run provenance failed");
    }
    return parseWorkerFeedback({ version: 1, kind: "code_review_rejection",
      deliveryId: nativePrRejectionDeliveryId({ interactionId: card.id, headSha: input.headSha }),
      issueId: input.issueId, reviewInteractionId: card.id, reviewStage: identity.stage,
      prUrl: input.prUrl, headSha: input.headSha, reason: verdict.data.items[0]!.reason.trim(),
      createdAt: new Date().toISOString(),
    });
  }
  return null;
}
