import { checkPrMergeability, evaluatePrMergeability } from "../core/git-safety.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

// Paperclip 2026.824 can return a stale reviewer-owned issue projection to a
// subsequent heartbeat after the operator gate was reconciled. Keep a local
// idempotency fence so that projection drift cannot turn the same successful
// repair into a write every minute. The key includes the durable approval;
// restarting the adapter safely revalidates the current state once.
const reconciledOperatorGates = new Set<string>();

import { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { WorkerFeedbackEnvelope } from "@pilleo/paperclip-adapter-common";
import { extractIssueMetadata, resolvePaperclipProject, resolveProjectWorkspace, type PaperclipProjectRecord } from "../core/parser.js";
import { calculateConflictMatrix, selectNextTasksMultiLane } from "../core/dispatcher.js";
import { fetchJulesQuota } from "../core/jules-quota.js";
import { checkWorkspaceConsistency } from "../core/consistency.js";
import { fetchGitHubPullRequests, hasUnreviewedReadyPullRequest, matchPrToIssue, registeredPullRequestFromIssue, checkPrCiIsGreen, fetchPullRequestHeadSha } from "../core/github-sync.js";
import { evaluateIssueTransition } from "../core/state-machine.js";
import { readWorkspaceGitRemote, syncBacklogMarkdownToPaperclip } from "../core/backlog-sync.js";
import { archiveResolvedBacklogFiles } from "../core/backlog-archiver.js";
import { selectClarificationCandidates } from "../core/clarifier.js";
import { ParsedIssueMetadata } from "../core/types.js";
import {
  evaluateTaskStartApproval,
  evaluatePrMergeApproval,
  shouldReclaimUnapprovedStart,
  PaperclipApprovalSummary,
} from "../core/approvals.js";
import { formatOrchestratorDashboardCard } from "../core/telemetry-card.js";
import { identifyStalledIssues } from "../core/stalled-session-reaper.js";
import { hasDelegatedReviewChild, hasDelegatedReviewHistory, isDelegatedReviewChild } from "../core/recovery-eligibility.js";
import { evaluateReviewPipelineProgress, hasStaleReviewerOwnership, isReviewDispatchDecision, operatorGateReconciliationPatch, reviewDispatchStage } from "../core/review-pipeline.js";
import { buildReviewInteractionRequest, hasNativeRejectionForHead, isCanonicalReviewCardKey, isReviewInteractionForIssue, planReviewDialog, reviewInteractionIdempotencyKey, reviewInteractionIdempotencyKeys, selectReviewAttempt, selectReviewCardsToWithdrawAfterRejection, type PrReviewStage } from "../core/review-interaction-state.js";
import { findReviewCardBinding } from "../core/review-session-state.js";
import {
  buildMazewallExecutionPolicy,
  NATIVE_PR_REVIEW_STAGE_IDS,
  issueHasExecutionPolicy,
  issueHasUnsafeVibeReviewParticipant,
  issueNeedsExecutionPolicyBackfill,
} from "../core/execution-policy.js";
import { rebasePrBranchLocally } from "../core/local-rebase.js";
import { evaluateAgentHealth, AgentHealthReport } from "../core/agent-health-monitor.js";
import { mergeAuditMarker, synthesizeAuditDigest } from "../core/audit-digest.js";
import { decidePullRequestReconciliation } from "../core/pull-request-reconciliation.js";
import { resolveManagedFleet, type FleetAgentRecord } from "../core/managed-workers.js";
import { MANAGED_FLEET_DEFINITIONS, canReconcileManagedFleet, reconcileManagedFleet } from "../core/fleet-manager.js";
import { asArray, createPaperclipHttp, issuePatch } from "../core/paperclip-http.js";
import {
  liveHeartbeatIssueIds,
  parseHeartbeatRun,
  selectSessionContinuations,
  type ContinuationWorker,
  type HeartbeatRunSummary,
} from "../core/session-continuation.js";
import {
  JULES_SUPERVISOR_MARKER,
  selectJulesSupervisorActions,
  selectJulesSupervisorIssueIdsToClose,
} from "../core/jules-supervisor.js";
import { capabilityCircuit } from "../core/capability-circuit.js";
import { evaluateReviewerEligibility, isReviewerEligibilityFailure } from "../core/reviewer-eligibility.js";
import { buildReviewWaitState, isReviewWaitState } from "../core/review-wait-state.js";
import { isSameReviewerUnavailableRecovery, reviewerUnavailableRecoveryPayload } from "../core/review-recovery.js";
import { canPromoteJulesPrToReview, isAuthoritativeJulesMonitor } from "../core/jules-monitor-state.js";
import { decideIssueLifecycleReconciliation } from "../core/issue-lifecycle-reconciliation.js";
import { ConvergenceGuard } from "../core/convergence-guard.js";
import { planTerminalParentBarrier } from "../core/terminal-parent-barrier.js";
import { buildJulesMonitorReattachment, decideJulesMonitorReconciliation } from "../core/jules-monitor-reconciliation.js";
import { needsFullIssueRecord } from "../core/issue-enrichment-policy.js";
import { planBoardReconciliation, type BoardIssueSnapshot } from "../core/board-reconciliation.js";
import { decideBlockedManagedWork, decideRecoveryArtifact } from "../core/recovery-artifact.js";
import { allocateProjectCapacity } from "../core/project-capacity.js";
import { isProjectWorkspaceDirectory } from "../core/project-workspaces.js";
import { IncidentDeduper } from "../core/incident-deduper.js";
import { runProjectWorkerPool } from "../core/project-worker-pool.js";
import { planOrphanReviewRecovery } from "../core/orphan-review-recovery.js";
import { decideReviewSession } from "../core/review-session-state.js";
import type { IssueState } from "../core/types.js";
import { selectStaleJulesReviewChildren } from "../core/stale-review-artifacts.js";
import { executePaperclipCommand } from "@pilleo/paperclip-adapter-common";

// One orchestrator process can receive overlapping Paperclip heartbeats. Keep
// merge effects single-flight so concurrent ticks cannot duplicate comments or
// otherwise race on the same issue. The board is still re-read on each tick;
// this only protects the read/decide/write window within this adapter process.
const mergeConvergenceGuard = new ConvergenceGuard();
const lifecycleConvergenceGuard = new ConvergenceGuard();
// A stale reviewer card must be withdrawn exactly once after a structured
// rejection. Without this fence, overlapping heartbeats can repeatedly race
// the worker transition and leave Terra/legacy cards able to wake reviewers
// after the PR has returned to Jules.
const reviewRejectionConvergenceGuard = new ConvergenceGuard();
const agentIncidentDeduper = new IncidentDeduper();

export interface OrchestratorAdapterConfig {
  readonly maxConcurrentJules?: number | undefined;
  readonly maxConcurrentVibe?: number | undefined;
  readonly julesAgentId?: string | undefined;
  readonly vibeAgentId?: string | undefined;
  readonly vibeReviewerAgentId?: string | undefined;
  readonly reviewerAgentId?: string | undefined;
  readonly lunaReviewerAgentId?: string | undefined;
  readonly terraReviewerAgentId?: string | undefined;
  readonly terraAdjudicatorAgentId?: string | undefined;
  readonly julesPlanApprovalPolicy?: "required" | "trusted_opt_out" | undefined;
  readonly backlogDirectory?: string | undefined;
  readonly resolvedDirectory?: string | undefined;
  readonly apiUrl?: string | undefined;
  readonly requireTaskApproval?: boolean | undefined;
  readonly stalledThresholdMinutes?: number | undefined;
  /** Internal: fleet provisioning is company-scoped, not project-scoped. */
  readonly reconcileFleet?: boolean | undefined;
}

/**
 * Company heartbeat entrypoint. Paperclip sends one heartbeat for the
 * orchestrator, but projects own repositories and workspaces. Run the state
 * machine once per configured project so Git/PR state cannot leak between
 * repositories.
 */
export async function execute(context: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  // Unit tests exercise the project state machine directly with mocked HTTP.
  // Production heartbeats always enumerate the company projects first.
  // Vitest does not consistently set NODE_ENV across workspace invocations,
  // but unit fixtures intentionally exercise the project state machine
  // directly. Production adapter heartbeats still use the company-wide path.
  if (process.env["NODE_ENV"] === "test" || process.env["VITEST"] === "true") return executeProject(context);
  return executeAllProjects(context);
}

export async function executeAllProjects(
  context: AdapterExecutionContext,
  runProject: (context: AdapterExecutionContext) => Promise<AdapterExecutionResult> = executeProject,
): Promise<AdapterExecutionResult> {
  const rawContext = (context.context as Record<string, unknown> | undefined) || {};
  const companyId = context.agent?.companyId || String(rawContext["companyId"] || "");
  const apiUrl = ((context.config as Record<string, unknown> | undefined)?.["apiUrl"] as string | undefined)
    || process.env["PAPERCLIP_API_URL"] || "http://127.0.0.1:3100";
  const authToken =
    (context as AdapterExecutionContext & { authToken?: string }).authToken
    || process.env["PAPERCLIP_AGENT_TOKEN"]
    || process.env["PAPERCLIP_API_KEY"];
  const pc = createPaperclipHttp({ apiUrl, authToken, localTrustedBoardWrites: true });
  let projects: PaperclipProjectRecord[];
  try {
    const listedProjects = asArray<PaperclipProjectRecord>(await pc.listProjects(companyId));
    // Paperclip projections can briefly contain the same project more than
    // once during workspace/company reconciliation. A company heartbeat must
    // never run one project twice; dedupe before capacity allocation and
    // worker-pool dispatch so duplicate rows cannot double-write the board.
    projects = [...new Map(listedProjects.map((project) => [project.id, project])).values()];
  } catch (err: unknown) {
    const message = `Could not list company projects: ${err instanceof Error ? err.message : String(err)}`;
    await context.onLog?.("stderr", `[ORCHESTRATOR] 🚨 ${message}\n`);
    return { exitCode: 1, signal: null, timedOut: false, errorMessage: message, summary: message };
  }

  const runnableProjects = projects.filter((project) => {
    const resolution = resolveProjectWorkspace({ projectId: project.id, projects });
    return resolution.ok && isProjectWorkspaceDirectory(resolution.workspacePath);
  });
  const skippedProjects = projects.length - runnableProjects.length;
  if (runnableProjects.length === 0) {
    const message = `No company project has a usable local workspace; skipped ${projects.length} project(s)`;
    await context.onLog?.("stderr", `[ORCHESTRATOR] 🚨 ${message}\n`);
    return { exitCode: 1, signal: null, timedOut: false, errorMessage: message, summary: message };
  }

  const rawConfig = (context.config as Record<string, unknown> | undefined) || {};
  const projectCapacity = allocateProjectCapacity({
    projectIds: runnableProjects.map((project) => project.id),
    maxConcurrentJules: typeof rawConfig["maxConcurrentJules"] === "number" ? rawConfig["maxConcurrentJules"] : 15,
    maxConcurrentVibe: typeof rawConfig["maxConcurrentVibe"] === "number" ? rawConfig["maxConcurrentVibe"] : 1,
  });
  const projectRuns = await runProjectWorkerPool(
    runnableProjects,
    typeof rawConfig["maxConcurrentProjects"] === "number" ? rawConfig["maxConcurrentProjects"] : 2,
    async (project) => {
    const capacity = projectCapacity.find((item) => item.projectId === project.id);
    return runProject({
      ...context,
      config: {
        ...rawConfig,
        ...(capacity ? { maxConcurrentJules: capacity.jules, maxConcurrentVibe: capacity.vibe } : {}),
        // Respect an explicit test/manual opt-out. Without this guard an
        // isolated canary still attempts fleet provisioning and emits noisy
        // agents:create denials even though it only needs existing workers.
        reconcileFleet: rawConfig["reconcileFleet"] !== false && project === runnableProjects[0],
      },
      context: {
        ...((context.context as Record<string, unknown> | undefined) || {}),
        projectId: project.id,
      },
    });
    },
  );

  const failures = projectRuns.filter((result) => !result.ok || result.value.exitCode !== 0);
  const summary = `Processed ${runnableProjects.length} project(s), skipped ${skippedProjects}; ${failures.length} project execution(s) failed. ${projectRuns.map((result) => result.ok ? (result.value.summary || result.value.errorMessage || "completed") : result.error).join(" | ")}`;
  return {
    exitCode: failures.length > 0 ? 1 : 0,
    signal: null,
    timedOut: projectRuns.some((result) => result.ok && result.value.timedOut),
    ...(failures[0] ? { errorMessage: failures[0].ok ? failures[0].value.errorMessage : failures[0].error } : {}),
    summary,
  };
}

async function executeProject(context: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const runId = context.runId || process.env["PAPERCLIP_RUN_ID"];
  const t0 = Date.now();
  const rawContext = (context.context as Record<string, unknown> | undefined) || {};
  const companyId = (context.agent?.companyId || (rawContext["companyId"] as string) || "") as string;
  const config = (context.config || {}) as OrchestratorAdapterConfig;
  const envMap = process.env;
  const apiUrl = config.apiUrl || envMap["PAPERCLIP_API_URL"] || "http://127.0.0.1:3100";
  const workspaceFromCtx =
    typeof rawContext["workspacePath"] === "string"
      ? (rawContext["workspacePath"] as string)
      : typeof (rawContext["workspace"] as Record<string, unknown> | undefined)?.["cwd"] === "string"
        ? ((rawContext["workspace"] as Record<string, unknown>)["cwd"] as string)
        : undefined;
  // Kept only for direct unit-test fixtures and older internal callers. The
  // production entrypoint always injects projectId and overrides this value
  // from the Paperclip project's workspace.
  let workspacePath = ((config as Record<string, unknown>)["workspacePath"] as string | undefined)
    || envMap["WORKSPACE_PATH"] || workspaceFromCtx || process.cwd();
  const authToken =
    (context as AdapterExecutionContext & { authToken?: string }).authToken ||
    envMap["PAPERCLIP_AGENT_TOKEN"] ||
    envMap["PAPERCLIP_API_KEY"];
  const pc = createPaperclipHttp({
    apiUrl,
    authToken,
    runId,
    // A company-level orchestrator run has no source issueId. Paperclip's
    // cross-issue guard therefore rejects agent-JWT mutations. Local-trusted
    // Paperclip explicitly provides an implicit board actor for this case;
    // never enable this fallback for non-loopback deployments.
    localTrustedBoardWrites: true,
  });
  const explicitProjectId = typeof rawContext["projectId"] === "string" ? String(rawContext["projectId"]).trim() : "";
  const orchestratorId = context.agent?.id || "";
  let managedIds = new Set<string>();

  const log = async (msg: string) => {
    console.log(msg);
    if (context.onLog) {
      await context.onLog("stdout", msg + "\n").catch(() => {});
    }
  };

  const retireStaleJulesChildren = async (issueId: string, issueLabel: string): Promise<void> => {
    let children: readonly Record<string, unknown>[];
    try {
      children = asArray<Record<string, unknown>>(await pc.listChildren(companyId, issueId));
    } catch (err: unknown) {
      await log(`[ORCHESTRATOR] Could not inspect Jules coordination children for [${issueLabel}]: ${String(err)}`);
      return;
    }
    await log(`[ORCHESTRATOR] Jules PR recovery children for [${issueLabel}]: ${children.length} authoritative records.`);
    for (const childId of selectStaleJulesReviewChildren(issueId, children)) {
      const closed = await pc.patchIssue(childId, { status: "done" });
      if (!closed.ok) await log(`[ORCHESTRATOR] Could not close stale Jules PR child [${childId}] (${closed.status}): ${closed.text}`);
    }
  };

  // Paperclip may asynchronously normalize an issue when a board approval is
  // created. A single PATCH can therefore report success while the persisted
  // projection is still (or becomes again) `in_progress`. Converge on the
  // review invariant with a bounded read-after-write loop; this is deliberately
  // local to the approval handoff and never polls indefinitely on a heartbeat.
  const preservePendingReviewState = async (issueId: string) => {
    let last: { ok: boolean; status: number; text: string } = {
      ok: false,
      status: 0,
      text: "review state was not verified",
    };
    let verified = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const patched = await pc.patchIssue(issueId, {
        status: "in_review",
        assigneeAgentId: null,
        executionPolicy: null,
        executionState: null,
      });
      last = patched;
      if (!patched.ok) return patched;
      await new Promise<void>((resolve) => setTimeout(resolve, attempt === 0 ? 25 : 75));
      try {
        const current = await pc.getIssue<Record<string, unknown>>(issueId);
        verified = current["status"] === "in_review" && current["assigneeAgentId"] == null;
      } catch {
        // A transient detail read is not a reason to abandon the safety
        // invariant; the next bounded attempt writes and verifies again.
      }
    }
    return verified ? last : { ...last, ok: false, text: "Paperclip did not converge to in_review" };
  };
  if (explicitProjectId) {
    try {
      const project = await pc.getJson<PaperclipProjectRecord>(`/api/projects/${encodeURIComponent(explicitProjectId)}`);
      const resolution = resolveProjectWorkspace({ projectId: explicitProjectId, projects: [project] });
      if (!resolution.ok) {
        const message = `Project ${explicitProjectId} has no usable local workspace (${resolution.reason})`;
        await log(`[ORCHESTRATOR] 🚨 ${message}`);
        return { exitCode: 1, signal: null, timedOut: false, errorMessage: message, summary: message };
      }
      workspacePath = resolution.workspacePath;
    } catch (err: unknown) {
      const message = `Could not resolve project ${explicitProjectId}: ${err instanceof Error ? err.message : String(err)}`;
      await log(`[ORCHESTRATOR] 🚨 ${message}`);
      return { exitCode: 1, signal: null, timedOut: false, errorMessage: message, summary: message };
    }
  }
  const managedWakeup = async (
    agentId: string | undefined,
    reason: string,
    issueId?: string,
    options?: { resumeFromRunId?: string | undefined; recoverStaleExecution?: boolean | undefined; workerFeedback?: WorkerFeedbackEnvelope | undefined; reviewInteractionId?: string | undefined },
  ) => {
    if (!agentId || !managedIds.has(agentId)) return;
    const circuitKey = `managed-wakeup:${agentId}`;
    if (capabilityCircuit.isOpen(circuitKey)) return;
    if (!runId) {
      await log(`[ORCHESTRATOR] Skipped managed-worker wakeup: run attribution is missing.`);
      return;
    }
    const idempotencyKey = `orchestrator:wakeup:${agentId}:${issueId || "company"}:${options?.reviewInteractionId || options?.workerFeedback?.deliveryId || options?.resumeFromRunId || "current"}`;
    const result = await executePaperclipCommand(
      {
        key: idempotencyKey,
        issueId: issueId || "company",
        action: "wakeup",
        payload: { agentId, reason, ...options },
      },
      () => pc.wakeup(agentId, reason, issueId, { ...options, idempotencyKey }),
    );
    const normalizedResult = { ...result, text: result.text ?? "" };
    const circuitState = capabilityCircuit.record(circuitKey, normalizedResult);
    let wakeResponse: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(normalizedResult.text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        wakeResponse = parsed as Record<string, unknown>;
      }
    } catch {
      // The HTTP helper deliberately keeps response bodies opaque; malformed
      // success bodies are reported only through the normal status path.
    }
    if (normalizedResult.ok && wakeResponse["status"] === "skipped") {
      await log(
        `[ORCHESTRATOR] Managed-worker wakeup skipped for ${issueId || "unscoped"}: ${String(wakeResponse["reason"] || "unknown")}. Next scheduled poll will retry.`,
      );
      // Paperclip can retain a running execution lock after a reviewer process
      // dies during a restart. A later review stage is then permanently
      // deferred behind the dead prior-stage run. Review dispatch is the one
      // safe recovery point: the state machine has already observed the prior
      // review verdict, so cancel only the different stale owner reported by
      // Paperclip, then retry the intended reviewer wake once.
      const staleRunId = typeof wakeResponse["executionRunId"] === "string" ? wakeResponse["executionRunId"] : undefined;
      const staleOwnerId = typeof wakeResponse["executionAgentId"] === "string" ? wakeResponse["executionAgentId"] : undefined;
      if (options?.recoverStaleExecution && issueId && staleRunId && staleOwnerId && staleOwnerId !== agentId) {
        const cancelled = await pc.cancelHeartbeatRun(staleRunId, `Cancelled stale prior-stage execution before delegated review of ${issueId}`);
        if (cancelled.ok) {
          await log(`[ORCHESTRATOR] Cleared stale execution ${staleRunId} owned by ${staleOwnerId}; retrying delegated review wake.`);
          await pc.wakeup(agentId, reason, issueId, { resumeFromRunId: options?.resumeFromRunId });
        } else {
          await log(`[ORCHESTRATOR] 🚨 Could not clear stale execution ${staleRunId} (${cancelled.status}): ${cancelled.text}`);
        }
      }
    }
    if (!normalizedResult.ok && circuitState !== "already_open") {
      const suffix = circuitState === "opened"
        ? " Capability circuit opened; this wake will not be retried until the adapter is reloaded after a Paperclip authorization change."
        : "";
      await log(`[ORCHESTRATOR] Managed-worker wakeup failed (${normalizedResult.status}): ${normalizedResult.text}${suffix}`);
    }
  };

  await log(`[ORCHESTRATOR] Starting deterministic scheduling tick for company ${companyId}...`);
  await log(`[ORCHESTRATOR] Run attribution: ${runId || "(missing)"}`);
  await log(`[ORCHESTRATOR] Workspace path: ${workspacePath}`);

  // 1. Resolve Worker (Jules & Vibe) and Reviewer agents
  let julesAgentId = config.julesAgentId;
  let vibeAgentId = config.vibeAgentId;
  let vibeReviewerAgentId = config.vibeReviewerAgentId;
  let reviewerAgentId = config.reviewerAgentId;
  let lunaReviewerAgentId = config.lunaReviewerAgentId;
  let terraReviewerAgentId = config.terraReviewerAgentId ?? config.reviewerAgentId;
  let terraAdjudicatorAgentId = config.terraAdjudicatorAgentId;
  let fleetAuthorizationFailures: Awaited<ReturnType<typeof reconcileManagedFleet>>["authorizationFailures"] = [];
  let agentHealthReport: AgentHealthReport | undefined;

  let managedJulesIds = new Set<string>();
  let managedWorkerStates: ContinuationWorker[] = [];
  let managedAgentStatuses = new Map<string, string>();
  let agentAdapterTypes = new Map<string, string>();
  let julesNeedsReattach = false;
  try {
    // Reconcile before resolving. Previously the executor only resolved
    // existing identities, so a newly required reviewer (Luna) could never
    // be provisioned and the state machine correctly—but permanently—failed
    // closed. Reconciliation is idempotent and restricted to managed names.
    const fleetToken = authToken || process.env["PAPERCLIP_AGENT_TOKEN"] || process.env["PAPERCLIP_API_KEY"];
    if (canReconcileManagedFleet(apiUrl, fleetToken, config.reconcileFleet !== false)) {
      const fleetResult = await reconcileManagedFleet(apiUrl, companyId, {
        orchestratorAgentId: orchestratorId,
        authToken: fleetToken,
        julesPlanApprovalPolicy: config.julesPlanApprovalPolicy,
        lunaReviewerAgentId,
        terraReviewerAgentId,
        terraAdjudicatorAgentId,
        vibeReviewerAgentId,
        reviewerAgentId,
        skipWorkerKeys: MANAGED_FLEET_DEFINITIONS
          .map((definition) => definition.key)
          .filter((workerKey) =>
            capabilityCircuit.isOpen(`fleet:${companyId}:configure:${workerKey}`) ||
            capabilityCircuit.isOpen(`fleet:${companyId}:create:${workerKey}`),
          ),
      });
      fleetAuthorizationFailures = fleetResult.authorizationFailures;
      for (const denial of fleetAuthorizationFailures) {
        const operation = denial.capability === "agents:create" ? "create" : "configure";
        const key = `fleet:${companyId}:${operation}:${denial.workerKey}`;
        const state = capabilityCircuit.record(key, {
          ok: false, status: denial.status, text: `${denial.capability}: ${denial.detail}`,
        });
        if (state === "opened") {
          await log(`[ORCHESTRATOR] 🚨 Fleet reconciliation blocked for ${denial.workerKey}: missing ${denial.capability}. Grant it to the Task Orchestrator, then reload the adapter. Other fleet workers continue independently.`);
        }
      }
    }
    const rawAgents = asArray<Record<string, unknown>>(await pc.listAgents(companyId));
    const agents: FleetAgentRecord[] = rawAgents.map((a) => ({
      id: String(a["id"]),
      name: String(a["name"]),
      adapterType: String(a["adapterType"]),
      status: String(a["status"] || "idle"),
      adapterConfig: (a["adapterConfig"] as Record<string, unknown> | null) || null,
      reportsTo: (a["reportsTo"] as string | null) || null,
      errorReason: (a["errorReason"] as string | null) || null,
      pauseReason: (a["pauseReason"] as string | null) || null,
      orgChainHealth: a["orgChainHealth"] as FleetAgentRecord["orgChainHealth"],
      metadata: (a["metadata"] as Record<string, unknown> | null) || null,
    }));
    managedAgentStatuses = new Map(agents.map((agent) => [agent.id, agent.status]));
    agentAdapterTypes = new Map(agents.map((agent) => [agent.id, agent.adapterType]));

    const fleet = resolveManagedFleet(agents, orchestratorId, {
      julesAgentId,
      vibeAgentId,
      vibeReviewerAgentId,
      reviewerAgentId,
      lunaReviewerAgentId,
      terraReviewerAgentId,
    });
    managedIds = new Set(fleet.managedIds);
    managedJulesIds = new Set(fleet.managedJulesIds);
    managedWorkerStates = agents
      .filter((a) => managedIds.has(a.id) && (a.adapterType === "jules" || a.adapterType === "vibe" || a.adapterType === "antigravity"))
      .map((a) => ({ id: a.id, status: a.status, adapterType: a.adapterType }));
    julesAgentId = fleet.julesAgentId;
    vibeAgentId = fleet.vibeAgentId;
    vibeReviewerAgentId = fleet.vibeReviewerAgentId;
    reviewerAgentId = fleet.reviewerAgentId;
    lunaReviewerAgentId = fleet.lunaReviewerAgentId;
    terraReviewerAgentId = fleet.terraReviewerAgentId;
    terraAdjudicatorAgentId = fleet.terraAdjudicatorAgentId;
    if (julesAgentId) await log(`[ORCHESTRATOR] Managed Jules agent: ${julesAgentId}`);
    if (vibeAgentId) await log(`[ORCHESTRATOR] Managed Vibe agent: ${vibeAgentId}`);
    if (lunaReviewerAgentId) await log(`[ORCHESTRATOR] Managed Luna reviewer: ${lunaReviewerAgentId}`);
    if (terraReviewerAgentId) await log(`[ORCHESTRATOR] Managed Terra reviewer: ${terraReviewerAgentId}`);

    // The orchestrator owns the policy for its managed Jules worker. Apply an
    // explicit setting to existing workers too; otherwise newly provisioned
    // and already-running workers can silently use different gates.
    const julesConfigurationDenied = fleetAuthorizationFailures.some(
      (failure) => failure.workerKey === "jules" && failure.capability === "agents:configure"
    );
    if (julesAgentId && !julesConfigurationDenied && (config.julesPlanApprovalPolicy || lunaReviewerAgentId || terraReviewerAgentId || terraAdjudicatorAgentId)) {
      const managedJules = agents.find((agent) => agent.id === julesAgentId);
      if (managedJules && (
        managedJules.adapterConfig?.["planApprovalPolicy"] !== config.julesPlanApprovalPolicy ||
        managedJules.adapterConfig?.["planReviewerAgentId"] !== lunaReviewerAgentId ||
        managedJules.adapterConfig?.["planStrongReviewerAgentId"] !== terraReviewerAgentId ||
        managedJules.adapterConfig?.["questionReviewerAgentId"] !== terraReviewerAgentId
        || managedJules.adapterConfig?.["questionAdjudicatorAgentId"] !== terraAdjudicatorAgentId
      )) {
        const patch = await pc.patchAgent(julesAgentId, {
          adapterConfig: {
            ...(managedJules?.adapterConfig ?? {}),
            ...(config.julesPlanApprovalPolicy ? { planApprovalPolicy: config.julesPlanApprovalPolicy } : {}),
            ...(lunaReviewerAgentId ? { planReviewerAgentId: lunaReviewerAgentId } : {}),
            ...(terraReviewerAgentId ? { planStrongReviewerAgentId: terraReviewerAgentId } : {}),
            ...(terraReviewerAgentId ? { questionReviewerAgentId: terraReviewerAgentId } : {}),
            ...(terraAdjudicatorAgentId ? { questionAdjudicatorAgentId: terraAdjudicatorAgentId, questionReviewerAgentId: terraAdjudicatorAgentId } : {}),
          },
        });
        if (!patch.ok) {
          await log(`[ORCHESTRATOR] Failed to apply Jules plan policy (${patch.status}): ${patch.text}`);
        } else {
          await log(`[ORCHESTRATOR] Applied Jules plan policy: ${config.julesPlanApprovalPolicy}`);
        }
      }
    }

    const managedJules = agents.find((a) => a.id === julesAgentId);
    julesNeedsReattach = Boolean(
      managedJules &&
        (managedJules.status === "error" || (managedJules.errorReason || "").includes("Process lost"))
    );

    agentHealthReport = evaluateAgentHealth(agents);
    const newIncidents = agentIncidentDeduper.reconcile(agentHealthReport.incidents);
    if (newIncidents.length > 0) {
      for (const inc of newIncidents) {
        await log(
          `[ORCHESTRATOR] [Agent Incident] [${inc.severity}] ${inc.agentName} (${inc.status}): ${inc.issue}`
        );
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await log(`[ORCHESTRATOR] Error: Failed to fetch agents list: ${msg}`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: msg,
      summary: msg,
    };
  }

  // 2. Read-only Workspace consistency verification
  const wsConsistency = await checkWorkspaceConsistency(workspacePath);
  if (wsConsistency.warning) {
    await log(`[ORCHESTRATOR] ℹ️ Workspace note: ${wsConsistency.warning}`);
  }

  // 3. Two-Way Markdown Ingestion (project comes from workspace folder / git remote)
  let companyProjects: PaperclipProjectRecord[] = [];
  try {
    companyProjects = asArray<PaperclipProjectRecord>(await pc.listProjects(companyId));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await log(`[ORCHESTRATOR] Warning: could not list Paperclip projects: ${msg}`);
  }
  const gitRemoteUrl = readWorkspaceGitRemote(workspacePath);
  const explicitProjectResolution = explicitProjectId
    ? resolveProjectWorkspace({ projectId: explicitProjectId, projects: companyProjects })
    : null;
  const workspaceProject = explicitProjectResolution?.ok
    ? explicitProjectResolution.project
    : explicitProjectId
      ? null
      : resolvePaperclipProject({ workspacePath, gitRemoteUrl, projects: companyProjects });
  if (workspaceProject) {
    await log(
      `[ORCHESTRATOR] Workspace folder maps to Paperclip project ${workspaceProject.name || workspaceProject.urlKey || workspaceProject.id}`,
    );
  }
  const syncSummary = await syncBacklogMarkdownToPaperclip({
    workspacePath,
    companyId,
    apiUrl,
    backlogDirectory: config.backlogDirectory,
    resolvedDirectory: config.resolvedDirectory,
    gitRemoteUrl,
    projects: companyProjects,
    ...(workspaceProject?.id ? { projectId: workspaceProject.id } : {}),
    orchestratorAgentId: orchestratorId,
    managedAgentIds: managedIds,
  });
  if (syncSummary.createdCount > 0 || syncSummary.syncedHeadersCount > 0) {
    await log(
      `[ORCHESTRATOR] 📥 Backlog Sync: created=${syncSummary.createdCount}, headers_synced=${syncSummary.syncedHeadersCount}`
    );
  }
  if (syncSummary.conflicts.length > 0) {
    for (const conflict of syncSummary.conflicts) {
      await log(
        `[ORCHESTRATOR] Backlog identity conflict for ${conflict.logicalId}: ${conflict.reason}; candidates=${conflict.candidateIssueIds.join(",")}. Skipping sync for ${conflict.filePath}.`
      );
    }
  }

  // 4. Verify remote GitHub state
  const ghStatus = await fetchGitHubPullRequests(workspacePath, 50);
  if (ghStatus.openPrs.length > 0 || ghStatus.mergedPrs.length > 0) {
    await log(
      `[ORCHESTRATOR] 🌐 Remote Verification: open_prs=${ghStatus.openPrs.length}, merged_prs=${ghStatus.mergedPrs.length}, active_pr_files_locked=${ghStatus.openPrFiles.size}`
    );
  }

  // 5. Fetch live Jules quota
  const configEnv = context.config ? (context.config["env"] as Record<string, unknown> | undefined) : undefined;
  const julesApiKey =
    (configEnv ? (configEnv["JULES_API_KEY"] as string | undefined) : undefined) ||
    (context.config ? (context.config["julesApiKey"] as string | undefined) : undefined) ||
    envMap["JULES_API_KEY"];

  const julesQuota = await fetchJulesQuota(julesApiKey);
  if (julesQuota.fetchedLive) {
    await log(
      `[ORCHESTRATOR] Live Jules Quota: active_sessions=${julesQuota.activeSessionsCount}/${julesQuota.maxConcurrent}, last_24h=${julesQuota.sessionsLast24hCount}/${julesQuota.maxDaily}, available_slots=${julesQuota.effectiveAvailableCapacity}`
    );
  }

  if (ghStatus.error) {
    await log(`[ORCHESTRATOR] 🚨 GITHUB ACCESS UNAVAILABLE: ${ghStatus.error}. Remote PR reconciliation is degraded; reviews and merges remain safety-paused until GitHub access recovers.`);
  }

  // 6. Fetch all company issues
  let issuesList: Record<string, unknown>[] = [];
  try {
    issuesList = asArray<Record<string, unknown>>(await pc.listIssues(companyId));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const errMsg = `Failed to fetch issues: ${msg}`;
    await log(`[ORCHESTRATOR] Error: ${errMsg}`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: errMsg,
      summary: errMsg,
    };
  }

  // A company may contain several repositories. Scheduling across all of
  // them makes unrelated active locks (and approvals) block this workspace's
  // backlog. The workspace project is the orchestrator's isolation boundary.
  const scopedIssues = workspaceProject?.id
    ? issuesList.filter((issue) => issue["projectId"] === workspaceProject.id)
    : [];
  if (workspaceProject?.id && issuesList.some((issue) => issue["projectId"] !== workspaceProject.id)) {
    const message = `Project-scoped issue query returned a cross-project issue for ${workspaceProject.id}`;
    await log(`[ORCHESTRATOR] 🚨 ${message}`);
    return { exitCode: 1, signal: null, timedOut: false, errorMessage: message, summary: message };
  }
  // Paperclip's company issue list intentionally omits workProducts. Enrich
  // terminal and active-review issues; otherwise a ready Jules PR becomes
  // invisible immediately after the recovery tick changes `done` to
  // `in_review`.
  const enrichedIssues = await Promise.all(scopedIssues.map(async (issue) => {
    const status = String(issue["status"] ?? "").toLowerCase();
    const orchestratorOwnedRecoveryRecord =
      (status === "backlog" || status === "todo" || status === "in_progress" || status === "blocked") &&
      (issue["assigneeAgentId"] === orchestratorId || managedIds.has(String(issue["assigneeAgentId"] || "")));
    if (!needsFullIssueRecord(status) && !orchestratorOwnedRecoveryRecord) return issue;
    try {
      return await pc.getIssue<Record<string, unknown>>(String(issue["id"] ?? ""));
    } catch {
      return issue;
    }
  }));
  const parsedIssues: ParsedIssueMetadata[] = enrichedIssues.map((issue) =>
    extractIssueMetadata({
      ...issue,
      id: String(issue["id"] ?? ""),
      title: String(issue["title"] ?? ""),
      status: String(issue["status"] ?? "backlog"),
      identifier: typeof issue["identifier"] === "string" ? issue["identifier"] : null,
      issueNumber: typeof issue["issueNumber"] === "number" ? issue["issueNumber"] : null,
      description: typeof issue["description"] === "string" ? issue["description"] : null,
      priority: typeof issue["priority"] === "string" ? issue["priority"] : null,
      assigneeAgentId: typeof issue["assigneeAgentId"] === "string" ? issue["assigneeAgentId"] : null,
      updatedAt: typeof issue["updatedAt"] === "string" ? issue["updatedAt"] : null,
      executionRunId: typeof issue["executionRunId"] === "string" ? issue["executionRunId"] : null,
      parentId: typeof issue["parentId"] === "string" ? issue["parentId"] : null,
    })
  );

  const wokeThisTick = new Set<string>();
  if (julesNeedsReattach && julesAgentId && managedIds.has(julesAgentId)) {
    const julesIssue = parsedIssues.find(
      (i) =>
        i.assigneeAgentId === julesAgentId &&
        (i.status === "in_progress" || i.status === "in_review")
    );
    await log(
      `[ORCHESTRATOR] Managed Jules needs reattach after process-lost; waking with issue ${julesIssue?.identifier || julesIssue?.id || "(none in progress)"}.`
    );
    await managedWakeup(julesAgentId, "Reattach after host process-lost", julesIssue?.id);
    wokeThisTick.add(julesAgentId);
  }

  const heartbeatRuns: HeartbeatRunSummary[] = [];
  for (const worker of managedWorkerStates) {
    try {
      // Lifecycle reconciliation may need to cancel several stale delegated
      // review runs created in one burst. The default eight-run window can
      // miss older siblings and allow Paperclip to reopen them after their
      // terminal parent has already been reconciled.
      const rawRuns = await pc.listHeartbeatRuns(companyId, worker.id, 50);
      heartbeatRuns.push(...rawRuns.map((raw) => parseHeartbeatRun(raw)));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await log(`[ORCHESTRATOR] Warning: Failed to list heartbeat runs for ${worker.id}: ${msg}`);
    }
  }

  // Retire children made by the superseded bridge. This is bounded cleanup,
  // not a replacement execution path; new children are never created.
  const legacySupervisorChildren = scopedIssues
    .filter((issue) => typeof issue["parentId"] === "string" &&
      typeof issue["description"] === "string" && issue["description"].includes(JULES_SUPERVISOR_MARKER) &&
      !["done", "cancelled"].includes(String(issue["status"])))
    .map((issue) => ({ id: String(issue["id"]), parentId: String(issue["parentId"]) }));
  for (const childId of selectJulesSupervisorIssueIdsToClose({
    supervisorChildren: legacySupervisorChildren,
  })) {
    const circuitKey = `supervisor-retire:${childId}`;
    if (capabilityCircuit.isOpen(circuitKey)) continue;
    const closed = await pc.patchIssue(childId, issuePatch("done"));
    const circuitState = capabilityCircuit.record(circuitKey, closed);
    if (!closed.ok && circuitState !== "already_open") {
      await log(`[ORCHESTRATOR] Failed to retire legacy Jules supervisor child (${closed.status}): ${closed.text}`);
    }
  }

  for (const action of selectJulesSupervisorActions({
    issues: parsedIssues,
    runs: heartbeatRuns,
    julesAgentId,
    now: Date.now(),
  })) {
    if (action.wake && !wokeThisTick.has(`${julesAgentId ?? ""}:${action.issueId}`)) {
      await managedWakeup(
        julesAgentId,
        `Poll supervised Jules session ${action.sessionId}`,
        action.issueId,
        { resumeFromRunId: action.resumeFromRunId },
      );
      wokeThisTick.add(`${julesAgentId ?? ""}:${action.issueId}`);
    }
  }

  // 7. PHASE 1: Reconcile board status with merged GitHub PRs & Archive files
  const statusOverrides = new Map<string, IssueState>();
  const mergedIssueIds = new Set<string>();
  let mergedAutoCompleted = 0;
  if (!ghStatus.error) {
    for (const issue of parsedIssues) {
      const mergedPr = ghStatus.mergedPrs.find((pr) => matchPrToIssue(pr, issue));
      if (!mergedPr) continue;

      mergedIssueIds.add(issue.id);
      const mergeKey = `merge:${issue.id}:pr-${mergedPr.number}:${mergedPr.mergedAt || "unknown"}`;
      await mergeConvergenceGuard.runOnce(mergeKey, async () => {
        const rawProducts = issue.rawIssue["workProducts"] ?? issue.rawIssue["work_products"];
        const rawProduct = Array.isArray(rawProducts)
          ? rawProducts.find((product) => {
              if (!product || typeof product !== "object") return false;
              const candidate = product as Record<string, unknown>;
              return typeof candidate["url"] === "string" &&
                candidate["url"].replace(/\/$/, "").toLowerCase() === mergedPr.url.replace(/\/$/, "").toLowerCase();
            }) as Record<string, unknown> | undefined
          : undefined;
        const comments = asArray<{ body?: string }>(await pc.listComments(issue.id));
        const auditMarker = mergeAuditMarker({ issue, pr: mergedPr });
        const decision = decidePullRequestReconciliation({
          issueId: issue.id,
          issueStatus: issue.status,
          ...(rawProduct ? {
            workProduct: {
              id: String(rawProduct["id"] ?? ""),
              status: typeof rawProduct["status"] === "string" ? rawProduct["status"] : null,
              reviewState: typeof rawProduct["reviewState"] === "string" ? rawProduct["reviewState"] : null,
              url: String(rawProduct["url"]),
            },
          } : {}),
          pullRequest: mergedPr,
          auditAlreadyRecorded: comments.some((comment) => typeof comment.body === "string" && comment.body.includes(auditMarker)),
        });
        if (decision.action !== "COMPLETE_MERGED_PR" && decision.action !== "NORMALIZE_MERGED_METADATA") return;

        await log(`[ORCHESTRATOR] Reconciling [${issue.identifier || issue.id}] "${issue.title}" (${decision.reason})`);
        if (issue.status !== "done") {
          const patch = await pc.patchIssue(issue.id, issuePatch("done"));
          if (!patch.ok) {
            await log(`[ORCHESTRATOR] Warning: Failed to transition merged issue (${patch.status}): ${patch.text}`);
            return;
          }
        }
        if (rawProduct?.["id"]) {
          const productPatch = await pc.patchWorkProduct(String(rawProduct["id"]), {
            status: decision.workProductStatus,
            reviewState: decision.workProductReviewState,
          });
          if (!productPatch.ok) {
            await log(`[ORCHESTRATOR] Warning: Failed to normalize merged work product (${productPatch.status}): ${productPatch.text}`);
          }
        }
        if (decision.shouldPostAudit) {
          await pc.comment(issue.id, synthesizeAuditDigest({ issue, pr: mergedPr }));
        }
        statusOverrides.set(issue.id, "done");
        mergedAutoCompleted++;
      }).catch(async (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        await log(`[ORCHESTRATOR] Warning: Failed to reconcile merged issue: ${msg}`);
      });
    }
  }

  // A Jules PR can outlive a lost Paperclip monitor and leave its source issue
  // blocked/in_progress. Recover only a registered Jules work product after
  // GitHub confirms its checks are green; the normal native review pipeline
  // then owns reviewer dispatch. This replaces the old external timer bridge.
  const openPrRecoveryIds = new Set<string>();
  if (!ghStatus.error) {
    for (const issue of parsedIssues) {
      // A board approval can cause Paperclip to normalize the linked issue to
      // todo/in_progress and reassign the previous worker. A registered open
      // Jules PR is authoritative review work in every nonterminal state, so
      // recovery must not depend on the stale lifecycle projection.
      if (!issue.orchestratorManaged || !["backlog", "todo", "in_progress", "in_review", "blocked"].includes(issue.status)) continue;
      const rawProducts = issue.rawIssue["workProducts"] ?? issue.rawIssue["work_products"];
      const julesProduct = Array.isArray(rawProducts)
        ? rawProducts.find((product) => {
            if (!product || typeof product !== "object") return false;
            const candidate = product as Record<string, unknown>;
            return (candidate["type"] === "pull_request" || candidate["kind"] === "pull_request") &&
              (candidate["metadata"] as Record<string, unknown> | undefined)?.["source"] === "jules";
          })
        : undefined;
      if (!julesProduct) continue;
      const matchingPr = ghStatus.openPrs.find((pr) => matchPrToIssue(pr, issue));
      if (!matchingPr) continue;
      // Open/green cannot override a structured rejection for this immutable
      // head, nor can it steal an issue whose Jules monitor is resumable.
      // Read the authoritative interactions/detail before deciding; the
      // compact issue list is allowed to omit both fields.
      let currentHeadRejected = false;
      let authoritativeExecutionPolicy: unknown = undefined;
      try {
        const detail = await pc.getIssue<Record<string, unknown>>(issue.id);
        const policy = detail["executionPolicy"];
        const policyRecord = policy && typeof policy === "object" && !Array.isArray(policy) ? policy as Record<string, unknown> : null;
        authoritativeExecutionPolicy = policyRecord;
        if (matchingPr.headRefOid) {
          const rawInteractions = asArray<Record<string, unknown>>(await pc.listInteractions(issue.id));
          currentHeadRejected = hasNativeRejectionForHead(rawInteractions.map((interaction) => ({
            id: String(interaction["id"] ?? ""),
            kind: typeof interaction["kind"] === "string" ? interaction["kind"] : undefined,
            status: typeof interaction["status"] === "string" ? interaction["status"] : undefined,
            idempotencyKey: typeof interaction["idempotencyKey"] === "string" ? interaction["idempotencyKey"] : undefined,
            result: interaction["result"],
          })), issue.id, matchingPr.headRefOid);
        }
      } catch (err: unknown) {
        await log(`[ORCHESTRATOR] Deferring open Jules PR recovery for [${issue.identifier || issue.id}]: could not verify monitor/review state (${String(err)}).`);
        continue;
      }
      if (!canPromoteJulesPrToReview({ ciGreen: true, currentHeadRejected, executionPolicy: authoritativeExecutionPolicy })) {
        await log(`[ORCHESTRATOR] Keeping [${issue.identifier || issue.id}] with Jules: current PR head is rejected or its provider monitor is resumable.`);
        continue;
      }
      const ci = await checkPrCiIsGreen(matchingPr.number, workspacePath, matchingPr.url);
      if (!ci.isGreen) {
        await log(`[ORCHESTRATOR] Deferring open Jules PR recovery for [${issue.identifier || issue.id}]: CI is ${ci.status}.`);
        continue;
      }
      // The same PR may need recovery again if Paperclip asynchronously
      // reprojects the issue after creating an approval. Include the board's
      // current version/state in the fence: stable `in_review` heartbeats do
      // not enter this branch, while a later regression gets a fresh key and
      // is repaired instead of being hidden by a lifetime `runOnce` marker.
      const recoveryKey = `jules-open-pr-recovery:${issue.id}:${matchingPr.url}:${issue.updatedAt || "unknown"}:${issue.status}:${issue.assigneeAgentId || "unassigned"}`;
      await lifecycleConvergenceGuard.runOnce(recoveryKey, async () => {
        await retireStaleJulesChildren(issue.id, issue.identifier || issue.id);
        const recovered = await pc.patchIssue(issue.id, { status: "in_review", assigneeAgentId: null });
        if (!recovered.ok) {
          await log(`[ORCHESTRATOR] Could not recover open Jules PR for [${issue.identifier || issue.id}] (${recovered.status}): ${recovered.text}`);
          return;
        }
        statusOverrides.set(issue.id, "in_review");
        openPrRecoveryIds.add(issue.id);
        await log(`[ORCHESTRATOR] Recovered open Jules PR for [${issue.identifier || issue.id}] into native review.`);
      });
    }
  }

  // Paperclip creates monitor issues directly, outside the adapter transition
  // guard. Reconcile those persisted states before scheduling so diagnostics
  // cannot occupy worker lanes forever and review children cannot outlive a
  // terminal parent. The pure decision function keeps this heartbeat safe to
  // repeat; the marker makes the write/comment side idempotent as well.
  let lifecycleClosedCount = 0;
  let lifecycleDuplicateCount = 0;
  let lifecycleOrphanCount = 0;
  const lifecycleIssues = parsedIssues.map((issue) =>
    statusOverrides.has(issue.id)
      ? { ...issue, status: statusOverrides.get(issue.id) as IssueState }
      : issue,
  );
  const reattachedJulesMonitorIssueIds = new Set<string>();

  // Paperclip can leave an external Jules task blocked after its monitor
  // timeout, even though the persisted provider session is resumable. Resume
  // only that explicit structured case; provider completion/questions remain
  // the Jules adapter's responsibility.
  for (const issue of lifecycleIssues) {
    const executionState = issue.rawIssue["executionState"];
    const state = executionState && typeof executionState === "object" && !Array.isArray(executionState)
      ? executionState as Record<string, unknown>
      : null;
    const monitor = state?.["monitor"];
    const executionPolicyRaw = issue.rawIssue["executionPolicy"];
    const executionPolicyRecord = executionPolicyRaw && typeof executionPolicyRaw === "object" && !Array.isArray(executionPolicyRaw)
      ? executionPolicyRaw as Record<string, unknown>
      : null;
    const policyMonitor = executionPolicyRecord?.["monitor"];
    // Once repaired, executionPolicy.monitor is authoritative. Prefer it over
    // Paperclip's lossy executionState projection, which may retain the old
    // cleared/invalid_assignee monitor for several heartbeats.
    const monitorRecord = policyMonitor && typeof policyMonitor === "object" && !Array.isArray(policyMonitor)
      ? policyMonitor as Record<string, unknown>
      : monitor && typeof monitor === "object" && !Array.isArray(monitor)
        ? monitor as Record<string, unknown>
        : null;
    const monitorStatus = typeof monitorRecord?.["status"] === "string" ? monitorRecord["status"] : null;
    const monitorClearReason = typeof monitorRecord?.["clearReason"] === "string" ? monitorRecord["clearReason"] : null;
    const timeoutAt = typeof monitorRecord?.["timeoutAt"] === "string" ? monitorRecord["timeoutAt"] : null;
    const serviceName = typeof monitorRecord?.["serviceName"] === "string" ? monitorRecord["serviceName"] : null;
    const externalRef = monitorRecord?.["externalRef"];
    const executionPolicy = executionPolicyRecord;
    // Compatibility bridge: Paperclip can drop executionPolicy while its
    // durable projection still says that Jules owns an active monitor. Such
    // an issue is otherwise invisible to the scheduler because the projected
    // monitor has no nextCheckAt. Reattach it once from this explicit state;
    // never infer it from provider prose or a PR alone.
    const monitorDetached = executionPolicyRecord === null &&
      serviceName === "jules" &&
      typeof externalRef === "string" && externalRef.trim().length > 0 &&
      (monitorStatus === "triggered" || monitorStatus === null);
    const nativePolicyMonitor = executionPolicy?.["monitor"];
    const canReattachNativeMonitor = Boolean(
      nativePolicyMonitor && typeof nativePolicyMonitor === "object" && !Array.isArray(nativePolicyMonitor) &&
      typeof (nativePolicyMonitor as Record<string, unknown>)["externalRef"] === "string" &&
      String((nativePolicyMonitor as Record<string, unknown>)["externalRef"]).trim(),
    );
    const monitorDecision = decideJulesMonitorReconciliation({
      issueStatus: statusOverrides.get(issue.id) || issue.status,
      assigneeIsOrchestrator: issue.assigneeAgentId === orchestratorId || issue.assigneeAgentId === julesAgentId || managedJulesIds.has(issue.assigneeAgentId || ""),
      serviceName,
      monitorStatus,
      monitorClearReason,
      timeoutAt,
      hasProviderSession: typeof externalRef === "string" && externalRef.trim().length > 0,
      monitorCanBeReattached: canReattachNativeMonitor,
      monitorDetached,
      assigneeIsJules: issue.assigneeAgentId === julesAgentId,
    }, Date.now());
    if (monitorDecision.action === "return_to_todo") {
      const key = `jules-monitor-reclaim:${issue.id}:${timeoutAt}`;
      await lifecycleConvergenceGuard.runOnce(key, async () => {
        const reclaimed = await pc.patchIssue(issue.id, { status: "todo" });
        if (!reclaimed.ok) {
          await log(`[ORCHESTRATOR] Could not reclaim expired Jules monitor for [${issue.identifier || issue.id}] (${reclaimed.status}): ${reclaimed.text}`);
          return;
        }
        statusOverrides.set(issue.id, "todo");
        await log(`[ORCHESTRATOR] Reclaimed expired Jules monitor for [${issue.identifier || issue.id}] to todo: ${monitorDecision.reason}.`);
      });
      continue;
    }
    if (monitorDecision.action !== "resume_provider") continue;
    const key = `jules-monitor-resume:${issue.id}:${timeoutAt}`;
    // Paperclip's invalid-assignee cleanup can leave the legacy projection
    // (`executionState.monitor`) cleared while dropping `executionPolicy`.
    // That is a recoverable state, but it can persist across several ticks if
    // a concurrent heartbeat wins the write or the first PATCH fails. A
    // lifetime guard entry must not turn that state into a permanent stall:
    // allow the next heartbeat to retry until the native policy is observable.
    if (monitorStatus === "cleared" && monitorClearReason === "invalid_assignee" && !canReattachNativeMonitor) {
      lifecycleConvergenceGuard.clear(key);
    }
    await lifecycleConvergenceGuard.runOnce(key, async () => {
      const invalidAssigneeRepair = (issue.status === "in_progress" || issue.status === "blocked" || issue.status === "todo") &&
        monitorStatus === "cleared" && monitorClearReason === "invalid_assignee" &&
        issue.assigneeAgentId === julesAgentId;
      if ((!executionPolicy && !invalidAssigneeRepair && !monitorDetached) || (!canReattachNativeMonitor && !invalidAssigneeRepair && !monitorDetached) || typeof externalRef !== "string") {
        await log(`[ORCHESTRATOR] Refusing Jules monitor reattachment for [${issue.identifier || issue.id}]: native monitor payload is incomplete.`);
        return;
      }
      const reattachedPolicy = buildJulesMonitorReattachment(executionPolicy ?? { mode: "normal", stages: [] }, externalRef, Date.now());
      const resumed = await pc.patchIssue(issue.id, { status: "in_progress", executionPolicy: reattachedPolicy });
      if (!resumed.ok) {
        await log(`[ORCHESTRATOR] Could not resume expired Jules monitor for [${issue.identifier || issue.id}] (${resumed.status}): ${resumed.text}`);
        return;
      }
      statusOverrides.set(issue.id, "in_progress");
      reattachedJulesMonitorIssueIds.add(issue.id);
      await log(`[ORCHESTRATOR] Resumed expired Jules monitor for [${issue.identifier || issue.id}].`);
    });
  }

  // A Jules revision can be observed by several overlapping/restarted worker
  // heartbeats. Reconcile the resulting board artifacts by stable delegation
  // identity before scheduling any reviewer work. This is deliberately a
  // small command planner: it never infers provider decisions from prose.
  const boardSnapshots: BoardIssueSnapshot[] = lifecycleIssues.map((issue) => {
    const state = issue.rawIssue["executionState"];
    const stateRecord = state && typeof state === "object" && !Array.isArray(state)
      ? state as Record<string, unknown>
      : null;
    const delegation = typeof issue.rawIssue["description"] === "string"
      ? (issue.rawIssue["description"] as string).match(/paperclip-delegation\s+kind=([^\s]+)\s+parent=([^\s]+)\s+revision=([^\s]+)\s+stage=([^\s]+)/i)
      : null;
    const reviewGateKey = delegation
      ? `${delegation[1]}:${delegation[2]}:${delegation[3]}:${delegation[4]}`
      : null;
    const executionStatus = stateRecord?.["status"];
    const nativeReviewInteraction = Boolean(stateRecord?.["reviewRequest"] && typeof stateRecord["reviewRequest"] === "object");
    // Jules review children are created by the provider and therefore do not
    // inherit the parent's frontmatter. Their signed delegation marker is the
    // managed-scope proof; generic historical children remain untouched.
    const managed = issue.orchestratorManaged || isDelegatedReviewChild(issue) || Boolean(issue.parentId && lifecycleIssues.some((candidate) => candidate.id === issue.parentId && candidate.orchestratorManaged));
    const policy = issue.rawIssue["executionPolicy"];
    const policyRecord = policy && typeof policy === "object" && !Array.isArray(policy)
      ? policy as Record<string, unknown>
      : null;
    const policyMonitor = policyRecord?.["monitor"];
    const policyMonitorRecord = policyMonitor && typeof policyMonitor === "object" && !Array.isArray(policyMonitor)
      ? policyMonitor as Record<string, unknown>
      : null;
    const resumableMonitor = isAuthoritativeJulesMonitor(policy);
    const monitorExpired = Boolean(policyMonitorRecord?.["timeoutAt"] && Number.isFinite(Date.parse(String(policyMonitorRecord["timeoutAt"]))) && Date.now() >= Date.parse(String(policyMonitorRecord["timeoutAt"] as string)));
    const rawProducts = issue.rawIssue["workProducts"] ?? issue.rawIssue["work_products"];
    const hasJulesPullRequestProduct = Array.isArray(rawProducts) && rawProducts.some((product) => {
      if (!product || typeof product !== "object") return false;
      const candidate = product as Record<string, unknown>;
      const type = candidate["type"] ?? candidate["kind"];
      const metadata = candidate["metadata"];
      return (type === "pull_request" || type === "pull-request") &&
        typeof candidate["url"] === "string" &&
        metadata && typeof metadata === "object" && (metadata as Record<string, unknown>)["source"] === "jules";
    });
    const registeredPr = hasJulesPullRequestProduct ? registeredPullRequestFromIssue(issue) : undefined;
    const registeredOpenPullRequest = Boolean(
      registeredPr && !ghStatus.error && ghStatus.openPrs.some(
        (pr) => pr.url.replace(/\/$/, "").toLowerCase() === registeredPr.url.replace(/\/$/, "").toLowerCase(),
      ),
    );
    return {
      id: issue.id,
      identifier: issue.identifier || issue.id,
      status: (statusOverrides.get(issue.id) || issue.status) as BoardIssueSnapshot["status"],
      title: issue.title,
      managed,
      assigneeKind: issue.assigneeAgentId && managedJulesIds.has(issue.assigneeAgentId)
        ? "jules"
        : issue.assigneeAgentId && issue.assigneeAgentId === vibeReviewerAgentId
          ? "vibe_reviewer"
          : issue.assigneeAgentId === orchestratorId ? "orchestrator" : "other",
      executionRunLive: Boolean(issue.executionRunId) || ["queued", "running", "active", "waiting"].includes(String(executionStatus)),
      // The lifecycle pass may have just reattached a native Jules monitor.
      // Carry that same-tick proof into board reconciliation; otherwise the
      // stale pre-PATCH projection can immediately recover the open PR into
      // review and hand the issue back to Jules on the next heartbeat.
      resumableMonitor: resumableMonitor || reattachedJulesMonitorIssueIds.has(issue.id),
      monitorExpired: reattachedJulesMonitorIssueIds.has(issue.id) ? false : monitorExpired,
      nativeReviewInteraction,
      registeredOpenPullRequest,
      hasPullRequest: issue.status === "in_review" && !ghStatus.error && Boolean(ghStatus.openPrs.find((pr) => matchPrToIssue(pr, issue))),
      parentId: issue.parentId || null,
      reviewGateKey,
    };
  });
  const boardReviewRecoveryIds = new Set<string>();
  for (const command of planBoardReconciliation(boardSnapshots)) {
    const guardKey = `board-reconciliation:${command.action}:${command.issueId}`;
    const isReviewRecovery = command.action === "recover_to_review";
    const targetStatus = command.action === "cancel_duplicate_child"
      ? "cancelled"
      : isReviewRecovery ? "in_review" : "todo";
    const snapshot = boardSnapshots.find((candidate) => candidate.id === command.issueId);
    // The Paperclip projection can reopen an issue after the write if a stale
    // heartbeat still owns it. A completed in-process guard must not suppress
    // the next repair attempt in that case; idempotency is valid only after
    // the target status is observed on the board.
    if (snapshot && snapshot.status !== targetStatus) lifecycleConvergenceGuard.clear(guardKey);
    await lifecycleConvergenceGuard.runOnce(guardKey, async () => {
      if (command.action === "cancel_duplicate_child") {
        // Paperclip can immediately re-project an issue as in_progress when
        // its queued/running heartbeat is still alive. Fence the run first,
        // then transition the issue; otherwise cleanup itself recreates the
        // stale work it is supposed to retire.
        for (const run of heartbeatRuns.filter((candidate) => candidate.issueId === command.issueId && ["queued", "running", "active"].includes(candidate.status))) {
          const cancelledRun = await pc.cancelHeartbeatRun(run.id, `Superseded delegated review child ${command.issueId}`);
          if (!cancelledRun.ok) {
            await log(`[ORCHESTRATOR] Could not cancel run ${run.id} before child cleanup (${cancelledRun.status}): ${cancelledRun.text}`);
          }
        }
      }
      const patch = await pc.patchIssue(command.issueId, { status: targetStatus });
      if (!patch.ok) {
        await log(`[ORCHESTRATOR] Could not apply board reconciliation to [${command.issueId}] (${patch.status}): ${patch.text}`);
        return;
      }
      // Paperclip treats any comment on an issue as
      // `issue_reopened_via_comment`, which would immediately wake the issue
      // we just repaired. Keep this reconciliation write-only and use the
      // structured adapter log as its audit trail; user-facing comments are
      // reserved for genuine provider/reviewer interactions.
      statusOverrides.set(command.issueId, targetStatus);
      await log(`[ORCHESTRATOR] Applied ${command.action} to [${command.issueId}].`);
    });
  }

  // Apply the subtree barrier before individual child reconciliation. This
  // ordering is essential: a queued child must be cancelled before its issue
  // is closed, otherwise Paperclip can execute the stale run and reopen it.
  for (const parent of lifecycleIssues.filter((candidate) => ["done", "cancelled"].includes(candidate.status))) {
    const barrier = planTerminalParentBarrier({
      parent: { id: parent.id, status: parent.status },
      descendants: lifecycleIssues
        .filter((candidate) => candidate.parentId === parent.id)
        .map((candidate) => ({ id: candidate.id, status: candidate.status })),
      runs: heartbeatRuns.map((run) => ({ id: run.id, issueId: run.issueId, status: run.status })),
    });
    for (const runId of barrier.cancelRunIds) {
      const cancelled = await pc.cancelHeartbeatRun(runId, `Terminal parent barrier: ${barrier.reason}`);
      if (!cancelled.ok) {
        await log(`[ORCHESTRATOR] Could not cancel terminal-parent child run ${runId} (${cancelled.status}): ${cancelled.text}`);
      }
    }
    for (const childId of barrier.closeIssueIds) {
      const child = lifecycleIssues.find((candidate) => candidate.id === childId);
      if (!child || ["done", "cancelled"].includes(child.status)) continue;
      const closed = await pc.patchIssue(childId, { status: "cancelled" });
      if (!closed.ok) {
        await log(`[ORCHESTRATOR] Could not close terminal-parent child ${childId} (${closed.status}): ${closed.text}`);
      } else {
        statusOverrides.set(childId, "cancelled");
      }
    }
  }
  for (const issue of lifecycleIssues) {
    if (statusOverrides.has(issue.id)) continue;
    const sourceReference = typeof issue.rawIssue["description"] === "string"
      ? (issue.rawIssue["description"] as string).match(/source issue:\s*\[([^\]]+)\]/i)?.[1]
      : undefined;
    const source = issue.parentId
      ? lifecycleIssues.find((candidate) => candidate.id === issue.parentId) || null
      : sourceReference
        ? lifecycleIssues.find((candidate) => candidate.id === sourceReference || candidate.identifier === sourceReference) || null
        : null;
    const artifactDecision = decideRecoveryArtifact(
      issue,
      source,
      Boolean(issue.assigneeAgentId && ["idle", "running", "busy"].includes(managedAgentStatuses.get(issue.assigneeAgentId) || "")),
    );
    if (artifactDecision.action === "close") {
      const artifactKey = `recovery-artifact:${issue.id}`;
      if (issue.status === artifactDecision.status) continue;
      await lifecycleConvergenceGuard.runOnce(artifactKey, async () => {
        const patch = await pc.patchIssue(issue.id, { status: artifactDecision.status });
        if (!patch.ok) {
          await log(`[ORCHESTRATOR] Recovery artifact cleanup failed for [${issue.identifier || issue.id}] (${patch.status}): ${patch.text}`);
          return;
        }
        statusOverrides.set(issue.id, artifactDecision.status);
        await log(`[ORCHESTRATOR] Closed recovery artifact [${issue.identifier || issue.id}] (${artifactDecision.reason}).`);
      });
      continue;
    }
    const assignedWorker = issue.assigneeAgentId
      ? managedWorkerStates.find((worker) => worker.id === issue.assigneeAgentId) || {
          id: issue.assigneeAgentId,
          status: managedAgentStatuses.get(issue.assigneeAgentId) || "",
          adapterType: agentAdapterTypes.get(issue.assigneeAgentId) || "",
        }
      : undefined;
    const blockedWorkDecision = decideBlockedManagedWork(
      issue,
      assignedWorker?.adapterType || null,
      assignedWorker?.status || null,
    );
    if (blockedWorkDecision.action === "reclaim") {
      const reclaimKey = `blocked-managed-work:${issue.id}`;
      if (issue.status !== blockedWorkDecision.status) continue;
      await lifecycleConvergenceGuard.runOnce(reclaimKey, async () => {
        const patch = await pc.patchIssue(issue.id, { status: blockedWorkDecision.status });
        if (!patch.ok) {
          await log(`[ORCHESTRATOR] Stale managed work recovery failed for [${issue.identifier || issue.id}] (${patch.status}): ${patch.text}`);
          return;
        }
        statusOverrides.set(issue.id, blockedWorkDecision.status);
        await log(`[ORCHESTRATOR] Reclaimed stale managed work [${issue.identifier || issue.id}] (${blockedWorkDecision.reason}).`);
      });
      continue;
    }
    const decision = decideIssueLifecycleReconciliation(issue, lifecycleIssues);
    if (decision.action === "preserve") continue;
    const marker = `<!-- orchestrator:lifecycle:${decision.action}:${issue.id} -->`;
    try {
      await lifecycleConvergenceGuard.runOnce(`lifecycle:${decision.action}:${issue.id}`, async () => {
      // Comment history is useful only for idempotent audit text. A transient
      // Paperclip comment-read failure must not prevent the actual lifecycle
      // repair, otherwise an invalid state survives solely because telemetry
      // storage is unavailable.
      let comments: { body?: string }[] = [];
      try {
        comments = asArray<{ body?: string }>(await pc.listComments(issue.id));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await log(`[ORCHESTRATOR] Lifecycle comment history unavailable for [${issue.identifier || issue.id}]; continuing with state repair: ${msg}`);
      }
      if (comments.some((comment) => typeof comment.body === "string" && comment.body.includes(marker))) return;
      const patch = await pc.patchIssue(issue.id, { status: decision.status });
      if (!patch.ok) {
        await log(`[ORCHESTRATOR] Lifecycle reconciliation failed for [${issue.identifier || issue.id}] (${patch.status}): ${patch.text}`);
        return;
      }
      await pc.comment(issue.id, `${marker}\n[Orchestrator] ${decision.reason}. Reconciled to \`${decision.status}\`.`).catch(async (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        await log(`[ORCHESTRATOR] Lifecycle audit comment unavailable for [${issue.identifier || issue.id}]; state repair succeeded: ${msg}`);
      });
      statusOverrides.set(issue.id, decision.status);
      if (decision.action === "close_duplicate_diagnostic") lifecycleDuplicateCount++;
      else if (decision.action === "reclaim_orphan_in_progress") lifecycleOrphanCount++;
      else lifecycleClosedCount++;
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await log(`[ORCHESTRATOR] Lifecycle reconciliation error for [${issue.identifier || issue.id}]: ${msg}`);
    }
  }
  if (lifecycleClosedCount || lifecycleDuplicateCount || lifecycleOrphanCount) {
    await log(`[ORCHESTRATOR] Lifecycle reconciliation: closed=${lifecycleClosedCount}, duplicates=${lifecycleDuplicateCount}, orphan_in_progress=${lifecycleOrphanCount}`);
  }

const archiveResult = archiveResolvedBacklogFiles(workspacePath, parsedIssues);
  if (archiveResult.archivedCount > 0) {
    await log(`[ORCHESTRATOR] 📦 Archived ${archiveResult.archivedCount} completed tasks to docs/internals/backlog/resolved/`);
  }

  // 7.5. PHASE 1.5: Reclaim stalled in_progress sessions with no live runner or heartbeat
  const activeExecutionIds = new Set<string>();
  for (const issue of parsedIssues) {
    if (issue.executionRunId) activeExecutionIds.add(issue.id);
  }
  const julesThresholdMs = 48 * 60 * 60 * 1000;
  const vibeThresholdMs = config.stalledThresholdMinutes ? config.stalledThresholdMinutes * 60 * 1000 : 15 * 60 * 1000;
  const nowMs = Date.now();
  for (const issueId of liveHeartbeatIssueIds(heartbeatRuns, nowMs, julesThresholdMs)) {
    const issue = parsedIssues.find((i) => i.id === issueId);
    if (issue?.assigneeAgentId && managedJulesIds.has(issue.assigneeAgentId)) {
      activeExecutionIds.add(issueId);
    }
  }
  for (const issueId of liveHeartbeatIssueIds(heartbeatRuns, nowMs, vibeThresholdMs)) {
    const issue = parsedIssues.find((i) => i.id === issueId);
    if (issue?.assigneeAgentId && managedIds.has(issue.assigneeAgentId) && !managedJulesIds.has(issue.assigneeAgentId)) {
      activeExecutionIds.add(issueId);
    }
  }
  const stalled = identifyStalledIssues(parsedIssues, activeExecutionIds, {
    stalledThresholdMs: config.stalledThresholdMinutes ? config.stalledThresholdMinutes * 60 * 1000 : 15 * 60 * 1000,
    julesThresholdMs,
    managedAgentIds: managedIds,
    managedJulesIds,
    skipIssue: (issue) => isDelegatedReviewChild(issue) || hasDelegatedReviewChild(issue.id, parsedIssues),
  });

  let stalledReclaimedCount = 0;
  for (const { issue, idleDurationMs } of stalled) {
    const mins = Math.round(idleDurationMs / 60000);
    await log(
      `[ORCHESTRATOR] Reclaiming stalled task [${issue.identifier || issue.id}] "${issue.title}" (idle ${mins}m with no active heartbeat) -> todo`
    );
    try {
      const patch = await pc.patchIssue(issue.id, { status: "todo" });
      if (!patch.ok) {
        await log(`[ORCHESTRATOR] Warning: Failed to reclaim stalled issue (${patch.status}): ${patch.text}`);
        continue;
      }
      await pc.comment(
        issue.id,
        `[Orchestrator] Stalled session detected with no active heartbeat (idle ${mins}m). Safely reclaimed and returned to \`todo\`.`
      );
      statusOverrides.set(issue.id, "todo");
      stalledReclaimedCount++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await log(`[ORCHESTRATOR] Warning: Failed to reclaim stalled issue: ${msg}`);
    }
  }

  // 7.6. PHASE 1.6: Auto-unblock orphan blocked tasks with no active blocking dependencies
  const blockedIssues = parsedIssues.filter((i) => (statusOverrides.get(i.id) || i.status) === "blocked");
  let unblockedCount = 0;
  for (const issue of blockedIssues) {
    const sourceReference = typeof issue.rawIssue["description"] === "string"
      ? (issue.rawIssue["description"] as string).match(/source issue:\s*\[([^\]]+)\]/i)?.[1]
      : undefined;
    const source = issue.parentId
      ? parsedIssues.find((candidate) => candidate.id === issue.parentId) || null
      : sourceReference
        ? parsedIssues.find((candidate) => candidate.id === sourceReference || candidate.identifier === sourceReference) || null
        : null;
    const artifactDecision = decideRecoveryArtifact(
      issue,
      source,
      Boolean(issue.assigneeAgentId && ["idle", "running", "busy"].includes(managedAgentStatuses.get(issue.assigneeAgentId) || "")),
    );
    if (artifactDecision.action === "close") {
      const key = `recovery-artifact:${issue.id}`;
      lifecycleConvergenceGuard.clear(key);
      await lifecycleConvergenceGuard.runOnce(key, async () => {
        const patch = await pc.patchIssue(issue.id, { status: artifactDecision.status });
        if (!patch.ok) {
          await log(`[ORCHESTRATOR] Recovery artifact cleanup failed for [${issue.identifier || issue.id}] (${patch.status}): ${patch.text}`);
          return;
        }
        statusOverrides.set(issue.id, artifactDecision.status);
        await log(`[ORCHESTRATOR] Closed recovery artifact [${issue.identifier || issue.id}] (${artifactDecision.reason}).`);
      });
      continue;
    }
    const assignedWorker = issue.assigneeAgentId
      ? managedWorkerStates.find((worker) => worker.id === issue.assigneeAgentId) || {
          id: issue.assigneeAgentId,
          status: managedAgentStatuses.get(issue.assigneeAgentId) || "",
          adapterType: agentAdapterTypes.get(issue.assigneeAgentId) || "",
        }
      : undefined;
    const blockedWorkDecision = decideBlockedManagedWork(
      issue,
      assignedWorker?.adapterType || null,
      assignedWorker?.status || null,
    );
    if (blockedWorkDecision.action === "reclaim") {
      const key = `blocked-managed-work:${issue.id}`;
      lifecycleConvergenceGuard.clear(key);
      await lifecycleConvergenceGuard.runOnce(key, async () => {
        const patch = await pc.patchIssue(issue.id, { status: blockedWorkDecision.status });
        if (!patch.ok) {
          await log(`[ORCHESTRATOR] Stale managed work recovery failed for [${issue.identifier || issue.id}] (${patch.status}): ${patch.text}`);
          return;
        }
        statusOverrides.set(issue.id, blockedWorkDecision.status);
        await log(`[ORCHESTRATOR] Reclaimed stale managed work [${issue.identifier || issue.id}] (${blockedWorkDecision.reason}).`);
      });
      continue;
    }
    // A delegated review child, or its Jules parent while that child exists,
    // is governed by the Jules/ACP ladder. Never turn age/dependency cleanup
    // into an implicit reviewer decision or wakeup loop.
    if (isDelegatedReviewChild(issue) || hasDelegatedReviewChild(issue.id, parsedIssues)) {
      await log(`[ORCHESTRATOR] Preserving blocked delegated review state [${issue.identifier || issue.id}]`);
      continue;
    }
    const delegatedReviewReleased = hasDelegatedReviewHistory(issue.id, parsedIssues) &&
      Boolean(issue.assigneeAgentId && managedJulesIds.has(issue.assigneeAgentId));
    const missingDep = issue.dependencies.some((depId) => {
      return !parsedIssues.some((p) => p.id === depId || p.identifier === depId);
    });
    // Old Jules migrations can leave a deleted supervisor/dependency ID in the
    // markdown. Once all ACP review children are terminal, that stale edge
    // must not keep the persisted Jules session blocked forever.
    if (missingDep && !delegatedReviewReleased) continue;

    const hasUnresolvedDependency = issue.dependencies.some((depId) => {
      const dep = parsedIssues.find((p) => p.id === depId || p.identifier === depId);
      if (!dep) return true;
      const depStatus = statusOverrides.get(dep.id) || dep.status;
      return depStatus !== "done";
    });

    if (!hasUnresolvedDependency || delegatedReviewReleased) {
      const matchingPr = ghStatus.error ? undefined : ghStatus.openPrs.find((pr) => matchPrToIssue(pr, issue));
      // Once every delegated reviewer child is terminal, the child ladder has
      // released the parent. Jules must resume its persisted provider session
      // (rather than starting a duplicate implementation session from todo).
      const targetStatus = matchingPr
        ? "in_review"
        : (issue.assigneeAgentId && managedJulesIds.has(issue.assigneeAgentId) ? "in_progress" : "todo");
      const targetAssignee = matchingPr && reviewerAgentId ? reviewerAgentId : undefined;

      await log(
        `[ORCHESTRATOR] Unblocking orphan blocked task [${issue.identifier || issue.id}] "${issue.title}" -> ${targetStatus}`
      );
      try {
        const patch = await pc.patchIssue(
          issue.id,
          targetStatus === "in_review" && targetAssignee
            ? issuePatch("in_review", targetAssignee)
            : {
                status: targetStatus,
                ...(delegatedReviewReleased ? { executionPolicy: null } : {}),
              }
        );
        if (!patch.ok) {
          await log(`[ORCHESTRATOR] Warning: Failed to unblock issue (${patch.status}): ${patch.text}`);
          continue;
        }
        statusOverrides.set(issue.id, targetStatus);
        unblockedCount++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await log(`[ORCHESTRATOR] Warning: Failed to unblock issue: ${msg}`);
      }
    }
  }

  const overlayedIssues = parsedIssues.map((issue) =>
    statusOverrides.has(issue.id)
      ? { ...issue, status: statusOverrides.get(issue.id) as IssueState }
      : issue
  );

  let executionPolicyBackfillCount = 0;
  const mazewallPolicy = buildMazewallExecutionPolicy({
    vibeReviewerAgentId: lunaReviewerAgentId,
    reviewerAgentId: terraReviewerAgentId,
  });
  const delegatedReviewParentIds = new Set(
    parsedIssues
      .filter((issue) => isDelegatedReviewChild(issue) && issue.parentId)
      .map((issue) => issue.parentId as string),
  );
  if (mazewallPolicy) {
    for (const issue of overlayedIssues) {
      if (isDelegatedReviewChild(issue) || delegatedReviewParentIds.has(issue.id)) continue;
      if (!issueNeedsExecutionPolicyBackfill(issue, managedIds) &&
          !issueHasUnsafeVibeReviewParticipant(issue.rawIssue, vibeAgentId)) continue;
      const circuitKey = `execution-policy-backfill:${issue.id}`;
      if (capabilityCircuit.isOpen(circuitKey)) continue;
      await log(
        `[ORCHESTRATOR] Reconciling executionPolicy on [${issue.identifier || issue.id}] (assigned without dispatch; no status/assignee change)`,
      );
      try {
        const patch = await pc.patchIssue(issue.id, { executionPolicy: mazewallPolicy });
        const circuitState = capabilityCircuit.record(circuitKey, patch);
        if (!patch.ok) {
          const suffix = circuitState === "opened"
            ? " Capability circuit opened; this backfill will not be retried until the adapter is reloaded after a Paperclip authorization change."
            : "";
          await log(
            `[ORCHESTRATOR] Warning: Failed to backfill executionPolicy (${patch.status}): ${patch.text}${suffix}`,
          );
          continue;
        }
        executionPolicyBackfillCount++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await log(`[ORCHESTRATOR] Warning: Failed to backfill executionPolicy: ${msg}`);
      }
    }
  }

  let continuationWakeCount = 0;
  const continuations = selectSessionContinuations({
    issues: overlayedIssues.filter((issue) => issue.orchestratorManaged),
    workers: managedWorkerStates,
    runs: heartbeatRuns,
    now: nowMs,
  });
  for (const wake of continuations) {
    if (wokeThisTick.has(wake.agentId)) continue;
    const issue = overlayedIssues.find((i) => i.id === wake.issueId);
    await log(
      `[ORCHESTRATOR] Continuing live session on [${issue?.identifier || wake.issueId}] via ${wake.agentId}: ${wake.reason}`
    );
    await managedWakeup(wake.agentId, wake.reason, wake.issueId);
    wokeThisTick.add(wake.agentId);
    continuationWakeCount++;
  }

  const inProgressIssues = overlayedIssues.filter((i) => i.status === "in_progress");
  const reviewRecoveryIssues = overlayedIssues.filter(
    (issue) => issue.status === "done" && !mergedIssueIds.has(issue.id) && hasUnreviewedReadyPullRequest(issue),
  );
  for (const issue of reviewRecoveryIssues) {
    await log(
      `[ORCHESTRATOR] Recovering [${issue.identifier || issue.id}] from done: its registered PR is still ready_for_review and has no review verdict.`,
    );
    try {
      const patch = await pc.patchIssue(issue.id, { status: "in_review", assigneeAgentId: null });
      if (patch.ok) {
        statusOverrides.set(issue.id, "in_review");
      } else {
        await log(`[ORCHESTRATOR] Warning: failed to recover review state (${patch.status}): ${patch.text}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await log(`[ORCHESTRATOR] Warning: failed to recover review state: ${msg}`);
    }
  }
  const reviewRecoveryIds = new Set(reviewRecoveryIssues.map((issue) => issue.id));
  const inReviewIssues = overlayedIssues.filter((i) => {
    if (i.status === "in_review" || reviewRecoveryIds.has(i.id)) return true;
    // Paperclip may transiently normalize a native review handoff to
    // in_progress while it releases/reassigns the execution lock. Keep the
    // review state machine alive across that normalization, but only for the
    // exact two-stage review policy owned by this orchestrator. Ordinary
    // implementation issues must never enter the PR-review lane.
    const policy = i.rawIssue["executionPolicy"];
    const stages = policy && typeof policy === "object" && Array.isArray((policy as Record<string, unknown>)["stages"])
      ? (policy as Record<string, unknown>)["stages"] as unknown[]
      : [];
    // The list projection can omit executionPolicy, and Paperclip clears
    // executionState while handing a native review stage to its assignee.
    // Reviewer identity is the durable discriminator here: implementation
    // work is never assigned to either managed review agent, so this keeps
    // the review lane alive without admitting ordinary in-progress tasks.
    const assignedReviewer = i.assigneeAgentId === lunaReviewerAgentId || i.assigneeAgentId === terraReviewerAgentId;
    return i.status === "in_progress" && i.orchestratorManaged && assignedReviewer &&
      (stages.length === 0 || (stages.length === 2 &&
        stages.every((stage) => stage && typeof stage === "object" && (stage as Record<string, unknown>)["type"] === "review")));
  });
  const conflictResult = calculateConflictMatrix(overlayedIssues.filter((issue) => issue.orchestratorManaged));

  const julesRunning = inProgressIssues.filter((i) => i.assigneeAgentId === julesAgentId).length;
  const vibeRunning = inProgressIssues.filter((i) => i.assigneeAgentId === vibeAgentId).length;

  const julesCapacity = julesQuota.fetchedLive
    ? Math.min(
        config.maxConcurrentJules ?? julesQuota.effectiveAvailableCapacity + julesRunning,
        julesQuota.effectiveAvailableCapacity + julesRunning
      )
    : 0;
  const vibeCapacity = config.maxConcurrentVibe ?? 1;

  await log(
    `[ORCHESTRATOR] Backlog: total=${parsedIssues.length}, in_review=${inReviewIssues.length} | Jules running=${julesRunning}/${julesCapacity}, Vibe running=${vibeRunning}/${vibeCapacity}, conflict_edges=${conflictResult.conflictEdges.length}`
  );

  let existingApprovals: PaperclipApprovalSummary[] = [];
  try {
    const rawApprovals = asArray<{
      id: string;
      type: string;
      status: string;
      issueIds?: string[];
      title?: string;
      description?: string;
      payload?: Record<string, unknown>;
    }>(await pc.listApprovals(companyId));
    existingApprovals = rawApprovals.map((a) => ({
      id: a.id,
      type: a.type,
      status: (a.status as "pending" | "approved" | "rejected") || "pending",
      issueIds: a.issueIds || [],
      ...(a.title ? { title: a.title } : {}),
      ...(a.description ? { description: a.description } : {}),
      ...(a.payload ? { payload: a.payload } : {}),
    }));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await log(`[ORCHESTRATOR] Error: Failed to fetch approvals: ${msg}. Refusing to dispatch this tick.`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: msg,
      summary: `Failed to fetch approvals: ${msg}`,
    };
  }

  const requireApproval = config.requireTaskApproval !== false && (config as Record<string, unknown>)["requireApproval"] !== false;
  let reclaimedUnapprovedCount = 0;
  if (requireApproval) {
    for (const issue of parsedIssues) {
      if (!shouldReclaimUnapprovedStart(issue, existingApprovals)) continue;
      await log(
        `[ORCHESTRATOR] Reclaiming [${issue.identifier || issue.id}] "${issue.title}" — task_start is still pending; workers must not run this issue.`,
      );
      const reclaim = await pc.patchIssue(issue.id, { status: "todo", assigneeAgentId: null });
      if (reclaim.ok) {
        statusOverrides.set(issue.id, "todo");
        reclaimedUnapprovedCount++;
      } else {
        await log(`[ORCHESTRATOR] Warning: reclaim failed (${reclaim.status}): ${reclaim.text}`);
      }
    }
  }

  // 8. PHASE 2: Multi-Tier Review Pipeline (CI -> Vibe Fast Review -> Strong Model Review -> Operator Merge Approval)
  let reviewDispatchedCount = 0;
  for (const listedReviewTask of inReviewIssues) {
    // The company issue-list projection intentionally omits execution details
    // in some Paperclip versions. Review decisions must use the enriched issue
    // record; otherwise a human-escalated stage looks idle and is redispatched
    // on every heartbeat.
    let reviewTask = listedReviewTask;
    let authoritativeReviewIssue: Record<string, unknown> = listedReviewTask.rawIssue;
    try {
      const enriched = await pc.getIssue<Record<string, unknown>>(listedReviewTask.id);
      authoritativeReviewIssue = enriched;
      reviewTask = {
        ...listedReviewTask,
        rawIssue: Object.freeze({ ...listedReviewTask.rawIssue, ...enriched }),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await log(`[ORCHESTRATOR] Deferring review for [${listedReviewTask.identifier || listedReviewTask.id}]: enriched issue state unavailable: ${msg}`);
      continue;
    }
    if (isDelegatedReviewChild(reviewTask)) {
      await log(`[ORCHESTRATOR] Ignoring Jules coordination record [${reviewTask.identifier || reviewTask.id}] in PR-review pipeline.`);
      continue;
    }
    if (!reviewTask.orchestratorManaged) {
      await log(
        `[ORCHESTRATOR] Ignoring unmanaged in_review issue [${reviewTask.identifier || reviewTask.id}] as a native Paperclip task; no review or merge mutation will be attempted.`
      );
      continue;
    }
    // A registered Paperclip work product remains authoritative when gh is
    // unavailable. This keeps review routing alive in local-trusted installs;
    // GitHub REST is used below for the CI gate when possible.
    const matchingPr = ghStatus.error
      ? registeredPullRequestFromIssue(reviewTask)
      : ghStatus.openPrs.find((pr) => matchPrToIssue(pr, reviewTask));
    if (!matchingPr) {
      await log(`[ORCHESTRATOR] Ignoring in_review issue [${reviewTask.identifier || reviewTask.id}] without a registered PR.`);
      continue;
    }
    const reviewHeadSha = matchingPr.headRefOid || await fetchPullRequestHeadSha(matchingPr.url);
    if (!reviewHeadSha) {
      await log(`[ORCHESTRATOR] Deferring review for [${reviewTask.identifier || reviewTask.id}]: immutable PR head SHA is unavailable.`);
      continue;
    }
    if (matchingPr) {
      const mergeSafety = await checkPrMergeability(matchingPr.number, workspacePath);
      const mergeEval = evaluatePrMergeability(mergeSafety);
      const needsLocalRebase =
        mergeEval.isConflicting || mergeSafety.mergeStateStatus === "BEHIND";
      if (needsLocalRebase) {
        await log(
          `[ORCHESTRATOR] PR #${matchingPr.number} needs a local rebase (${mergeSafety.mergeable}/${mergeSafety.mergeStateStatus}). Jules will not be given a new session.`
        );
        const rebase = await rebasePrBranchLocally(mergeSafety, workspacePath);
        await pc.comment(reviewTask.id, `[Orchestrator] Local conflict resolution: ${rebase.message}`);
        if (!rebase.ok && vibeAgentId && managedIds.has(vibeAgentId)) {
          await pc.patchIssue(reviewTask.id, issuePatch("in_progress", vibeAgentId));
          statusOverrides.set(reviewTask.id, "in_progress");
          await managedWakeup(
            vibeAgentId,
            `Resolve merge conflicts locally for PR #${matchingPr.number} (${mergeSafety.headRefName} onto ${mergeSafety.baseRefName}). Do not open a new Jules session. ${rebase.message}`,
            reviewTask.id
          );
        }
        continue;
      }
    }
    const ciCheck = await checkPrCiIsGreen(matchingPr.number, workspacePath, matchingPr.url);

    let reviewInteractions: Array<{ id: string; kind?: string; status?: string; idempotencyKey?: string; continuationPolicy?: string; addresseeAgentId?: string | null; result?: unknown }> = [];
    try {
      reviewInteractions = asArray<Record<string, unknown>>(await pc.listInteractions(reviewTask.id))
        .filter((interaction): interaction is Record<string, unknown> & { id: string } => typeof interaction["id"] === "string")
        .map((interaction) => ({
          id: interaction["id"],
          ...(typeof interaction["kind"] === "string" ? { kind: interaction["kind"] } : {}),
          ...(typeof interaction["status"] === "string" ? { status: interaction["status"] } : {}),
          ...(typeof interaction["idempotencyKey"] === "string" ? { idempotencyKey: interaction["idempotencyKey"] } : {}),
          ...(typeof interaction["continuationPolicy"] === "string" ? { continuationPolicy: interaction["continuationPolicy"] } : {}),
          ...(typeof interaction["addresseeAgentId"] === "string" ? { addresseeAgentId: interaction["addresseeAgentId"] } : {}),
          result: interaction["result"],
        }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await log(`[ORCHESTRATOR] Warning: Failed to list review interactions for ${reviewTask.identifier}: ${msg}`);
    }

    const pipelineDecision = evaluateReviewPipelineProgress({
      issue: reviewTask,
      prNumber: matchingPr?.number,
      prUrl: matchingPr?.url,
      ciStatus: ciCheck,
      interactions: reviewInteractions,
      reviewHeadSha,
      existingApprovals,
      vibeReviewerAgentId,
      reviewerAgentId,
      lunaReviewerAgentId,
      terraReviewerAgentId,
      workerAgentId: julesAgentId || vibeAgentId,
      executionState: (reviewTask.rawIssue["executionState"] as {
        status?: string;
        currentStageIndex?: number | null;
        currentParticipant?: { type?: string; agentId?: string | null } | null;
      } | null | undefined),
      reviewerAgentStatus: (() => {
        const reviewerId = (reviewTask.rawIssue["executionState"] as { currentParticipant?: { agentId?: string | null } } | null | undefined)?.currentParticipant?.agentId;
        return reviewerId ? managedAgentStatuses.get(reviewerId) : undefined;
      })(),
    });

    if (pipelineDecision.action === "AWAIT_CI") {
      if (ciCheck.accessProblem) {
        await log(
          `[ORCHESTRATOR] 🚨 GITHUB CI VERIFICATION UNAVAILABLE for [${reviewTask.identifier || reviewTask.id}]: ${ciCheck.accessProblem} ` +
          `The PR may be green, but no review will be dispatched until Paperclip can verify it.`
        );
      }
      await log(
        `[ORCHESTRATOR] ⏳ [Stage 1 CI Gate] ${pipelineDecision.reason}`
      );
      continue;
    }
    if (pipelineDecision.action === "AWAIT_REVIEW_CONFIGURATION" || pipelineDecision.action === "AWAIT_REVIEW") {
      await log(`[ORCHESTRATOR] ⏳ [${pipelineDecision.stage}] ${pipelineDecision.reason}`);
      continue;
    }

    const runtimeOwnsReviewerAssignment = issueHasExecutionPolicy(reviewTask.rawIssue);
    if (runtimeOwnsReviewerAssignment) {
      if (["DISPATCH_VIBE_REVIEW", "DISPATCH_STRONG_REVIEW", "DISPATCH_LUNA_REVIEW", "DISPATCH_TERRA_REVIEW"].includes(pipelineDecision.action)) {
        await log(
          `[ORCHESTRATOR] [${reviewTask.identifier || reviewTask.id}] has executionPolicy; Paperclip runtime owns reviewer assignment while the orchestrator creates the bound review dialog. ${pipelineDecision.reason}`
        );
      }
    }

    if (["DISPATCH_VIBE_REVIEW", "DISPATCH_STRONG_REVIEW", "DISPATCH_LUNA_REVIEW", "DISPATCH_TERRA_REVIEW"].includes(pipelineDecision.action)) {
      const targetAgentId = "targetAgentId" in pipelineDecision ? pipelineDecision.targetAgentId : undefined;
      {
        const stageLabel = pipelineDecision.action === "DISPATCH_LUNA_REVIEW" ? "Stage 2 OpenAI Luna Review" : pipelineDecision.action === "DISPATCH_TERRA_REVIEW" ? "Stage 3 OpenAI Terra Review" : pipelineDecision.action === "DISPATCH_VIBE_REVIEW" ? "Stage 2 Vibe Fast Review" : "Stage 3 Strong Model Review";
        await log(
          `[ORCHESTRATOR] 📋 [${stageLabel}] Routing in_review task [${reviewTask.identifier || reviewTask.id}] "${reviewTask.title}" to ${targetAgentId}`
        );

        try {
          if (!targetAgentId) {
            await log(`[ORCHESTRATOR] Refusing to route review without a target agent`);
            continue;
          }
          if (targetAgentId && !managedIds.has(targetAgentId)) {
            await log(`[ORCHESTRATOR] Refusing to route review to unmanaged agent ${targetAgentId}`);
            continue;
          }
          let reviewInteractionId: string | undefined;
          let dialogCreated = false;
          const stage = pipelineDecision.action === "DISPATCH_LUNA_REVIEW" ? "luna" : pipelineDecision.action === "DISPATCH_TERRA_REVIEW" ? "terra" : pipelineDecision.action === "DISPATCH_VIBE_REVIEW" ? "vibe" : "strong";
          const reviewIdentity = {
            issueId: reviewTask.id,
            prUrl: matchingPr.url,
            headSha: reviewHeadSha,
            stage,
            reviewerAgentId: targetAgentId,
          } as const;
          try {
            const nativeReviewPolicy = buildMazewallExecutionPolicy({
              vibeReviewerAgentId: lunaReviewerAgentId,
              reviewerAgentId: terraReviewerAgentId,
            });
            const nativeReviewPolicyWithStableIds = nativeReviewPolicy
              ? {
                  ...nativeReviewPolicy,
                  stages: nativeReviewPolicy.stages.map((reviewStage, index) => ({
                    ...reviewStage,
                    id: index === 0 ? NATIVE_PR_REVIEW_STAGE_IDS.luna : NATIVE_PR_REVIEW_STAGE_IDS.terra,
                  })),
                }
              : null;
            const participantPatch = await pc.patchIssue(reviewTask.id, {
              // Request the native workflow transition in the same atomic
              // patch as the policy. Without this, Paperclip correctly
              // preserves an existing idle executionState and the queued
              // interaction wake is cancelled as an assignee change.
              status: "in_review",
              // Paperclip derives the persisted execution participant from
              // the issue assignee. Keeping the previous Luna assignee here
              // silently rewinds the native state to stage 0, even when the
              // adapter supplied Terra's executionState.
              assigneeAgentId: targetAgentId,
              executionPolicy: nativeReviewPolicyWithStableIds,
              executionState: buildNativeReviewExecutionState(
                (reviewTask.rawIssue["executionState"] as Record<string, unknown> | null | undefined),
                stage,
                targetAgentId,
              ),
            });
            if (!participantPatch.ok) {
              throw new Error(`Native review participant setup failed (${participantPatch.status}): ${participantPatch.text}`);
            }
            const dialogPlan = planReviewDialog(reviewIdentity, reviewInteractions);
            for (const stale of reviewInteractions.filter((interaction) =>
              interaction.kind === "request_item_verdicts" && interaction.status === "pending" &&
              isReviewInteractionForIssue(interaction.idempotencyKey, reviewTask.id) &&
              (interaction.idempotencyKey !== reviewInteractionIdempotencyKey(reviewIdentity) ||
                interaction.continuationPolicy !== "wake_assignee" || interaction.addresseeAgentId !== targetAgentId),
            )) {
              await pc.withdrawInteraction(reviewTask.id, stale.id, "Superseded by a review dialog for the current immutable PR head.");
            }
            if (dialogPlan.action === "reuse") {
              reviewInteractionId = dialogPlan.interactionId;
            } else {
              const createdInteraction = await pc.createInteraction(
                reviewTask.id,
                buildReviewInteractionRequest(reviewIdentity),
              );
              if (!createdInteraction.ok) {
                throw new Error(`Native review dialog creation failed (${createdInteraction.status}): ${createdInteraction.text}`);
              }
              const created = createdInteraction.data;
              reviewInteractionId = created && typeof created === "object" && typeof (created as Record<string, unknown>)["id"] === "string"
                ? (created as Record<string, unknown>)["id"] as string
                : undefined;
              if (!reviewInteractionId) {
                throw new Error("Native review dialog creation returned no interaction id");
              }
              dialogCreated = true;
            }
          } catch (interactionError) {
            await log(`[ORCHESTRATOR] 🚨 Failed to create native review dialog for [${reviewTask.identifier || reviewTask.id}]: ${String(interactionError)}`);
            continue;
          }
          // In this Paperclip version, creating an addressed interaction does
          // not reliably start an ACP run. Explicitly wake the addressee for
          // both a newly-created and a reused pending card. The verified
          // Terra assignee/state above makes this wake belong to the current
          // review stage instead of being cancelled as a stale assignee wake.
          if (reviewInteractionId) {
            await managedWakeup(
              targetAgentId,
              `Review PR #${matchingPr.number} for ${reviewTask.identifier || reviewTask.id}; respond to native review interaction ${reviewInteractionId}. This is a read-only review; do not modify files.`,
              reviewTask.id,
              { recoverStaleExecution: true },
            );
            wokeThisTick.add(`${targetAgentId}:${reviewTask.id}`);
            reviewDispatchedCount++;
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          await log(`[ORCHESTRATOR] Warning: Failed to route review task: ${msg}`);
        }
      }
    } else if (pipelineDecision.action === "REASSIGN_TO_WORKER") {
      const workerId = pipelineDecision.targetAssigneeId;
      if (!workerId || !managedIds.has(workerId)) {
        await log(`[ORCHESTRATOR] Refusing to reassign [${reviewTask.identifier}] to unmanaged worker ${workerId}`);
        continue;
      }
      await log(
        `[ORCHESTRATOR] Code review requested changes for [${reviewTask.identifier || reviewTask.id}]. Reassigning back to worker agent (${workerId}) in_progress`
      );

      try {
        const patch = await pc.patchIssue(reviewTask.id, issuePatch("in_progress", workerId));
        if (!patch.ok) {
          await log(`[ORCHESTRATOR] Warning: Reassign failed (${patch.status}): ${patch.text}`);
          continue;
        }
        statusOverrides.set(reviewTask.id, "in_progress");
        await managedWakeup(
          workerId,
          `Native PR review needs work for [${reviewTask.identifier || reviewTask.id}]: ${pipelineDecision.feedbackSummary || "See the bound review dialog."}`,
          reviewTask.id,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await log(`[ORCHESTRATOR] Warning: Failed to reassign after review: ${msg}`);
      }
    } else if (pipelineDecision.action === "RECONCILE_OPERATOR_GATE") {
      const reconciliationKey = `${reviewTask.id}:${pipelineDecision.approvalId}`;
      if (reconciledOperatorGates.has(reconciliationKey)) {
        continue;
      }
      const rawExecutionState = Object.prototype.hasOwnProperty.call(authoritativeReviewIssue, "executionState")
        ? authoritativeReviewIssue["executionState"]
        : null;
      const rawExecutionPolicy = Object.prototype.hasOwnProperty.call(authoritativeReviewIssue, "executionPolicy")
        ? authoritativeReviewIssue["executionPolicy"]
        : null;
      // The issue-list projection may omit fields that the detail response
      // represents as null. Treat both null and undefined as cleared; using
      // strict `!== null` here turned every heartbeat into a write/log even
      // after reconciliation had already succeeded.
      const staleReviewerOwnership = hasStaleReviewerOwnership({
        // Use the enriched detail projection. The issue-list row can retain
        // the previous reviewer assignee after Paperclip has already cleared
        // it, which would otherwise defeat this idempotency guard forever.
        assigneeAgentId: Object.prototype.hasOwnProperty.call(authoritativeReviewIssue, "assigneeAgentId")
          ? authoritativeReviewIssue["assigneeAgentId"] as string | null | undefined
          : null,
        executionState: rawExecutionState,
        executionPolicy: rawExecutionPolicy,
      });
      if (staleReviewerOwnership) {
        try {
          const reconciled = await pc.patchIssue(reviewTask.id, operatorGateReconciliationPatch());
          if (!reconciled.ok) {
            await log(`[ORCHESTRATOR] Warning: operator-gate reconciliation failed (${reconciled.status}): ${reconciled.text}`);
          } else {
            statusOverrides.set(reviewTask.id, "in_review");
            reconciledOperatorGates.add(reconciliationKey);
            await log(`[ORCHESTRATOR] [Stage 4 Operator Approval] Cleared stale reviewer ownership for [${reviewTask.identifier || reviewTask.id}]; approval ${pipelineDecision.approvalId} remains pending.`);
          }
        } catch (err: unknown) {
          await log(`[ORCHESTRATOR] Warning: operator-gate reconciliation failed: ${String(err)}`);
        }
      }
    } else if (pipelineDecision.action === "CREATE_MERGE_APPROVAL") {
      const mergeDecision = evaluatePrMergeApproval(reviewTask, matchingPr?.number || 0, existingApprovals, {
        prUrl: matchingPr?.url,
        vibeSummary: pipelineDecision.vibeSummary,
        strongSummary: pipelineDecision.strongSummary,
      });

      if (mergeDecision.action === "CREATE_MERGE_APPROVAL_REQUEST") {
        await log(
          `[ORCHESTRATOR] [Stage 4 Operator Approval] Creating final merge approval card in Paperclip for PR #${matchingPr?.number || 0}`
        );
        try {
          const created = await pc.createApproval(companyId, {
            type: "request_board_approval",
            title: mergeDecision.title,
            description: mergeDecision.description,
            issueIds: [reviewTask.id],
            payload: {
              action: "task_merge",
              issueId: reviewTask.id,
              prNumber: matchingPr?.number,
              prUrl: matchingPr?.url,
            },
          });
          if (!created.ok) {
            await log(`[ORCHESTRATOR] Warning: Failed to create merge approval (${created.status}): ${created.text}`);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          await log(`[ORCHESTRATOR] Warning: Failed to create merge approval: ${msg}`);
        }
      }
    } else if (pipelineDecision.action === "EXECUTE_MERGE") {
      const prNum = matchingPr?.number || pipelineDecision.prNumber;
      if (prNum) {
        const mergeSafety = await checkPrMergeability(prNum, workspacePath);
        const mergeEval = evaluatePrMergeability(mergeSafety);
        if (!mergeEval.canMerge) {
          await log(`[ORCHESTRATOR] [Merge Blocked] ${mergeEval.reason}`);
          if (mergeEval.isConflicting) {
            const rebase = await rebasePrBranchLocally(mergeSafety, workspacePath);
            await pc.comment(reviewTask.id, `[Orchestrator] Local conflict resolution: ${rebase.message}`);
            if (rebase.ok) {
              await log(`[ORCHESTRATOR] Local rebase succeeded for PR #${prNum}. Merge deferred to the next tick.`);
              continue;
            }
            if (vibeAgentId && managedIds.has(vibeAgentId)) {
              await log(
                `[ORCHESTRATOR] Local rebase failed; assigning managed Vibe to resolve conflicts on the host. A new Jules session cannot rebase this branch.`
              );
              await pc.patchIssue(reviewTask.id, issuePatch("in_progress", vibeAgentId));
              statusOverrides.set(reviewTask.id, "in_progress");
              await managedWakeup(
                vibeAgentId,
                `Resolve merge conflicts locally for PR #${prNum} (${mergeSafety.headRefName} onto ${mergeSafety.baseRefName}). Do not open a new Jules session. ${rebase.message}`,
                reviewTask.id
              );
            }
          }
          continue;
        }

        await log(
          `[ORCHESTRATOR] [Stage 4 Operator Approval] Operator approved merge for PR #${prNum}. Executing merge...`
        );
        try {
          await execFileAsync("gh", ["pr", "merge", String(prNum), "--merge", "--delete-branch"], {
            cwd: workspacePath,
          });
          await pc.patchIssue(reviewTask.id, { status: "done" });
          statusOverrides.set(reviewTask.id, "done");
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          await log(`[ORCHESTRATOR] Warning: Failed to execute automated merge: ${msg}`);
        }
      }
    }
  }

  // 9. PHASE 3: Route ambiguous / open_questions tasks to Vibe Clarifier Lane
  let clarifierDispatchedCount = 0;
  if (vibeAgentId && managedIds.has(vibeAgentId) && vibeRunning < vibeCapacity) {
    const clarificationCandidates = selectClarificationCandidates(
      overlayedIssues.filter((issue) => issue.orchestratorManaged),
      vibeAgentId,
      vibeCapacity - vibeRunning
    );
    for (const cand of clarificationCandidates) {
      await log(
        `[ORCHESTRATOR] Routing ambiguous task [${cand.issue.identifier || cand.issue.id}] "${cand.issue.title}" to Vibe Clarification Lane`
      );
      try {
        const patch = await pc.patchIssue(cand.issue.id, issuePatch("in_progress", vibeAgentId));
        if (!patch.ok) {
          await log(`[ORCHESTRATOR] Warning: Clarifier assign failed (${patch.status}): ${patch.text}`);
          continue;
        }
        statusOverrides.set(cand.issue.id, "in_progress");
        await managedWakeup(
          vibeAgentId,
          `Conduct task interview, clarify open questions, and formulate implementation specification for [${cand.issue.identifier || cand.issue.id}]`,
          cand.issue.id
        );
        clarifierDispatchedCount++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await log(`[ORCHESTRATOR] Warning: Clarifier dispatch failed: ${msg}`);
      }
    }
  }

  const dispatchIssues = overlayedIssues.filter((issue) => issue.orchestratorManaged).map((issue) =>
    statusOverrides.has(issue.id) ? { ...issue, status: statusOverrides.get(issue.id) as IssueState } : issue
  );
  const conflictForDispatch = calculateConflictMatrix(dispatchIssues);

  // 10. PHASE 4: Multi-Lane Implementation Dispatching
  const candidateSelections = selectNextTasksMultiLane(dispatchIssues, conflictForDispatch, {
    julesAgentId,
    vibeAgentId,
    julesCapacity,
    vibeCapacity,
    julesRunningCount: julesRunning,
    vibeRunningCount: vibeRunning,
    // A project may receive zero capacity when the company has more runnable
    // projects than slots. Never turn that safe allocation into a dispatch.
    maxToSelect: Math.max(0, julesCapacity - julesRunning + (vibeCapacity - vibeRunning)),
    extraLockedFiles: ghStatus.openPrFiles,
  });

  if (candidateSelections.length === 0) {
    const reason =
      julesRunning >= julesCapacity && vibeRunning >= vibeCapacity
        ? `Worker lanes at full capacity (Jules: ${julesRunning}/${julesCapacity}, Vibe: ${vibeRunning}/${vibeCapacity})`
        : "No unblocked implementation tasks ready in backlog/todo";

    await log(`[ORCHESTRATOR] Implementation dispatch: ${reason}.`);
    const summary = `Orchestrator tick: ${mergedAutoCompleted} merged tasks reconciled, ${archiveResult.archivedCount} archived, ${reviewDispatchedCount} reviews routed, ${clarifierDispatchedCount} clarified, backfilled ${executionPolicyBackfillCount} execution policies, continued ${continuationWakeCount} live sessions, 0 new dev tasks dispatched (${reason}).`;
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary,
    };
  }

  // existingApprovals was evaluated in Phase 2

  let dispatchedCount = 0;
  let approvalsRequestedCount = 0;
  let awaitingApprovalCount = 0;

  for (const selection of candidateSelections) {
    const targetIssueId = selection.issue.id;
    const targetAgentId = selection.targetAgentId;

    const approvalDecision = evaluateTaskStartApproval(
      selection.issue,
      targetAgentId || "",
      existingApprovals,
      requireApproval
    );

    if (approvalDecision.action === "CREATE_APPROVAL_REQUEST") {
      await log(
        `[ORCHESTRATOR] ⏳ Requesting operator start approval for [${selection.issue.identifier || selection.issue.id}] "${selection.issue.title}" -> ${targetAgentId || "worker"}`
      );
      try {
        const createRes = await pc.createApproval(companyId, {
          type: "request_board_approval",
          payload: {
            action: "task_start",
            title: approvalDecision.title,
            description: approvalDecision.description,
            issueId: targetIssueId,
            identifier: selection.issue.identifier,
            issueTitle: selection.issue.title,
            targetAgentId,
            priority: selection.issue.priority,
            component: selection.issue.component,
            targetFiles: selection.issue.targetFiles,
            reason: selection.reason,
          },
        });
        if (createRes.ok) {
          approvalsRequestedCount++;
        } else {
          await log(`[ORCHESTRATOR] Warning: Failed to create start approval (${createRes.status}): ${createRes.text}`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await log(`[ORCHESTRATOR] Warning: Failed to create approval request: ${msg}`);
      }
      continue;
    }

    if (approvalDecision.action === "AWAIT_APPROVAL") {
      await log(
        `[ORCHESTRATOR] ⏳ [${selection.issue.identifier || selection.issue.id}] "${selection.issue.title}" is awaiting operator approval (${approvalDecision.reason})`
      );
      awaitingApprovalCount++;
      continue;
    }

    if (approvalDecision.action === "SKIP_REJECTED") {
      await log(
        `[ORCHESTRATOR] 🛑 [${selection.issue.identifier || selection.issue.id}] "${selection.issue.title}" start was rejected by operator (${approvalDecision.reason}). Skipping.`
      );
      continue;
    }

    const transition = evaluateIssueTransition(selection.issue.status, selection.issue.assigneeAgentId, {
      type: "DISPATCH",
      targetAgentId: targetAgentId || "",
      reason: selection.reason,
    });

    if (!transition.isAllowed) continue;

    await log(
      `[ORCHESTRATOR] 🚀 Dispatching [${selection.issue.identifier || selection.issue.id}] "${selection.issue.title}" (Priority: ${selection.issue.priority}) -> Agent ${targetAgentId || "unassigned"} (${selection.reason})`
    );

    try {
      const effectiveAssigneeId = targetAgentId || julesAgentId || vibeAgentId;
      if (!effectiveAssigneeId || !managedIds.has(effectiveAssigneeId)) {
        await log(`[ORCHESTRATOR] Refusing to dispatch [${selection.issue.identifier}] to unmanaged agent ${effectiveAssigneeId}`);
        continue;
      }
      const policy = buildMazewallExecutionPolicy({
        vibeReviewerAgentId: lunaReviewerAgentId,
        reviewerAgentId: terraReviewerAgentId,
      });
      const updateRes = await pc.patchIssue(targetIssueId, {
        ...issuePatch(transition.toStatus as "in_progress", effectiveAssigneeId),
        ...(policy ? { executionPolicy: policy } : {}),
      });

      if (!updateRes.ok) {
        throw new Error(`Failed to update issue status: HTTP ${updateRes.status} ${updateRes.text}`);
      }

      await managedWakeup(
        targetAgentId,
        `Task [${selection.issue.identifier || selection.issue.id}] dispatched by Task Orchestrator`,
        targetIssueId
      );

      dispatchedCount++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await log(`[ORCHESTRATOR] ❌ Dispatch error for issue ${targetIssueId}: ${msg}`);
    }
  }

  const elapsed = Date.now() - t0;
  const summary = `Reconciled with remote (${mergedAutoCompleted} merged PRs completed, ${archiveResult.archivedCount} files archived), requested ${approvalsRequestedCount} approvals (${awaitingApprovalCount} pending), backfilled ${executionPolicyBackfillCount} execution policies, continued ${continuationWakeCount} live sessions, dispatched ${dispatchedCount} tasks in ${elapsed}ms.`;
  
  const dashboardCard = formatOrchestratorDashboardCard({
    companyId,
    totalIssues: parsedIssues.length,
    inProgressCount: inProgressIssues.length,
    inReviewCount: inReviewIssues.length,
    resolvedCount: parsedIssues.filter((i) => i.status === "done").length,
    todoCount: parsedIssues.filter((i) => i.status === "todo" || i.status === "backlog").length,
    julesQuota,
    julesRunning,
    julesCapacity,
    vibeRunning,
    vibeCapacity,
    ghStatus,
    conflictResult,
    approvalsPendingCount: awaitingApprovalCount + approvalsRequestedCount,
    elapsedMs: elapsed,
    agentHealth: agentHealthReport,
  });

  await log(`\n${dashboardCard}\n`);
  await log(`[ORCHESTRATOR] ✅ ${summary}`);

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    summary,
  };
}
