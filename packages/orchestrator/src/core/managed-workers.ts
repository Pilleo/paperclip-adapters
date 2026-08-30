export const MANAGED_BY = "paperclip-orchestrator";

export interface FleetAgentRecord {
  readonly id: string;
  readonly name: string;
  readonly adapterType: string;
  readonly reportsTo?: string | null | undefined;
  readonly metadata?: Record<string, unknown> | null | undefined;
  readonly status: string;
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

export interface ManagedFleetIds {
  readonly managedIds: ReadonlySet<string>;
  readonly julesAgentId?: string | undefined;
  readonly vibeAgentId?: string | undefined;
  readonly antigravityAgentId?: string | undefined;
  readonly reviewerAgentId?: string | undefined;
  readonly managedJulesIds: ReadonlySet<string>;
}

export function resolveManagedFleet(
  agents: readonly FleetAgentRecord[],
  orchestratorAgentId: string,
  configured?: {
    readonly julesAgentId?: string | undefined;
    readonly vibeAgentId?: string | undefined;
    readonly reviewerAgentId?: string | undefined;
  }
): ManagedFleetIds {
  const managed = agents.filter((a) => isManagedWorker(a, orchestratorAgentId));
  const managedIds = new Set(managed.map((a) => a.id));

  const pick = (
    configuredId: string | undefined,
    predicate: (a: FleetAgentRecord) => boolean
  ): string | undefined => {
    if (configuredId && managedIds.has(configuredId)) {
      return configuredId;
    }
    return managed.find(predicate)?.id;
  };

  const julesAgentId = pick(
    configured?.julesAgentId,
    (a) => a.adapterType === "jules" || a.name.toLowerCase().includes("jules")
  );
  const vibeAgentId = pick(
    configured?.vibeAgentId,
    (a) => a.adapterType === "vibe" || a.name.toLowerCase().includes("vibe")
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

  const managedJulesIds = new Set(
    managed.filter((a) => isJulesAdapterType(a.adapterType)).map((a) => a.id)
  );

  return {
    managedIds,
    julesAgentId,
    vibeAgentId,
    antigravityAgentId,
    reviewerAgentId,
    managedJulesIds,
  };
}
