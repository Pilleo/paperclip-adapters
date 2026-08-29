
function ghStatusRepo(wsPath?: string): string | undefined {
  return "Pilleo/mazewall";
}
import { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { extractIssueMetadata } from "../core/parser.js";
import { calculateConflictMatrix, selectNextTasksMultiLane } from "../core/dispatcher.js";
import { fetchJulesQuota } from "../core/jules-quota.js";
import { checkWorkspaceConsistency } from "../core/consistency.js";
import { fetchGitHubPullRequests, matchPrToIssue } from "../core/github-sync.js";
import { evaluateIssueTransition } from "../core/state-machine.js";
import { syncBacklogMarkdownToPaperclip } from "../core/backlog-sync.js";
import { archiveResolvedBacklogFiles } from "../core/backlog-archiver.js";
import { selectClarificationCandidates } from "../core/clarifier.js";
import { ParsedIssueMetadata } from "../core/types.js";
import { evaluateTaskStartApproval, PaperclipApprovalSummary } from "../core/approvals.js";
import { formatOrchestratorDashboardCard } from "../core/telemetry-card.js";
import { identifyStalledIssues } from "../core/stalled-session-reaper.js";
import { synthesizeTokenFriendlyReviewPrompt } from "../core/review-synthesizer.js";
import { identifyMergedBranches } from "../core/branch-pruner.js";
import { reconcileManagedFleet } from "../core/fleet-manager.js";

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
  const rawContext = context.context as Record<string, unknown> | undefined;
  const companyId = (context.agent?.companyId || (rawContext ? (rawContext["companyId"] as string) : "") || "") as string;
  const config = (context.config || {}) as OrchestratorAdapterConfig;
  const envMap = process.env;
  const apiUrl = config.apiUrl || envMap["PAPERCLIP_API_URL"] || "http://127.0.0.1:3100";
  const workspacePath = config.workspacePath || "/home/leanid/Documents/code/java/jseccomp";

  const log = async (msg: string) => {
    console.log(msg);
    if (context.onLog) {
      await context.onLog("stdout", msg + "\n").catch(() => {});
    }
  };

  await log(`[ORCHESTRATOR] Starting deterministic scheduling tick for company ${companyId}...`);

  // 1. Resolve Worker (Jules & Vibe) and Reviewer agents
  let julesAgentId = config.julesAgentId;
  let vibeAgentId = config.vibeAgentId;
  let reviewerAgentId = config.reviewerAgentId;

  try {
    const agentsRes = await fetch(`${apiUrl}/api/companies/${companyId}/agents`);
    if (agentsRes.ok) {
      const agents = (await agentsRes.json()) as Array<{ id: string; name: string; adapterType: string }>;

      if (!julesAgentId) {
        const jules = agents.find(
          (a) =>
            a.adapterType === "jules" ||
            a.name.toLowerCase().includes("jules") ||
            a.name.toLowerCase().includes("async")
        );
        if (jules) {
          julesAgentId = jules.id;
          await log(`[ORCHESTRATOR] Primary Jules agent: ${jules.name} (${jules.id})`);
        }
      }

      if (!vibeAgentId) {
        const vibe = agents.find((a) => a.adapterType === "vibe" || a.name.toLowerCase().includes("vibe"));
        if (vibe) {
          vibeAgentId = vibe.id;
          await log(`[ORCHESTRATOR] Specialized Vibe agent: ${vibe.name} (${vibe.id})`);
        }
      }

      if (!reviewerAgentId) {
        const securityEngineer = agents.find((a) => a.name.includes("Founding Systems") || a.name.includes("Security"));
        const claudeSummarizer = agents.find(
          (a) => a.adapterType === "claude_local" || a.adapterType === "codex_local"
        );
        const selectedReviewer = securityEngineer || claudeSummarizer;
        if (selectedReviewer) {
          reviewerAgentId = selectedReviewer.id;
          await log(`[ORCHESTRATOR] Reviewer agent: ${selectedReviewer.name} (${selectedReviewer.id})`);
        }
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await log(`[ORCHESTRATOR] Warning: Failed to fetch agents list: ${msg}`);
  }

  // 2. Read-only Workspace consistency verification
  const wsConsistency = await checkWorkspaceConsistency(workspacePath);
  if (wsConsistency.warning) {
    await log(`[ORCHESTRATOR] ℹ️ Workspace note: ${wsConsistency.warning}`);
  }

  // 3. Two-Way Markdown Ingestion
  const syncSummary = await syncBacklogMarkdownToPaperclip({
    workspacePath,
    companyId,
    apiUrl,
    backlogDirectory: config.backlogDirectory,
    resolvedDirectory: config.resolvedDirectory,
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

  // 6. Fetch all company issues
  let issuesList: any[] = [];
  try {
    const issuesRes = await fetch(`${apiUrl}/api/companies/${companyId}/issues?limit=1000`);
    if (!issuesRes.ok) {
      throw new Error(`Failed to fetch issues: HTTP ${issuesRes.status}`);
    }
    issuesList = (await issuesRes.json()) as any[];
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

  const parsedIssues: ParsedIssueMetadata[] = issuesList.map(extractIssueMetadata);

  // 7. PHASE 1: Reconcile board status with merged GitHub PRs & Archive files
  const statusOverrides = new Map<string, string>();
  let mergedAutoCompleted = 0;
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
            `[ORCHESTRATOR] 🎯 Reconciling [${issue.identifier || issue.id}] "${issue.title}" (${transition.reason})`
          );
          try {
            await fetch(`${apiUrl}/api/issues/${issue.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status: transition.toStatus }),
            });
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

const archiveResult = archiveResolvedBacklogFiles(workspacePath, parsedIssues);
  if (archiveResult.archivedCount > 0) {
    await log(`[ORCHESTRATOR] 📦 Archived ${archiveResult.archivedCount} completed tasks to docs/internals/backlog/resolved/`);
  }

  // 7.5. PHASE 1.5: Reclaim stalled in_progress sessions with no live runner or heartbeat
  const activeExecutionIds = new Set<string>();
  const stalled = identifyStalledIssues(parsedIssues, activeExecutionIds, {
    stalledThresholdMs: config.stalledThresholdMinutes ? config.stalledThresholdMinutes * 60 * 1000 : 15 * 60 * 1000,
  });

  let stalledReclaimedCount = 0;
  for (const { issue, idleDurationMs } of stalled) {
    const mins = Math.round(idleDurationMs / 60000);
    await log(
      `[ORCHESTRATOR] ♻️ Reclaiming stalled task [${issue.identifier || issue.id}] "${issue.title}" (idle ${mins}m with no active heartbeat) -> todo`
    );
    try {
      await fetch(`${apiUrl}/api/issues/${issue.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "todo",
          assigneeAgentId: null,
          assigneeUserId: null,
        }),
      });
      await fetch(`${apiUrl}/api/issues/${issue.id}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: `[Orchestrator] Stalled session detected with no active heartbeat (idle ${mins}m). Safely reclaimed and returned to \`todo\`.`,
        }),
      }).catch(() => {});
      statusOverrides.set(issue.id, "todo");
      stalledReclaimedCount++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await log(`[ORCHESTRATOR] Warning: Failed to reclaim stalled issue: ${msg}`);
    }
  }

  const inProgressIssues = parsedIssues.filter((i) => i.status === "in_progress");
  const inReviewIssues = parsedIssues.filter((i) => i.status === "in_review");
  const conflictResult = calculateConflictMatrix(parsedIssues);

  const julesRunning = inProgressIssues.filter((i) => i.assigneeAgentId === julesAgentId).length;
  const vibeRunning = inProgressIssues.filter((i) => i.assigneeAgentId === vibeAgentId).length;

  const julesCapacity =
    config.maxConcurrentJules ??
    (julesQuota.fetchedLive ? julesQuota.effectiveAvailableCapacity + julesRunning : 15);
  const vibeCapacity = config.maxConcurrentVibe ?? 1;

  await log(
    `[ORCHESTRATOR] Backlog: total=${parsedIssues.length}, in_review=${inReviewIssues.length} | Jules running=${julesRunning}/${julesCapacity}, Vibe running=${vibeRunning}/${vibeCapacity}, conflict_edges=${conflictResult.conflictEdges.length}`
  );

  // 8. PHASE 2: Route in_review tasks to Reviewer Agent
  let reviewDispatchedCount = 0;
  for (const reviewTask of inReviewIssues) {
    if (reviewerAgentId && reviewTask.assigneeAgentId !== reviewerAgentId) {
      await log(
        `[ORCHESTRATOR] 📋 Routing in_review task [${reviewTask.identifier || reviewTask.id}] "${reviewTask.title}" to Reviewer Agent (${reviewerAgentId})`
      );

      try {
        const matchingPr = ghStatus.openPrs.find((pr) => matchPrToIssue(pr, reviewTask));
        const reviewPrompt = synthesizeTokenFriendlyReviewPrompt({
          issue: reviewTask,
          prUrl: matchingPr?.url,
          prNumber: matchingPr?.number,
          branchName: matchingPr?.headRefName,
        });

        await fetch(`${apiUrl}/api/issues/${reviewTask.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ assigneeAgentId: reviewerAgentId }),
        });

        await fetch(`${apiUrl}/api/issues/${reviewTask.id}/comments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: reviewPrompt }),
        }).catch(() => {});

        await fetch(`${apiUrl}/api/agents/${reviewerAgentId}/wakeup`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reason: `Token-efficient review requested for [${reviewTask.identifier || reviewTask.id}]`,
            issueId: reviewTask.id,
          }),
        }).catch(() => {});

        reviewDispatchedCount++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await log(`[ORCHESTRATOR] Warning: Failed to route review task: ${msg}`);
      }
    }
  }

  // 9. PHASE 3: Route ambiguous / open_questions tasks to Vibe Clarifier Lane
  let clarifierDispatchedCount = 0;
  if (vibeAgentId && vibeRunning < vibeCapacity) {
    const clarificationCandidates = selectClarificationCandidates(parsedIssues, vibeAgentId, vibeCapacity - vibeRunning);
    for (const cand of clarificationCandidates) {
      await log(
        `[ORCHESTRATOR] 💡 Routing ambiguous task [${cand.issue.identifier || cand.issue.id}] "${cand.issue.title}" to Vibe Clarification Lane`
      );
      try {
        await fetch(`${apiUrl}/api/issues/${cand.issue.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status: "in_progress",
            assigneeAgentId: vibeAgentId,
          }),
        });
        await fetch(`${apiUrl}/api/agents/${vibeAgentId}/wakeup`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reason: `Conduct task interview, clarify open questions, and formulate implementation specification for [${cand.issue.identifier || cand.issue.id}]`,
            issueId: cand.issue.id,
          }),
        }).catch(() => {});
        clarifierDispatchedCount++;
      } catch {}
    }
  }

  // 10. PHASE 4: Multi-Lane Implementation Dispatching
  const candidateSelections = selectNextTasksMultiLane(parsedIssues, conflictResult, {
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
    const summary = `Orchestrator tick: ${mergedAutoCompleted} merged tasks reconciled, ${archiveResult.archivedCount} archived, ${reviewDispatchedCount} reviews routed, ${clarifierDispatchedCount} clarified, 0 new dev tasks dispatched (${reason}).`;
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary,
    };
  }

  // Fetch existing approvals to enforce operator approval gate
  let existingApprovals: PaperclipApprovalSummary[] = [];
  try {
    const approvalsRes = await fetch(`${apiUrl}/api/companies/${companyId}/approvals`);
    if (approvalsRes.ok) {
      const rawApprovals = (await approvalsRes.json()) as Array<{
        id: string;
        type: string;
        status: "pending" | "approved" | "rejected";
        payload?: Record<string, unknown>;
        issueIds?: string[];
      }>;
      existingApprovals = rawApprovals.map((a) => {
        const payload = (a.payload || {}) as Record<string, unknown>;
        const payloadIssueId = typeof payload["issueId"] === "string" ? [payload["issueId"] as string] : [];
        return {
          id: a.id,
          type: a.type,
          status: a.status,
          issueIds: Array.isArray(a.issueIds) && a.issueIds.length > 0 ? a.issueIds : payloadIssueId,
          payload,
        };
      });
    }
  } catch {}

  const requireApproval = config.requireTaskApproval !== false && (config as any).requireApproval !== false;
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
        const createRes = await fetch(`${apiUrl}/api/companies/${companyId}/approvals`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
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
          }),
        });
        if (createRes.ok) {
          approvalsRequestedCount++;
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
      const updateRes = await fetch(`${apiUrl}/api/issues/${targetIssueId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: transition.toStatus,
          assigneeAgentId: effectiveAssigneeId,
        }),
      });

      if (!updateRes.ok) {
        const errText = await updateRes.text();
        throw new Error(`Failed to update issue status: HTTP ${updateRes.status} ${errText}`);
      }

      if (targetAgentId) {
        await fetch(`${apiUrl}/api/agents/${targetAgentId}/wakeup`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reason: `Task [${selection.issue.identifier || selection.issue.id}] dispatched by Task Orchestrator`,
            issueId: targetIssueId,
          }),
        }).catch(() => {});
      }

      dispatchedCount++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await log(`[ORCHESTRATOR] ❌ Dispatch error for issue ${targetIssueId}: ${msg}`);
    }
  }

  const elapsed = Date.now() - t0;
  const summary = `Reconciled with remote (${mergedAutoCompleted} merged PRs completed, ${archiveResult.archivedCount} files archived), requested ${approvalsRequestedCount} approvals (${awaitingApprovalCount} pending), dispatched ${dispatchedCount} tasks in ${elapsed}ms.`;
  
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
