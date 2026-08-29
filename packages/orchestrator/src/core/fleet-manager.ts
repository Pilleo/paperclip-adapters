export interface ManagedWorkerDefinition {
  readonly key: "jules" | "vibe" | "antigravity" | "reviewer";
  readonly name: string;
  readonly adapterType: string;
  readonly role: "engineer" | "qa" | "security" | "general";
  readonly description: string;
  readonly adapterConfig: Record<string, unknown>;
}

export interface ManagedFleetConfig {
  readonly repository?: string | undefined;
  readonly baseBranch?: string | undefined;
  readonly julesApiKeySecretId?: string | undefined;
  readonly julesApiKey?: string | undefined;
}

export interface ManagedFleetResolved {
  readonly julesAgentId?: string | undefined;
  readonly vibeAgentId?: string | undefined;
  readonly antigravityAgentId?: string | undefined;
  readonly reviewerAgentId?: string | undefined;
  readonly provisionedCount: number;
  readonly updatedCount: number;
}

export const MANAGED_FLEET_DEFINITIONS: readonly ManagedWorkerDefinition[] = Object.freeze([
  {
    key: "jules",
    name: "[Orchestrated] Jules Async Worker",
    adapterType: "jules",
    role: "engineer",
    description: "Cloud asynchronous developer executing approved tasks in isolation",
    adapterConfig: {
      pollCadenceSeconds: 0, // Strictly 0: No autonomous unprompted scheduling
      prPolicy: "auto",
      ciPolicy: "skip",
      automationMode: "AUTO_CREATE_PR",
      planApprovalPolicy: "required",
      retryBudget: 3,
      progressVerbosity: "normal",
    },
  },
  {
    key: "vibe",
    name: "[Orchestrated] Vibe Local Worker",
    adapterType: "vibe",
    role: "engineer",
    description: "Local ACP developer executing autonomous clarifications and small refactors",
    adapterConfig: {
      pollCadenceSeconds: 0, // Strictly 0
      permissionMode: "approve-all",
      instructionsBundle: true,
    },
  },
  {
    key: "antigravity",
    name: "[Orchestrated] Antigravity Local Worker",
    adapterType: "antigravity",
    role: "engineer",
    description: "Local pair-programming ACP worker executing tasks via Google Antigravity",
    adapterConfig: {
      pollCadenceSeconds: 0, // Strictly 0
      permissionMode: "approve-all",
    },
  },
  {
    key: "reviewer",
    name: "[Orchestrated] Code Reviewer",
    adapterType: "vibe",
    role: "qa",
    description: "Token-efficient code review specialist inspecting PRs, symbols, and invariants",
    adapterConfig: {
      pollCadenceSeconds: 0, // Strictly 0
      permissionMode: "read-only",
      instructionsBundle: true,
    },
  },
]);

/**
 * Reconciles and provisions the dedicated orchestrator-managed worker fleet in Paperclip.
 */
export async function reconcileManagedFleet(
  apiUrl: string,
  companyId: string,
  config: ManagedFleetConfig = {}
): Promise<ManagedFleetResolved> {
  const agentsRes = await fetch(`${apiUrl}/api/companies/${companyId}/agents`);
  if (!agentsRes.ok) {
    throw new Error(`Failed to fetch agents for company ${companyId}: ${agentsRes.statusText}`);
  }
  const existingAgents = (await agentsRes.json()) as Array<{
    id: string;
    name: string;
    adapterType: string;
    status?: string;
    adapterConfig?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }>;

  const resolvedIds: Record<string, string> = {};
  let provisionedCount = 0;
  let updatedCount = 0;

  for (const def of MANAGED_FLEET_DEFINITIONS) {
    // Look for existing managed agent by exact name or metadata tag
    const matching = existingAgents.find(
      (a) =>
        a.name === def.name ||
        (a.metadata?.["managedBy"] === "paperclip-orchestrator" && a.metadata?.["workerKey"] === def.key)
    );

    const mergedConfig: Record<string, unknown> = {
      ...def.adapterConfig,
      ...(def.key === "jules" && config.repository ? { repository: config.repository } : {}),
      ...(def.key === "jules" && config.baseBranch ? { baseBranch: config.baseBranch } : {}),
      ...(def.key === "jules" && config.julesApiKeySecretId
        ? {
            env: {
              JULES_API_KEY: {
                type: "secret_ref",
                version: "latest",
                secretId: config.julesApiKeySecretId,
              },
            },
          }
        : {}),
      ...(def.key === "jules" && config.julesApiKey ? { apiKey: config.julesApiKey } : {}),
    };

    if (!matching) {
      // Provision fresh managed worker
      const createRes = await fetch(`${apiUrl}/api/companies/${companyId}/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: def.name,
          adapterType: def.adapterType,
          role: def.role,
          status: "idle", // Idle by default: Only wakes on Orchestrator wakeup calls
          adapterConfig: mergedConfig,
          metadata: {
            managedBy: "paperclip-orchestrator",
            workerKey: def.key,
            immutableConfig: true,
            description: def.description,
          },
        }),
      });

      if (createRes.ok) {
        const created = (await createRes.json()) as { id: string };
        resolvedIds[def.key] = created.id;
        provisionedCount++;
      } else {
        const errText = await createRes.text();
        console.warn(`[FLEET] Failed to provision agent ${def.name}: ${errText}`);
      }
    } else {
      resolvedIds[def.key] = matching.id;

      // Ensure pollCadenceSeconds is 0 and status is idle to prevent scheduler takeover
      const needsUpdate =
        matching.adapterConfig?.["pollCadenceSeconds"] !== 0 ||
        matching.status === "running" ||
        matching.metadata?.["managedBy"] !== "paperclip-orchestrator";

      if (needsUpdate) {
        try {
          await fetch(`${apiUrl}/api/agents/${matching.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              status: "idle",
              adapterConfig: {
                ...matching.adapterConfig,
                ...mergedConfig,
                pollCadenceSeconds: 0,
              },
              metadata: {
                ...matching.metadata,
                managedBy: "paperclip-orchestrator",
                workerKey: def.key,
              },
            }),
          });
          updatedCount++;
        } catch {
          // patch failed
        }
      }
    }
  }

  return Object.freeze({
    julesAgentId: resolvedIds["jules"],
    vibeAgentId: resolvedIds["vibe"],
    antigravityAgentId: resolvedIds["antigravity"],
    reviewerAgentId: resolvedIds["reviewer"],
    provisionedCount,
    updatedCount,
  });
}
