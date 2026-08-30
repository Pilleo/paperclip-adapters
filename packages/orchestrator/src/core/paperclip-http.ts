import { resilientFetch } from "./resilient-fetch.js";
import { createUpdateIssuePayload, type UpdateIssuePayload } from "./paperclip-orchestrator-client.js";
import type { IssueStatus } from "./types.js";

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
}

function apiBase(apiUrl: string): string {
  return apiUrl.replace(/\/+$/, "");
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

export function createPaperclipHttp(options: PaperclipHttpOptions) {
  const base = apiBase(options.apiUrl);

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const token = requireToken(options.authToken);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.runId ? { "X-Paperclip-Run-Id": options.runId } : {}),
      ...((init.headers as Record<string, string> | undefined) || {}),
    };
    const response = await resilientFetch(`${base}${path}`, { ...init, headers });
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
    method: "POST" | "PATCH",
    body: unknown
  ): Promise<{ ok: boolean; status: number; text: string }> {
    const response = await request(path, {
      method,
      body: JSON.stringify(body),
    });
    const text = await readError(response);
    if (response.status === 409) {
      throw new OrchestratorPaperclipError(409, `Conflict on ${method} ${path}: ${text}`);
    }
    return { ok: response.ok, status: response.status, text };
  }

  return {
    getJson,
    sendJson,
    async listAgents<T = unknown>(companyId: string): Promise<T> {
      return getJson<T>(`/api/companies/${encodeURIComponent(companyId)}/agents`);
    },
    async listIssues<T = unknown>(companyId: string): Promise<T> {
      return getJson<T>(`/api/companies/${encodeURIComponent(companyId)}/issues?limit=1000`);
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
    async comment(issueId: string, body: string) {
      return sendJson(`/api/issues/${encodeURIComponent(issueId)}/comments`, "POST", { body });
    },
    async createApproval(companyId: string, payload: Record<string, unknown>) {
      return sendJson(`/api/companies/${encodeURIComponent(companyId)}/approvals`, "POST", payload);
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
    async wakeup(agentId: string, reason: string, issueId?: string) {
      // Paperclip wakeAgentSchema ignores top-level issueId. Heartbeat only
      // injects context.paperclipIssue / task when payload.issueId is set.
      return sendJson(`/api/agents/${encodeURIComponent(agentId)}/wakeup`, "POST", {
        source: "on_demand",
        triggerDetail: "ping",
        reason,
        forceFreshSession: false,
        ...(issueId ? { payload: { issueId } } : {}),
      });
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
    for (const key of ["agents", "issues", "approvals", "comments", "projects", "items"]) {
      if (Array.isArray(record[key])) return record[key] as T[];
    }
  }
  return [];
}
