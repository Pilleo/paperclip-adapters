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
type NativeReviewFetcher = (url: string | URL, init?: RequestInit) => Promise<Response>;

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
  readonly fetcher?: NativeReviewFetcher;
}

export type NativeReviewRuntimeSubmissionInput = Omit<NativeReviewSubmissionInput, "cards" | "issueId"> & {
  readonly issueId?: string;
  readonly companyId?: string;
};

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

  const fetcher: NativeReviewFetcher = input.fetcher ?? nativeReviewFetch;
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
  if (!input.apiBase.trim() || !input.agentId.trim() || (!input.issueId?.trim() && !input.companyId?.trim())) {
    return fail("missing_runtime_context");
  }
  if (!input.token?.trim() && !isLoopbackApi(input.apiBase)) return fail("missing_runtime_auth");
  const fetcher = input.fetcher ?? nativeReviewFetch;
  if (!input.issueId?.trim()) {
    const companyId = input.companyId?.trim();
    if (!companyId) return fail("missing_runtime_context");
    return submitSingleOwnedCompanyCard({ ...input, companyId, fetcher });
  }
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
  return submitNativeReviewVerdict({ ...input, issueId: input.issueId, cards: cards as NativeReviewCard[] });
}

/**
 * Compatibility for Codex MCP children: current Paperclip injects task scope
 * into the Codex process but Codex does not pass that environment through to
 * configured MCP servers. Search only the addressed reviewer's own live
 * assignments, and proceed only when exactly one owned pending card exists.
 *
 * This is deliberately fail-closed. Paperclip should eventually pass the
 * run's task/interaction binding directly to MCP subprocesses, letting this
 * compatibility lookup be removed.
 */
async function submitSingleOwnedCompanyCard(
  input: NativeReviewRuntimeSubmissionInput & { readonly companyId: string; readonly fetcher: NativeReviewFetcher },
): Promise<NativeReviewSubmissionResult> {
  let issueResponse: Response;
  try {
    const query = new URLSearchParams({
      assigneeAgentId: input.agentId,
      status: "todo,in_progress,in_review,blocked",
    });
    issueResponse = await input.fetcher(
      `${apiRoot(input.apiBase)}/api/companies/${encodeURIComponent(input.companyId)}/issues?${query.toString()}`,
      { headers: runtimeHeaders(input) },
    );
  } catch {
    return fail("runtime_transport_error");
  }
  if (!issueResponse.ok) return fail("list_http_error", issueResponse.status);
  const issues = await issueResponse.json().catch(() => null);
  if (!Array.isArray(issues)) return fail("list_invalid_response");

  const candidates: Array<{ issueId: string; cards: NativeReviewCard[] }> = [];
  for (const issue of issues) {
    const issueId = typeof issue === "object" && issue !== null && !Array.isArray(issue)
      ? (issue as Record<string, unknown>)["id"]
      : undefined;
    if (typeof issueId !== "string" || !issueId.trim()) return fail("list_invalid_response");
    let cardResponse: Response;
    try {
      cardResponse = await input.fetcher(
        `${apiRoot(input.apiBase)}/api/issues/${encodeURIComponent(issueId)}/interactions`,
        { headers: runtimeHeaders(input) },
      );
    } catch {
      return fail("runtime_transport_error");
    }
    if (!cardResponse.ok) return fail("list_http_error", cardResponse.status);
    const cards = await cardResponse.json().catch(() => null);
    if (!Array.isArray(cards)) return fail("list_invalid_response");
    if (cards.some((card) => card && typeof card === "object" && !Array.isArray(card) &&
      (card as NativeReviewCard).kind === "request_item_verdicts" &&
      (card as NativeReviewCard).status === "pending" &&
      (card as NativeReviewCard).addresseeAgentId === input.agentId)) {
      candidates.push({ issueId, cards: cards as NativeReviewCard[] });
    }
  }
  if (candidates.length === 0) return fail("no_owned_pending_card");
  if (candidates.length > 1) return fail("ambiguous_owned_pending_cards");
  const candidate = candidates[0];
  if (!candidate) return fail("no_owned_pending_card");
  return submitNativeReviewVerdict({ ...input, issueId: candidate.issueId, cards: candidate.cards });
}

export function isResolvedNativeReviewCard(value: unknown): value is ResolvedCard {
  return typeof value === "object" && value !== null && "card" in value && "item" in value;
}
