import { nativeReviewFetch } from "./native-review-http.js";
import { z } from "zod";

/**
 * Adapter-side transport for native Paperclip review cards.
 *
 * The reviewer decides the verdict, but must never copy an interaction UUID
 * from prose. The UUID and item id are resolved from the server-owned card.
 * This is intentionally an adapters-only compatibility layer until Paperclip
 * exposes a first-class "submit current review" tool to local agents.
 */

export type NativeReviewVerdict = "approve" | "reject";
export type JulesQuestionDecision = "answer" | "escalate";

export interface NativeReviewCard {
  readonly id: string;
  readonly idempotencyKey?: string;
  readonly kind: string;
  readonly status: string;
  readonly addresseeAgentId?: string | null;
  readonly payload?: {
    readonly items?: readonly [{ readonly id?: string; readonly label?: string }] | readonly { readonly id?: string; readonly label?: string }[];
    readonly detailsMarkdown?: string;
    readonly target?: unknown;
  };
}

export interface NativePlanReviewTarget {
  readonly type: "issue_document";
  readonly issueId: string;
  readonly documentId: string;
  readonly key: "plan";
  readonly revisionId: string;
  readonly revisionNumber: number;
}

export type NativeReviewAssignment =
  | { readonly kind: "plan_review_recorded"; readonly interactionId: string; readonly verdict: NativeReviewVerdict }
  | {
      readonly kind: "plan_handback_recovered";
      readonly interactionId: string;
      readonly verdict: NativeReviewVerdict;
    }
  | {
      readonly kind: "plan";
      readonly interactionId: string;
      readonly itemId: "plan";
      readonly detailsMarkdown: string;
      readonly target: NativePlanReviewTarget;
    }
  | {
      readonly kind: "pull_request";
      readonly interactionId: string;
      readonly itemId: "pull_request";
      readonly prUrl: string;
      readonly headSha: string;
    };

export type NativeReviewAssignmentResult =
  | { readonly ok: true; readonly assignment: NativeReviewAssignment }
  | NativeReviewFailure;

type NativeReviewSuccess = {
  readonly ok: true;
  readonly interactionId: string;
  readonly itemId: string;
  readonly verdict: NativeReviewVerdict;
  readonly planReviewProtocol?: "child_v3";
  readonly childReviewKey?: string;
};

export type NativeReviewFailureCode =
  | "missing_runtime_context"
  | "missing_runtime_auth"
  | "runtime_transport_error"
  | "list_http_error"
  | "list_invalid_response"
  | "no_owned_pending_card"
  | "ambiguous_owned_pending_cards"
  | "mismatched_review_card"
  | "malformed_review_card"
  | "rejection_reason_required"
  | "submit_http_error"
  | "submit_invalid_response"
  | "invalid_identity"
  | "evidence_unavailable"
  | "invalid_card_evidence"
  | "untrusted_plan_verdict"
  | "stale_plan_revision"
  | "unowned_review_policy"
  | "unexpected_issue_state"
  | "handback_failed"
  | "child_plan_cleanup_failed";

export type NativeReviewFailure = {
  readonly ok: false;
  readonly code: NativeReviewFailureCode;
  readonly status?: number;
};

export type NativeReviewSubmissionResult = NativeReviewSuccess | NativeReviewFailure;

type ResolvedCard = { readonly card: NativeReviewCard; readonly item: { readonly id: string } };
type NativeReviewFetcher = (url: string | URL, init?: RequestInit) => Promise<Response>;

function parsePlanTarget(value: unknown): NativePlanReviewTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const issueId = typeof raw["issueId"] === "string" ? raw["issueId"].trim() : "";
  const documentId = typeof raw["documentId"] === "string" ? raw["documentId"].trim() : "";
  const revisionId = typeof raw["revisionId"] === "string" ? raw["revisionId"].trim() : "";
  const revisionNumber = raw["revisionNumber"];
  return raw["type"] === "issue_document" && raw["key"] === "plan" && issueId && documentId && revisionId &&
    typeof revisionNumber === "number" && Number.isInteger(revisionNumber) && revisionNumber > 0
    ? { type: "issue_document", issueId, documentId, key: "plan", revisionId, revisionNumber }
    : null;
}

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

/** Read-only, immutable context for one addressed Jules plan review. */
export function resolveNativeReviewAssignment(
  cards: readonly NativeReviewCard[],
  agentId: string,
): NativeReviewAssignmentResult {
  const resolved = resolveNativeReviewCard(cards, agentId);
  if (!resolved.ok && resolved.code === "no_owned_pending_card") {
    const answeredSchema = z.object({ id: z.string(), kind: z.literal("request_item_verdicts"), status: z.literal("answered"),
      idempotencyKey: z.string().regex(/^jules:plan-child:v3:[0-9a-f]{64}$/), addresseeAgentId: z.literal(agentId),
      resolvedByAgentId: z.literal(agentId), resolvedByRunId: z.string().min(1),
      result: z.object({ outcome: z.literal("resolved"), complete: z.literal(true), items: z.array(z.object({
        id: z.literal("plan"), verdict: z.enum(["approve", "reject"]), reason: z.string().optional(),
      })).length(1) }),
    });
    const answered = cards.flatMap((card) => { const parsed = answeredSchema.safeParse(card); return parsed.success ? [parsed.data] : []; });
    const only = answered.length === 1 ? answered[0] : undefined;
    const verdict = only?.result.items[0];
    if (only && verdict && (verdict.verdict === "approve" || verdict.reason?.trim())) return { ok: true,
      assignment: { kind: "plan_review_recorded", interactionId: only.id, verdict: verdict.verdict } };
  }
  if (!resolved.ok) return resolved;
  const detailsMarkdown = resolved.card.payload?.detailsMarkdown?.trim() ?? "";
  const target = parsePlanTarget(resolved.card.payload?.target);
  if (resolved.item.id === "plan" && target && detailsMarkdown) {
    return {
      ok: true,
      assignment: {
        kind: "plan",
        interactionId: resolved.card.id,
        itemId: "plan",
        detailsMarkdown,
        target,
      },
    };
  }
  const prUrl = /^\*\*PR:\*\*\s*(https?:\/\/\S+)/m.exec(detailsMarkdown)?.[1];
  const headSha = /:([a-f0-9]{40}):(?:luna|terra)(?::attempt:[1-9]\d*)?$/i.exec(resolved.card.idempotencyKey ?? "")?.[1];
  if (resolved.item.id !== "pull_request" || !prUrl || !headSha) return { ok: false, code: "malformed_review_card" };
  return {
    ok: true,
    assignment: {
      kind: "pull_request",
      interactionId: resolved.card.id,
      itemId: "pull_request",
      prUrl,
      headSha,
    },
  };
}

export interface NativeReviewSubmissionInput {
  readonly apiBase: string;
  readonly issueId: string;
  readonly agentId: string;
  readonly token?: string;
  readonly runId?: string;
  /** The interaction bound to this heartbeat run, when Paperclip provided it. */
  readonly interactionId?: string;
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
  if (input.interactionId && resolved.card.id !== input.interactionId) return fail("mismatched_review_card");

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
  const target = parsePlanTarget(resolved.card.payload?.target);
  const childReviewKey = resolved.card.idempotencyKey;
  const childPlan = resolved.item.id === "plan" && /^jules:plan-child:v3:[0-9a-f]{64}$/.test(childReviewKey ?? "") &&
    target !== null && target.issueId !== input.issueId;
  return { ok: true, interactionId: resolved.card.id, itemId: resolved.item.id, verdict: input.verdict,
    ...(childPlan && childReviewKey ? { planReviewProtocol: "child_v3" as const, childReviewKey } : {}) };
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
  const issueId = input.issueId;
  let response: Response;
  try {
    response = await fetcher(
      `${apiRoot(input.apiBase)}/api/issues/${encodeURIComponent(issueId)}/interactions`,
      { headers: runtimeHeaders(input) },
    );
  } catch {
    return fail("runtime_transport_error");
  }
  if (!response.ok) return fail("list_http_error", response.status);
  const cards = await response.json().catch(() => null);
  if (!Array.isArray(cards)) return fail("list_invalid_response");
  return submitNativeReviewVerdict({ ...input, issueId, cards: cards as NativeReviewCard[] });
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

/** Fetch and decode the one assignment that the current reviewer may inspect. */
export async function readNativeReviewAssignmentFromRuntime(
  input: Omit<NativeReviewRuntimeSubmissionInput, "verdict" | "reason">,
): Promise<NativeReviewAssignmentResult> {
  if (!input.apiBase.trim() || !input.issueId?.trim() || !input.agentId.trim()) {
    return fail("missing_runtime_context");
  }
  if (!input.token?.trim() && !isLoopbackApi(input.apiBase)) return fail("missing_runtime_auth");
  const issueId = input.issueId;
  const fetcher = input.fetcher ?? nativeReviewFetch;
  let response: Response;
  try {
    response = await fetcher(
      `${apiRoot(input.apiBase)}/api/issues/${encodeURIComponent(issueId)}/interactions`,
      { headers: runtimeHeaders(input) },
    );
  } catch {
    return fail("runtime_transport_error");
  }
  if (!response.ok) return fail("list_http_error", response.status);
  const cards = await response.json().catch(() => null);
  if (!Array.isArray(cards)) return fail("list_invalid_response");
  const assignment = resolveNativeReviewAssignment(cards as NativeReviewCard[], input.agentId);
  if (!assignment.ok) return assignment;
  if (input.interactionId && assignment.assignment.interactionId !== input.interactionId) {
    return fail("mismatched_review_card");
  }
  return assignment;
}

/**
 * Resolve and answer exactly one reviewer-owned Jules question form.
 *
 * This mirrors native-review submission but intentionally uses Paperclip's
 * `ask_user_questions` response contract. The model supplies only the
 * decision text; it never selects a card ID or writes a comment fallback.
 */
export async function submitJulesQuestionDecisionFromRuntime(input: {
  readonly apiBase: string;
  readonly issueId: string;
  readonly agentId: string;
  readonly token?: string;
  readonly runId?: string;
  readonly decision: JulesQuestionDecision;
  readonly response: string;
  readonly fetcher?: typeof fetch;
}): Promise<
  | { readonly ok: true; readonly interactionId: string; readonly decision: JulesQuestionDecision }
  | { readonly ok: false; readonly code: string; readonly status?: number }
> {
  if (!input.apiBase.trim() || !input.issueId.trim() || !input.agentId.trim() || !input.response.trim()) {
    return { ok: false, code: "missing_runtime_context" };
  }
  if (!input.token?.trim() && !isLoopbackApi(input.apiBase)) return { ok: false, code: "missing_runtime_auth" };
  const fetcher = input.fetcher ?? nativeReviewFetch;
  let list: Response;
  try {
    list = await fetcher(
      `${apiRoot(input.apiBase)}/api/issues/${encodeURIComponent(input.issueId)}/interactions`,
      { headers: runtimeHeaders(input) },
    );
  } catch {
    return { ok: false, code: "runtime_transport_error" };
  }
  if (!list.ok) return { ok: false, code: "list_http_error", status: list.status };
  const cards = await list.json().catch(() => null);
  if (!Array.isArray(cards)) return { ok: false, code: "list_invalid_response" };
  const owned = cards.filter((card): card is NativeReviewCard =>
    typeof card === "object" && card !== null &&
    (card as NativeReviewCard).kind === "ask_user_questions" &&
    (card as NativeReviewCard).status === "pending" &&
    (card as NativeReviewCard).addresseeAgentId === input.agentId,
  );
  if (owned.length !== 1 || !owned[0]?.id) {
    return { ok: false, code: owned.length === 0 ? "no_owned_pending_card" : "ambiguous_owned_pending_cards" };
  }
  const card = owned[0];
  let submitted: Response;
  try {
    submitted = await fetcher(
      `${apiRoot(input.apiBase)}/api/issues/${encodeURIComponent(input.issueId)}/interactions/${encodeURIComponent(card.id)}/respond`,
      {
        method: "POST",
        headers: runtimeHeaders(input),
        body: JSON.stringify({
          answers: [
            { questionId: "resolution", optionIds: [input.decision] },
            { questionId: "response", optionIds: ["response"], otherText: input.response.trim() },
          ],
        }),
      },
    );
  } catch {
    return { ok: false, code: "runtime_transport_error" };
  }
  if (!submitted.ok) return { ok: false, code: "submit_http_error", status: submitted.status };
  const body = await submitted.json().catch(() => null) as { id?: unknown; status?: unknown } | null;
  if (body?.id !== card.id || body.status !== "answered") return { ok: false, code: "submit_invalid_response" };
  return { ok: true, interactionId: card.id, decision: input.decision };
}

export function isResolvedNativeReviewCard(value: unknown): value is ResolvedCard {
  return typeof value === "object" && value !== null && "card" in value && "item" in value;
}
