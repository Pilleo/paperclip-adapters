import { nativeReviewFetch } from "./native-review-http.js";

/**
 * Adapter-side transport for native Paperclip review cards.
 *
 * The reviewer decides the verdict, but must never copy an interaction UUID
 * from prose. The UUID and item id are resolved from the server-owned card.
 * This is intentionally an adapters-only compatibility layer until Paperclip
 * exposes a first-class "submit current review" tool to local agents.
 */

export type NativeReviewVerdict = "approve" | "reject";

export interface NativeReviewCard {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly addresseeAgentId?: string | null;
  readonly payload?: { readonly items?: readonly [{ readonly id?: string; readonly label?: string }] | readonly { readonly id?: string; readonly label?: string }[] };
}

type NativeReviewSuccess = {
  readonly ok: true;
  readonly interactionId: string;
  readonly itemId: string;
  readonly verdict: NativeReviewVerdict;
};

export type NativeReviewFailureCode =
  | "missing_runtime_context"
  | "missing_runtime_auth"
  | "runtime_transport_error"
  | "list_http_error"
  | "list_invalid_response"
  | "no_owned_pending_card"
  | "ambiguous_owned_pending_cards"
  | "malformed_review_card"
  | "rejection_reason_required"
  | "submit_http_error"
  | "submit_invalid_response";

export type NativeReviewFailure = {
  readonly ok: false;
  readonly code: NativeReviewFailureCode;
  readonly status?: number;
};

export type NativeReviewSubmissionResult = NativeReviewSuccess | NativeReviewFailure;

type ResolvedCard = { readonly card: NativeReviewCard; readonly item: { readonly id: string } };

export function resolveNativeReviewCard(
  cards: readonly NativeReviewCard[],
  agentId: string,
): { readonly ok: true; readonly card: NativeReviewCard; readonly item: { readonly id: string } } | NativeReviewFailure {
  const owned = cards.filter((card) =>
    card.kind === "request_item_verdicts" &&
    card.status === "pending" &&
    card.addresseeAgentId === agentId,
  );
  if (owned.length === 0) return { ok: false, code: "no_owned_pending_card" };
  if (owned.length > 1) return { ok: false, code: "ambiguous_owned_pending_cards" };

  const ownedCard = owned[0];
  if (!ownedCard) return { ok: false, code: "no_owned_pending_card" };
  const items = ownedCard.payload?.items;
  if (!Array.isArray(items) || items.length !== 1 || typeof items[0]?.id !== "string" || !items[0].id.trim()) {
    return { ok: false, code: "malformed_review_card" };
  }
  return { ok: true, card: ownedCard, item: { id: items[0].id } };
}

export interface NativeReviewSubmissionInput {
  readonly apiBase: string;
  readonly issueId: string;
  readonly agentId: string;
  readonly token?: string;
  readonly runId?: string;
  readonly cards: readonly NativeReviewCard[];
  readonly verdict: NativeReviewVerdict;
  readonly reason?: string;
  readonly fetcher?: typeof fetch;
}

export type NativeReviewRuntimeSubmissionInput = Omit<NativeReviewSubmissionInput, "cards">;

function isLoopbackApi(value: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(?:\/|$)/i.test(value.trim());
}

function runtimeHeaders(input: { readonly token?: string; readonly runId?: string }): Record<string, string> {
  return {
    ...(input.token?.trim() ? { Authorization: `Bearer ${input.token.trim()}` } : {}),
    "Content-Type": "application/json",
    ...(input.runId?.trim() ? { "X-Paperclip-Run-Id": input.runId.trim() } : {}),
  };
}

function apiRoot(value: string): string {
  return value.replace(/\/+$/, "").replace(/\/api$/, "");
}

function fail(code: NativeReviewFailureCode, status?: number): NativeReviewFailure {
  return status === undefined ? { ok: false, code } : { ok: false, code, status };
}

export async function submitNativeReviewVerdict(input: NativeReviewSubmissionInput): Promise<NativeReviewSubmissionResult> {
  if (!input.apiBase.trim() || !input.issueId.trim() || !input.agentId.trim()) {
    return fail("missing_runtime_context");
  }
  if (!input.token?.trim() && !isLoopbackApi(input.apiBase)) return fail("missing_runtime_auth");
  if (input.verdict === "reject" && !input.reason?.trim()) return fail("rejection_reason_required");

  const resolved = resolveNativeReviewCard(input.cards, input.agentId);
  if (!resolved.ok) return resolved;

  const fetcher = input.fetcher ?? nativeReviewFetch;
  let response: Response;
  try {
    response = await fetcher(
      `${apiRoot(input.apiBase)}/api/issues/${encodeURIComponent(input.issueId)}/interactions/${encodeURIComponent(resolved.card.id)}/verdicts`,
      {
        method: "POST",
        headers: runtimeHeaders(input),
        body: JSON.stringify({
          verdicts: [{ id: resolved.item.id, verdict: input.verdict, ...(input.verdict === "reject" ? { reason: input.reason!.trim() } : {}) }],
        }),
      },
    );
  } catch {
    return fail("runtime_transport_error");
  }
  if (!response.ok) return fail("submit_http_error", response.status);

  const body = await response.json().catch(() => null) as {
    readonly id?: unknown;
    readonly status?: unknown;
    readonly result?: { readonly items?: readonly { readonly id?: unknown; readonly verdict?: unknown }[] };
  } | null;
  const returnedItem = body?.result?.items?.find((item) => item?.id === resolved.item.id);
  if (body?.id !== resolved.card.id || body.status !== "answered" || returnedItem?.verdict !== input.verdict) {
    return fail("submit_invalid_response");
  }
  return { ok: true, interactionId: resolved.card.id, itemId: resolved.item.id, verdict: input.verdict };
}

/**
 * Resolves the native card inside the reviewer process from its run-scoped
 * Paperclip identity. The model supplies a verdict only; it never receives
 * authority to choose an interaction or item identifier.
 */
export async function submitNativeReviewVerdictFromRuntime(
  input: NativeReviewRuntimeSubmissionInput,
): Promise<NativeReviewSubmissionResult> {
  if (!input.apiBase.trim() || !input.issueId.trim() || !input.agentId.trim()) {
    return fail("missing_runtime_context");
  }
  if (!input.token?.trim() && !isLoopbackApi(input.apiBase)) return fail("missing_runtime_auth");
  const fetcher = input.fetcher ?? nativeReviewFetch;
  let response: Response;
  try {
    response = await fetcher(
      `${apiRoot(input.apiBase)}/api/issues/${encodeURIComponent(input.issueId)}/interactions`,
      { headers: runtimeHeaders(input) },
    );
  } catch {
    return fail("runtime_transport_error");
  }
  if (!response.ok) return fail("list_http_error", response.status);
  const cards = await response.json().catch(() => null);
  if (!Array.isArray(cards)) return fail("list_invalid_response");
  return submitNativeReviewVerdict({ ...input, cards: cards as NativeReviewCard[] });
}

export function isResolvedNativeReviewCard(value: unknown): value is ResolvedCard {
  return typeof value === "object" && value !== null && "card" in value && "item" in value;
}
