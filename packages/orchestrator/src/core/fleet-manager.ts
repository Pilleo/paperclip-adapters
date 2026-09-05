export interface ManagedWorkerDefinition {
  readonly key: "jules" | "vibe" | "luna_reviewer" | "antigravity" | "terra_reviewer" | "terra_adjudicator";
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
  readonly authToken?: string | undefined;
  readonly repository?: string | undefined;
  readonly baseBranch?: string | undefined;
  readonly julesApiKeySecretId?: string | undefined;
  readonly julesApiKey?: string | undefined;
  readonly julesPlanApprovalPolicy?: "required" | "trusted_opt_out" | undefined;
  readonly vibeReviewerAgentId?: string | undefined;
  readonly reviewerAgentId?: string | undefined;
  readonly lunaReviewerAgentId?: string | undefined;
  readonly terraReviewerAgentId?: string | undefined;
  readonly terraAdjudicatorAgentId?: string | undefined;
  /** Managed workers whose reconciliation capability is known to be unavailable. */
  readonly skipWorkerKeys?: readonly ManagedWorkerDefinition["key"][] | undefined;
}

export interface ManagedFleetResolved {
  readonly julesAgentId?: string | undefined;
  readonly vibeAgentId?: string | undefined;
  readonly vibeReviewerAgentId?: string | undefined;
  readonly antigravityAgentId?: string | undefined;
  readonly reviewerAgentId?: string | undefined;
  readonly lunaReviewerAgentId?: string | undefined;
  readonly terraReviewerAgentId?: string | undefined;
  readonly provisionedCount: number;
  readonly updatedCount: number;
  readonly authorizationFailures: readonly FleetAuthorizationFailure[];
}

export interface FleetAuthorizationFailure {
  readonly capability: "agents:create" | "agents:configure";
  readonly workerKey: ManagedWorkerDefinition["key"];
  readonly agentId?: string | undefined;
  readonly status: number;
  readonly detail: string;
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
      pollCadenceSeconds: 300,
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
    // This is intentionally a separate identity from the writable Vibe
    // implementation lane. Paperclip execution policies address agents, not
    // roles, so reusing the developer here made a completed review eligible to
    // edit and push code.
    key: "luna_reviewer",
    name: "[Orchestrated] Luna Fast Reviewer",
    title: "Read-Only OpenAI Luna Code Reviewer",
    adapterType: "codex_local",
    role: "qa",
    capabilities:
      "Read-only, low-cost PR triage using OpenAI Luna. Inspects diffs and tests, then returns an explicit APPROVE or REQUEST_CHANGES verdict. Never edits files, creates commits, pushes branches, or opens pull requests.",
    description: "Read-only OpenAI Luna reviewer for the first PR review stage",
    adapterConfig: {
      pollCadenceSeconds: 0,
      permissionMode: "read-only",
      model: "gpt-5.6-luna",
      dangerouslyBypassApprovalsAndSandbox: false,
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
    key: "terra_reviewer",
    name: "[Orchestrated] Terra Strong Reviewer",
    title: "Principal Systems & Security Terra Code Reviewer",
    adapterType: "codex_local",
    role: "qa",
    capabilities:
      "Deep Terra code review specialist. Inspects PR diffs, validates declared AST target symbols, and provides structured approval recommendations. STRICT INVARIANT: NEVER POST ON GITHUB (no gh pr comment). Output verdict ONLY as Paperclip review cards.",
    description: "Read-only OpenAI Terra reviewer inspecting PRs, symbols, and invariants",
    adapterConfig: {
      pollCadenceSeconds: 0, // Strictly 0
      permissionMode: "read-only",
      model: "gpt-5.6-terra",
      dangerouslyBypassApprovalsAndSandbox: false,
      instructionsBundle: true,
      // ACPX validates cwd before the Vibe adapter can normalize it. Keep this
      // absolute for the local managed fleet; workspace-aware provisioning can
      // override it in deployments that use another checkout.
      cwd: "/home/leanid/Documents/code/java/paperclip-adapters",
    },
  },
]);

/**
 * Reconciles and provisions the dedicated orchestrator-managed worker fleet in Paperclip.
 * Configures rich titles, capabilities, supported heartbeat scheduling, and direct reportsTo hierarchy.
 */
export async function reconcileManagedFleet(
  apiUrl: string,
  companyId: string,
  config: ManagedFleetConfig = {}
): Promise<ManagedFleetResolved> {
  const requestInit = config.authToken
    ? { headers: { Authorization: `Bearer ${config.authToken}` } }
    : {};
  const agentsRes = await fetch(`${apiUrl}/api/companies/${companyId}/agents`, requestInit);
  if (!agentsRes.ok) {
    throw new Error(`Failed to fetch agents for company ${companyId}: ${agentsRes.statusText}`);
  }
  const rawAgents = (await agentsRes.json()) as
    | Array<{
        id: string;
        name: string;
        title?: string | null;
        capabilities?: string | null;
        adapterType: string;
        status?: string;
        reportsTo?: string | null;
        adapterConfig?: Record<string, unknown>;
        metadata?: Record<string, unknown>;
        runtimeConfig?: Record<string, unknown>;
      }>
    | { agents?: Array<{
        id: string;
        name: string;
        title?: string | null;
        capabilities?: string | null;
        adapterType: string;
        status?: string;
        reportsTo?: string | null;
        adapterConfig?: Record<string, unknown>;
        metadata?: Record<string, unknown>;
        runtimeConfig?: Record<string, unknown>;
      }> };
  const existingAgents = Array.isArray(rawAgents) ? rawAgents : rawAgents.agents ?? [];

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
  const authorizationFailures: FleetAuthorizationFailure[] = [];
  const blockedCapabilities = new Set<FleetAuthorizationFailure["capability"]>();

  // Review identities are reconciled first. Jules consumes their IDs in its
  // plan/question reviewer configuration, and must not be allowed to block
  // their provisioning when its own protected configuration is unauthorized.
  const reconciliationOrder = [...MANAGED_FLEET_DEFINITIONS].sort((left, right) => {
    const priority = (key: ManagedWorkerDefinition["key"]) =>
      key === "luna_reviewer" ? 0 : key === "terra_reviewer" ? 1 : key === "terra_adjudicator" ? 2 : 3;
    return priority(left.key) - priority(right.key);
  });

  for (const def of reconciliationOrder) {
    // Look for existing managed agent by exact name or metadata tag
    const matching = existingAgents.find(
      (a) =>
        a.name === def.name ||
        (def.key === "terra_reviewer" && a.name === "[Orchestrated] Code Reviewer") ||
        (a.metadata?.["managedBy"] === "paperclip-orchestrator" && a.metadata?.["workerKey"] === def.key)
    );

    // A deterministic authorization failure must not be retried on every
    // heartbeat. The caller owns the circuit and may clear it after an
    // authorization/configuration change; this pass preserves the identity
    // without attempting another forbidden write.
    if (config.skipWorkerKeys?.includes(def.key)) {
      if (matching) resolvedIds[def.key] = matching.id;
      continue;
    }

    const mergedConfig: Record<string, unknown> = {
      ...def.adapterConfig,
      ...(def.key === "jules" && config.repository ? { repository: config.repository } : {}),
      ...(def.key === "jules" && config.baseBranch ? { baseBranch: config.baseBranch } : {}),
      ...(def.key === "jules" && config.julesPlanApprovalPolicy
        ? { planApprovalPolicy: config.julesPlanApprovalPolicy }
        : {}),
      ...(def.key === "jules" && (resolvedIds["luna_reviewer"] ?? config.lunaReviewerAgentId ?? config.vibeReviewerAgentId) ? { planReviewerAgentId: resolvedIds["luna_reviewer"] ?? config.lunaReviewerAgentId ?? config.vibeReviewerAgentId } : {}),
      ...(def.key === "jules" && (resolvedIds["terra_reviewer"] ?? config.terraReviewerAgentId ?? config.reviewerAgentId) ? { planStrongReviewerAgentId: resolvedIds["terra_reviewer"] ?? config.terraReviewerAgentId ?? config.reviewerAgentId } : {}),
      ...(def.key === "jules" && (resolvedIds["terra_reviewer"] ?? config.terraReviewerAgentId ?? config.reviewerAgentId) ? { questionReviewerAgentId: resolvedIds["terra_reviewer"] ?? config.terraReviewerAgentId ?? config.reviewerAgentId } : {}),
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
      if (blockedCapabilities.has("agents:create")) continue;
      // Provision fresh managed worker reporting to orchestrator
      const createRes = await fetch(`${apiUrl}/api/companies/${companyId}/agents`, {
        method: "POST",
          headers: { "Content-Type": "application/json", ...(config.authToken ? { Authorization: `Bearer ${config.authToken}` } : {}) },
        body: JSON.stringify({
          name: def.name,
          title: def.title,
          role: def.role,
          capabilities: def.capabilities,
          adapterType: def.adapterType,
          reportsTo: managerId || null,
          status: "idle", // Idle by default: Only wakes on Orchestrator wakeup calls
          adapterConfig: mergedConfig,
            ...(def.key === "luna_reviewer" || def.key === "terra_reviewer" || def.key === "terra_adjudicator"
            ? {
                instructionsBundle: {
                  entryFile: "AGENTS.md",
                  files: { "AGENTS.md": def.key === "terra_adjudicator" ? JULES_ADJUDICATOR_INSTRUCTIONS : NATIVE_REVIEWER_INSTRUCTIONS },
                },
              }
            : {}),
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
        if (createRes.status === 401 || createRes.status === 403) {
          const failure: FleetAuthorizationFailure = { capability: "agents:create", workerKey: def.key, status: createRes.status, detail: errText.slice(0, 300) };
          authorizationFailures.push(failure);
          blockedCapabilities.add("agents:create");
          console.warn(`[FLEET] Authorization blocked ${def.key} reconciliation (${failure.capability}): ${errText}`);
          continue;
        }
        console.warn(`[FLEET] Failed to provision agent ${def.name}: ${errText}`);
      }
    } else {
      resolvedIds[def.key] = matching.id;

      // Ensure title, capabilities, heartbeat policy, reportsTo, and status are in sync.
      const runtimeConfig = desiredRuntimeConfig(def.key);
      const currentHeartbeat = (matching as { runtimeConfig?: Record<string, unknown> }).runtimeConfig?.["heartbeat"] as
        | Record<string, unknown>
        | undefined;
      const needsUpdate =
        matching.title !== def.title ||
        matching.capabilities !== def.capabilities ||
        matching.adapterType !== def.adapterType ||
        matching.name !== def.name ||
        matching.adapterConfig?.["pollCadenceSeconds"] !== mergedConfig["pollCadenceSeconds"] ||
        matching.adapterConfig?.["model"] !== mergedConfig["model"] ||
        matching.adapterConfig?.["dangerouslyBypassApprovalsAndSandbox"] !== mergedConfig["dangerouslyBypassApprovalsAndSandbox"] ||
        (def.key === "jules" && matching.adapterConfig?.["planApprovalPolicy"] !== mergedConfig["planApprovalPolicy"]) ||
        (def.key === "jules" && matching.adapterConfig?.["planReviewerAgentId"] !== mergedConfig["planReviewerAgentId"]) ||
        (def.key === "jules" && matching.adapterConfig?.["planStrongReviewerAgentId"] !== mergedConfig["planStrongReviewerAgentId"]) ||
        (def.key === "jules" && matching.adapterConfig?.["questionReviewerAgentId"] !== mergedConfig["questionReviewerAgentId"]) ||
        (def.key === "jules" && matching.adapterConfig?.["questionAdjudicatorAgentId"] !== mergedConfig["questionAdjudicatorAgentId"]) ||
        (def.key === "luna_reviewer" && matching.adapterConfig?.["cwd"] !== mergedConfig["cwd"]) ||
        (def.key === "jules" &&
          (currentHeartbeat?.["enabled"] !== true || currentHeartbeat?.["intervalSec"] !== 300 ||
            currentHeartbeat?.["wakeOnDemand"] !== true || currentHeartbeat?.["maxConcurrentRuns"] !== 1)) ||
        (managerId && matching.reportsTo !== managerId) ||
        matching.metadata?.["managedBy"] !== "paperclip-orchestrator" ||
        matching.metadata?.["workerKey"] !== def.key;

      if (needsUpdate) {
        if (blockedCapabilities.has("agents:configure")) continue;
        try {
          const patchRes = await fetch(`${apiUrl}/api/agents/${matching.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", ...(config.authToken ? { Authorization: `Bearer ${config.authToken}` } : {}) },
            body: JSON.stringify({
              name: def.name,
              title: def.title,
              capabilities: def.capabilities,
              adapterType: def.adapterType,
              errorReason: null,
              reportsTo: managerId || matching.reportsTo || null,
              adapterConfig: {
                ...matching.adapterConfig,
                ...mergedConfig,
                ...(def.key === "jules" ? { pollCadenceSeconds: 300 } : { pollCadenceSeconds: 0 }),
              },
              ...(desiredRuntimeConfig ? { runtimeConfig: desiredRuntimeConfig } : {}),
              metadata: {
                ...matching.metadata,
                managedBy: "paperclip-orchestrator",
                workerKey: def.key,
                description: def.description,
              },
            }),
          });
          if (patchRes.status === 401 || patchRes.status === 403) {
            const failure: FleetAuthorizationFailure = { capability: "agents:configure", workerKey: def.key, agentId: matching.id, status: patchRes.status, detail: (await patchRes.text()).slice(0, 300) };
            authorizationFailures.push(failure);
            blockedCapabilities.add("agents:configure");
            console.warn(`[FLEET] Authorization blocked ${def.key} reconciliation (${failure.capability}): ${failure.detail}`);
            continue;
          }
          if (patchRes.ok) updatedCount++;
        } catch {
          // patch failed
        }
      }
    }
  }

  return Object.freeze({
    julesAgentId: resolvedIds["jules"],
    vibeAgentId: resolvedIds["vibe"],
    // Deprecated aliases retained for callers during the Luna/Terra migration.
    vibeReviewerAgentId: resolvedIds["luna_reviewer"],
    antigravityAgentId: resolvedIds["antigravity"],
    reviewerAgentId: resolvedIds["terra_reviewer"],
    lunaReviewerAgentId: resolvedIds["luna_reviewer"],
    terraReviewerAgentId: resolvedIds["terra_reviewer"],
    provisionedCount,
    updatedCount,
    authorizationFailures,
  });
}
