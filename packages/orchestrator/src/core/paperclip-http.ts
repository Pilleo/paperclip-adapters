import { createHash } from "node:crypto";
import { resilientFetch } from "./resilient-fetch.js";
import { createUpdateIssuePayload, type UpdateIssuePayload } from "./paperclip-orchestrator-client.js";
import type { IssueStatus } from "./types.js";
import {
  buildNativeInteractionWakeRequest,
  executePaperclipCommand,
  type PaperclipCommandResponse,
  type WorkerFeedbackEnvelope,
} from "@pilleo/paperclip-adapter-common";

export class OrchestratorPaperclipError extends Error {
  constructor(
    public readonly status: number | null,
    message: string
  ) {
    super(message);
    this.name = "OrchestratorPaperclipError";
  }
}

export interface PaperclipHttpOptions {
  readonly apiUrl: string;
  readonly authToken?: string | undefined;
  readonly runId?: string | undefined;
  /**
   * Company-level orchestrator heartbeats have no source issueId, so
   * Paperclip's cross-issue write guard rejects their agent JWT mutations.
   * In local-trusted mode only, use the implicit board actor for mutations.
   */
  readonly localTrustedBoardWrites?: boolean | undefined;
}

export interface IssueListOptions {
  readonly projectId?: string | undefined;
  readonly includeBlockedBy?: boolean | undefined;
  readonly parentId?: string | undefined;
}

export interface NativeReviewWakeInput {
  readonly reviewerAgentId: string;
  readonly issueId: string;
  readonly interactionId: string;
  readonly interactionKind: "request_item_verdicts";
}

export type NativeReviewWakeResult =
  | { readonly kind: "started"; readonly runId: string }
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "rejected"; readonly status: number; readonly reason: string }
  | { readonly kind: "invalid_response" }
  | { readonly kind: "transport_failure"; readonly reason: string };

function apiBase(apiUrl: string): string {
  return apiUrl.replace(/\/+$/, "").replace(/\/api$/i, "");
}

function requireToken(authToken?: string): string {
  const token =
    (typeof authToken === "string" && authToken.trim().length > 0 ? authToken.trim() : "") ||
    process.env["PAPERCLIP_AGENT_TOKEN"] ||
    process.env["PAPERCLIP_API_KEY"] ||
    "";
  if (!token) {
    throw new OrchestratorPaperclipError(null, "Paperclip agent token is unavailable");
  }
  return token;
}

export function nativeReviewWakeIdempotencyKey(input: NativeReviewWakeInput): string {
  return [
    "native-review-dispatch-recovery:v1",
    input.issueId,
    input.interactionId,
    input.reviewerAgentId,
  ].join(":");
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function textField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field.trim() : null;
}

export function classifyNativeReviewWakeResponse(response: {
  readonly ok: boolean;
  readonly status: number;
  readonly text: string;
  readonly data?: unknown;
}): NativeReviewWakeResult {
  const data = record(response.data);
  if (!response.ok) {
    const reason = textField(data ?? {}, "error") ?? response.text;
    return {
      kind: "rejected",
      status: response.status,
      reason: reason || `HTTP ${response.status}`,
    };
  }
  const runId = data ? textField(data, "id") : null;
  if (runId) return { kind: "started", runId };
  if (data?.["status"] === "skipped") {
    return { kind: "skipped", reason: textField(data, "reason") ?? "Paperclip skipped the wake" };
  }
  return { kind: "invalid_response" };
}

export function createPaperclipHttp(options: PaperclipHttpOptions) {
  const base = apiBase(options.apiUrl);
  // Callers may pass either the Paperclip origin or its conventional `/api`
  // base. Both are loopback-only and therefore eligible for the built-in
  // local-trusted actor; rejecting the latter makes recovery scripts fail
  // before they can reuse an existing typed review card.
  const localTrustedBoardWrites = options.localTrustedBoardWrites === true && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(?:\/api)?$/i.test(base);

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const isMutation = (init.method || "GET").toUpperCase() !== "GET";
    // Paperclip's loopback `local_trusted` actor is intentionally credential
    // free for built-in adapters. Apply it to the complete company-level
    // control-plane exchange, not only mutations; otherwise the first project
    // GET fails before the trusted mutation path can even be reached.
    const token = localTrustedBoardWrites ? "" : requireToken(options.authToken);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(token && options.runId ? { "X-Paperclip-Run-Id": options.runId } : {}),
      ...((init.headers as Record<string, string> | undefined) || {}),
    };
    // A lost acknowledgement may follow remote acceptance. The native effect
    // owner must inspect its receipt; retrying a mutation can duplicate work.
    const response = await resilientFetch(`${base}${path}`, { ...init, headers },
      isMutation ? { maxRetries: 0 } : {});
    return response;
  }

  async function readError(response: Response): Promise<string> {
    const text = await response.text().catch(() => "");
    return text.trim().slice(0, 500);
  }

  async function getJson<T>(path: string): Promise<T> {
    const response = await request(path, { method: "GET" });
    if (!response.ok) {
      throw new OrchestratorPaperclipError(
        response.status,
        `GET ${path} failed (${response.status}): ${await readError(response)}`
      );
    }
    return (await response.json()) as T;
  }

  async function sendJson(
    path: string,
    method: "POST" | "PUT" | "PATCH" | "DELETE",
    body: unknown,
    idempotencyKey?: string,
  ): Promise<{ ok: boolean; status: number; text: string; data?: unknown }> {
    const key = idempotencyKey || explicitIdempotencyKey(body) || derivedIdempotencyKey(method, path, body);
    const commandResponse = await executePaperclipCommand(
      {
        key,
        issueId: issueIdFromPath(path),
        action: commandAction(method, path),
        payload: body,
      },
      async () => {
        const response = await request(path, {
          method,
          body: JSON.stringify(body),
          headers: { "Idempotency-Key": key },
        });
        const rawText = await response.text().catch(() => "");
        const text = rawText.trim().slice(0, 500);
        if (response.status === 409) {
          throw new OrchestratorPaperclipError(409, `Conflict on ${method} ${path}: ${text}`);
        }
        let data: unknown;
        try { data = rawText ? JSON.parse(rawText) : undefined; } catch { /* plain-text responses remain diagnostic text */ }
        return { ok: response.ok, status: response.status, text, ...(data !== undefined ? { data } : {}) } satisfies PaperclipCommandResponse;
      },
    );
    return { ok: commandResponse.ok, status: commandResponse.status, text: commandResponse.text ?? "", ...(commandResponse.data !== undefined ? { data: commandResponse.data } : {}) };
  }

  function explicitIdempotencyKey(body: unknown): string | undefined {
    if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
    const value = (body as Record<string, unknown>)["idempotencyKey"];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  function derivedIdempotencyKey(method: string, path: string, body: unknown): string {
    const digest = createHash("sha256").update(JSON.stringify(body) ?? "null").digest("hex").slice(0, 24);
    return `paperclip:${method}:${path}:${digest}`;
  }

  function issueIdFromPath(path: string): string {
    const match = path.match(/\/api\/issues\/([^/]+)/);
    return match?.[1] || "company";
  }

  function commandAction(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string): "comment" | "interaction" | "status" | "assignment" | "wakeup" {
    if (path.endsWith("/wakeup")) return "wakeup";
    if (path.includes("/interactions")) return "interaction";
    if (path.includes("/comments")) return "comment";
    if (path.includes("/agents/")) return "assignment";
    return method === "PATCH" ? "status" : "interaction";
  }

  return {
    getJson,
    sendJson,
    async listAgents<T = unknown>(companyId: string): Promise<T> {
      return getJson<T>(`/api/companies/${encodeURIComponent(companyId)}/agents`);
    },
    async listIssues<T = unknown>(companyId: string, listOptions: IssueListOptions = {}): Promise<T> {
      const query = new URLSearchParams({ limit: "1000" });
      if (listOptions.projectId) query.set("projectId", listOptions.projectId);
      if (listOptions.includeBlockedBy) query.set("includeBlockedBy", "true");
      if (listOptions.parentId) query.set("parentId", listOptions.parentId);
      return getJson<T>(`/api/companies/${encodeURIComponent(companyId)}/issues?${query.toString()}`);
    },
    /** Children are authoritative even when Paperclip omitted their projectId. */
    async listChildren<T = unknown>(companyId: string, parentIssueId: string): Promise<T> {
      const raw = await getJson<unknown>(`/api/companies/${encodeURIComponent(companyId)}/issues?limit=1000&parentId=${encodeURIComponent(parentIssueId)}`);
      if (Array.isArray(raw)) return raw as T;
      if (raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>)["children"])) {
        return (raw as Record<string, unknown>)["children"] as T;
      }
      return raw as T;
    },
    /** Fetch the enriched issue representation; list responses omit work products. */
    async getIssue<T = unknown>(issueId: string): Promise<T> {
      return getJson<T>(`/api/issues/${encodeURIComponent(issueId)}`);
    },
    async listProjects<T = unknown>(companyId: string): Promise<T> {
      return getJson<T>(`/api/companies/${encodeURIComponent(companyId)}/projects`);
    },
    async listApprovals<T = unknown>(companyId: string): Promise<T> {
      return getJson<T>(`/api/companies/${encodeURIComponent(companyId)}/approvals`);
    },
    async listComments<T = unknown>(issueId: string): Promise<T> {
      return getJson<T>(`/api/issues/${encodeURIComponent(issueId)}/comments`);
    },
    async patchIssue(issueId: string, payload: UpdateIssuePayload | Record<string, unknown>) {
      return sendJson(`/api/issues/${encodeURIComponent(issueId)}`, "PATCH", payload);
    },
    async patchWorkProduct(workProductId: string, payload: Record<string, unknown>) {
      return sendJson(`/api/work-products/${encodeURIComponent(workProductId)}`, "PATCH", payload);
    },
    async patchAgent(agentId: string, payload: Record<string, unknown>) {
      return sendJson(`/api/agents/${encodeURIComponent(agentId)}`, "PATCH", payload);
    },
    async patchProject(projectId: string, payload: Record<string, unknown>) {
      return sendJson(`/api/projects/${encodeURIComponent(projectId)}`, "PATCH", payload);
    },
    async comment(issueId: string, body: string) {
      return sendJson(`/api/issues/${encodeURIComponent(issueId)}/comments`, "POST", { body });
    },
    async createInteraction(issueId: string, payload: object) {
      return sendJson(`/api/issues/${encodeURIComponent(issueId)}/interactions`, "POST", payload);
    },
    async listInteractions<T = unknown>(issueId: string): Promise<T> {
      return getJson<T>(`/api/issues/${encodeURIComponent(issueId)}/interactions`);
    },
    async listRecoveryActions<T = unknown>(issueId: string): Promise<T> {
      return getJson<T>(`/api/issues/${encodeURIComponent(issueId)}/recovery-actions`);
    },
    async createRecoveryAction(issueId: string, payload: Record<string, unknown>) {
      return sendJson(`/api/issues/${encodeURIComponent(issueId)}/recovery-actions`, "POST", payload);
    },
    async resolveRecoveryAction(issueId: string, payload: Record<string, unknown>) {
      return sendJson(`/api/issues/${encodeURIComponent(issueId)}/recovery-actions/resolve`, "POST", payload);
    },
    async withdrawInteraction(issueId: string, interactionId: string, reason: string) {
      return sendJson(
        `/api/issues/${encodeURIComponent(issueId)}/interactions/${encodeURIComponent(interactionId)}/withdraw`,
        "POST",
        { reason },
      );
    },
    async createChildIssue(parentIssueId: string, payload: Record<string, unknown>) {
      return sendJson(`/api/issues/${encodeURIComponent(parentIssueId)}/children`, "POST", payload);
    },
    async createApproval(companyId: string, payload: Record<string, unknown>) {
      return sendJson(`/api/companies/${encodeURIComponent(companyId)}/approvals`, "POST", payload);
    },
    /**
     * A verified remote merge makes an unanswered operator gate obsolete.
     * Paperclip currently exposes reject, rather than a dedicated invalidation
     * route, so callers must supply an explicit note that distinguishes this
     * terminal cleanup from a human rejection of the implementation.
     */
    async rejectApproval(approvalId: string, decisionNote: string) {
      return sendJson(
        `/api/approvals/${encodeURIComponent(approvalId)}/reject`,
        "POST",
        { decisionNote },
      );
    },
    async listHeartbeatRuns(companyId: string, agentId: string, limit = 8): Promise<Record<string, unknown>[]> {
      const path =
        `/api/companies/${encodeURIComponent(companyId)}/heartbeat-runs` +
        `?agentId=${encodeURIComponent(agentId)}&limit=${Math.max(1, Math.min(50, limit))}`;
      try {
        return asArray<Record<string, unknown>>(await getJson<unknown>(path));
      } catch (err: unknown) {
        if (err instanceof OrchestratorPaperclipError && err.status === 404) {
          return [];
        }
        throw err;
      }
    },
    /**
     * The server-owned run snapshot is the authority for a coalesced
     * heartbeat's scope. Do not hide lookup failures: callers must fail
     * closed instead of widening a scoped wake to every project.
     */
    async getHeartbeatRun<T = unknown>(runId: string): Promise<T> {
      return getJson<T>(`/api/heartbeat-runs/${encodeURIComponent(runId)}`);
    },
    async cancelHeartbeatRun(runId: string, reason = "Cancelled stale delegated execution") {
      return sendJson(`/api/heartbeat-runs/${encodeURIComponent(runId)}/cancel`, "POST", { reason });
    },
    async wakeNativeReview(input: NativeReviewWakeInput): Promise<NativeReviewWakeResult> {
      const request = buildNativeInteractionWakeRequest({
        ...input,
        reason: "native_review_dispatch_recovery",
      });
      try {
        return classifyNativeReviewWakeResponse(await sendJson(
          request.path,
          "POST",
          request.body,
          nativeReviewWakeIdempotencyKey(input),
        ));
      } catch (error) {
        if (error instanceof OrchestratorPaperclipError && error.status !== null) {
          return { kind: "rejected", status: error.status, reason: error.message };
        }
        return { kind: "transport_failure", reason: error instanceof Error ? error.message : String(error) };
      }
    },
    async wakeup(
      agentId: string,
      reason: string,
      issueId?: string,
      options?: {
        resumeFromRunId?: string | undefined;
        idempotencyKey?: string | undefined;
        /** Native review cards need their identity in the runtime task context. */
        reviewInteractionId?: string | undefined;
        /** Reviewers must not reuse a stale session whose prompt predates the card. */
        forceFreshSession?: boolean | undefined;
        /** Compatibility wake anchor required by Paperclip v831. */
        wakeCommentId?: string | undefined;
        /** Exact answered PR verdict from an addressed native reviewer child. */
        workerFeedback?: WorkerFeedbackEnvelope | undefined;
        source?: "automation" | "on_demand" | undefined;
        triggerDetail?: "system" | "ping" | undefined;
      },
    ) {
      // Paperclip wakeAgentSchema ignores top-level issueId. Heartbeat only
      // injects context.paperclipIssue / task when payload.issueId is set.
      return sendJson(`/api/agents/${encodeURIComponent(agentId)}/wakeup`, "POST", {
        source: options?.source ?? "on_demand",
        triggerDetail: options?.triggerDetail ?? "ping",
        reason,
        // A reviewer session contains the previous task prompt and may be
        // reused by Paperclip. Review-card wakes are protocol-bound and must
        // receive a fresh prompt, otherwise the model can act on a cancelled
        // historical card even though the wake carries a new interaction id.
        forceFreshSession: options?.forceFreshSession === true || options?.reviewInteractionId !== undefined,
        ...(issueId || options?.resumeFromRunId || options?.workerFeedback
          ? {
              payload: {
                ...(issueId ? { issueId } : {}),
                ...(options?.resumeFromRunId ? { resumeFromRunId: options.resumeFromRunId } : {}),
                ...(options?.workerFeedback ? { workerFeedback: options.workerFeedback } : {}),
                // Vanilla Paperclip deliberately clears interactionId unless
                // this marks an interaction continuation. Without it a
                // reviewer wake loses the addressed native-card binding.
                ...(options?.reviewInteractionId
                  ? {
                      mutation: "interaction",
                      interactionId: options.reviewInteractionId,
                      interactionKind: "request_item_verdicts",
                    }
                  : {}),
                ...(options?.wakeCommentId ? { commentId: options.wakeCommentId } : {}),
              },
            }
          : {}),
      }, options?.idempotencyKey);
    },
  };
}

export type PaperclipHttp = ReturnType<typeof createPaperclipHttp>;

export function issuePatch(
  status: IssueStatus,
  assigneeAgentId?: string | null
): UpdateIssuePayload {
  return createUpdateIssuePayload(status, assigneeAgentId);
}

export function asArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    for (const key of ["agents", "issues", "approvals", "comments", "interactions", "projects", "children", "items"]) {
      if (Array.isArray(record[key])) return record[key] as T[];
    }
  }
  return [];
}
