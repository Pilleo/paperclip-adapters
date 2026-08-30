import {
  MAX_COMMENT_LENGTH,
  MAX_SESSION_RESUME_ATTEMPTS,
  activityComment,
  extractQuestionText,
  feedbackAnswer,
  formatActivityForLog,
  interactionPlanRevisionId,
  latestAgentMessage,
  latestPlan,
  planMarkdown,
  rejectionReason,
} from "./activity-formatter.js";
import { evaluateSessionStartup, isInteractionWake, sessionMatchesConfig } from "./session-lifecycle.js";
import { isLiveJulesRemoteState } from "./jules-live-state.js";
import { evaluateSessionWatchdog } from "./watchdog.js";
import { listAllActivities, mirrorNewActivities } from "./activity-mirror.js";
import { persistSessionBestEffort } from "./session-initializer.js";
import { evaluatePlanClarity, composePlanForReview, createCheapReviewer, createTerraCodexReviewer, defaultCheapReviewer } from "./plan-reviewer.js";
import { buildHostImplementationPlan } from "@pilleo/paperclip-adapter-common";
import { evaluateSessionFailure } from "./failure-recovery.js";
import { extractResolvedInteraction } from "./interaction-relay.js";
import {
  evaluateInteractionAction,
  recordFeedbackRelayed,
  recordPlanApprovalRelayed,
  determinePaperclipIssueStatus,
} from "./interaction-engine.js";
import { formatCardPrompt, formatCardSummary } from "./card-prompt.js";
import { getPullRequestCiStatus, getPullRequestDetails, getPullRequestPatch, listPullRequestChangedFiles } from "./ci-status.js";
import { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { AdapterConfig, validateConfig, requireJulesApiKey, discoverLocalGitRepository, discoverLocalGitDefaultBranch } from "./config.js";
import { isGhCliAuthenticated, createRemoteGitHubRepo } from "./git-remote-creator.js";
import { JulesAdapterSessionV1, sessionCodec, serializeSession } from "./session.js";
import { JulesActivity, JulesClient, JulesClientError, extractPullRequestUrl } from "./jules-client.js";
import { buildPrompt, hashPromptIdentity, PROMPT_IDENTITY_HASH_VERSION } from "./prompt-builder.js";
import { handleJulesState } from "./state-machine.js";
import { evaluateJulesLifecycleState } from "./state-engine.js";
import { evaluateScopeConformity } from "@pilleo/paperclip-adapter-common";
import { classifyFailure, toErrorFamily, summarizeJulesFailure } from "./failure-classifier.js";
import { shouldRetry, getRetryNotBefore } from "./retry-policy.js";
import { asJulesActivityId, asJulesSessionId, asPaperclipId } from "./brands.js";
import { CtxContextSchema, HostContextSchema } from "./context-schemas.js";
import { sanitizeError } from "./error-sanitizer.js";
import { deleteStoredSession, loadStoredSession, saveStoredSession } from "./session-store.js";
import {
  isAfterCheckpoint,
  laterCheckpoint,
  normalizeActivities,
} from "./activity-checkpoint.js";
import {
  listIssueComments,
  createNoPrCompletionInteraction,
  addJulesActivityComment,
  createJulesFeedbackInteraction,
  createJulesPlanApprovalInteraction,
  getPaperclipInteraction,
  listPaperclipInteractions,
  moveIssueToBlocked,
  moveIssueToInProgress,
  postSessionLink,
  readJulesSessionHandle,
  moveIssueToDone,
  moveIssueToReview,
  listWorkProducts,
  registerPullRequestWorkProduct,
  PaperclipClientError,
  getPaperclipJson,
  type PaperclipInteraction,
} from "./paperclip-client.js";
import { createTelemetry } from "./telemetry.js";

const JULES_CONTINUATION_DELAY_MS = 60 * 1000;
const JULES_INITIAL_ACTIVITY_CHECK_DELAY_MS = 5 * 1000;

function readContextString(context: Record<string, unknown>, key: string): string | null {
  const value = context[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readContextRecord(context: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = context[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function completionInteractionResult(
  session: JulesAdapterSessionV1,
  issueStatus: "blocked" | "done",
  summary: string,
  clearSession: boolean,
): AdapterExecutionResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    sessionParams: serializeSession(session),
    sessionDisplayId: session.julesSessionId ?? null,
    summary,
    resultJson: {
      provider: "jules",
      julesSessionId: session.julesSessionId,
      julesState: session.julesState ?? session.phase,
      issueStatus,
      interactionId: session.pendingInteraction?.paperclipInteractionId,
      completedWithoutPr: true,
    },
    clearSession,
  };
}

function paperclipInteractionFailure(
  session: JulesAdapterSessionV1,
  error: unknown,
): AdapterExecutionResult {
  console.error("[jules] paperclipInteractionFailure:", error);
  const status = error instanceof PaperclipClientError ? error.status : null;
  const transient = status === null || status === 408 || status === 429 || status >= 500;
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorCode: "paperclip_completion_interaction_failed",
    errorFamily: transient ? "transient_upstream" : null,
    errorMessage: sanitizeError(error),
    retryNotBefore: transient
      ? new Date(Date.now() + JULES_CONTINUATION_DELAY_MS).toISOString()
      : null,
    sessionParams: serializeSession(session),
    sessionDisplayId: session.julesSessionId ?? null,
    clearSession: false,
  };
}

function createProgressSummary(session: JulesAdapterSessionV1): string {
    const state = session.julesState || session.phase || "RUNNING";
    return `Jules session ${session.julesSessionId} is ${state}; Paperclip will resume polling it on the next heartbeat.`;
}

function createPendingResult(
  session: JulesAdapterSessionV1,
  initialActivityCheck = false,
  reattachDelayMs?: number,
): AdapterExecutionResult {
    const summary = createProgressSummary(session);
    const delayMs = initialActivityCheck
      ? JULES_INITIAL_ACTIVITY_CHECK_DELAY_MS
      : (reattachDelayMs ?? JULES_CONTINUATION_DELAY_MS);
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      retryNotBefore: new Date(Date.now() + delayMs).toISOString(),
      sessionParams: serializeSession(session),
      sessionDisplayId: session.julesSessionId || null,
      summary,
      resultJson: {
        provider: "jules",
        julesSessionId: session.julesSessionId,
        julesState: session.julesState ?? session.phase,
        pending: true,
      },
      clearSession: false,
    };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  if (!ctx.agent || typeof ctx.agent.adapterConfig === 'undefined') {
      throw new Error("Missing adapter config");
  }
  // Resumed runs (scheduled-retry promotion, heartbeat recovery) may arrive with
  // an empty context - Paperclip does not re-attach task/paperclipIssue on those
  // paths. When an existing session is being resumed, task identity is already
  // captured in the stored prompt hash, so synthesize the minimum the schema
  // requires instead of crashing before the poll loop. (Issue #7 follow-up /
  // upstream ask: promote-with-context.)
  const rawCtx: Record<string, unknown> =
    ctx.context && typeof ctx.context === "object"
      ? (ctx.context as Record<string, unknown>)
      : {};
  const resumedSessionId: string | undefined = (() => {
    const sp = (ctx.runtime?.sessionParams ?? null) as Record<string, unknown> | null;
    if (sp) {
      const direct = sp["julesSessionId"] ?? sp["sessionId"];
      if (typeof direct === "string" && direct) return direct;
      for (const v of Object.values(sp)) {
        if (v && typeof v === "object") {
          const nested = (v as Record<string, unknown>)["julesSessionId"];
          if (typeof nested === "string" && nested) return nested;
        }
      }
    }
    const runtimeSid = (ctx.runtime as { sessionId?: string | null; sessionDisplayId?: string | null } | undefined)
      ?.sessionId || (ctx.runtime as { sessionDisplayId?: string | null } | undefined)?.sessionDisplayId;
    if (typeof runtimeSid === "string" && runtimeSid.trim()) return runtimeSid.trim();
    return undefined;
  })();

  const extractedTask = ((): Record<string, unknown> | null => {
    if (rawCtx["task"] && typeof rawCtx["task"] === "object") return rawCtx["task"] as Record<string, unknown>;
    if (rawCtx["paperclipIssue"] && typeof rawCtx["paperclipIssue"] === "object") return rawCtx["paperclipIssue"] as Record<string, unknown>;
    if (rawCtx["issue"] && typeof rawCtx["issue"] === "object") return rawCtx["issue"] as Record<string, unknown>;
    const wake = rawCtx["paperclipWake"] as Record<string, unknown> | undefined;
    if (wake && typeof wake === "object") {
      if (wake["task"] && typeof wake["task"] === "object") return wake["task"] as Record<string, unknown>;
      if (wake["paperclipIssue"] && typeof wake["paperclipIssue"] === "object") return wake["paperclipIssue"] as Record<string, unknown>;
      if (wake["issue"] && typeof wake["issue"] === "object") return wake["issue"] as Record<string, unknown>;
    }
    const payload = rawCtx["payload"] as Record<string, unknown> | undefined;
    if (payload && typeof payload === "object") {
      if (payload["task"] && typeof payload["task"] === "object") return payload["task"] as Record<string, unknown>;
      if (payload["paperclipIssue"] && typeof payload["paperclipIssue"] === "object") return payload["paperclipIssue"] as Record<string, unknown>;
      if (payload["issue"] && typeof payload["issue"] === "object") return payload["issue"] as Record<string, unknown>;
    }
    return null;
  })();

  if (!extractedTask && !resumedSessionId) {
    if (ctx.onLog) {
      await ctx.onLog("stdout", "[jules] No task or paperclipIssue attached to this run context; heartbeat completed cleanly.\n");
    }
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "No task or paperclipIssue attached to this run; heartbeat completed.",
      sessionParams: ctx.runtime?.sessionParams ?? null,
      sessionDisplayId: resumedSessionId ?? null,
      clearSession: false,
    };
  }

  const contextForParse: Record<string, unknown> = {
    ...rawCtx,
    task: extractedTask ?? { id: `resumed:${resumedSessionId}`, title: "Resumed Jules session", description: "" },
  };
  const parsedCtxContext = CtxContextSchema.parse(contextForParse);
  const rawContext = parsedCtxContext as Record<string, unknown>;
  const rawWorkspace = readContextRecord(parsedCtxContext, "workspace") ?? readContextRecord(parsedCtxContext, "paperclipWorkspace");
  const issueOverride = rawContext["julesSettings"] ?? rawContext["adapterSettings"];
  let workspaceRepositoryUrl = readContextString(rawWorkspace, "repositoryUrl") ?? readContextString(rawWorkspace, "repoUrl");
  let workspaceDefaultBranch = readContextString(rawWorkspace, "defaultBranch") ?? readContextString(rawWorkspace, "defaultRef");

  let projectId = readContextString(parsedCtxContext, "projectId") ??
    readContextString(readContextRecord(parsedCtxContext, "contextSnapshot"), "projectId") ??
    readContextString(readContextRecord(parsedCtxContext, "task"), "projectId") ??
    readContextString(readContextRecord(parsedCtxContext, "paperclipIssue"), "projectId");

  const effectiveTaskId = asPaperclipId(String((extractedTask as { id?: unknown })?.id ?? parsedCtxContext.task.id));

  // Project lookup
  let companyId = readContextString(parsedCtxContext, "companyId") ??
    readContextString(readContextRecord(parsedCtxContext, "task"), "companyId") ??
    readContextString(readContextRecord(parsedCtxContext, "paperclipIssue"), "companyId");

  if (process.env["NODE_ENV"] !== "test" && !projectId && effectiveTaskId && !effectiveTaskId.startsWith("resumed:")) {
    try {
      const issueData = await getPaperclipJson<Record<string, unknown>>(
        `/api/issues/${encodeURIComponent(effectiveTaskId)}`,
        ctx.authToken,
        ctx.runId,
      );
      if (typeof issueData["projectId"] === "string") projectId = issueData["projectId"];
      if (typeof issueData["companyId"] === "string") companyId = issueData["companyId"];
    } catch (e) {
      if (ctx.onLog) await ctx.onLog("stderr", `[jules] Issue fetch error: ${e}\n`);
    }
  }

  let workspaceCwd = readContextString(rawWorkspace, "cwd");

  if (process.env["NODE_ENV"] !== "test") {
    try {
      let targetProject: Record<string, unknown> | null = null;
      if (projectId) {
        targetProject = await getPaperclipJson<Record<string, unknown>>(
          `/api/projects/${encodeURIComponent(projectId)}`,
          ctx.authToken,
          ctx.runId,
        );
      } else if (companyId) {
        const list = await getPaperclipJson<unknown>(
          `/api/companies/${encodeURIComponent(companyId)}/projects`,
          ctx.authToken,
          ctx.runId,
        );
        if (Array.isArray(list) && list.length === 1) {
          targetProject = list[0] as Record<string, unknown>;
        } else if (Array.isArray(list) && list.length > 1) {
          targetProject = list[0] as Record<string, unknown>;
        }
      }

      if (targetProject) {
        const nested = targetProject as {
          primaryWorkspace?: { repoUrl?: string; defaultRef?: string; cwd?: string };
          codebase?: { repoUrl?: string; defaultRef?: string; localFolder?: string; effectiveLocalFolder?: string };
          name?: string;
        };
        const pRepo = nested.primaryWorkspace?.repoUrl ?? nested.codebase?.repoUrl;
        const pBranch = nested.primaryWorkspace?.defaultRef ?? nested.codebase?.defaultRef;
        const pCwd = nested.primaryWorkspace?.cwd ?? nested.codebase?.localFolder ?? nested.codebase?.effectiveLocalFolder;
        if (pRepo && !workspaceRepositoryUrl) workspaceRepositoryUrl = pRepo;
        if (pBranch && !workspaceDefaultBranch) workspaceDefaultBranch = pBranch;
        if (pCwd) {
          if (!workspaceCwd) workspaceCwd = pCwd;
          if (!workspaceRepositoryUrl) {
            const discoveredRepo = discoverLocalGitRepository(pCwd);
            if (discoveredRepo) {
              workspaceRepositoryUrl = discoveredRepo;
            } else if (isGhCliAuthenticated(pCwd) && ((ctx.agent.adapterConfig as Record<string, unknown> | undefined)?.["autoCreateRemote"] === true || (rawContext && (rawContext as any)["approvedRemoteCreation"] === true))) {
              if (ctx.onLog) await ctx.onLog("stdout", `[jules] Creating GitHub remote repository for local workspace via gh CLI...\n`);
              const creationResult = createRemoteGitHubRepo({ cwd: pCwd });
              if (creationResult.success && creationResult.repository) {
                workspaceRepositoryUrl = creationResult.repoUrl || `https://github.com/${creationResult.repository}`;
                if (ctx.onLog) await ctx.onLog("stdout", `[jules] Created and pushed to GitHub repository: ${creationResult.repository}\n`);
              }
            }
          }
          if (!workspaceDefaultBranch) {
            const discoveredBranch = discoverLocalGitDefaultBranch(pCwd);
            if (discoveredBranch) workspaceDefaultBranch = discoveredBranch;
          }
        }
        if (ctx.onLog) await ctx.onLog("stdout", `[jules] Resolved project ${nested.name} -> repo: ${workspaceRepositoryUrl}, branch: ${workspaceDefaultBranch}\n`);
      }
    } catch (e) {
      if (ctx.onLog) await ctx.onLog("stderr", `[jules] Project fetch error: ${e}\n`);
    }
  }
  const warnings: string[] = [];
  const config = validateConfig(ctx.agent.adapterConfig, {
    issueOverride,
    workspace: {
      ...(workspaceRepositoryUrl ? { repositoryUrl: workspaceRepositoryUrl } : {}),
      ...(workspaceDefaultBranch ? { defaultBranch: workspaceDefaultBranch } : {}),
      ...(workspaceCwd ? { cwd: workspaceCwd } : {}),
      ...(rawWorkspace["hasRemote"] === false ? { hasRemote: false } : {}),
    },
    warn: message => warnings.push(message),
  });
  for (const warning of warnings) await ctx.onLog?.("stderr", `[jules settings] ${warning}\n`);
  const parsedHostCtx = HostContextSchema.parse(ctx);

  let session = sessionCodec.decode(ctx.runtime.sessionParams);
  const canonicalSessionId =
    sessionCodec.getCanonicalSessionId(ctx.runtime.sessionParams) ??
    sessionCodec.getDisplayId(ctx.runtime.sessionParams) ??
    resumedSessionId ??
    (typeof ctx.runtime?.sessionId === "string" ? ctx.runtime.sessionId : null) ??
    (typeof ctx.runtime?.sessionDisplayId === "string" ? ctx.runtime.sessionDisplayId : null);
  // sessionDeadlineMinutes is the Jules cloud session TTL, not the Paperclip
  // heartbeat budget. Each execute() run polls once and yields.
  const reattachDelayMs = config.pollCadenceSeconds * 1000;

  const abortSignal = parsedHostCtx.abortSignal || new AbortController().signal;

  const rawTaskId = parsedCtxContext.task.id;
  const taskId = asPaperclipId(rawTaskId);
  const telemetry = createTelemetry(taskId, async (record) => {
    if (ctx.onLog) await ctx.onLog("stdout", `${JSON.stringify(record)}\n`);
  });
  const apiKey = requireJulesApiKey(ctx.config);
  const client = new JulesClient(apiKey, telemetry);
  const taskTitle = parsedCtxContext.task.title;
  const taskDescription = parsedCtxContext.task.description;

  // EARLY CHECK: Check if this issue already has an attached PR on GitHub that is merged.
  let earlyPrUrl = session?.currentPrUrl;
  if (!earlyPrUrl && !process.env["VITEST"]) {
    try {
      const existing = await listWorkProducts(taskId, ctx.authToken, ctx.runId).catch(() => []);
      const match = existing.find((w: any) => Boolean(w.url && (w.url.includes("/pull/") || w.type === "pull_request")));
      if (match?.url) earlyPrUrl = match.url as any;
    } catch {}
  }

  if (earlyPrUrl) {
    try {
      const prDetails = await getPullRequestDetails(earlyPrUrl);
      if (prDetails.merged) {
        if (ctx.onLog) {
          await ctx.onLog("stdout", `[jules] Pull request ${earlyPrUrl} is already merged on GitHub. Completing task as done.\n`);
        }
        await moveIssueToDone(taskId, session?.julesSessionId || "completed", ctx.authToken, ctx.runId);
        await deleteStoredSession(taskId, config.source, config.baseBranch).catch(() => {});
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          sessionParams: null,
          sessionDisplayId: session?.julesSessionId || null,
          summary: `Pull request ${earlyPrUrl} is merged on GitHub. Issue marked done.`,
          resultJson: { provider: "jules", prUrl: earlyPrUrl, issueStatus: "done", merged: true },
          clearSession: true
        };
      }
    } catch (e) {
      if (ctx.onLog) await ctx.onLog("stderr", `[jules] Early merged PR check error: ${e}\n`);
    }
  }

  let storedRecoverySession: JulesAdapterSessionV1 | null = null;
  try {
    storedRecoverySession = await loadStoredSession(taskId, config.source, config.baseBranch);
  } catch {}

  let issueHandleSessionId: string | null = null;
  if (!session && !canonicalSessionId && !storedRecoverySession && ctx.authToken) {
    try {
      issueHandleSessionId = await readJulesSessionHandle(taskId, ctx.authToken, ctx.runId);
    } catch (error) {
      if (ctx.onLog) {
        await ctx.onLog("stderr", `[jules] Could not read Paperclip session handle: ${sanitizeError(error)}\n`);
      }
    }
  }

  const startupDecision = evaluateSessionStartup(
    rawContext,
    session,
    storedRecoverySession,
    canonicalSessionId,
    { repository: config.repository, source: config.source, baseBranch: config.baseBranch, taskId },
    issueHandleSessionId,
  );

  if (startupDecision.forceFreshSession) {
    session = null;
    await deleteStoredSession(taskId, config.source, config.baseBranch).catch(() => {});
  } else {
    session = startupDecision.session;
    if (session && !sessionMatchesConfig(session, config) && ctx.onLog) {
      await ctx.onLog(
        "stderr",
        `[jules] Stored session repo/branch differs from current config; still resuming live Jules session ${session.julesSessionId} (no createSession).\n`,
      );
    }
    if (session && storedRecoverySession && session.sessionId === storedRecoverySession.sessionId && ctx.onLog) {
      await ctx.onLog("stdout", "[jules] Restored session " + session.julesSessionId + " from the local recovery record.\n");
    } else if (session && issueHandleSessionId && session.julesSessionId === issueHandleSessionId && ctx.onLog) {
      await ctx.onLog("stdout", "[jules] Restored session " + session.julesSessionId + " from the Paperclip issue handle.\n");
    }
  }

  if (session && session.julesSessionId && ctx.authToken) {
    try {
      const comments = await listIssueComments(taskId, ctx.authToken, ctx.runId);
      const relayed = new Set(session.relayedReviewCommentIds || []);
      for (const comment of comments) {
        if (relayed.has(comment.id)) continue;
        if (comment.body && (comment.body.includes("REQUEST_CHANGES") || comment.body.includes("Code Review"))) {
          await client.sendMessage(session.julesSessionId, {
            prompt: `The code review for this task returned changes requested:\n\n${comment.body}\n\nPlease address these review findings and update the pull request.`,
          });
          relayed.add(comment.id);
          session.relayedReviewCommentIds = [...relayed];
          await persistSessionBestEffort(session, ctx.onLog);
          if (ctx.onLog) {
            await ctx.onLog("stdout", `[jules] Relayed review comment ${comment.id} to Jules session ${session.julesSessionId}\n`);
          }
        }
      }
    } catch (e) {
      if (ctx.onLog) await ctx.onLog("stderr", `[jules] Review comment relay check failed: ${String(e)}\n`);
    }
  }

  const resolvedInter = extractResolvedInteraction(rawContext, session);
  const interactionId = resolvedInter.interactionId;
  const interactionKind = resolvedInter.kind;
  const interactionStatus = resolvedInter.status;
  const pendingCompletion = session?.pendingInteraction?.type === "completion_confirmation"
    ? session.pendingInteraction
    : null;
  const pendingProviderInteraction = session?.pendingInteraction &&
    (session.pendingInteraction.type === "user_feedback" || session.pendingInteraction.type === "plan_approval")
    ? session.pendingInteraction
    : null;
  const isCompletionResolution = interactionKind === "request_confirmation" &&
    (interactionStatus === "accepted" || interactionStatus === "rejected");

  if (!pendingCompletion && !pendingProviderInteraction && isCompletionResolution) {
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "Ignored an already-resolved or stale Paperclip interaction wake with no pending Jules state.",
      sessionParams: session ? serializeSession(session) : null,
      sessionDisplayId: session?.julesSessionId ?? null,
      clearSession: false,
    };
  }

  if (pendingCompletion && isCompletionResolution) {
    if (interactionId !== pendingCompletion.paperclipInteractionId) {
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "Ignored a stale Paperclip completion interaction wake.",
        sessionParams: serializeSession(session!),
        sessionDisplayId: session!.julesSessionId ?? null,
        clearSession: false,
      };
    }

    try {
      await deleteStoredSession(taskId, config.source, config.baseBranch);
      if (interactionStatus === "accepted") {
        await moveIssueToDone(
          taskId,
          session!.julesSessionId!,
          ctx.authToken,
          ctx.runId,
          `Confirmed Jules session ${session!.julesSessionId} completed without a PR; marked the Paperclip issue done.`,
        );
        return completionInteractionResult(
          session!,
          "done",
          `Confirmed Jules session ${session!.julesSessionId} completed without a PR; marked the Paperclip issue done.`,
          true,
        );
      }
      await moveIssueToBlocked(taskId, ctx.authToken, ctx.runId);
      return completionInteractionResult(
        session!,
        "blocked",
        `Rejected completion of Jules session ${session!.julesSessionId}; the Paperclip issue remains blocked for manual follow-up.`,
        true,
      );
    } catch (error) {
      return paperclipInteractionFailure(session!, error);
    }
  }

  // Paperclip normally supplies the resolved interaction in the wake context.  Do
  // not depend on that being present, though: some wake paths only preserve the
  // generic issue context.  The persisted card is the authority in that case.
  let storedPendingInteraction: PaperclipInteraction | null = null;
  if (pendingProviderInteraction) {
    try {
      storedPendingInteraction = await getPaperclipInteraction(
        taskId,
        pendingProviderInteraction.paperclipInteractionId!,
        ctx.authToken,
        ctx.runId,
      );
    } catch (error) {
      if (ctx.onLog) {
        await ctx.onLog("stderr", `[jules] Could not read the pending Paperclip interaction: ${sanitizeError(error)}\n`);
      }
    }
  }

  // Fallback: If not found or still pending, check all interactions on the issue for an answered feedback card
  if (!storedPendingInteraction && pendingProviderInteraction) {
    try {
      const allInteractions = await listPaperclipInteractions(taskId, ctx.authToken, ctx.runId);
      const answeredFeedback = allInteractions.find(
        (i: PaperclipInteraction) => i.kind === "ask_user_questions" && i.status === "answered" && Boolean(feedbackAnswer(i.result))
      );
      if (answeredFeedback) {
        storedPendingInteraction = answeredFeedback;
      }
    } catch {}
  }
  const providerInteractionId = interactionId ??
    (storedPendingInteraction?.status !== "pending" ? pendingProviderInteraction?.paperclipInteractionId : null);
  const providerInteractionKind = interactionKind ?? storedPendingInteraction?.kind ?? null;
  const providerInteractionStatus = interactionStatus ?? storedPendingInteraction?.status ?? null;
  const isProviderResolution = providerInteractionStatus === "answered" ||
    (providerInteractionKind === "request_confirmation" &&
      (providerInteractionStatus === "accepted" || providerInteractionStatus === "rejected"));

  if (pendingProviderInteraction && (storedPendingInteraction?.status === "superseded" || storedPendingInteraction?.status === "cancelled")) {
    session!.pendingInteraction = undefined;
    await persistSessionBestEffort(session!, ctx.onLog);
  }

  if (pendingProviderInteraction && isProviderResolution) {
    if (providerInteractionId !== pendingProviderInteraction.paperclipInteractionId && storedPendingInteraction?.status !== "answered") {
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "Ignored a stale Paperclip provider interaction wake.",
        sessionParams: serializeSession(session!),
        sessionDisplayId: session!.julesSessionId ?? null,
        clearSession: false,
      };
    }
    try {
      if (pendingProviderInteraction.type === "user_feedback") {
        if (providerInteractionStatus !== "answered") {
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            sessionParams: serializeSession(session!),
            sessionDisplayId: session!.julesSessionId ?? null,
            summary: "Jules feedback request awaits human response in Paperclip.",
            resultJson: { provider: "jules", issueStatus: "in_progress" },
            clearSession: false,
          };
        }
        const answer = storedPendingInteraction ? feedbackAnswer(storedPendingInteraction.result) : null;
        if (!answer) {
          const nextAttempt = (session!.feedbackInteractionAttempt ?? 0) + 1;
          const replacement = await createJulesFeedbackInteraction(
            taskId,
            session!.julesSessionId!,
            pendingProviderInteraction.julesActivityId,
            pendingProviderInteraction.question,
            ctx.authToken,
            nextAttempt,
            ctx.runId,
          );
          session!.feedbackInteractionAttempt = nextAttempt;
          session!.pendingInteraction = {
            ...pendingProviderInteraction,
            paperclipInteractionId: replacement.id,
            createdAt: new Date().toISOString(),
          };
          await persistSessionBestEffort(session!, ctx.onLog);
          await moveIssueToBlocked(taskId, ctx.authToken, ctx.runId);
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            sessionParams: serializeSession(session!),
            sessionDisplayId: session!.julesSessionId ?? null,
            summary: "Jules did not receive an empty reply; Paperclip opened a new reply card.",
            resultJson: { provider: "jules", issueStatus: "blocked", interactionId: replacement.id },
            clearSession: false,
          };
        }
        // Relay gate: only forward to Jules when the operator intends it.
        // Board-level replies (cleanup, status notes) are dismissed without
        // reaching the session. Default: relay (Jules feedback cards).
        if (session!.relayNextAnswerToJules !== false) {
          await client.sendMessage(session!.julesSessionId!, { prompt: answer });
        } else {
          session!.relayNextAnswerToJules = undefined;
        }
      } else {
        const resolvedRevisionId = interactionPlanRevisionId(storedPendingInteraction);
        if (!pendingProviderInteraction.planRevisionId || resolvedRevisionId !== pendingProviderInteraction.planRevisionId) {
          return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorCode: "paperclip_plan_revision_mismatch",
            errorMessage: "Resolved Paperclip confirmation does not target the pending Jules plan revision",
            sessionParams: serializeSession(session!),
            sessionDisplayId: session!.julesSessionId ?? null,
            clearSession: false,
          };
        }
        if (providerInteractionStatus === "rejected") {
          const reason = storedPendingInteraction ? rejectionReason(storedPendingInteraction.result) : null;
          // A rejection is actionable provider feedback, not a terminal dead
          // end. Jules uses sendMessage to regenerate the plan; retain the
          // issue's blocked disposition until it publishes the replacement.
          await client.sendMessage(
            session!.julesSessionId!,
            { prompt: `The Paperclip plan review rejected the current plan.${reason ? ` Feedback: ${reason}` : " Please regenerate the plan with the requested changes."}` },
          );
          session!.pendingInteraction = undefined;
          session!.phase = "RUNNING";
          await persistSessionBestEffort(session!, ctx.onLog);
          await moveIssueToBlocked(taskId, ctx.authToken, ctx.runId);
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            sessionParams: serializeSession(session!),
            sessionDisplayId: session!.julesSessionId ?? null,
            summary: "Jules received the plan rejection feedback and will regenerate its plan asynchronously.",
            resultJson: { provider: "jules", issueStatus: "blocked" },
            clearSession: false,
          };
        }
        if (providerInteractionStatus !== "accepted") {
          return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorCode: "paperclip_plan_approval_missing",
            errorMessage: "The Jules plan approval interaction was not accepted",
            sessionParams: serializeSession(session!),
            sessionDisplayId: session!.julesSessionId ?? null,
            clearSession: false,
          };
        }
        // Idempotent resume: if the relay already succeeded in a previous run
        // (planApprovedAt set), do NOT call approvePlan again - Jules rejects
        // double-approval and the run would fail-loop (MAZ-37 incident).
        if (!session!.planApprovedAt) {
          await client.approvePlan(session!.julesSessionId!);
          session!.planApprovedAt = new Date().toISOString();
        }
      }
      session!.pendingInteraction = undefined;
      session!.phase = "RUNNING";
      await persistSessionBestEffort(session!, ctx.onLog);
      return createPendingResult(session!, true);
    } catch (error) {
      return paperclipInteractionFailure(session!, error);
    }
  }

  let createdSessionThisRun = false;
  if (!session || session.phase === 'RETRY_SCHEDULED') {
    const isRetry = session?.phase === 'RETRY_SCHEDULED';
    const failedSessions = session?.failedSessions || [];
    const attempt = (isRetry && session) ? (session.attempt + 1) : 1;

    // RETRY PREFERENCE: resume the existing Jules session via chat for up to
    // MAX_SESSION_RESUME_ATTEMPTS consecutive executions. Each resume preserves full
    // context. Only after exhausting resume attempts do we fall through to
    // new-session creation below, which naturally starts from the branch tip.
    //


    // SKIP RESUME if the session already produced a PR: sending a chat message
    // to a completed session starts a redundant cycle (observed live on MAZ-105).
    const alreadyDeliveredPr = Boolean(session?.currentPrUrl);
    if (alreadyDeliveredPr && isRetry) {
      await ctx.onLog?.('stdout', `[jules] Session already delivered PR ${session!.currentPrUrl} - skipping resume.\n`);
    } else if (isRetry && session!.julesSessionId) {
      // Check if remote Jules session is still alive before creating a new one
      try {
        const remoteSession = await client.getSession(session!.julesSessionId);
        if (isLiveJulesRemoteState(remoteSession.state)) {
          await ctx.onLog?.('stdout', `[jules] Remote session ${session!.julesSessionId} is active (${remoteSession.state}) - continuing polling.\n`);
          session!.phase = 'RUNNING';
          await persistSessionBestEffort(session!, ctx.onLog);
          return createPendingResult(session!, true);
        }
      } catch (err) {
        await ctx.onLog?.('stderr', `[jules] Could not query remote session status: ${sanitizeError(err)}\n`);
      }

      if (attempt <= MAX_SESSION_RESUME_ATTEMPTS) {
        await ctx.onLog?.('stdout', `[jules] Retrying by resuming session ${session!.julesSessionId} (attempt ${attempt}/${MAX_SESSION_RESUME_ATTEMPTS})\n`);
        try {
          await client.sendMessage(
              session!.julesSessionId as Parameters<typeof client.sendMessage>[0],
              { prompt: "Your previous run hit an error. Please retry the task from where you left off." },
          );
        } catch { /* ignore chat send error on retry */ }
        session!.phase = 'RUNNING';
        session!.pendingInteraction = undefined;
        try {
          await moveIssueToInProgress(taskId, ctx.authToken,
            `Jules session resumed for retry (attempt ${attempt}).`, ctx.runId);
        } catch { /* board unavailable */ }
        await persistSessionBestEffort(session!, ctx.onLog);
        return createPendingResult(session!, true);
      }
      await ctx.onLog?.('stderr', `[jules] Session resume budget exhausted (${MAX_SESSION_RESUME_ATTEMPTS} attempts) - creating fresh session as continuation.\n`);
    }

    let failedSessionId, failedSessionMessage;
    if (isRetry && failedSessions.length > 0) {
       const lastFailed = failedSessions[failedSessions.length - 1];
       if (lastFailed) {
         failedSessionId = lastFailed.sessionId;
         failedSessionMessage = lastFailed.message;
       }
    }

    const promptContext = {
      issueId: taskId,
      runId: ctx.runId,
      title: taskTitle,
      description: taskDescription,
      isRetry,
      resumeAttempt: isRetry ? attempt : 0,
      failedSessionUrl: failedSessionId ? `Session ID: ${failedSessionId}` : undefined,
      failedSessionMessage,
      priorPrUrls: (session?.failedSessions ?? [])
          .map((fs) => fs.prUrl)
          .filter((url): url is string => Boolean(url)),
    };

    const prompt = buildPrompt(promptContext, config);
    const pHash = hashPromptIdentity(promptContext, config);

    if (session?.julesSessionId) {
      try {
        const remote = await client.getSession(session.julesSessionId);
        if (isLiveJulesRemoteState(remote.state)) {
          await ctx.onLog?.("stdout", `[jules] Reattaching live remote session ${session.julesSessionId} (${remote.state}); skipping createSession.\n`);
          session.phase = "RUNNING";
          session.julesState = remote.state;
          await persistSessionBestEffort(session, ctx.onLog);
          return createPendingResult(session, true);
        }
      } catch (err) {
        await ctx.onLog?.("stderr", `[jules] Remote session probe before create failed: ${sanitizeError(err)}\n`);
      }
    }

    try {
      const julesSession = await client.createSession({
          prompt,
          title: taskTitle,
          sourceContext: {
              source: config.source,
              githubRepoContext: {
                  startingBranch: config.baseBranch
              }
          },
          requirePlanApproval: config.requirePlanApproval,
          automationMode: config.automationMode
      });

      session = {
        version: 1,
        paperclipIssueId: taskId,
        promptHash: pHash,
        promptHashVersion: PROMPT_IDENTITY_HASH_VERSION,
        repository: config.repository,
        source: config.source,
        baseBranch: config.baseBranch,
        phase: 'RUNNING',
        sessionId: julesSession.id,
        julesSessionId: julesSession.id,
        julesSessionUrl: julesSession.url,
        attempt,
        failedSessions,
        createdAt: new Date().toISOString()
      };
      createdSessionThisRun = true;
      await persistSessionBestEffort(session, ctx.onLog);

    } catch (error) {
      const classification = classifyFailure(error);
      const willRetry = shouldRetry(classification, attempt, config);

      if (willRetry) {
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorCode: "jules_transient_failure",
          errorFamily: toErrorFamily(classification),
          errorMessage: sanitizeError(error),
          retryNotBefore: new Date(getRetryNotBefore(attempt, {
            retryAfterMs: error instanceof JulesClientError ? error.retryAfterMs : null,
          })).toISOString(),
          sessionParams: serializeSession({
            version: 1,
            paperclipIssueId: taskId,
            promptHash: pHash,
            promptHashVersion: PROMPT_IDENTITY_HASH_VERSION,
            repository: config.repository,
            source: config.source,
            baseBranch: config.baseBranch,
            phase: 'RETRY_SCHEDULED',
            attempt,
            failedSessions: [
              ...failedSessions,
              { failedAt: new Date().toISOString(), message: sanitizeError(error), classification,
                ...(session?.currentPrUrl ? { prUrl: session.currentPrUrl } : {}) },
            ],
            createdAt: new Date().toISOString()
          }),
          clearSession: false
        };
      }

      return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorCode: "jules_create_failure",
          errorFamily: toErrorFamily(classification),
          errorMessage: sanitizeError(error),
          clearSession: false
      };
    }
  }

  if (!session) throw new Error("Session is null after initialization");

  const yieldHeartbeat = async (
    current: JulesAdapterSessionV1,
    initialActivityCheck = false,
  ): Promise<AdapterExecutionResult> => {
    await persistSessionBestEffort(current, ctx.onLog, { authToken: ctx.authToken, runId: ctx.runId });
    return createPendingResult(current, initialActivityCheck, reattachDelayMs);
  };

  // Persist the provider identity before waiting on Jules. If Paperclip or the
  // adapter process restarts during a long Jules job, the next run can resume
  // this exact remote session instead of creating another one.
  if (createdSessionThisRun) {
    if (ctx.onLog) {
      await ctx.onLog("stdout", `[jules] Created session ${session.julesSessionId}; checkpointing before yielding the heartbeat.\n`);
    }
    if (session.julesSessionUrl) {
      try { await postSessionLink(taskId, session.julesSessionUrl, ctx.authToken, ctx.runId); }
      catch { /* board unavailable */ }
    }
    return await yieldHeartbeat(session, true);
  }

  const currentPromptContext = {
    issueId: taskId,
    runId: ctx.runId,
    title: taskTitle,
    description: taskDescription,
    isRetry: false
  };
  const currentHash = hashPromptIdentity(currentPromptContext, config);
  if (session.promptHashVersion !== PROMPT_IDENTITY_HASH_VERSION) {
    session.promptHash = currentHash;
    session.promptHashVersion = PROMPT_IDENTITY_HASH_VERSION;
    await persistSessionBestEffort(session, ctx.onLog);
  } else if (session.promptHash !== currentHash && session.attempt === 1) {
    if (ctx.onLog) {
        await ctx.onLog('stderr', `[WARN] Task identity changed. Using original prompt hash for session ${session.julesSessionId}`);
    }
  }

  while (!abortSignal.aborted) {
    if (!session.julesSessionId) throw new Error("Missing julesSessionId during polling loop");

    try {
      const julesSession = await client.getSession(session.julesSessionId);
      const state = julesSession.state || 'UNKNOWN';
      session.julesState = state;
      if (ctx.onLog) {
        const timeStr = new Date().toLocaleTimeString();
        const thoughtEvent = JSON.stringify({
          type: "thought",
          data: `Jules session ${session.julesSessionId} is ${state} in cloud sandbox (polled at ${timeStr})`,
        });
        await ctx.onLog("stdout", `${thoughtEvent}\n[jules][${timeStr}] Polled session status: ${state}\n`);
      }
      if (julesSession.url) {
          session.julesSessionUrl = julesSession.url;
      }
      let prUrl = extractPullRequestUrl(julesSession);
      if (prUrl) {
          if (session.currentPrUrl !== prUrl || !session.prRegisteredOnBoard) {
            session.currentPrUrl = prUrl;
            if (ctx.onLog) {
              await ctx.onLog("stdout", `[jules] Discovered pull request created by Jules: ${prUrl}\n`);
            }
            try {
              await registerPullRequestWorkProduct(taskId, prUrl, ctx.authToken, ctx.runId);
              session.prRegisteredOnBoard = true;
            } catch {
              /* best-effort early registration of work product */
            }
          }

          await persistSessionBestEffort(session, ctx.onLog);
          const prDetails = await getPullRequestDetails(prUrl);
          const changedFiles = await listPullRequestChangedFiles(prUrl).catch(() => [] as string[]);
          const rawDiff = await getPullRequestPatch(prUrl).catch(() => "");
          const hostContract = buildHostImplementationPlan(taskDescription ?? "", taskId, workspaceCwd ?? undefined);
          const scope = evaluateScopeConformity({
            declaredTargetFiles: hostContract.plan.targetFiles,
            declaredTargetSymbols: hostContract.plan.targetSymbols.map((s) => s.symbol),
            modifiedFiles: changedFiles,
            rawDiff,
          });
          const lifecycle = evaluateJulesLifecycleState(session, {
            julesState: state,
            prUrl,
            prDetails: {
              isMerged: prDetails.merged,
              ...(prDetails.mergeableStatus ? { mergeableStatus: prDetails.mergeableStatus } : {}),
            },
            ciStatus: prDetails.ciStatus === "unknown" ? "pending" : prDetails.ciStatus,
            scopeConformant: changedFiles.length === 0 ? true : scope.isConformant,
            scopeSummary: scope.summaryText,
          });

          if (lifecycle.phase === "COMPLETED_AND_MERGED") {
            if (ctx.onLog) {
              await ctx.onLog("stdout", `[jules] Pull request ${prUrl} is merged on GitHub. Completing session.\n`);
            }
            await deleteStoredSession(taskId, config.source, config.baseBranch);
            return {
              exitCode: 0,
              signal: null,
              timedOut: false,
              sessionParams: serializeSession(session),
              sessionDisplayId: session.julesSessionId || null,
              summary: `Jules PR ${prUrl} is merged on GitHub. Session completed and recovery state cleared.`,
              resultJson: { provider: "jules", julesSessionId: session.julesSessionId, prUrl, issueStatus: "done", merged: true },
              clearSession: true
            };
          }

          if (lifecycle.issueTransition?.comment?.includes("merge conflicts") || prDetails.mergeableStatus === "conflicting") {
            if (ctx.onLog) {
              await ctx.onLog(
                "stderr",
                `[jules] Pull request ${prUrl} has Git merge conflicts. Jules will not start a new session; the host must rebase locally.\n`,
              );
            }
            session.phase = "RUNNING";
            await persistSessionBestEffort(session, ctx.onLog);
            return {
              exitCode: 0,
              signal: null,
              timedOut: false,
              retryNotBefore: new Date(Date.now() + reattachDelayMs).toISOString(),
              sessionParams: serializeSession(session),
              sessionDisplayId: session.julesSessionId ?? null,
              summary: `Pull request ${prUrl} has merge conflicts. Jules session ${session.julesSessionId} is paused for local rebase; no new Jules session will be created.`,
              resultJson: {
                provider: "jules",
                julesSessionId: session.julesSessionId,
                prUrl,
                mergeableStatus: "conflicting",
                issueStatus: "in_progress",
              },
              clearSession: false,
            };
          }

          const drift = lifecycle.actions.find((action) => action.type === "FLAG_SCOPE_DRIFT");
          if (drift && drift.type === "FLAG_SCOPE_DRIFT") {
            if (ctx.onLog) {
              await ctx.onLog("stderr", `[jules] ${drift.summary}\n`);
            }
            try {
              await client.sendMessage(session.julesSessionId, {
                prompt: `The PR drifted from the host plan contract:\n${drift.summary}\nStay inside the declared files and symbols. Do not start a new Jules session.`,
              });
            } catch {
              /* Jules may reject chat on a completed session; still yield */
            }
            session.phase = "RUNNING";
            await persistSessionBestEffort(session, ctx.onLog);
            return {
              exitCode: 0,
              signal: null,
              timedOut: false,
              retryNotBefore: new Date(Date.now() + reattachDelayMs).toISOString(),
              sessionParams: serializeSession(session),
              sessionDisplayId: session.julesSessionId ?? null,
              summary: `Jules PR ${prUrl} drifted from the host plan. Session ${session.julesSessionId} stays attached for a scoped fix.`,
              resultJson: {
                provider: "jules",
                julesSessionId: session.julesSessionId,
                prUrl,
                scopeConformant: false,
                issueStatus: "in_progress",
              },
              clearSession: false,
            };
          }
      }

      // Mirroring must never prevent terminal detection: a mirror failure used to
      // abort this run before the COMPLETED/FAILED branches could fire, leaving
      // the Paperclip issue blocked forever (MAZ-102 incident, issue #4/#5 class).
      let activities: JulesActivity[] = [];
      try {
        activities = await mirrorNewActivities(client, session, taskId, ctx.authToken, ctx.runId, ctx.onLog);
      } catch (mirrorError) {
        await ctx.onLog?.(
          'stderr',
          `[jules] activity mirroring failed (terminal detection continues): ${String(mirrorError)}\n`,
        );
      }

      // Watchdog stall evaluation
      const lastAct = activities.length > 0 && activities[activities.length - 1]
        ? activities[activities.length - 1]
        : null;
      const latestActivityTime = lastAct?.createTime || session.createdAt;
      const watchdogEval = evaluateSessionWatchdog(session, latestActivityTime);
      session.lastPolledAt = new Date().toISOString();
      if (watchdogEval.shouldNudge && watchdogEval.nudgeMessage) {
        if (ctx.onLog) {
          await ctx.onLog("stdout", "[jules] Watchdog auto-nudge: " + watchdogEval.reason + "\n");
        }
        try {
          await client.sendMessage(session.julesSessionId!, { prompt: watchdogEval.nudgeMessage });
          session.lastWatchdogNudgeAt = new Date().toISOString();
          session.watchdogNudgeCount = watchdogEval.nudgeCount;
          await persistSessionBestEffort(session, ctx.onLog);
        } catch (nudgeErr) {
          if (ctx.onLog) {
            await ctx.onLog("stderr", "[jules] Watchdog nudge failed: " + sanitizeError(nudgeErr) + "\n");
          }
        }
      }

      const stateMachineRes = handleJulesState(state, !!session.currentPrUrl);
      // Recover from stale blocked status: if Jules is actively working but the
      // board still shows a previous failure's blocked status, flip back to
      // in_progress so dashboards reflect reality.
      // Unconditional: whenever Jules is actively coding, ensure the board
      // reflects it. Covers blocked→in_progress after retry-resume, and is a
      // no-op when already in_progress (Paperclip handles idempotent PATCHes).
      // Only flip status if recovering from a non-in_progress state (e.g. was blocked)
      // Otherwise do not call PATCH /api/issues to avoid triggering spurious status events
      if (state === 'IN_PROGRESS' && session.phase !== 'RUNNING') {
        try { await moveIssueToInProgress(taskId, ctx.authToken, undefined, ctx.runId); }
        catch { /* board unavailable; session continues regardless */ }
      }
      session.phase = stateMachineRes.nextPhase;

      const unapprovedPlan = latestPlan(activities);
      const isPlanningTurnCompleted = Boolean(
        unapprovedPlan &&
        config.requirePlanApproval &&
        !session.planApprovedAt
      );

      if (isPlanningTurnCompleted) {
        session.phase = "WAITING_FOR_PLAN_APPROVAL";
      } else if (stateMachineRes.isTerminal) {
         if (session.phase === 'COMPLETED') {
             if (!stateMachineRes.isSuccess) {
                 try {
                   let completion = session.pendingInteraction?.type === "completion_confirmation"
                     ? session.pendingInteraction
                     : null;
                   if (!completion) {
                     const question = `Jules session ${session.julesSessionId} completed without creating a PR. Is this task complete?`;
                     const interaction = await createNoPrCompletionInteraction(
                       taskId,
                       session.julesSessionId!,
                       session.julesSessionUrl,
                       ctx.authToken,
                       ctx.runId,
                     );
                     completion = {
                       type: "completion_confirmation",
                       paperclipInteractionId: interaction.id,
                       question,
                       createdAt: new Date().toISOString(),
                     };
                     session.pendingInteraction = completion;
                     await persistSessionBestEffort(session, ctx.onLog);

                     if (interaction.status === "accepted") {
                       await deleteStoredSession(taskId, config.source, config.baseBranch);
                       await moveIssueToDone(taskId, session.julesSessionId!, ctx.authToken, ctx.runId);
                       return completionInteractionResult(
                         session,
                         "done",
                         `Confirmed Jules session ${session.julesSessionId} completed without a PR; marked the Paperclip issue done.`,
                         true,
                       );
                     }
                     if (interaction.status === "rejected") {
                       await deleteStoredSession(taskId, config.source, config.baseBranch);
                       await moveIssueToBlocked(taskId, ctx.authToken, ctx.runId);
                       return completionInteractionResult(
                         session,
                         "blocked",
                         `Rejected completion of Jules session ${session.julesSessionId}; the Paperclip issue remains blocked for manual follow-up.`,
                         true,
                       );
                     }
                   }

                   await moveIssueToBlocked(taskId, ctx.authToken, ctx.runId);
                   return completionInteractionResult(
                     session,
                     "blocked",
                     `Jules session ${session.julesSessionId} completed without a PR and awaits confirmation in Paperclip.`,
                     false,
                   );
                 } catch (error) {
                   return paperclipInteractionFailure(session, error);
                 }
             }

             if (session.currentPrUrl) {
               const skipCi =
                 (ctx.agent.adapterConfig as Record<string, unknown> | undefined)?.["ciPolicy"] === "skip" ||
                 (ctx.config as Record<string, unknown> | undefined)?.["ciPolicy"] === "skip";
               const ciStatus = skipCi ? "success" : await getPullRequestCiStatus(session.currentPrUrl);
               if (ciStatus === "pending") {
                 if (ctx.onLog) {
                   await ctx.onLog(
                     "stdout",
                     `[jules] Pull request ${session.currentPrUrl} is awaiting CI build checks to pass before moving to review...\n`,
                   );
                 }
                 session.phase = "RUNNING";
                 return await yieldHeartbeat(session);
               }
               if (ciStatus === "failed") {
                 if (ctx.onLog) {
                   await ctx.onLog(
                     "stderr",
                     `[jules] Pull request ${session.currentPrUrl} CI build checks failed.\n`,
                   );
                 }
               }
             }
             await moveIssueToReview(taskId, session.currentPrUrl!, ctx.authToken, ctx.runId);
              await persistSessionBestEffort(session, ctx.onLog);
             if (ctx.onLog) {
                 await ctx.onLog(
                     "stdout",
                      `[jules] Session ${session.julesSessionId} created PR ${session.currentPrUrl}. Session preserved for code review feedback loop.\n`,
                 );
             }
             return {
                 exitCode: 0,
                 signal: null,
                 timedOut: false,
                 sessionParams: serializeSession(session),
                 sessionDisplayId: session.julesSessionId || null,
                 summary: `Jules session ${session.julesSessionId} completed, created a PR, and moved the Paperclip issue to review: ${session.currentPrUrl}`,
                 resultJson: { provider: "jules", julesSessionId: session.julesSessionId, prUrl: session.currentPrUrl, issueStatus: "in_review" },
                  clearSession: false
             };
         } else if (session.phase === 'FAILED') {
             const failureDetails = julesSession.errorInfo || {};
             const classification = classifyFailure(failureDetails);
             const willRetry = shouldRetry(classification, session.attempt, config);

             if (willRetry) {
                 session.failedSessions.push({
                     sessionId: session.julesSessionId,
                     failedAt: new Date().toISOString(),
                     message: sanitizeError(summarizeJulesFailure(failureDetails)),
                     classification,
                     ...(session.currentPrUrl ? { prUrl: session.currentPrUrl } : {})
                 });
                 session.phase = 'RETRY_SCHEDULED';
                 return {
                     exitCode: 1,
                     signal: null,
                     timedOut: false,
                     errorCode: "jules_transient_failure",
                     errorFamily: toErrorFamily(classification),
                     errorMessage: sanitizeError(summarizeJulesFailure(failureDetails)),
                     retryNotBefore: new Date(getRetryNotBefore(session.attempt)).toISOString(),
                     sessionParams: serializeSession(session),
                     clearSession: false
                 };
             } else {
                 return {
                     exitCode: 1,
                     signal: null,
                     timedOut: false,
                     errorCode: "jules_task_failure",
                     errorFamily: toErrorFamily(classification),
                     errorMessage: sanitizeError(`Jules session failed and exhausted retries: ${summarizeJulesFailure(failureDetails)}`),
                     sessionParams: serializeSession(session),
                     clearSession: false
                 };
             }
         }
      }

      if (stateMachineRes.requiresReturn || isPlanningTurnCompleted) {
        try {
          const existingInteractions = await listPaperclipInteractions(taskId, ctx.authToken, ctx.runId).catch(() => []);
          let rawQuestionText: string | undefined;
          if (session.phase === "WAITING_FOR_FEEDBACK") {
            let activity = latestAgentMessage(activities);
            if (!activity) {
              const allActivities = await listAllActivities(client, session.julesSessionId!);
              activity = latestAgentMessage(allActivities);
            }
            rawQuestionText = extractQuestionText(activity);
          } else if (session.phase === "WAITING_FOR_PLAN_APPROVAL") {
            const activity = latestPlan(activities);
            rawQuestionText = planMarkdown(activity);
          }

          const action = evaluateInteractionAction(session, state, existingInteractions, rawQuestionText);

          switch (action.type) {
            case "RELAY_FEEDBACK": {
              if (ctx.onLog) {
                await ctx.onLog("stdout", `[jules] Sending answered feedback to Jules: ${action.answer}\n`);
              }
              await client.sendMessage(session.julesSessionId!, { prompt: action.answer });
              session = recordFeedbackRelayed(session, action.interactionId);
              return await yieldHeartbeat(session);
            }

            case "RELAY_PLAN_APPROVAL": {
              if (ctx.onLog) {
                await ctx.onLog("stdout", `[jules] Sending plan approval to Jules for revision: ${action.planRevisionId}\n`);
              }
              await client.approvePlan(session.julesSessionId!);
              session = recordPlanApprovalRelayed(session);
              return await yieldHeartbeat(session);
            }

            case "CREATE_FEEDBACK_CARD": {
              let activity = latestAgentMessage(activities);
              if (!activity) {
                const allActivities = await listAllActivities(client, session.julesSessionId!);
                activity = latestAgentMessage(allActivities);
              }
              const activityId = activity?.id ?? "awaiting-user-feedback";
              const interaction = await createJulesFeedbackInteraction(
                taskId, session.julesSessionId!, activityId, action.question, ctx.authToken, action.attempt, ctx.runId,
              );
              session.feedbackInteractionAttempt = action.attempt;
              session.pendingInteraction = {
                type: "user_feedback",
                julesActivityId: asJulesActivityId(activityId),
                paperclipInteractionId: interaction.id,
                question: action.question,
                createdAt: new Date().toISOString(),
              };
              await persistSessionBestEffort(session, ctx.onLog);
              return {
                exitCode: 0,
                signal: null,
                timedOut: false,
                sessionParams: serializeSession(session),
                sessionDisplayId: session.julesSessionId ?? null,
                summary: `Jules session ${session.julesSessionId} awaits feedback in Paperclip.`,
                resultJson: { provider: "jules", issueStatus: "in_progress", interactionId: interaction.id },
                clearSession: false,
              };
            }

            case "CREATE_PLAN_CARD": {
              const activity = latestPlan(activities);
              const activityId = activity?.id ?? "awaiting-plan-approval";
              const { plan: hostPlan, markdown: hostPlanMarkdown } = buildHostImplementationPlan(
                taskDescription ?? "",
                taskId,
                workspaceCwd ?? undefined,
              );
              const fullPlan = composePlanForReview(action.planMarkdown, hostPlanMarkdown);
              const planReview = await evaluatePlanClarity(fullPlan, {
                title: taskTitle,
                description: taskDescription,
                targetFiles: hostPlan.targetFiles,
                targetSymbols: hostPlan.targetSymbols.map((s) => s.symbol),
                testFiles: hostPlan.testFiles,
                hostPlanMarkdown,
                cheapReviewer: createCheapReviewer() ?? defaultCheapReviewer,
                terraCodexReviewer: createTerraCodexReviewer(),
              });
              if (planReview.action === "AUTO_APPROVE" && planReview.stage === "terra_codex" && config.planApprovalPolicy !== "required") {
                if (ctx.onLog) {
                  await ctx.onLog("stdout", `[jules] Terra/Codex approved the plan (planApprovalPolicy=${config.planApprovalPolicy}).\n`);
                }
                await client.approvePlan(session.julesSessionId!);
                session.planApprovedAt = new Date().toISOString();
                session = recordPlanApprovalRelayed(session);
                return await yieldHeartbeat(session);
              }

              const interaction = await createJulesPlanApprovalInteraction(
                taskId, session.julesSessionId!, activityId, action.planMarkdown, ctx.authToken, ctx.runId,
              );
              session.pendingInteraction = {
                type: "plan_approval",
                julesActivityId: asJulesActivityId(activityId),
                paperclipInteractionId: interaction.id,
                question: action.planMarkdown,
                planDocumentId: interaction.planRevision.documentId,
                planRevisionId: interaction.planRevision.revisionId,
                planRevisionNumber: interaction.planRevision.revisionNumber,
                createdAt: new Date().toISOString(),
              };
              await persistSessionBestEffort(session, ctx.onLog);
              return {
                exitCode: 0,
                signal: null,
                timedOut: false,
                sessionParams: serializeSession(session),
                sessionDisplayId: session.julesSessionId ?? null,
                summary: `Jules session ${session.julesSessionId} plan ${planReview.stage} review awaits plan approval from operator (last resort).`,
                resultJson: { provider: "jules", interactionId: interaction.id },
                clearSession: false,
              };
            }

            case "WAIT_FOR_HUMAN": {
              if (action.interactionId && !session.pendingInteraction) {
                session.pendingInteraction = {
                  type: "user_feedback",
                  julesActivityId: asJulesActivityId("awaiting-user-feedback"),
                  paperclipInteractionId: action.interactionId,
                  question: action.summary,
                  createdAt: new Date().toISOString(),
                };
                await persistSessionBestEffort(session, ctx.onLog);
              }
              return {
                exitCode: 0,
                signal: null,
                timedOut: false,
                sessionParams: serializeSession(session),
                sessionDisplayId: session.julesSessionId ?? null,
                summary: action.summary,
                resultJson: { provider: "jules", issueStatus: "in_progress", interactionId: action.interactionId },
                clearSession: false,
              };
            }

            case "RESET_PAUSED_SESSION": {
              if (ctx.onLog) {
                await ctx.onLog(
                  "stdout",
                  `[jules] Session ${action.sessionId} was paused/archived by operator. Creating fresh Jules session immediately.\n`,
                );
              }
              try {
                await addJulesActivityComment(
                  taskId,
                  "session-paused-reset",
                  `ℹ️ Previous Jules session \`${action.sessionId}\` was paused/archived by the operator. Launching fresh session for this issue.`,
                  session.julesSessionUrl,
                  ctx.authToken,
                  ctx.runId,
                );
              } catch {}
              await deleteStoredSession(taskId, config.source, config.baseBranch).catch(() => {});

              const promptContext = {
                issueId: taskId,
                runId: ctx.runId,
                title: taskTitle,
                description: taskDescription,
                isRetry: false,
                resumeAttempt: 0,
                priorPrUrls: [],
              };
              const prompt = buildPrompt(promptContext, config);
              const pHash = hashPromptIdentity(promptContext, config);

              const newJulesSession = await client.createSession({
                prompt,
                title: taskTitle,
                sourceContext: {
                  source: config.source,
                  githubRepoContext: {
                    startingBranch: config.baseBranch,
                  },
                },
                requirePlanApproval: config.requirePlanApproval,
                automationMode: config.automationMode,
              });

              const freshSession: JulesAdapterSessionV1 = {
                version: 1,
                paperclipIssueId: taskId,
                promptHash: pHash,
                promptHashVersion: PROMPT_IDENTITY_HASH_VERSION,
                repository: config.repository,
                source: config.source,
                baseBranch: config.baseBranch,
                phase: "RUNNING",
                sessionId: newJulesSession.id,
                julesSessionId: newJulesSession.id,
                julesSessionUrl: newJulesSession.url,
                attempt: 1,
                failedSessions: [{
                  sessionId: action.sessionId,
                  failedAt: new Date().toISOString(),
                  message: "Archived by operator",
                  classification: "task",
                }],
                createdAt: new Date().toISOString(),
              };

              session = freshSession;
              await persistSessionBestEffort(freshSession, ctx.onLog);
              if (freshSession.julesSessionUrl) {
                try { await postSessionLink(taskId, freshSession.julesSessionUrl, ctx.authToken, ctx.runId); }
                catch {}
              }
              return createPendingResult(freshSession, true);
            }

            case "CONTINUE_POLLING":
              return await yieldHeartbeat(session);
          }
        } catch (error) {
          return paperclipInteractionFailure(session, error);
        }
      }

      return await yieldHeartbeat(session);

    } catch (error) {
      const classification = classifyFailure(error);

      if (classification === 'transient') {
         return await yieldHeartbeat(session);
      } else {
          return {
             exitCode: 1,
             signal: null,
             timedOut: false,
             errorCode: "jules_polling_error",
             errorFamily: toErrorFamily(classification),
             errorMessage: sanitizeError(error),
             sessionParams: serializeSession(session),
             sessionDisplayId: session.julesSessionId ?? null,
             clearSession: false
          };
      }
    }
  }

  return await yieldHeartbeat(session);
}
