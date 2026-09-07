import { StructuredDecisionCapabilitySchema, type DecisionKind } from "@pilleo/paperclip-adapter-common";

export const MANAGED_BY = "paperclip-orchestrator";

export interface FleetAgentRecord {
  readonly id: string;
  readonly name: string;
  readonly adapterType: string;
  readonly reportsTo?: string | null | undefined;
  readonly metadata?: Record<string, unknown> | null | undefined;
  readonly status: string;
  readonly adapterConfig?: Record<string, unknown> | null | undefined;
  readonly errorReason?: string | null | undefined;
  readonly pauseReason?: string | null | undefined;
  readonly orgChainHealth?: {
    readonly status?: string | undefined;
    readonly reason?: string | undefined;
    readonly escalationWarning?: string | undefined;
  } | undefined;
}

/**
 * Independent Jules/Vibe/Antigravity agents stay on the company for other
 * workflows. The orchestrator may only mutate workers it owns.
 */
export function isManagedWorker(
  agent: FleetAgentRecord,
  orchestratorAgentId?: string | null
): boolean {
  if (agent.metadata?.["managedBy"] === MANAGED_BY) {
    return true;
  }
  const name = agent.name || "";
  if (!name.includes("[Orchestrated]")) {
    return false;
  }
  if (orchestratorAgentId && agent.reportsTo === orchestratorAgentId) {
    return true;
  }
  return name.startsWith("[Orchestrated]");
}

export function isJulesAdapterType(adapterType: string): boolean {
  return adapterType === "jules";
}

function supportsStructuredDecision(agent: FleetAgentRecord, kind: DecisionKind): boolean {
  const parsed = StructuredDecisionCapabilitySchema.safeParse(
    agent.metadata?.["structuredDecisionCapability"],
  );
  return parsed.success && parsed.data.decisionKinds.includes(kind);
}

export interface ManagedFleetIds {
  readonly managedIds: ReadonlySet<string>;
  readonly julesAgentId?: string | undefined;
  readonly vibeAgentId?: string | undefined;
  readonly vibeReviewerAgentId?: string | undefined;
  readonly antigravityAgentId?: string | undefined;
  readonly reviewerAgentId?: string | undefined;
  readonly lunaReviewerAgentId?: string | undefined;
  readonly terraReviewerAgentId?: string | undefined;
  readonly terraAdjudicatorAgentId?: string | undefined;
  readonly managedJulesIds: ReadonlySet<string>;
}

export function resolveManagedFleet(
  agents: readonly FleetAgentRecord[],
  orchestratorAgentId: string,
  configured?: {
    readonly julesAgentId?: string | undefined;
    readonly vibeAgentId?: string | undefined;
    readonly vibeReviewerAgentId?: string | undefined;
    readonly reviewerAgentId?: string | undefined;
    readonly lunaReviewerAgentId?: string | undefined;
    readonly terraReviewerAgentId?: string | undefined;
    readonly terraAdjudicatorAgentId?: string | undefined;
  }
): ManagedFleetIds {
  const managed = agents.filter((a) => isManagedWorker(a, orchestratorAgentId));
  const managedIds = new Set(managed.map((a) => a.id));

  const pick = (
    configuredId: string | undefined,
    predicate: (a: FleetAgentRecord) => boolean,
    eligible: (a: FleetAgentRecord) => boolean = () => true,
  ): string | undefined => {
    const configuredAgent = configuredId
      ? managed.find((agent) => agent.id === configuredId)
      : undefined;
    if (configuredAgent && predicate(configuredAgent) && eligible(configuredAgent)) {
      return configuredId;
    }
    return managed.find((agent) => predicate(agent) && eligible(agent))?.id;
  };

  const julesAgentId = pick(
    configured?.julesAgentId,
    (a) => a.adapterType === "jules" || a.name.toLowerCase().includes("jules")
  );
  const vibeAgentId = pick(
    configured?.vibeAgentId,
    (a) =>
      a.name === "[Orchestrated] Vibe Local Worker" ||
      (a.adapterType === "vibe" && !a.name.toLowerCase().includes("review"))
  );
  const vibeReviewerAgentId = pick(
    configured?.vibeReviewerAgentId,
    (a) =>
      a.name === "[Orchestrated] Vibe Fast Reviewer" ||
      (a.adapterType === "vibe" && a.name.toLowerCase().includes("review"))
  );
  const lunaReviewerAgentId = pick(
    configured?.lunaReviewerAgentId,
    (a) => a.metadata?.["workerKey"] === "luna_reviewer",
    (a) => supportsStructuredDecision(a, "pull_request_review"),
  );
  const antigravityAgentId = managed.find(
    (a) => a.adapterType === "antigravity" || a.name.toLowerCase().includes("antigravity")
  )?.id;
  const reviewerAgentId = pick(
    configured?.reviewerAgentId,
    (a) =>
      a.adapterType === "codex_local" ||
      a.name.toLowerCase().includes("reviewer") ||
      a.name.toLowerCase().includes("security")
  );
  const terraReviewerAgentId = pick(
    configured?.terraReviewerAgentId,
    (a) => (a.metadata?.["workerKey"] === "terra_reviewer" || a.name === "[Orchestrated] Terra Strong Reviewer" || a.name === "[Orchestrated] Code Reviewer") && a.adapterType === "codex_local",
    (a) => supportsStructuredDecision(a, "pull_request_review"),
  );
  const terraAdjudicatorAgentId = pick(
    configured?.terraAdjudicatorAgentId,
    (a) => (a.metadata?.["workerKey"] === "terra_adjudicator" || a.name === "[Orchestrated] Terra Jules Question Adjudicator") && a.adapterType === "codex_local",
  );

  const managedJulesIds = new Set(
    managed.filter((a) => isJulesAdapterType(a.adapterType)).map((a) => a.id)
  );

  return {
    managedIds,
    julesAgentId,
    vibeAgentId,
    vibeReviewerAgentId,
    antigravityAgentId,
    reviewerAgentId,
    lunaReviewerAgentId,
    terraReviewerAgentId,
    terraAdjudicatorAgentId,
    managedJulesIds,
  };
}
