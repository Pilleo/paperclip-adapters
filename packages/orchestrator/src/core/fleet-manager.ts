import os from "node:os";
import path from "node:path";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import { JULES_PROVIDER_POLL_CADENCE_SECONDS } from "@pilleo/paperclip-adapter-common";
import { resolveNativeReviewMcpHome, type NativeReviewWorkerKey } from "./native-review-mcp-home.js";

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
  readonly runId?: string | undefined;
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

/** Reviewers are event-driven: timer polling is off, but addressed native
 * cards must be allowed to wake them. One run at a time prevents duplicate
 * reviewer invocations from consuming quota during reconciliation/restarts. */
type ManagedRuntimeConfig = {
  readonly heartbeat: {
    readonly enabled: boolean;
    readonly intervalSec?: number;
    readonly wakeOnDemand: boolean;
    readonly maxConcurrentRuns: number;
    readonly skipTimerWhenNoActionableWork?: boolean;
  };
};

const EVENT_DRIVEN_REVIEW_RUNTIME_CONFIG: ManagedRuntimeConfig = Object.freeze({
  heartbeat: Object.freeze({
    enabled: false,
    wakeOnDemand: true,
    maxConcurrentRuns: 1,
    skipTimerWhenNoActionableWork: true,
  }),
});

function desiredRuntimeConfig(workerKey: ManagedWorkerDefinition["key"]): ManagedRuntimeConfig | undefined {
  if (workerKey === "jules") {
    return {
      heartbeat: { enabled: true, intervalSec: JULES_PROVIDER_POLL_CADENCE_SECONDS, wakeOnDemand: true, maxConcurrentRuns: 1 },
    };
  }
  if (workerKey === "luna_reviewer" || workerKey === "terra_reviewer" || workerKey === "terra_adjudicator") {
    return EVENT_DRIVEN_REVIEW_RUNTIME_CONFIG;
  }
  return undefined;
}

/**
 * Built-in adapters may use Paperclip's implicit trusted actor on loopback;
 * requiring an API key there made disposable companies unable to provision the
 * managed reviewer fleet. Remote deployments still require an explicit token.
 */
export function canReconcileManagedFleet(
  apiUrl: string,
  authToken: string | undefined,
  enabled = true,
): boolean {
  if (!enabled) return false;
  if (typeof authToken === "string" && authToken.trim().length > 0) return true;
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(apiUrl.replace(/\/+$/, ""));
}

export const NATIVE_REVIEW_PROTOCOL_VERSION = "v10" as const;

const NATIVE_REVIEW_DECISION_CAPABILITY = Object.freeze({
  version: 1 as const,
  transports: ["mcp_tool"] as const,
  decisionKinds: ["plan_review", "pull_request_review"] as const,
});

/**
 * The only model-facing control-plane operation is the managed stdio MCP
 * tool. It inherits a run-scoped Paperclip bridge, so no secret is rendered in
 * a prompt/config and no shell command is needed for a verdict.
 *
 * Paperclip already places the reviewer inside an outer Bubblewrap boundary.
 * A nested Codex sandbox cannot create its own process namespace there and
 * fails with EPERM before the MCP tool is called. Bypass the inner Codex
 * wrapper and do not request Paperclip's local Bubblewrap network wrapper for
 * this special loopback reviewer lane; otherwise the two process boundaries
 * conflict. The reviewer remains read-only and uses the host's configured
 * network/proxy policy. `--approve-for-me` must stay out of extraArgs because
 * Codex rejects it together with this bypass flag.
 */
const NATIVE_REVIEW_CONTROL_PLANE_TRANSPORT = Object.freeze({
  engine: "cli",
  dangerouslyBypassApprovalsAndSandbox: true,
  extraArgs: [],
});

function nativeReviewMcpHomeFor(companyId: string, key: NativeReviewWorkerKey): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: process.env["PAPERCLIP_HOME"]?.trim() || path.join(os.homedir(), ".paperclip"),
    instanceId: process.env["PAPERCLIP_INSTANCE_ID"]?.trim() || "default",
    env: process.env,
  });
  return resolveNativeReviewMcpHome({ instanceRoot, companyId, workerKey: key });
}

function isNativeReviewWorker(key: ManagedWorkerDefinition["key"]): key is NativeReviewWorkerKey {
  return key === "luna_reviewer" || key === "terra_reviewer" || key === "terra_adjudicator";
}

const LEGACY_NATIVE_REVIEWER_INSTRUCTIONS = `# Native Review Role

Review the assigned pull request in read-only mode. Never edit, stage, commit, push, merge, open a PR, or post a normal issue comment.

The review decision must be delivered through the one pending Paperclip request_item_verdicts card addressed to this agent. Do not copy an interaction UUID or item id from instructions or prose: both are server-owned and must be discovered at submission time. Use only approve or reject; reject requires a concrete actionable reason.

After deciding, run this exact command, replacing only DECISION with approve/reject and REASON with the rejection reason (use an empty string for approve). It resolves the unique addressed pending card, derives its item id, submits the structured verdict, and verifies that the same card became answered. Do not replace it with curl, a normal comment, or a prose review:

DECISION=approve REASON='' node --input-type=module - <<'PAPERCLIP_NATIVE_REVIEW
const verdict = process.env.DECISION;
const reason = (process.env.REASON ?? '').trim();
const base = (process.env.PAPERCLIP_API_URL ?? '').replace(/\\/+$/, '').replace(/\\/api$/, '');
const issueId = process.env.PAPERCLIP_TASK_ID;
const agentId = process.env.PAPERCLIP_AGENT_ID;
const token = process.env.PAPERCLIP_API_KEY;
if (!['approve', 'reject'].includes(verdict) || !base || !issueId || !agentId || !token || (verdict === 'reject' && !reason)) process.exit(2);
const headers = { Authorization: \`Bearer \${token}\`, 'Content-Type': 'application/json' };
const list = await fetch(\`\${base}/api/issues/\${encodeURIComponent(issueId)}/interactions\`, { headers });
if (!list.ok) process.exit(3);
const cards = await list.json();
const owned = cards.filter((card) => card.kind === 'request_item_verdicts' && card.status === 'pending' && card.addresseeAgentId === agentId);
if (owned.length !== 1 || !Array.isArray(owned[0].payload?.items) || owned[0].payload.items.length !== 1 || typeof owned[0].payload.items[0].id !== 'string') process.exit(4);
const card = owned[0];
const itemId = card.payload.items[0].id;
const submitted = await fetch(\`\${base}/api/issues/\${encodeURIComponent(issueId)}/interactions/\${encodeURIComponent(card.id)}/verdicts\`, { method: 'POST', headers, body: JSON.stringify({ verdicts: [{ id: itemId, verdict, ...(verdict === 'reject' ? { reason } : {}) }] }) });
if (!submitted.ok) process.exit(5);
const result = await submitted.json().catch(() => null);
if (result?.id !== card.id || result?.status !== 'answered' || result?.result?.items?.find((item) => item.id === itemId)?.verdict !== verdict) process.exit(6);
PAPERCLIP_NATIVE_REVIEW

If any validation or HTTP step fails, stop with the non-zero result. Do not retry with a different id, create another card, or post a fallback comment.`;

const NATIVE_REVIEWER_INSTRUCTIONS = `# Native Review Role

Review the assigned pull request in read-only mode. Never edit, stage, commit, push, merge, open a PR, or post a normal issue comment.

Make a decision only for the pending Paperclip review card addressed to you.
Call the paperclip_review.submit_native_review_verdict MCP tool exactly once:

- approve: {"verdict":"approve"}
- request changes: {"verdict":"reject","reason":"concrete actionable reason"}

The tool, not model prose, resolves the card and item from the run-scoped
identity, submits the native verdict, and verifies Paperclip's response. Do
not use shell commands, curl, node_repl, normal comments, or a fallback path
to deliver a review decision. If the tool reports an error, stop; do not retry
with a different identifier or create a new card.`;

const JULES_ADJUDICATOR_INSTRUCTIONS = `# Jules Question Adjudicator Role

Answer only the exact quoted Jules provider question from the assigned issue.
Do not inspect or modify a checkout, diff, tests, branch, pull request, GitHub,
or repository files. Do not leave a prose review and do not use Paperclip review
verdict endpoints.

Post exactly one issue comment containing one JSON object, with no Markdown fence:
{"kind":"ANSWER","answer":"direct operational instruction for Jules"}
or
{"kind":"ESCALATE","reason":"the concrete decision the human must make"}

Then mark the adjudication issue done. Generic continue/commit/submit questions
must receive the direct workflow instruction declared by the parent task. Escalate
only when that contract lacks a concrete product, authorization, or destructive
decision.`;

function reviewerInstructionsFor(key: ManagedWorkerDefinition["key"]): string | null {
  if (key === "terra_adjudicator") return JULES_ADJUDICATOR_INSTRUCTIONS;
  if (key === "luna_reviewer" || key === "terra_reviewer") return NATIVE_REVIEWER_INSTRUCTIONS;
  return null;
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
      pollCadenceSeconds: JULES_PROVIDER_POLL_CADENCE_SECONDS,
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
      promptTemplate: NATIVE_REVIEWER_INSTRUCTIONS,
      ...NATIVE_REVIEW_CONTROL_PLANE_TRANSPORT,
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
      promptTemplate: NATIVE_REVIEWER_INSTRUCTIONS,
      ...NATIVE_REVIEW_CONTROL_PLANE_TRANSPORT,
      instructionsBundle: true,
      // ACPX validates cwd before the Vibe adapter can normalize it. Keep this
      // absolute for the local managed fleet; workspace-aware provisioning can
      // override it in deployments that use another checkout.
      cwd: "/home/leanid/Documents/code/java/paperclip-adapters",
    },
  },
  {
    key: "terra_adjudicator",
    name: "[Orchestrated] Terra Jules Question Adjudicator",
    title: "Principal Terra Jules Question Adjudicator",
    adapterType: "codex_local",
    role: "qa",
    capabilities:
      "Read-only Terra adjudicator for Jules provider questions. Emits strict ANSWER or ESCALATE JSON and never reviews code or posts prose.",
    description: "Dedicated Terra ACP adjudicator for Jules provider-question protocol",
    adapterConfig: {
      pollCadenceSeconds: 0,
      permissionMode: "read-only",
      model: "gpt-5.6-terra",
      ...NATIVE_REVIEW_CONTROL_PLANE_TRANSPORT,
      instructionsBundle: true,
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
  const headers = {
    ...(config.authToken ? { Authorization: `Bearer ${config.authToken}` } : {}),
    ...(config.runId ? { "X-Paperclip-Run-Id": config.runId } : {}),
  };
  const requestInit = Object.keys(headers).length > 0 ? { headers } : {};
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
    const matchingCandidates = existingAgents.filter(
      (a) =>
        a.name === def.name ||
        (def.key === "terra_reviewer" && a.name === "[Orchestrated] Code Reviewer") ||
        (a.metadata?.["managedBy"] === "paperclip-orchestrator" && a.metadata?.["workerKey"] === def.key)
    );
    // Prefer an already migrated structured reviewer over its legacy identity.
    // This makes the create-only compatibility replacement idempotent across
    // heartbeats even while Paperclip still denies configuration of the old row.
    const matching =
      matchingCandidates.find(
        (agent) =>
          (def.key === "luna_reviewer" || def.key === "terra_reviewer") &&
          JSON.stringify(agent.metadata?.["structuredDecisionCapability"] ?? null) ===
            JSON.stringify(NATIVE_REVIEW_DECISION_CAPABILITY),
      ) ?? matchingCandidates[0];

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
      ...(isNativeReviewWorker(def.key)
        ? { env: { CODEX_HOME: nativeReviewMcpHomeFor(companyId, def.key) } }
        : {}),
      ...(def.key === "jules" && config.repository ? { repository: config.repository } : {}),
      ...(def.key === "jules" && config.baseBranch ? { baseBranch: config.baseBranch } : {}),
      ...(def.key === "jules" && config.julesPlanApprovalPolicy
        ? { planApprovalPolicy: config.julesPlanApprovalPolicy }
        : {}),
      ...(def.key === "jules" && (resolvedIds["luna_reviewer"] ?? config.lunaReviewerAgentId ?? config.vibeReviewerAgentId) ? { planReviewerAgentId: resolvedIds["luna_reviewer"] ?? config.lunaReviewerAgentId ?? config.vibeReviewerAgentId } : {}),
      ...(def.key === "jules" && (resolvedIds["terra_reviewer"] ?? config.terraReviewerAgentId ?? config.reviewerAgentId) ? { planStrongReviewerAgentId: resolvedIds["terra_reviewer"] ?? config.terraReviewerAgentId ?? config.reviewerAgentId } : {}),
      ...(def.key === "jules" && (resolvedIds["terra_reviewer"] ?? config.terraReviewerAgentId ?? config.reviewerAgentId) ? { questionReviewerAgentId: resolvedIds["terra_reviewer"] ?? config.terraReviewerAgentId ?? config.reviewerAgentId } : {}),
      ...(def.key === "jules" && resolvedIds["terra_adjudicator"] ? { questionAdjudicatorAgentId: resolvedIds["terra_adjudicator"], questionReviewerAgentId: resolvedIds["terra_adjudicator"] } : {}),
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

    const createManagedWorker = async (replacesAgentId?: string) => {
      const replacement = Boolean(replacesAgentId);
      const { promptTemplate: _legacyPromptTemplate, ...createAdapterConfig } = mergedConfig;
      return fetch(`${apiUrl}/api/companies/${companyId}/agents`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          // Paperclip 2026.831 protects configuration updates with a granular
          // grant that cannot currently be assigned to agent principals via
          // its public API. A versioned name lets the adapter atomically create
          // a capable replacement without colliding with the legacy identity.
          name: replacement ? `${def.name} [${NATIVE_REVIEW_PROTOCOL_VERSION}]` : def.name,
          title: def.title,
          role: def.role,
          capabilities: def.capabilities,
          adapterType: def.adapterType,
          reportsTo: managerId || null,
          status: "idle",
          // New Paperclip agents materialize prompts from instructionsBundle;
          // sending the retired promptTemplate field is rejected with 422.
          adapterConfig: createAdapterConfig,
          ...(def.key === "luna_reviewer" || def.key === "terra_reviewer" || def.key === "terra_adjudicator"
            ? {
                instructionsBundle: {
                  entryFile: "AGENTS.md",
                  files: { "AGENTS.md": reviewerInstructionsFor(def.key)! },
                },
              }
            : {}),
          ...(desiredRuntimeConfig(def.key) ? { runtimeConfig: desiredRuntimeConfig(def.key) } : {}),
          metadata: {
            managedBy: "paperclip-orchestrator",
            workerKey: def.key,
            immutableConfig: true,
            description: def.description,
            ...(replacesAgentId ? { replacesAgentId } : {}),
            ...(reviewerInstructionsFor(def.key) ? { nativeReviewProtocolVersion: NATIVE_REVIEW_PROTOCOL_VERSION } : {}),
            ...(def.key === "luna_reviewer" || def.key === "terra_reviewer"
              ? { structuredDecisionCapability: NATIVE_REVIEW_DECISION_CAPABILITY }
              : {}),
          },
        }),
      });
    };

    if (!matching) {
      if (blockedCapabilities.has("agents:create")) continue;
      // Provision fresh managed worker reporting to orchestrator
      const createRes = await createManagedWorker();

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
        matching.adapterConfig?.["engine"] !== mergedConfig["engine"] ||
        matching.adapterConfig?.["model"] !== mergedConfig["model"] ||
        matching.adapterConfig?.["dangerouslyBypassApprovalsAndSandbox"] !== mergedConfig["dangerouslyBypassApprovalsAndSandbox"] ||
        JSON.stringify(matching.adapterConfig?.["extraArgs"] ?? []) !== JSON.stringify(mergedConfig["extraArgs"] ?? []) ||
        JSON.stringify(matching.adapterConfig?.["networkScope"] ?? null) !== JSON.stringify(mergedConfig["networkScope"] ?? null) ||
        JSON.stringify(matching.adapterConfig?.["networkAllowlist"] ?? []) !== JSON.stringify(mergedConfig["networkAllowlist"] ?? []) ||
        (isNativeReviewWorker(def.key) && matching.adapterConfig?.["promptTemplate"] !== mergedConfig["promptTemplate"]) ||
        (def.key === "jules" && matching.adapterConfig?.["planApprovalPolicy"] !== mergedConfig["planApprovalPolicy"]) ||
        (def.key === "jules" && matching.adapterConfig?.["planReviewerAgentId"] !== mergedConfig["planReviewerAgentId"]) ||
        (def.key === "jules" && matching.adapterConfig?.["planStrongReviewerAgentId"] !== mergedConfig["planStrongReviewerAgentId"]) ||
        (def.key === "jules" && matching.adapterConfig?.["questionReviewerAgentId"] !== mergedConfig["questionReviewerAgentId"]) ||
        (def.key === "jules" && matching.adapterConfig?.["questionAdjudicatorAgentId"] !== mergedConfig["questionAdjudicatorAgentId"]) ||
        (def.key === "luna_reviewer" && matching.adapterConfig?.["cwd"] !== mergedConfig["cwd"]) ||
        (isNativeReviewWorker(def.key) && JSON.stringify(matching.adapterConfig?.["env"] ?? {}) !== JSON.stringify(mergedConfig["env"] ?? {})) ||
        (runtimeConfig && (
          currentHeartbeat?.["enabled"] !== runtimeConfig.heartbeat["enabled"] ||
          (runtimeConfig.heartbeat["intervalSec"] !== undefined && currentHeartbeat?.["intervalSec"] !== runtimeConfig.heartbeat["intervalSec"]) ||
          currentHeartbeat?.["wakeOnDemand"] !== runtimeConfig.heartbeat["wakeOnDemand"] ||
          currentHeartbeat?.["maxConcurrentRuns"] !== runtimeConfig.heartbeat["maxConcurrentRuns"] ||
          (runtimeConfig.heartbeat["skipTimerWhenNoActionableWork"] !== undefined && currentHeartbeat?.["skipTimerWhenNoActionableWork"] !== runtimeConfig.heartbeat["skipTimerWhenNoActionableWork"])
        )) ||
        (managerId && matching.reportsTo !== managerId) ||
        matching.metadata?.["managedBy"] !== "paperclip-orchestrator" ||
        matching.metadata?.["workerKey"] !== def.key ||
        (reviewerInstructionsFor(def.key) !== null && matching.metadata?.["nativeReviewProtocolVersion"] !== NATIVE_REVIEW_PROTOCOL_VERSION) ||
        ((def.key === "luna_reviewer" || def.key === "terra_reviewer") &&
          JSON.stringify(matching.metadata?.["structuredDecisionCapability"] ?? null) !== JSON.stringify(NATIVE_REVIEW_DECISION_CAPABILITY));

      if (needsUpdate) {
        try {
          // Managed workers are fully owned by this adapter. Replacing the
          // config is intentional: merging would preserve retired fields such
          // as the nested Bubblewrap network wrapper forever.
          const reconciledAdapterConfig = { ...mergedConfig };
          const patchRes = await fetch(`${apiUrl}/api/agents/${matching.id}`, {
            method: "PATCH",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({
              name: def.name,
              title: def.title,
              capabilities: def.capabilities,
              adapterType: def.adapterType,
              errorReason: null,
              reportsTo: managerId || matching.reportsTo || null,
              ...(isNativeReviewWorker(def.key) ? { replaceAdapterConfig: true } : {}),
              adapterConfig: {
                ...reconciledAdapterConfig,
                ...(def.key === "jules" ? { pollCadenceSeconds: JULES_PROVIDER_POLL_CADENCE_SECONDS } : { pollCadenceSeconds: 0 }),
              },
              ...(runtimeConfig ? { runtimeConfig } : {}),
              metadata: {
                ...matching.metadata,
                managedBy: "paperclip-orchestrator",
                workerKey: def.key,
                description: def.description,
                ...(reviewerInstructionsFor(def.key) ? { nativeReviewProtocolVersion: NATIVE_REVIEW_PROTOCOL_VERSION } : {}),
                ...(def.key === "luna_reviewer" || def.key === "terra_reviewer"
                  ? { structuredDecisionCapability: NATIVE_REVIEW_DECISION_CAPABILITY }
                  : {}),
              },
            }),
          });
          if (patchRes.status === 401 || patchRes.status === 403) {
            const failure: FleetAuthorizationFailure = { capability: "agents:configure", workerKey: def.key, agentId: matching.id, status: patchRes.status, detail: (await patchRes.text()).slice(0, 300) };
            authorizationFailures.push(failure);
            console.warn(`[FLEET] Authorization blocked ${def.key} reconciliation (${failure.capability}): ${failure.detail}`);
            const missingStructuredCapability =
              (def.key === "luna_reviewer" || def.key === "terra_reviewer") &&
              JSON.stringify(matching.metadata?.["structuredDecisionCapability"] ?? null) !==
                JSON.stringify(NATIVE_REVIEW_DECISION_CAPABILITY);
            if (missingStructuredCapability && !blockedCapabilities.has("agents:create")) {
              const replacementRes = await createManagedWorker(matching.id);
              if (replacementRes.ok) {
                const replacement = (await replacementRes.json()) as { id: string };
                resolvedIds[def.key] = replacement.id;
                provisionedCount++;
              } else if (replacementRes.status === 401 || replacementRes.status === 403) {
                const replacementFailure: FleetAuthorizationFailure = {
                  capability: "agents:create",
                  workerKey: def.key,
                  status: replacementRes.status,
                  detail: (await replacementRes.text()).slice(0, 300),
                };
                authorizationFailures.push(replacementFailure);
                blockedCapabilities.add("agents:create");
              }
            }
            continue;
          }
          if (patchRes.ok) {
            updatedCount++;
            const reviewerInstructions = reviewerInstructionsFor(def.key);
            if (reviewerInstructions) {
              const instructionsRes = await fetch(`${apiUrl}/api/agents/${matching.id}/instructions-bundle/file`, {
                method: "PUT",
                headers: { ...headers, "Content-Type": "application/json" },
                body: JSON.stringify({ path: "AGENTS.md", content: reviewerInstructions }),
              });
              if (!instructionsRes.ok) {
                console.warn(`[FLEET] Failed to refresh ${def.key} instructions bundle (${instructionsRes.status})`);
              }
            }
          }
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
    terraAdjudicatorAgentId: resolvedIds["terra_adjudicator"],
    provisionedCount,
    updatedCount,
    authorizationFailures,
  });
}
