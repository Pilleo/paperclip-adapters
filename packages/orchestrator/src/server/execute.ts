import { checkPrMergeability, evaluatePrMergeability } from "../core/git-safety.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
const execFileAsync = promisify(execFile);

// Paperclip 2026.824 can return a stale reviewer-owned issue projection to a
// subsequent heartbeat after the operator gate was reconciled. Keep a local
// idempotency fence so that projection drift cannot turn the same successful
// repair into a write every minute. The key includes the durable approval;
// restarting the adapter safely revalidates the current state once.
const reconciledOperatorGates = new Set<string>();

const lastSyncDisposition = new Map<string, string>();

import { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { extractIssueMetadata, normalizeGitHubOwnerRepo, resolvePaperclipProject, resolveProjectWorkspace, resolveProjectMetadata, type PaperclipProjectRecord } from "../core/parser.js";
import { calculateConflictMatrix, selectNextTasksMultiLane } from "../core/dispatcher.js";
import { managedWorkerLane, resolveWorkerLaneCapacity } from "../core/worker-lane-state.js";
import { checkWorkspaceConsistency } from "../core/consistency.js";
import {
  classifyAuthoritativeHeartbeatScope,
  resolveHeartbeatProjectSelection,
  type ApprovalScopeRecord,
  type HeartbeatScopeReference,
  type HeartbeatRunScopeRecord,
} from "../core/heartbeat-project-scope.js";
import { ensureManagedProjectCheckout, managedProjectCheckoutPath } from "../core/project-managed-checkout.js";
import { fetchGitHubPullRequest, fetchGitHubPullRequests, hasUnreviewedReadyPullRequest, matchPrToIssue, registeredPullRequestFromIssue, checkPrCiIsGreen, fetchPullRequestHeadSha, resolvePrCiGate } from "../core/github-sync.js";
import { evaluateIssueTransition } from "../core/state-machine.js";
import { readWorkspaceGitRemote, syncBacklogMarkdownToPaperclip } from "../core/backlog-sync.js";
import { archiveResolvedBacklogFiles } from "../core/backlog-archiver.js";
import { selectClarificationCandidates } from "../core/clarifier.js";
import { selectStartApprovalCandidates } from "../core/start-approval-scheduling.js";
import { ParsedIssueMetadata } from "../core/types.js";
import {
  evaluateTaskStartApproval,
  evaluatePrMergeApproval,
  findTaskStartApproval,
  shouldReclaimUnapprovedStart,
  PaperclipApprovalSummary,
} from "../core/approvals.js";
import { evaluateAuthoritativeDependencies } from "../core/dependency-gate.js";
import { formatOrchestratorDashboardCard } from "../core/telemetry-card.js";
import { identifyStalledIssues } from "../core/stalled-session-reaper.js";
import { hasDelegatedReviewChild, hasDelegatedReviewHistory, isDelegatedReviewChild } from "../core/recovery-eligibility.js";
import { evaluateReviewPipelineProgress, hasStaleReviewerOwnership, isReviewDispatchDecision, operatorGateReconciliationPatch, reviewDispatchStage } from "../core/review-pipeline.js";
import { buildReviewInteractionRequest, hasCompletedNativeApprovalLadderForHead, hasNativeRejectionForHead, isCanonicalReviewCardKey, isReviewInteractionForIssue, planReviewDialog, reviewInteractionIdempotencyKey, reviewInteractionIdempotencyKeys, selectReviewAttempt, selectReviewCardsToWithdrawAfterRejection, selectReviewRunDispatch, shouldDeferPrReviewDispatch, type PrReviewStage } from "../core/review-interaction-state.js";
import { findReviewCardBinding, nativeReviewRecoveryWakeKey } from "../core/review-session-state.js";
import { prepareAndWakeNativeReview, revalidateNativeReviewWake, selectNativeReviewWakeAnchor } from "../core/native-review-recovery.js";
import {
  buildMazewallExecutionPolicy,
  NATIVE_PR_REVIEW_STAGE_IDS,
  issueHasExecutionPolicy,
  issueHasUnsafeVibeReviewParticipant,
  issueNeedsExecutionPolicyBackfill,
  nativePrReviewCleanupPatch,
  nativePrReviewWaitPatch,
  shouldTakeOverNativePrReview,
  shouldRecoverNativePrReview,
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
import { capabilityCircuit, fleetCapabilityCircuitKey } from "../core/capability-circuit.js";
import { evaluateStructuredReviewerEligibility, isReviewerEligibilityFailure } from "../core/reviewer-eligibility.js";
import { buildReviewWaitState, isReviewWaitState } from "../core/review-wait-state.js";
import { isSameReviewerUnavailableRecovery, reviewerUnavailableRecoveryPayload } from "../core/review-recovery.js";
import { canPromoteJulesPrToReview, hasJulesMonitorClaim, isAuthoritativeJulesMonitor } from "../core/jules-monitor-state.js";
import { decideIssueLifecycleReconciliation } from "../core/issue-lifecycle-reconciliation.js";
import { ConvergenceGuard } from "../core/convergence-guard.js";
import { planTerminalParentBarrier } from "../core/terminal-parent-barrier.js";
import { buildJulesMonitorReattachment, decideJulesMonitorReconciliation, resolveJulesMonitorSessionId } from "../core/jules-monitor-reconciliation.js";
import {
  buildJulesExecutionReconciliationPayload,
  decideJulesExecutionBlockerRecovery,
  parseJulesExecutionBlockerPointer,
} from "../core/jules-execution-blocker-reconciliation.js";
import { resolvedJulesPlanVerdict } from "../core/jules-plan-verdict-continuation.js";
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
import { provisionNativeReviewMcpHome, resolveNativeReviewMcpHome, type NativeReviewWorkerKey } from "../core/native-review-mcp-home.js";
import {
  decideJulesPlanNativeReviewRecovery,
  decideNativeReviewRecovery,
  nativeReviewRecoveryIssuePatch,
} from "../core/native-review-recovery-state.js";

// One orchestrator process can receive overlapping Paperclip heartbeats. Keep
// merge effects single-flight so concurrent ticks cannot duplicate comments or
// otherwise race on the same issue. The board is still re-read on each tick;
// this only protects the read/decide/write window within this adapter process.
const mergeConvergenceGuard = new ConvergenceGuard();
// Approval invalidation is intentionally independent of issue completion. A
// GitHub merge is terminal even if Paperclip temporarily rejects the board
// write; a later heartbeat must retry only that stale-card cleanup.
const mergeApprovalInvalidationGuard = new ConvergenceGuard();
const lifecycleConvergenceGuard = new ConvergenceGuard();
// A stale reviewer card must be withdrawn exactly once after a structured
// rejection. Without this fence, overlapping heartbeats can repeatedly race
// the worker transition and leave Terra/legacy cards able to wake reviewers
// after the PR has returned to Jules.
const reviewRejectionConvergenceGuard = new ConvergenceGuard();
// Compatibility fence for Paperclip hot-restart projections. A pending typed
// card is the review lock; this guard prevents overlapping orchestrator ticks
// from restoring/waking the same card more than once.
const nativeReviewRecoveryConvergenceGuard = new ConvergenceGuard();
const agentIncidentDeduper = new IncidentDeduper();

// Give Paperclip's normal native-card dispatch one quiet heartbeat window
// before taking the compatibility wake path. This is deliberately internal:
// no status mutation, comment, or provider poll is emitted while waiting.
const JULES_PLAN_NATIVE_REVIEW_RECOVERY_GRACE_MS = 60_000;

export interface OrchestratorAdapterConfig {
  readonly reconciliationMode?: "normal" | "freeze" | undefined;
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
  const runId = context.runId?.trim() || process.env["PAPERCLIP_RUN_ID"]?.trim() || "";
  const agentId = context.agent?.id?.trim() || "";
  const companyId = context.agent?.companyId || String(rawContext["companyId"] || "");
  const apiUrl = ((context.config as Record<string, unknown> | undefined)?.["apiUrl"] as string | undefined)
    || process.env["PAPERCLIP_API_URL"] || "http://127.0.0.1:3100";
  const authToken =
    (context as AdapterExecutionContext & { authToken?: string }).authToken
    || process.env["PAPERCLIP_AGENT_TOKEN"]
    || process.env["PAPERCLIP_API_KEY"];
  const pc = createPaperclipHttp({ apiUrl, authToken, runId: runId || undefined, localTrustedBoardWrites: true });
  let scopeReference: Exclude<HeartbeatScopeReference, { readonly kind: "invalid_explicit_scope" }>;
  try {
    const run = runId ? await pc.getHeartbeatRun<HeartbeatRunScopeRecord>(runId) : {};
    const snapshot = run.contextSnapshot && typeof run.contextSnapshot === "object" && !Array.isArray(run.contextSnapshot)
      ? run.contextSnapshot as Readonly<Record<string, unknown>>
      : {};
    await context.onLog?.("stdout", `[ORCHESTRATOR] Authoritative heartbeat scope evidence: ${JSON.stringify({
      source: snapshot["source"] ?? null,
      reason: snapshot["reason"] ?? null,
      wakeSource: snapshot["wakeSource"] ?? null,
      wakeReason: snapshot["wakeReason"] ?? null,
      projectId: snapshot["projectId"] ?? null,
      issueId: snapshot["issueId"] ?? null,
      approvalId: snapshot["approvalId"] ?? null,
    })}\n`);
    const authority = classifyAuthoritativeHeartbeatScope({
      runId,
      agentId,
      invocationContext: rawContext,
      run,
    });
    if (authority.kind === "invalid") {
      const message = `Invalid authoritative heartbeat scope (${authority.reason})`;
      await context.onLog?.("stderr", `[ORCHESTRATOR] 🚨 ${message}\n`);
      return { exitCode: 1, signal: null, timedOut: false, errorMessage: message, summary: message };
    }
    scopeReference = authority.reference;
  } catch (err: unknown) {
    const message = `Could not load authoritative heartbeat scope: ${err instanceof Error ? err.message : String(err)}`;
    await context.onLog?.("stderr", `[ORCHESTRATOR] 🚨 ${message}\n`);
    return { exitCode: 1, signal: null, timedOut: false, errorMessage: message, summary: message };
  }

  const scopeDescription = (() => {
    switch (scopeReference.kind) {
      case "project": return `project:${scopeReference.projectId}`;
      case "issue": return `issue:${scopeReference.issueId}`;
      case "approval": return `approval:${scopeReference.approvalId}`;
      case "unscoped_timer": return "scheduler_timer";
    }
  })();
  await context.onLog?.("stdout", `[ORCHESTRATOR] Authoritative heartbeat scope: run=${runId}; ${scopeDescription}\n`);

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

  let selectedProjects: readonly PaperclipProjectRecord[];
  try {
    const selection = await resolveHeartbeatProjectSelection({
      projects,
      reference: scopeReference,
      approvals: scopeReference.kind === "approval"
        ? asArray<ApprovalScopeRecord>(await pc.listApprovals(companyId))
        : [],
      getIssue: async (issueId) => {
        const issue = await pc.getIssue<Record<string, unknown>>(issueId);
        return {
          id: String(issue["id"] ?? issueId),
          projectId: typeof issue["projectId"] === "string" ? issue["projectId"] : null,
        };
      },
    });
    switch (selection.kind) {
      case "all_projects":
        selectedProjects = selection.projects;
        break;
      case "scoped":
        selectedProjects = [selection.project];
        break;
      case "invalid": {
        const message = `Could not resolve scoped heartbeat project (${selection.reason})`;
        await context.onLog?.("stderr", `[ORCHESTRATOR] 🚨 ${message}\n`);
        return { exitCode: 1, signal: null, timedOut: false, errorMessage: message, summary: message };
      }
    }
  } catch (err: unknown) {
    const message = `Could not resolve scoped heartbeat project: ${err instanceof Error ? err.message : String(err)}`;
    await context.onLog?.("stderr", `[ORCHESTRATOR] 🚨 ${message}\n`);
    return { exitCode: 1, signal: null, timedOut: false, errorMessage: message, summary: message };
  }

  const runnableProjects = selectedProjects.filter((project) => {
    const resolution = resolveProjectWorkspace({ projectId: project.id, projects });
    // Paperclip records a managed git path before an issue-scoped execution
    // materializes it. The project runner validates that metadata first, then
    // materializes only the exact host-owned path through the documented
    // compatibility bridge below; filtering on host filesystem existence here
    // would incorrectly drop a valid remote project before that step.
    return resolution.ok;
  });
  const skippedProjects = selectedProjects.length - runnableProjects.length;
  if (runnableProjects.length === 0) {
    const message = `No selected project has a usable local workspace; skipped ${selectedProjects.length} project(s)`;
    await context.onLog?.("stderr", `[ORCHESTRATOR] 🚨 ${message}\n`);
    return { exitCode: 1, signal: null, timedOut: false, errorMessage: message, summary: message };
  }

  const rawConfig = (context.config as Record<string, unknown> | undefined) || {};
  const { maxNewJulesSessionsPerHeartbeat: _ignoredProviderSessionBudget, ...projectConfig } = rawConfig;
  const projectCapacity = allocateProjectCapacity({
    projectIds: runnableProjects.map((project) => project.id),
    maxConcurrentJules: typeof rawConfig["maxConcurrentJules"] === "number" ? rawConfig["maxConcurrentJules"] : 15,
    maxConcurrentVibe: typeof rawConfig["maxConcurrentVibe"] === "number" ? rawConfig["maxConcurrentVibe"] : 1,
  });
  // Fleet configuration is company-scoped, while project execution is
  // concurrent. Claim reconciliation synchronously before the first project
  // callback awaits anything; array position must not decide whether managed
  // reviewers receive a config update.
  let fleetReconciliationClaimed = false;
  const projectRuns = await runProjectWorkerPool(
    runnableProjects,
    typeof rawConfig["maxConcurrentProjects"] === "number" ? rawConfig["maxConcurrentProjects"] : 2,
    async (project) => {
    const capacity = projectCapacity.find((item) => item.projectId === project.id);
    const reconcileFleet = rawConfig["reconcileFleet"] !== false && !fleetReconciliationClaimed;
    if (reconcileFleet) fleetReconciliationClaimed = true;
    return runProject({
      ...context,
      config: {
        ...projectConfig,
        ...(capacity ? { maxConcurrentJules: capacity.jules, maxConcurrentVibe: capacity.vibe } : {}),
        // Respect an explicit test/manual opt-out. Without this guard an
        // isolated canary still attempts fleet provisioning and emits noisy
        // agents:create denials even though it only needs existing workers.
        reconcileFleet,
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
  if (config.reconciliationMode === "freeze") {
    const summary = "Lifecycle reconciliation frozen; no control-plane I/O was attempted.";
    await context.onLog?.("stdout", `[ORCHESTRATOR] ${summary}\n`).catch(() => {});
    return { exitCode: 0, signal: null, timedOut: false, summary };
  }
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
  let explicitProjectId = typeof rawContext["projectId"] === "string" ? String(rawContext["projectId"]).trim() : "";
  // Paperclip currently preserves issue scope in a heartbeat context but may
  // omit the derived project scope. Resolve it from the authoritative issue
  // record before workspace selection; never infer it from cwd or git remote.
  if (!explicitProjectId && typeof rawContext["issueId"] === "string" && rawContext["issueId"].trim()) {
    try {
      const scopedIssue = await pc.getIssue<Record<string, unknown>>(rawContext["issueId"].trim());
      explicitProjectId = typeof scopedIssue["projectId"] === "string" ? scopedIssue["projectId"].trim() : "";
    } catch (error: unknown) {
      console.error(`[ORCHESTRATOR] Could not resolve project from bound issue: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
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
      const metadata = resolveProjectMetadata(project);
      if (metadata.ok) {
        const instanceRoot = resolvePaperclipInstanceRootForAdapter({
          homeDir: process.env["PAPERCLIP_HOME"]?.trim() || path.join(os.homedir(), ".paperclip"),
          instanceId: process.env["PAPERCLIP_INSTANCE_ID"]?.trim() || "default",
          env: process.env,
        });
        const managedWorkspacePath = managedProjectCheckoutPath({
          instanceRoot,
          companyId,
          projectId: explicitProjectId,
          repoUrl: metadata.repoUrl,
        });
        if (path.resolve(workspacePath) === managedWorkspacePath) {
          const preparation = await ensureManagedProjectCheckout({
            instanceRoot,
            companyId,
            projectId: explicitProjectId,
            workspacePath,
            repoUrl: metadata.repoUrl,
            defaultRef: metadata.defaultRef,
          });
          if (preparation.status === "materialized") {
            await log(`[ORCHESTRATOR] Materialized Paperclip-managed checkout for project ${explicitProjectId}.`);
          }
        }
      }
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
    options?: { resumeFromRunId?: string | undefined; recoverStaleExecution?: boolean | undefined; reviewInteractionId?: string | undefined; forceFreshSession?: boolean | undefined; recoveryRunId?: string | undefined; idempotencyKey?: string | undefined },
  ) => {
    if (!agentId || !managedIds.has(agentId)) return;
    const circuitKey = `managed-wakeup:${agentId}`;
    if (capabilityCircuit.isOpen(circuitKey)) return;
    if (!runId) {
      await log(`[ORCHESTRATOR] Skipped managed-worker wakeup: run attribution is missing.`);
      return;
    }
    const reviewerKey: NativeReviewWorkerKey | null = agentId === lunaReviewerAgentId
      ? "luna_reviewer"
      : agentId === terraReviewerAgentId
        ? "terra_reviewer"
        : agentId === terraAdjudicatorAgentId
          ? "terra_adjudicator"
          : null;
    if (reviewerKey) {
      try {
        const instanceRoot = resolvePaperclipInstanceRootForAdapter({
          homeDir: process.env["PAPERCLIP_HOME"]?.trim() || path.join(os.homedir(), ".paperclip"),
          instanceId: process.env["PAPERCLIP_INSTANCE_ID"]?.trim() || "default",
          env: process.env,
        });
        await provisionNativeReviewMcpHome({
          home: resolveNativeReviewMcpHome({ instanceRoot, companyId, workerKey: reviewerKey }),
          authSource: path.join(process.env["CODEX_HOME"]?.trim() || path.join(os.homedir(), ".codex"), "auth.json"),
          nodePath: process.execPath,
          serverPath: fileURLToPath(new URL("./native-review-mcp-stdio.js", import.meta.url)),
          runtimeContext: {
            apiBase: apiUrl,
            companyId,
            agentId,
            ...(issueId ? { issueId } : {}),
            ...(options?.reviewInteractionId ? { interactionId: options.reviewInteractionId } : {}),
          },
        });
      } catch (error) {
        await log(`[ORCHESTRATOR] Native review transport is unavailable for ${reviewerKey}: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    const idempotencyKey = options?.idempotencyKey ?? (options?.recoveryRunId && options.reviewInteractionId && issueId
      ? nativeReviewRecoveryWakeKey(agentId, issueId, options.reviewInteractionId, options.recoveryRunId)
      : `orchestrator:wakeup:${agentId}:${issueId || "company"}:${options?.reviewInteractionId || options?.resumeFromRunId || "current"}`);
    // A recovery decision is made from the scheduler's earlier snapshot. Do
    // not let that stale snapshot turn into a compatibility wake after
    // Paperclip has already started, or completed, the addressed native
    // reviewer. This is deliberately a final read immediately before the
    // write; failure is fail-closed because an unnecessary wake spends model
    // quota and can create a second reviewer run for the same card.
    const canWakeNativeReviewCard = async (): Promise<boolean> => {
      if (!options?.reviewInteractionId || !issueId) return true;
      try {
        const decision = await revalidateNativeReviewWake({
          paperclip: pc,
          companyId,
          agentId,
          issueId,
          interactionId: options.reviewInteractionId,
          nowMs: Date.now(),
          graceMs: JULES_PLAN_NATIVE_REVIEW_RECOVERY_GRACE_MS,
        });
        switch (decision.action) {
          case "compatibility_wake":
            return true;
          case "answered":
            await log(`[ORCHESTRATOR] Suppressed native-review compatibility wake for ${issueId}; card ${options.reviewInteractionId} is already answered.`);
            return false;
          case "await_run":
            await log(`[ORCHESTRATOR] Suppressed native-review compatibility wake for ${issueId}; card ${options.reviewInteractionId} already has live reviewer run ${decision.runId}.`);
            return false;
          case "await_native_dispatch":
            await log(`[ORCHESTRATOR] Deferred native-review compatibility wake for ${issueId}; card ${options.reviewInteractionId} remains inside Paperclip's native dispatch grace period.`);
            return false;
          case "retry_exhausted":
            await log(`[ORCHESTRATOR] Suppressed native-review compatibility wake for ${issueId}; card ${options.reviewInteractionId} has exhausted its bounded recovery attempts.`);
            return false;
          case "no_action":
            await log(`[ORCHESTRATOR] Suppressed native-review compatibility wake for ${issueId}; addressed card ${options.reviewInteractionId} is no longer pending.`);
            return false;
          default: {
            const exhaustive: never = decision;
            return exhaustive;
          }
        }
      } catch (error) {
        await log(`[ORCHESTRATOR] Suppressed native-review compatibility wake for ${issueId}; final card/run revalidation failed: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    };
    const wakeNativeReviewCard = async () => {
      let wakeCommentId: string | undefined;
      try {
        const comments = asArray<{ id?: unknown; body?: unknown }>(await pc.listComments(issueId!));
        wakeCommentId = selectNativeReviewWakeAnchor(comments);
      } catch (error) {
        // The v831 compatibility path needs an existing durable comment. A
        // comment-read outage must not invent a free-text anchor; retain the
        // native dispatch fallback for newer hosts that preserve the card.
        await log(`[ORCHESTRATOR] Native review wake anchor unavailable for ${issueId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return prepareAndWakeNativeReview({
        paperclip: pc,
        agentId,
        issueId: issueId!,
        interactionId: options!.reviewInteractionId!,
        reason,
        idempotencyKey,
        ...(wakeCommentId ? { wakeCommentId } : {}),
      });
    };
    if (options?.reviewInteractionId && issueId && !(await canWakeNativeReviewCard())) return false;
    const result = await executePaperclipCommand(
      {
        key: idempotencyKey,
        issueId: issueId || "company",
        action: "wakeup",
        payload: { agentId, reason, ...options },
      },
      () => options?.reviewInteractionId && issueId
        ? wakeNativeReviewCard()
        : pc.wakeup(agentId, reason, issueId, { ...options, idempotencyKey }),
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
          if (options.reviewInteractionId && issueId) {
            if (await canWakeNativeReviewCard()) await wakeNativeReviewCard();
          } else {
            await pc.wakeup(agentId, reason, issueId, { resumeFromRunId: options?.resumeFromRunId });
          }
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
    return normalizedResult.ok;
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
  let managedAgents: FleetAgentRecord[] = [];

  let managedJulesIds = new Set<string>();
  let managedJulesCiPolicy: unknown = undefined;
  let managedWorkerStates: ContinuationWorker[] = [];
  let managedAgentStatuses = new Map<string, string>();
  let agentStructuredDecisionCapabilities = new Map<string, unknown>();
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
        runId,
        julesPlanApprovalPolicy: config.julesPlanApprovalPolicy,
        lunaReviewerAgentId,
        terraReviewerAgentId,
        terraAdjudicatorAgentId,
        vibeReviewerAgentId,
        reviewerAgentId,
        skipWorkerKeys: MANAGED_FLEET_DEFINITIONS
          .map((definition) => definition.key)
          .filter((workerKey) =>
            capabilityCircuit.isOpen(fleetCapabilityCircuitKey(companyId, "configure", workerKey)) ||
            capabilityCircuit.isOpen(fleetCapabilityCircuitKey(companyId, "create", workerKey)),
          ),
      });
      fleetAuthorizationFailures = fleetResult.authorizationFailures;
      for (const denial of fleetAuthorizationFailures) {
        const operation = denial.capability === "agents:create" ? "create" : "configure";
        const key = fleetCapabilityCircuitKey(companyId, operation, denial.workerKey);
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
    managedAgents = agents;
    managedAgentStatuses = new Map(agents.map((agent) => [agent.id, agent.status]));
    agentStructuredDecisionCapabilities = new Map(
      agents.map((agent) => [agent.id, agent.metadata?.["structuredDecisionCapability"]]),
    );
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
    managedJulesCiPolicy = managedJules?.adapterConfig?.["ciPolicy"];
    julesNeedsReattach = Boolean(
      managedJules &&
        (managedJules.status === "error" || (managedJules.errorReason || "").includes("Process lost"))
    );

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

  // 2. Two-Way Markdown Ingestion (project comes from workspace folder / git remote)
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

  // 3. Workspace consistency verification
  let isSyncHealthy = false;
  let syncDispositionStatus = "unhealthy";
  let syncDispositionObservation: { type: string; [key: string]: unknown } = { type: "missing_repo_url" };
  if (workspaceProject) {
    let metadataResolution = resolveProjectMetadata(workspaceProject);

    // Implicit Migration: if repoUrl points to the orchestrator repository but defaultRef is missing, auto-migrate to "master".
    if (
      !metadataResolution.ok &&
      metadataResolution.reason === "missing_default_ref" &&
      metadataResolution.repoUrl &&
      metadataResolution.sourceBlock &&
      normalizeGitHubOwnerRepo(metadataResolution.repoUrl) === "pilleo/paperclip-adapters"
    ) {
      const sourceBlockName = metadataResolution.sourceBlock;
      const patchedBlock = {
        ...(workspaceProject[sourceBlockName] as Record<string, unknown>),
        defaultRef: "master",
      };

      try {
        const patchRes = await pc.patchProject(workspaceProject.id, { [sourceBlockName]: patchedBlock });
        if (patchRes.ok) {
          await log(`[ORCHESTRATOR] Migrated orchestrator project metadata to defaultRef: "master" in block ${sourceBlockName}`);
          metadataResolution = { ok: true, repoUrl: metadataResolution.repoUrl, defaultRef: "master", sourceBlock: sourceBlockName };
        } else {
          await log(`[ORCHESTRATOR] Warning: Failed to migrate orchestrator project defaultRef (${patchRes.status}): ${patchRes.text}`);
        }
      } catch (err: unknown) {
        await log(`[ORCHESTRATOR] Warning: Exception while migrating orchestrator project defaultRef: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const wsConsistency = await checkWorkspaceConsistency(
      workspacePath,
      metadataResolution.ok ? metadataResolution.repoUrl : undefined,
      metadataResolution.ok ? metadataResolution.defaultRef : undefined
    );

    if (!metadataResolution.ok) {
      await log(
        `[ORCHESTRATOR] Project metadata rejected for ${workspaceProject.id}: ${metadataResolution.reason}; ` +
        `primaryRepo=${String(workspaceProject.primaryWorkspace?.repoUrl ?? "")}; ` +
        `codebaseRepo=${String(workspaceProject.codebase?.repoUrl ?? "")}`,
      );
    }

    isSyncHealthy = wsConsistency.status === "healthy";
    syncDispositionStatus = wsConsistency.status;
    syncDispositionObservation = wsConsistency.observation;
  } else {
    // If we have no workspaceProject, fallback logic
    const wsConsistency = await checkWorkspaceConsistency(workspacePath);
    isSyncHealthy = wsConsistency.status === "healthy";
    syncDispositionStatus = wsConsistency.status;
    syncDispositionObservation = wsConsistency.observation;
  }

  if (workspaceProject) {
    const currentFingerprint = JSON.stringify({ status: syncDispositionStatus, observation: syncDispositionObservation });
    if (lastSyncDisposition.get(workspaceProject.id) !== currentFingerprint) {
      lastSyncDisposition.set(workspaceProject.id, currentFingerprint);
      if (!isSyncHealthy) {
        await log(`[ORCHESTRATOR] 🚨 Sync Disposition changed to unhealthy: ${syncDispositionObservation.type}. Synchronization guard deliberately fails closed while preserving existing autonomous lifecycles.`);
      } else {
        await log(`[ORCHESTRATOR] ✅ Sync Disposition recovered to healthy: ${syncDispositionObservation.type}`);
      }
    }
  }

  let syncSummary = { createdCount: 0, syncedHeadersCount: 0, conflicts: [] as readonly { logicalId: string; reason: string; candidateIssueIds: readonly string[]; filePath: string }[] };
  if (isSyncHealthy) {
    syncSummary = await syncBacklogMarkdownToPaperclip({
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
  } else {
    await log(`[ORCHESTRATOR] ⚠️ Skipping Backlog Sync: workspace sync disposition is unhealthy (${syncDispositionObservation.type}).`);
  }

  // 4. Verify remote GitHub state
  const configuredRepository = typeof (config as Record<string, unknown>)["repository"] === "string"
    ? String((config as Record<string, unknown>)["repository"]).trim()
    : undefined;
  const projectRepository = workspaceProject
    ? normalizeGitHubOwnerRepo(workspaceProject.primaryWorkspace?.repoUrl) ||
      normalizeGitHubOwnerRepo(workspaceProject.codebase?.repoUrl) ||
      undefined
    : undefined;
  const ghRepository = configuredRepository || normalizeGitHubOwnerRepo(gitRemoteUrl) || projectRepository;
  const ghStatus = await fetchGitHubPullRequests(workspacePath, 50, ghRepository);
  if (ghStatus.openPrs.length > 0 || ghStatus.mergedPrs.length > 0) {
    await log(
      `[ORCHESTRATOR] 🌐 Remote Verification: open_prs=${ghStatus.openPrs.length}, merged_prs=${ghStatus.mergedPrs.length}, active_pr_files_locked=${ghStatus.openPrFiles.size}`
    );
  }

  if (ghStatus.error) {
    await log(`[ORCHESTRATOR] 🚨 GITHUB ACCESS UNAVAILABLE: ${ghStatus.error}. Remote PR reconciliation is degraded; reviews and merges remain safety-paused until GitHub access recovers.`);
  }

  // 6. Fetch all company issues
  let issuesList: Record<string, unknown>[] = [];
  try {
    issuesList = asArray<Record<string, unknown>>(await pc.listIssues(companyId, {
      ...(workspaceProject?.id ? { projectId: workspaceProject.id } : {}),
      includeBlockedBy: true,
    }));
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

  const activeAssignments = new Map<string, number>();
  for (const issue of parsedIssues) {
    if (!issue.assigneeAgentId || !["in_progress", "in_review"].includes(issue.status)) continue;
    activeAssignments.set(issue.assigneeAgentId, (activeAssignments.get(issue.assigneeAgentId) || 0) + 1);
  }
  const laneAssignments = { julesAgentId, vibeAgentId, lunaReviewerAgentId, terraReviewerAgentId };
  agentHealthReport = evaluateAgentHealth(managedAgents.map((agent) => ({
    ...agent,
    lane: managedWorkerLane(agent.id, laneAssignments),
    activeAssignmentCount: activeAssignments.get(agent.id) || 0,
  })));
  const newIncidents = agentIncidentDeduper.reconcile(agentHealthReport.incidents);
  for (const incident of newIncidents) {
    const label = incident.impact === "lane_degraded" ? "DEGRADED" : incident.severity;
    await log(`[ORCHESTRATOR] [Agent Incident] [${label}] ${incident.agentName} (${incident.status}): ${incident.issue}`);
  }

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

  let existingApprovals: PaperclipApprovalSummary[] = [];
  let approvalsSnapshotLoaded = false;
  const loadApprovals = async (): Promise<void> => {
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
    approvalsSnapshotLoaded = true;
  };
  try {
    await loadApprovals();
  } catch (err: unknown) {
    // A missing approval snapshot must not prevent GitHub's terminal merge
    // state from completing the issue. The start-approval phase below still
    // fails closed if it cannot load its required snapshot.
    await log(`[ORCHESTRATOR] Warning: Failed to prefetch approvals for merged-PR cleanup: ${err instanceof Error ? err.message : String(err)}`);
  }

  const pendingMergeApprovalFor = (issue: ParsedIssueMetadata, prUrl: string): PaperclipApprovalSummary | undefined => {
    const normalizedPrUrl = prUrl.replace(/\/$/, "").toLowerCase();
    return existingApprovals.find((approval) => {
      if (approval.status !== "pending") return false;
      const isMergeGate = approval.type === "task_merge_approval" ||
        (approval.type === "request_board_approval" && approval.payload?.["action"] === "task_merge");
      const approvalPrUrl = approval.payload?.["prUrl"];
      return isMergeGate &&
        (approval.issueIds.includes(issue.id) || approval.payload?.["issueId"] === issue.id) &&
        typeof approvalPrUrl === "string" && approvalPrUrl.replace(/\/$/, "").toLowerCase() === normalizedPrUrl;
    });
  };

  // `gh pr list --limit 50` is intentionally bounded. A pending final merge
  // approval is the only historical state that can keep a completed task
  // visibly stale, so hydrate only its board-registered PR when it falls
  // outside that discovery window.
  const mergedPrs = [...ghStatus.mergedPrs];
  if (approvalsSnapshotLoaded) {
    for (const issue of parsedIssues) {
      const registeredPr = registeredPullRequestFromIssue(issue);
      if (!registeredPr || mergedPrs.some((pr) => pr.url.replace(/\/$/, "").toLowerCase() === registeredPr.url.replace(/\/$/, "").toLowerCase())) continue;
      if (!pendingMergeApprovalFor(issue, registeredPr.url)) continue;
      const observedPr = await fetchGitHubPullRequest(workspacePath, registeredPr.url);
      if (observedPr?.state === "MERGED") mergedPrs.push(observedPr);
    }
  }

  // 7. PHASE 1: Reconcile board status with merged GitHub PRs & Archive files
  const statusOverrides = new Map<string, IssueState>();
  const mergedIssueIds = new Set<string>();
  let mergedAutoCompleted = 0;
  if (!ghStatus.error || mergedPrs.length > 0) {
    for (const issue of parsedIssues) {
      const mergedPr = mergedPrs.find((pr) => matchPrToIssue(pr, issue));
      if (!mergedPr) continue;

      mergedIssueIds.add(issue.id);
      const pendingMergeApproval = pendingMergeApprovalFor(issue, mergedPr.url);
      if (pendingMergeApproval) {
        const invalidationKey = `merged-approval-invalidation:${pendingMergeApproval.id}`;
        try {
          await mergeApprovalInvalidationGuard.runOnce(invalidationKey, async () => {
            const rejection = await pc.rejectApproval(
              pendingMergeApproval.id,
              `Superseded automatically: GitHub confirmed PR #${mergedPr.number} is merged. This is not a rejection of the implementation.`,
            );
            if (!rejection.ok) {
              throw new Error(`Paperclip rejected stale merge-approval invalidation (${rejection.status}): ${rejection.text}`);
            }
            await log(`[ORCHESTRATOR] [Stage 4 Operator Approval] invalidated stale final merge approval ${pendingMergeApproval.id} after GitHub merged PR #${mergedPr.number}.`);
          });
        } catch (err: unknown) {
          await log(`[ORCHESTRATOR] Warning: Failed to invalidate stale final merge approval ${pendingMergeApproval.id} for merged PR ${mergedPr.url}: ${err instanceof Error ? err.message : String(err)}. The task will remain terminal and cleanup will retry.`);
        }
      }
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
          ...(pendingMergeApproval ? { mergeApproval: { id: pendingMergeApproval.id, status: pendingMergeApproval.status } } : {}),
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
      let currentHeadReviewComplete = false;
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
          currentHeadReviewComplete = hasCompletedNativeApprovalLadderForHead(rawInteractions.map((interaction) => ({
            id: String(interaction["id"] ?? ""), kind: typeof interaction["kind"] === "string" ? interaction["kind"] : undefined,
            status: typeof interaction["status"] === "string" ? interaction["status"] : undefined,
            idempotencyKey: typeof interaction["idempotencyKey"] === "string" ? interaction["idempotencyKey"] : undefined,
            result: interaction["result"],
          })), issue.id, matchingPr.headRefOid);
        }
      } catch (err: unknown) {
        await log(`[ORCHESTRATOR] Deferring open Jules PR recovery for [${issue.identifier || issue.id}]: could not verify monitor/review state (${String(err)}).`);
        continue;
      }
      if (currentHeadReviewComplete) continue;
      if (!canPromoteJulesPrToReview({ ciGreen: true, currentHeadRejected, executionPolicy: authoritativeExecutionPolicy })) {
        await log(`[ORCHESTRATOR] Keeping [${issue.identifier || issue.id}] with Jules: current PR head is rejected or its provider monitor is resumable.`);
        continue;
      }
      const ci = resolvePrCiGate(
        managedJulesCiPolicy,
        await checkPrCiIsGreen(matchingPr.number, workspacePath, matchingPr.url),
      );
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
        // Paperclip can still consider a host execution policy active when it
        // reprojects this issue as `in_progress`. Clear that host-owned state
        // atomically with the native review projection; a partial status patch
        // is rejected with 422 and leaves an avoidable recovery warning.
        const recovered = await pc.patchIssue(issue.id, nativePrReviewCleanupPatch());
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
    let sessionHandleBody: unknown;
    if (serviceName === "jules") {
      try {
        const documents = asArray<Record<string, unknown>>(await pc.getJson<unknown>(`/api/issues/${encodeURIComponent(issue.id)}/documents`));
        sessionHandleBody = documents.find((document) => document["key"] === "jules-session")?.["body"];
      } catch (error: unknown) {
        await log(`[ORCHESTRATOR] Deferring Jules monitor recovery for [${issue.identifier || issue.id}]: could not read its durable session handle (${String(error)}).`);
      }
    }
    const providerSessionId = resolveJulesMonitorSessionId({ monitorExternalRef: externalRef, sessionHandleBody });
    const executionBlocker = issue.rawIssue["executionBlocker"];
    // Paperclip's execution blocker is a stronger no-replay boundary than a
    // detached provider monitor. Never overwrite it with an `in_progress`
    // monitor patch. A narrow compatibility bridge can instead submit the
    // server's typed reconciliation evidence for a terminal Jules polling
    // turn, after which normal todo dispatch lets Jules inspect and resume its
    // durable provider session. Upstream Paperclip should eventually expose
    // this as an adapter-owned terminal disposition rather than requiring a
    // local-trusted board reconciliation.
    if (issue.status === "blocked" && executionBlocker != null) {
      const blockerPointer = parseJulesExecutionBlockerPointer({
        issueStatus: issue.status,
        assigneeAgentId: issue.assigneeAgentId,
        julesAgentId,
        providerSessionId,
        executionBlocker,
      });
      if (!blockerPointer) {
        await log(`[ORCHESTRATOR] Preserving Paperclip execution hold for [${issue.identifier || issue.id}]; it is not a typed Jules polling continuation.`);
        continue;
      }
      try {
        const failedRun = await pc.getHeartbeatRun<Record<string, unknown>>(blockerPointer.runId);
        const blockerDecision = decideJulesExecutionBlockerRecovery({
          issueStatus: issue.status,
          assigneeAgentId: issue.assigneeAgentId,
          julesAgentId,
          providerSessionId,
          executionBlocker,
          failedRun,
        });
        switch (blockerDecision.action) {
          case "preserve":
            await log(`[ORCHESTRATOR] Preserving Paperclip execution hold for [${issue.identifier || issue.id}]: ${blockerDecision.reason}.`);
            break;
          case "resolve_to_todo": {
            const resolved = await pc.resolveRecoveryAction(
              issue.id,
              buildJulesExecutionReconciliationPayload(blockerDecision),
            );
            if (!resolved.ok) {
              await log(`[ORCHESTRATOR] Could not reconcile terminal Jules polling hold for [${issue.identifier || issue.id}] (${resolved.status}): ${resolved.text}`);
              break;
            }
            statusOverrides.set(issue.id, "todo");
            await log(`[ORCHESTRATOR] Reconciled terminal Jules polling hold for [${issue.identifier || issue.id}] to todo; the persisted provider session remains authoritative.`);
            break;
          }
        }
      } catch (error: unknown) {
        await log(`[ORCHESTRATOR] Deferring Jules execution-hold reconciliation for [${issue.identifier || issue.id}]: ${String(error)}.`);
      }
      continue;
    }
    let planVerdictContinuation: ReturnType<typeof resolvedJulesPlanVerdict> = null;
    let planVerdictChild: typeof lifecycleIssues[number] | null = null;
    if (monitorClearReason === "manual" && providerSessionId &&
        (issue.status === "backlog" || issue.status === "blocked") && issue.assigneeAgentId === julesAgentId) {
      for (const child of lifecycleIssues.filter((candidate) =>
        candidate.parentId === issue.id && isDelegatedReviewChild(candidate) && candidate.status !== "cancelled")) {
        try {
          planVerdictContinuation = resolvedJulesPlanVerdict({
            parentId: issue.id,
            parentSessionId: providerSessionId,
            interactions: asArray<Record<string, unknown>>(await pc.listInteractions(child.id)),
          });
          if (planVerdictContinuation) {
            planVerdictChild = child;
            break;
          }
        } catch (error: unknown) {
          await log(`[ORCHESTRATOR] Deferring resolved native plan verdict recovery for [${issue.identifier || issue.id}]: could not read child interaction (${String(error)}).`);
        }
      }
    }
    const executionPolicy = executionPolicyRecord;
    // Compatibility bridge: Paperclip can drop either the whole
    // executionPolicy or only executionPolicy.monitor while its durable
    // projection still says that Jules owns an active monitor. The latter is
    // the v2026.916.0 shape: native review stages survive, but the provider
    // continuation does not. Reattach the monitor while preserving every
    // other policy field; never infer ownership from provider prose or a PR.
    const policyHasMonitor = Boolean(
      policyMonitor && typeof policyMonitor === "object" && !Array.isArray(policyMonitor),
    );
    const monitorDetached = !policyHasMonitor &&
      serviceName === "jules" &&
      providerSessionId !== null &&
      (monitorStatus === "triggered" || monitorStatus === null ||
        (monitorStatus === "cleared" && monitorClearReason === "invalid_status") ||
        (monitorStatus === "cleared" && monitorClearReason === "manual" && planVerdictContinuation !== null));
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
      hasProviderSession: providerSessionId !== null,
      monitorCanBeReattached: canReattachNativeMonitor,
      monitorDetached,
      resolvedNativePlanVerdict: planVerdictContinuation !== null,
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
    if (!julesAgentId) continue;
    if (planVerdictContinuation && planVerdictChild && planVerdictChild.status !== "done") {
      const childCompletionKey = `jules:plan-verdict-child-complete:${issue.id}:${planVerdictContinuation.interactionId}`;
      const childCompleted = await lifecycleConvergenceGuard.runOnce(childCompletionKey, async () => {
        const completed = await pc.patchIssue(planVerdictChild!.id, { status: "done", blockParentUntilDone: false });
        return completed.ok;
      });
      if (!childCompleted) {
        lifecycleConvergenceGuard.clear(childCompletionKey);
        continue;
      }
    }
    const key = planVerdictContinuation
      ? `jules-monitor-resume:${issue.id}:${planVerdictContinuation.interactionId}`
      : `jules-monitor-resume:${issue.id}:${timeoutAt}`;
    // Paperclip's invalid-assignee cleanup can leave the legacy projection
    // (`executionState.monitor`) cleared while dropping `executionPolicy`.
    // That is a recoverable state, but it can persist across several ticks if
    // a concurrent heartbeat wins the write or the first PATCH fails. A
    // lifetime guard entry must not turn that state into a permanent stall:
    // allow the next heartbeat to retry until the native policy is observable.
    if (monitorStatus === "cleared" && monitorClearReason === "invalid_assignee" && !canReattachNativeMonitor) {
      lifecycleConvergenceGuard.clear(key);
    }
    const resumedThisTick = await lifecycleConvergenceGuard.runOnce(key, async () => {
      const invalidAssigneeRepair = (issue.status === "in_progress" || issue.status === "blocked" || issue.status === "todo") &&
        monitorStatus === "cleared" && monitorClearReason === "invalid_assignee" &&
        issue.assigneeAgentId === julesAgentId;
      if ((!executionPolicy && !invalidAssigneeRepair && !monitorDetached) || (!canReattachNativeMonitor && !invalidAssigneeRepair && !monitorDetached) || !providerSessionId) {
        await log(`[ORCHESTRATOR] Refusing Jules monitor reattachment for [${issue.identifier || issue.id}]: native monitor payload is incomplete.`);
        return false;
      }
      const reattachedPolicy = buildJulesMonitorReattachment(executionPolicy ?? { mode: "normal", stages: [] }, providerSessionId, Date.now());
      const resumed = await pc.patchIssue(issue.id, { status: "in_progress", assigneeAgentId: julesAgentId, executionPolicy: reattachedPolicy });
      if (!resumed.ok) {
        await log(`[ORCHESTRATOR] Could not resume expired Jules monitor for [${issue.identifier || issue.id}] (${resumed.status}): ${resumed.text}`);
        return false;
      }
      statusOverrides.set(issue.id, "in_progress");
      reattachedJulesMonitorIssueIds.add(issue.id);
      await log(`[ORCHESTRATOR] Resumed expired Jules monitor for [${issue.identifier || issue.id}].`);
      if (planVerdictContinuation && !wokeThisTick.has(`${julesAgentId}:${issue.id}`)) {
        await managedWakeup(julesAgentId, "synchronize_provider_plan_ready", issue.id, {
          idempotencyKey: `jules:plan-verdict-continuation:${issue.id}:${planVerdictContinuation.interactionId}`,
        });
        wokeThisTick.add(`${julesAgentId}:${issue.id}`);
      }
      return true;
    });
    if (!resumedThisTick) lifecycleConvergenceGuard.clear(key);
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
      ciRemediationInProgress: false,
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
      const patch = await pc.patchIssue(command.issueId, {
        status: targetStatus,
        ...(isReviewRecovery ? { assigneeAgentId: null } : {}),
      });
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
      if (isReviewRecovery) boardReviewRecoveryIds.add(command.issueId);
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
    // Provider-monitor recovery above is the sole owner of a Jules
    // continuation. Never replace its atomic status/assignee/policy repair
    // with a bare generic status change: Paperclip will immediately block
    // such an issue again because it still has no executable continuation.
    if (hasJulesMonitorClaim({
      executionPolicy: issue.rawIssue["executionPolicy"],
      executionState: issue.rawIssue["executionState"],
    })) continue;
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
      const policyIssue = { ...issue, hasReadyPullRequest: hasUnreviewedReadyPullRequest(issue) };
      if (!issueNeedsExecutionPolicyBackfill(policyIssue, managedIds) &&
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

  // A rejection can race with the host transition that returns the issue to
  // Jules. In that window the issue is no longer part of `inReviewIssues`, so
  // cleanup performed only in the review branch would never see a stale
  // Terra/strong card. For a Jules-owned implementation issue, every pending
  // PR-review interaction is orphaned and must be withdrawn before the next
  // worker heartbeat. This is deliberately limited to orchestrated issues
  // assigned to the managed worker and uses the pure selector to avoid
  // touching questions or unrelated interactions.
  for (const issue of inProgressIssues.filter((candidate) =>
    candidate.orchestratorManaged && candidate.assigneeAgentId === julesAgentId,
  )) {
    try {
      const interactions = asArray<Record<string, unknown>>(await pc.listInteractions(issue.id));
      const staleCardIds = selectReviewCardsToWithdrawAfterRejection(
        interactions.map((interaction) => ({
          id: String(interaction["id"] || ""),
          kind: typeof interaction["kind"] === "string" ? interaction["kind"] : undefined,
          status: typeof interaction["status"] === "string" ? interaction["status"] : undefined,
          idempotencyKey: typeof interaction["idempotencyKey"] === "string" ? interaction["idempotencyKey"] : undefined,
        })),
        issue.id,
      );
      if (staleCardIds.length === 0) continue;
      await reviewRejectionConvergenceGuard.runOnce(
        `orphaned-review-cleanup:${issue.id}`,
        async () => {
          for (const interactionId of staleCardIds) {
            const withdrawn = await pc.withdrawInteraction(
              issue.id,
              interactionId,
              "Orphaned PR-review card: issue is back in worker in_progress after review rejection.",
            );
            if (!withdrawn.ok && withdrawn.status !== 404 && withdrawn.status !== 409) {
              await log(`[ORCHESTRATOR] Warning: orphaned review card cleanup failed (${withdrawn.status}): ${withdrawn.text}`);
            }
          }
          return true;
        },
      );
    } catch (err: unknown) {
      await log(`[ORCHESTRATOR] Warning: failed to contain orphaned review cards for ${issue.identifier || issue.id}: ${String(err)}`);
    }
  }
  // Jules plan review cards have no PR/head identity, so they cannot enter the
  // PR recovery loop below. Recover only one overdue, typed Luna/Terra card
  // while retaining Jules as the issue owner; the plan gate is provider-owned.
  const nativeReviewRecoveryIds = new Set<string>();
  const planReviewRecoveryAgents = julesAgentId && lunaReviewerAgentId && terraReviewerAgentId
    ? { jules: julesAgentId, reviewers: { luna: lunaReviewerAgentId, terra: terraReviewerAgentId } }
    : null;
  if (planReviewRecoveryAgents) {
    for (const issue of overlayedIssues.filter((candidate) =>
      candidate.orchestratorManaged && candidate.assigneeAgentId === planReviewRecoveryAgents.jules && !mergedIssueIds.has(candidate.id),
    )) {
      let interactions: Array<{ id: string; kind?: string; status?: string; idempotencyKey?: string; addresseeAgentId?: string | null; createdAt?: string }>;
      try {
        interactions = asArray<Record<string, unknown>>(await pc.listInteractions(issue.id))
          .filter((interaction): interaction is Record<string, unknown> & { id: string } => typeof interaction["id"] === "string")
          .map((interaction) => ({
            id: interaction["id"],
            ...(typeof interaction["kind"] === "string" ? { kind: interaction["kind"] } : {}),
            ...(typeof interaction["status"] === "string" ? { status: interaction["status"] } : {}),
            ...(typeof interaction["idempotencyKey"] === "string" ? { idempotencyKey: interaction["idempotencyKey"] } : {}),
            ...(typeof interaction["addresseeAgentId"] === "string" ? { addresseeAgentId: interaction["addresseeAgentId"] } : {}),
            ...(typeof interaction["createdAt"] === "string" ? { createdAt: interaction["createdAt"] } : {}),
          }));
      } catch (error) {
        await log(`[ORCHESTRATOR] Warning: could not inspect Jules plan cards for ${issue.identifier || issue.id}: ${String(error)}`);
        continue;
      }

      const recovery = decideJulesPlanNativeReviewRecovery({
        issueId: issue.id,
        orchestratorManaged: issue.orchestratorManaged,
        issueAssigneeAgentId: issue.assigneeAgentId,
        julesAgentId: planReviewRecoveryAgents.jules,
        reviewerAgentIds: planReviewRecoveryAgents.reviewers,
        nowMs,
        graceMs: JULES_PLAN_NATIVE_REVIEW_RECOVERY_GRACE_MS,
        cards: interactions,
        reviewerRuns: heartbeatRuns,
      });
      switch (recovery.action) {
        case "no_action":
          continue;
        case "await_run":
          await log(`[ORCHESTRATOR] Preserving Jules plan card ${recovery.interactionId} for ${issue.identifier || issue.id}; reviewer run ${recovery.runId} is live.`);
          continue;
        case "retry_exhausted":
          await log(`[ORCHESTRATOR] Jules plan review recovery exhausted for ${issue.identifier || issue.id}, card ${recovery.interactionId}; leaving its typed card pending without another wake.`);
          continue;
        case "protocol_failure":
          await log(`[ORCHESTRATOR] Jules plan recovery refused for ${issue.identifier || issue.id}: ${recovery.reason}.`);
          continue;
        case "recover":
          break;
      }

      const recoveryKey = `native-review-plan-recovery:${issue.id}:${recovery.interactionId}:${recovery.recoveryRunId || "initial"}`;
      await nativeReviewRecoveryConvergenceGuard.runOnce(recoveryKey, async () => {
        const woke = await managedWakeup(
          recovery.reviewerAgentId,
          `Recover Jules plan review interaction ${recovery.interactionId}; submit only its structured verdict.`,
          issue.id,
          {
            recoverStaleExecution: true,
            reviewInteractionId: recovery.interactionId,
            forceFreshSession: true,
            ...(recovery.recoveryRunId ? { recoveryRunId: recovery.recoveryRunId } : {}),
            idempotencyKey: `native-review-plan-recovery:v1:${recovery.reviewerAgentId}:${issue.id}:${recovery.interactionId}:${recovery.recoveryRunId || "initial"}`,
          },
        );
        if (woke) {
          await log(`[ORCHESTRATOR] Recovered Jules plan review for ${issue.identifier || issue.id} using card ${recovery.interactionId}.`);
        }
        return true;
      });
    }
  }

  // Paperclip can interrupt a reviewer during hot reload and transiently
  // project its source issue as backlog or reassign it. Reconstruct only the
  // review lane proven by the immutable PR/head encoded in an addressed,
  // pending native card. This is deliberately before the older open-PR
  // fallback below: a generic ready PR cannot tell us which card is current.
  for (const issue of overlayedIssues.filter((candidate) =>
    candidate.orchestratorManaged && !mergedIssueIds.has(candidate.id),
  )) {
    const matchingPr = ghStatus.error
      ? registeredPullRequestFromIssue(issue)
      : ghStatus.openPrs.find((pr) => matchPrToIssue(pr, issue));
    if (!matchingPr) continue;
    const reviewHeadSha = matchingPr.headRefOid || await fetchPullRequestHeadSha(matchingPr.url);
    if (!reviewHeadSha) continue;

    let interactions: Array<{ id: string; kind?: string; status?: string; idempotencyKey?: string; addresseeAgentId?: string | null }>;
    try {
      interactions = asArray<Record<string, unknown>>(await pc.listInteractions(issue.id))
        .filter((interaction): interaction is Record<string, unknown> & { id: string } => typeof interaction["id"] === "string")
        .map((interaction) => ({
          id: interaction["id"],
          ...(typeof interaction["kind"] === "string" ? { kind: interaction["kind"] } : {}),
          ...(typeof interaction["status"] === "string" ? { status: interaction["status"] } : {}),
          ...(typeof interaction["idempotencyKey"] === "string" ? { idempotencyKey: interaction["idempotencyKey"] } : {}),
          ...(typeof interaction["addresseeAgentId"] === "string" ? { addresseeAgentId: interaction["addresseeAgentId"] } : {}),
        }));
    } catch (error) {
      await log(`[ORCHESTRATOR] Warning: could not inspect native review cards for ${issue.identifier || issue.id}: ${String(error)}`);
      continue;
    }

    const recovery = decideNativeReviewRecovery({
      issueId: issue.id,
      issueStatus: issue.status,
      issueAssigneeAgentId: issue.assigneeAgentId,
      orchestratorManaged: issue.orchestratorManaged,
      prIdentity: { url: matchingPr.url, headSha: reviewHeadSha },
      cards: interactions,
      reviewerRuns: heartbeatRuns,
    });
    switch (recovery.action) {
      case "no_action":
        continue;
      case "await_run":
        nativeReviewRecoveryIds.add(issue.id);
        await log(`[ORCHESTRATOR] Preserving native card ${recovery.interactionId} for ${issue.identifier || issue.id}; reviewer run ${recovery.runId} is live.`);
        continue;
      case "protocol_failure":
        await log(`[ORCHESTRATOR] Native review recovery refused for ${issue.identifier || issue.id}: ${recovery.reason}.`);
        continue;
      case "restore_and_recover":
        break;
    }

    const recoveryKey = `native-review-projection-recovery:${issue.id}:${recovery.interactionId}:${recovery.failedRunId || "dispatch"}`;
    await nativeReviewRecoveryConvergenceGuard.runOnce(recoveryKey, async () => {
      // Do not mutate executionPolicy/currentParticipant. The existing card
      // remains the sole durable review authority. Paperclip's released
      // ownership gate requires the addressed reviewer to own the issue
      // before it starts the card-bound run; see the pure patch selector.
      const recoveryPatch = nativeReviewRecoveryIssuePatch(recovery);
      if (issue.status !== recoveryPatch.status || issue.assigneeAgentId !== recoveryPatch.assigneeAgentId) {
        const restored = await pc.patchIssue(issue.id, recoveryPatch);
        if (!restored.ok) {
          await log(`[ORCHESTRATOR] Warning: native review state restore failed for ${issue.identifier || issue.id} (${restored.status}): ${restored.text}`);
          return false;
        }
      }
      for (const interactionId of recovery.withdrawInteractionIds) {
        const withdrawn = await pc.withdrawInteraction(
          issue.id,
          interactionId,
          "Superseded plan-review card: an immutable matching PR review card is the active native review authority.",
        );
        if (!withdrawn.ok && withdrawn.status !== 404 && withdrawn.status !== 409) {
          await log(`[ORCHESTRATOR] Warning: stale plan-card withdrawal failed for ${issue.identifier || issue.id} (${withdrawn.status}): ${withdrawn.text}`);
          return false;
        }
      }
      await managedWakeup(
        recovery.reviewerAgentId,
        `Recover native review interaction ${recovery.interactionId}; submit only its structured verdict.`,
        issue.id,
        {
          recoverStaleExecution: true,
          reviewInteractionId: recovery.interactionId,
          forceFreshSession: true,
          ...(recovery.failedRunId ? { recoveryRunId: recovery.failedRunId } : {}),
        },
      );
      nativeReviewRecoveryIds.add(issue.id);
      statusOverrides.set(issue.id, "in_review");
      await log(`[ORCHESTRATOR] Restored native PR review for ${issue.identifier || issue.id} using card ${recovery.interactionId}.`);
      return true;
    });
  }

  // Generic recovery is independently CI-gated. A Jules-specific pass may
  // deliberately leave a red or unverifiable PR with its implementation
  // worker; this broader repair must not immediately steal it into review.
  const reviewRecoveryIssues: ParsedIssueMetadata[] = [];
  for (const issue of overlayedIssues) {
    const isRecoveryCandidate = !nativeReviewRecoveryIds.has(issue.id) && shouldRecoverNativePrReview({
      status: issue.status,
      orchestratorManaged: issue.orchestratorManaged,
      merged: mergedIssueIds.has(issue.id),
      hasUnreviewedReadyPullRequest: hasUnreviewedReadyPullRequest(issue),
      ciGreen: true,
    });
    if (!isRecoveryCandidate) continue;
    if (ghStatus.error) {
      await log(`[ORCHESTRATOR] Deferring native PR review recovery for [${issue.identifier || issue.id}]: GitHub PR/CI state is unavailable.`);
      continue;
    }
    const matchingPr = ghStatus.openPrs.find((pr) => matchPrToIssue(pr, issue));
    if (!matchingPr) {
      await log(`[ORCHESTRATOR] Deferring native PR review recovery for [${issue.identifier || issue.id}]: no authoritative open GitHub PR was found.`);
      continue;
    }
    const ci = await checkPrCiIsGreen(matchingPr.number, workspacePath, matchingPr.url);
    if (!shouldRecoverNativePrReview({
      status: issue.status,
      orchestratorManaged: issue.orchestratorManaged,
      merged: mergedIssueIds.has(issue.id),
      hasUnreviewedReadyPullRequest: hasUnreviewedReadyPullRequest(issue),
      ciGreen: ci.isGreen,
    })) {
      await log(`[ORCHESTRATOR] Deferring native PR review recovery for [${issue.identifier || issue.id}]: CI is ${ci.status}.`);
      continue;
    }
    reviewRecoveryIssues.push(issue);
  }
  for (const issue of reviewRecoveryIssues) {
    await log(
      `[ORCHESTRATOR] Recovering [${issue.identifier || issue.id}] from ${issue.status}: its registered PR is still ready_for_review and has no review verdict.`,
    );
    try {
      const patch = await pc.patchIssue(issue.id, nativePrReviewCleanupPatch());
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
  const reviewRecoveryIds = new Set([...nativeReviewRecoveryIds, ...reviewRecoveryIssues.map((issue) => issue.id), ...boardReviewRecoveryIds, ...openPrRecoveryIds]);
  const inReviewIssues = overlayedIssues.filter((i) => {
    if (i.status === "in_review" || reviewRecoveryIds.has(i.id)) return true;
    if (i.orchestratorManaged && i.assigneeAgentId === orchestratorId && isReviewWaitState(i.rawIssue["executionState"])) return true;
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

  const julesCapacity = resolveWorkerLaneCapacity({
    lane: "jules",
    configuredCapacity: config.maxConcurrentJules ?? 15,
    runningCount: julesRunning,
    agentStatus: julesAgentId ? managedAgentStatuses.get(julesAgentId) : undefined,
  });
  const vibeCapacity = resolveWorkerLaneCapacity({
    lane: "vibe",
    configuredCapacity: config.maxConcurrentVibe ?? 1,
    runningCount: vibeRunning,
    agentStatus: vibeAgentId ? managedAgentStatuses.get(vibeAgentId) : undefined,
  });

  await log(
    `[ORCHESTRATOR] Backlog: total=${parsedIssues.length}, in_review=${inReviewIssues.length} | Jules running=${julesRunning}/${julesCapacity}, Vibe running=${vibeRunning}/${vibeCapacity}, conflict_edges=${conflictResult.conflictEdges.length}`
  );

  if (!approvalsSnapshotLoaded) {
    try {
      await loadApprovals();
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
  }

  const requireApproval = config.requireTaskApproval !== false && (config as Record<string, unknown>)["requireApproval"] !== false;
  let reclaimedUnapprovedCount = 0;
  if (requireApproval) {
    for (const issue of parsedIssues) {
      // `parsedIssues` is the heartbeat's initial snapshot. An open PR can
      // have been promoted above to native review during this same tick, so
      // never let the stale in-progress projection reclaim that terminal
      // handoff because its historical task_start approval is still pending.
      if (!shouldReclaimUnapprovedStart(issue, existingApprovals, openPrRecoveryIds.has(issue.id))) continue;
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
    // Jules titles carry the immutable Paperclip UUID, while the company PR
    // list traditionally matches the human identifier. Prefer that list when
    // it matches, but fall back to the hydrated registered work product so a
    // valid Jules PR cannot disappear merely because its title shape differs.
    const registeredPr = registeredPullRequestFromIssue(reviewTask);
    const matchingPr = !ghStatus.error
      ? ghStatus.openPrs.find((pr) => matchPrToIssue(pr, reviewTask))
        ?? ghStatus.openPrs.find((pr) => registeredPr && pr.url.replace(/\/$/, "") === registeredPr.url.replace(/\/$/, ""))
        ?? registeredPr
      : registeredPr;
    if (!matchingPr) {
      await log(`[ORCHESTRATOR] Ignoring in_review issue [${reviewTask.identifier || reviewTask.id}] without a registered PR.`);
      continue;
    }
    // Paperclip v831 cannot advance an executionPolicy review stage from the
    // adapter's addressed request_item_verdicts cards.  Transfer a managed
    // ready PR to the native-card protocol before evaluating cards: allowing
    // both state machines to coexist creates host recovery wakes after Luna
    // and Terra have already submitted their typed decisions.
    if (shouldTakeOverNativePrReview({
      orchestratorManaged: reviewTask.orchestratorManaged,
      hasReadyPullRequest: true,
      nativeReviewConfigured: Boolean(lunaReviewerAgentId && terraReviewerAgentId),
      rawIssue: reviewTask.rawIssue,
    })) {
      const ownership = await pc.patchIssue(reviewTask.id, nativePrReviewCleanupPatch());
      if (!ownership.ok) {
        await log(`[ORCHESTRATOR] Native PR-review ownership transfer failed for [${reviewTask.identifier || reviewTask.id}] (${ownership.status}): ${ownership.text}`);
        continue;
      }
      const verified = await pc.getIssue<Record<string, unknown>>(reviewTask.id);
      if (issueHasExecutionPolicy(verified)) {
        await log(`[ORCHESTRATOR] Native PR-review ownership transfer for [${reviewTask.identifier || reviewTask.id}] has not converged; deferring card evaluation.`);
        continue;
      }
      statusOverrides.set(reviewTask.id, "in_review");
      await log(`[ORCHESTRATOR] Native PR-review ownership transferred for [${reviewTask.identifier || reviewTask.id}]; evaluating cards on the next heartbeat.`);
      continue;
    }
    // Provider-created coordination children are outside the review state
    // machine. Retire only explicitly marked Jules artifacts before the
    // native card is reused; generic task children remain untouched.
    await retireStaleJulesChildren(reviewTask.id, reviewTask.identifier || reviewTask.id);
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
    const ciCheck = resolvePrCiGate(
      managedJulesCiPolicy,
      await checkPrCiIsGreen(matchingPr.number, workspacePath, matchingPr.url),
    );

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

    // The native card is the durable review lock. Paperclip may project the
    // issue executionState back to idle and may expire the visible card while
    // its explicitly woken reviewer is still running. Correlate that run from
    // the card id before evaluating the pipeline, so a heartbeat cannot create
    // a replacement card or reviewer wake during the active turn.
    const canonicalReviewCards = reviewInteractions.filter((interaction) =>
      interaction.kind === "request_item_verdicts" &&
      isReviewInteractionForIssue(interaction.idempotencyKey, reviewTask.id) &&
      isCanonicalReviewCardKey(interaction.idempotencyKey),
    );
    let hasLiveNativeReviewRun = false;
    for (const reviewerId of [lunaReviewerAgentId, terraReviewerAgentId].filter((id): id is string => Boolean(id))) {
      const binding = findReviewCardBinding({
        issueId: reviewTask.id,
        reviewerAgentId: reviewerId,
        cards: canonicalReviewCards,
        runs: heartbeatRuns,
      });
      if (binding?.run) {
        await log(`[ORCHESTRATOR] ⏳ Preserving live native review run ${binding.run.id} for ${reviewTask.identifier || reviewTask.id}; no replacement card or wake.`);
        hasLiveNativeReviewRun = true;
      }
    }
    // A reviewer run can linger after its exact card has already produced a
    // complete Luna→Terra verdict ladder. The structured verdicts are the
    // durable authority; an old process projection must not suppress the
    // operator merge gate indefinitely.
    const currentHeadReviewComplete = hasCompletedNativeApprovalLadderForHead(
      reviewInteractions,
      reviewTask.id,
      reviewHeadSha,
    );
    if (hasLiveNativeReviewRun && !currentHeadReviewComplete) continue;

    // Allocate no replacement attempt while the exact reviewer run is still
    // live. This must precede orphan cleanup and selectReviewAttempt: a
    // cancelled card is not evidence that the reviewer run ended.
    const sessionState = reviewTask.rawIssue["executionState"];
    const sessionStateRecord = sessionState && typeof sessionState === "object" && !Array.isArray(sessionState)
      ? sessionState as Record<string, unknown>
      : null;
    const sessionInteractionId = typeof sessionStateRecord?.["reviewInteractionId"] === "string"
      ? sessionStateRecord["reviewInteractionId"] as string
      : null;
    const sessionReviewerId = sessionStateRecord?.["currentParticipant"] && typeof sessionStateRecord["currentParticipant"] === "object"
      && typeof (sessionStateRecord["currentParticipant"] as Record<string, unknown>)["agentId"] === "string"
      ? (sessionStateRecord["currentParticipant"] as Record<string, unknown>)["agentId"] as string
      : null;
    if (!currentHeadReviewComplete && sessionInteractionId && sessionReviewerId) {
      const sessionDecision = decideReviewSession({
        issueId: reviewTask.id,
        reviewerAgentId: sessionReviewerId,
        interactionId: sessionInteractionId,
        runs: heartbeatRuns,
        interactions: reviewInteractions,
      });
      if (sessionDecision.action === "await_run") {
        await log(`[ORCHESTRATOR] ⏳ Preserving live native review run ${sessionDecision.runId} for ${reviewTask.identifier || reviewTask.id}; no replacement card or wake.`);
        continue;
      }
      if (sessionDecision.action === "protocol_failure") {
        await log(`[ORCHESTRATOR] 🚨 Native review protocol failure for ${reviewTask.identifier || reviewTask.id}: ${sessionDecision.reason}; no automatic retry.`);
        continue;
      }
      if (sessionDecision.action === "recover") {
        await log(`[ORCHESTRATOR] ♻️ Recovering native review card ${sessionInteractionId} after terminal reviewer run ${sessionDecision.runId}.`);
        await managedWakeup(
          sessionReviewerId,
          `Recover native review interaction ${sessionInteractionId} after reviewer run ${sessionDecision.runId} ended without a structured verdict. Use the existing card exactly once; do not create a new card or post a comment.`,
          reviewTask.id,
          {
            recoverStaleExecution: true,
            reviewInteractionId: sessionInteractionId,
            forceFreshSession: true,
            recoveryRunId: sessionDecision.runId,
          },
        );
        continue;
      }
    }

    // Paperclip versions before native review dispositions may classify an
    // unbound reviewer heartbeat as `deliberate_wait_without_target`. That is
    // a generic owner-repair loop, not a real review decision. Contain it at
    // the adapter boundary: cancel only reviewer runs for this issue that do
    // not carry a pending native card binding, and resolve only the matching
    // generic repair action. The native review-card path below then creates or
    // reuses the one authoritative dialog. This is intentionally temporary;
    // Paperclip should eventually own this typed disposition and propagate
    // interactionId/interactionKind atomically with the heartbeat context.
    let containedOrphanReviewerRun = false;
    try {
      const recoverySnapshot = await pc.listRecoveryActions(reviewTask.id) as { active?: Record<string, unknown> | null };
      const executionState = reviewTask.rawIssue["executionState"];
      const activeReviewInteractionId = executionState && typeof executionState === "object" && !Array.isArray(executionState)
        && typeof (executionState as Record<string, unknown>)["reviewInteractionId"] === "string"
        ? (executionState as Record<string, unknown>)["reviewInteractionId"] as string
        : null;
      const reviewerIds = [lunaReviewerAgentId, terraReviewerAgentId, vibeReviewerAgentId, reviewerAgentId]
        .filter((id): id is string => Boolean(id));
      const orphanPlan = planOrphanReviewRecovery({
        issueId: reviewTask.id,
        reviewerAgentIds: reviewerIds,
        activeReviewInteractionId,
        runs: heartbeatRuns,
        interactions: reviewInteractions,
        activeRecoveryAction: recoverySnapshot.active,
      });
      for (const runId of orphanPlan.cancelRunIds) {
        const cancelled = await pc.cancelHeartbeatRun(runId, `Native review containment: ${orphanPlan.reason}`);
        if (cancelled.ok || cancelled.status === 404 || cancelled.status === 409) {
          containedOrphanReviewerRun = true;
        }
        if (!cancelled.ok && cancelled.status !== 404 && cancelled.status !== 409) {
          await log(`[ORCHESTRATOR] Warning: could not cancel orphan reviewer run ${runId} (${cancelled.status}): ${cancelled.text}`);
        }
      }
      if (orphanPlan.resolveRecoveryActionId) {
        const resolved = await pc.resolveRecoveryAction(reviewTask.id, {
          actionId: orphanPlan.resolveRecoveryActionId,
          outcome: "false_positive",
          sourceIssueStatus: reviewTask.status,
          resolutionNote: `${orphanPlan.reason} Paperclip upstream should model native review cards as typed dispositions.`,
        });
        if (!resolved.ok && resolved.status !== 404 && resolved.status !== 409) {
          await log(`[ORCHESTRATOR] Warning: could not resolve orphan review disposition (${resolved.status}): ${resolved.text}`);
        }
      }
    } catch (recoveryError) {
      // Recovery cleanup must never prevent the actual review pipeline from
      // evaluating the native card and producing a safe next action.
      await log(`[ORCHESTRATOR] Warning: orphan review containment probe failed: ${String(recoveryError)}`);
    }

    const pipelineDecision = evaluateReviewPipelineProgress({
      issue: reviewTask,
      prNumber: matchingPr?.number,
      prUrl: matchingPr?.url,
      ciStatus: ciCheck,
      interactions: reviewInteractions,
      heartbeatRuns: currentHeadReviewComplete
        ? heartbeatRuns.filter((run) => run.issueId !== reviewTask.id)
        : heartbeatRuns,
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
        if (containedOrphanReviewerRun) return "idle";
        const reviewerId = (reviewTask.rawIssue["executionState"] as { currentParticipant?: { agentId?: string | null } } | null | undefined)?.currentParticipant?.agentId;
        return reviewerId ? managedAgentStatuses.get(reviewerId) : undefined;
      })(),
    });

    // Every selected review item must leave one durable diagnostic breadcrumb.
    // This is intentionally log-only: native cards and approvals remain the
    // state-machine authority, while this records the exact reducer action
    // when a host projection or an external provider makes a live heartbeat
    // appear to stop after Jules-child reconciliation.
    await log(
      `[ORCHESTRATOR] [Review outcome] [${reviewTask.identifier || reviewTask.id}] ` +
      `pipeline:${pipelineDecision.action} pr=${matchingPr.url} head=${reviewHeadSha}`,
    );

    switch (pipelineDecision.action) {
      case "AWAIT_CI":
        if (ciCheck.accessProblem) {
          await log(
            `[ORCHESTRATOR] 🚨 GITHUB CI VERIFICATION UNAVAILABLE for [${reviewTask.identifier || reviewTask.id}]: ${ciCheck.accessProblem} ` +
            `The PR may be green, but no review will be dispatched until Paperclip can verify it.`
          );
        }
        await log(`[ORCHESTRATOR] ⏳ [Stage 1 CI Gate] ${pipelineDecision.reason}`);
        continue;
      case "AWAIT_REVIEW_CONFIGURATION":
      case "AWAIT_REVIEW":
      case "AWAIT_OPERATOR_RECOVERY":
        await log(`[ORCHESTRATOR] ⏳ [${pipelineDecision.stage}] ${pipelineDecision.reason}`);
        continue;
      case "DISPATCH_VIBE_REVIEW":
      case "DISPATCH_STRONG_REVIEW":
      case "DISPATCH_LUNA_REVIEW":
      case "DISPATCH_TERRA_REVIEW":
      case "RECOVER_REVIEW":
      case "REASSIGN_TO_WORKER":
      case "RECONCILE_OPERATOR_GATE":
      case "CREATE_MERGE_APPROVAL":
      case "AWAIT_OPERATOR_APPROVAL":
      case "EXECUTE_MERGE":
        break;
    }

    if (isReviewDispatchDecision(pipelineDecision)) {
      // Workspace sync only protects backlog import and new implementation
      // dispatch. A registered PR already has an immutable repository URL and
      // native typed review cards, so blocking its review behind an unrelated
      // local checkout turns a healthy PR into a permanent in_review stall.
      // Existing terminal verdicts still need to converge while a provider
      // question is pending, but starting another reviewer would create a
      // competing owner and spend quota on a revision awaiting clarification.
      if (shouldDeferPrReviewDispatch(reviewInteractions, true)) {
        await log(
          `[ORCHESTRATOR] Deferring PR review for [${reviewTask.identifier || reviewTask.id}]: ` +
          `a native provider question is still pending.`,
        );
        continue;
      }
      const targetAgentId = pipelineDecision.targetAgentId;
      {
        const stage: PrReviewStage = reviewDispatchStage(pipelineDecision);
        const reviewCircuitKey = targetAgentId
          ? `review-card:${companyId}:${reviewTask.id}:${stage}:${reviewHeadSha}:${targetAgentId}`
          : undefined;
        // Do not emit a misleading routing line on every heartbeat while the
        // same reviewer capability is durably unavailable. The first failure
        // below emits the actionable diagnostic; recovery closes the circuit.
        if (!reviewCircuitKey || !capabilityCircuit.isOpen(reviewCircuitKey)) {
          const stageLabel = stage === "luna" ? "Stage 2 OpenAI Luna Review" : stage === "terra" ? "Stage 3 OpenAI Terra Review" : stage === "vibe" ? "Stage 2 Vibe Fast Review" : "Stage 3 Strong Model Review";
          await log(
            `[ORCHESTRATOR] 📋 [${stageLabel}] Routing in_review task [${reviewTask.identifier || reviewTask.id}] "${reviewTask.title}" to ${targetAgentId}`
          );
        }

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
          let reviewRequest: ReturnType<typeof buildReviewInteractionRequest> | undefined;
          const reviewIdentityBase = {
            issueId: reviewTask.id,
            prUrl: matchingPr.url,
            headSha: reviewHeadSha,
            stage,
            reviewerAgentId: targetAgentId,
          };
          // Cancelled Paperclip interactions retain their idempotency keys
          // forever. Allocate a monotonic attempt so a cancelled native card
          // can be replaced without a 409, while a pending card remains
          // exactly-once and is reused.
          const reviewIdentity = {
            ...reviewIdentityBase,
            attempt: selectReviewAttempt(reviewIdentityBase, reviewInteractions),
          } as const;
          const reviewCircuitKey = `review-card:${companyId}:${reviewTask.id}:${stage}:${reviewHeadSha}:${targetAgentId}`;
          const reviewerEligibility = evaluateStructuredReviewerEligibility(
            managedAgentStatuses.get(targetAgentId),
            agentStructuredDecisionCapabilities.get(targetAgentId),
            "pull_request_review",
          );
          if (reviewerEligibility.kind === "unavailable") {
            const status = managedAgentStatuses.get(targetAgentId);
            const circuitState = capabilityCircuit.record(reviewCircuitKey, {
              ok: false,
              status: 422,
              text: `Reviewer ${targetAgentId} is not invokable: ${reviewerEligibility.reason}`,
            });
            if (circuitState === "opened") {
              await log(
                `[ORCHESTRATOR] 🚨 Review paused for [${reviewTask.identifier || reviewTask.id}]: ` +
                `reviewer ${targetAgentId} is unavailable (${status || "unknown"}). ` +
                `No review card or wake will be retried until the reviewer becomes invokable.`,
              );
            }
            const waitState = buildReviewWaitState({
              prUrl: matchingPr.url,
              headSha: reviewHeadSha,
              stage,
              reviewerAgentId: targetAgentId,
              reviewerStatus: status || "unknown",
              reason: reviewerEligibility.reason,
              circuitKey: reviewCircuitKey,
            });
            // Publish the wait as a Paperclip recovery action. Unlike the
            // adapter executionState projection, this is consumed by
            // Paperclip's native attention/inbox state and remains visible
            // while the reviewer is paused. The server upsert is source- and
            // fingerprint-scoped, so heartbeats are idempotent.
            try {
              const recoveryResponse = await pc.listRecoveryActions(reviewTask.id) as { active?: unknown };
              if (!isSameReviewerUnavailableRecovery(recoveryResponse.active, reviewCircuitKey)) {
                const recovery = await pc.createRecoveryAction(
                  reviewTask.id,
                  reviewerUnavailableRecoveryPayload({
                    prUrl: matchingPr.url,
                    headSha: reviewHeadSha,
                    stage,
                    reviewerAgentId: targetAgentId,
                    reviewerStatus: status || "unknown",
                    reason: reviewerEligibility.reason,
                    circuitKey: reviewCircuitKey,
                  }),
                );
                if (!recovery.ok) {
                  await log(`[ORCHESTRATOR] Warning: could not persist reviewer recovery action (${recovery.status}): ${recovery.text}`);
                }
              }
            } catch (recoveryError) {
              await log(`[ORCHESTRATOR] Warning: failed to publish reviewer recovery action: ${String(recoveryError)}`);
            }
            // A circuit marker can predate this wait-state protocol. Reconcile
            // missing/mismatched durable state once, without reopening the
            // diagnostic or attempting a reviewer dispatch.
            // Paperclip owns and rewrites executionState for the active
            // orchestrator heartbeat (usually back to idle). Do not fight
            // that projection every minute: status + orchestrator ownership
            // + null policy are the durable wait-state contract, while the
            // immutable identity is retained by the circuit marker.
            const durableWaitOwnership = reviewTask.status === "in_review" &&
              reviewTask.assigneeAgentId === orchestratorId &&
              !issueHasExecutionPolicy(reviewTask.rawIssue);
            if (!durableWaitOwnership) {
              const waitPatch = await pc.patchIssue(reviewTask.id, nativePrReviewWaitPatch(orchestratorId, waitState));
              if (!waitPatch.ok) {
                await log(`[ORCHESTRATOR] Warning: could not persist recoverable review wait state (${waitPatch.status}): ${waitPatch.text}`);
              }
            }
            continue;
          }
          // A successful health observation is the explicit probe that closes
          // a durable paused-reviewer circuit after the agent recovers.
          capabilityCircuit.record(reviewCircuitKey, { ok: true, status: 200, text: "reviewer invokable" });
          try {
            const dialogPlan = planReviewDialog(reviewIdentity, reviewInteractions);
            // The native card is the only review lock. Do not patch
            // executionPolicy/currentParticipant here: Paperclip can launch a
            // second unbound reviewer run from that projection, which was the
            // source of MAZ-955's duplicate free-text comments and quota burn.
            // Do not withdraw another stage's card during a heartbeat either;
            // stale-card cleanup must be an explicit migration operation.
            if (dialogPlan.action === "reuse") {
              reviewInteractionId = dialogPlan.interactionId;
            } else {
              reviewRequest = buildReviewInteractionRequest(reviewIdentity);
              const createdInteraction = await pc.createInteraction(
                reviewTask.id,
                reviewRequest,
              );
              if (!createdInteraction.ok) {
                const circuitState = capabilityCircuit.record(reviewCircuitKey, {
                  ok: false,
                  status: createdInteraction.status,
                  text: createdInteraction.text,
                });
                if (isReviewerEligibilityFailure(createdInteraction.status, createdInteraction.text) && circuitState === "already_open") {
                  continue;
                }
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
              reviewDispatchedCount++;
            }
            try {
              const recoveryResponse = await pc.listRecoveryActions(reviewTask.id) as { active?: Record<string, unknown> | null };
              const active = recoveryResponse.active;
              if (active?.["kind"] === "reviewer_unavailable" && active["fingerprint"] === reviewCircuitKey) {
                const resolved = await pc.resolveRecoveryAction(reviewTask.id, {
                  actionId: active["id"],
                  outcome: "restored",
                  sourceIssueStatus: "in_review",
                  resolutionNote: `Reviewer ${targetAgentId} is invokable again; native ${stage} review dispatch restored.`,
                });
                if (!resolved.ok) {
                  await log(`[ORCHESTRATOR] Warning: could not resolve reviewer recovery action (${resolved.status}): ${resolved.text}`);
                }
              }
            } catch (recoveryError) {
              await log(`[ORCHESTRATOR] Warning: failed to resolve reviewer recovery action: ${String(recoveryError)}`);
            }
          } catch (interactionError) {
            await log(`[ORCHESTRATOR] 🚨 Failed to create native review dialog for [${reviewTask.identifier || reviewTask.id}]: ${String(interactionError)}`);
            continue;
          }
          const runDispatch = selectReviewRunDispatch({
            dialogCreated,
            recovery: pipelineDecision.action === "RECOVER_REVIEW",
            request: reviewRequest,
          });
          // A just-created addressed card starts one run natively. Do not
          // change the issue owner or issue a second wake: Paperclip treats
          // that extra run as an unbound review path after the first verdict.
          // Recovery remains the sole explicit-wake path because it reuses an
          // existing unanswered card whose original run is terminal.
          if (reviewInteractionId && (runDispatch === "manual_wake" || runDispatch === "recovery_wake")) {
            await managedWakeup(
              targetAgentId,
              `Review PR #${matchingPr.number} for ${reviewTask.identifier || reviewTask.id}; respond to native review interaction ${reviewInteractionId}. This is a read-only review; do not modify files.`,
              reviewTask.id,
              { recoverStaleExecution: true, reviewInteractionId, forceFreshSession: true },
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
        const staleReviewCardIds = selectReviewCardsToWithdrawAfterRejection(reviewInteractions, reviewTask.id);
        if (staleReviewCardIds.length > 0) {
          await reviewRejectionConvergenceGuard.runOnce(
            `review-rejection-cleanup:${reviewTask.id}:${reviewHeadSha}`,
            async () => {
              for (const interactionId of staleReviewCardIds) {
                const withdrawn = await pc.withdrawInteraction(
                  reviewTask.id,
                  interactionId,
                  `Superseded by structured ${pipelineDecision.stage} rejection; worker resumed for the same PR head.`,
                );
                if (!withdrawn.ok && withdrawn.status !== 404 && withdrawn.status !== 409) {
                  await log(`[ORCHESTRATOR] Warning: stale review card cleanup failed (${withdrawn.status}): ${withdrawn.text}`);
                }
              }
              return true;
            },
          );
        }
        await managedWakeup(
          workerId,
          `Native PR review needs work for [${reviewTask.identifier || reviewTask.id}]. Jules will reconcile the bound structured verdict.`,
          reviewTask.id,
          { idempotencyKey: `orchestrator:jules-reconcile:${reviewTask.id}:${reviewHeadSha}:${pipelineDecision.stage}` },
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
          } else {
            // Paperclip versions that create a board approval may normalize
            // the linked issue back to an implementation state. The approval
            // is a review-stage wait, so preserve the lifecycle invariant:
            // green PR + pending merge approval remains in_review and cannot
            // be dispatched to Jules/Vibe again on the next heartbeat.
            const preserved = await preservePendingReviewState(reviewTask.id);
            if (!preserved.ok) {
              await log(`[ORCHESTRATOR] Warning: Could not verify in_review after merge approval (${preserved.status}): ${preserved.text}`);
            }
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
  if (vibeAgentId && managedIds.has(vibeAgentId) && vibeRunning < vibeCapacity && isSyncHealthy) {
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
  let candidateSelections = isSyncHealthy ? selectNextTasksMultiLane(dispatchIssues, conflictForDispatch, {
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
    preferredIssueIds: new Set(
      dispatchIssues
        .filter((issue) => findTaskStartApproval(existingApprovals, issue.id)?.status === "approved")
        .map((issue) => issue.id),
    ),
  }) : [];

  // Authorization belongs to a task, not to a capacity-dependent worker
  // selection. Create a bounded wave from the currently runnable roots and
  // their explicit dependents, so an operator can approve a DAG before each
  // predecessor becomes terminal without flooding unrelated backlog cards.
  let approvalsRequestedCount = 0;
  const requestedStartApprovalIssueIds = new Set<string>();
  if (requireApproval && isSyncHealthy) {
    const earlyApprovalCandidates = selectStartApprovalCandidates(
      dispatchIssues,
      candidateSelections.map((selection) => selection.issue.id),
    );
    for (const issue of earlyApprovalCandidates) {
      const approvalDecision = evaluateTaskStartApproval(issue, existingApprovals, requireApproval);
      if (approvalDecision.action !== "CREATE_APPROVAL_REQUEST") continue;

      await log(
        `[ORCHESTRATOR] ⏳ Requesting task-scoped operator start approval for [${issue.identifier || issue.id}] "${issue.title}".`,
      );
      try {
        const createRes = await pc.createApproval(companyId, {
          type: "request_board_approval",
          payload: {
            action: "task_start",
            title: approvalDecision.title,
            description: approvalDecision.description,
            issueId: issue.id,
            identifier: issue.identifier,
            issueTitle: issue.title,
            priority: issue.priority,
            component: issue.component,
            targetFiles: issue.targetFiles,
          },
        });
        if (createRes.ok) {
          approvalsRequestedCount++;
          requestedStartApprovalIssueIds.add(issue.id);
        } else {
          await log(`[ORCHESTRATOR] Warning: Failed to create start approval (${createRes.status}): ${createRes.text}`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await log(`[ORCHESTRATOR] Warning: Failed to create start approval: ${msg}`);
      }
    }
  }

  if (candidateSelections.length === 0) {
    const reason = !isSyncHealthy
      ? `Workspace synchronization is unhealthy (${syncDispositionObservation.type}); new dev tasks suppressed.`
      : julesRunning >= julesCapacity && vibeRunning >= vibeCapacity
        ? `Worker lanes at full capacity (Jules: ${julesRunning}/${julesCapacity}, Vibe: ${vibeRunning}/${vibeCapacity})`
        : "No unblocked implementation tasks ready in backlog/todo";

    await log(`[ORCHESTRATOR] Implementation dispatch: ${reason}.`);
    const summary = `Orchestrator tick: ${mergedAutoCompleted} merged tasks reconciled, ${archiveResult.archivedCount} archived, ${reviewDispatchedCount} reviews routed, ${clarifierDispatchedCount} clarified, backfilled ${executionPolicyBackfillCount} execution policies, continued ${continuationWakeCount} live sessions, 0 new dev tasks dispatched (${reason}).`;

    if (!isSyncHealthy) {
      const heldCandidates = selectNextTasksMultiLane(dispatchIssues, conflictForDispatch, {
        julesAgentId, vibeAgentId, julesCapacity: 1, vibeCapacity: 1, julesRunningCount: 0, vibeRunningCount: 0,
        maxToSelect: 1, extraLockedFiles: ghStatus.openPrFiles, preferredIssueIds: new Set(),
      });

      let topHeldIssue: ParsedIssueMetadata | null = heldCandidates.length > 0 ? heldCandidates[0]!.issue : null;
      if (!topHeldIssue) {
        // Fallback to finding highest priority held task from inReviewIssues that were held
        // But evaluating pipeline decisions precisely here is complex. We'll simply use any orchestrated issue that is held if we couldn't find a dispatch issue.
        const backupHeld = overlayedIssues.filter(i => i.orchestratorManaged && (i.status === "todo" || i.status === "backlog" || i.status === "in_review"))
          .sort((a, b) => b.priorityRank - a.priorityRank);
        if (backupHeld.length > 0) topHeldIssue = backupHeld[0] || null;
      }

      if (topHeldIssue) {
        const fingerprintStr = JSON.stringify({ status: syncDispositionStatus, observation: syncDispositionObservation });
        const idempotencyKey = `sync-hold:${topHeldIssue.id}:${fingerprintStr}`;
        const holdDesc = `[Task Orchestrator] The shared project workspace failed to synchronize safely. New work has been temporarily suspended to avoid conflicting with another teammate's unpushed changes or a damaged git tree.\n\nObservation: ${syncDispositionObservation.type}\nStatus: ${syncDispositionStatus}\n\nExisting merges and reviews will continue to process, but this task will not begin until the workspace is healthy again. Please inspect the host git repository manually to resolve the issue.`;

        try {
          const interactionRes = await pc.createInteraction(topHeldIssue.id, {
            kind: "ask_user_questions",
            status: "pending",
            resolverPolicy: "human_only",
            continuationPolicy: "wake_assignee",
            idempotencyKey,
            request: {
              prompt: holdDesc,
              questions: [{ id: "sync_resolved", type: "confirm", text: "I have manually restored the workspace consistency. Re-evaluate sync on the next heartbeat." }]
            }
          });
          if (!interactionRes.ok) {
            await log(`[ORCHESTRATOR] Warning: Failed to create sync-hold user question for ${topHeldIssue.identifier || topHeldIssue.id}: ${interactionRes.status} ${interactionRes.text}`);
          } else {
            await log(`[ORCHESTRATOR] ⚠️ Emitted sync-hold human question for held task ${topHeldIssue.identifier || topHeldIssue.id}.`);
          }
        } catch (e: unknown) {
          await log(`[ORCHESTRATOR] Warning: Exception creating sync-hold user question: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary,
    };
  }

  // existingApprovals was evaluated in Phase 2

  let dispatchedCount = 0;
  let awaitingApprovalCount = 0;

  for (const selection of candidateSelections) {
    const targetIssueId = selection.issue.id;
    const targetAgentId = selection.targetAgentId;

    if (requestedStartApprovalIssueIds.has(targetIssueId)) {
      await log(
        `[ORCHESTRATOR] ⏳ [${selection.issue.identifier || selection.issue.id}] "${selection.issue.title}" is awaiting the task-scoped approval created this heartbeat.`,
      );
      awaitingApprovalCount++;
      continue;
    }

    const approvalDecision = evaluateTaskStartApproval(
      selection.issue,
      existingApprovals,
      requireApproval
    );

    if (approvalDecision.action === "CREATE_APPROVAL_REQUEST") {
      // The early authorization phase owns creation. Reaching this branch
      // means creation failed or the snapshot is stale, and dispatch must
      // remain fail-closed until the next heartbeat can reconcile it.
      await log(
        `[ORCHESTRATOR] Warning: [${selection.issue.identifier || selection.issue.id}] has no task-start approval after the authorization phase; refusing dispatch.`,
      );
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

    // Selection is an optimization; this is the final safety gate. Fetch the
    // enriched Paperclip record after approval evaluation so stale compact
    // projections cannot turn an approved dependent into a worker wake.
    try {
      const authoritativeIssue = await pc.getIssue<Record<string, unknown>>(targetIssueId);
      const dependencyGate = evaluateAuthoritativeDependencies(authoritativeIssue);
      if (!dependencyGate.safe) {
        await log(`[ORCHESTRATOR] Dependency-gated skip for [${selection.issue.identifier || targetIssueId}]: ${dependencyGate.reason}`);
        continue;
      }
    } catch (err: unknown) {
      await log(`[ORCHESTRATOR] Dependency-gated skip for [${selection.issue.identifier || targetIssueId}]: could not read authoritative blockers (${String(err)}).`);
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
