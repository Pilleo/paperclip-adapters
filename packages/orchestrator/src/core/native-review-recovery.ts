import type { PaperclipHttp } from "./paperclip-http.js";

export interface NativeReviewRecoveryInput {
  readonly paperclip: PaperclipHttp;
  readonly agentId: string;
  readonly issueId: string;
  readonly interactionId: string;
  readonly reason: string;
  readonly idempotencyKey?: string;
}

export type NativeReviewRecoveryResult =
  | { readonly ok: boolean; readonly status: number; readonly text: string; readonly data?: unknown }
  | { readonly ok: false; readonly status: 400; readonly text: string; readonly code: "invalid_native_review_identity" }
  | { readonly ok: false; readonly status: 409; readonly text: string; readonly code: "host_card_requeue_required" };

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
  return input.paperclip.wakeup(input.agentId, input.reason, input.issueId, {
    reviewInteractionId: input.interactionId,
    forceFreshSession: true,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  });
}

/**
 * Compatibility fence for Paperclip versions that validate queued reviewer
 * ownership before reading the interaction binding. Patching ownership queues
 * an unbound assignment run before an adapter can issue the typed wake; a
 * following HTTP 202 therefore cannot prove the native card was recovered.
 *
 * Keep normal routing core-owned. Until Paperclip exposes atomic requeue of an
 * addressed pending interaction, operator recovery must surface this typed
 * state instead of manufacturing an unsafe assignment-plus-wake sequence.
 */
export async function prepareAndWakeNativeReview(input: NativeReviewRecoveryInput): Promise<NativeReviewRecoveryResult> {
  void input;
  return {
    ok: false,
    status: 409,
    text: "host_card_requeue_required",
    code: "host_card_requeue_required",
  };
}
