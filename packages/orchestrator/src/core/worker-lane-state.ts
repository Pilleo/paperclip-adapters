export type ManagedWorkerLane = "jules" | "vibe" | "review_luna" | "review_terra";

export type WorkerLaneAvailability = "available" | "unavailable";

export type WorkerFailureDisposition = "retryable" | "operator_action";

export interface WorkerLaneCapacityInput {
  readonly lane: ManagedWorkerLane;
  readonly configuredCapacity: number;
  readonly runningCount: number;
  readonly agentStatus: string | null | undefined;
}

export interface ManagedLaneAssignments {
  readonly julesAgentId?: string | undefined;
  readonly vibeAgentId?: string | undefined;
  readonly lunaReviewerAgentId?: string | undefined;
  readonly terraReviewerAgentId?: string | undefined;
}

const INVOKABLE_AGENT_STATUSES = new Set(["idle", "running", "busy"]);

export function workerLaneAvailability(agentStatus: string | null | undefined): WorkerLaneAvailability {
  return INVOKABLE_AGENT_STATUSES.has((agentStatus || "").trim().toLowerCase())
    ? "available"
    : "unavailable";
}

export function managedWorkerLane(
  agentId: string,
  assignments: ManagedLaneAssignments,
): ManagedWorkerLane | undefined {
  if (agentId === assignments.julesAgentId) return "jules";
  if (agentId === assignments.vibeAgentId) return "vibe";
  if (agentId === assignments.lunaReviewerAgentId) return "review_luna";
  if (agentId === assignments.terraReviewerAgentId) return "review_terra";
  return undefined;
}

/**
 * Paperclip owns lane concurrency. Provider-side Jules sessions are neither
 * complete nor authoritative, so they deliberately do not participate here.
 */
export function resolveWorkerLaneCapacity(input: WorkerLaneCapacityInput): number {
  if (workerLaneAvailability(input.agentStatus) === "unavailable") return 0;
  return Math.max(
    0,
    Math.floor(input.configuredCapacity),
    Math.floor(input.runningCount),
  );
}

export function classifyWorkerFailureDisposition(reason: string | null | undefined): WorkerFailureDisposition {
  const normalized = (reason || "").toLowerCase();
  return normalized.includes("402") ||
    normalized.includes("payment required") ||
    normalized.includes("401") ||
    normalized.includes("unauthorized") ||
    normalized.includes("invalid api key")
    ? "operator_action"
    : "retryable";
}
