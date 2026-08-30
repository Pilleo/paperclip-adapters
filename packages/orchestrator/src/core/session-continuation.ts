export const DEFAULT_CONTINUATION_CADENCE_MS = 300_000;

export interface ContinuationIssue {
  readonly id: string;
  readonly identifier?: string | null | undefined;
  readonly status: string;
  readonly assigneeAgentId?: string | null | undefined;
}

export interface ContinuationWorker {
  readonly id: string;
  readonly status: string;
  readonly adapterType: string;
}

export interface HeartbeatRunSummary {
  readonly id: string;
  readonly agentId: string;
  readonly status: string;
  readonly finishedAt: string | null;
  readonly startedAt: string | null;
  readonly sessionIdBefore: string | null;
  readonly sessionIdAfter: string | null;
  readonly issueId: string | null;
  readonly retryNotBefore: string | null;
  readonly providerSessionId: string | null;
}

export type ContinuationDecision =
  | { action: "WAKE"; agentId: string; issueId: string; reason: string }
  | { action: "SKIP"; reason: string };

const CONTINUABLE_ISSUE_STATUSES = new Set(["in_progress", "in_review"]);
const BUSY_AGENT_STATUSES = new Set(["running", "queued", "busy"]);
const BUSY_RUN_STATUSES = new Set(["running", "queued", "claimed"]);
const CONTINUABLE_ADAPTERS = new Set(["jules", "vibe", "antigravity"]);

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "-" || trimmed === "null") return null;
  return trimmed;
}

export function parseHeartbeatRun(raw: Record<string, unknown>): HeartbeatRunSummary {
  const context = raw["contextSnapshot"];
  const contextRecord =
    context && typeof context === "object" && !Array.isArray(context)
      ? (context as Record<string, unknown>)
      : {};
  const result = raw["resultJson"];
  const resultRecord =
    result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : {};
  return {
    id: String(raw["id"] ?? ""),
    agentId: String(raw["agentId"] ?? ""),
    status: String(raw["status"] ?? ""),
    finishedAt: nonEmpty(raw["finishedAt"]),
    startedAt: nonEmpty(raw["startedAt"]),
    sessionIdBefore: nonEmpty(raw["sessionIdBefore"]),
    sessionIdAfter: nonEmpty(raw["sessionIdAfter"]),
    issueId: nonEmpty(contextRecord["issueId"]) ?? nonEmpty(resultRecord["issueId"]),
    retryNotBefore: nonEmpty(resultRecord["retryNotBefore"]) ?? nonEmpty(raw["retryNotBefore"]),
    providerSessionId: nonEmpty(resultRecord["julesSessionId"]) ?? nonEmpty(resultRecord["sessionId"]),
  };
}

export function liveSessionId(run: HeartbeatRunSummary): string | null {
  return run.sessionIdAfter ?? run.providerSessionId ?? run.sessionIdBefore;
}

export function evaluateSessionContinuation(input: {
  readonly issue: ContinuationIssue;
  readonly worker: ContinuationWorker | null;
  readonly latestRun: HeartbeatRunSummary | null;
  readonly now?: number | undefined;
  readonly defaultCadenceMs?: number | undefined;
  readonly managedWorkerIds: ReadonlySet<string>;
}): ContinuationDecision {
  const now = input.now ?? Date.now();
  const cadenceMs = input.defaultCadenceMs ?? DEFAULT_CONTINUATION_CADENCE_MS;
  const assignee = input.issue.assigneeAgentId ?? null;

  if (!CONTINUABLE_ISSUE_STATUSES.has(input.issue.status)) {
    return { action: "SKIP", reason: `issue status ${input.issue.status} is not a live execution` };
  }
  if (!assignee || !input.managedWorkerIds.has(assignee)) {
    return { action: "SKIP", reason: "assignee is not a managed worker" };
  }
  if (!input.worker || input.worker.id !== assignee) {
    return { action: "SKIP", reason: "managed worker record is missing" };
  }
  if (!CONTINUABLE_ADAPTERS.has(input.worker.adapterType)) {
    return { action: "SKIP", reason: `adapter ${input.worker.adapterType} is not polled by continuation` };
  }
  if (BUSY_AGENT_STATUSES.has(input.worker.status)) {
    return { action: "SKIP", reason: `worker is ${input.worker.status}` };
  }
  if (!input.latestRun) {
    return { action: "SKIP", reason: "no heartbeat to reattach; will not create a new session" };
  }
  if (BUSY_RUN_STATUSES.has(input.latestRun.status)) {
    return { action: "SKIP", reason: `latest run is ${input.latestRun.status}` };
  }
  const sessionId = liveSessionId(input.latestRun);
  if (!sessionId) {
    return { action: "SKIP", reason: "latest run has no live provider session id" };
  }

  const retryAt = input.latestRun.retryNotBefore
    ? Date.parse(input.latestRun.retryNotBefore)
    : NaN;
  if (!Number.isNaN(retryAt) && now < retryAt) {
    return { action: "SKIP", reason: `retryNotBefore ${input.latestRun.retryNotBefore} is still in the future` };
  }

  const finishedAt = input.latestRun.finishedAt ? Date.parse(input.latestRun.finishedAt) : NaN;
  if (Number.isNaN(retryAt) && !Number.isNaN(finishedAt) && now < finishedAt + cadenceMs) {
    return { action: "SKIP", reason: "poll cadence has not elapsed since last heartbeat" };
  }

  return {
    action: "WAKE",
    agentId: assignee,
    issueId: input.issue.id,
    reason: `Continue live ${input.worker.adapterType} session ${sessionId}`,
  };
}

export function selectSessionContinuations(input: {
  readonly issues: readonly ContinuationIssue[];
  readonly workers: readonly ContinuationWorker[];
  readonly runs: readonly HeartbeatRunSummary[];
  readonly now?: number | undefined;
  readonly defaultCadenceMs?: number | undefined;
}): Extract<ContinuationDecision, { action: "WAKE" }>[] {
  const managedWorkerIds = new Set(input.workers.map((w) => w.id));
  const workerById = new Map(input.workers.map((w) => [w.id, w]));
  const wakes: Extract<ContinuationDecision, { action: "WAKE" }>[] = [];
  const wokenAgents = new Set<string>();

  for (const worker of input.workers) {
    if (wokenAgents.has(worker.id)) continue;
    const assigned = input.issues.filter((issue) => issue.assigneeAgentId === worker.id);
    for (const issue of assigned) {
      const latestRun =
        input.runs.find((run) => run.agentId === worker.id && run.issueId === issue.id) ??
        (assigned.length === 1
          ? input.runs.find((run) => run.agentId === worker.id && liveSessionId(run)) ?? null
          : null);
      const decision = evaluateSessionContinuation({
        issue,
        worker: workerById.get(worker.id) ?? null,
        latestRun: latestRun ?? null,
        now: input.now,
        defaultCadenceMs: input.defaultCadenceMs,
        managedWorkerIds,
      });
      if (decision.action === "WAKE") {
        wakes.push(decision);
        wokenAgents.add(worker.id);
        break;
      }
    }
  }
  return wakes;
}

export function liveHeartbeatIssueIds(
  runs: readonly HeartbeatRunSummary[],
  now: number,
  maxAgeMs: number
): Set<string> {
  const ids = new Set<string>();
  for (const run of runs) {
    if (!run.issueId || !liveSessionId(run)) continue;
    if (BUSY_RUN_STATUSES.has(run.status)) {
      ids.add(run.issueId);
      continue;
    }
    const stamp = Date.parse(run.finishedAt ?? run.startedAt ?? "");
    if (!Number.isNaN(stamp) && now - stamp < maxAgeMs) {
      ids.add(run.issueId);
    }
  }
  return ids;
}
