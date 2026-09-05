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
import { JulesAdapterSessionV1, normalizeJulesState, sessionCodec, serializeSession } from "./session.js";
import { parsePlanReviewInteraction } from "./plan-review-protocol.js";
import { JulesActivity, JulesClient, JulesClientError, extractPullRequestUrl, ownerRepoFromJulesSource } from "./jules-client.js";
import { buildPrompt, hashPromptIdentity, PROMPT_IDENTITY_HASH_VERSION } from "./prompt-builder.js";
import { handleJulesState } from "./state-machine.js";
import { evaluateJulesLifecycleState } from "./state-engine.js";
import { evaluateScopeConformity } from "@pilleo/paperclip-adapter-common";
import { classifyFailure, toErrorFamily, summarizeJulesFailure } from "./failure-classifier.js";
import { shouldRetry, getRetryNotBefore } from "./retry-policy.js";
import { asJulesActivityId, asJulesSessionId, asPaperclipId } from "./brands.js";
import { CtxContextSchema, HostContextSchema } from "./context-schemas.js";
import { sanitizeError } from "./error-sanitizer.js";
import { beginMutation, markMutationFailed, markMutationSucceeded } from "./mutation-checkpoint.js";
import { deleteStoredSession, findStoredSessionByJulesSessionId, loadStoredSession, saveStoredSession } from "./session-store.js";
import {
  isAfterCheckpoint,
  laterCheckpoint,
  normalizeActivities,
} from "./activity-checkpoint.js";
import { evaluateJulesStartGate } from "./start-gate.js";
import {
  listIssueComments,
  createNoPrCompletionInteraction,
  addJulesActivityComment,
  createJulesFeedbackInteraction,
  createJulesAgentAdjudicationInteraction,
  createJulesQuestionReviewInteraction,
  answerJulesAgentAdjudicationInteraction,
  resolveJulesAgentAdjudicationInteraction,
  createJulesPlanApprovalInteraction,
  createJulesPlanReviewInteraction,
  saveJulesPlanDocument,
  getPaperclipInteraction,
  listPaperclipApprovals,
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
  createJulesQuestionAdjudication,
  findJulesQuestionAdjudication,
  withdrawPaperclipInteraction,
  getPaperclipIssue,
  normalizeInternalReviewIssue,
  completeInternalReviewIssue,
  activateInternalReviewIssue,
  isPaperclipChildLimitError,
  scheduleJulesSessionMonitor,
  clearJulesSessionMonitor,
  type PaperclipInteraction,
} from "./paperclip-client.js";
import { evaluateQuestionAdjudicationChild } from "./question-adjudication-state.js";
import { parseQuestionAdjudication } from "./question-adjudication.js";
import { classifyNativeQuestionReview } from "./question-workflow.js";
import { isNativeAgentAdjudication } from "./session.js";
import { createJulesPlanReviewChild } from "./plan-review-client.js";
import { parsePlanAdjudication } from "./plan-adjudication.js";
import { createTelemetry } from "./telemetry.js";
import { evaluateJulesIssueOwnership } from "./session-ownership.js";
import { evaluateIssueScopedRun } from "./issue-scoped-run.js";

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

async function runCheckpointedMutation<T>(input: {
  session: JulesAdapterSessionV1;
  key: string;
  operation: string;
  issueId: string;
  sessionId?: string;
  activityId?: string;
  persist: () => Promise<void>;
  run: () => Promise<T>;
}): Promise<T> {
  input.session.mutationCheckpoint = beginMutation(input);
  await input.persist();
  try {
    const result = await input.run();
    const responseId = result && typeof result === "object" && "id" in result && typeof result.id === "string"
      ? result.id
      : undefined;
    input.session.mutationCheckpoint = markMutationSucceeded(
      input.session.mutationCheckpoint,
      responseId ? { responseId } : {},
    );
    await input.persist();
    return result;
  } catch (error) {
    input.session.mutationCheckpoint = markMutationFailed(input.session.mutationCheckpoint, sanitizeError(error));
    await input.persist();
    throw error;
  }
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
      interactionId: session.pendingInteraction && "paperclipInteractionId" in session.pendingInteraction ? session.pendingInteraction.paperclipInteractionId : undefined,
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

function createPendingResult(
  session: JulesAdapterSessionV1,
  initialActivityCheck = false,
  reattachDelayMs?: number,
): AdapterExecutionResult {
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
      resultJson: {
        provider: "jules",
        julesSessionId: session.julesSessionId,
        julesState: session.julesState ?? session.phase,
        pending: true,
        planPending: session.phase === "WAITING_FOR_PLAN_APPROVAL" && !session.planApprovedAt,
        nextAction: `Continue polling Jules session ${session.julesSessionId || "after the next heartbeat"}.`,
      },
      clearSession: false,
    };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  // Paperclip's local runner exposes the authoritative heartbeat id through
  // PAPERCLIP_RUN_ID on some wake paths rather than ctx.runId. Normalize it
  // once so every governed write carries the cross-issue attribution header.
  const rawRuntime = (ctx.runtime ?? {}) as unknown as Record<string, unknown>;
  const rawContextForRun = (ctx.context ?? {}) as Record<string, unknown>;
  const recoveredRunId = [
    ctx.runId,
    process.env["PAPERCLIP_RUN_ID"],
    process.env["PAPERCLIP_HEARTBEAT_RUN_ID"],
    rawRuntime["runId"],
    rawContextForRun["runId"],
    rawContextForRun["heartbeatRunId"],
  ].find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? "";
  ctx = { ...ctx, runId: recoveredRunId };
  await ctx.onLog?.("stdout", `[jules] Paperclip heartbeat attribution: ${recoveredRunId ? "present" : "missing"}\n`);
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

  let extractedTask = ((): Record<string, unknown> | null => {
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
    const snapshot = rawCtx["contextSnapshot"] as Record<string, unknown> | undefined;
    const issueId = snapshot && (snapshot["issueId"] ?? snapshot["taskId"]);
    if (typeof issueId === "string" && issueId.trim()) return { id: issueId, title: "Resumed Jules session", description: "" };
    return null;
  })();

  if (!extractedTask && resumedSessionId) {
    const recovered = await findStoredSessionByJulesSessionId(resumedSessionId).catch(() => null);
    if (recovered) {
      extractedTask = {
        id: recovered.paperclipIssueId,
        title: "Resumed Jules session",
        description: "",
      };
    }
  }

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

  const resumedPaperclipIssueId = (() => {
    const value = sessionCodec.deserialize(ctx.runtime?.sessionParams);
    return typeof value?.["paperclipIssueId"] === "string" ? value["paperclipIssueId"] as string : null;
  })();
  const contextForParse: Record<string, unknown> = {
    ...rawCtx,
    task: extractedTask ?? { id: resumedPaperclipIssueId ?? `resumed:${resumedSessionId}`, title: "Resumed Jules session", description: "" },
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
  let config = validateConfig(ctx.agent.adapterConfig, {
    issueOverride,
    workspace: {
      ...(workspaceRepositoryUrl ? { repositoryUrl: workspaceRepositoryUrl } : {}),
      ...(workspaceDefaultBranch ? { defaultBranch: workspaceDefaultBranch } : {}),
      ...(workspaceCwd ? { cwd: workspaceCwd } : {}),
      ...(rawWorkspace["hasRemote"] === false ? { hasRemote: false } : {}),
    },
    warn: message => warnings.push(message),
  });
  // Paperclip may deliver adapter settings through the agent envelope even
  // when a legacy validator omits newly-added optional fields.
  const rawAdapterConfig = ctx.agent.adapterConfig as Record<string, unknown>;
  config = {
    ...config,
    planReviewerAgentId: config.planReviewerAgentId ?? (typeof rawAdapterConfig["planReviewerAgentId"] === "string" ? rawAdapterConfig["planReviewerAgentId"] : undefined),
    planStrongReviewerAgentId: config.planStrongReviewerAgentId ?? (typeof rawAdapterConfig["planStrongReviewerAgentId"] === "string" ? rawAdapterConfig["planStrongReviewerAgentId"] : undefined),
    questionReviewerAgentId: config.questionReviewerAgentId ?? (typeof rawAdapterConfig["questionReviewerAgentId"] === "string" ? rawAdapterConfig["questionReviewerAgentId"] : undefined),
    questionAdjudicatorAgentId: config.questionAdjudicatorAgentId ?? (typeof rawAdapterConfig["questionAdjudicatorAgentId"] === "string" ? rawAdapterConfig["questionAdjudicatorAgentId"] : undefined),
    codeReviewerAgentIds: config.codeReviewerAgentIds ?? (Array.isArray(rawAdapterConfig["codeReviewerAgentIds"])
      ? rawAdapterConfig["codeReviewerAgentIds"].filter((id): id is string => typeof id === "string")
      : undefined),
  };
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
  const client = new JulesClient(apiKey, telemetry, resolveJulesBaseUrl(ctx.agent.adapterConfig as Record<string, unknown>));
  const scheduleLiveSessionMonitor = async (
    current: JulesAdapterSessionV1,
    initialActivityCheck = false,
  ): Promise<void> => {
    // Human cards have their own wake continuation. Internal reviewer children
    // do not: Paperclip must keep waking the Jules owner so this adapter can
    // observe reviewer decisions and provider questions that arrive meanwhile.
    const humanWait = current.pendingInteraction?.type === "user_feedback" ||
      current.pendingInteraction?.type === "plan_approval" ||
      current.pendingInteraction?.type === "completion_confirmation";
    if (humanWait || !current.julesSessionId) return;
    const delayMs = initialActivityCheck ? JULES_INITIAL_ACTIVITY_CHECK_DELAY_MS : reattachDelayMs;
    const timeoutAt = new Date(
      new Date(current.createdAt).getTime() + config.sessionDeadlineMinutes * 60_000,
    ).toISOString();
    // The monitor is a durable convenience for waking the already-persisted
    // provider session.  It must never turn a healthy Jules run into a failed
    // one: the session identity is checkpointed first and can be reattached on
    // the next normal heartbeat if Paperclip is briefly unavailable.
    try {
      await scheduleJulesSessionMonitor(
        taskId,
        current.julesSessionId,
        new Date(Date.now() + delayMs).toISOString(),
        timeoutAt,
        ctx.authToken,
        ctx.runId,
      );
    } catch (error) {
      await ctx.onLog?.(
        "stderr",
        `[jules] Could not schedule the next Paperclip monitor; session ${current.julesSessionId} remains resumable: ${sanitizeError(error)}\n`,
      );
    }
  };
  // Unit tests intentionally provide an offline Jules client/fetch. Do not
  // perform the catalog probe in either Vitest's or Node's test environment;
  // otherwise a mocked COMPLETED session can block on a real network request.
  if (!process.env["VITEST"] && process.env["NODE_ENV"] !== "test") {
    try {
      const catalogSource = await client.resolveGithubSourceName(config.repository);
      if (catalogSource && catalogSource !== config.source) {
        if (ctx.onLog) {
          await ctx.onLog("stdout", `[jules] Jules catalog source for ${config.repository} is ${catalogSource}\n`);
        }
        config = { ...config, source: catalogSource };
      } else if (!catalogSource && ctx.onLog) {
        await ctx.onLog(
          "stderr",
          `[jules] ${config.repository} is not in the Jules source catalog yet (createSession would 404). Using ${config.source}.\n`,
        );
      }
    } catch (error) {
      if (ctx.onLog) {
        await ctx.onLog("stderr", `[jules] Jules source catalog lookup failed: ${sanitizeError(error)}\n`);
      }
    }
  }
  const taskTitle = parsedCtxContext.task.title;
  const taskDescription = parsedCtxContext.task.description;

  const startGateCompanyId = companyId || ctx.agent?.companyId;
  if (ctx.authToken && startGateCompanyId && !process.env["VITEST"]) {
    try {
      const approvals = await listPaperclipApprovals(startGateCompanyId, ctx.authToken, ctx.runId);
      const gate = evaluateJulesStartGate(approvals, taskId);
      if (!gate.allow) {
        if (ctx.onLog) await ctx.onLog("stdout", `[jules] ${gate.reason}\n`);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          summary: gate.reason,
          resultJson: { provider: "jules", issueStatus: "todo", startGate: "blocked" },
          clearSession: false,
        };
      }
    } catch (error) {
      if (ctx.onLog) {
        await ctx.onLog("stderr", `[jules] Start-gate approval check failed: ${sanitizeError(error)}\n`);
      }
    }
  }

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
    if (session && session.julesSessionId && !sessionMatchesConfig(session, config)) {
      let remoteRepo: string | null =
        ownerRepoFromJulesSource(session.source) || (session.repository ? session.repository.toLowerCase() : null);
      // A legacy source such as `github` carries no repository identity. It is
      // not safe to spend the one authoritative poll on an identity probe:
      // that turns a real 401/5xx polling failure into a successful heartbeat.
      // Probe only when the checkpoint itself contains a comparable repo name;
      // otherwise continue to the normal polling path, which classifies the
      // provider error correctly.
      if (remoteRepo && remoteRepo.includes("/")) {
        try {
          const remote = await client.getSession(session.julesSessionId);
          remoteRepo = ownerRepoFromJulesSource(remote.source) || remoteRepo;
        } catch {
          /* probe failed; normal polling remains authoritative */
        }
      }
      const wantRepo = config.repository.toLowerCase();
      if (remoteRepo && remoteRepo !== wantRepo) {
        if (ctx.onLog) {
          await ctx.onLog(
            "stderr",
            `[jules] Dropping session ${session.julesSessionId} on ${remoteRepo}; this issue is bound to ${config.repository}. A new Jules session will be created on the correct source.\n`,
          );
        }
        await deleteStoredSession(taskId, config.source, config.baseBranch).catch(() => {});
        session = null;
      } else if (ctx.onLog) {
        await ctx.onLog(
          "stderr",
          `[jules] Stored session identity differs from current config; probing remote before createSession.\n`,
        );
      }
    }
    if (session && storedRecoverySession && session.sessionId === storedRecoverySession.sessionId && ctx.onLog) {
      await ctx.onLog("stdout", "[jules] Restored session " + session.julesSessionId + " from the local recovery record.\n");
    } else if (session && issueHandleSessionId && session.julesSessionId === issueHandleSessionId && ctx.onLog) {
      await ctx.onLog("stdout", "[jules] Restored session " + session.julesSessionId + " from the Paperclip issue handle.\n");
    }
  }

  // A Jules cloud session may finish after Paperclip has reassigned or closed
  // its issue.  Do this ownership fence before any completion/plan mutation:
  // Paperclip's 403 is a correct authorization decision, not a retryable Jules
  // failure.  Confirmed handoffs clear the stale recovery record so the same
  // completed session cannot be resurrected on every heartbeat.
  if (session && process.env["NODE_ENV"] !== "test") {
    let ownership = evaluateJulesIssueOwnership({ julesAgentId: ctx.agent.id });
    try {
      const currentIssue = await getPaperclipIssue(taskId, ctx.authToken, ctx.runId);
      ownership = evaluateJulesIssueOwnership({
        issue: {
          ...(currentIssue.assigneeAgentId !== undefined ? { assigneeAgentId: currentIssue.assigneeAgentId } : {}),
          ...(currentIssue.status !== undefined ? { status: currentIssue.status } : {}),
        },
        julesAgentId: ctx.agent.id,
      });
    } catch (error) {
      ownership = evaluateJulesIssueOwnership({
        fetchFailed: { status: error instanceof PaperclipClientError ? error.status : null },
        julesAgentId: ctx.agent.id,
      });
      if (ownership === "unknown") throw error;
    }
    if (ownership === "transferred" || ownership === "missing") {
      await deleteStoredSession(taskId, config.source, config.baseBranch).catch(() => {});
      await ctx.onLog?.("stdout", `[jules] Releasing stale completed session ${session.julesSessionId ?? "unknown"}: issue ownership is ${ownership}. No Paperclip mutation or retry will be scheduled.\n`);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: `Released stale Jules session; issue ownership is ${ownership}.`,
        sessionParams: null,
        sessionDisplayId: session.julesSessionId ?? null,
        resultJson: { provider: "jules", julesSessionId: session.julesSessionId, staleSessionReleased: true, ownership },
        clearSession: true,
      };
    }
  }

  // PR review verdicts are native Paperclip interaction results consumed by
  // the orchestrator. Do not mine issue comments here: prose must never
  // reopen a completed Jules session or create duplicate provider work.

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
  const pendingPlanAgentReview = session?.pendingInteraction?.type === "plan_agent_review"
    ? session.pendingInteraction : null;
  const isCompletionResolution = interactionKind === "request_confirmation" &&
    (interactionStatus === "accepted" || interactionStatus === "rejected");

  // A previous buggy heartbeat could create a no-PR confirmation before the
  // provider's final question was visible.  Do not consume that confirmation
  // while newer provider work exists: re-check the activity stream, withdraw
  // the stale card, and let the normal question adjudication path take over.
  let supersededCompletion = false;
  if (pendingCompletion && session?.julesSessionId) {
    try {
      // This is only a narrow stale-confirmation check. Do not replay the
      // complete provider history before terminal handling; one recent page is
      // enough to prove that a newer question exists.
      const currentActivities = await listAllActivities(
        client,
        session.julesSessionId,
        session.currentPrUrl ? 1 : 5,
      );
      const latestProviderQuestion = [...currentActivities].reverse().find(
        (activity) => Boolean(activity.agentMessaged?.agentMessage?.trim()),
      );
      if (latestProviderQuestion && session.deliveredFeedbackActivityId !== latestProviderQuestion.id) {
        await withdrawPaperclipInteraction(
          taskId,
          pendingCompletion.paperclipInteractionId,
          "Superseded by an unresolved Jules provider question",
          ctx.authToken,
          ctx.runId,
        ).catch(() => undefined);
        session.pendingInteraction = undefined;
        await persistSessionBestEffort(session, ctx.onLog);
        supersededCompletion = true;
      }
    } catch (error) {
      await ctx.onLog?.("stderr", `[jules] Could not validate pending completion against provider activities: ${String(error)}\n`);
    }
  }

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

  if (pendingCompletion && isCompletionResolution && !supersededCompletion) {
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
      session!.pendingInteraction = session!.deferredPlanReview;
      session!.deferredPlanReview = undefined;
      session!.phase = "RUNNING";
      await persistSessionBestEffort(session!, ctx.onLog);
      await scheduleLiveSessionMonitor(session!, true);
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
          await scheduleLiveSessionMonitor(session!, true);
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
        await scheduleLiveSessionMonitor(session!, true);
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
        const remoteRepo = ownerRepoFromJulesSource(remote.source);
        const wantRepo = config.repository.toLowerCase();
        const repoMatches = !remoteRepo || remoteRepo === wantRepo;
        if (isLiveJulesRemoteState(remote.state) && repoMatches) {
          await ctx.onLog?.("stdout", `[jules] Reattaching live remote session ${session.julesSessionId} (${remote.state}); skipping createSession.\n`);
          session.phase = "RUNNING";
          session.julesState = normalizeJulesState(remote.state);
          await persistSessionBestEffort(session, ctx.onLog);
          await scheduleLiveSessionMonitor(session, true);
          return createPendingResult(session, true);
        }
        if (isLiveJulesRemoteState(remote.state) && !repoMatches) {
          await ctx.onLog?.(
            "stderr",
            `[jules] Not reattaching session ${session.julesSessionId} on ${remoteRepo}; this issue is bound to ${config.repository}. Creating a session on the correct source.\n`,
          );
        }
      } catch (err) {
        await ctx.onLog?.("stderr", `[jules] Remote session probe before create failed: ${sanitizeError(err)}\n`);
      }
    }

    const createOnSource = async (source: string) =>
      client.createSession({
          prompt,
          title: taskTitle,
          sourceContext: {
              source,
              githubRepoContext: {
                  startingBranch: config.baseBranch
              }
          },
          requirePlanApproval: config.requirePlanApproval,
          automationMode: config.automationMode
      });

    try {
      let julesSession;
      try {
        julesSession = await createOnSource(config.source);
      } catch (error) {
        if (error instanceof JulesClientError && error.status === 404) {
          const catalogSource = await client.resolveGithubSourceName(config.repository);
          if (catalogSource && catalogSource !== config.source) {
            if (ctx.onLog) {
              await ctx.onLog("stdout", `[jules] createSession 404 on ${config.source}; retrying with catalog source ${catalogSource}\n`);
            }
            config = { ...config, source: catalogSource };
            julesSession = await createOnSource(catalogSource);
          } else {
            throw error;
          }
        } else {
          throw error;
        }
      }

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
    outcome?: { summary?: string; resultJson?: Record<string, unknown> },
  ): Promise<AdapterExecutionResult> => {
    await persistSessionBestEffort(current, ctx.onLog, { authToken: ctx.authToken, runId: ctx.runId });
    // Human interactions have their own Paperclip continuation. Internal
    // reviewer children still need the native monitor so this adapter can
    // observe both reviewer decisions and new provider activity.
    await scheduleLiveSessionMonitor(current, initialActivityCheck);
    const pending = createPendingResult(current, initialActivityCheck, reattachDelayMs);
    return {
      ...pending,
      ...(outcome?.summary ? { summary: outcome.summary } : {}),
      resultJson: { ...(pending.resultJson as Record<string, unknown>), ...(outcome?.resultJson ?? {}) },
    };
  };

  // Compatibility migration for sessions created before strong approval was
  // allowed to satisfy the `required` plan gate. Re-evaluate that exact plan
  // revision once; never repeatedly spend reviewer calls on the same card.
  if (
    pendingProviderInteraction?.type === "plan_approval" &&
    storedPendingInteraction?.status === "pending" &&
    config.planReviewerAgentId && config.planStrongReviewerAgentId
  ) {
    // Migrate legacy human cards to the native ACP ladder. This is deliberately
    // checked before the legacy direct-API compatibility reviewer so existing
    // blocked tasks recover without requiring any reviewer API key.
    if (config.planReviewerAgentId && config.planStrongReviewerAgentId) {
      const child = await createJulesPlanReviewChild(
        taskId, config.planReviewerAgentId, "vibe", pendingProviderInteraction.question,
        pendingProviderInteraction.planRevisionId, ctx.authToken, ctx.runId, ctx.agent.companyId,
      );
      if (pendingProviderInteraction.paperclipInteractionId) {
        await withdrawPaperclipInteraction(taskId, pendingProviderInteraction.paperclipInteractionId, "Replaced by native ACP plan-review ladder", ctx.authToken, ctx.runId).catch(() => undefined);
      }
      session.pendingInteraction = {
        type: "plan_agent_review",
        julesActivityId: pendingProviderInteraction.julesActivityId,
        question: pendingProviderInteraction.question,
        planRevisionId: pendingProviderInteraction.planRevisionId,
        planRevisionNumber: pendingProviderInteraction.planRevisionNumber,
        planDocumentId: pendingProviderInteraction.planDocumentId,
        reviewIssueId: child.id,
        reviewerAgentId: config.planReviewerAgentId,
        stage: "vibe",
        createdAt: new Date().toISOString(),
      };
      session.planReviewRevisionId = pendingProviderInteraction.planRevisionId;
      session.planReviewOutcome = undefined;
      await persistSessionBestEffort(session, ctx.onLog);
      return await yieldHeartbeat(session);
    }
    const migrationReview = await evaluatePlanClarity(pendingProviderInteraction.question, {
      title: taskTitle,
      description: taskDescription,
      hostPlanMarkdown: pendingProviderInteraction.question,
      cheapReviewer: createCheapReviewer() ?? defaultCheapReviewer,
      terraCodexReviewer: createTerraCodexReviewer(),
    });
    session.planReviewRevisionId = pendingProviderInteraction.planRevisionId;
    session.planReviewOutcome = migrationReview.action === "AUTO_APPROVE"
      ? "approved"
      : migrationReview.action === "REQUEST_REVISION"
        ? "revision_requested"
        : "human_escalation";
    await persistSessionBestEffort(session, ctx.onLog);
    if (migrationReview.action === "AUTO_APPROVE") {
      await withdrawPaperclipInteraction(
        taskId,
        pendingProviderInteraction.paperclipInteractionId!,
        "Replaced by automatic strong-reviewer approval",
        ctx.authToken,
        ctx.runId,
      );
      await client.approvePlan(session.julesSessionId!);
      session.planApprovedAt = new Date().toISOString();
      session.pendingInteraction = undefined;
      session.phase = "RUNNING";
      await persistSessionBestEffort(session, ctx.onLog);
      return await yieldHeartbeat(session);
    }
  }

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
      const state = normalizeJulesState(julesSession.state);
      const terminalProviderState = state === "COMPLETED" || state === "FAILED";
      let scopeDriftSummary: string | undefined;
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
              await runCheckpointedMutation({
                session: session!,
                key: `jules:work-product:${taskId}:${prUrl}`,
                operation: "register_pull_request_work_product",
                issueId: taskId,
                sessionId: session!.julesSessionId,
                persist: () => persistSessionBestEffort(session!, ctx.onLog),
                run: () => registerPullRequestWorkProduct(taskId, prUrl, ctx.authToken, ctx.runId),
              });
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
          const driftFingerprint = drift && drift.type === "FLAG_SCOPE_DRIFT"
            ? `${prUrl}\n${drift.summary}`
            : undefined;
          if (!driftFingerprint && session.scopeDriftFingerprint) {
            session.scopeDriftFingerprint = undefined;
            await persistSessionBestEffort(session, ctx.onLog);
          }
          if (drift && drift.type === "FLAG_SCOPE_DRIFT") {
            // Scope drift is a host/reviewer finding, not a provider question.
            // Jules must not be asked to "fix" a PR based on a local comparison:
            // the PR may intentionally contain commits from another task, and
            // sending this text reopens an otherwise finished provider session.
            // Hand the existing PR to Paperclip's review pipeline instead.
            if (ctx.onLog) {
              await ctx.onLog("stderr", `[jules] ${drift.summary}\n`);
            }
            session.scopeDriftFingerprint = driftFingerprint;
            session.phase = "PR_CREATED";
            await persistSessionBestEffort(session, ctx.onLog);
            // Do not return here. This branch is reached before the Jules
            // activity stream is reconciled; returning used to hide a question
            // and consume the due Paperclip monitor without re-arming it.
            scopeDriftSummary = drift.summary;
          }
      }

      // Mirroring must never prevent terminal detection: a mirror failure used to
      // abort this run before the COMPLETED/FAILED branches could fire, leaving
      // the Paperclip issue blocked forever (MAZ-102 incident, issue #4/#5 class).
      const deliveredActivityIdsBeforePoll = new Set(session.deliveredActivityIds ?? []);
      let activities: JulesActivity[] = [];
      try {
        // Terminal reconciliation must inspect a bounded window large enough
        // to contain both the provider's typed completion marker and a final
        // question. One page can contain the question but omit the marker,
        // which would make old prose look like a new question.
        activities = await mirrorNewActivities(
          client,
          session,
          taskId,
          ctx.authToken,
          ctx.runId,
          ctx.onLog,
          5,
        );
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
      if (watchdogEval.reason.startsWith("Session stalled")) {
        await ctx.onLog?.("stdout", `[jules] Watchdog observed a stalled session; monitor polling continues without sending a provider message. ${watchdogEval.reason}\n`);
      }

      // Jules can publish its final question in the same activity window in
      // which the provider changes state to COMPLETED.  That question is
      // provider work, not a no-PR completion signal.  Keep the activity ID
      // that was actually answered as the high-water mark; older messages are
      // harmless, while a newer message must enter the reviewer lane first.
      const latestAgentActivity = [...activities].reverse().find(
        (activity) => Boolean(activity.agentMessaged?.agentMessage?.trim()),
      );
      const latestAgentActivityIndex = latestAgentActivity
        ? activities.findIndex((activity) => activity.id === latestAgentActivity.id)
        : -1;
      const completionActivityIndex = activities.reduce(
        (latestIndex, activity, index) => activity.sessionCompleted !== undefined ? index : latestIndex,
        -1,
      );
      // Jules sometimes leaves a human-sounding plan prompt in the activity
      // stream immediately before its typed completion event. That is history,
      // not a new question. Activity type and ordering are the protocol here;
      // the prompt's wording is deliberately never classified.
      const messageFollowsCompletion = completionActivityIndex >= 0 &&
        latestAgentActivityIndex > completionActivityIndex;
      // Mirroring and answering are separate checkpoints. A previous adapter
      // may have copied a question to Paperclip before it crashed or stopped
      // polling; that activity must still enter adjudication until Jules has
      // received the reviewer answer. Terminal races require the activity to
      // be new in this poll, while AWAITING_USER_FEEDBACK is authoritative.
      // A plan-review child is another durable wait boundary: Jules may emit a
      // typed agent message before its coarse session state flips to
      // AWAITING_USER_FEEDBACK. That fresh message must preempt the plan child
      // and enter the strong-reviewer lane; this uses provider structure and
      // activity identity, never text matching.
      const freshMessageWhilePlanReviewing = Boolean(
        pendingPlanAgentReview &&
        state !== "COMPLETED" && state !== "FAILED" &&
        latestAgentActivity &&
        !deliveredActivityIdsBeforePoll.has(latestAgentActivity.id) &&
        session.deliveredFeedbackActivityId !== latestAgentActivity.id,
      );
      const latestProviderQuestion = latestAgentActivity &&
        ((state === "AWAITING_USER_FEEDBACK" && session.deliveredFeedbackActivityId !== latestAgentActivity.id) ||
          ((state === "COMPLETED" || state === "FAILED") &&
            !deliveredActivityIdsBeforePoll.has(latestAgentActivity.id) && messageFollowsCompletion) ||
          freshMessageWhilePlanReviewing)
        ? latestAgentActivity
        : undefined;
      const hasProviderQuestion = Boolean(latestProviderQuestion);
      const hasUnresolvedProviderQuestion = Boolean(
        latestProviderQuestion &&
        session.deliveredFeedbackActivityId !== latestProviderQuestion.id,
      );

      // Recover answers relayed by older builds that only left a comment and
      // reviewer child. The exact activity ID proves which provider question
      // was answered; we reconstruct the visible parent interaction from that
      // typed activity and the reviewer's JSON decision without messaging
      // Jules a second time.
      // Do not use the latest message here.  Jules can continue producing
      // progress activities after it receives an answer, so the activity that
      // was already relayed is often no longer the latest one.  Nor may an
      // independent plan-review child suppress this audit trail: plan review
      // and a provider question are separate state machines.
      const deliveredFeedbackActivityId = session?.deliveredFeedbackActivityId;
      const deliveredFeedbackActivity = deliveredFeedbackActivityId
        ? activities.find((activity) => activity.id === deliveredFeedbackActivityId)
        : undefined;
      if (deliveredFeedbackActivity && !session.deliveredFeedbackInteractionId) {
        const question = extractQuestionText(deliveredFeedbackActivity);
        const recoveryReviewerAgentId = config.questionReviewerAgentId;
        if (question && recoveryReviewerAgentId) {
          const recoveredChild = await createJulesQuestionAdjudication(
            taskId,
            recoveryReviewerAgentId,
            question,
            ctx.authToken,
            ctx.runId,
            ctx.agent.companyId,
          );
          const recoveredDecision = (await listIssueComments(recoveredChild.id, ctx.authToken, ctx.runId).catch(() => []))
            .filter((comment) => comment.authorAgentId === recoveryReviewerAgentId)
            .map((comment) => parseQuestionAdjudication(comment.body))
            .find((decision) => decision?.kind === "ANSWER");
          if (recoveredDecision?.kind === "ANSWER") {
            const visibleInteraction = await createJulesAgentAdjudicationInteraction(
              taskId,
              session.julesSessionId!,
              deliveredFeedbackActivity.id,
              question,
              recoveryReviewerAgentId,
              ctx.authToken,
              ctx.runId,
            );
            await answerJulesAgentAdjudicationInteraction(
              taskId,
              visibleInteraction.id,
              recoveredDecision.answer,
              ctx.authToken,
              ctx.runId,
            );
            session.deliveredFeedbackInteractionId = visibleInteraction.id;
            await completeInternalReviewIssue(recoveredChild.id, ctx.authToken, ctx.runId).catch(() => undefined);
            await persistSessionBestEffort(session, ctx.onLog);
          }
        }
      }

      // A session restart can lose the in-memory reference to a completion
      // card while the Paperclip interaction remains pending.  Reconcile that
      // orphan by the stable idempotency key used when the card was created,
      // but only when a concrete newer provider question proves the card is
      // stale.  This is deliberately narrow so unrelated confirmations are
      // never withdrawn.
      if (hasProviderQuestion) {
        const staleCompletionKey = `jules:no-pr-completion:${taskId}:${session.julesSessionId}`;
        const interactions = await listPaperclipInteractions(taskId, ctx.authToken, ctx.runId).catch(() => []);
        const staleCompletion = interactions.find(
          (interaction) => interaction.kind === "request_confirmation" &&
            interaction.status === "pending" &&
            interaction.idempotencyKey === staleCompletionKey,
        );
        if (staleCompletion) {
          await withdrawPaperclipInteraction(
            taskId,
            staleCompletion.id,
            "Superseded by an unresolved Jules provider question",
            ctx.authToken,
            ctx.runId,
          ).catch(() => undefined);
        }
      }

      // ACP-only plan ladder. This deliberately runs after the provider
      // activity stream has been fetched and mirrored. A delegated review may
      // take many heartbeats, and Jules can emit a new question meanwhile;
      // returning before this poll used to leave that question invisible.
      // A plan-review child is an ACP coordination detail, not a terminal
      // gate. Jules may complete while that child is still unanswered (for
      // example after a reviewer was unavailable). Do not keep yielding a
      // heartbeat forever: terminal provider state must continue to the PR
      // handoff / failure path below. Non-terminal sessions still wait for the
      // structured reviewer decision exactly as before.
      if (pendingPlanAgentReview && !hasUnresolvedProviderQuestion && !terminalProviderState) {
        const child = await getPaperclipIssue(pendingPlanAgentReview.reviewIssueId, ctx.authToken, ctx.runId).catch(() => null);
        if (child) {
          const comments = await listIssueComments(child.id, ctx.authToken, ctx.runId);
          const comment = [...comments].reverse().find((c) => c.authorAgentId === pendingPlanAgentReview.reviewerAgentId);
          const decision = comment ? parsePlanAdjudication(comment.body) : null;
          // The structured reviewer comment is the durable completion event;
          // child status is intentionally not used as the protocol signal.
          if (decision && child.status !== "done") {
            await moveIssueToDone(child.id, session.julesSessionId!, ctx.authToken, ctx.runId, "Jules consumed the structured ACP plan-review decision.").catch(() => undefined);
          }
          if (pendingPlanAgentReview.stage === "vibe" && decision?.kind === "PASS_TO_STRONG" && config.planStrongReviewerAgentId) {
            const next = await createJulesPlanReviewChild(taskId, config.planStrongReviewerAgentId, "strong", pendingPlanAgentReview.question, pendingPlanAgentReview.planRevisionId, ctx.authToken, ctx.runId, ctx.agent.companyId);
            session.pendingInteraction = { ...pendingPlanAgentReview, stage: "strong", reviewIssueId: next.id, reviewerAgentId: config.planStrongReviewerAgentId };
            await persistSessionBestEffort(session, ctx.onLog);
            return await yieldHeartbeat(session);
          }
          if (decision?.kind === "REQUEST_REVISION") {
            await client.sendMessage(session.julesSessionId!, { prompt: ["The ACP plan reviewer found concrete issues. Revise the plan and publish a new plan activity.", ...decision.findings, ...decision.questions].join("\n") });
            session.pendingInteraction = undefined;
            session.planReviewOutcome = "revision_requested";
            await persistSessionBestEffort(session, ctx.onLog);
            return await yieldHeartbeat(session);
          }
          if (pendingPlanAgentReview.stage === "strong" && decision?.kind === "APPROVE") {
            await client.approvePlan(session.julesSessionId!);
            session.planApprovedAt = new Date().toISOString();
            session.pendingInteraction = undefined;
            session.planReviewOutcome = "approved";
            await persistSessionBestEffort(session, ctx.onLog);
            return await yieldHeartbeat(session);
          }
          if (pendingPlanAgentReview.stage === "strong" && decision?.kind === "ESCALATE") {
            const interaction = await runCheckpointedMutation({
              session: session!,
              key: `confirmation:${taskId}:plan:${pendingPlanAgentReview.planRevisionId}`,
              operation: "create_plan_approval_interaction",
              issueId: taskId,
              sessionId: session!.julesSessionId,
              activityId: pendingPlanAgentReview.julesActivityId,
              persist: () => persistSessionBestEffort(session!, ctx.onLog),
              run: () => createJulesPlanApprovalInteraction(taskId, session!.julesSessionId!, pendingPlanAgentReview.julesActivityId, pendingPlanAgentReview.question, ctx.authToken, ctx.runId),
            });
            session.pendingInteraction = { type: "plan_approval", julesActivityId: pendingPlanAgentReview.julesActivityId, paperclipInteractionId: interaction.id, question: pendingPlanAgentReview.question, planDocumentId: interaction.planRevision.documentId, planRevisionId: interaction.planRevision.revisionId, planRevisionNumber: interaction.planRevision.revisionNumber, createdAt: new Date().toISOString() };
            session.planReviewOutcome = "human_escalation";
            await persistSessionBestEffort(session, ctx.onLog);
            return await yieldHeartbeat(session);
          }
          // A missing child decision is a reviewer wait, not permission to
          // invent a human question or reset the plan gate.
        }
        return await yieldHeartbeat(session);
      }

      // Provider questions are delegated to the configured strong Paperclip
      // reviewer. The only machine-readable input accepted from that agent is
      // the strict JSON protocol in question-adjudication.ts; prose is never
      // classified or auto-answered.
      // A pre-fix run can leave a question child active after Jules has
      // already completed and produced a PR. Retire both stale ACP children
      // and the visible card, then let the terminal state machine continue.
      if (terminalProviderState && !hasUnresolvedProviderQuestion &&
          session.pendingInteraction?.type === "agent_adjudication") {
        const staleQuestion = session.pendingInteraction;
        await completeInternalReviewIssue(staleQuestion.adjudicationIssueId, ctx.authToken, ctx.runId).catch(() => undefined);
        if (staleQuestion.paperclipInteractionId) {
          await withdrawPaperclipInteraction(
            taskId,
            staleQuestion.paperclipInteractionId,
            "Superseded by terminal Jules completion",
            ctx.authToken,
            ctx.runId,
          ).catch(() => undefined);
        }
        if (session.deferredPlanReview) {
          await completeInternalReviewIssue(session.deferredPlanReview.reviewIssueId, ctx.authToken, ctx.runId).catch(() => undefined);
        }
        session.pendingInteraction = undefined;
        session.deferredPlanReview = undefined;
        await persistSessionBestEffort(session, ctx.onLog);
      }

      // Plan-review children are ACP bookkeeping, not provider work. If a
      // legacy run reaches a terminal Jules state before the reviewer answers,
      // retire the child and resume the durable PR handoff instead of yielding
      // a heartbeat forever. This is intentionally terminal-state driven.
      if (terminalProviderState && !hasUnresolvedProviderQuestion &&
          session.pendingInteraction?.type === "plan_agent_review") {
        const stalePlanReview = session.pendingInteraction;
        await completeInternalReviewIssue(stalePlanReview.reviewIssueId, ctx.authToken, ctx.runId).catch(() => undefined);
        if (stalePlanReview.paperclipInteractionId) {
          await withdrawPaperclipInteraction(
            taskId,
            stalePlanReview.paperclipInteractionId,
            "Superseded by terminal Jules completion",
            ctx.authToken,
            ctx.runId,
          ).catch(() => undefined);
        }
        session.pendingInteraction = undefined;
        session.deferredPlanReview = undefined;
        session.planReviewOutcome = "superseded_terminal";
        await persistSessionBestEffort(session, ctx.onLog);
      }

      if (session.pendingInteraction?.type === "agent_adjudication" &&
          !(terminalProviderState && !hasUnresolvedProviderQuestion)) {
        const pending = session.pendingInteraction;
        // A pre-fix session may contain an adjudication created from plan text
        // while Jules was asking a separate question in the same activity
        // window. Never send that stale answer to Jules. Drop the child and
        // let the current typed provider-question path create a replacement.
        if (
          state === "AWAITING_USER_FEEDBACK" &&
          latestAgentActivity &&
          latestAgentActivity.id !== pending.julesActivityId &&
          session.deliveredFeedbackActivityId !== latestAgentActivity.id
        ) {
          await completeInternalReviewIssue(pending.adjudicationIssueId, ctx.authToken, ctx.runId).catch(() => undefined);
          session.pendingInteraction = session.deferredPlanReview;
          session.deferredPlanReview = undefined;
          await persistSessionBestEffort(session, ctx.onLog);
        } else {
        // Older adapter builds created these children as non-blocking tasks or
        // assigned them to the orchestrator. They are not a valid durable wait
        // path, so discard the stale reference and recreate it through the
        // configured strong-reviewer lane below.
        const adjudicationIssue = await getPaperclipIssue(
          pending.adjudicationIssueId, ctx.authToken, ctx.runId,
        ).catch(() => null);
        if (adjudicationIssue) {
          await normalizeInternalReviewIssue(adjudicationIssue, ctx.authToken, ctx.runId).catch(() => undefined);
        }
        const comments = await listIssueComments(pending.adjudicationIssueId, ctx.authToken, ctx.runId).catch(() => []);
        const decision = comments
          .filter((comment) => comment.authorAgentId === pending.reviewerAgentId)
          .map((comment) => parseQuestionAdjudication(comment.body))
          .find((candidate) => candidate !== null);
        if (decision?.kind === "ANSWER") {
          if (pending.paperclipInteractionId) {
            await answerJulesAgentAdjudicationInteraction(
              taskId,
              pending.paperclipInteractionId,
              decision.answer,
              ctx.authToken,
              ctx.runId,
            );
          }
          await completeInternalReviewIssue(pending.adjudicationIssueId, ctx.authToken, ctx.runId).catch(() => undefined);
          await client.sendMessage(session.julesSessionId!, { prompt: decision.answer });
          session.deliveredFeedbackActivityId = pending.julesActivityId;
          session.pendingInteraction = session.deferredPlanReview;
          session.deferredPlanReview = undefined;
          session.phase = "RUNNING";
          await persistSessionBestEffort(session, ctx.onLog);
          return await yieldHeartbeat(session);
        }
        if (decision?.kind === "ESCALATE") {
          await completeInternalReviewIssue(pending.adjudicationIssueId, ctx.authToken, ctx.runId).catch(() => undefined);
          const activityId = pending.julesActivityId;
          const attempt = (session.feedbackInteractionAttempt ?? 0) + 1;
          const interaction = await runCheckpointedMutation({
            session: session!,
            key: `jules:user-feedback:${taskId}:${session!.julesSessionId}:${activityId}:${attempt}`,
            operation: "create_user_feedback_interaction",
            issueId: taskId,
            sessionId: session!.julesSessionId,
            activityId,
            persist: () => persistSessionBestEffort(session!, ctx.onLog),
            run: () => createJulesFeedbackInteraction(
              taskId,
              session!.julesSessionId!,
              activityId,
              `${pending.question}\n\nReviewer escalation: ${decision.reason}`,
              ctx.authToken,
              attempt,
              ctx.runId,
            ),
          });
          session.feedbackInteractionAttempt = attempt;
          session.pendingInteraction = {
            type: "user_feedback",
            julesActivityId: pending.julesActivityId,
            paperclipInteractionId: interaction.id,
            question: pending.question,
            createdAt: new Date().toISOString(),
          };
          await persistSessionBestEffort(session, ctx.onLog);
          return await yieldHeartbeat(session);
        }
        if (adjudicationIssue?.status === "cancelled" ||
            adjudicationIssue?.status === "done" ||
            adjudicationIssue?.assigneeAgentId !== pending.reviewerAgentId) {
          session.pendingInteraction = undefined;
          await persistSessionBestEffort(session, ctx.onLog);
        } else {
          return await yieldHeartbeat(session);
        }
        }
      }

      const stateMachineRes = handleJulesState(state, !!session.currentPrUrl);
      session.phase = stateMachineRes.nextPhase;
      if (hasUnresolvedProviderQuestion) {
        session.phase = "WAITING_FOR_FEEDBACK";
      }

      const unapprovedPlan = latestPlan(activities);
      const isPlanningTurnCompleted = Boolean(
        unapprovedPlan &&
        config.requirePlanApproval &&
        !session.planApprovedAt
      );

      if (hasUnresolvedProviderQuestion) {
        // A provider question is actionable work even when the same poll also
        // contains a planGenerated activity. Preserve the plan-review state in
        // deferredPlanReview and let the strong question reviewer run first.
        session.phase = "WAITING_FOR_FEEDBACK";
      } else if (isPlanningTurnCompleted) {
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
                     const interaction = await runCheckpointedMutation({
                       session: session!,
                       key: `jules:no-pr-completion:${taskId}:${session!.julesSessionId}`,
                       operation: "create_no_pr_completion_interaction",
                       issueId: taskId,
                       sessionId: session!.julesSessionId,
                       persist: () => persistSessionBestEffort(session!, ctx.onLog),
                       run: () => createNoPrCompletionInteraction(
                         taskId,
                         session!.julesSessionId!,
                         session!.julesSessionUrl,
                         ctx.authToken,
                         ctx.runId,
                       ),
                     });
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
               if (scopeDriftSummary) {
                 return await yieldHeartbeat(session, false, {
                   summary: `Jules PR ${session.currentPrUrl} requires host review for scope conformity. No message was sent to Jules.`,
                   resultJson: {
                     julesSessionId: session.julesSessionId,
                     prUrl: session.currentPrUrl,
                     scopeConformant: false,
                     issueStatus: "in_review",
                     reviewRequired: true,
                     providerMessageSent: false,
                   },
                 });
               }
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
             await runCheckpointedMutation({
               session: session!,
               key: `jules:review:${taskId}:${session!.currentPrUrl}`,
               operation: "register_pull_request_review",
               issueId: taskId,
               sessionId: session!.julesSessionId,
               persist: () => persistSessionBestEffort(session!, ctx.onLog),
               run: () => moveIssueToReview(taskId, session!.currentPrUrl!, ctx.authToken, ctx.runId),
             });
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

      if (stateMachineRes.requiresReturn || isPlanningTurnCompleted || hasUnresolvedProviderQuestion) {
        try {
          const existingInteractions = await listPaperclipInteractions(taskId, ctx.authToken, ctx.runId).catch(() => []);
          let rawQuestionText: string | undefined;
          let rawQuestionActivityId: string | undefined;
          if (hasUnresolvedProviderQuestion) {
            let activity: JulesActivity | null = latestAgentActivity ?? null;
            if (!activity) {
              const allActivities = await listAllActivities(client, session.julesSessionId!);
              activity = [...allActivities].reverse().find(
                (candidate) => Boolean(candidate.agentMessaged?.agentMessage?.trim()),
              ) ?? null;
            }
            rawQuestionText = extractQuestionText(activity);
            rawQuestionActivityId = activity?.id;
          } else if (session.phase === "WAITING_FOR_PLAN_APPROVAL") {
            const activity = latestPlan(activities);
            rawQuestionText = planMarkdown(activity);
          }

          // `isPlanningTurnCompleted` is derived from the structured
          // `planGenerated` activity, so pass the explicit state into the
          // reducer. The reducer must not classify provider prose.
          const action = evaluateInteractionAction(
            session,
            hasUnresolvedProviderQuestion
                ? "AWAITING_USER_FEEDBACK"
                : isPlanningTurnCompleted
                  ? "AWAITING_PLAN_APPROVAL"
                : state,
            existingInteractions,
            rawQuestionText,
            rawQuestionActivityId,
          );

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
              const interaction = await runCheckpointedMutation({
                session: session!,
                key: `jules:user-feedback:${taskId}:${session!.julesSessionId}:${activityId}:${action.attempt}`,
                operation: "create_user_feedback_interaction",
                issueId: taskId,
                sessionId: session!.julesSessionId,
                activityId,
                persist: () => persistSessionBestEffort(session!, ctx.onLog),
                run: () => createJulesFeedbackInteraction(
                  taskId, session!.julesSessionId!, activityId, action.question, ctx.authToken, action.attempt, ctx.runId,
                ),
              });
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

            case "CREATE_AGENT_ADJUDICATION": {
              const reviewerAgentId = config.questionReviewerAgentId;
              if (!reviewerAgentId) {
                throw new Error("questionReviewerAgentId must be configured; provider questions may not bypass the strong-reviewer lane");
              }
              if (session.pendingInteraction?.type === "plan_agent_review") {
                session.deferredPlanReview = session.pendingInteraction;
              }
              let activity: JulesActivity | null = latestAgentActivity ?? null;
              if (!activity) {
                const allActivities = await listAllActivities(client, session.julesSessionId!);
                activity = [...allActivities].reverse().find(
                  (candidate) => Boolean(candidate.agentMessaged?.agentMessage?.trim()),
                ) ?? null;
              }
              const activityId = activity?.id ?? "awaiting-user-feedback";
              const visibleInteraction = await runCheckpointedMutation({
                session: session!,
                key: `jules:agent-adjudication:${taskId}:${session!.julesSessionId}:${activityId}`,
                operation: "create_agent_adjudication_interaction",
                issueId: taskId,
                sessionId: session!.julesSessionId,
                activityId,
                persist: () => persistSessionBestEffort(session!, ctx.onLog),
                run: () => createJulesAgentAdjudicationInteraction(
                  taskId, session!.julesSessionId!, activityId, action.question, reviewerAgentId, ctx.authToken, ctx.runId,
                ),
              });
              const adjudication = await runCheckpointedMutation({
                session: session!,
                key: `jules:question-adjudication:${taskId}:${action.question}`,
                operation: "create_question_adjudication_issue",
                issueId: taskId,
                sessionId: session!.julesSessionId,
                activityId,
                persist: () => persistSessionBestEffort(session!, ctx.onLog),
                run: () => createJulesQuestionAdjudication(
                  taskId, reviewerAgentId, action.question, ctx.authToken, ctx.runId, ctx.agent.companyId,
                ),
              });
              session.pendingInteraction = {
                type: "agent_adjudication",
                julesActivityId: asJulesActivityId(activityId),
                paperclipInteractionId: visibleInteraction.id,
                question: action.question,
                adjudicationIssueId: adjudication.id,
                reviewerAgentId,
                createdAt: new Date().toISOString(),
              };
              await persistSessionBestEffort(session, ctx.onLog);
              return await yieldHeartbeat(session);
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
              if (config.planReviewerAgentId && config.planStrongReviewerAgentId) {
                const revision = await runCheckpointedMutation({
                  session: session!,
                  key: `jules:plan-document:${taskId}:${activityId}`,
                  operation: "save_plan_document",
                  issueId: taskId,
                  sessionId: session!.julesSessionId,
                  activityId,
                  persist: () => persistSessionBestEffort(session!, ctx.onLog),
                  run: () => saveJulesPlanDocument(taskId, activityId, fullPlan, ctx.authToken, ctx.runId),
                });
                const child = await runCheckpointedMutation({
                  session: session!,
                  key: `jules:plan-review:${taskId}:${revision.revisionId}:vibe`,
                  operation: "create_plan_review_child",
                  issueId: taskId,
                  sessionId: session!.julesSessionId,
                  activityId,
                  persist: () => persistSessionBestEffort(session!, ctx.onLog),
                  run: () => createJulesPlanReviewChild(taskId, config.planReviewerAgentId!, "vibe", fullPlan, revision.revisionId, ctx.authToken, ctx.runId, ctx.agent.companyId),
                });
                session.planReviewRevisionId = revision.revisionId;
                session.planReviewOutcome = undefined;
                session.pendingInteraction = { type: "plan_agent_review", julesActivityId: asJulesActivityId(activityId), question: fullPlan, planDocumentId: revision.documentId, planRevisionId: revision.revisionId, planRevisionNumber: revision.revisionNumber, reviewIssueId: child.id, reviewerAgentId: config.planReviewerAgentId, stage: "vibe", createdAt: new Date().toISOString() };
                await persistSessionBestEffort(session, ctx.onLog);
                return await yieldHeartbeat(session);
              }
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
              // Activity ID is the stable pre-card revision key. When a
              // Paperclip plan document is created below, replace it with the
              // exact document revision ID.
              session.planReviewRevisionId = activityId;
              session.planReviewOutcome = planReview.action === "AUTO_APPROVE"
                ? "approved"
                : planReview.action === "REQUEST_REVISION"
                  ? "revision_requested"
                  : "human_escalation";
              await persistSessionBestEffort(session, ctx.onLog);
              // `required` means Jules must have an approved plan before
              // coding. A confident strong-reviewer approval satisfies that
              // requirement; it must not force a human into the loop. The
              // human card below is only the final escalation path.
              if (planReview.action === "AUTO_APPROVE" && planReview.stage === "terra_codex") {
                if (ctx.onLog) {
                  await ctx.onLog("stdout", `[jules] Terra/Codex approved the plan (planApprovalPolicy=${config.planApprovalPolicy}).\n`);
                }
                await client.approvePlan(session.julesSessionId!);
                session.planApprovedAt = new Date().toISOString();
                session = recordPlanApprovalRelayed(session);
                return await yieldHeartbeat(session);
              }

              if (planReview.action === "REQUEST_REVISION") {
                await client.sendMessage(session.julesSessionId!, {
                  prompt: [
                    "The plan review found concrete issues. Revise the plan and publish a new plan activity.",
                    ...planReview.findings,
                    ...planReview.questions,
                  ].join("\n"),
                });
                session.planReviewOutcome = "revision_requested";
                await persistSessionBestEffort(session, ctx.onLog);
                return await yieldHeartbeat(session);
              }

              const interaction = await createJulesPlanApprovalInteraction(
                taskId, session.julesSessionId!, activityId, action.planMarkdown, ctx.authToken, ctx.runId,
              );
              session.planReviewRevisionId = interaction.planRevision.revisionId;
              session.planReviewOutcome = "human_escalation";
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
              return await yieldHeartbeat(freshSession, true);
            }

            case "CONTINUE_POLLING":
              if (scopeDriftSummary) {
                return await yieldHeartbeat(session, false, {
                  summary: `Jules PR ${session.currentPrUrl} requires host review for scope conformity. No message was sent to Jules.`,
                  resultJson: {
                    julesSessionId: session.julesSessionId,
                    prUrl: session.currentPrUrl,
                    scopeConformant: false,
                    issueStatus: "in_review",
                    reviewRequired: true,
                    providerMessageSent: false,
                  },
                });
              }
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
