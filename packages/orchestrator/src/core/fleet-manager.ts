export interface ManagedWorkerDefinition {
  readonly key: "jules" | "vibe" | "antigravity" | "reviewer";
  readonly name: string;
  readonly title: string;
  readonly adapterType: string;
  readonly role: "engineer" | "qa" | "security" | "general";
  readonly capabilities: string;
  readonly description: string;
  readonly adapterConfig: Record<string, unknown>;
}

export interface ManagedFleetConfig {
  readonly orchestratorAgentId?: string | undefined;
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
    title: "Cloud Asynchronous Developer",
    adapterType: "jules",
    role: "engineer",
    capabilities:
      "Executes approved tasks in isolated cloud environments using Google Jules. Performs surgical AST symbol modifications, executes reproducer test suites, and opens comprehensive pull requests with audit logs.",
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
    title: "Local ACP Implementation Specialist",
    adapterType: "vibe",
    role: "engineer",
    capabilities:
      "Local fast-path development lane. Executes targeted refactorings, autonomous Q&A clarification loops, and fast test verification via the local Agent Client Protocol (ACP).",
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
    title: "Deep Agentic Systems Engineer",
    adapterType: "antigravity",
    role: "engineer",
    capabilities:
      "Advanced local pair-programming and systems engineering via Google Antigravity ACP. Executes multi-step workflows, tool calls, and complex architectural investigations.",
    description: "Local pair-programming ACP worker executing tasks via Google Antigravity",
    adapterConfig: {
      pollCadenceSeconds: 0, // Strictly 0
      permissionMode: "approve-all",
    },
  },
  {
    key: "reviewer",
    name: "[Orchestrated] Code Reviewer",
    title: "Principal Systems & Security Code Reviewer",
    adapterType: "codex_local",
    role: "qa",
    capabilities:
      "Token-efficient code review specialist. Inspects PR diffs, validates declared AST target symbols, and provides structured approval recommendations. STRICT INVARIANT: NEVER POST ON GITHUB (no gh pr comment). Output verdict ONLY as Paperclip comments to be relayed to developer sessions.",
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
 * Configures rich titles, capabilities, zero-cadence scheduling, and direct reportsTo hierarchy.
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
    title?: string | null;
    capabilities?: string | null;
    adapterType: string;
    status?: string;
    reportsTo?: string | null;
    adapterConfig?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }>;

  // Resolve Orchestrator ID if not explicitly provided
  let managerId = config.orchestratorAgentId;
  if (!managerId) {
    const orchestratorAgent = existingAgents.find(
      (a) => a.adapterType === "orchestrator" || a.name.toLowerCase().includes("orchestrator")
    );
    if (orchestratorAgent) {
      managerId = orchestratorAgent.id;
    }
  }

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
      // Provision fresh managed worker reporting to orchestrator
      const createRes = await fetch(`${apiUrl}/api/companies/${companyId}/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: def.name,
          title: def.title,
          role: def.role,
          capabilities: def.capabilities,
          adapterType: def.adapterType,
          reportsTo: managerId || null,
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

      // Ensure title, capabilities, pollCadenceSeconds: 0, reportsTo, and status are in sync
      const needsUpdate =
        matching.title !== def.title ||
        matching.capabilities !== def.capabilities ||
        matching.adapterType !== def.adapterType ||
        matching.adapterConfig?.["pollCadenceSeconds"] !== 0 ||
        matching.status === "running" ||
        (managerId && matching.reportsTo !== managerId) ||
        matching.metadata?.["managedBy"] !== "paperclip-orchestrator";

      if (needsUpdate) {
        try {
          await fetch(`${apiUrl}/api/agents/${matching.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: def.title,
              capabilities: def.capabilities,
              adapterType: def.adapterType,
              status: "idle",
              errorReason: null,
              reportsTo: managerId || matching.reportsTo || null,
              adapterConfig: {
                ...matching.adapterConfig,
                ...mergedConfig,
                pollCadenceSeconds: 0,
              },
              metadata: {
                ...matching.metadata,
                managedBy: "paperclip-orchestrator",
                workerKey: def.key,
                description: def.description,
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
