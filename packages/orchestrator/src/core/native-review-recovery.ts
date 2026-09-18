import { asArray, type PaperclipHttp } from "./paperclip-http.js";
import { decideNativeReviewWake, type NativeReviewWakeDecision } from "./native-review-recovery-state.js";
import { parseHeartbeatRun } from "./session-continuation.js";

/**
 * Paperclip v831 treats a non-assignee reviewer wake as live only when its
 * reason is one of the host's comment-origin reasons. A pending Jules review
 * already has a durable session-link comment, so reuse that anchor and this
 * host-recognized classification rather than creating a duplicate comment or
 * temporarily changing issue ownership.
 *
 * Compatibility bridge: remove this when Paperclip accepts a typed
 * `request_item_verdicts` interaction wake independently of its assignee.
 */
const HOST_COMMENT_ORIGIN_WAKE_REASON = "issue_commented";

export interface NativeReviewRecoveryInput {
  readonly paperclip: PaperclipHttp;
  readonly agentId: string;
  readonly issueId: string;
  readonly interactionId: string;
  /** Real issue-comment id used only by Paperclip's compatibility wake route. */
  readonly wakeCommentId?: string;
  readonly reason: string;
  readonly idempotencyKey?: string;
  /** Ensure the addressed reviewer has its typed MCP transport before wake. */
  readonly prepareTransport?: () => Promise<void>;
}

export type NativeReviewRecoveryResult =
  | { readonly ok: boolean; readonly status: number; readonly text: string; readonly data?: unknown }
  | { readonly ok: false; readonly status: 400; readonly text: string; readonly code: "invalid_native_review_identity" };

export async function revalidateNativeReviewWake(input: {
  readonly paperclip: Pick<PaperclipHttp, "listInteractions" | "listHeartbeatRuns">;
  readonly companyId: string;
  readonly agentId: string;
  readonly issueId: string;
  readonly interactionId: string;
  readonly nowMs: number;
  readonly graceMs: number;
}): Promise<NativeReviewWakeDecision> {
  const rawRuns = await input.paperclip.listHeartbeatRuns(input.companyId, input.agentId, 50);
  // Read the card last. A reviewer can submit its structured verdict while
  // this compatibility check is in flight; the final card state is the
  // authority that decides whether any wake may still be emitted.
  const interactions = await input.paperclip.listInteractions<unknown>(input.issueId);
  const card = asArray<Record<string, unknown>>(interactions).find((candidate) => candidate["id"] === input.interactionId);
  if (!card) return { action: "no_action" };
  return decideNativeReviewWake({
    issueId: input.issueId,
    reviewerAgentId: input.agentId,
    nowMs: input.nowMs,
    graceMs: input.graceMs,
    card: {
      id: input.interactionId,
      ...(typeof card["status"] === "string" ? { status: card["status"] } : {}),
      ...(typeof card["createdAt"] === "string" ? { createdAt: card["createdAt"] } : {}),
    },
    reviewerRuns: rawRuns.map(parseHeartbeatRun),
  });
}

/**
 * Paperclip v831 accepts a non-assignee reviewer wake only when it is tied to
 * a real issue comment. Jules writes this durable session-link comment when
 * it creates the provider session. Selecting it is transport compatibility,
 * not review parsing: the structured verdict remains bound by the one owned
 * pending interaction check in native-review-submission.
 */
export function selectNativeReviewWakeAnchor(
  comments: readonly { readonly id?: unknown; readonly body?: unknown }[],
): string | undefined {
  for (const comment of [...comments].reverse()) {
    if (typeof comment.id === "string" && comment.id.trim() &&
        typeof comment.body === "string" &&
        comment.body.includes("[Open Jules session](https://jules.google.com/session/")) {
      return comment.id;
    }
  }
  return undefined;
}

/**
 * Single adapter-owned wake contract for native review cards.
 *
 * Paperclip reads the issue anchor from `payload.issueId`; putting it at the
 * top level creates an unscoped run that falls back to the agent home, where
 * Codex rejects the repository as untrusted. Keeping this wrapper typed makes
 * that wire-shape impossible for automatic and operator recovery alike.
 */
export async function wakeNativeReview(input: NativeReviewRecoveryInput): Promise<NativeReviewRecoveryResult> {
  if (![input.agentId, input.issueId, input.interactionId, input.reason].every((value) => value.trim().length > 0)) {
    return { ok: false, status: 400, text: "invalid_native_review_identity", code: "invalid_native_review_identity" };
  }
  await input.prepareTransport?.();
  return input.paperclip.wakeup(
    input.agentId,
    input.wakeCommentId ? HOST_COMMENT_ORIGIN_WAKE_REASON : input.reason,
    input.issueId,
    {
      reviewInteractionId: input.interactionId,
      forceFreshSession: true,
      ...(input.wakeCommentId ? { wakeCommentId: input.wakeCommentId, source: "automation", triggerDetail: "system" } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    },
  );
}

/**
 * Recover one existing typed card through Paperclip's native dispatch route.
 * This route, unlike a generic agent wake, records the interaction binding in
 * the reviewer runtime context. The historic ownership-patch bridge created
 * unbound runs and therefore could never yield a structured verdict.
 */
export async function prepareAndWakeNativeReview(input: NativeReviewRecoveryInput): Promise<NativeReviewRecoveryResult> {
  // Paperclip v831's typed dispatch endpoint loses the card binding when the
  // reviewer differs from the issue assignee. Its comment-backed wake keeps
  // the run executable. Prefer that compatibility route when a durable
  // existing comment (normally the Jules session link) is available; the MCP
  // submission still resolves exactly one reviewer-owned pending card.
  if (input.wakeCommentId) return wakeNativeReview(input);
  const paperclip = input.paperclip as NativeReviewRecoveryInput["paperclip"] & {
    dispatchNativeReview(issueId: string, interactionId: string, idempotencyKey?: string): Promise<NativeReviewRecoveryResult>;
  };
  await input.prepareTransport?.();
  return paperclip.dispatchNativeReview(
    input.issueId,
    input.interactionId,
    input.idempotencyKey ?? `native-review-recovery:v2:${input.issueId}:${input.interactionId}`,
  );
}

/**
 * Recover an existing card through the v831-compatible transport without
 * making an operator copy an implementation detail from the issue timeline.
 * The latest durable Jules-session link is a host-owned execution anchor, not
 * a review decision; the decision remains confined to the addressed card.
 */
export async function recoverNativeReviewCard(
  input: Omit<NativeReviewRecoveryInput, "wakeCommentId">,
): Promise<NativeReviewRecoveryResult> {
  const comments = await input.paperclip.listComments(input.issueId);
  const wakeCommentId = Array.isArray(comments)
    ? selectNativeReviewWakeAnchor(comments)
    : undefined;
  return prepareAndWakeNativeReview({
    ...input,
    ...(wakeCommentId ? { wakeCommentId } : {}),
  });
}
