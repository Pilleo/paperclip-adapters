import { asArray, type PaperclipHttp } from "./paperclip-http.js";
import { decideNativeReviewWake, type NativeReviewWakeDecision } from "./native-review-recovery-state.js";
import { parseHeartbeatRun } from "./session-continuation.js";

export interface NativeReviewRecoveryInput {
  readonly paperclip: PaperclipHttp;
  readonly agentId: string;
  readonly issueId: string;
  readonly interactionId: string;
  /** Canonical card identity observed by the outer recovery reducer. */
  readonly immutableKey?: string;
  readonly reason: string;
  readonly idempotencyKey?: string;
  readonly prepareTransport?: () => Promise<void>;
}

export type NativeReviewRecoveryResult =
  | {
      readonly ok: true;
      readonly status: 204;
      readonly text: "host_owned_native_dispatch";
      readonly data: { readonly kind: "host_owned_native_dispatch" };
    }
  | { readonly ok: false; readonly status: 400; readonly text: string; readonly code: "invalid_native_review_identity" };

export async function revalidateNativeReviewWake(input: {
  readonly paperclip: Pick<PaperclipHttp, "listInteractions" | "listHeartbeatRuns">;
  readonly companyId: string;
  readonly agentId: string;
  readonly issueId: string;
  readonly interactionId: string;
  readonly immutableKey?: string;
  readonly nowMs: number;
  readonly graceMs: number;
}): Promise<NativeReviewWakeDecision> {
  const rawRuns = await input.paperclip.listHeartbeatRuns(input.companyId, input.agentId, 50);
  const interactions = await input.paperclip.listInteractions<unknown>(input.issueId);
  const card = asArray<Record<string, unknown>>(interactions).find((candidate) => candidate["id"] === input.interactionId);
  if (!card) return { action: "no_action" };
  if (
    input.immutableKey !== undefined &&
    (card["idempotencyKey"] !== input.immutableKey || card["addresseeAgentId"] !== input.agentId)
  ) {
    return { action: "protocol_failure", reason: "card_identity_mismatch" };
  }
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
 * Paperclip creates the canonical `interaction_pending` wake when it creates
 * an addressed native verdict card. Recovery therefore has no provider-side
 * action to perform: writing a second wake, a comment, or an adapter route
 * races the host queue and can repeatedly run the same reviewer.
 */
/** @deprecated Native cards are host-dispatched; recovery callers must use the replacement reducer. */
export async function prepareAndWakeNativeReview(input: NativeReviewRecoveryInput): Promise<NativeReviewRecoveryResult> {
  if (![input.agentId, input.issueId, input.interactionId, input.reason].every((value) => value.trim().length > 0)) {
    return { ok: false, status: 400, text: "invalid_native_review_identity", code: "invalid_native_review_identity" };
  }
  return {
    ok: true,
    status: 204,
    text: "host_owned_native_dispatch",
    data: { kind: "host_owned_native_dispatch" },
  };
}

export async function recoverNativeReviewCard(input: NativeReviewRecoveryInput): Promise<NativeReviewRecoveryResult> {
  return prepareAndWakeNativeReview(input);
}
