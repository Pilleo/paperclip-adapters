import { formatCardPrompt, formatCardSummary, formatCardPromptAndHelpText, SafeCardPrompt, SafeCardSummary } from "./card-prompt.js";
import {
  extractJulesSessionId,
  extractJulesSessionIdFromComments,
  formatJulesSessionHandleBody,
  JULES_SESSION_DOCUMENT_KEY,
} from "./jules-session-handle.js";
const PAPERCLIP_API_URL_ENV = "PAPERCLIP_API_URL";

export class PaperclipClientError extends Error {
  constructor(public readonly status: number | null, message: string) {
    super(message);
    this.name = "PaperclipClientError";
  }
}

export interface PaperclipInteraction {
  id: string;
  status: string;
  kind?: string;
  result?: unknown;
  target?: unknown;
  idempotencyKey?: string;
}

export interface PlanRevision {
  documentId: string;
  revisionId: string;
  revisionNumber: number;
}

export interface PlanApprovalInteraction extends PaperclipInteraction {
  planRevision: PlanRevision;
}

function paperclipApiBaseUrl(): string {
  return (process.env[PAPERCLIP_API_URL_ENV] ?? "http://127.0.0.1:3100").replace(/\/+$/, "");
}

function requireAuthToken(authToken: string | undefined): string {
  const token = (typeof authToken === "string" && authToken.trim().length > 0)
    ? authToken.trim()
    : process.env["PAPERCLIP_AGENT_TOKEN"] || process.env["PAPERCLIP_API_KEY"];
  if (!token) throw new PaperclipClientError(null, "Paperclip local agent token is unavailable");
  return token;
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
  const token = requireAuthToken(authToken);
  let response: Response;
  try {
    response = await fetch(`${paperclipApiBaseUrl()}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(runId ? { "X-Paperclip-Run-Id": runId } : {}),
        ...init.headers,
      },
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new PaperclipClientError(null, `Paperclip API request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    const detail = typeof response.text === "function" ? await response.text().catch(() => "") : "";
    const suffix = detail.trim() ? ": " + detail.trim().slice(0, 500) : "";
    throw new PaperclipClientError(response.status, "Paperclip API request failed (" + response.status + ")" + suffix);
  }
  return response;
}

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
): Promise<Array<{ url?: string }>> {
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
        .map((w) => ({ url: w["url"] as string }))
    : [];
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
): Promise<void> {
  let baseRevisionId: string | null = null;
  try {
    const headResponse = await paperclipRequest(
      `/api/issues/${encodeURIComponent(issueId)}/documents/${JULES_SESSION_DOCUMENT_KEY}`,
      authToken,
      { method: "GET" },
      runId,
    );
    const head = await headResponse.json() as Record<string, unknown>;
    baseRevisionId = typeof head["latestRevisionId"] === "string" ? head["latestRevisionId"] : null;
  } catch (error) {
    if (!(error instanceof PaperclipClientError) || error.status !== 404) throw error;
  }

  await paperclipRequest(
    `/api/issues/${encodeURIComponent(issueId)}/documents/${JULES_SESSION_DOCUMENT_KEY}`,
    authToken,
    {
      method: "PUT",
      body: JSON.stringify({
        title: "Jules session",
        format: "markdown",
        body: formatJulesSessionHandleBody(sessionId, sessionUrl),
        changeSummary: `Jules session ${sessionId}`,
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

export async function registerPullRequestWorkProduct(
  issueId: string,
  prUrl: string,
  authToken: string | undefined,
  runId?: string,
): Promise<void> {
  const existing = await listWorkProducts(issueId, authToken, runId).catch(
    () => [] as Array<{ url?: string }>,
  );
  if (!existing.some((w) => w.url === prUrl)) {
    await paperclipRequest(`/api/issues/${encodeURIComponent(issueId)}/work-products`, authToken, {
      method: "POST",
      body: JSON.stringify({
        type: "pull_request",
        provider: "github",
        title: "Jules pull request",
        url: prUrl,
        externalId: prUrl,
        status: "ready_for_review",
        isPrimary: true,
        metadata: { source: "jules" },
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
  try {
    await registerPullRequestWorkProduct(issueId, prUrl, authToken, runId);
  } catch {
    // Work product registration is best-effort
  }

  // Note: We do not perform an unbacked status PATCH to in_review here to prevent
  // Paperclip server 422 invalid_issue_disposition errors on agent-authored transitions.
  // The Orchestrator automatically detects the registered PR and routes the task to in_review with a reviewer.
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

function interactionFromResponse(raw: unknown, status: number): PaperclipInteraction {
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
    target: (record["payload"] as Record<string, unknown> | undefined)?.["target"] ?? record["target"],
    ...(typeof record["kind"] === "string" ? { kind: record["kind"] } : {}),
    ...(typeof record["idempotencyKey"] === "string" ? { idempotencyKey: record["idempotencyKey"] } : {}),
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
  await paperclipRequest(`/api/issues/${encodeURIComponent(issueId)}/comments`, authToken, {
    method: "POST",
    body: JSON.stringify({
      body,
      authorType: "agent",
    }),
  }, runId);
}

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

export async function createJulesPlanApprovalInteraction(
  issueId: string,
  sessionId: string,
  activityId: string,
  planMarkdown: string,
  authToken: string | undefined,
  runId?: string,
): Promise<PlanApprovalInteraction> {
  let baseRevisionId: string | null = null;
  try {
    const headResponse = await paperclipRequest(
      `/api/issues/${encodeURIComponent(issueId)}/documents/plan`, authToken, { method: "GET" }, runId,
    );
    const head = await headResponse.json() as Record<string, unknown>;
    baseRevisionId = typeof head["latestRevisionId"] === "string" ? head["latestRevisionId"] : null;
  } catch (error) {
    if (!(error instanceof PaperclipClientError) || error.status !== 404) throw error;
  }

  const documentResponse = await paperclipRequest(
    `/api/issues/${encodeURIComponent(issueId)}/documents/plan`, authToken, {
      method: "PUT",
      body: JSON.stringify({
        title: "Jules plan",
        format: "markdown",
        body: planMarkdown,
        changeSummary: `Generated by Jules activity ${activityId}`,
        baseRevisionId,
      }),
    }, runId,
  );
  const document = await documentResponse.json() as Record<string, unknown>;
  const documentId = document["id"];
  const revisionId = document["latestRevisionId"];
  const revisionNumber = document["latestRevisionNumber"];
  if (typeof documentId !== "string" || typeof revisionId !== "string" || typeof revisionNumber !== "number") {
    throw new PaperclipClientError(documentResponse.status, "Paperclip returned an invalid plan document revision");
  }

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

export async function withdrawPaperclipInteraction(
  issueId: string,
  interactionId: string,
  reason: string,
  authToken: string | undefined,
  runId?: string,
): Promise<void> {
  await paperclipRequest(
    `/api/issues/${encodeURIComponent(issueId)}/interactions/${encodeURIComponent(interactionId)}/withdraw`,
    authToken,
    {
      method: "POST",
      body: JSON.stringify({ reason }),
    },
    runId,
  );
}

export async function listPaperclipInteractions(
  issueId: string,
  authToken: string | undefined,
  runId?: string,
): Promise<PaperclipInteraction[]> {
  const response = await paperclipRequest(`/api/issues/${encodeURIComponent(issueId)}/interactions`, authToken, {
    method: "GET",
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
): Promise<PaperclipInteraction> {
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
        idempotencyKey: `jules:no-pr-completion:${issueId}:${sessionId}`,
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
