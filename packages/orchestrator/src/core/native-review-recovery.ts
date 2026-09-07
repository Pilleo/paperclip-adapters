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
  | { readonly ok: false; readonly status: 400; readonly text: string; readonly code: "invalid_native_review_identity" };

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
 * Compatibility bridge for Paperclip versions that validate queued reviewer
 * ownership before reading the interaction binding. Keep it limited to an
 * explicit existing card recovery; normal review routing remains core-owned.
 * Remove once the host persists the native-card binding before its ownership
 * gate (see native-review-recovery-state.ts).
 */
export async function prepareAndWakeNativeReview(input: NativeReviewRecoveryInput): Promise<NativeReviewRecoveryResult> {
  const paperclip = input.paperclip as NativeReviewRecoveryInput["paperclip"] & {
    patchIssue(issueId: string, payload: { status: "in_review"; assigneeAgentId: string }): Promise<{ ok: boolean; status: number; text: string; data?: unknown }>;
  };
  const patched = await paperclip.patchIssue(input.issueId, {
    status: "in_review",
    assigneeAgentId: input.agentId,
  });
  if (!patched.ok) return patched;
  return wakeNativeReview(input);
}
