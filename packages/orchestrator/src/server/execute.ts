import { checkPrMergeability, evaluatePrMergeability } from "../core/git-safety.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

import { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { extractIssueMetadata, resolvePaperclipProject, type PaperclipProjectRecord } from "../core/parser.js";
import { calculateConflictMatrix, selectNextTasksMultiLane } from "../core/dispatcher.js";
import { fetchJulesQuota } from "../core/jules-quota.js";
import { checkWorkspaceConsistency } from "../core/consistency.js";
import { fetchGitHubPullRequests, matchPrToIssue, checkPrCiIsGreen } from "../core/github-sync.js";
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
import { synthesizeTokenFriendlyReviewPrompt } from "../core/review-synthesizer.js";
import { evaluateReviewPipelineProgress } from "../core/review-pipeline.js";
import {
  buildMazewallExecutionPolicy,
  issueHasExecutionPolicy,
  issueNeedsExecutionPolicyBackfill,
} from "../core/execution-policy.js";
import { rebasePrBranchLocally } from "../core/local-rebase.js";
import { evaluateAgentHealth, AgentHealthReport } from "../core/agent-health-monitor.js";
import { synthesizeAuditDigest } from "../core/audit-digest.js";
import { resolveManagedFleet, type FleetAgentRecord } from "../core/managed-workers.js";
import { asArray, createPaperclipHttp, issuePatch } from "../core/paperclip-http.js";
import {
  liveHeartbeatIssueIds,
  parseHeartbeatRun,
  selectSessionContinuations,
  type ContinuationWorker,
  type HeartbeatRunSummary,
} from "../core/session-continuation.js";

export interface OrchestratorAdapterConfig {
  readonly maxConcurrentJules?: number | undefined;
  readonly maxConcurrentVibe?: number | undefined;
  readonly julesAgentId?: string | undefined;
  readonly vibeAgentId?: string | undefined;
  readonly reviewerAgentId?: string | undefined;
  readonly workspacePath?: string | undefined;
  readonly backlogDirectory?: string | undefined;
  readonly resolvedDirectory?: string | undefined;
  readonly apiUrl?: string | undefined;
  readonly requireTaskApproval?: boolean | undefined;
  readonly stalledThresholdMinutes?: number | undefined;
}

export async function execute(context: AdapterExecutionContext): Promise<AdapterExecutionResult> {
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
  const workspacePath = config.workspacePath || envMap["WORKSPACE_PATH"] || workspaceFromCtx || process.cwd();
  const authToken =
    (context as AdapterExecutionContext & { authToken?: string }).authToken ||
    envMap["PAPERCLIP_AGENT_TOKEN"] ||
    envMap["PAPERCLIP_API_KEY"];
  const pc = createPaperclipHttp({ apiUrl, authToken, runId: context.runId });
  let managedIds = new Set<string>();

  const log = async (msg: string) => {
    console.log(msg);
    if (context.onLog) {
      await context.onLog("stdout", msg + "\n").catch(() => {});
    }
  };
  const managedWakeup = async (agentId: string | undefined, reason: string, issueId?: string) => {
    if (!agentId || !managedIds.has(agentId)) return;
    const res = await pc.wakeup(agentId, reason, issueId);
    if (!res.ok) {
      await log(`[ORCHESTRATOR] Warning: wakeup ${agentId} failed (${res.status}): ${res.text}`);
    }
  };

  await log(`[ORCHESTRATOR] Starting deterministic scheduling tick for company ${companyId}...`);

  // 1. Resolve Worker (Jules & Vibe) and Reviewer agents
  let julesAgentId = config.julesAgentId;
  let vibeAgentId = config.vibeAgentId;
  let reviewerAgentId = config.reviewerAgentId;
  let agentHealthReport: AgentHealthReport | undefined;

  let managedJulesIds = new Set<string>();
  let managedWorkerStates: ContinuationWorker[] = [];
  let julesNeedsReattach = false;
  try {
    const rawAgents = asArray<Record<string, unknown>>(await pc.listAgents(companyId));
    const agents: FleetAgentRecord[] = rawAgents.map((a) => ({
      id: String(a["id"]),
      name: String(a["name"]),
      adapterType: String(a["adapterType"]),
      status: String(a["status"] || "idle"),
      reportsTo: (a["reportsTo"] as string | null) || null,
      errorReason: (a["errorReason"] as string | null) || null,
      pauseReason: (a["pauseReason"] as string | null) || null,
      orgChainHealth: a["orgChainHealth"] as FleetAgentRecord["orgChainHealth"],
      metadata: (a["metadata"] as Record<string, unknown> | null) || null,
    }));

    const orchestratorId = context.agent?.id || "";
    const fleet = resolveManagedFleet(agents, orchestratorId, {
      julesAgentId,
      vibeAgentId,
      reviewerAgentId,
    });
    managedIds = new Set(fleet.managedIds);
    managedJulesIds = new Set(fleet.managedJulesIds);
    managedWorkerStates = agents
      .filter((a) => managedIds.has(a.id) && (a.adapterType === "jules" || a.adapterType === "vibe" || a.adapterType === "antigravity"))
      .map((a) => ({ id: a.id, status: a.status, adapterType: a.adapterType }));
    julesAgentId = fleet.julesAgentId;
    vibeAgentId = fleet.vibeAgentId;
    reviewerAgentId = fleet.reviewerAgentId;
    if (julesAgentId) await log(`[ORCHESTRATOR] Managed Jules agent: ${julesAgentId}`);
    if (vibeAgentId) await log(`[ORCHESTRATOR] Managed Vibe agent: ${vibeAgentId}`);
    if (reviewerAgentId) await log(`[ORCHESTRATOR] Managed Reviewer agent: ${reviewerAgentId}`);

    const managedJules = agents.find((a) => a.id === julesAgentId);
    julesNeedsReattach = Boolean(
      managedJules &&
        (managedJules.status === "error" || (managedJules.errorReason || "").includes("Process lost"))
    );

    agentHealthReport = evaluateAgentHealth(agents);
    if (!agentHealthReport.isHealthy) {
      for (const inc of agentHealthReport.incidents) {
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
  const workspaceProject = resolvePaperclipProject({
    workspacePath,
    gitRemoteUrl,
    projects: companyProjects,
  });
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
  });
  if (syncSummary.createdCount > 0 || syncSummary.syncedHeadersCount > 0) {
    await log(
      `[ORCHESTRATOR] 📥 Backlog Sync: created=${syncSummary.createdCount}, headers_synced=${syncSummary.syncedHeadersCount}`
    );
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
    await log(`[ORCHESTRATOR] GitHub sync failed: ${ghStatus.error}. Skipping merge/review mutations this tick.`);
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

  const parsedIssues: ParsedIssueMetadata[] = issuesList.map((issue) =>
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
      const rawRuns = await pc.listHeartbeatRuns(companyId, worker.id, 8);
      heartbeatRuns.push(...rawRuns.map((raw) => parseHeartbeatRun(raw)));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await log(`[ORCHESTRATOR] Warning: Failed to list heartbeat runs for ${worker.id}: ${msg}`);
    }
  }

  // 7. PHASE 1: Reconcile board status with merged GitHub PRs & Archive files
  const statusOverrides = new Map<string, string>();
  let mergedAutoCompleted = 0;
  if (!ghStatus.error) {
  for (const issue of parsedIssues) {
    if (issue.status !== "done" && issue.status !== "cancelled") {
      const mergedPr = ghStatus.mergedPrs.find((pr) => matchPrToIssue(pr, issue));
      if (mergedPr) {
        const transition = evaluateIssueTransition(issue.status, issue.assigneeAgentId, {
          type: "APPROVE_AND_MERGE",
          prNumber: mergedPr.number,
        });

        if (transition.isAllowed) {
          await log(
            `[ORCHESTRATOR] Reconciling [${issue.identifier || issue.id}] "${issue.title}" (${transition.reason})`
          );
          try {
            const patch = await pc.patchIssue(issue.id, issuePatch(transition.toStatus as "done"));
            if (!patch.ok) {
              await log(`[ORCHESTRATOR] Warning: Failed to transition merged issue (${patch.status}): ${patch.text}`);
              continue;
            }

            if (transition.toStatus === "done") {
              const digest = synthesizeAuditDigest({
                issue,
                pr: mergedPr,
              });
              await pc.comment(issue.id, digest);
            }

            statusOverrides.set(issue.id, transition.toStatus);
            mergedAutoCompleted++;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            await log(`[ORCHESTRATOR] Warning: Failed to transition merged issue: ${msg}`);
          }
        }
      }
    }
  }
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
    const missingDep = issue.dependencies.some((depId) => {
      return !parsedIssues.some((p) => p.id === depId || p.identifier === depId);
    });
    if (missingDep) continue;

    const hasUnresolvedDependency = issue.dependencies.some((depId) => {
      const dep = parsedIssues.find((p) => p.id === depId || p.identifier === depId);
      if (!dep) return true;
      const depStatus = statusOverrides.get(dep.id) || dep.status;
      return depStatus !== "done" && depStatus !== "resolved";
    });

    if (!hasUnresolvedDependency) {
      const matchingPr = ghStatus.error ? undefined : ghStatus.openPrs.find((pr) => matchPrToIssue(pr, issue));
      const targetStatus = matchingPr ? "in_review" : "todo";
      const targetAssignee = matchingPr && reviewerAgentId ? reviewerAgentId : undefined;

      await log(
        `[ORCHESTRATOR] Unblocking orphan blocked task [${issue.identifier || issue.id}] "${issue.title}" -> ${targetStatus}`
      );
      try {
        const patch = await pc.patchIssue(
          issue.id,
          targetStatus === "in_review" && targetAssignee
            ? issuePatch("in_review", targetAssignee)
            : { status: targetStatus }
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
      ? { ...issue, status: statusOverrides.get(issue.id) as string }
      : issue
  );

  let executionPolicyBackfillCount = 0;
  const mazewallPolicy = buildMazewallExecutionPolicy({
    vibeAgentId,
    reviewerAgentId,
  });
  if (mazewallPolicy) {
    for (const issue of overlayedIssues) {
      if (!issueNeedsExecutionPolicyBackfill(issue, managedIds)) continue;
      await log(
        `[ORCHESTRATOR] Backfilling executionPolicy on [${issue.identifier || issue.id}] (assigned without dispatch; no status/assignee change)`,
      );
      try {
        const patch = await pc.patchIssue(issue.id, { executionPolicy: mazewallPolicy });
        if (!patch.ok) {
          await log(
            `[ORCHESTRATOR] Warning: Failed to backfill executionPolicy (${patch.status}): ${patch.text}`,
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
    issues: overlayedIssues,
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
  const inReviewIssues = overlayedIssues.filter((i) => i.status === "in_review");
  const conflictResult = calculateConflictMatrix(overlayedIssues);

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
  for (const reviewTask of inReviewIssues) {
    const matchingPr = ghStatus.error ? undefined : ghStatus.openPrs.find((pr) => matchPrToIssue(pr, reviewTask));
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
    const ciCheck = matchingPr
      ? await checkPrCiIsGreen(matchingPr.number, workspacePath)
      : { isGreen: false, status: "none" as const };

    let taskComments: Array<{ id: string; body: string; authorAgentId?: string | null }> = [];
    try {
      taskComments = asArray(await pc.listComments(reviewTask.id));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await log(`[ORCHESTRATOR] Warning: Failed to list comments for ${reviewTask.identifier}: ${msg}`);
    }

    const pipelineDecision = evaluateReviewPipelineProgress({
      issue: reviewTask,
      prNumber: matchingPr?.number,
      prUrl: matchingPr?.url,
      ciStatus: ciCheck,
      comments: taskComments,
      existingApprovals,
      vibeAgentId,
      reviewerAgentId,
      workerAgentId: julesAgentId || vibeAgentId,
    });

    if (pipelineDecision.action === "AWAIT_CI") {
      await log(
        `[ORCHESTRATOR] ⏳ [Stage 1 CI Gate] ${pipelineDecision.reason}`
      );
      continue;
    }

    if (issueHasExecutionPolicy(reviewTask.rawIssue)) {
      if (pipelineDecision.action === "DISPATCH_VIBE_REVIEW" || pipelineDecision.action === "DISPATCH_STRONG_REVIEW") {
        await log(
          `[ORCHESTRATOR] [${reviewTask.identifier || reviewTask.id}] has executionPolicy; Paperclip runtime owns reviewer assignment. ${pipelineDecision.reason}`
        );
        continue;
      }
    }

    if (pipelineDecision.action === "DISPATCH_VIBE_REVIEW" || pipelineDecision.action === "DISPATCH_STRONG_REVIEW") {
      const targetAgentId = pipelineDecision.targetAgentId;
      if (reviewTask.assigneeAgentId !== targetAgentId) {
        const stageLabel = pipelineDecision.action === "DISPATCH_VIBE_REVIEW" ? "Stage 2 Vibe Fast Review" : "Stage 3 Strong Model Review";
        await log(
          `[ORCHESTRATOR] 📋 [${stageLabel}] Routing in_review task [${reviewTask.identifier || reviewTask.id}] "${reviewTask.title}" to ${targetAgentId}`
        );

        try {
          if (targetAgentId && !managedIds.has(targetAgentId)) {
            await log(`[ORCHESTRATOR] Refusing to route review to unmanaged agent ${targetAgentId}`);
            continue;
          }
          const reviewPrompt = synthesizeTokenFriendlyReviewPrompt({
            issue: reviewTask,
            prUrl: matchingPr?.url,
            prNumber: matchingPr?.number,
            branchName: matchingPr?.headRefName,
          });

          await pc.patchIssue(reviewTask.id, { assigneeAgentId: targetAgentId });
          await pc.comment(reviewTask.id, reviewPrompt);
          await managedWakeup(targetAgentId, `Review requested for [${reviewTask.identifier || reviewTask.id}]`, reviewTask.id);
          reviewDispatchedCount++;
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
        await managedWakeup(workerId, `Review changes requested for [${reviewTask.identifier || reviewTask.id}]`, reviewTask.id);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await log(`[ORCHESTRATOR] Warning: Failed to reassign after review: ${msg}`);
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
    const clarificationCandidates = selectClarificationCandidates(overlayedIssues, vibeAgentId, vibeCapacity - vibeRunning);
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

  const dispatchIssues = overlayedIssues.map((issue) =>
    statusOverrides.has(issue.id) ? { ...issue, status: statusOverrides.get(issue.id) as string } : issue
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
    maxToSelect: Math.max(1, julesCapacity - julesRunning + (vibeCapacity - vibeRunning)),
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
        vibeAgentId,
        reviewerAgentId,
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
    resolvedCount: parsedIssues.filter((i) => i.status === "done" || i.status === "resolved").length,
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
