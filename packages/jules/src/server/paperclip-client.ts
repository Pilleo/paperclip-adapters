import { appendCardHelpText, formatCardPrompt, formatCardSummary, formatCardPromptAndHelpText, formatConfirmationDetails, MAX_CONFIRMATION_PROMPT_LENGTH, SafeCardPrompt, SafeCardSummary } from "./card-prompt.js";
import { createHash } from "node:crypto";
import {
  buildNativeInteractionWakeRequest,
  bootstrapChildPlanReview,
  executePaperclipCommand,
  nativePlanReviewStageId,
  reconcileChildPlanReview,
  type ChildPlanReviewIdentity,
  type ChildPlanReviewObservation,
  type ChildReviewApi,
  type PaperclipCommandResponse,
} from "@pilleo/paperclip-adapter-common";
import {
  extractJulesSessionId,
  extractJulesSessionIdFromComments,
  formatJulesSessionHandleBody,
  JULES_SESSION_DOCUMENT_KEY,
  parseJulesSessionHandle,
  type JulesSessionHandle,
} from "./jules-session-handle.js";
import {
  buildQuestionCorrelation,
  parseQuestionCorrelation,
  questionCorrelationMarker,
} from "./question-correlation.js";
import { planReviewIdempotencyKey } from "./plan-review-protocol.js";
const PAPERCLIP_API_URL_ENV = "PAPERCLIP_API_URL";
const JULES_REVIEWER_RESPONSE_HELP = 'Provide the exact answer for Jules, or the concrete ambiguity requiring human input. Submit this Paperclip form through its native respond endpoint using exactly: answers: [{ questionId: "resolution", optionIds: ["answer"] }, { questionId: "response", optionIds: ["response"], otherText: "..." }]. For escalation, use optionIds: ["escalate"] and put the concrete reason in otherText. Do not use selectedOptionIds, text, an object map, or an issue comment.';

export class PaperclipClientError extends Error {
  constructor(public readonly status: number | null, message: string) {
    super(message);
    this.name = "PaperclipClientError";
  }
}

/** Paperclip rejects helper creation after the per-parent safety cap. */
export function isPaperclipChildLimitError(error: unknown): boolean {
  return error instanceof PaperclipClientError && error.status === 422 &&
    /maximum\s+25\s+child\s+issues/i.test(error.message);
}

export interface PaperclipInteraction {
  id: string;
  status: string;
  kind?: string;
  result?: unknown;
  /** Preserve the typed interaction contract for protocol/state-machine validation. */
  payload?: unknown;
  addresseeAgentId?: string;
  target?: unknown;
  idempotencyKey?: string;
  sourceRunId?: string | null;
  /** Host creation timestamp required for dispatch-grace validation. */
  createdAt?: string;
  resolvedAt?: string | null;
  /** Native MCP verdict executor when Paperclip records local-board as resolver. */
  resolvedByRunId?: string | null;
  /** Direct native reviewer identity when Paperclip exposes it. */
  resolvedByAgentId?: string | null;
  /** Local-board principal used by Paperclip's native MCP bridge. */
  resolvedByUserId?: string | null;
}

/**
 * A response write is idempotent once Paperclip has made the interaction
 * terminal.  In particular, recovery can withdraw a visible audit card at
 * the same time that the reviewer-child run consumes its typed decision.
 * The child decision is still safe to relay to Jules, so the stale audit
 * mutation must converge instead of failing the provider heartbeat.
 */
function isTerminalInteractionStatus(status: string | undefined): boolean {
  switch (status) {
    case "answered":
    case "cancelled":
    case "expired":
      return true;
    case "pending":
    case undefined:
      return false;
    default:
      return false;
  }
}

export interface PlanRevision {
  documentId: string;
  revisionId: string;
  revisionNumber: number;
}

export interface PlanApprovalInteraction extends PaperclipInteraction {
  planRevision: PlanRevision;
}

export interface JulesPlanReviewerWakeInput {
  readonly reviewerAgentId: string;
  readonly childIssueId: string;
  readonly interactionId: string;
  readonly idempotencyKey: string;
  readonly authToken: string | undefined;
  readonly runId?: string;
}

/**
 * Starts one reviewer run with the exact native verdict card in Paperclip's
 * runtime context. Addressed cards deliberately use continuationPolicy=none:
 * the host's automatic issue wake omits this binding and fails with
 * continuation_source_context_missing on v2026.916.0.
 */
export async function wakeJulesPlanReviewer(input: JulesPlanReviewerWakeInput): Promise<{ readonly runId: string }> {
  const request = buildNativeInteractionWakeRequest({
    issueId: input.childIssueId,
    reviewerAgentId: input.reviewerAgentId,
    interactionId: input.interactionId,
    reason: "native_plan_review",
  });
  const response = await paperclipRequest(
    request.path,
    input.authToken,
    {
      method: "POST",
      headers: { "Idempotency-Key": input.idempotencyKey },
      body: JSON.stringify({ ...request.body, idempotencyKey: input.idempotencyKey }),
    },
    input.runId,
  );
  const raw: unknown = await response.json().catch(() => null);
  const runId = typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)["id"]
    : null;
  if (typeof runId !== "string" || !runId.trim()) {
    throw new PaperclipClientError(response.status, "Paperclip native plan-review wake did not return a reviewer run id");
  }
  return { runId: runId.trim() };
}

export async function saveJulesPlanDocument(
  issueId: string, activityId: string, planMarkdown: string,
  authToken: string | undefined, runId?: string,
): Promise<PlanRevision> {
  let baseRevisionId: string | null = null;
  try {
    const headResponse = await paperclipRequest(`/api/issues/${encodeURIComponent(issueId)}/documents/plan`, authToken, { method: "GET" }, runId);
    const head = await headResponse.json() as Record<string, unknown>;
    baseRevisionId = typeof head["latestRevisionId"] === "string" ? head["latestRevisionId"] : null;
  } catch (error) {
    if (!(error instanceof PaperclipClientError) || error.status !== 404) throw error;
  }
  const response = await paperclipRequest(`/api/issues/${encodeURIComponent(issueId)}/documents/plan`, authToken, {
    method: "PUT",
    body: JSON.stringify({ title: "Jules plan", format: "markdown", body: planMarkdown, changeSummary: `Generated by Jules activity ${activityId}`, baseRevisionId }),
  }, runId);
  const document = await response.json() as Record<string, unknown>;
  if (typeof document["id"] !== "string" || typeof document["latestRevisionId"] !== "string" || typeof document["latestRevisionNumber"] !== "number") {
    throw new PaperclipClientError(response.status, "Paperclip returned an invalid plan document revision");
  }
  return { documentId: document["id"] as string, revisionId: document["latestRevisionId"] as string, revisionNumber: document["latestRevisionNumber"] as number };
}

function paperclipApiBaseUrl(): string {
  return (process.env[PAPERCLIP_API_URL_ENV] ?? "http://127.0.0.1:3100").replace(/\/+$/, "");
}

function isLocalTrustedPaperclip(): boolean {
  try {
    const host = new URL(paperclipApiBaseUrl()).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

function requireAuthToken(authToken: string | undefined): string | undefined {
  const token = (typeof authToken === "string" && authToken.trim().length > 0)
    ? authToken.trim()
    : process.env["PAPERCLIP_AGENT_TOKEN"] || process.env["PAPERCLIP_API_KEY"];
  if (token) return token;

  // Paperclip's `local_trusted` deployment is loopback-only and intentionally
  // has no agent/API key. Built-in adapters run inside that trusted process,
  // so requiring a credential here made every durable Jules write fail even
  // though the board itself correctly accepts unauthenticated local requests.
  // Keep the fallback limited to loopback; authenticated/remote deployments
  // still fail closed rather than silently sending bearer-less requests.
  const base = paperclipApiBaseUrl();
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(base)) return undefined;
  throw new PaperclipClientError(null, "Paperclip local agent token is unavailable");
}

export async function getPaperclipJson<T>(
  path: string,
  authToken: string | undefined,
  runId?: string,
): Promise<T> {
  const response = await paperclipRequest(path, authToken, { method: "GET" }, runId);
  return (await response.json()) as T;
}

async function paperclipRequest(
  path: string,
  authToken: string | undefined,
  init: RequestInit,
  runId?: string,
): Promise<Response> {
  // Some Paperclip resume paths omit the field on the adapter context but
  // still export it to the process. Keep the attribution header at the last
  // boundary so every governed mutation remains auditable.
  const effectiveRunId = runId || process.env["PAPERCLIP_RUN_ID"] || process.env["PAPERCLIP_HEARTBEAT_RUN_ID"];
  const token = requireAuthToken(authToken);
  const method = (init.method ?? "GET").toUpperCase();
  const isMutation = method !== "GET" && method !== "HEAD";
  const body = typeof init.body === "string" ? init.body : "";
  const bodyKey = body.match(/\"idempotencyKey\"\s*:\s*\"([^\"]+)\"/)?.[1];
  const idempotencyKey = bodyKey ?? (isMutation
    ? `jules:paperclip:${createHash("sha256").update(`${method}:${path}:${body}`).digest("hex")}`
    : undefined);
  let lastNetworkError: unknown;
  const command = {
    key: idempotencyKey ?? `jules:paperclip:read:${method}:${path}`,
    issueId: path.match(/\/api\/issues\/([^/]+)/)?.[1] ?? "unknown",
    action: isMutation ? "comment" as const : "status" as const,
    payload: { method, path },
  };
  const result = await executePaperclipCommand(command, async (): Promise<PaperclipCommandResponse> => {
    try {
      const response = await fetch(`${paperclipApiBaseUrl()}${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(effectiveRunId ? { "X-Paperclip-Run-Id": effectiveRunId } : {}),
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
          ...init.headers,
        },
        signal: init.signal ?? AbortSignal.timeout(30_000),
      });
      return {
        ok: response.ok,
        status: response.status,
        data: response,
        ...(!response.ok && typeof response.text === "function"
          ? { text: await response.text().catch(() => "") }
          : {}),
      };
    } catch (error) {
      lastNetworkError = error;
      return { ok: false, status: 503, text: error instanceof Error ? error.message : String(error) };
    }
  });
  if (result.ok) return result.data as Response;
  if (lastNetworkError && result.status === 503) {
    throw new PaperclipClientError(null, `Paperclip API request failed: ${String(result.text ?? lastNetworkError)}`);
  }
  const suffix = result.text?.trim() ? ": " + result.text.trim().slice(0, 500) : "";
  throw new PaperclipClientError(result.status, "Paperclip API request failed (" + result.status + ")" + suffix);
}

// Used by durable ACP delegation helpers in this package. Keeping the request
// implementation here guarantees they use the same Paperclip auth and run attribution.
export const paperclipRequestForInternalUse = paperclipRequest;

async function moveIssue(
  issueId: string,
  status: "blocked" | "done" | "in_review" | "in_progress",
  authToken: string | undefined,
  comment?: string,
  runId?: string,
): Promise<void> {
  await paperclipRequest(`/api/issues/${encodeURIComponent(issueId)}`, authToken, {
    method: "PATCH",
    body: JSON.stringify({ status, ...(comment ? { comment } : {}) }),
  }, runId);
}

export async function listWorkProducts(
  issueId: string,
  authToken: string | undefined,
  runId?: string,
): Promise<Array<{ id?: string; type?: string; url?: string; status?: string; isPrimary?: boolean; summary?: string; metadata?: Record<string, unknown> }>> {
  const response = await paperclipRequest(
    `/api/issues/${encodeURIComponent(issueId)}/work-products`,
    authToken,
    { method: "GET" },
    runId,
  );
  const raw: unknown = await response.json();
  return Array.isArray(raw)
    ? raw
        .filter(
            (w): w is Record<string, unknown> =>
                typeof w === "object" && w !== null && typeof (w as Record<string, unknown>)["url"] === "string",
        )
        .map((w) => ({
          ...(typeof w["id"] === "string" ? { id: w["id"] } : {}),
          ...(typeof w["type"] === "string" ? { type: w["type"] } : {}),
          url: w["url"] as string,
          ...(typeof w["status"] === "string" ? { status: w["status"] } : {}),
          ...(typeof w["isPrimary"] === "boolean" ? { isPrimary: w["isPrimary"] } : {}),
          ...(typeof w["summary"] === "string" ? { summary: w["summary"] } : {}),
          ...(w["metadata"] && typeof w["metadata"] === "object" && !Array.isArray(w["metadata"])
            ? { metadata: w["metadata"] as Record<string, unknown> }
            : {}),
        }))
    : [];
}

export interface PullRequestWorkProductEvidence {
  readonly merged?: boolean;
  readonly headSha?: string;
  readonly headRefName?: string;
  readonly mergeableStatus?: "mergeable" | "conflicting" | "unknown";
  readonly ciStatus?: "success" | "pending" | "stalled" | "failed" | "unknown";
  readonly changedFiles: readonly string[];
}

function pullRequestEvidencePayload(evidence: PullRequestWorkProductEvidence | undefined): {
  readonly metadata: Record<string, unknown>;
  readonly summary?: string;
} {
  const base = { source: "jules", producer: "paperclip-jules-adapter", schemaVersion: 1 } as const;
  if (!evidence) return { metadata: base };

  const changedFiles = evidence.changedFiles.slice(0, 50);
  const metadata = {
    ...base,
    ...(evidence.headSha ? { headSha: evidence.headSha } : {}),
    ...(evidence.headRefName ? { headRefName: evidence.headRefName } : {}),
    ...(evidence.mergeableStatus ? { mergeableStatus: evidence.mergeableStatus } : {}),
    ...(evidence.ciStatus ? { ciStatus: evidence.ciStatus } : {}),
    changedFileCount: evidence.changedFiles.length,
    changedFiles,
    ...(evidence.changedFiles.length > changedFiles.length ? { changedFilesTruncated: true } : {}),
  };
  const sha = evidence.headSha ? ` at ${evidence.headSha.slice(0, 8)}` : "";
  const ci = evidence.ciStatus ? `; CI ${evidence.ciStatus}` : "";
  return { metadata, summary: `${evidence.changedFiles.length} changed files${sha}${ci}` };
}

/**
 * Idempotent by URL: a heartbeat retry after a timeout between the work-product
 * POST and the status PATCH would otherwise create duplicate primary PR cards.
 * (Issue #8)
 */
export async function upsertJulesSessionHandle(
  issueId: string,
  sessionId: string,
  sessionUrl: string | null | undefined,
  authToken: string | undefined,
  runId?: string,
  pr?: { readonly prUrl?: string | null; readonly headSha?: string | null; readonly headRefName?: string | null },
  delivery?: { readonly deliveredFeedbackActivityId?: string | null; readonly deliveredFeedbackInteractionId?: string | null },
  remediation?: {
    readonly originalSessionId?: string | null;
    readonly recoverySessionId?: string | null;
    readonly reason?: "ci_failure" | "terminal_plan_revision_unavailable" | null;
  },
): Promise<void> {
  let baseRevisionId: string | null = null;
  let existingHandle: JulesSessionHandle | null = null;
  try {
    const headResponse = await paperclipRequest(
      `/api/issues/${encodeURIComponent(issueId)}/documents/${JULES_SESSION_DOCUMENT_KEY}`,
      authToken,
      { method: "GET" },
      runId,
    );
    const head = await headResponse.json() as Record<string, unknown>;
    baseRevisionId = typeof head["latestRevisionId"] === "string" ? head["latestRevisionId"] : null;
    existingHandle = parseJulesSessionHandle(typeof head["body"] === "string" ? head["body"] : null);
  } catch (error) {
    if (!(error instanceof PaperclipClientError) || error.status !== 404) throw error;
  }

  const hasCompletePrIdentity = Boolean(pr?.prUrl && pr.headSha && pr.headRefName);
  const hasExistingCompletePrIdentity = Boolean(
    existingHandle?.prUrl && existingHandle.headSha && existingHandle.headRefName,
  );
  // `jules-session` is a current-provider pointer, while the PR fields bind
  // a durable handoff. A generic retry has no authority to erase that handoff
  // merely by becoming the newest session.
  const persistedPr = hasCompletePrIdentity
    ? pr
    : hasExistingCompletePrIdentity
      ? {
          prUrl: existingHandle!.prUrl!,
          headSha: existingHandle!.headSha!,
          headRefName: existingHandle!.headRefName!,
        }
      : pr;
  const persistedRemediation = remediation?.originalSessionId && remediation.recoverySessionId && remediation.reason
    ? remediation
    : existingHandle?.remediation;
  // A single branch-bound remediation owns its immutable PR branch.  A stale
  // retry may still reach this write after creating a provider session, but it
  // must not replace the durable recovery pointer; doing so loses the only
  // evidence that a retry was already consumed and permits duplicate work.
  const persistedSessionId = existingHandle?.remediation?.recoverySessionId &&
    existingHandle.remediation.recoverySessionId !== sessionId
    ? existingHandle.remediation.recoverySessionId
    : sessionId;
  const persistedSessionUrl = persistedSessionId === existingHandle?.sessionId
    ? existingHandle.sessionUrl ?? sessionUrl
    : sessionUrl;

  await paperclipRequest(
    `/api/issues/${encodeURIComponent(issueId)}/documents/${JULES_SESSION_DOCUMENT_KEY}`,
    authToken,
    {
      method: "PUT",
      body: JSON.stringify({
        title: "Jules session",
        format: "markdown",
        body: formatJulesSessionHandleBody(persistedSessionId, persistedSessionUrl, persistedPr, delivery, persistedRemediation),
        changeSummary: `Jules session ${persistedSessionId}`,
        baseRevisionId,
      }),
    },
    runId,
  );
}

export async function readJulesSessionHandle(
  issueId: string,
  authToken: string | undefined,
  runId?: string,
): Promise<string | null> {
  try {
    const response = await paperclipRequest(
      `/api/issues/${encodeURIComponent(issueId)}/documents/${JULES_SESSION_DOCUMENT_KEY}`,
      authToken,
      { method: "GET" },
      runId,
    );
    const document = await response.json() as Record<string, unknown>;
    const fromBody = extractJulesSessionId(typeof document["body"] === "string" ? document["body"] : null);
    if (fromBody) return fromBody;
  } catch (error) {
    if (!(error instanceof PaperclipClientError) || error.status !== 404) {
      /* fall through to comments */
    }
  }

  try {
    const comments = await listIssueComments(issueId, authToken, runId);
    return extractJulesSessionIdFromComments(comments);
  } catch {
    return null;
  }
}

/** Reads the full versioned recovery handle while retaining the legacy ID API. */
export async function readJulesSessionHandleState(
  issueId: string,
  authToken: string | undefined,
  runId?: string,
): Promise<JulesSessionHandle | null> {
  try {
    const response = await paperclipRequest(
      `/api/issues/${encodeURIComponent(issueId)}/documents/${JULES_SESSION_DOCUMENT_KEY}`,
      authToken,
      { method: "GET" },
      runId,
    );
    const document = await response.json() as Record<string, unknown>;
    return parseJulesSessionHandle(typeof document["body"] === "string" ? document["body"] : null);
  } catch (error) {
    if (!(error instanceof PaperclipClientError) || error.status !== 404) throw error;
    return null;
  }
}

/** Posts a standalone clickable Jules-session link as an issue comment. */
export async function postSessionLink(
  issueId: string,
  sessionUrl: string,
  authToken: string | undefined,
  runId?: string,
): Promise<void> {
  await paperclipRequest(`/api/issues/${encodeURIComponent(issueId)}/comments`, authToken, {
    method: "POST",
    body: JSON.stringify({ body: `[Open Jules session](${sessionUrl})` }),
  }, runId);
}

/** Host-requested status-only follow-up. Never treat this prose as a typed review verdict. */
export async function reportJulesStatusOnlyRun(
  issueId: string,
  authToken: string | undefined,
  runId: string,
): Promise<void> {
  if (!issueId.trim() || !runId.trim()) throw new Error("Status-only reporting requires exact issue and run attribution");
  await paperclipRequest(`/api/issues/${encodeURIComponent(issueId)}/comments`, authToken, {
    method: "POST",
    headers: { "Idempotency-Key": `jules:status-only:${runId}` },
    body: JSON.stringify({
      body: "Jules status-only host follow-up: the existing provider session remains under its durable monitor. No provider mutation, deliverable update, or native review verdict was attempted in this run.",
    }),
  }, runId);
}

export async function registerPullRequestWorkProduct(
  issueId: string,
  prUrl: string,
  authToken: string | undefined,
  runId?: string,
  evidence?: PullRequestWorkProductEvidence,
): Promise<void> {
  const existing = await listWorkProducts(issueId, authToken, runId);
  const normalizedPrUrl = prUrl.replace(/\/$/, "").toLowerCase();
  const matching = existing.find((workProduct) => workProduct.url?.replace(/\/$/, "").toLowerCase() === normalizedPrUrl);
  const payload = pullRequestEvidencePayload(evidence);
  if (matching?.id && (matching.isPrimary !== true || matching.metadata?.["producer"] !== payload.metadata["producer"] ||
      (evidence !== undefined && (matching.summary !== payload.summary ||
        (evidence.headSha !== undefined && matching.metadata?.["headSha"] !== evidence.headSha) ||
        (evidence.merged === true && matching.status !== "merged"))))) {
    await paperclipRequest(`/api/work-products/${encodeURIComponent(matching.id)}`, authToken, {
      method: "PATCH",
      body: JSON.stringify({ isPrimary: true, metadata: { ...matching.metadata, ...payload.metadata },
        ...(evidence !== undefined ? { summary: payload.summary } : {}),
        ...(evidence?.merged === true ? { status: "merged" } : {}) }),
    }, runId);
  } else if (!matching) {
    await paperclipRequest(`/api/issues/${encodeURIComponent(issueId)}/work-products`, authToken, {
      method: "POST",
      body: JSON.stringify({
        type: "pull_request",
        provider: "github",
        title: "Jules pull request",
        url: prUrl,
        externalId: prUrl,
        status: evidence?.merged === true ? "merged" : "ready_for_review",
        isPrimary: true,
        ...payload,
      }),
    }, runId);
  }
}

export async function moveIssueToReview(
  issueId: string,
  prUrl: string,
  authToken: string | undefined,
  runId?: string,
): Promise<void> {
  // The registered work product is the durable bridge from a terminal Jules
  // session to the orchestrator's native review pipeline. Swallowing this
  // write leaves a completed PR indistinguishable from fresh implementation
  // work and lets a stale Paperclip projection dispatch Jules again.
  await registerPullRequestWorkProduct(issueId, prUrl, authToken, runId);

  // Note: We do not perform an unbacked status PATCH to in_review here because
  // Paperclip requires an agent-authored transition to include a real typed
  // review owner. The orchestrator creates that native review path from the
  // registered work product.
}

export async function moveIssueToInProgress(
  issueId: string,
  authToken: string | undefined,
  comment?: string,
  runId?: string,
): Promise<void> {
  await moveIssue(issueId, "in_progress", authToken, comment, runId);
}

export async function moveIssueToBlocked(
  issueId: string,
  authToken: string | undefined,
  runId?: string,
): Promise<void> {
  await moveIssue(issueId, "blocked", authToken, undefined, runId);
}

export async function moveIssueToDone(
  issueId: string,
  sessionId: string,
  authToken: string | undefined,
  runId?: string,
  comment?: string,
): Promise<void> {
  await moveIssue(
    issueId,
    "done",
    authToken,
    comment ?? `Confirmed completion of Jules session ${sessionId}.`,
    runId,
  );
}

/** Requeue one protocol child after a terminal reviewer task omitted its JSON decision. */
export async function requeueInternalReviewIssue(
  issueId: string,
  authToken: string | undefined,
  runId?: string,
): Promise<void> {
  await paperclipRequest(`/api/issues/${encodeURIComponent(issueId)}`, authToken, {
    method: "PATCH",
    body: JSON.stringify({ status: "todo", blockParentUntilDone: false, executionPolicy: INTERNAL_REVIEW_EXECUTION_POLICY }),
  }, runId);
}

export function interactionFromResponse(raw: unknown, status: number): PaperclipInteraction {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new PaperclipClientError(status, "Paperclip returned an invalid interaction response");
  }
  const record = raw as Record<string, unknown>;
  const id = record["id"];
  const interactionStatus = record["status"];
  if (typeof id !== "string" || id.length === 0 || typeof interactionStatus !== "string") {
    throw new PaperclipClientError(status, "Paperclip returned an invalid interaction response");
  }
  return {
    id,
    status: interactionStatus,
    result: record["result"],
    payload: record["payload"],
    ...(typeof record["addresseeAgentId"] === "string" ? { addresseeAgentId: record["addresseeAgentId"] } : {}),
    target: (record["payload"] as Record<string, unknown> | undefined)?.["target"] ?? record["target"],
    ...(typeof record["kind"] === "string" ? { kind: record["kind"] } : {}),
    ...(typeof record["idempotencyKey"] === "string" ? { idempotencyKey: record["idempotencyKey"] } : {}),
    ...(typeof record["createdAt"] === "string" ? { createdAt: record["createdAt"] } : {}),
    ...(typeof record["resolvedByRunId"] === "string" ? { resolvedByRunId: record["resolvedByRunId"] } : {}),
    ...(typeof record["resolvedByAgentId"] === "string" ? { resolvedByAgentId: record["resolvedByAgentId"] } : {}),
    ...(typeof record["resolvedByUserId"] === "string" ? { resolvedByUserId: record["resolvedByUserId"] } : {}),
  };
}

export async function addJulesActivityComment(
  issueId: string,
  activityId: string,
  body: string,
  sessionUrl: string | undefined,
  authToken: string | undefined,
  runId?: string,
): Promise<void> {
  // Jules returns the full activity window on every poll. The activity ID is
  // the provider's immutable event identity; question text and timestamps are
  // not. Check the issue before writing so a restart or concurrent heartbeat
  // cannot mirror the same provider event repeatedly.
  const marker = `<!-- jules-activity:${activityId} -->`;
  const lockKey = `${issueId}:${activityId}`;
  const previous = activityCommentLocks.get(lockKey) ?? Promise.resolve();
  const operation = previous.then(async () => {
    const existing = await listIssueComments(issueId, authToken, runId).catch(() => []);
    if (existing.some((comment) => comment.body.includes(marker))) return;
    await paperclipRequest(`/api/issues/${encodeURIComponent(issueId)}/comments`, authToken, {
      method: "POST",
      headers: { "Idempotency-Key": `jules:activity-comment:${issueId}:${activityId}` },
      body: JSON.stringify({
        body: `${marker}\n${body}`,
        authorType: "agent",
      }),
    }, runId);
  });
  const lock = operation.then(() => undefined, () => undefined);
  activityCommentLocks.set(lockKey, lock);
  try {
    await operation;
  } finally {
    if (activityCommentLocks.get(lockKey) === lock) activityCommentLocks.delete(lockKey);
  }
}

const activityCommentLocks = new Map<string, Promise<void>>();

export async function createJulesFeedbackInteraction(
  issueId: string,
  sessionId: string,
  activityId: string,
  question: SafeCardPrompt | string,
  authToken: string | undefined,
  attempt = 1,
  runId?: string,
  summary?: SafeCardSummary | string,
): Promise<PaperclipInteraction> {
  const idempotencyKey = `jules:user-feedback:${issueId}:${sessionId}:${activityId}:${attempt}`;
  const { prompt: safePrompt, helpText: customHelpText } = formatCardPromptAndHelpText(typeof question === "string" ? question : String(question));
  const safeSummary = formatCardSummary(summary ?? question);
  try {
    const response = await paperclipRequest(
      `/api/issues/${encodeURIComponent(issueId)}/interactions`, authToken, {
        method: "POST",
        body: JSON.stringify({
          kind: "ask_user_questions",
          idempotencyKey,
          title: "Question from Jules",
          summary: safeSummary,
          continuationPolicy: "wake_assignee",
          payload: {
            version: 1,
            title: "Question from Jules",
            submitLabel: "Send to Jules",
            questions: [{
              id: "reply",
              prompt: safePrompt,
              helpText: customHelpText ? (customHelpText.slice(0, 930) + "\n\nType your answer or instructions for Jules below.") : "Type your answer or instructions for Jules below.",
              selectionMode: "single",
              required: true,
              allowOther: false,
              options: [{ id: "response", label: "Write a response", freeText: true }],
            }],
          },
        }),
      },
      runId,
    );
    return interactionFromResponse(await response.json(), response.status);
  } catch (error) {
    if (error instanceof PaperclipClientError && (error.status === 409 || error.status === 422 || error.status === 400)) {
      const existing = await listPaperclipInteractions(issueId, authToken, runId).catch(() => []);
      const match = existing.find((i) => i.idempotencyKey === idempotencyKey) ||
        existing.find((i) => i.kind === "ask_user_questions");
      if (match) return match;
    }
    throw error;
  }
}

/**
 * Creates the human-only follow-up for a strong reviewer's escalation.
 *
 * This deliberately retains the ordinary Jules feedback payload (`reply`) so
 * the established provider-relay state machine remains the sole consumer of
 * human answers.  The distinction is authorization, not a new workflow:
 * reviewer agents may answer their own child adjudication form, but they must
 * never be able to resolve the human escalation created from it.
 *
 * Paperclip currently exposes `human_only` as its narrowest native resolver
 * policy. It targets board humans (including the local board operator) rather
 * than a particular user ID; an adapter cannot reliably identify a board user.
 */
export async function createJulesHumanEscalationInteraction(
  issueId: string,
  sessionId: string,
  activityId: string,
  question: SafeCardPrompt | string,
  escalationReason: SafeCardSummary | string,
  authToken: string | undefined,
  runId?: string,
): Promise<PaperclipInteraction> {
  const idempotencyKey = `jules:human-escalation:${issueId}:${sessionId}:${activityId}`;
  const combinedPrompt = `${String(question)}\n\nReviewer escalation: ${String(escalationReason)}`;
  const { prompt: safePrompt, helpText: customHelpText } = formatCardPromptAndHelpText(combinedPrompt);
  try {
    const response = await paperclipRequest(
      `/api/issues/${encodeURIComponent(issueId)}/interactions`, authToken, {
        method: "POST",
        body: JSON.stringify({
          kind: "ask_user_questions",
          idempotencyKey,
          title: "Human decision needed for Jules",
          summary: "A strong reviewer could not safely answer Jules. A board human must decide.",
          continuationPolicy: "wake_assignee",
          resolverPolicy: "human_only",
          payload: {
            version: 1,
            title: "Human decision needed for Jules",
            submitLabel: "Send to Jules",
            questions: [{
              id: "reply",
              prompt: safePrompt,
              helpText: customHelpText
                ? (customHelpText.slice(0, 930) + "\n\nType your decision or instructions for Jules below.")
                : "Type your decision or instructions for Jules below.",
              selectionMode: "single",
              required: true,
              allowOther: false,
              options: [{ id: "response", label: "Write a response", freeText: true }],
            }],
          },
        }),
      },
      runId,
    );
    return interactionFromResponse(await response.json(), response.status);
  } catch (error) {
    if (error instanceof PaperclipClientError && (error.status === 409 || error.status === 422 || error.status === 400)) {
      // Do not recover an arbitrary ask-user form: an unrelated generic card
      // could otherwise be mistaken for this privileged escalation.
      const existing = await listPaperclipInteractions(issueId, authToken, runId).catch(() => []);
      const match = existing.find((interaction) => interaction.idempotencyKey === idempotencyKey);
      if (match) return match;
    }
    throw error;
  }
}

/**
 * Visible parent-thread record for a provider question handled by the strong
 * reviewer lane. It is intentionally not addressed to the reviewer: Jules
 * remains the parent assignee, while the executable reviewer form lives on a
 * Terra-owned child created by the adapters-only bridge.
 */
export async function createJulesAgentAdjudicationInteraction(
  issueId: string,
  sessionId: string,
  activityId: string,
  question: string,
  reviewerAgentId: string,
  authToken: string | undefined,
  runId?: string,
  generation = 0,
): Promise<PaperclipInteraction> {
  void reviewerAgentId;
  const idempotencyKey = `jules:agent-adjudication:${issueId}:${sessionId}:${activityId}` +
    (generation > 0 ? `:generation:${generation}` : "") + ":presentation:v2";
  const { prompt, helpText } = formatCardPromptAndHelpText(question);
  try {
    const response = await paperclipRequest(
      `/api/issues/${encodeURIComponent(issueId)}/interactions`, authToken, {
        method: "POST",
        body: JSON.stringify({
          kind: "ask_user_questions",
          idempotencyKey,
          title: "Question from Jules",
          summary: "An automated reviewer is handling this question. You can answer Jules directly here.",
          // The parent stays assigned to Jules. The reviewer wake target is
          // the Terra-owned child form created by the adapter below.
          continuationPolicy: "wake_assignee",
          resolverPolicy: "anyone",
          payload: {
            version: 1,
            title: "Question from Jules",
            submitLabel: "Send to Jules",
            questions: [{
              id: "reply",
              prompt,
              helpText: appendCardHelpText(helpText, "Type your answer or instructions for Jules below."),
              selectionMode: "single",
              required: true,
              allowOther: false,
              options: [{ id: "response", label: "Write a response", freeText: true }],
            }],
          },
        }),
      },
      runId,
    );
    return interactionFromResponse(await response.json(), response.status);
  } catch (error) {
    if (error instanceof PaperclipClientError && (error.status === 409 || error.status === 422 || error.status === 400)) {
      const existing = await listPaperclipInteractions(issueId, authToken, runId).catch(() => []);
      const match = existing.find((interaction) => interaction.idempotencyKey === idempotencyKey);
      if (match) return match;
    }
    throw error;
  }
}

/**
 * Creates the executable reviewer form on the reviewer-owned child issue.
 *
 * Paperclip wakes an addressed agent only when that agent owns the issue being
 * mutated.  The Jules issue must remain assigned to Jules, so its visible
 * audit card cannot also be the Terra wake target.  This child form is the
 * adapters-only compatibility bridge until Paperclip exposes a first-class
 * cross-assignee interaction target.
 */
export async function createJulesQuestionReviewInteraction(
  childIssueId: string,
  parentIssueId: string,
  sessionId: string,
  activityId: string,
  question: string,
  reviewerAgentId: string,
  authToken: string | undefined,
  runId?: string,
): Promise<PaperclipInteraction> {
  // Paperclip enforces interaction idempotency across more than one issue in
  // some deployments. Include the protocol child identity so a terminal
  // child from an earlier recovery generation cannot reject the new child's
  // otherwise-correct form with a cross-issue 409.
  const idempotencyKey = `jules:question-review:${childIssueId}:${parentIssueId}:${sessionId}:${activityId}`;
  const { prompt, helpText } = formatCardPromptAndHelpText(question);
  try {
    const response = await paperclipRequest(
      `/api/issues/${encodeURIComponent(childIssueId)}/interactions`, authToken, {
        method: "POST",
        body: JSON.stringify({
          kind: "ask_user_questions",
          idempotencyKey,
          title: "Adjudicate Jules question",
          summary: "A strong reviewer must choose an answer or escalation for Jules.",
          addresseeAgentId: reviewerAgentId,
          continuationPolicy: "wake_assignee",
          resolverPolicy: "anyone",
          payload: {
            version: 1,
            title: "Adjudicate Jules question",
            submitLabel: "Submit reviewer decision",
            questions: [{
              id: "resolution",
              prompt: "Choose how to handle Jules' question.",
              helpText: "Answer only when the task context makes the response clear. Escalate concrete ambiguity to a human.",
              selectionMode: "single",
              required: true,
              allowOther: false,
              options: [
                { id: "answer", label: "Answer Jules" },
                { id: "escalate", label: "Escalate to human" },
              ],
            }, {
              id: "response",
              prompt,
              helpText: appendCardHelpText(helpText, JULES_REVIEWER_RESPONSE_HELP),
              selectionMode: "single",
              required: true,
              allowOther: false,
              options: [{ id: "response", label: "Reviewer response", freeText: true }],
            }],
          },
        }),
      },
      runId,
    );
    return interactionFromResponse(await response.json(), response.status);
  } catch (error) {
    if (error instanceof PaperclipClientError && (error.status === 409 || error.status === 422 || error.status === 400)) {
      const existing = await listPaperclipInteractions(childIssueId, authToken, runId).catch(() => []);
      const match = existing.find((interaction) => interaction.idempotencyKey === idempotencyKey);
      if (match) return match;
    }
    throw error;
  }
}

/** Record the strong reviewer's answer in the visible provider-question card. */
export async function answerJulesAgentAdjudicationInteraction(
  issueId: string,
  interactionId: string,
  answer: string,
  authToken: string | undefined,
  runId?: string,
): Promise<void> {
  return resolveJulesAgentAdjudicationInteraction(issueId, interactionId, "answer", answer, authToken, runId);
}

/** Resolves the visible parent question card with the same typed decision used by the child form. */
export async function resolveJulesAgentAdjudicationInteraction(
  issueId: string,
  interactionId: string,
  resolution: "answer" | "escalate",
  responseText: string,
  authToken: string | undefined,
  runId?: string,
): Promise<void> {
  try {
    await paperclipRequest(
      `/api/issues/${encodeURIComponent(issueId)}/interactions/${encodeURIComponent(interactionId)}/respond`,
      authToken,
      {
        method: "POST",
        body: JSON.stringify({
          answers: [
            { questionId: "resolution", optionIds: [resolution] },
            { questionId: "response", optionIds: ["response"], otherText: responseText },
          ],
          summaryMarkdown: resolution === "answer"
            ? "Resolved by the configured strong reviewer and relayed to Jules."
            : "Escalated by the configured strong reviewer for human clarification.",
        }),
      },
      runId,
    );
  } catch (error) {
    // Older parent cards were accidentally addressed to Terra. The child
    // form is the reviewer protocol, but Jules still has to close the parent
    // audit card after consuming Terra's answer. In local-trusted Paperclip,
    // retry once as the board actor; never discard a real adapter credential
    // or weaken authorization on authenticated deployments.
    if (error instanceof PaperclipClientError && error.status === 403 &&
        /interaction_addressee_mismatch/.test(error.message) && isLocalTrustedPaperclip()) {
      await paperclipRequest(
        `/api/issues/${encodeURIComponent(issueId)}/interactions/${encodeURIComponent(interactionId)}/respond`,
        undefined,
        {
          method: "POST",
          body: JSON.stringify({
            answers: [
              { questionId: "resolution", optionIds: [resolution] },
              { questionId: "response", optionIds: ["response"], otherText: responseText },
            ],
            summaryMarkdown: resolution === "answer"
              ? "Resolved by the configured strong reviewer and relayed to Jules."
              : "Escalated by the configured strong reviewer for human clarification.",
          }),
        },
      );
      return;
    }
    // Two Paperclip heartbeats may observe the same adjudication at once. If
    // the first one answered it, the second receives 409 rather than an
    // idempotent success. Re-fetch the authoritative interaction and treat an
    // already-answered card as success; every other 409 remains visible.
    if (error instanceof PaperclipClientError && error.status === 409) {
      const current = await getPaperclipInteraction(issueId, interactionId, authToken, runId).catch(() => null);
      if (isTerminalInteractionStatus(current?.status)) return;
    }
    throw error;
  }
}

export async function createJulesPlanApprovalInteraction(
  issueId: string,
  sessionId: string,
  activityId: string,
  planMarkdown: string,
  authToken: string | undefined,
  runId?: string,
): Promise<PlanApprovalInteraction> {
  const revision = await saveJulesPlanDocument(issueId, activityId, planMarkdown, authToken, runId);
  const { documentId, revisionId, revisionNumber } = revision;

  const response = await paperclipRequest(
    `/api/issues/${encodeURIComponent(issueId)}/interactions`, authToken, {
      method: "POST",
      body: JSON.stringify({
        kind: "request_confirmation",
        idempotencyKey: `confirmation:${issueId}:plan:${revisionId}`,
        title: "Approve Jules plan",
        summary: "Jules is waiting for plan approval.",
        continuationPolicy: "wake_assignee",
        payload: {
          version: 1,
          prompt: "Approve this Jules plan?",
          acceptLabel: "Approve plan",
          rejectLabel: "Request changes",
          rejectRequiresReason: true,
          rejectReasonLabel: "Requested changes",
          supersedeOnUserComment: true,
          target: {
            type: "issue_document",
            issueId,
            documentId,
            key: "plan",
            revisionId,
            revisionNumber,
            label: `Jules plan revision ${revisionNumber}`,
          },
        },
      }),
    },
    runId,
  );
  return {
    ...interactionFromResponse(await response.json(), response.status),
    planRevision: { documentId, revisionId, revisionNumber },
  };
}

export interface NativePlanReviewStageInput {
  readonly issueId: string;
  readonly revisionId: string;
  readonly stage: "luna" | "terra";
  readonly reviewerAgentId: string;
  readonly ownerAgentId: string;
  readonly reviewRequest?: string;
  readonly authToken: string | undefined;
  readonly runId?: string;
}

export async function observeJulesChildPlanReview(
  identity: ChildPlanReviewIdentity, childId: string | undefined, authToken: string | undefined, runId: string,
): Promise<ChildPlanReviewObservation> {
  if (!authToken || !runId) throw new PaperclipClientError(null, "Child review requires authenticated Jules run credentials");
  const send = async (path: string, method: string, body?: unknown): Promise<unknown> => {
    const response = await paperclipRequest(`/api${path}`, authToken, { method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, runId);
    return response.json();
  };
  return reconcileChildPlanReview({ identity, ...(childId ? { childId } : {}),
    api: { get: (path) => send(path, "GET"), post: (path, body) => send(path, "POST", body), patch: (path, body) => send(path, "PATCH", body) } });
}

/** Bootstrap a v4 plan card from Jules's own issue-scoped child run. */
export async function bootstrapJulesChildPlanReview(input: {
  readonly identity: ChildPlanReviewIdentity; readonly childId: string;
  readonly agentId: string; readonly runId: string; readonly authToken: string;
}): Promise<{ readonly childId: string; readonly cardId: string } |
  { readonly kind: "reviewer_unavailable"; readonly childId: string; readonly reviewerId: string }> {
  if (input.identity.version !== 4 || input.identity.bootstrapAgentId !== input.agentId ||
      input.identity.julesAgentId !== input.agentId) throw new Error("Jules child bootstrap requires a v4 self-owned identity");
  const request = async (path: string, method: string, body?: unknown): Promise<unknown> => {
    const response = await paperclipRequest(`/api${path}`, input.authToken, {
      method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, input.runId);
    return response.json();
  };
  return bootstrapChildPlanReview({ identity: input.identity, childId: input.childId,
    agentId: input.agentId, runId: input.runId,
    api: { get: (path) => request(path, "GET"), post: (path, body) => request(path, "POST", body),
      patch: (path, body) => request(path, "PATCH", body) } });
}

/** Question protocol writes keep the caller's native run attribution and never borrow board credentials. */
export function questionReviewApi(authToken: string | undefined, runId: string): ChildReviewApi {
  if (!authToken || !runId) throw new Error("Question review requires authenticated native run credentials");
  const request = async (path: string, method: string, body?: unknown): Promise<unknown> => {
    const response = await paperclipRequest(`/api${path}`, authToken, { method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, runId);
    return response.json();
  };
  return { get: path => request(path, "GET"), post: (path, body) => request(path, "POST", body), patch: (path, body) => request(path, "PATCH", body) };
}

export interface NativePlanReviewStage {
  readonly stageId: string;
  readonly reviewerAgentId: string;
  readonly ownerAgentId: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isExactNativePlanReviewStage(
  issue: PaperclipIssue,
  expected: { readonly issueId: string; readonly stageId: string; readonly reviewerAgentId: string; readonly ownerAgentId: string },
): boolean {
  if (issue.id !== expected.issueId || issue.status !== "in_review" || issue.assigneeAgentId !== expected.reviewerAgentId) return false;
  const policy = asRecord(issue.executionPolicy);
  const stages = policy && Array.isArray(policy["stages"]) ? policy["stages"] : [];
  if (policy?.["monitor"] || stages.length !== 1) return false;
  const stage = asRecord(stages[0]);
  const participants = stage && Array.isArray(stage["participants"]) ? stage["participants"] : [];
  const state = asRecord(issue.executionState);
  return !!stage && stage["id"] === expected.stageId && stage["type"] === "review" &&
    participants.length === 1 && asRecord(participants[0])?.["agentId"] === expected.reviewerAgentId &&
    state?.["status"] === "pending" && state["currentStageId"] === expected.stageId &&
    state["currentStageType"] === "review" &&
    asRecord(state["currentParticipant"])?.["agentId"] === expected.reviewerAgentId &&
    asRecord(state["returnAssignee"])?.["agentId"] === expected.ownerAgentId;
}

function isIdleJulesMonitorAuditState(value: Record<string, unknown> | null): boolean {
  if (!value || value["status"] !== "idle" || value["currentStageId"] != null ||
      value["currentParticipant"] != null || value["returnAssignee"] != null || value["reviewRequest"] != null) {
    return false;
  }
  const monitor = asRecord(value["monitor"]);
  return monitor?.["status"] === "triggered" && monitor["serviceName"] === "jules" &&
    monitor["externalRef"] === "[redacted]";
}

/**
 * Moves a Jules-owned issue into one native review stage before its verdict
 * card exists. Paperclip assigns and wakes the reviewer through its own
 * execution-policy transition; Jules must not wake another agent directly.
 * A repeated call after a lost response reuses the exact persisted stage.
 */
export async function enterNativePlanReviewStage(input: NativePlanReviewStageInput): Promise<NativePlanReviewStage> {
  const issueId = asText(input.issueId);
  const revisionId = asText(input.revisionId);
  const reviewerAgentId = asText(input.reviewerAgentId);
  const ownerAgentId = asText(input.ownerAgentId);
  if (!issueId || !revisionId || (input.stage !== "luna" && input.stage !== "terra") ||
      !reviewerAgentId || !ownerAgentId || reviewerAgentId === ownerAgentId) {
    throw new PaperclipClientError(null, "Native plan-review stage identity is invalid");
  }
  const stageId = nativePlanReviewStageId(issueId, revisionId, input.stage);
  const expected = { issueId, stageId, reviewerAgentId, ownerAgentId };
  const issue = await getPaperclipIssue(issueId, input.authToken, input.runId);
  if (isExactNativePlanReviewStage(issue, expected)) return { stageId, reviewerAgentId, ownerAgentId };
  const policy = asRecord(issue.executionPolicy);
  const stages = policy && Array.isArray(policy["stages"]) ? policy["stages"] : [];
  if (issue.status !== "todo" && issue.status !== "in_progress") {
    throw new PaperclipClientError(null, `Native plan review cannot start from issue status ${issue.status}`);
  }
  if (issue.assigneeAgentId !== ownerAgentId || policy?.["monitor"] || stages.length > 0 ||
      (issue.executionState && !isIdleJulesMonitorAuditState(asRecord(issue.executionState)))) {
    throw new PaperclipClientError(null, "Native plan review cannot overwrite an existing issue workflow");
  }
  const reviewRequest = asText(input.reviewRequest);
  const response = await paperclipRequest(`/api/issues/${encodeURIComponent(issueId)}`, input.authToken, {
    method: "PATCH",
    body: JSON.stringify({
      status: "in_review",
      executionPolicy: {
        mode: "normal",
        stages: [{ id: stageId, type: "review", participants: [{ type: "agent", agentId: reviewerAgentId }] }],
      },
      ...(reviewRequest ? { reviewRequest: { instructions: reviewRequest } } : {}),
    }),
  }, input.runId);
  const updated = await response.json() as PaperclipIssue;
  if (!isExactNativePlanReviewStage(updated, expected)) {
    throw new PaperclipClientError(response.status, "Paperclip did not enter the exact native review stage");
  }
  return { stageId, reviewerAgentId, ownerAgentId };
}

/**
 * Creates the only supported automated plan-review primitive. The reviewer
 * responds through Paperclip's typed verdict endpoint; comments and child
 * issue prose are deliberately outside this protocol.
 */
export async function createJulesPlanReviewInteraction(
  issueId: string,
  sessionId: string,
  revision: PlanRevision,
  planMarkdown: string,
  stage: "luna" | "terra",
  reviewerAgentId: string,
  authToken: string | undefined,
  runId?: string,
  providerActivityId?: string,
  generation: 0 | 1 = 0,
): Promise<PlanApprovalInteraction> {
  const idempotencyKey = planReviewIdempotencyKey({
    issueId,
    sessionId,
    documentId: revision.documentId,
    revisionId: revision.revisionId,
    revisionNumber: revision.revisionNumber,
    stage,
    reviewerAgentId,
    generation,
  }, "v2");
  const stageName = stage === "luna" ? "Luna" : "Terra";
  const requestBody = {
    kind: "request_item_verdicts",
    idempotencyKey,
    title: `Review Jules plan (${stageName})`,
    summary: `Review Jules plan revision ${revision.revisionNumber}.`,
    addresseeAgentId: reviewerAgentId,
    continuationPolicy: "none",
    resolverPolicy: "anyone",
    payload: {
      version: 1,
      prompt: formatCardPrompt(
        `Review the attached Jules plan as ${stageName}. Choose All good only when it is ready to implement; choose Needs work only with a concrete reason.`,
        MAX_CONFIRMATION_PROMPT_LENGTH,
      ),
      detailsMarkdown: formatConfirmationDetails(planMarkdown, revision.revisionNumber),
      items: [{ id: "plan", label: "Plan", description: `Plan revision ${revision.revisionNumber}` }],
      verdicts: ["approve", "reject"],
      requireReasonOn: ["reject"],
      reasonLabel: "What must change?",
      allowBulkApprove: true,
      supersedeOnUserComment: false,
      // Bind a verdict to the exact provider plan generation. Recovery may
      // observe several plans in one Jules session and must never replay an
      // older answer against the current plan.
      ...(providerActivityId ? { providerActivityId } : {}),
      target: {
        type: "issue_document",
        issueId,
        documentId: revision.documentId,
        key: "plan",
        revisionId: revision.revisionId,
        revisionNumber: revision.revisionNumber,
      },
    },
  };
  try {
    const response = await paperclipRequest(
      `/api/issues/${encodeURIComponent(issueId)}/interactions`, authToken,
      { method: "POST", body: JSON.stringify(requestBody) }, runId,
    );
    return { ...interactionFromResponse(await response.json(), response.status), planRevision: revision };
  } catch (error) {
    if (error instanceof PaperclipClientError && (error.status === 409 || error.status === 422 || error.status === 400)) {
      const existing = await listPaperclipInteractions(issueId, authToken, runId).catch(() => []);
      const match = existing.find((interaction) => interaction.idempotencyKey === requestBody.idempotencyKey);
      if (match) return { ...match, planRevision: revision };
    }
    throw error;
  }
}

/**
 * Legacy writer retained while persisted pre-v2026.916.0 sessions migrate.
 * New plan-review cards must use createJulesPlanReviewInteraction so the card
 * and its source Jules run share one issue-scoped continuation provenance.
 */
export async function createJulesPlanReviewChildInteraction(
  childIssueId: string,
  parentIssueId: string,
  sessionId: string,
  revision: PlanRevision,
  planMarkdown: string,
  stage: "luna" | "terra",
  reviewerAgentId: string,
  authToken: string | undefined,
  runId?: string,
  providerActivityId?: string,
): Promise<PlanApprovalInteraction> {
  const idempotencyKey = planReviewIdempotencyKey({
    issueId: parentIssueId, sessionId, documentId: revision.documentId,
    revisionId: revision.revisionId, revisionNumber: revision.revisionNumber,
    stage, reviewerAgentId,
  }, "v2");
  const stageName = stage === "luna" ? "Luna" : "Terra";
  const requestBody = {
    kind: "request_item_verdicts",
    idempotencyKey,
    title: `Review Jules plan (${stageName})`,
    summary: `Review Jules plan revision ${revision.revisionNumber}.`,
    addresseeAgentId: reviewerAgentId,
    continuationPolicy: "none",
    resolverPolicy: "anyone",
    payload: {
      version: 1,
      prompt: formatCardPrompt(`Review the attached Jules plan as ${stageName}. Choose All good only when it is ready to implement; choose Needs work only with a concrete reason.`, MAX_CONFIRMATION_PROMPT_LENGTH),
      detailsMarkdown: formatConfirmationDetails(planMarkdown, revision.revisionNumber),
      items: [{ id: "plan", label: "Plan", description: `Plan revision ${revision.revisionNumber}` }],
      verdicts: ["approve", "reject"], requireReasonOn: ["reject"], reasonLabel: "What must change?",
      allowBulkApprove: true, supersedeOnUserComment: false,
      // The card must carry the immutable provider activity it reviews. A
      // session may contain multiple plans; recovery must never replay a
      // verdict for an older plan against a later replacement.
      ...(providerActivityId ? { providerActivityId } : {}),
      target: { type: "issue_document", issueId: parentIssueId, documentId: revision.documentId, key: "plan", revisionId: revision.revisionId, revisionNumber: revision.revisionNumber },
    },
  };
  try {
    const response = await paperclipRequest(`/api/issues/${encodeURIComponent(childIssueId)}/interactions`, authToken, { method: "POST", body: JSON.stringify(requestBody) }, runId);
    return { ...interactionFromResponse(await response.json(), response.status), planRevision: revision };
  } catch (error) {
    if (error instanceof PaperclipClientError && (error.status === 409 || error.status === 422 || error.status === 400)) {
      const existing = await listPaperclipInteractions(childIssueId, authToken, runId).catch(() => []);
      const match = existing.find((interaction) => interaction.idempotencyKey === idempotencyKey);
      if (match) return { ...match, planRevision: revision };
    }
    throw error;
  }
}

export async function withdrawPaperclipInteraction(
  issueId: string,
  interactionId: string,
  reason: string,
  authToken: string | undefined,
  runId?: string,
): Promise<void> {
  try {
    await paperclipRequest(
      `/api/issues/${encodeURIComponent(issueId)}/interactions/${encodeURIComponent(interactionId)}/withdraw`,
      authToken,
      {
        method: "POST",
        body: JSON.stringify({ reason }),
      },
      runId,
    );
  } catch (error) {
    if (!(error instanceof PaperclipClientError) || error.status !== 409) throw error;

    // Paperclip correctly rejects a second terminal transition. A recovery
    // heartbeat can race an earlier withdrawal, though, and treating that
    // expected conflict as fatal previously prevented unrelated, already
    // validated provider feedback from reaching Jules. Confirm the terminal
    // state rather than broadly swallowing 409: a still-pending card remains
    // a real failure and must not be replaced or silently ignored.
    const interaction = (await listPaperclipInteractions(issueId, authToken, runId))
      .find((candidate) => candidate.id === interactionId);
    if (interaction && interaction.status !== "pending") return;
    throw error;
  }
}

export async function listPaperclipApprovals(
  companyId: string,
  authToken: string | undefined,
  runId?: string,
): Promise<Array<{ id: string; type: string; status: string; issueIds: string[]; payload?: Record<string, unknown> }>> {
  const raw = await getPaperclipJson<unknown>(
    `/api/companies/${encodeURIComponent(companyId)}/approvals`,
    authToken,
    runId,
  );
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { approvals?: unknown }).approvals)
      ? (raw as { approvals: unknown[] }).approvals
      : [];
  return list
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      id: String(item["id"] || ""),
      type: String(item["type"] || ""),
      status: String(item["status"] || ""),
      issueIds: Array.isArray(item["issueIds"]) ? item["issueIds"].map(String) : [],
      ...(item["payload"] && typeof item["payload"] === "object"
        ? { payload: item["payload"] as Record<string, unknown> }
        : {}),
    }));
}

export async function listPaperclipInteractions(
  issueId: string,
  authToken: string | undefined,
  runId?: string,
  timeoutMs?: number,
): Promise<PaperclipInteraction[]> {
  const response = await paperclipRequest(`/api/issues/${encodeURIComponent(issueId)}/interactions`, authToken, {
    method: "GET",
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  }, runId);
  const raw: unknown = await response.json();
  if (!Array.isArray(raw)) return [];
  return raw.map((value) => interactionFromResponse(value, response.status));
}

export async function getPaperclipInteraction(
  issueId: string,
  interactionId: string,
  authToken: string | undefined,
  runId?: string,
): Promise<PaperclipInteraction | null> {
  const response = await paperclipRequest(`/api/issues/${encodeURIComponent(issueId)}/interactions`, authToken, {
    method: "GET",
  }, runId);
  const raw: unknown = await response.json();
  if (!Array.isArray(raw)) throw new PaperclipClientError(response.status, "Paperclip returned an invalid interactions response");
  const match = raw.find((value) => typeof value === "object" && value !== null && (value as Record<string, unknown>)["id"] === interactionId);
  return match ? interactionFromResponse(match, response.status) : null;
}

export async function createNoPrCompletionInteraction(
  issueId: string,
  sessionId: string,
  sessionUrl: string | undefined,
  authToken: string | undefined,
  runId?: string,
  cancelledCardId?: string,
): Promise<PaperclipInteraction> {
  if (cancelledCardId && !/^[A-Za-z0-9-]{1,128}$/.test(cancelledCardId)) {
    throw new Error("Cannot reissue a no-PR confirmation without a valid cancelled card identity");
  }
  const details = [
    `Jules session: \`${sessionId}\``,
    sessionUrl ? `[Open the Jules session](${sessionUrl})` : null,
    "Accept to mark this task done. Reject to keep it blocked for manual follow-up.",
  ].filter((value): value is string => value !== null).join("\n\n");
  const response = await paperclipRequest(
    `/api/issues/${encodeURIComponent(issueId)}/interactions`,
    authToken,
    {
      method: "POST",
      body: JSON.stringify({
        kind: "request_confirmation",
        idempotencyKey: `jules:no-pr-completion:${issueId}:${sessionId}` +
          (cancelledCardId ? `:reissue:${cancelledCardId}` : ""),
        title: "Confirm Jules completion without a PR",
        summary: `Jules session ${sessionId} completed without creating a pull request.`,
        continuationPolicy: "wake_assignee",
        payload: {
          version: 1,
          prompt: "Jules completed without a PR. Is this task complete?",
          acceptLabel: "Mark done",
          rejectLabel: "Keep blocked",
          rejectRequiresReason: false,
          detailsMarkdown: details,
        },
      }),
    },
    runId,
  );
  return interactionFromResponse(await response.json(), response.status);
}

export async function createIssueComment(
  issueId: string,
  body: string,
  authToken: string | undefined,
  runId?: string,
): Promise<void> {
  await paperclipRequest(
    `/api/issues/${encodeURIComponent(issueId)}/comments`,
    authToken,
    {
      method: "POST",
      body: JSON.stringify({ body }),
    },
    runId,
  );
}

export interface IssueComment {
  id: string;
  body: string;
  authorUserId?: string | null;
  authorAgentId?: string | null;
  createdAt: string;
}

export interface PaperclipIssue {
  id: string;
  companyId?: string;
  executionBlocker?: unknown;
  description?: string | null;
  identifier?: string | null;
  status: string;
  assigneeAgentId?: string | null;
  executionPolicy?: Record<string, unknown> | null;
  executionState?: Record<string, unknown> | null;
}

/**
 * Explicitly empty policy for adapter-owned reviewer children. `null` is not
 * equivalent here: Paperclip interprets null as permission to inherit/apply
 * the default review policy when the child is assigned.
 */
export const INTERNAL_REVIEW_EXECUTION_POLICY = {
  mode: "normal",
  stages: [],
  commentRequired: false,
} as const;

function executionPolicyWithJulesMonitor(
  executionPolicy: Record<string, unknown> | null | undefined,
  input: { sessionId: string; nextCheckAt: string; timeoutAt: string },
): Record<string, unknown> {
  // The Jules adapter owns provider continuation. Native Paperclip review
  // stages on the same issue can block a legitimate Jules poll or emit a
  // generic missing-disposition prompt, so retain only non-review metadata
  // while the remote session is active. The orchestrator owns final PR review.
  const { stages: _stages, commentRequired: _commentRequired, ...nonReviewPolicy } = executionPolicy ?? {};
  return {
    mode: nonReviewPolicy["mode"] ?? "normal",
    ...nonReviewPolicy,
    stages: [],
    commentRequired: false,
    monitor: {
      nextCheckAt: input.nextCheckAt,
      notes: "Jules cloud session is active; Paperclip will poll it when this monitor is due.",
      scheduledBy: "assignee",
      kind: "external_service",
      serviceName: "jules",
      externalRef: input.sessionId,
      timeoutAt: input.timeoutAt,
      recoveryPolicy: "wake_owner",
    },
  };
}

/**
 * Reuse a future monitor for this exact provider session.  A Paperclip issue
 * update can wake Jules between scheduled checks (for example when a review
 * decision is recorded). Replacing the monitor in that path delays polling
 * and leaves the old due callback able to race and clear the replacement.
 */
function hasReusableJulesMonitor(
  issue: PaperclipIssue,
  sessionId: string,
  nowMs = Date.now(),
  requestedNextCheckAt?: string,
): boolean {
  const monitor = issue.executionPolicy?.["monitor"];
  if (!monitor || typeof monitor !== "object" || Array.isArray(monitor)) return false;
  const record = monitor as Record<string, unknown>;
  if (record["serviceName"] !== "jules") return false;
  const externalRef = record["externalRef"];
  if (typeof externalRef === "string" && externalRef !== "[redacted]" && externalRef !== sessionId) return false;
  if (typeof record["nextCheckAt"] !== "string") return false;
  const nextCheckAtMs = Date.parse(record["nextCheckAt"]);
  if (!Number.isFinite(nextCheckAtMs) || nextCheckAtMs <= nowMs) return false;
  if (requestedNextCheckAt) {
    const requestedMs = Date.parse(requestedNextCheckAt);
    if (!Number.isFinite(requestedMs) || nextCheckAtMs > requestedMs + 5_000) return false;
  }
  return true;
}

/**
 * Checks whether Paperclip already owns a future poll for this active provider
 * session. Event-driven wakes are advisory; callers use this before touching
 * Jules so a stale review/status ping cannot defeat the configured cadence.
 */
export async function hasFutureJulesSessionMonitor(
  issueId: string,
  sessionId: string,
  authToken: string | undefined,
  runId?: string,
): Promise<boolean> {
  const issue = await getPaperclipIssue(issueId, authToken, runId);
  return hasReusableJulesMonitor(issue, sessionId);
}

export interface JulesMonitorScheduleExpectation {
  readonly sessionId: string;
  readonly nextCheckAt: string;
}

/**
 * Paperclip can accept a monitor PATCH while returning a normalized issue
 * projection. Treat that response as the write receipt: a 2xx without the
 * expected monitor is not a successful continuation and must be retried.
 */
export function assertJulesMonitorScheduled(
  issue: unknown,
  expectation: JulesMonitorScheduleExpectation,
): void {
  if (!issue || typeof issue !== "object" || Array.isArray(issue)) {
    throw new PaperclipClientError(200, "Paperclip returned no issue while scheduling a verified Jules monitor");
  }
  const policy = (issue as Record<string, unknown>)["executionPolicy"];
  const monitor = policy && typeof policy === "object" && !Array.isArray(policy)
    ? (policy as Record<string, unknown>)["monitor"]
    : undefined;
  if (!monitor || typeof monitor !== "object" || Array.isArray(monitor)) {
    throw new PaperclipClientError(200, "Paperclip returned no verified Jules monitor");
  }
  const record = monitor as Record<string, unknown>;
  const externalRef = record["externalRef"];
  // Paperclip intentionally redacts provider handles in issue projections.
  // The monitor identity is still verified by serviceName + nextCheckAt;
  // preserve strict rejection for a non-redacted, wrong provider handle.
  const externalRefIsRedacted = externalRef === "[redacted]";
  if (record["serviceName"] !== "jules" ||
      (typeof externalRef === "string" && !externalRefIsRedacted && externalRef !== expectation.sessionId) ||
      typeof record["nextCheckAt"] !== "string" ||
      record["nextCheckAt"].trim().length === 0) {
    throw new PaperclipClientError(200, "Paperclip returned an invalid verified Jules monitor");
  }
  const observedDeadline = Date.parse(record["nextCheckAt"] as string);
  const requestedDeadline = Date.parse(expectation.nextCheckAt);
  if (!Number.isFinite(observedDeadline) || !Number.isFinite(requestedDeadline) || observedDeadline > requestedDeadline + 5_000) {
    throw new PaperclipClientError(200, "Paperclip monitor deadline remained later than requested");
  }
}

/**
 * Persists Paperclip's native durable continuation for a live Jules session.
 * The monitor scheduler atomically claims the due check and wakes this issue's
 * assignee, so no adapter-private timer or orchestrator poll is required.
 */
export async function scheduleJulesSessionMonitor(
  issueId: string,
  sessionId: string,
  nextCheckAt: string,
  timeoutAt: string,
  authToken: string | undefined,
  runId?: string,
): Promise<void> {
  const issue = await getPaperclipIssue(issueId, authToken, runId);
  if (hasReusableJulesMonitor(issue, sessionId, Date.now(), nextCheckAt)) return;
  const response = await paperclipRequest(`/api/issues/${encodeURIComponent(issueId)}`, authToken, {
    method: "PATCH",
    body: JSON.stringify({
      executionPolicy: executionPolicyWithJulesMonitor(issue.executionPolicy, {
        sessionId,
        nextCheckAt,
        timeoutAt,
      }),
    }),
  }, runId);
  const updatedIssue = await response.json().catch(() => null) as unknown;
  assertJulesMonitorScheduled(updatedIssue, { sessionId, nextCheckAt });
}

/** Remove only the Jules continuation marker and retain any review workflow. */
export async function clearJulesSessionMonitor(
  issueId: string,
  authToken: string | undefined,
  runId?: string,
): Promise<void> {
  const issue = await getPaperclipIssue(issueId, authToken, runId);
  const policyMonitor = issue.executionPolicy?.["monitor"];
  const stateMonitor = issue.executionState?.["monitor"];
  const strandedJulesMonitor = !policyMonitor && stateMonitor &&
    typeof stateMonitor === "object" && !Array.isArray(stateMonitor) &&
    (stateMonitor as Record<string, unknown>)["serviceName"] === "jules" &&
    typeof (stateMonitor as Record<string, unknown>)["externalRef"] === "string";
  if (!policyMonitor && !strandedJulesMonitor) return;

  let policy: Record<string, unknown> = issue.executionPolicy ?? { ...INTERNAL_REVIEW_EXECUTION_POLICY };
  if (strandedJulesMonitor) {
    // Compatibility bridge for Paperclip versions that strip executionPolicy
    // when a monitor is triggered but leave executionState.monitor behind.
    // Reintroduce the same Jules monitor, then remove it through the normal
    // policy transition so Paperclip clears both projections. This is safe to
    // repeat and must be removed once Paperclip exposes a direct clear API.
    const monitor = stateMonitor as Record<string, unknown>;
    policy = executionPolicyWithJulesMonitor(policy, {
      sessionId: String(monitor["externalRef"]),
      nextCheckAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      timeoutAt: typeof monitor["timeoutAt"] === "string"
        ? monitor["timeoutAt"]
        : new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    await paperclipRequest(`/api/issues/${encodeURIComponent(issueId)}`, authToken, {
      method: "PATCH",
      body: JSON.stringify({ executionPolicy: policy }),
    }, runId);
  }

  const { monitor: _monitor, ...executionPolicy } = policy;
  await paperclipRequest(`/api/issues/${encodeURIComponent(issueId)}`, authToken, {
    method: "PATCH",
    body: JSON.stringify({
      // Paperclip PATCH merges nested policy objects. Omission therefore
      // preserves the prior monitor; use an explicit tombstone to terminate
      // the provider continuation before the independent review transition.
      executionPolicy: { ...executionPolicy, monitor: null },
    }),
  }, runId);

  if (strandedJulesMonitor) {
    const verified = await getPaperclipIssue(issueId, authToken, runId);
    const remaining = verified.executionState?.["monitor"];
    if (hasLiveJulesMonitor(remaining)) {
      throw new PaperclipClientError(null, "Paperclip retained a stranded Jules monitor after compatibility cleanup");
    }
  }
}

/**
 * Paperclip retains a `cleared` monitor in executionState as audit history
 * after removing its scheduling policy.  Only scheduled/triggered monitors
 * can wake Jules again; treating the cleared record as live turns a successful
 * compatibility cleanup into a false failed heartbeat and recovery loop.
 */
function hasLiveJulesMonitor(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const monitor = value as Record<string, unknown>;
  if (monitor["serviceName"] !== "jules") return false;
  switch (monitor["status"]) {
    case "cleared":
      return false;
    case "scheduled":
    case "triggered":
      return true;
    default:
      // Old/malformed state lacks a terminal status. Fail closed: it can still
      // represent a live continuation on older Paperclip releases.
      return true;
  }
}

export async function createJulesQuestionAdjudication(
  parentIssueId: string,
  reviewerAgentId: string,
  question: string,
  authToken: string | undefined,
  runId?: string,
  companyId?: string,
  activityId?: string,
  sessionId?: string,
  generation = 0,
  deferExecution = false,
  kind: "question" | "plan" = "question",
): Promise<PaperclipIssue> {
  const isPlanReview = kind === "plan";
  const fingerprint = createHash("sha256").update(question).digest("hex").slice(0, 24);
  const correlation = companyId && activityId
    ? buildQuestionCorrelation({
      parentIssueId,
      companyId,
      sessionId: sessionId ?? "unknown-session",
      activityId,
      reviewerAgentId,
      question,
      generation,
    })
    : null;
  const marker = correlation
    ? questionCorrelationMarker(correlation)
    : `<!-- jules-question-adjudication:${fingerprint} -->`;
  const lockKey = `${parentIssueId}:${activityId ?? fingerprint}:${generation}`;
  const description = `
${marker}
${isPlanReview
  ? "You are the assigned reviewer for a Jules implementation plan. Review only the plan attached in the typed Paperclip form. Submit All good only when it is implementable; submit Needs work with a concrete reason. Do not post a comment as a substitute for the form."
  : "You are the strong adjudicator for a Jules provider question. Answer only the quoted operational question. Do not inspect or review the checkout, diff, tests, branches, pull requests, GitHub, or repository files; they may be stale and are not part of this decision. Do not propose code changes or implementation feedback. Use only the parent task's explicit instructions and the quoted provider question. For generic continue/commit/submit questions, return the direct workflow instruction already declared by the parent task. Escalate only when the question requires a concrete product or authorization decision that the parent task does not specify."}

${isPlanReview ? "Plan:" : "Provider question:"}
${question}

The Paperclip interaction attached to this issue is the only decision protocol. Submit
that typed form, then mark this reviewer task done. Do not post a JSON object or
free-text comment as a substitute for the structured decision.`;
  const previous = questionAdjudicationLocks.get(lockKey) ?? Promise.resolve();
  const operation = previous.then(async () => {
    if (companyId) {
      const issues = await getPaperclipJson<Array<Record<string, unknown>> | { issues?: Array<Record<string, unknown>> }>(
        `/api/companies/${encodeURIComponent(companyId)}/issues?limit=1000`, authToken, runId,
      ).catch(() => [] as Array<Record<string, unknown>>);
      const list = Array.isArray(issues) ? issues : (issues.issues ?? []);
      const existing = list.find((issue) =>
        issue["parentId"] === parentIssueId &&
        (deferExecution || issue["assigneeAgentId"] === reviewerAgentId) &&
        typeof issue["description"] === "string" &&
        (issue["description"] as string).includes(marker) &&
        issue["status"] !== "cancelled" && issue["status"] !== "done",
      );
      if (existing && typeof existing["id"] === "string") return existing as unknown as PaperclipIssue;
    }
    let created: PaperclipIssue;
    try {
      const response = await paperclipRequest(
        `/api/issues/${encodeURIComponent(parentIssueId)}/children`, authToken, {
        method: "POST",
        body: JSON.stringify({
          title: isPlanReview ? "Review Jules plan" : "Adjudicate Jules provider question",
          description,
          // Paperclip treats `blocked` as closed for interaction creation.
          // Backlog accepts interactions but is not eligible for an agent
          // heartbeat. Keep Terra assigned so Paperclip can surface the
          // pending form when activation changes the status to todo.
          status: deferExecution ? "backlog" : "todo",
          priority: "high",
          assigneeAgentId: reviewerAgentId,
          // Jules owns the provider-question gate. A native Paperclip dependency
          // would block the parent before the adapter can consume the reviewer's
          // structured answer and would invite generic native recovery prompts.
          blockParentUntilDone: false,
          executionPolicy: INTERNAL_REVIEW_EXECUTION_POLICY,
        }),
        }, runId,
      );
      created = (await response.json()) as PaperclipIssue;
    } catch (error) {
      if (!isPaperclipChildLimitError(error) || !companyId) throw error;
      // Paperclip intentionally caps helper children per parent. Use a fresh
      // company-level protocol issue when that cap is hit. Reopening a
      // terminal child would retain its old reviewer comments and could make
      // a stale answer look like the answer to this new provider question.
      const raw = await getPaperclipJson<unknown>(
        `/api/companies/${encodeURIComponent(companyId)}/issues?limit=1000`, authToken, runId,
      );
      const allIssues = Array.isArray(raw) ? raw : ((raw as { issues?: unknown[] })?.issues ?? []);
      const alreadyCreated = allIssues.find((value) => {
        const issue = value as Record<string, unknown>;
        return issue["status"] !== "cancelled" && issue["status"] !== "done" &&
          typeof issue["description"] === "string" &&
          (issue["description"] as string).includes(marker) &&
          typeof issue["id"] === "string";
      });
      if (alreadyCreated && typeof (alreadyCreated as Record<string, unknown>)["id"] === "string") {
        created = alreadyCreated as PaperclipIssue;
      } else {
        const response = await paperclipRequest(
          `/api/companies/${encodeURIComponent(companyId)}/issues`, authToken, {
          method: "POST",
          body: JSON.stringify({
            companyId,
            title: "Adjudicate Jules provider question",
            description: `${description}\n\nParent issue: ${parentIssueId}`,
            status: deferExecution ? "backlog" : "todo",
            priority: "high",
            assigneeAgentId: reviewerAgentId,
            blockParentUntilDone: false,
            executionPolicy: INTERNAL_REVIEW_EXECUTION_POLICY,
            // Company-level issue creation has a recent-title duplicate guard.
            // This fallback is used after the parent reaches Paperclip's child
            // cap, and every correlated provider activity must get fresh task
            // context. Reusing an older terminal issue can make an otherwise
            // correct reviewer answer the previous provider question. The
            // request body's correlation marker plus paperclipRequest's stable
            // idempotency key still make retries of this activity converge.
            // Remove this adapter workaround if Paperclip gains a native
            // protocol/helper-issue identity independent of title deduplication.
            allowDuplicate: true,
          }),
          }, runId,
        );
        created = (await response.json()) as PaperclipIssue;
      }
      /*
       * The fallback intentionally has no parentId: it is still linked by its
       * marker and session state, while avoiding Paperclip's per-parent cap.
       */
      if (!created.id) throw error;
      await paperclipRequest(`/api/issues/${encodeURIComponent(created.id)}`, authToken, {
        method: "PATCH",
        body: JSON.stringify({
          assigneeAgentId: reviewerAgentId,
          blockParentUntilDone: false,
          executionPolicy: INTERNAL_REVIEW_EXECUTION_POLICY,
        }),
      }, runId);
    }
    // Paperclip versions that inherit the parent's policy on child creation
    // must be explicitly neutralized. This child is an ACP protocol endpoint,
    // not a native execution-review task.
    if (created.id) {
      await paperclipRequest(`/api/issues/${encodeURIComponent(created.id)}`, authToken, {
        method: "PATCH",
        body: JSON.stringify({ blockParentUntilDone: false, executionPolicy: INTERNAL_REVIEW_EXECUTION_POLICY }),
      }, runId).catch(() => undefined);
    }
    return created;
  });
  const lock = operation.then(() => undefined, () => undefined);
  questionAdjudicationLocks.set(lockKey, lock);
  try { return await operation; } finally {
    if (questionAdjudicationLocks.get(lockKey) === lock) questionAdjudicationLocks.delete(lockKey);
  }
}

/**
 * Reconnects a recovered Jules session to its existing strong-review child.
 * The session checkpoint is disposable, so the activity marker is the durable
 * identity; this lookup never scans comments or guesses from question prose.
 */
export async function findJulesQuestionAdjudication(
  parentIssueId: string,
  companyId: string,
  reviewerAgentId: string,
  sessionId: string,
  activityId: string,
  authToken: string | undefined,
  runId?: string,
): Promise<PaperclipIssue | null> {
  const response = await paperclipRequest(
    `/api/companies/${encodeURIComponent(companyId)}/issues?limit=1000`,
    authToken,
    // Paperclip's local API can legitimately take ~2s while the heartbeat
    // runner is acquiring a database connection. Keep recovery bounded, but
    // do not make a healthy lookup fail before that normal latency window.
    { method: "GET", signal: AbortSignal.timeout(5000) },
    runId,
  );
  const raw = await response.json() as unknown;
  const issues = Array.isArray(raw) ? raw : ((raw as { issues?: unknown[] } | null)?.issues ?? []);
  const match = issues.find((value) => {
    if (!value || typeof value !== "object") return false;
    const issue = value as Record<string, unknown>;
    if (issue["assigneeAgentId"] !== reviewerAgentId || issue["status"] === "cancelled" ||
        typeof issue["description"] !== "string") return false;
    const description = issue["description"] as string;
    const correlation = parseQuestionCorrelation(description);
    if (correlation) {
      // v2 fallback issues intentionally have no parentId; the marker is the
      // authoritative parent/session/activity identity in that case.
      return correlation.parentIssueId === parentIssueId && correlation.companyId === companyId &&
        correlation.sessionId === sessionId && correlation.activityId === activityId &&
        correlation.reviewerAgentId === reviewerAgentId;
    }
    // Older adapter builds emitted only question-hash/activity markers and a
    // prose parent hint for company-level fallback issues. Read this format
    // for migration, but never emit it for new children.
    const legacyActivityMarker = `:${activityId} -->`;
    const legacyParentHint = `Parent issue: ${parentIssueId}`;
    return description.includes("jules-question-adjudication:") &&
      description.includes(legacyActivityMarker) &&
      (issue["parentId"] === parentIssueId || description.includes(legacyParentHint));
  });
  return match && typeof (match as Record<string, unknown>)["id"] === "string"
    ? match as PaperclipIssue
    : null;
}

const questionAdjudicationLocks = new Map<string, Promise<void>>();

export async function getPaperclipIssue(
  issueId: string,
  authToken: string | undefined,
  runId?: string,
): Promise<PaperclipIssue> {
  return getPaperclipJson<PaperclipIssue>(`/api/issues/${encodeURIComponent(issueId)}`, authToken, runId);
}

/**
 * Internal Jules reviewer children are protocol endpoints, not Paperclip review
 * tasks. Paperclip can attach the parent's execution policy when assigning a
 * child, so repair that policy immediately before consuming the child result.
 * This is intentionally idempotent and keeps provider-question adjudication
 * out of native review/approval loops.
 */
export async function normalizeInternalReviewIssue(
  issue: PaperclipIssue,
  authToken: string | undefined,
  runId?: string,
): Promise<void> {
  if (issue.executionPolicy &&
      Array.isArray(issue.executionPolicy["stages"]) &&
      issue.executionPolicy["stages"].length === 0 &&
      issue.executionPolicy["commentRequired"] === false) return;
  await paperclipRequest(`/api/issues/${encodeURIComponent(issue.id)}`, authToken, {
    method: "PATCH",
    body: JSON.stringify({ blockParentUntilDone: false, executionPolicy: INTERNAL_REVIEW_EXECUTION_POLICY }),
  }, runId);
}

/** Completes an internal reviewer child after its structured protocol result is consumed. */
export async function completeInternalReviewIssue(
  issueId: string,
  authToken: string | undefined,
  runId?: string,
): Promise<void> {
  await paperclipRequest(`/api/issues/${encodeURIComponent(issueId)}`, authToken, {
    method: "PATCH",
    body: JSON.stringify({ status: "done", blockParentUntilDone: false, executionPolicy: INTERNAL_REVIEW_EXECUTION_POLICY }),
  }, runId);
}

/** Activates a reviewer child only after its typed interaction exists. */
export async function activateInternalReviewIssue(
  issueId: string,
  reviewerAgentId: string,
  authToken: string | undefined,
  runId?: string,
): Promise<void> {
  await paperclipRequest(`/api/issues/${encodeURIComponent(issueId)}`, authToken, {
    method: "PATCH",
    body: JSON.stringify({
      status: "todo",
      assigneeAgentId: reviewerAgentId,
      blockParentUntilDone: false,
      executionPolicy: INTERNAL_REVIEW_EXECUTION_POLICY,
    }),
  }, runId);
}

export async function listIssueComments(
  issueId: string,
  authToken: string | undefined,
  runId?: string,
): Promise<IssueComment[]> {
  const response = await paperclipRequest(
    `/api/issues/${encodeURIComponent(issueId)}/comments`,
    authToken,
    { method: "GET" },
    runId,
  );
  const raw = (await response.json()) as unknown;
  return Array.isArray(raw) ? (raw as IssueComment[]) : [];
}
