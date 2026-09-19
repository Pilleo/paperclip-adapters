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
import { evaluateSessionStartup, isInteractionWake, preferBranchBoundRecoveryHandle, recoverPrIdentityFromWorkProduct, restoreBranchBoundRemediationFromHandle, sessionMatchesConfig, shouldReadIssueSessionHandle, shouldReclaimBranchBoundRecovery } from "./session-lifecycle.js";
import { isLiveJulesRemoteState } from "./jules-live-state.js";
import { evaluateSessionWatchdog } from "./watchdog.js";
import { MAX_ACTIVITY_PAGES, activityScanPageLimit, listAllActivities, mirrorActivities, mirrorNewActivities, reduceTerminalActivityScan, terminalEvidenceActivity } from "./activity-mirror.js";
import { reconcileProviderContinuation } from "./provider-continuation.js";
import { persistSessionBestEffort } from "./session-initializer.js";
import { evaluatePlanClarity, composePlanForReview, createCheapReviewer, createTerraCodexReviewer, defaultCheapReviewer } from "./plan-reviewer.js";
import { buildHostImplementationPlan, decideReviewHandoff, nativePrRejectionDeliveryId, parseWorkerFeedback, PR_REJECTION_SUPERSEDED_PLAN_REASON, workerFeedbackPrompt } from "@pilleo/paperclip-adapter-common";
import { evaluateSessionFailure } from "./failure-recovery.js";
import { extractResolvedInteraction } from "./interaction-relay.js";
import {
  evaluateInteractionAction,
  extractPlanReviewVerdict,
  recordFeedbackRelayed,
  recordPlanApprovalRelayed,
  resumePlanReviewAfterQuestionResolution,
  isPlanApprovalRequired,
  determinePaperclipIssueStatus,
} from "./interaction-engine.js";
import { formatCardPrompt, formatCardSummary } from "./card-prompt.js";
import { getPullRequestCiStatus, getPullRequestDetails, getPullRequestPatch, listPullRequestChangedFiles } from "./ci-status.js";
import { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { AdapterConfig, validateConfig, requireJulesApiKey, resolveJulesBaseUrl, discoverLocalGitRepository, discoverLocalGitDefaultBranch } from "./config.js";
import { isGhCliAuthenticated, createRemoteGitHubRepo } from "./git-remote-creator.js";
import { JulesAdapterSessionV1, normalizeJulesState, sessionCodec, serializeSession } from "./session.js";
import { parsePlanReviewInteraction, parsePlanReviewVerdictResult } from "./plan-review-protocol.js";
import { hasNativeReviewVerdictAttestation } from "./native-review-attestation.js";
import { decidePlanGateRecovery, recoverMissingPlanGatePointer } from "./plan-gate-state.js";
import {
  createPlanRevisionRequest,
  decidePlanRevisionRequestDelivery,
  planRevisionRequestPrompt,
} from "./plan-revision-request.js";
import { reconcileProviderState, selectTerminalPullRequestUrl } from "./provider-reconciliation.js";
import { decideTerminalPrLifecycle } from "./terminal-pr-lifecycle.js";
import { JulesActivity, JulesClient, JulesClientError, extractPullRequestUrl, ownerRepoFromJulesSource } from "./jules-client.js";
import { buildPrompt, hashPromptIdentity, PROMPT_IDENTITY_HASH_VERSION } from "./prompt-builder.js";
import { handleJulesState } from "./state-machine.js";
import { evaluateJulesLifecycleState } from "./state-engine.js";
import { evaluateScopeConformity } from "@pilleo/paperclip-adapter-common";
import { classifyFailure, toErrorFamily, summarizeJulesFailure } from "./failure-classifier.js";
import { shouldRetry, getRetryNotBefore } from "./retry-policy.js";
import { asJulesActivityId, asJulesSessionId, asPaperclipId, asPrUrl } from "./brands.js";
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
  createJulesHumanEscalationInteraction,
  createJulesAgentAdjudicationInteraction,
  createJulesQuestionReviewInteraction,
  answerJulesAgentAdjudicationInteraction,
  resolveJulesAgentAdjudicationInteraction,
  createJulesPlanApprovalInteraction,
  createJulesPlanReviewChildInteraction,
  saveJulesPlanDocument,
  getPaperclipInteraction,
  listPaperclipApprovals,
  listPaperclipInteractions,
  moveIssueToBlocked,
  moveIssueToInProgress,
  postSessionLink,
  readJulesSessionHandle,
  readJulesSessionHandleState,
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
  hasFutureJulesSessionMonitor,
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
import { classifyNativeQuestionReview, evaluateTerminalQuestionDisposition, evaluateTerminalQuestionRecovery, isExpiredQuestionBridge } from "./question-workflow.js";
import { isNativeAgentAdjudication } from "./session.js";
import { createJulesPlanReviewChild } from "./plan-review-client.js";
import { parsePlanAdjudication } from "./plan-adjudication.js";
import { createTelemetry } from "./telemetry.js";
import { decideNativePlanReviewLifecycle } from "./native-plan-review-lifecycle.js";

function assertNever(value: never): never {
  throw new Error(`Unhandled Jules adapter state: ${String(value)}`);
}
import { evaluateJulesIssueOwnership } from "./session-ownership.js";
import { evaluateIssueScopedRun } from "./issue-scoped-run.js";

const JULES_CONTINUATION_DELAY_MS = 60 * 1000;
const JULES_INITIAL_ACTIVITY_CHECK_DELAY_MS = 5 * 1000;

async function nativePlanVerdictIsAttested(input: {
  readonly companyId: string | undefined;
  readonly reviewerAgentId: string;
  readonly reviewerChildIssueId: string | undefined;
  readonly interactionId: string;
  readonly verdict: "approve" | "reject";
  readonly authToken: string | undefined;
  readonly runId: string | undefined;
}): Promise<boolean> {
  const reviewerChildIssueId = input.reviewerChildIssueId;
  if (!input.companyId || !reviewerChildIssueId) return false;
  try {
    const summaries = await getPaperclipJson<unknown[]>(
      `/api/companies/${encodeURIComponent(input.companyId)}/heartbeat-runs?agentId=${encodeURIComponent(input.reviewerAgentId)}&limit=50`,
      input.authToken,
      input.runId,
    );
    const candidateIds = summaries.flatMap((summary) => {
      if (!summary || typeof summary !== "object" || Array.isArray(summary)) return [];
      const record = summary as Record<string, unknown>;
      const context = record["contextSnapshot"];
      const taskId = context && typeof context === "object" && !Array.isArray(context)
        ? (context as Record<string, unknown>)["taskId"]
        : undefined;
      return record["agentId"] === input.reviewerAgentId && record["status"] === "succeeded" &&
          taskId === reviewerChildIssueId && typeof record["id"] === "string"
        ? [record["id"]]
        : [];
    });
    for (const runId of candidateIds) {
      const run = await getPaperclipJson<unknown>(`/api/heartbeat-runs/${encodeURIComponent(runId)}`, input.authToken, input.runId);
      if (hasNativeReviewVerdictAttestation({
        reviewerAgentId: input.reviewerAgentId,
        reviewerChildIssueId,
        interactionId: input.interactionId,
        verdict: input.verdict,
        runs: [run],
      })) return true;
    }
  } catch {
    // The interaction's actor identity remains mandatory when run evidence is
    // temporarily unavailable.  Do not turn a transient read failure into a
    // human override.
  }
  return false;
}

type NativePlanReviewRunEvidence = {
  readonly id: string;
  readonly status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
  readonly issueId: string;
  readonly agentId: string;
  readonly interactionId: string | null;
  readonly interactionKind: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly error?: string;
};

function normalizeNativePlanReviewRuns(rawRuns: readonly unknown[]): NativePlanReviewRunEvidence[] {
  const status = (value: unknown): NativePlanReviewRunEvidence["status"] | null => {
    switch (value) {
      case "queued": return "queued";
      case "running":
      case "active":
      case "claimed": return "running";
      case "succeeded": return "succeeded";
      case "failed": return "failed";
      case "cancelled":
      case "interrupted": return "cancelled";
      case "timed_out": return "timed_out";
      default: return null;
    }
  };
  const nonEmpty = (value: unknown): string | null =>
    typeof value === "string" && value.trim().length > 0 ? value : null;

  return rawRuns.flatMap((raw): NativePlanReviewRunEvidence[] => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const record = raw as Record<string, unknown>;
    const context = record["contextSnapshot"] && typeof record["contextSnapshot"] === "object" &&
      !Array.isArray(record["contextSnapshot"])
      ? record["contextSnapshot"] as Record<string, unknown>
      : {};
    const normalizedStatus = status(record["status"]);
    const id = nonEmpty(record["id"]);
    const agentId = nonEmpty(record["agentId"]);
    const issueId = nonEmpty(context["issueId"]);
    if (!normalizedStatus || !id || !agentId || !issueId) return [];
    const error = nonEmpty(record["error"]);
    return [{
      id,
      status: normalizedStatus,
      issueId,
      agentId,
      interactionId: nonEmpty(context["interactionId"]),
      interactionKind: nonEmpty(context["interactionKind"]),
      startedAt: nonEmpty(record["startedAt"]),
      finishedAt: nonEmpty(record["finishedAt"]),
      ...(error ? { error } : {}),
    }];
  });
}

async function readNativePlanReviewRuns(input: {
  readonly companyId: string;
  readonly reviewerAgentId: string;
  readonly authToken: string | undefined;
  readonly runId: string | undefined;
}): Promise<NativePlanReviewRunEvidence[]> {
  const runs = await getPaperclipJson<unknown[]>(
    `/api/companies/${encodeURIComponent(input.companyId)}/heartbeat-runs?agentId=${encodeURIComponent(input.reviewerAgentId)}&limit=50`,
    input.authToken,
    input.runId,
  );
  return normalizeNativePlanReviewRuns(runs);
}

/**
 * A reviewer rejection asks Jules to publish a replacement plan, not to do a
 * normal long-running coding turn.  Keep that narrow handoff responsive so a
 * provider can neither finish nor supersede the new plan before Paperclip
 * creates its next native review card. This is a provider poll only: it does
 * not add issue comments or send another provider prompt.
 */
function liveSessionPollDelayMs(
  session: JulesAdapterSessionV1,
  initialActivityCheck: boolean,
  normalDelayMs: number,
): number {
  if (initialActivityCheck) return JULES_INITIAL_ACTIVITY_CHECK_DELAY_MS;
  return session.planReviewOutcome === "revision_requested"
    ? JULES_CONTINUATION_DELAY_MS
    : normalDelayMs;
}

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

/**
 * Paperclip can emit an on-demand issue wake for an already-recorded review
 * outcome without attaching that outcome's typed worker-feedback envelope.
 * Such a wake is advisory only: a live native monitor remains authoritative.
 */
function isAdvisoryOnDemandWake(rawContext: Record<string, unknown>): boolean {
  const paperclipWake = readContextRecord(rawContext, "paperclipWake");
  const wakeSource = readContextString(rawContext, "wakeSource") ??
    readContextString(paperclipWake, "wakeSource");
  // This is deliberately a closed allowlist, not a heuristic over arbitrary
  // board comments. It is the one operator-issued event that means the
  // provider was read independently and has a plan ready to synchronize.
  // Generic on-demand wakes remain advisory and cannot spend provider polls.
  if (isProviderPlanSynchronizationWake(rawContext)) return false;
  return wakeSource === "on_demand" && !isInteractionWake(rawContext);
}

/** An operator-confirmed provider-plan event invalidates any completed activity cache. */
function isProviderPlanSynchronizationWake(rawContext: Record<string, unknown>): boolean {
  const paperclipWake = readContextRecord(rawContext, "paperclipWake");
  return (readContextString(rawContext, "wakeReason") ??
    readContextString(paperclipWake, "wakeReason")) === "synchronize_provider_plan_ready";
}

type MonitoredJulesSession = JulesAdapterSessionV1 & {
  readonly julesSessionId: NonNullable<JulesAdapterSessionV1["julesSessionId"]>;
};

type AdvisoryMonitorWakeDecision =
  | { readonly action: "execute" }
  | { readonly action: "defer_to_monitor"; readonly session: MonitoredJulesSession };

/**
 * A future monitor can suppress only an advisory duplicate wake. A persisted
 * retry is an execution command: it may be the one opportunity to replace a
 * terminal provider session on its already-created PR branch. Treating it as
 * advisory causes an infinite loop in which Paperclip repeatedly restores the
 * terminal session and Jules never receives the recovery prompt.
 */
function decideAdvisoryMonitorWake(input: {
  readonly workerFeedbackPresent: boolean;
  readonly rawContext: Record<string, unknown>;
  readonly session: JulesAdapterSessionV1 | null;
}): AdvisoryMonitorWakeDecision {
  const session = input.session;
  if (
    input.workerFeedbackPresent ||
    !session?.julesSessionId ||
    !isAdvisoryOnDemandWake(input.rawContext)
  ) {
    return { action: "execute" };
  }
  // Re-materialize the session with its checked identity required. This keeps
  // the deferred branch unable to accidentally serialize or poll an undefined
  // provider id under exact optional-property checking.
  const monitoredSession: MonitoredJulesSession = {
    ...session,
    julesSessionId: session.julesSessionId,
  };

  switch (session.phase) {
    case "RETRY_SCHEDULED":
      return { action: "execute" };
    case "STARTING":
    case "RUNNING":
    case "WAITING_FOR_FEEDBACK":
    case "WAITING_FOR_PLAN_APPROVAL":
    case "PR_CREATED":
    case "COMPLETED":
    case "FAILED":
      return { action: "defer_to_monitor", session: monitoredSession };
    default:
      return assertNever(session.phase);
  }
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
    const delayMs = liveSessionPollDelayMs(
      session,
      initialActivityCheck,
      reattachDelayMs ?? JULES_CONTINUATION_DELAY_MS,
    );
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
        // `planApprovedAt` is session history, not the current plan gate. A
        // regenerated plan can legitimately require review after an earlier
        // plan was approved; the phase is the authoritative state-machine
        // result for this heartbeat.
        planPending: session.phase === "WAITING_FOR_PLAN_APPROVAL",
        // Do not expose a prose nextAction here. Paperclip promotes it into
        // run liveness and immediately retries the worker, bypassing this
        // result's retryNotBefore. The durable Jules monitor is the sole
        // authority for normal provider polling cadence.
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

  // Paperclip's cross-issue guard requires the persisted heartbeat run to carry
  // this issue as its source. A generic agent wake can have a valid JWT and run
  // id while still lacking that source issue; allowing it into the mutation
  // paths only produces a deterministic 403 and, historically, retry noise.
  // Reads remain available to diagnostics, but production mutations/polling
  // must wait for the issue monitor to create a scoped run.
  const issueScope = evaluateIssueScopedRun({
    runId: ctx.runId,
    context: {
      ...rawCtx,
      ...readContextRecord(rawCtx, "contextSnapshot"),
    },
    issueId: String(effectiveTaskId),
  });
  if (issueScope.kind === "unscoped" && process.env["NODE_ENV"] !== "test") {
    await ctx.onLog?.("stderr", `[jules] Skipping unscoped run: ${issueScope.code}. Waiting for an issue-scoped Paperclip monitor heartbeat.\n`);
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: `Jules heartbeat skipped: ${issueScope.code}; no Paperclip mutation attempted.`,
      sessionParams: ctx.runtime?.sessionParams ?? null,
      sessionDisplayId: resumedSessionId ?? null,
      resultJson: { provider: "jules", issueId: String(effectiveTaskId), skipped: true, reason: issueScope.code },
      clearSession: false,
    };
  }

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
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: unknown }> => {
    // A resolved visible strong-review card also wakes the Jules assignee.
    // Human cards have their own wake continuation. Native reviewer forms are
    // also monitored while healthy; a denied monitor mutation is handled as a
    // narrow authorization fallback at the yield boundary below.
    const humanWait = current.pendingInteraction?.type === "user_feedback" ||
      current.pendingInteraction?.type === "plan_approval" ||
      current.pendingInteraction?.type === "completion_confirmation";
    if (humanWait || !current.julesSessionId) return { ok: true };
    const delayMs = liveSessionPollDelayMs(current, initialActivityCheck, reattachDelayMs);
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
      return { ok: true };
    } catch (error) {
      await ctx.onLog?.(
        "stderr",
        `[jules] Could not schedule the next Paperclip monitor; session ${current.julesSessionId} remains resumable: ${sanitizeError(error)}\n`,
      );
      return { ok: false, error };
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
  let earlyPrDetails: Awaited<ReturnType<typeof getPullRequestDetails>> | undefined;
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
      earlyPrDetails = prDetails;
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

  let durableIssueHandle = null;
  try {
    durableIssueHandle = await readJulesSessionHandleState(taskId, ctx.authToken, ctx.runId);
  } catch (error) {
    await ctx.onLog?.("stderr", `[jules] Could not read durable Paperclip session handle: ${sanitizeError(error)}\n`);
  }

  let issueHandleSessionId: string | null = null;
  if (shouldReadIssueSessionHandle({
    hasSession: Boolean(session),
    hasCanonicalSessionId: Boolean(canonicalSessionId),
    hasStoredRecoverySession: Boolean(storedRecoverySession),
  })) {
    try {
      issueHandleSessionId = durableIssueHandle?.sessionId ?? await readJulesSessionHandle(taskId, ctx.authToken, ctx.runId);
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
    session = preferBranchBoundRecoveryHandle(
      session,
      durableIssueHandle,
      { repository: config.repository, source: config.source, baseBranch: config.baseBranch, taskId },
      session?.createdAt ?? new Date().toISOString(),
    );
    // A wake contains routing data, not arbitrary adapter payload.  Recover
    // the immutable identity from Jules' own issue document before scanning
    // native verdicts, so a restart cannot turn a valid rejection into an
    // ambiguous URL-only match.  Never merge a head from another PR.
    if (session) {
      try {
        const handle = durableIssueHandle;
        if (handle && handle.sessionId === session.julesSessionId) {
          const restored = restoreBranchBoundRemediationFromHandle(session, handle, session.createdAt);
          if (restored !== session) {
            session = restored;
            await ctx.onLog?.("stdout", "[jules] Restored branch-bound remediation fence from the Jules session handle.\n");
          }
        }
        // A complete handle is written by the Jules assignee and binds the
        // session to an immutable PR identity. It therefore also repairs a
        // legacy local checkpoint whose PR URL was a historical placeholder.
        // A partial handle never overrides runtime state.
        if (handle && handle.sessionId === session.julesSessionId &&
            handle.prUrl && handle.headSha &&
            (session.currentPrUrl !== asPrUrl(handle.prUrl) || session.currentPrHeadSha !== handle.headSha)) {
          session = {
            ...session,
            currentPrUrl: asPrUrl(handle.prUrl),
            currentPrHeadSha: handle.headSha,
          };
          await ctx.onLog?.("stdout", `[jules] Restored immutable PR head from the Jules session handle.\n`);
        }
        if (handle && handle.sessionId === session.julesSessionId &&
            (!session.deliveredFeedbackActivityId || !session.deliveredFeedbackInteractionId) &&
            handle.deliveredFeedbackActivityId && handle.deliveredFeedbackInteractionId) {
          session = {
            ...session,
            deliveredFeedbackActivityId: session.deliveredFeedbackActivityId ?? asJulesActivityId(handle.deliveredFeedbackActivityId),
            deliveredFeedbackInteractionId: session.deliveredFeedbackInteractionId ?? handle.deliveredFeedbackInteractionId,
          };
          await ctx.onLog?.("stdout", `[jules] Restored typed feedback delivery checkpoint from the Jules session handle.\n`);
        }
      } catch (error) {
        await ctx.onLog?.("stderr", `[jules] Could not restore PR identity from the Jules session handle: ${sanitizeError(error)}\n`);
      }
      // An early generic recovery used to overwrite the durable session
      // document with its replacement provider ID, even though the issue had
      // already registered a primary PR. Rehydrate only an absent identity
      // from that primary work product; an existing identity remains fenced
      // by its own URL and immutable head.
      if (!session.currentPrUrl && earlyPrUrl && earlyPrDetails?.headSha && earlyPrDetails.headRefName) {
        session = recoverPrIdentityFromWorkProduct(session, {
          url: earlyPrUrl,
          headSha: earlyPrDetails.headSha,
          headRefName: earlyPrDetails.headRefName,
        });
        await persistSessionBestEffort(session, ctx.onLog, { authToken: ctx.authToken, runId: ctx.runId });
        await ctx.onLog?.("stdout", `[jules] Rehydrated immutable PR handoff from the primary Paperclip work product.\n`);
      }
    }
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

  if (session?.terminalActivityScan && isProviderPlanSynchronizationWake(rawContext)) {
    // An operator only emits this typed wake after observing a provider plan.
    // Older recovery records can otherwise retain a completed scan from before
    // the plan was published and permanently hide it. Persist before polling so
    // a configuration refresh cannot restore that stale cache mid-recovery.
    session.terminalActivityScan = undefined;
    await persistSessionBestEffort(session, ctx.onLog, { authToken: ctx.authToken, runId: ctx.runId });
    await ctx.onLog?.("stdout", "[jules] Cleared terminal activity cache for explicit provider-plan synchronization.\n");
  }

  await ctx.onLog?.("stdout", `[jules] Reconciled session checkpoint: pending=${session?.pendingInteraction?.type ?? "none"}, questionTransport=${session?.pendingInteraction?.type === "agent_adjudication" && "transport" in session.pendingInteraction ? session.pendingInteraction.transport ?? "legacy" : "n/a"}, questionReviewer=${config.questionAdjudicatorAgentId ?? config.questionReviewerAgentId ?? "none"}.\n`);

  // Native reviewer feedback is a typed wake payload, not a human comment or
  // free-form wake reason. Process it before the normal completed-session
  // retry path so an existing PR can be revised in place.
  const wakeRecord = rawContext["paperclipWake"] && typeof rawContext["paperclipWake"] === "object"
    ? rawContext["paperclipWake"] as Record<string, unknown>
    : undefined;
  const payloadRecord = rawContext["payload"] && typeof rawContext["payload"] === "object"
    ? rawContext["payload"] as Record<string, unknown>
    : undefined;
  const wakePayloadRecord = wakeRecord?.["payload"] && typeof wakeRecord["payload"] === "object"
    ? wakeRecord["payload"] as Record<string, unknown>
    : undefined;
  let workerFeedback = parseWorkerFeedback(
    rawContext["workerFeedback"] ?? payloadRecord?.["workerFeedback"] ??
    wakeRecord?.["workerFeedback"] ?? wakePayloadRecord?.["workerFeedback"],
  );
  // PR feedback and plan review are different state machines. A structured
  // rejection for this session's exact submitted head wins over a stale plan
  // card; otherwise a completed session can poll forever behind Terra's card.
  // This is deliberately identity-only: reviewer prose and URL-only matches
  // are never allowed to reopen a provider session.
  if (workerFeedback && session?.currentPrUrl) {
    const pendingPlanReview = session.pendingInteraction?.type === "plan_native_review"
      ? session.pendingInteraction
      : undefined;
    const rejection = workerFeedback.reviewStage === "luna" || workerFeedback.reviewStage === "terra"
      ? {
          interactionId: workerFeedback.reviewInteractionId,
          prUrl: workerFeedback.prUrl,
          headSha: workerFeedback.headSha,
          stage: workerFeedback.reviewStage,
          reason: workerFeedback.reason,
        }
      : undefined;
    // Legacy sessions created before `currentPrHeadSha` existed have no safe
    // restart-recovery identity. A direct orchestrator wake is different: its
    // typed envelope is bound to the answered native card, so it may seed the
    // missing immutable head exactly once. Do not apply this migration to the
    // interaction-scan fallback below.
    const directFeedbackHead = session.currentPrHeadSha ?? workerFeedback.headSha;
    const handoff = decideReviewHandoff({
      providerState: session.julesState ?? "UNKNOWN",
      currentPr: { url: session.currentPrUrl, headSha: directFeedbackHead },
      ...(pendingPlanReview ? { pendingPlanReview: { interactionId: pendingPlanReview.paperclipInteractionId, stage: pendingPlanReview.stage } } : {}),
      ...(rejection ? { rejection } : {}),
      ...(session.workerFeedbackDeliveryId ? { deliveredRejectionDeliveryId: session.workerFeedbackDeliveryId } : {}),
    });
    if (handoff.action === "relay_pr_rejection" && handoff.supersedePlanInteractionId) {
      await withdrawPaperclipInteraction(
        taskId,
        handoff.supersedePlanInteractionId,
        PR_REJECTION_SUPERSEDED_PLAN_REASON,
        ctx.authToken,
        ctx.runId,
      );
      session.pendingInteraction = undefined;
      session.planReviewOutcome = "superseded_pr_rejection";
      session.currentPrHeadSha = directFeedbackHead;
      await persistSessionBestEffort(session, ctx.onLog);
    }
  }
  // Paperclip's stale-assignment recovery starts Jules directly and therefore
  // cannot include the orchestrator wake payload. Native review interactions
  // are authoritative, so recover the same typed envelope from the issue on
  // this path instead of repeatedly polling a completed session with no action.
  // Built-in local Paperclip adapters may have no authToken; their local
  // trusted client is intentionally allowed to read issue interactions.
  if (!workerFeedback && session?.currentPrUrl) {
    try {
      // A completed session already persisted the exact head it submitted for
      // review. GitHub is a freshness check, not the only source of that
      // immutable identity: a short GitHub outage must not drop a structured
      // rejection and leave the session stuck behind an old plan card.
      let currentHeadSha = session.currentPrHeadSha;
      try {
        const currentPrDetails = await getPullRequestDetails(session.currentPrUrl);
        currentHeadSha = currentPrDetails.headSha ?? currentHeadSha;
      } catch (error) {
        if (!currentHeadSha) throw error;
        await ctx.onLog?.("stderr", `[jules] GitHub head lookup failed; recovering only the persisted immutable PR head: ${sanitizeError(error)}\n`);
      }
      if (!currentHeadSha) throw new Error("GitHub did not provide the current PR head SHA");
      const interactions = await listPaperclipInteractions(taskId, ctx.authToken, ctx.runId);
      const rejection = interactions.find((interaction) => {
        if (interaction.kind !== "request_item_verdicts" || interaction.status !== "answered") return false;
        const key = interaction.idempotencyKey || "";
        if (!key.includes(`${session!.currentPrUrl!}:${currentHeadSha}:`)) return false;
        const result = interaction.result;
        if (!result || typeof result !== "object") return false;
        const items = (result as Record<string, unknown>)["items"];
        if (!Array.isArray(items)) return false;
        return items.some((item) => item && typeof item === "object" &&
          (item as Record<string, unknown>)["id"] === "pull_request" &&
          (item as Record<string, unknown>)["verdict"] === "reject" &&
          typeof (item as Record<string, unknown>)["reason"] === "string" &&
          Boolean(String((item as Record<string, unknown>)["reason"]).trim()));
      });
      if (rejection) {
        const result = rejection.result as { items: Array<{ id?: string; reason?: string }> };
        const item = result.items.find((candidate) => candidate.id === "pull_request");
        const stageMatch = (rejection.idempotencyKey || "").match(/:(luna|terra|vibe|strong)(?::attempt:\d+)?$/i);
        const stageValue = stageMatch?.[1]?.toLowerCase();
        const stage: "luna" | "terra" | "vibe" | "strong" =
          stageValue === "luna" || stageValue === "terra" || stageValue === "vibe" || stageValue === "strong"
            ? stageValue
            : "strong";
        workerFeedback = {
          version: 1,
          kind: "code_review_rejection",
          deliveryId: `native-review:${rejection.id}:${currentHeadSha}`,
          issueId: taskId,
          reviewInteractionId: rejection.id,
          reviewStage: stage,
          prUrl: session.currentPrUrl,
          headSha: currentHeadSha,
          reason: String(item?.reason || "Native reviewer requested changes."),
          createdAt: new Date().toISOString(),
        };
        await ctx.onLog?.("stdout", `[jules] Recovered native review rejection ${rejection.id} from Paperclip issue state.\n`);
      }
    } catch (error) {
      await ctx.onLog?.("stderr", `[jules] Could not recover native review rejection: ${sanitizeError(error)}\n`);
    }
  }
  const advisoryMonitorWake = decideAdvisoryMonitorWake({
    workerFeedbackPresent: Boolean(workerFeedback),
    rawContext,
    session,
  });
  if (advisoryMonitorWake.action === "defer_to_monitor") {
    const monitoredSession = advisoryMonitorWake.session;
    try {
      if (await hasFutureJulesSessionMonitor(taskId, monitoredSession.julesSessionId, ctx.authToken, ctx.runId)) {
        await ctx.onLog?.(
          "stdout",
          `[jules] Deferring advisory on-demand wake to the existing Jules monitor; no cloud poll was needed.\n`,
        );
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          sessionParams: serializeSession(monitoredSession),
          sessionDisplayId: monitoredSession.julesSessionId,
          resultJson: {
            provider: "jules",
            issueId: taskId,
            skipped: true,
            reason: "future_jules_monitor",
          },
          clearSession: false,
        };
      }
    } catch (error) {
      // A failed advisory read must not prevent a due/provider recovery poll.
      await ctx.onLog?.("stderr", `[jules] Could not inspect the existing monitor: ${sanitizeError(error)}\n`);
    }
  }
  // Recovery reconstructs the same typed envelope after the direct-wake
  // branch above. Re-run the pure precedence rule here so a lost wake cannot
  // leave its old plan card live while the rejection is delivered.
  if (workerFeedback && session?.currentPrUrl && session.pendingInteraction?.type === "plan_native_review") {
    const pendingPlanReview = session.pendingInteraction;
    const rejection = workerFeedback.reviewStage === "luna" || workerFeedback.reviewStage === "terra"
      ? {
          interactionId: workerFeedback.reviewInteractionId,
          prUrl: workerFeedback.prUrl,
          headSha: workerFeedback.headSha,
          stage: workerFeedback.reviewStage,
          reason: workerFeedback.reason,
        }
      : undefined;
    const handoff = decideReviewHandoff({
      providerState: session.julesState ?? "UNKNOWN",
      currentPr: { url: session.currentPrUrl, headSha: session.currentPrHeadSha },
      pendingPlanReview: { interactionId: pendingPlanReview.paperclipInteractionId, stage: pendingPlanReview.stage },
      ...(rejection ? { rejection } : {}),
      ...(session.workerFeedbackDeliveryId ? { deliveredRejectionDeliveryId: session.workerFeedbackDeliveryId } : {}),
    });
    if (handoff.action === "relay_pr_rejection" && handoff.supersedePlanInteractionId) {
      await withdrawPaperclipInteraction(
        taskId,
        handoff.supersedePlanInteractionId,
        PR_REJECTION_SUPERSEDED_PLAN_REASON,
        ctx.authToken,
        ctx.runId,
      );
      session.pendingInteraction = undefined;
      session.planReviewOutcome = "superseded_pr_rejection";
      await persistSessionBestEffort(session, ctx.onLog);
    }
  }
  if (workerFeedback && session?.julesSessionId) {
    if (session.workerFeedbackDeliveryId === workerFeedback.deliveryId) {
      await ctx.onLog?.("stdout", `[jules] Worker feedback ${workerFeedback.deliveryId} was already delivered; skipping duplicate wake.\n`);
      // The duplicate guard applies only to sendMessage. Do not return here:
      // scheduled heartbeats still must poll Jules and mirror any subsequent
      // question, plan, PR, or completion activity from the provider.
      workerFeedback = null;
    }
    if (workerFeedback && session.currentPrUrl && session.currentPrUrl !== workerFeedback.prUrl) {
      await ctx.onLog?.("stderr", `[jules] Ignoring worker feedback for ${workerFeedback.prUrl}; session is bound to ${session.currentPrUrl}.\n`);
    } else if (workerFeedback) {
      await client.sendMessage(session.julesSessionId, { prompt: workerFeedbackPrompt(workerFeedback) });
      // Persist the canonical identity generated from the native card, not
      // only an incidental wake payload value. Recovery scans and direct wakes
      // must consume the same rejection exactly once.
      session.workerFeedbackDeliveryId = workerFeedback.deliveryId || nativePrRejectionDeliveryId({
        interactionId: workerFeedback.reviewInteractionId,
        headSha: workerFeedback.headSha,
      });
      session.providerContinuation = {
        deliveryId: session.workerFeedbackDeliveryId,
        state: "sent_awaiting_provider",
        sentAt: new Date().toISOString(),
      };
      session.phase = "RUNNING";
      session.julesState = "IN_PROGRESS";
      await persistSessionBestEffort(session, ctx.onLog);
      await scheduleLiveSessionMonitor(session, true);
      return createPendingResult(session, true);
    }
  }

  // A Jules cloud session may finish after Paperclip has reassigned or closed
  // its issue.  Do this ownership fence before any completion/plan mutation:
  // Paperclip's 403 is a correct authorization decision, not a retryable Jules
  // failure.  Confirmed handoffs clear the stale recovery record so the same
  // completed session cannot be resurrected on every heartbeat.
  if (session && process.env["NODE_ENV"] !== "test") {
    let ownership = evaluateJulesIssueOwnership({ julesAgentId: ctx.agent.id });
    let currentIssue: Awaited<ReturnType<typeof getPaperclipIssue>> | null = null;
    try {
      currentIssue = await getPaperclipIssue(taskId, ctx.authToken, ctx.runId);
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
    if ((ownership === "transferred" || ownership === "missing") && currentIssue &&
        shouldReclaimBranchBoundRecovery({
          session,
          issue: currentIssue,
          interactions: await listPaperclipInteractions(taskId, ctx.authToken, ctx.runId).catch(() => []),
        })) {
      await moveIssueToInProgress(
        taskId,
        ctx.authToken,
        "Restored the branch-bound Jules recovery while its exact typed provider form remains pending.",
        ctx.runId,
      );
      ownership = "owned";
      await ctx.onLog?.("stdout", `[jules] Reclaimed branch-bound recovery ownership for its pending typed provider form.\n`);
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
      let pendingNativePlanReview = session?.pendingInteraction?.type === "plan_native_review"
        ? session.pendingInteraction : null;
  let completionResolutionStatus: "accepted" | "rejected" | null =
    interactionKind === "request_confirmation" &&
      (interactionStatus === "accepted" || interactionStatus === "rejected")
      ? interactionStatus
      : null;

  // Continuation recovery can wake the assignee with only generic issue
  // context. The persisted native card is authoritative in that case. Without
  // this read, a rejected completion card is mistaken for an unresolved one
  // and the terminal poll repeats `moveIssueToBlocked`, which Paperclip
  // correctly rejects after the card is no longer pending.
  if (pendingCompletion && !completionResolutionStatus) {
    try {
      const persistedCompletion = await getPaperclipInteraction(
        taskId,
        pendingCompletion.paperclipInteractionId,
        ctx.authToken,
        ctx.runId,
      );
      switch (persistedCompletion?.status) {
        case "accepted":
        case "rejected":
          completionResolutionStatus = persistedCompletion.status;
          break;
        default:
          break;
      }
    } catch (error) {
      return paperclipInteractionFailure(session!, error);
    }
  }
  const isCompletionResolution = completionResolutionStatus !== null;

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
    // A generic continuation wake has no interaction id. Once the persisted
    // card above proves it terminal, absence is not a mismatch; only an
    // explicitly different id is stale.
    if (interactionId && interactionId !== pendingCompletion.paperclipInteractionId) {
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
      if (completionResolutionStatus === "accepted") {
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
      // The pending confirmation was created only after the first terminal
      // poll had already moved this issue to blocked. Rejecting it consumes
      // the session checkpoint; repeating the same transition after the card
      // is resolved violates Paperclip's blocker invariant (422).
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
          // end. Keep the Jules assignee and monitor alive while it publishes
          // the replacement plan; moving the parent to blocked clears that
          // ownership and strands the native-review recovery path.
          await client.sendMessage(
            session!.julesSessionId!,
            { prompt: `The Paperclip plan review rejected the current plan.${reason ? ` Feedback: ${reason}` : " Please regenerate the plan with the requested changes."}` },
          );
          session!.pendingInteraction = undefined;
          session!.phase = "RUNNING";
          await persistSessionBestEffort(session!, ctx.onLog);
          await moveIssueToInProgress(
            taskId,
            ctx.authToken,
            "Jules received plan-revision feedback and will regenerate the plan.",
            ctx.runId,
          );
          await scheduleLiveSessionMonitor(session!, true);
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            sessionParams: serializeSession(session!),
            sessionDisplayId: session!.julesSessionId ?? null,
            summary: "Jules received the plan rejection feedback and will regenerate its plan asynchronously.",
            resultJson: { provider: "jules", issueStatus: "in_progress" },
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
          session!.planApprovedActivityId = pendingProviderInteraction.julesActivityId;
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

    const remediation = isRetry ? session?.prRemediation : undefined;
    const prompt = remediation
      ? `${buildPrompt(promptContext, config)}\n\n${remediation.reason === "terminal_plan_revision_unavailable"
        ? `This is plan-cycle recovery for existing pull request ${remediation.prUrl} on branch ${remediation.headRefName}. The prior Jules session was terminal and could not publish its requested revision. Do not create a new pull request. Publish a fresh plan activity before implementation so Paperclip can run a new typed review cycle.`
        : `This is PR remediation. Continue the existing pull request ${remediation.prUrl} on branch ${remediation.headRefName}. Do not create a new pull request.`}`
      : buildPrompt(promptContext, config);
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
                  // A terminal provider failure after a PR handoff is not a
                  // fresh task. Jules must resume the PR branch; starting at
                  // baseBranch can only produce an unrelated replacement PR.
                  startingBranch: remediation?.headRefName ?? config.baseBranch
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
        ...(remediation ? {
          currentPrUrl: remediation.prUrl,
          currentPrHeadSha: remediation.headSha,
          currentPrHeadRef: remediation.headRefName,
          prRegisteredOnBoard: true,
          prRemediation: { ...remediation, recoverySessionId: julesSession.id },
        } : {}),
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
    // The Jules parent and reviewer child own independent continuations. The
    // addressed child card wakes only its reviewer; this parent monitor must
    // remain durable so Jules can observe the verdict or newer provider
    // activity without Paperclip classifying the parent as stranded.
    const monitor = await scheduleLiveSessionMonitor(current, initialActivityCheck);
    if (!monitor.ok) {
      const nativeQuestionWait = current.pendingInteraction?.type === "agent_adjudication" &&
        isNativeAgentAdjudication(current.pendingInteraction);
      // The parent question card has continuationPolicy=wake_assignee. Once
      // its typed child form is answered, resolving the parent is enough to
      // wake Jules. Some delegated run contexts are permitted to create that
      // form but forbidden to PATCH the parent monitor; keep this exact wait
      // successful instead of converting a valid native continuation into a
      // failed adapter run.
      if (nativeQuestionWait && monitor.error instanceof PaperclipClientError && monitor.error.status === 403) {
        const pending = createPendingResult(current, initialActivityCheck, reattachDelayMs);
        return {
          ...pending,
          summary: `Jules session ${current.julesSessionId} is awaiting its typed strong-review decision.`,
          resultJson: {
            ...(pending.resultJson as Record<string, unknown>),
            continuation: "parent_question_wake",
            monitorAuthorizationFallback: true,
          },
        };
      }
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "paperclip_monitor_schedule_failed",
        errorFamily: "transient_upstream",
        errorMessage: sanitizeError(monitor.error),
        retryNotBefore: new Date(Date.now() + reattachDelayMs).toISOString(),
        sessionParams: serializeSession(current),
        sessionDisplayId: current.julesSessionId ?? null,
        clearSession: false,
        resultJson: {
          provider: "jules",
          julesSessionId: current.julesSessionId,
          issueStatus: "in_progress",
          continuation: "monitor_unverified",
        },
      };
    }
    const pending = createPendingResult(current, initialActivityCheck, reattachDelayMs);
    return {
      ...pending,
      ...(outcome?.summary ? { summary: outcome.summary } : {}),
      resultJson: {
        ...(pending.resultJson as Record<string, unknown>),
        ...(current.pendingInteraction?.type === "plan_native_review"
          ? { continuation: "jules_session_monitor" }
          : {}),
        ...(outcome?.resultJson ?? {}),
      },
    };
  };

  /**
   * CI remediation is provider feedback, never a review verdict. Keeping it
   * in one identity-keyed path prevents a coarse Jules state from creating a
   * fabricated question card or repeatedly sending the same instruction.
   */
  const relayCiRemediationOnce = async (
    prUrl: string,
    headSha: string | undefined,
    ciStatus: "failed" | "stalled",
  ): Promise<AdapterExecutionResult> => {
    const current = session;
    if (!current) throw new Error("Missing Jules session while relaying CI remediation");
    const ciFailureFingerprint = `${prUrl}:${headSha ?? "unknown"}:${ciStatus}`;
    if (current.ciFailureFingerprint !== ciFailureFingerprint) {
      await client.sendMessage(current.julesSessionId!, {
        prompt: ciStatus === "stalled"
          ? "The existing pull request CI has stalled beyond the bounded wait. Inspect the currently running GitHub check, fix the command or lifecycle condition that prevents it from completing, run the focused verification, and push an update to the same PR. Do not open a new session or pull request."
          : "The existing pull request has CI failed. Inspect the failing GitHub check, fix only the reported failure on the current branch, run the focused verification, and push an update to the same PR. Do not open a new session or pull request.",
      });
      current.ciFailureFingerprint = ciFailureFingerprint;
      await persistSessionBestEffort(current, ctx.onLog, { authToken: ctx.authToken, runId: ctx.runId });
    }
    await ctx.onLog?.("stderr", `[jules] Pull request ${prUrl} CI build checks ${ciStatus}.\n`);
    current.phase = "RUNNING";
    return await yieldHeartbeat(current);
  };

  /**
   * A terminal provider can no longer accept CI feedback. Schedule one new
   * session on the immutable PR branch instead. This deliberately fails
   * closed when GitHub did not return the branch identity: generic retries
   * start at baseBranch and would create a second PR.
   */
  const scheduleTerminalPrRemediation = async (
    reason: "ci_failure" | "terminal_plan_revision_unavailable" = "ci_failure",
  ): Promise<AdapterExecutionResult> => {
    const current = session;
    if (!current?.currentPrUrl || !current.julesSessionId) {
      throw new Error("Missing terminal PR identity while scheduling remediation");
    }
    const headSha = current.currentPrHeadSha;
    const headRefName = current.currentPrHeadRef;
    if (!headSha || !headRefName) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "jules_pr_remediation_identity_missing",
        errorFamily: null,
        errorMessage: "Jules delivered a PR but GitHub did not provide its immutable head SHA and branch; refusing to start a generic retry from the base branch.",
        sessionParams: serializeSession(current),
        clearSession: false,
      };
    }
    current.prRemediation = {
      originalSessionId: current.julesSessionId,
      prUrl: current.currentPrUrl,
      headSha,
      headRefName,
      reason,
      startedAt: new Date().toISOString(),
    };
    current.phase = "RETRY_SCHEDULED";
    await persistSessionBestEffort(current, ctx.onLog, { authToken: ctx.authToken, runId: ctx.runId });
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: reason === "terminal_plan_revision_unavailable"
        ? "jules_terminal_plan_recovery_scheduled"
        : "jules_pr_remediation_scheduled",
      errorFamily: "transient_upstream",
      errorMessage: reason === "terminal_plan_revision_unavailable"
        ? "Jules remained terminal after accepting a plan-revision request; scheduling one branch-bound plan-cycle recovery session."
        : "Jules reached a terminal state after delivering a PR; scheduling one branch-bound remediation session.",
      retryNotBefore: new Date(getRetryNotBefore(current.attempt)).toISOString(),
      sessionParams: serializeSession(current),
      clearSession: false,
    };
  };

  // Compatibility migration for sessions created before the native review
  // ladder. A legacy human card is not a native verdict; create the one
  // reviewer-owned native card directly rather than briefly creating a
  // parent-owned form and migrating it again on the next heartbeat.
  if (
    pendingProviderInteraction?.type === "plan_approval" &&
    storedPendingInteraction?.status === "pending" &&
    config.planReviewerAgentId && config.planStrongReviewerAgentId
  ) {
    if (config.planReviewerAgentId && config.planStrongReviewerAgentId) {
      const reviewerChild = await createJulesQuestionAdjudication(
        taskId,
        pendingProviderInteraction.question,
        config.planReviewerAgentId,
        ctx.authToken,
        ctx.runId,
        ctx.agent.companyId,
        pendingProviderInteraction.julesActivityId,
        session.julesSessionId,
        0,
        true,
        "plan",
      );
      const nativeReview = await createJulesPlanReviewChildInteraction(
        reviewerChild.id,
        taskId,
        session.julesSessionId!,
        {
          documentId: pendingProviderInteraction.planDocumentId,
          revisionId: pendingProviderInteraction.planRevisionId,
          revisionNumber: pendingProviderInteraction.planRevisionNumber,
        },
        pendingProviderInteraction.question,
        "luna",
        config.planReviewerAgentId,
        ctx.authToken,
        ctx.runId,
        pendingProviderInteraction.julesActivityId,
      );
      if (pendingProviderInteraction.paperclipInteractionId) {
        await withdrawPaperclipInteraction(taskId, pendingProviderInteraction.paperclipInteractionId, "Replaced by native ACP plan-review ladder", ctx.authToken, ctx.runId).catch(() => undefined);
      }
      session.pendingInteraction = {
        type: "plan_native_review",
        protocolVersion: 2,
        julesActivityId: pendingProviderInteraction.julesActivityId,
        question: pendingProviderInteraction.question,
        planRevisionId: pendingProviderInteraction.planRevisionId,
        planRevisionNumber: pendingProviderInteraction.planRevisionNumber,
        planDocumentId: pendingProviderInteraction.planDocumentId,
        paperclipInteractionId: nativeReview.id,
        reviewerAgentId: config.planReviewerAgentId,
        stage: "luna",
        reviewerChildIssueId: reviewerChild.id,
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
      session.planApprovedActivityId = pendingProviderInteraction.julesActivityId;
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
      // A terminal PR handoff has one authoritative PR snapshot per poll.
      // Re-probing CI later can disagree with that snapshot or hang after the
      // provider has completed, which keeps the Jules monitor alive and
      // prevents the orchestrator from claiming the native review workflow.
      let terminalPrDetails: Awaited<ReturnType<typeof getPullRequestDetails>> | undefined;
      let scopeDriftSummary: string | undefined;
      let scopeDriftIsNew = false;
      session.julesState = state;
      const providerReconciliation = reconcileProviderState({
        remoteState: state,
        persistedPhase: session.phase,
        hasPersistedPr: Boolean(session.currentPrUrl),
        remotePollSucceeded: true,
      });
      if (providerReconciliation.action === "continue_live" && providerReconciliation.clearStalePr) {
        // A run-scoped configuration refresh can replay an old completed PR
        // checkpoint. A successful nonterminal provider poll is authoritative:
        // do not hand the stale PR to review or clear this session's monitor.
        session.currentPrUrl = undefined;
        session.currentPrHeadSha = undefined;
        session.prRegisteredOnBoard = undefined;
      }
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
      const discoveredPrUrl = extractPullRequestUrl(julesSession, config.repository);
      const prUrl = selectTerminalPullRequestUrl({
        state,
        discovered: discoveredPrUrl,
        persisted: session.currentPrUrl,
      });
      // Activity is the provider protocol boundary. Capture it before any
      // GitHub/PR inspection so a slow or unavailable PR lookup cannot hide a
      // Jules question. The same immutable snapshot is reused below.
      const deliveredActivityIdsBeforePoll = new Set(session.deliveredActivityIds ?? []);
      let activities: JulesActivity[] = [];
      try {
        if (terminalProviderState) {
          // Terminal questions and the terminal PR/CI disposition share one
          // activity boundary. Scan the same bounded history budget used by
          // live activity reconciliation in this heartbeat; yielding after
          // each page can postpone a known terminal question or CI failure by
          // hours on long-lived Jules sessions.
          let next = session.terminalActivityScan;
          const scannedThisHeartbeat: JulesActivity[] = [];
          for (let pageCount = 0; (!next?.complete) && pageCount < MAX_ACTIVITY_PAGES; pageCount += 1) {
            const page = await client.getActivities(session.julesSessionId, next?.nextPageToken, 100);
            scannedThisHeartbeat.push(...page.activities);
            next = reduceTerminalActivityScan({
              sessionId: session.julesSessionId,
              ...(next ? { prior: next } : {}),
              activities: page.activities,
              ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
            });
          }
          if (!next) throw new Error("Terminal Jules activity scan did not produce a checkpoint");
          session.terminalActivityScan = next;
          // The scan stores only two durable witnesses; restore their actual
          // provider order before every downstream state-machine predicate.
          // Inserting completion first would falsely make any historical
          // message look post-completion and reopen its reviewer bridge.
          const terminalWitnesses = normalizeActivities([next.completion, next.latestPlan, next.latestAgentMessage]
            .filter((item): item is NonNullable<typeof item> => Boolean(item))
            .map(terminalEvidenceActivity));
          await mirrorActivities(
            normalizeActivities([...scannedThisHeartbeat, ...terminalWitnesses]),
            session,
            taskId,
            ctx.authToken,
            ctx.runId,
            ctx.onLog,
          );
          // Mirroring intentionally returns only newly delivered activities.
          // Terminal control flow also needs the current durable witnesses:
          // after a plan rejection, a revised plan may already be mirrored by
          // the recovery heartbeat that found it. Do not let that delivery
          // checkpoint erase the plan from the later native-review decision.
          activities = terminalWitnesses;
          await persistSessionBestEffort(session, ctx.onLog);
          if (!next.complete) return await yieldHeartbeat(session);
        } else {
          session.terminalActivityScan = undefined;
          activities = await mirrorNewActivities(client, session, taskId, ctx.authToken, ctx.runId, ctx.onLog, activityScanPageLimit(session));
        }
      } catch (mirrorError) {
        await ctx.onLog?.(
          'stderr',
          `[jules] activity mirroring failed (terminal detection continues): ${String(mirrorError)}\n`,
        );
      }
      await ctx.onLog?.(
        "stdout",
        `[jules] Activity reconciliation: count=${activities.length}, latestAgentActivity=${[...activities].reverse().find((activity) => Boolean(activity.agentMessaged?.agentMessage?.trim()))?.id ?? "none"}, pending=${session.pendingInteraction?.type ?? "none"}, providerState=${state}.\n`,
      );
      if (session.providerContinuation) {
        const reconciledContinuation = reconcileProviderContinuation(session.providerContinuation, activities);
        if (reconciledContinuation !== session.providerContinuation) {
          session.providerContinuation = reconciledContinuation;
          await persistSessionBestEffort(session, ctx.onLog);
        }
      }
      // A native rejection can be accepted by Jules, followed by a terminal
      // session that exposes neither a fresh PR handoff nor a new provider
      // question. That is unfinished execution, not a second review of the
      // rejected immutable head. Send one identity-keyed continuation to the
      // same session and retain its monitor; a second terminal poll cannot
      // repeat the message because the continuation state is durable.
      // This branch intentionally tests the raw provider handoff, not the
      // terminal fallback: a rejected PR needs one reminder only when Jules
      // has completed without publishing a new handoff.
      if (terminalProviderState && !discoveredPrUrl && session.currentPrUrl &&
          session.providerContinuation?.state === "provider_acknowledged" &&
          session.workerFeedbackDeliveryId === session.providerContinuation.deliveryId) {
        await client.sendMessage(session.julesSessionId, {
          prompt: "The requested PR revision has not reached a new pull-request handoff. Continue the existing task: finish the scoped changes, run the relevant tests, commit and push them to the existing PR. Do not create a new session or pull request.",
        });
        session.providerContinuation = {
          ...session.providerContinuation,
          state: "terminal_revision_reminder_sent",
          remindedAt: new Date().toISOString(),
        };
        session.phase = "RUNNING";
        await persistSessionBestEffort(session, ctx.onLog);
        await ctx.onLog?.("stdout", `[jules] Sent one terminal revision reminder for rejected PR ${session.currentPrUrl}.\n`);
        return await yieldHeartbeat(session);
      }
      const latestPreflightActivity = [...activities].reverse().find(
        (activity) => Boolean(activity.agentMessaged?.agentMessage?.trim()),
      );
      const latestPreflightIndex = latestPreflightActivity
        ? activities.findIndex((activity) => activity.id === latestPreflightActivity.id)
        : -1;
      const completionPreflightIndex = activities.reduce(
        (latestIndex, activity, index) => activity.sessionCompleted !== undefined ? index : latestIndex,
        -1,
      );
      const preflightQuestion = Boolean(
        latestPreflightActivity &&
        ((state === "AWAITING_USER_FEEDBACK" && session.deliveredFeedbackActivityId !== latestPreflightActivity.id) ||
          ((state === "COMPLETED" || state === "FAILED") &&
            !deliveredActivityIdsBeforePoll.has(latestPreflightActivity.id) &&
            session.terminalFeedbackActivityId !== latestPreflightActivity.id &&
            latestPreflightIndex > completionPreflightIndex)),
      );
      // The resumable scan itself establishes the ordering invariant. Do not
      // re-infer it from a compact activity snapshot: historical messages
      // before completion must never delay a terminal PR handoff.
      const scannedPostCompletionQuestion = terminalProviderState &&
        session.terminalActivityScan?.complete &&
        session.terminalActivityScan.postCompletionQuestion &&
        session.terminalFeedbackActivityId !== session.terminalActivityScan.postCompletionQuestion.id
        ? terminalEvidenceActivity(session.terminalActivityScan.postCompletionQuestion)
        : undefined;
      // Jules can reach COMPLETED without an activity-level sessionCompleted
      // witness. The newest unread agent message is then the only durable
      // terminal boundary. It must outrank an older resolved no-PR card:
      // mirroring an activity is not the same as relaying its typed answer.
      const unresolvedTerminalMessageWithoutCompletionBoundary = Boolean(
        terminalProviderState &&
        completionPreflightIndex < 0 &&
        latestPreflightActivity &&
        session.deliveredFeedbackActivityId !== latestPreflightActivity.id &&
        session.terminalFeedbackActivityId !== latestPreflightActivity.id,
      );

      // A no-PR confirmation belongs to the terminal provider session, not to
      // whichever plan card happened to be checkpointed most recently.  An
      // older native plan gate can survive a configuration refresh after the
      // no-PR card has already been rejected.  Resolve that exact, stable
      // card before deriving another plan wait; otherwise a completed Jules
      // session is resurrected and keeps polling forever.  A provider question
      // after completion remains higher priority and is never discarded here.
      if (state === "COMPLETED" && !prUrl && !preflightQuestion && !scannedPostCompletionQuestion &&
          !unresolvedTerminalMessageWithoutCompletionBoundary) {
        const completionKey = `jules:no-pr-completion:${taskId}:${session.julesSessionId}`;
        const interactions = await listPaperclipInteractions(taskId, ctx.authToken, ctx.runId).catch(() => []);
        const resolvedCompletion = interactions.find((interaction) =>
          interaction.kind === "request_confirmation" &&
          interaction.idempotencyKey === completionKey &&
          (interaction.status === "accepted" || interaction.status === "rejected"),
        );
        if (resolvedCompletion) {
          await deleteStoredSession(taskId, config.source, config.baseBranch);
          if (resolvedCompletion.status === "accepted") {
            await moveIssueToDone(
              taskId,
              session.julesSessionId,
              ctx.authToken,
              ctx.runId,
              `Confirmed Jules session ${session.julesSessionId} completed without a PR; marked the Paperclip issue done.`,
            );
            return completionInteractionResult(
              session,
              "done",
              `Confirmed Jules session ${session.julesSessionId} completed without a PR; marked the Paperclip issue done.`,
              true,
            );
          }
          return completionInteractionResult(
            session,
            "blocked",
            `Rejected completion of Jules session ${session.julesSessionId}; discarded its terminal checkpoint for a fresh Paperclip recovery run.`,
            true,
          );
        }
      }

      // Jules occasionally exposes only the coarse awaiting-feedback state
      // after publishing a PR, with no new agent-message activity to answer.
      // That state is not a human question. If the known PR is red, recover
      // through the ordinary one-per-head CI feedback path instead of
      // fabricating an adjudication card and parking the session indefinitely.
      const awaitingFeedbackWithoutQuestion = state === "AWAITING_USER_FEEDBACK" && !preflightQuestion;
      const skipCi =
        (ctx.agent.adapterConfig as Record<string, unknown> | undefined)?.["ciPolicy"] === "skip" ||
        (ctx.config as Record<string, unknown> | undefined)?.["ciPolicy"] === "skip";
      if (prUrl && !session.pendingInteraction && awaitingFeedbackWithoutQuestion && !skipCi &&
          ["failed", "stalled"].includes(await getPullRequestCiStatus(prUrl))) {
        const prDetails = await getPullRequestDetails(prUrl).catch(() => null);
        const ciStatus = prDetails?.ciStatus;
        return await relayCiRemediationOnce(prUrl, prDetails?.headSha, ciStatus === "stalled" ? "stalled" : "failed");
      }

      // Jules keeps historical outputs for the lifetime of a session.  A PR
      // URL in that history is not a current handoff while the provider is
      // still planning or awaiting feedback: otherwise a config-recovered
      // stale checkpoint can be cleared above and immediately recreated here.
      // Only a terminal provider state may promote a discovered PR to review.
      // PR reconciliation precedes the terminal plan reducer below. A
      // branch-bound recovery may have already reached COMPLETED with its
      // first replacement plan, so hold that PR path until the typed Luna →
      // Terra gate records an approval. Without this fence, an older build's
      // stale `planApprovedActivityId` can send the issue to review before a
      // native card exists. This is deliberately based on session/activity
      // identities and a typed outcome, never plan or comment prose.
      const branchBoundRecoveryNeedsPlanGate = terminalProviderState &&
        session.prRemediation?.recoverySessionId === session.julesSessionId &&
        session.planReviewOutcome !== "approved" &&
        activities.some((activity) => Boolean(activity.planGenerated));
      if (prUrl && terminalProviderState && !preflightQuestion && !scannedPostCompletionQuestion &&
          !branchBoundRecoveryNeedsPlanGate) {
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
          terminalPrDetails = prDetails;
          if (prDetails.headSha && session.currentPrHeadSha !== prDetails.headSha) {
            session.currentPrHeadSha = prDetails.headSha;
            // Persist before any review/card transition. This is the durable
            // identity used to recover a typed verdict after a payload-less
            // Paperclip wake or a process restart.
            await persistSessionBestEffort(session, ctx.onLog, { authToken: ctx.authToken, runId: ctx.runId });
          }
          if (prDetails.headRefName && session.currentPrHeadRef !== prDetails.headRefName) {
            session.currentPrHeadRef = prDetails.headRefName;
            await persistSessionBestEffort(session, ctx.onLog, { authToken: ctx.authToken, runId: ctx.runId });
          }
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
            // The lifecycle reducer only decides PR terminality. A stalled
            // check is non-terminal there and is remediated through the
            // provider-feedback branch below.
            ciStatus: prDetails.ciStatus === "unknown" || prDetails.ciStatus === "stalled"
              ? "pending"
              : prDetails.ciStatus,
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

          const scopeDriftSummaryForTelemetry = changedFiles.length > 0 && !scope.isConformant
            ? scope.summaryText
            : undefined;
          const driftFingerprint = scopeDriftSummaryForTelemetry
            ? `${prUrl}\n${scopeDriftSummaryForTelemetry}`
            : undefined;
          if (!driftFingerprint && session.scopeDriftFingerprint) {
            session.scopeDriftFingerprint = undefined;
            await persistSessionBestEffort(session, ctx.onLog);
          }
          if (scopeDriftSummaryForTelemetry) {
            // Scope drift is advisory telemetry, not a provider question or a
            // lifecycle gate. Never send it to Jules or turn it into a task
            // comment: the PR still follows the ordinary native review path.
            scopeDriftIsNew = session.scopeDriftFingerprint !== driftFingerprint;
            if (ctx.onLog && scopeDriftIsNew) {
              await ctx.onLog("stderr", `[jules] ${scopeDriftSummaryForTelemetry}\n`);
            }
            session.scopeDriftFingerprint = driftFingerprint;
            await persistSessionBestEffort(session, ctx.onLog);
            scopeDriftSummary = scopeDriftSummaryForTelemetry;
          }
      }

      // Mirroring must never prevent terminal detection: a mirror failure used to
      // abort this run before the COMPLETED/FAILED branches could fire, leaving
      // the Paperclip issue blocked forever (MAZ-102 incident, issue #4/#5 class).
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
      const planActivities = activities.filter((activity) => Boolean(activity.planGenerated));
      const latestPlanActivity = planActivities.at(-1);
      // A plan prompt may follow a replacement plan while the provider still
      // reports AWAITING_USER_FEEDBACK. It is safe to keep it in the plan lane
      // only when nothing but provider progress separates the replacement plan
      // from that message. A completion, user message, another plan, or an
      // earlier agent message is a protocol boundary: a later agent message
      // after such a boundary is an independent provider question and must be
      // mirrored to the typed reviewer form.
      const latestPlanActivityIndex = latestPlanActivity
        ? activities.findIndex((activity) => activity.id === latestPlanActivity.id)
        : -1;
      const activitiesBetweenLatestPlanAndMessage = latestPlanActivityIndex >= 0 && latestAgentActivityIndex > latestPlanActivityIndex
        ? activities.slice(latestPlanActivityIndex + 1, latestAgentActivityIndex)
        : [];
      const revisedPlanPrompt = Boolean(
        state === "AWAITING_USER_FEEDBACK" &&
        latestAgentActivity &&
        latestPlanActivity &&
        planActivities.length > 1 &&
        latestPlanActivityIndex >= 0 &&
        latestAgentActivityIndex > latestPlanActivityIndex &&
        activitiesBetweenLatestPlanAndMessage.every((activity) => Boolean(activity.progressUpdated)),
      );
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
      // Jules can report a terminal session state without emitting a matching
      // `sessionCompleted` activity. In that provider shape there is no
      // ordering boundary with which to prove that the newest unread agent
      // message is historical. Preserve the message for the strong-reviewer
      // protocol rather than manufacturing a no-PR confirmation card. This
      // is intentionally identity/state based: it does not inspect or parse
      // the provider's prose to decide whether it is a question.
      const terminalMessageWithoutCompletionBoundary =
        unresolvedTerminalMessageWithoutCompletionBoundary;
      const terminalMessageRequiresAdjudication =
        messageFollowsCompletion || terminalMessageWithoutCompletionBoundary;
      const postCompletionQuestion = scannedPostCompletionQuestion;
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
        (pendingPlanAgentReview || pendingNativePlanReview) &&
        latestAgentActivity &&
        latestAgentActivity.id !== (pendingPlanAgentReview?.julesActivityId ?? pendingNativePlanReview?.julesActivityId) &&
        session.deliveredFeedbackActivityId !== latestAgentActivity.id,
      );
      // A recovered native bridge is durable protocol state: it binds one
      // specific provider message to a reviewer form. If the cloud provider
      // reports COMPLETED after that message, completion must not erase the
      // unresolved question merely because the message preceded the terminal
      // activity. This deliberately keys on the stored activity identity,
      // never on the message prose.
      const persistedNativeQuestion = Boolean(
        latestAgentActivity &&
        session.pendingInteraction?.type === "agent_adjudication" &&
        isNativeAgentAdjudication(session.pendingInteraction) &&
        session.pendingInteraction.julesActivityId === latestAgentActivity.id &&
        session.deliveredFeedbackActivityId !== latestAgentActivity.id &&
        // A terminal scan retains an old bridge only as evidence. It remains
        // actionable at terminal state solely when its provider activity is
        // after the final completion boundary; otherwise the PR handoff wins.
        (!terminalProviderState || terminalMessageRequiresAdjudication),
      );
      const latestProviderQuestion = latestAgentActivity && !revisedPlanPrompt &&
        ((state === "AWAITING_USER_FEEDBACK" && session.deliveredFeedbackActivityId !== latestAgentActivity.id) ||
          ((state === "COMPLETED" || state === "FAILED") &&
            !deliveredActivityIdsBeforePoll.has(latestAgentActivity.id) &&
            session.terminalFeedbackActivityId !== latestAgentActivity.id && terminalMessageRequiresAdjudication) ||
          freshMessageWhilePlanReviewing ||
          persistedNativeQuestion ||
          session.unresolvedProviderQuestionActivityId === latestAgentActivity.id)
        ? latestAgentActivity
        : undefined;
      const hasProviderQuestion = Boolean(latestProviderQuestion);
      let hasUnresolvedProviderQuestion = Boolean(
        latestProviderQuestion &&
        session.deliveredFeedbackActivityId !== latestProviderQuestion.id,
      );
      if (hasUnresolvedProviderQuestion && latestProviderQuestion &&
          session.unresolvedProviderQuestionActivityId !== latestProviderQuestion.id) {
        // Preserve the provider identity independently of activity mirroring.
        // A subsequent Jules COMPLETED state must not erase a question that
        // still has no structured reviewer resolution.
        session.unresolvedProviderQuestionActivityId = latestProviderQuestion.id;
      }

      // Older builds could manufacture a human card from the coarse provider
      // state while losing the text of the activity it named. If the same
      // immutable activity is now available with a concrete question, that
      // card is semantically invalid: retire only this exact generic pointer
      // and re-enter the normal strong-reviewer protocol. Never withdraw a
      // human card whose stored prompt matches the provider activity.
      const pendingLegacyFeedback = session.pendingInteraction?.type === "user_feedback"
        ? session.pendingInteraction
        : undefined;
      const recoveredQuestion = latestAgentActivity ? extractQuestionText(latestAgentActivity) : "";
      if (pendingLegacyFeedback &&
          pendingLegacyFeedback.question === "Jules is awaiting user feedback." &&
          latestAgentActivity?.id === pendingLegacyFeedback.julesActivityId &&
          recoveredQuestion.trim().length > 0 &&
          recoveredQuestion !== pendingLegacyFeedback.question) {
        const legacyInteractionId = pendingLegacyFeedback.paperclipInteractionId;
        if (!legacyInteractionId) {
          throw new Error("Generic Jules feedback checkpoint is missing its Paperclip interaction ID");
        }
        await withdrawPaperclipInteraction(
          taskId,
          legacyInteractionId,
          "Superseded generic Jules feedback card by the recovered provider activity.",
          ctx.authToken,
          ctx.runId,
        );
        session.pendingInteraction = undefined;
        session.unresolvedProviderQuestionActivityId = latestAgentActivity.id;
        hasUnresolvedProviderQuestion = true;
        await persistSessionBestEffort(session, ctx.onLog);
        await ctx.onLog?.("stdout", `[jules] Replaced generic feedback card with recovered provider activity ${latestAgentActivity.id}.\n`);
      }

      // A historical crash or an owner-run cancellation can persist the
      // provider session ID but lose the transient pointer to its native plan
      // card.  Recover one exact v2 card while Jules awaits approval, and
      // also when the provider has already become terminal: an answered
      // rejection is a durable decision that must still be relayed.  Ambiguous
      // and user-cancelled cards stay inert.
      if (!pendingNativePlanReview &&
          (state === "AWAITING_PLAN_APPROVAL" || terminalProviderState) &&
          !hasUnresolvedProviderQuestion) {
        const currentPlan = latestPlan(activities);
        if (currentPlan?.id) {
          const recovered = recoverMissingPlanGatePointer({
            issueId: taskId,
            sessionId: session.julesSessionId!,
            latestPlanActivityId: currentPlan.id,
            interactions: await listPaperclipInteractions(taskId, ctx.authToken, ctx.runId).catch(() => []),
            // A second plan activity is a replacement revision.  Replaying an
            // answered card from the first revision would duplicate its
            // rejection and bind it to the wrong provider plan.
            allowAnswered: planActivities.length <= 1,
          });
          if (recovered) {
            pendingNativePlanReview = {
              type: "plan_native_review", protocolVersion: 2, julesActivityId: asJulesActivityId(recovered.activityId),
              paperclipInteractionId: recovered.interactionId, question: recovered.question,
              planDocumentId: recovered.documentId, planRevisionId: recovered.revisionId,
              planRevisionNumber: recovered.revisionNumber, reviewerAgentId: recovered.reviewerAgentId,
              stage: recovered.stage, createdAt: new Date().toISOString(),
            };
            session.pendingInteraction = pendingNativePlanReview;
            await persistSessionBestEffort(session, ctx.onLog);
          }
        }
      }

      // A restarted/changed adapter configuration can restore the provider
      // session while losing its pendingInteraction pointer. Reconnect that
      // exact activity to the already-created visible card and strong-review
      // child before evaluating the state machine. This is identity-based;
      // no comment or question wording is used for correlation.
      if (!session.pendingInteraction && (state === "AWAITING_USER_FEEDBACK" || terminalProviderState ||
          (!terminalProviderState && session.deliveredFeedbackActivityId &&
            !session.deliveredFeedbackInteractionId)) &&
          (config.questionAdjudicatorAgentId ?? config.questionReviewerAgentId)) {
        if (!session.julesSessionId) return await yieldHeartbeat(session);
        const questionReviewerAgentId = config.questionAdjudicatorAgentId ?? config.questionReviewerAgentId;
        if (!questionReviewerAgentId) return await yieldHeartbeat(session);
        const visibleInteractions = await listPaperclipInteractions(taskId, ctx.authToken, ctx.runId, 5000).catch(() => []);
        const answeredParent = [...activities].reverse().map((activity) => ({
          activity,
          interaction: visibleInteractions.find((item) => item.kind === "ask_user_questions" &&
            item.status === "answered" &&
            item.idempotencyKey === `jules:agent-adjudication:${taskId}:${session!.julesSessionId}:${activity.id}`),
        })).find((candidate) => {
          if (!candidate.interaction) return false;
          // On a terminal provider poll, only the scan-proven post-completion
          // message remains actionable. Jules can also omit sessionCompleted;
          // in that shape the newest unread agent activity is the sole durable
          // boundary. Reconnecting any older answered form here would yield
          // before a PR handoff on every heartbeat.
          const isTerminalActionableActivity =
            candidate.activity.id === scannedPostCompletionQuestion?.id ||
            (terminalMessageWithoutCompletionBoundary && candidate.activity.id === latestAgentActivity?.id);
          return !terminalProviderState || isTerminalActionableActivity;
        });
        if (answeredParent?.interaction) {
          // The parent interaction is the durable typed decision. A restart
          // may lose the child pointer after the parent has already been
          // answered; recreating a reviewer child in that state spends quota
          // and can never improve on the authoritative verdict.
          const formState = classifyNativeQuestionReview(
            answeredParent.interaction.status,
            answeredParent.interaction.result,
          );
          const answeredDecision = formState.state === "answered" && formState.decision !== "malformed"
            ? formState.decision
            : null;
          if (answeredDecision?.kind === "ANSWER") {
            if (session.deliveredFeedbackActivityId !== answeredParent.activity.id) {
              await client.sendMessage(session.julesSessionId, { prompt: answeredDecision.answer });
            }
            session.deliveredFeedbackActivityId = answeredParent.activity.id;
            session.deliveredFeedbackInteractionId = answeredParent.interaction.id;
            session.phase = "RUNNING";
            await persistSessionBestEffort(session, ctx.onLog);
            await ctx.onLog?.("stdout", `[jules] Relayed recovered typed question answer for activity ${answeredParent.activity.id}.\n`);
            return await yieldHeartbeat(session);
          }
        }
        // The card is the durable identity when a process restart lost the
        // session pointer. Scan provider activities by idempotency key rather
        // than assuming the latest activity or a particular provider state.
        let recoveryGeneration = 0;
        let candidate = [...activities].reverse().find((activity) => {
          const key = `jules:agent-adjudication:${taskId}:${session!.julesSessionId}:${activity.id}`;
          return visibleInteractions.some((item) => item.kind === "ask_user_questions" &&
            item.status === "pending" && item.idempotencyKey === key);
        });
        if (!candidate) {
          const prefix = `jules:agent-adjudication:${taskId}:${session!.julesSessionId}:`;
          const orphanCard = visibleInteractions.find((item) => item.kind === "ask_user_questions" &&
            item.status === "pending" && item.idempotencyKey?.startsWith(prefix));
          const orphanActivityId = orphanCard?.idempotencyKey?.slice(prefix.length);
          if (orphanActivityId) {
            candidate = (await listAllActivities(client, session.julesSessionId)).find(
              (activity) => activity.id === orphanActivityId,
            );
          }
        }
        // A prior build could cancel the only typed parent during terminal
        // cleanup even though this exact provider activity followed completion.
        // Re-open only that adapter-owned cancellation, on one generation-keyed
        // card; a board cancellation remains authoritative.
        if (!candidate && postCompletionQuestion) {
          const baseKey = `jules:agent-adjudication:${taskId}:${session!.julesSessionId}:${postCompletionQuestion.id}`;
          const cancelled = visibleInteractions.find((item) => item.kind === "ask_user_questions" &&
            item.status === "cancelled" && item.idempotencyKey === baseKey &&
            item.result && typeof item.result === "object" &&
            (item.result as Record<string, unknown>)["reason"] === "Superseded by terminal Jules completion");
          const generationOne = visibleInteractions.find((item) => item.kind === "ask_user_questions" &&
            item.status === "pending" && item.idempotencyKey === `${baseKey}:generation:1`);
          const recovery = evaluateTerminalQuestionRecovery({
            terminal: terminalProviderState,
            followsCompletion: true,
            answerRecorded: false,
            card: generationOne ? "pending_generation_one" : cancelled ? "cancelled_terminal" : "none",
          });
          if (recovery.action === "recover_generation_one") {
            candidate = postCompletionQuestion;
            recoveryGeneration = 1;
          } else if (recovery.action === "retain_pending") {
            candidate = postCompletionQuestion;
            recoveryGeneration = 1;
          }
        }
        let visibleInteraction = candidate
          ? visibleInteractions.find((item) => item.kind === "ask_user_questions" && item.status === "pending" &&
              item.idempotencyKey === `jules:agent-adjudication:${taskId}:${session!.julesSessionId}:${candidate.id}` +
                (recoveryGeneration > 0 ? `:generation:${recoveryGeneration}` : ""))
          : undefined;
        if (!visibleInteraction && candidate && recoveryGeneration > 0) {
          visibleInteraction = await createJulesAgentAdjudicationInteraction(
            taskId, session.julesSessionId!, candidate.id, extractQuestionText(candidate),
            questionReviewerAgentId, ctx.authToken, ctx.runId, recoveryGeneration,
          );
        }
        if (visibleInteraction && candidate) {
          // The checkpoint can be lost after a reviewer has already completed
          // its typed form. Correlation is the durable identity, including
          // terminal children; creating again would spend quota and hide the
          // authoritative verdict behind a duplicate form.
          const recoveredChild = await findJulesQuestionAdjudication(
            taskId,
            ctx.agent.companyId,
            questionReviewerAgentId,
            session.julesSessionId,
            candidate.id,
            ctx.authToken,
            ctx.runId,
          );
          const reviewerChild = recoveredChild ?? await createJulesQuestionAdjudication(
            taskId,
            questionReviewerAgentId,
            extractQuestionText(candidate),
            ctx.authToken,
            ctx.runId,
            ctx.agent.companyId,
            candidate.id,
            session.julesSessionId,
            0,
            true,
          );
          const reviewerInteraction = await createJulesQuestionReviewInteraction(
            reviewerChild.id,
            taskId,
            session.julesSessionId,
            candidate.id,
            extractQuestionText(candidate),
            questionReviewerAgentId,
            ctx.authToken,
            ctx.runId,
          );
          // A restart can discover the durable parent card after the reviewer
          // has already submitted the child form.  Do not reconstruct the
          // bridge and yield in that state: the next restart would erase the
          // local pointer again, leaving the answered typed verdict stranded
          // forever.  Consume the same structured decision through the normal
          // parent audit card before scheduling any further poll.
          const recoveredChildState = classifyNativeQuestionReview(
            reviewerInteraction.status,
            reviewerInteraction.result,
          );
          const recoveredChildDecision = recoveredChildState.state === "answered" &&
            recoveredChildState.decision !== "malformed"
            ? recoveredChildState.decision
            : null;
          if (recoveredChildDecision) {
            switch (recoveredChildDecision.kind) {
              case "ANSWER":
                await resolveJulesAgentAdjudicationInteraction(
                  taskId,
                  visibleInteraction.id,
                  "answer",
                  recoveredChildDecision.answer,
                  ctx.authToken,
                  ctx.runId,
                );
                await completeInternalReviewIssue(reviewerChild.id, ctx.authToken, ctx.runId).catch(() => undefined);
                if (session.deliveredFeedbackActivityId !== candidate.id) {
                  await client.sendMessage(session.julesSessionId!, { prompt: recoveredChildDecision.answer });
                }
                session.deliveredFeedbackActivityId = asJulesActivityId(candidate.id);
                session.deliveredFeedbackInteractionId = visibleInteraction.id;
                session.pendingInteraction = session.deferredPlanReview;
                session.deferredPlanReview = undefined;
                session.phase = "RUNNING";
                session = resumePlanReviewAfterQuestionResolution(session);
                await persistSessionBestEffort(session, ctx.onLog);
                await ctx.onLog?.("stdout", `[jules] Relayed recovered typed question answer for activity ${candidate.id}.\n`);
                return await yieldHeartbeat(session);
              case "ESCALATE": {
                await resolveJulesAgentAdjudicationInteraction(
                  taskId,
                  visibleInteraction.id,
                  "escalate",
                  recoveredChildDecision.reason,
                  ctx.authToken,
                  ctx.runId,
                );
                await completeInternalReviewIssue(reviewerChild.id, ctx.authToken, ctx.runId).catch(() => undefined);
                const interaction = await runCheckpointedMutation({
                  session,
                  key: `jules:human-escalation:${taskId}:${session.julesSessionId}:${candidate.id}`,
                  operation: "create_human_escalation_interaction",
                  issueId: taskId,
                  sessionId: session.julesSessionId,
                  activityId: candidate.id,
                  persist: () => persistSessionBestEffort(session!, ctx.onLog),
                  run: () => createJulesHumanEscalationInteraction(
                    taskId,
                    session!.julesSessionId!,
                    candidate.id,
                    extractQuestionText(candidate),
                    recoveredChildDecision.reason,
                    ctx.authToken,
                    ctx.runId,
                  ),
                });
                session.pendingInteraction = {
                  type: "user_feedback",
                  julesActivityId: asJulesActivityId(candidate.id),
                  paperclipInteractionId: interaction.id,
                  question: extractQuestionText(candidate),
                  createdAt: new Date().toISOString(),
                };
                session.phase = "WAITING_FOR_FEEDBACK";
                await persistSessionBestEffort(session, ctx.onLog);
                return await yieldHeartbeat(session);
              }
            }
          }
          // The child must not become runnable until its only valid decision
          // channel exists. Activating first lets a fast reviewer complete it
          // from prose, which immediately expires the form.
          if (reviewerChild.status !== "done" && reviewerChild.status !== "cancelled") {
            await activateInternalReviewIssue(
              reviewerChild.id, questionReviewerAgentId, ctx.authToken, ctx.runId,
            );
          }
          session.pendingInteraction = {
            type: "agent_adjudication",
            julesActivityId: asJulesActivityId(candidate.id),
            paperclipInteractionId: visibleInteraction.id,
            question: extractQuestionText(candidate),
            reviewerAgentId: questionReviewerAgentId,
            nativeForm: true,
            transport: "child_form_bridge",
            reviewerChildIssueId: reviewerChild.id,
            reviewerInteractionId: reviewerInteraction.id,
            ...(recoveryGeneration > 0 ? { adjudicationGeneration: recoveryGeneration } : {}),
            createdAt: new Date().toISOString(),
          };
          await persistSessionBestEffort(session, ctx.onLog);
          await ctx.onLog?.("stdout", `[jules] Reconnected native question-review form for activity ${candidate.id}.\n`);
          // This checkpoint is now complete. Do not fall through to the
          // generic provider-question reducer in the same heartbeat: it would
          // create a second form for the exact same child and activity.
          return await yieldHeartbeat(session);
        }
      }

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
        const recoveryReviewerAgentId = config.questionAdjudicatorAgentId ?? config.questionReviewerAgentId;
        if (question && recoveryReviewerAgentId) {
          const recoveredChild = await createJulesQuestionAdjudication(
            taskId,
            recoveryReviewerAgentId,
            question,
            ctx.authToken,
            ctx.runId,
            ctx.agent.companyId,
            deliveredFeedbackActivity.id,
            session.julesSessionId,
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
        const interactions = await listPaperclipInteractions(taskId, ctx.authToken, ctx.runId, 5000).catch(() => []);
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
      // A pending native plan review remains authoritative even if Jules has
      // already reported COMPLETED. Older builds could continue the provider
      // session after creating the card, leaving a terminal session with an
      // unresolved reviewer gate. Migrate/consume the typed card before the
      // terminal PR handoff instead of abandoning that visible decision.
      if (!session) {
        throw new Error("Native plan-review lifecycle requires a persisted Jules session.");
      }
      const nativePlanSession = session;
      const requestFreshPlanRevision = async (
        interactionId: string,
        planActivityId: string,
        reviewerFeedback?: string,
      ) => {
        const request = createPlanRevisionRequest({ interactionId, planActivityId, reviewerFeedback });
        // `sendMessage` has no provider idempotency key. Persisting this
        // prepared command before its only attempted delivery lets a restart
        // wait for the typed userMessaged echo instead of spamming Jules.
        nativePlanSession.pendingPlanRevisionRequest = request;
        await saveStoredSession(nativePlanSession);
        await client.sendMessage(nativePlanSession.julesSessionId!, {
          prompt: planRevisionRequestPrompt(request),
        });
        nativePlanSession.pendingPlanRevisionRequest = { ...request, state: "delivered" };
        nativePlanSession.pendingInteraction = undefined;
        nativePlanSession.supersededPlanActivityId = planActivityId;
        nativePlanSession.planReviewOutcome = "revision_requested";
        nativePlanSession.terminalActivityScan = undefined;
        await saveStoredSession(nativePlanSession);
        await persistSessionBestEffort(nativePlanSession, ctx.onLog);
        return await yieldHeartbeat(nativePlanSession);
      };

      if (session.pendingPlanRevisionRequest) {
        const request = session.pendingPlanRevisionRequest;
        const latestRequestPlan = latestPlan(activities);
        if (latestRequestPlan && latestRequestPlan.id !== request.planActivityId) {
          // A new typed provider plan proves the command took effect, even if
          // a restart happened before Jules mirrored its userMessaged echo.
          session.pendingPlanRevisionRequest = undefined;
          session.pendingInteraction = undefined;
          pendingNativePlanReview = null;
          await persistSessionBestEffort(session, ctx.onLog);
        } else {
          const delivery = decidePlanRevisionRequestDelivery({ request, activities, terminalProviderState });
          switch (delivery.action) {
            case "record_delivery": {
              session.pendingPlanRevisionRequest = { ...request, state: "delivered" };
              session.pendingInteraction = undefined;
              session.supersededPlanActivityId = request.planActivityId;
              session.planReviewOutcome = "revision_requested";
              session.terminalActivityScan = undefined;
              await saveStoredSession(session);
              await persistSessionBestEffort(session, ctx.onLog);
              return await yieldHeartbeat(session);
            }
            case "await_echo":
              return await yieldHeartbeat(session);
            case "await_provider_progress":
              return await yieldHeartbeat(session);
            default:
              return assertNever(delivery);
          }
        }
      }

      if (pendingNativePlanReview) {
        const nativePlanReview = pendingNativePlanReview;
        const reviewIssueId = nativePlanReview.reviewerChildIssueId ?? taskId;
        const latestPlanActivity = latestPlan(activities);
        // The provider activity is the immutable review target. Retire an
        // orphaned or answered card before reading its child issue, because
        // Paperclip may compact that child after resolution. Otherwise an old
        // pointer can survive forever and hide the newer plan from review.
        if (latestPlanActivity && latestPlanActivity.id !== nativePlanReview.julesActivityId) {
          session.supersededPlanActivityId = nativePlanReview.julesActivityId;
          session.planReviewOutcome = "revision_requested";
          session.pendingInteraction = undefined;
          await persistSessionBestEffort(session, ctx.onLog);
          return await yieldHeartbeat(session);
        }
        const interactions = await listPaperclipInteractions(reviewIssueId, ctx.authToken, ctx.runId).catch(() => []);
        const interaction = interactions.find((candidate) => candidate.id === nativePlanReview.paperclipInteractionId);
        if (!interaction) {
          // A reviewer child can be compacted or a legacy repair can leave a
          // stale local pointer after the card itself has gone away. Waiting
          // with that pointer would keep a terminal recovery plan pending
          // forever: there is no card for its reviewer to answer. Retire only
          // the missing pointer and continue this heartbeat so the normal
          // typed Luna card is rebuilt from the immutable provider activity
          // and plan document before Paperclip can park the parent again.
          session.pendingInteraction = undefined;
          await persistSessionBestEffort(session, ctx.onLog);
          pendingNativePlanReview = null;
        } else {
        // v2 initially placed its form on the Jules-owned parent. Paperclip
        // does not dispatch a cross-assignee form there, so migrate that exact
        // pending card to a reviewer-owned child before waiting again.
        if (!nativePlanReview.reviewerChildIssueId && interaction.status === "pending" && !hasUnresolvedProviderQuestion) {
          await withdrawPaperclipInteraction(taskId, interaction.id,
            "Migrating the parent-owned plan form to the reviewer-owned typed form.", ctx.authToken, ctx.runId);
          const child = await createJulesQuestionAdjudication(
            taskId, nativePlanReview.reviewerAgentId, nativePlanReview.question,
            ctx.authToken, ctx.runId, ctx.agent.companyId, nativePlanReview.julesActivityId,
            session.julesSessionId, 0, true, "plan",
          );
          const bridged = await createJulesPlanReviewChildInteraction(
            child.id, taskId, session.julesSessionId!,
            { documentId: nativePlanReview.planDocumentId, revisionId: nativePlanReview.planRevisionId, revisionNumber: nativePlanReview.planRevisionNumber },
            nativePlanReview.question, nativePlanReview.stage, nativePlanReview.reviewerAgentId,
            ctx.authToken, ctx.runId, nativePlanReview.julesActivityId,
          );
          session.pendingInteraction = { ...nativePlanReview, protocolVersion: 2, paperclipInteractionId: bridged.id, reviewerChildIssueId: child.id };
          await persistSessionBestEffort(session, ctx.onLog);
          return await yieldHeartbeat(session);
        }
        const withdrawalReason = interaction.result && typeof interaction.result === "object"
          ? (interaction.result as Record<string, unknown>)["reason"]
          : undefined;
        const planGateDecision = decidePlanGateRecovery({
          providerState: state,
          hasUnresolvedProviderQuestion,
          matchingInteraction: {
            status: interaction.status === "pending" || interaction.status === "answered" || interaction.status === "cancelled" || interaction.status === "expired"
              ? interaction.status
              : "unknown",
            ...(typeof withdrawalReason === "string" ? { cancellationReason: withdrawalReason } : {}),
          },
        });
        if (planGateDecision.action === "request_provider_plan_revision" &&
            nativePlanReview.protocolVersion === 2 &&
            latestPlanActivity?.id === pendingNativePlanReview.julesActivityId) {
          return await requestFreshPlanRevision(interaction.id, pendingNativePlanReview.julesActivityId);
        }
        // Native plan reviews are coordination gates, not provider work. A
        // newer typed Jules question must take precedence so it can reach the
        // strong reviewer lane instead of being hidden behind this card.
        const planReviewActivityId = pendingNativePlanReview?.julesActivityId;
        const planActivity = planReviewActivityId
          ? activities.find((activity) => activity.id === planReviewActivityId)
          : undefined;
        const questionIsNewerThanPlan = (() => {
          const questionAt = latestAgentActivity?.createTime ? Date.parse(latestAgentActivity.createTime) : Number.NaN;
          const planAt = planActivity?.createTime ? Date.parse(planActivity.createTime) : Number.NaN;
          // A missing timestamp must not cancel an already-visible plan gate:
          // replayed provider history is common after a session resumes.
          return Number.isFinite(questionAt) && Number.isFinite(planAt) && questionAt > planAt;
        })();
        if (hasUnresolvedProviderQuestion && questionIsNewerThanPlan && interaction.status === "pending") {
          await withdrawPaperclipInteraction(
            reviewIssueId,
            interaction.id,
            "Superseded by a newer Jules provider question; resume plan review only for a new plan activity.",
            ctx.authToken,
            ctx.runId,
          );
          session.supersededPlanActivityId = pendingNativePlanReview.julesActivityId;
          session.unresolvedProviderQuestionActivityId = latestAgentActivity?.id;
          session.planReviewOutcome = "superseded_provider_question";
          session.pendingInteraction = undefined;
          await persistSessionBestEffort(session, ctx.onLog);
          // The next heartbeat enters the normal question adjudication branch.
          // Persisting this checkpoint first makes the handoff restart-safe.
          return await yieldHeartbeat(session);
        }
        const planIdentity = {
          issueId: taskId,
          sessionId: session.julesSessionId!,
          documentId: pendingNativePlanReview.planDocumentId,
          revisionId: pendingNativePlanReview.planRevisionId,
          revisionNumber: pendingNativePlanReview.planRevisionNumber,
          stage: pendingNativePlanReview.stage,
          reviewerAgentId: pendingNativePlanReview.reviewerAgentId,
        } as const;
        let parsedPlanInteraction = parsePlanReviewInteraction(interaction, planIdentity);
        if (parsedPlanInteraction.kind === "untrusted") {
          const rawVerdict = parsePlanReviewVerdictResult(interaction.result);
          const attested = rawVerdict && await nativePlanVerdictIsAttested({
            companyId: ctx.agent.companyId,
            reviewerAgentId: nativePlanReview.reviewerAgentId,
            reviewerChildIssueId: nativePlanReview.reviewerChildIssueId,
            interactionId: interaction.id,
            verdict: rawVerdict.kind,
            authToken: ctx.authToken,
            runId: ctx.runId,
          });
          if (attested) {
            // Paperclip's current native-MCP transport stores the board
            // principal on the interaction.  The exact heartbeat receipt
            // above is the narrower, durable reviewer attribution.
            parsedPlanInteraction = parsePlanReviewInteraction({
              ...interaction,
              resolvedByAgentId: nativePlanReview.reviewerAgentId,
            }, planIdentity);
          }
        }
        if (parsedPlanInteraction.kind === "untrusted") {
          // Paperclip currently permits a human override for any addressed
          // agent card. That is useful for board operations but cannot become
          // a synthetic Luna/Terra decision: it would make the reviewer
          // reviewer decision: a human override is not a Luna/Terra verdict.
          // Request a fresh immutable provider plan rather than minting a
          // second card for this already-terminal review cycle.
          return await requestFreshPlanRevision(interaction.id, nativePlanReview.julesActivityId);
        }
        // An answered native plan card is a durable reviewer decision and must
        // win over stale provider activity discovered in the same poll.  A
        // previous question can remain in Jules' terminal activity history;
        // letting that history gate this branch strands the answered verdict
        // in Paperclip and never relays it to Jules.  Pending/malformed cards
        // still wait behind the provider-question lane.
        const hasAnsweredPlanVerdict = parsedPlanInteraction.kind === "v2" && parsedPlanInteraction.state === "answered" ||
          parsedPlanInteraction.kind === "legacy" && parsedPlanInteraction.state !== "pending";
        if (hasUnresolvedProviderQuestion && !hasAnsweredPlanVerdict) return await yieldHeartbeat(session);
        if (interaction.status === "pending") {
          if (nativePlanReview.protocolVersion === 2 && nativePlanReview.reviewerChildIssueId) {
            let lifecycle;
            try {
              const [reviewerChild, reviewerRuns] = await Promise.all([
                getPaperclipIssue(nativePlanReview.reviewerChildIssueId, ctx.authToken, ctx.runId),
                ctx.agent.companyId
                  ? readNativePlanReviewRuns({
                    companyId: ctx.agent.companyId,
                    reviewerAgentId: nativePlanReview.reviewerAgentId,
                    authToken: ctx.authToken,
                    runId: ctx.runId,
                  })
                  : Promise.resolve([]),
              ]);
              const canonicalCards = interactions.filter((candidate) =>
                candidate.kind === "request_item_verdicts" &&
                candidate.status === "pending" &&
                candidate.addresseeAgentId === nativePlanReview.reviewerAgentId,
              );
              lifecycle = decideNativePlanReviewLifecycle({
                identity: {
                  childIssueId: nativePlanReview.reviewerChildIssueId,
                  interactionId: interaction.id,
                  reviewerAgentId: nativePlanReview.reviewerAgentId,
                },
                childStatus: reviewerChild.status,
                card: canonicalCards.length > 1
                  ? { duplicate: canonicalCards }
                  : interaction,
                runs: reviewerRuns,
                nowMs: Date.now(),
                maxRecoveryAttempts: 1,
              });
            } catch (error) {
              await ctx.onLog?.(
                "stderr",
                `[jules] Native plan-review evidence unavailable for card ${interaction.id}: ${sanitizeError(error)}\n`,
              );
              const authorizationFailure = error instanceof PaperclipClientError &&
                (error.status === 401 || error.status === 403);
              return {
                exitCode: 1, signal: null, timedOut: false, clearSession: false,
                errorCode: authorizationFailure
                  ? "paperclip_plan_review_evidence_unauthorized"
                  : "paperclip_plan_review_evidence_unavailable",
                errorFamily: authorizationFailure ? null : "transient_upstream",
                errorMessage: sanitizeError(error),
                sessionParams: serializeSession(session),
                ...(!authorizationFailure
                  ? { retryNotBefore: new Date(Date.now() + reattachDelayMs).toISOString() }
                  : {}),
              };
            }

            switch (lifecycle.action) {
              case "wake_card":
              case "recover_card":
                // Paperclip agent tokens may invoke only their own agent.
                // The Jules worker owns the parent/session monitor; the
                // orchestrator owns cross-agent reviewer dispatch and bounded
                // recovery for this durable child card.
                return await yieldHeartbeat(session);
              case "await_run":
              case "await_verdict":
                return await yieldHeartbeat(session);
              case "consume_verdict":
                break;
              case "create_card":
                await moveIssueToBlocked(taskId, ctx.authToken, ctx.runId).catch(() => undefined);
                return {
                  exitCode: 1, signal: null, timedOut: false, clearSession: false,
                  errorCode: "native_plan_review_protocol_failure",
                  errorFamily: null,
                  errorMessage: `Native plan-review card ${interaction.id} disappeared from its canonical pointer.`,
                  sessionParams: serializeSession(session),
                };
              case "escalate_protocol_failure":
                await moveIssueToBlocked(taskId, ctx.authToken, ctx.runId).catch(() => undefined);
                return {
                  exitCode: 1, signal: null, timedOut: false, clearSession: false,
                  errorCode: "native_plan_review_protocol_failure",
                  errorFamily: null,
                  errorMessage: `Native plan-review protocol failure for card ${interaction.id}: ${lifecycle.reason}.`,
                  sessionParams: serializeSession(session),
                };
              default:
                return assertNever(lifecycle);
            }
          }
          // v1 used request_confirmation. Paperclip cannot authorize that card
          // to run a non-assignee reviewer, so its automatic wake is cancelled
          // as issue_assignee_changed. Migrate only a still-pending legacy card;
          // resolved legacy decisions remain authoritative and are never
          // withdrawn or replayed.
          if (parsedPlanInteraction.kind === "legacy" && parsedPlanInteraction.state === "pending") {
            await withdrawPaperclipInteraction(
              reviewIssueId,
              interaction.id,
              "Migrating the pending legacy plan review to the v2 typed verdict protocol.",
              ctx.authToken,
              ctx.runId,
            );
            const child = await createJulesQuestionAdjudication(
              taskId, pendingNativePlanReview.reviewerAgentId, pendingNativePlanReview.question,
              ctx.authToken, ctx.runId, ctx.agent.companyId, pendingNativePlanReview.julesActivityId,
              session.julesSessionId, 0, true, "plan",
            );
            const migrated = await createJulesPlanReviewChildInteraction(
              child.id,
              taskId,
              session.julesSessionId!,
              {
                documentId: pendingNativePlanReview.planDocumentId,
                revisionId: pendingNativePlanReview.planRevisionId,
                revisionNumber: pendingNativePlanReview.planRevisionNumber,
              },
              pendingNativePlanReview.question,
              pendingNativePlanReview.stage,
              pendingNativePlanReview.reviewerAgentId,
              ctx.authToken,
              ctx.runId,
              pendingNativePlanReview.julesActivityId,
            );
            session.pendingInteraction = {
              ...pendingNativePlanReview,
              protocolVersion: 2,
              paperclipInteractionId: migrated.id,
              reviewerChildIssueId: child.id,
            };
            await persistSessionBestEffort(session, ctx.onLog);
          }
          return await yieldHeartbeat(session);
        }
        const verdict = parsedPlanInteraction.kind === "v2" && parsedPlanInteraction.state === "answered"
          ? parsedPlanInteraction.decision
            ? parsedPlanInteraction.decision.kind === "approve"
              ? { decision: "approve" as const }
              : { decision: "reject" as const, reason: parsedPlanInteraction.decision.reason! }
            : null
          : parsedPlanInteraction.kind === "legacy" && parsedPlanInteraction.state !== "pending"
            ? parsedPlanInteraction.state === "accepted"
              ? { decision: "approve" as const }
              : parsedPlanInteraction.reason
                ? { decision: "reject" as const, reason: parsedPlanInteraction.reason }
                : null
            : null;
        if (!verdict) return await yieldHeartbeat(session);
        if (verdict.decision === "reject") {
          return await requestFreshPlanRevision(
            interaction.id,
            pendingNativePlanReview.julesActivityId,
            verdict.reason,
          );
        }
        if (pendingNativePlanReview.stage === "luna" && config.planStrongReviewerAgentId) {
          const nextChild = await createJulesQuestionAdjudication(
            taskId, config.planStrongReviewerAgentId, pendingNativePlanReview.question,
            ctx.authToken, ctx.runId, ctx.agent.companyId, pendingNativePlanReview.julesActivityId,
            session.julesSessionId, 0, true, "plan",
          );
          const next = await createJulesPlanReviewChildInteraction(
            nextChild.id,
            taskId,
            session.julesSessionId!,
            { documentId: pendingNativePlanReview.planDocumentId, revisionId: pendingNativePlanReview.planRevisionId, revisionNumber: pendingNativePlanReview.planRevisionNumber },
            pendingNativePlanReview.question,
            "terra",
            config.planStrongReviewerAgentId,
            ctx.authToken,
            ctx.runId,
            pendingNativePlanReview.julesActivityId,
          );
          session.pendingInteraction = {
            ...pendingNativePlanReview,
            type: "plan_native_review",
            protocolVersion: 2,
            paperclipInteractionId: next.id,
            reviewerAgentId: config.planStrongReviewerAgentId,
            stage: "terra",
            reviewerChildIssueId: nextChild.id,
          };
          await persistSessionBestEffort(session, ctx.onLog);
          return await yieldHeartbeat(session);
        }
        if (pendingNativePlanReview.stage === "terra") {
          await client.approvePlan(session.julesSessionId!);
          session.planApprovedAt = new Date().toISOString();
          session.planApprovedActivityId = pendingNativePlanReview.julesActivityId;
          session.planReviewOutcome = "approved";
          session.pendingInteraction = undefined;
          await persistSessionBestEffort(session, ctx.onLog);
          return await yieldHeartbeat(session);
        }
        return await yieldHeartbeat(session);
        }
      }

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
            session.planApprovedActivityId = pendingPlanAgentReview.julesActivityId;
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
      await ctx.onLog?.("stdout", `[jules] Question reconciliation checkpoint: pending=${session.pendingInteraction?.type ?? "none"}, native=${session.pendingInteraction?.type === "agent_adjudication" ? isNativeAgentAdjudication(session.pendingInteraction) : false}, terminal=${terminalProviderState}, hasQuestion=${hasUnresolvedProviderQuestion}.\n`);
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

      // Completion is terminal authority. Do not recreate or retain a question
      // adjudication after Jules has produced its PR: it would mask the PR
      // handoff and keep the external-session monitor alive indefinitely.
      const terminalQuestionDisposition = session.pendingInteraction?.type === "agent_adjudication"
        ? evaluateTerminalQuestionDisposition({
          terminal: terminalProviderState,
          followsCompletion: session.pendingInteraction.julesActivityId === latestAgentActivity?.id && terminalMessageRequiresAdjudication,
          terminalAnswerRecorded: session.terminalFeedbackActivityId === session.pendingInteraction.julesActivityId,
        })
        : { action: "not_terminal" } as const;
      if (terminalQuestionDisposition.action === "retire" && session.pendingInteraction?.type === "agent_adjudication") {
        const staleAdjudication = session.pendingInteraction;
        const helperIssueId = isNativeAgentAdjudication(staleAdjudication)
          ? staleAdjudication.reviewerChildIssueId
          : staleAdjudication.adjudicationIssueId;
        if (helperIssueId) await completeInternalReviewIssue(helperIssueId, ctx.authToken, ctx.runId).catch(() => undefined);
        if (staleAdjudication.paperclipInteractionId) {
          await withdrawPaperclipInteraction(taskId, staleAdjudication.paperclipInteractionId,
            "Superseded by terminal Jules completion", ctx.authToken, ctx.runId).catch(() => undefined);
        }
        session.pendingInteraction = undefined;
        session.deferredPlanReview = undefined;
        session.deliveredFeedbackActivityId = staleAdjudication.julesActivityId;
        await persistSessionBestEffort(session, ctx.onLog);
      }

      if (session.pendingInteraction?.type === "agent_adjudication" &&
          !(terminalProviderState && !hasUnresolvedProviderQuestion)) {
        const pending = session.pendingInteraction;
        // Native structured form protocol. New sessions use the child bridge;
        // the direct parent form below remains only for backward-compatible
        // reads of already answered legacy sessions.
        if (isNativeAgentAdjudication(pending)) {
          // Migrate sessions written before the child-form bridge. The old
          // parent card remains the audit record, but must no longer be used
          // as Terra's wake target because the parent is owned by Jules.
          if (pending.transport !== "child_form_bridge") {
            const reviewerChild = await createJulesQuestionAdjudication(
              taskId,
              pending.reviewerAgentId,
              pending.question,
              ctx.authToken,
              ctx.runId,
              ctx.agent.companyId,
              pending.julesActivityId,
              session.julesSessionId,
              (pending.adjudicationGeneration ?? 0) + 1,
              true,
            );
            const reviewerInteraction = await createJulesQuestionReviewInteraction(
              reviewerChild.id,
              taskId,
              session.julesSessionId!,
              pending.julesActivityId,
              pending.question,
              pending.reviewerAgentId,
              ctx.authToken,
              ctx.runId,
            );
            await activateInternalReviewIssue(
              reviewerChild.id, pending.reviewerAgentId, ctx.authToken, ctx.runId,
            );
            session.pendingInteraction = {
              ...pending,
              transport: "child_form_bridge",
              reviewerChildIssueId: reviewerChild.id,
              reviewerInteractionId: reviewerInteraction.id,
            };
            await persistSessionBestEffort(session, ctx.onLog);
            return await yieldHeartbeat(session);
          }
          if (pending.transport === "child_form_bridge" && pending.reviewerChildIssueId && pending.reviewerInteractionId) {
            // Older builds could persist the child bridge after its visible
            // parent form had been deleted. Probe that parent only when the
            // current provider question proves this exact bridge remains live.
            const nativeQuestionStillOpen = latestAgentActivity === undefined ||
              (hasUnresolvedProviderQuestion && latestAgentActivity.id === pending.julesActivityId);
            const parentForm = nativeQuestionStillOpen
              ? await getPaperclipInteraction(
                taskId, pending.paperclipInteractionId, ctx.authToken, ctx.runId,
              ).catch(() => null)
              : null;
            const childIssue = await getPaperclipIssue(
              pending.reviewerChildIssueId, ctx.authToken, ctx.runId,
            ).catch(() => null);
            const childForm = await getPaperclipInteraction(
              pending.reviewerChildIssueId, pending.reviewerInteractionId, ctx.authToken, ctx.runId,
            ).catch(() => null);
            const childState = classifyNativeQuestionReview(childForm?.status, childForm?.result);
            const childDecision = childState.state === "answered" && childState.decision !== "malformed"
              ? childState.decision
              : null;
            if (childDecision && !nativeQuestionStillOpen) {
              // The reviewer completed a bridge for an older provider
              // activity. Never relay that answer after Jules has moved on:
              // doing so answers the wrong question and hides the current one
              // from the typed Paperclip review path. Retire only the stale
              // local pointer, then let the current activity open its own
              // structured reviewer card below.
              await completeInternalReviewIssue(pending.reviewerChildIssueId, ctx.authToken, ctx.runId).catch(() => undefined);
              session.pendingInteraction = session.deferredPlanReview;
              session.deferredPlanReview = undefined;
              session.phase = "RUNNING";
              await persistSessionBestEffort(session, ctx.onLog);
            } else if (childDecision) {
              await resolveJulesAgentAdjudicationInteraction(
                taskId,
                pending.paperclipInteractionId,
                childDecision.kind === "ANSWER" ? "answer" : "escalate",
                childDecision.kind === "ANSWER" ? childDecision.answer : childDecision.reason,
                ctx.authToken,
                ctx.runId,
              );
              await completeInternalReviewIssue(pending.reviewerChildIssueId, ctx.authToken, ctx.runId).catch(() => undefined);
              if (childDecision.kind === "ANSWER") {
                if (session.deliveredFeedbackActivityId !== pending.julesActivityId) {
                  await client.sendMessage(session.julesSessionId!, { prompt: childDecision.answer });
                }
                session.deliveredFeedbackActivityId = pending.julesActivityId;
                session.pendingInteraction = session.deferredPlanReview;
                session.deferredPlanReview = undefined;
                session.phase = "RUNNING";
                session = resumePlanReviewAfterQuestionResolution(session);
                await persistSessionBestEffort(session, ctx.onLog);
                return await yieldHeartbeat(session);
              }
              const attempt = (session.feedbackInteractionAttempt ?? 0) + 1;
              const interaction = await runCheckpointedMutation({
                session: session!,
                key: `jules:human-escalation:${taskId}:${session!.julesSessionId}:${pending.julesActivityId}`,
                operation: "create_human_escalation_interaction",
                issueId: taskId,
                sessionId: session!.julesSessionId,
                activityId: pending.julesActivityId,
                persist: () => persistSessionBestEffort(session!, ctx.onLog),
                run: () => createJulesHumanEscalationInteraction(
                  taskId, session!.julesSessionId!, pending.julesActivityId,
                  pending.question, childDecision.reason, ctx.authToken, ctx.runId,
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
            }
            const terminalChild = childIssue?.status === "done" || childIssue?.status === "cancelled";
            const malformedForm = childState.state === "answered" && childState.decision === "malformed";
            const expiredBridge = isExpiredQuestionBridge(childForm?.result, childForm?.status);
            // A persisted bridge can outlive its child after a Paperclip
            // cleanup/recovery. A missing child or typed form is not a valid
            // reviewer wait: without this branch the provider question stays
            // unanswered indefinitely while every heartbeat merely yields.
            // Recover through the same bounded generation path as terminal or
            // malformed reviewer work; never synthesize a prose reply.
            const missingBridge = !childIssue || !childForm;
            if (!childDecision && (terminalChild || malformedForm || missingBridge)) {
              // A reviewer can race the bridge and finish the helper from its
              // description before the typed form is posted. Never reopen that
              // terminal task: its prose/comment history is not a decision for
              // this provider question. Create one bounded fresh generation.
              const recoveryCount = session.adjudicationRecoveryCount ?? 0;
              // Before form-before-activation was enforced, the same bridge
              // race could consume the old generic budget. Permit exactly one
              // separately checkpointed repair for its unmistakable native
              // `expired: issue_closed` signature. This migrates affected live
              // sessions without weakening the bounded retry policy for every
              // other terminal or malformed reviewer outcome.
              const bridgeRepairAttempt = session.adjudicationBridgeRepairAttempt ?? 0;
              const canRepairExpiredBridge = expiredBridge && bridgeRepairAttempt < 1;
              // A missing parent is not an ordinary child retry: it removes
              // the only answerable Paperclip record for a live Jules
              // question. Repair this legacy state exactly once, even if an
              // older build exhausted the generic child recovery budget.
              const missingParentBridge = nativeQuestionStillOpen && !parentForm;
              const missingParentRepairAttempt = session.missingParentBridgeRepairAttempt ?? 0;
              const canRepairMissingParentBridge = missingParentBridge && missingParentRepairAttempt < 1;
              if ((recoveryCount < 2 || canRepairExpiredBridge || canRepairMissingParentBridge) &&
                  ctx.agent.companyId && session.julesSessionId) {
                const generation = (pending.adjudicationGeneration ?? 0) + 1;
                const repairedParent = canRepairMissingParentBridge
                  ? await runCheckpointedMutation({
                    session: session!,
                    key: `jules:agent-adjudication:${taskId}:${session!.julesSessionId}:${pending.julesActivityId}`,
                    operation: "repair_missing_agent_adjudication_interaction",
                    issueId: taskId,
                    sessionId: session!.julesSessionId,
                    activityId: pending.julesActivityId,
                    persist: () => persistSessionBestEffort(session!, ctx.onLog),
                    run: () => createJulesAgentAdjudicationInteraction(
                      taskId, session!.julesSessionId!, pending.julesActivityId,
                      pending.question, pending.reviewerAgentId, ctx.authToken, ctx.runId,
                    ),
                  })
                  : undefined;
                const replacement = await createJulesQuestionAdjudication(
                  taskId, pending.reviewerAgentId, pending.question, ctx.authToken,
                  ctx.runId, ctx.agent.companyId, pending.julesActivityId,
                  session.julesSessionId, generation, true,
                );
                const replacementForm = await createJulesQuestionReviewInteraction(
                  replacement.id, taskId, session.julesSessionId,
                  pending.julesActivityId, pending.question, pending.reviewerAgentId,
                  ctx.authToken, ctx.runId,
                );
                await activateInternalReviewIssue(
                  replacement.id, pending.reviewerAgentId, ctx.authToken, ctx.runId,
                );
                session.pendingInteraction = {
                  ...pending,
                  ...(repairedParent ? { paperclipInteractionId: repairedParent.id } : {}),
                  reviewerChildIssueId: replacement.id,
                  reviewerInteractionId: replacementForm.id,
                  adjudicationGeneration: generation,
                };
                if (canRepairExpiredBridge) {
                  session.adjudicationBridgeRepairAttempt = bridgeRepairAttempt + 1;
                } else if (canRepairMissingParentBridge) {
                  session.missingParentBridgeRepairAttempt = missingParentRepairAttempt + 1;
                } else {
                  session.adjudicationRecoveryCount = recoveryCount + 1;
                }
                await persistSessionBestEffort(session, ctx.onLog);
              }
            }
            return await yieldHeartbeat(session);
          }
          const form = await getPaperclipInteraction(
            taskId, pending.paperclipInteractionId, ctx.authToken, ctx.runId,
          ).catch(() => null);
          const formState = classifyNativeQuestionReview(form?.status, form?.result);
          const decision = formState.state === "answered" && formState.decision !== "malformed"
            ? formState.decision
            : null;
          if (decision?.kind === "ANSWER") {
            if (session.deliveredFeedbackActivityId !== pending.julesActivityId) {
              await client.sendMessage(session.julesSessionId!, { prompt: decision.answer });
            }
            session.deliveredFeedbackActivityId = pending.julesActivityId;
            session.pendingInteraction = session.deferredPlanReview;
            session.deferredPlanReview = undefined;
            session.phase = "RUNNING";
            await persistSessionBestEffort(session, ctx.onLog);
            return await yieldHeartbeat(session);
          }
          if (decision?.kind === "ESCALATE" || formState.state === "answered") {
            const reason = decision?.kind === "ESCALATE"
              ? decision.reason
              : "The reviewer submitted an invalid structured decision; human clarification is required.";
            const activityId = pending.julesActivityId;
            const attempt = (session.feedbackInteractionAttempt ?? 0) + 1;
            const interaction = await runCheckpointedMutation({
              session: session!,
              key: `jules:human-escalation:${taskId}:${session!.julesSessionId}:${activityId}`,
              operation: "create_human_escalation_interaction",
              issueId: taskId,
              sessionId: session!.julesSessionId,
              activityId,
              persist: () => persistSessionBestEffort(session!, ctx.onLog),
              run: () => createJulesHumanEscalationInteraction(
                taskId, session!.julesSessionId!, activityId,
                pending.question, reason, ctx.authToken, ctx.runId,
              ),
            });
            session.feedbackInteractionAttempt = attempt;
            session.pendingInteraction = {
              type: "user_feedback", julesActivityId: pending.julesActivityId,
              paperclipInteractionId: interaction.id, question: pending.question,
              createdAt: new Date().toISOString(),
            };
            await persistSessionBestEffort(session, ctx.onLog);
          }
          // A stale bridge was cleared above. Fall through in this same poll
          // so the newer immutable provider activity opens its own typed
          // reviewer card instead of waiting one whole polling interval.
          if (session.pendingInteraction?.type === "agent_adjudication" &&
              session.pendingInteraction.julesActivityId === pending.julesActivityId) {
            return await yieldHeartbeat(session);
          }
        }
        // Migration-only child protocol. A malformed legacy record must not
        // fall through into side effects with an unknown child identity.
        if (isNativeAgentAdjudication(pending)) {
          if (session.pendingInteraction?.type === "agent_adjudication") {
            return await yieldHeartbeat(session);
          }
        } else {
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
        const adjudication = evaluateQuestionAdjudicationChild({
          status: adjudicationIssue?.status,
          reviewerAgentId: pending.reviewerAgentId,
          comments,
        });
        const decision = adjudication.decision;
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
            key: `jules:human-escalation:${taskId}:${session!.julesSessionId}:${activityId}`,
            operation: "create_human_escalation_interaction",
            issueId: taskId,
            sessionId: session!.julesSessionId,
            activityId,
            persist: () => persistSessionBestEffort(session!, ctx.onLog),
            run: () => createJulesHumanEscalationInteraction(
              taskId,
              session!.julesSessionId!,
              activityId,
              pending.question,
              decision.reason,
              ctx.authToken,
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
        if (adjudication.state === "protocol_error") {
          const recoveryCount = session.adjudicationRecoveryCount ?? 0;
          if (recoveryCount < 1) {
            // Paperclip deliberately rejects a bare terminal done->todo patch.
            // Create a new generation instead: the old child remains an audit
            // record, while the same visible card and provider activity are
            // bound to exactly one fresh adjudicator task.
            const replacementReviewerId = config.questionAdjudicatorAgentId ?? config.questionReviewerAgentId;
            if (!replacementReviewerId || !ctx.agent.companyId || !session.julesSessionId) {
              return await yieldHeartbeat(session);
            }
            const replacement = await createJulesQuestionAdjudication(
              taskId,
              replacementReviewerId,
              pending.question,
              ctx.authToken,
              ctx.runId,
              ctx.agent.companyId,
              pending.julesActivityId,
              session.julesSessionId,
              1,
            );
            session.pendingInteraction = {
              ...pending,
              adjudicationIssueId: replacement.id,
              reviewerAgentId: replacementReviewerId,
              adjudicationGeneration: 1,
            };
            session.adjudicationRecoveryCount = recoveryCount + 1;
            await persistSessionBestEffort(session, ctx.onLog);
          }
          // Keep the visible card and provider question pending. Prose from a
          // terminal child is never permission to answer Jules; the bounded
          // generation transition prevents a new child/card every heartbeat.
          return await yieldHeartbeat(session);
        }
        if (adjudicationIssue?.status === "cancelled" ||
            adjudicationIssue?.assigneeAgentId !== pending.reviewerAgentId) {
          session.pendingInteraction = undefined;
          await persistSessionBestEffort(session, ctx.onLog);
        } else {
          return await yieldHeartbeat(session);
        }
        }
        }
      }

      const stateMachineRes = handleJulesState(state, !!session.currentPrUrl);
      session.phase = stateMachineRes.nextPhase;
      if (stateMachineRes.isTerminal) {
        // A terminal provider state is authoritative over historical question
        // activities. The terminal branch below retires any pending question
        // bridge and performs the durable PR handoff.
        session.phase = stateMachineRes.nextPhase;
      } else if (hasUnresolvedProviderQuestion) {
        session.phase = "WAITING_FOR_FEEDBACK";
      }

      // The terminal scanner retains the newest plan as a durable witness.
      // `mirrorActivities` may legitimately suppress already-delivered events,
      // but delivery is not review completion. Recover the witness here so the
      // plan gate always sees the provider's current plan.
      const unapprovedPlan = latestPlan(activities) ??
        (session.terminalActivityScan?.latestPlan
          ? terminalEvidenceActivity(session.terminalActivityScan.latestPlan)
          : undefined);
      const isPlanningTurnCompleted = isPlanApprovalRequired({
        requirePlanApproval: config.requirePlanApproval,
        planActivityId: unapprovedPlan?.id,
        planApprovedAt: session.planApprovedAt,
        planApprovedActivityId: session.planApprovedActivityId,
        supersededPlanActivityId: session.supersededPlanActivityId,
      });
      // A typed native-plan rejection makes the next provider plan activity a
      // mandatory new review cycle, even if a terminal-state heuristic or
      // delivery checkpoint would otherwise classify it as historical. This is
      // intentionally narrower than "any terminal plan": only the exact
      // rejection continuation can defer an existing PR handoff.
      const isCurrentBranchBoundRecovery =
        session.prRemediation?.recoverySessionId === session.julesSessionId;
      // The persisted phase can remain WAITING_FOR_PLAN_APPROVAL after a
      // process loss even when Jules has completed. The provider observation,
      // not that stale local phase, is the terminal authority for recovery.
      const terminalReplacementPlan = terminalProviderState &&
        Boolean(unapprovedPlan?.id) &&
        (
          // A branch-bound recovery can complete immediately after publishing
          // its first plan, regardless of whether it was started for a plan
          // revision or failed CI. That plan is a new provider contract and
          // must reach Luna before the older PR's terminal CI state is allowed
          // to consume the recovery. Do not consult planApprovedActivityId
          // here: pre-v2 recovery code could persist a stale approval marker
          // for the same provider activity while failing before it created the
          // native card. The recovery-session identity is the durable fence.
          isCurrentBranchBoundRecovery ||
          (unapprovedPlan?.id !== session.planApprovedActivityId &&
            session.planReviewOutcome === "revision_requested")
        );

      // A completed PR normally supersedes a stale question bridge. A newer,
      // unapproved plan is different: it is durable evidence that a reviewer
      // asked Jules to revise that exact PR handoff. Present that plan before
      // PR remediation, otherwise the terminal path can fail the session while
      // hiding the only actionable provider response.
      const terminalPrHandoff = stateMachineRes.isTerminal &&
        Boolean(session.currentPrUrl) && !terminalReplacementPlan;
      if (!terminalPrHandoff && hasUnresolvedProviderQuestion) {
        // A provider question is actionable work even when the same poll also
        // contains a planGenerated activity. Preserve the plan-review state in
        // deferredPlanReview and let the strong question reviewer run first.
        session.phase = "WAITING_FOR_FEEDBACK";
      } else if (!terminalPrHandoff && (isPlanningTurnCompleted || terminalReplacementPlan)) {
        session.phase = "WAITING_FOR_PLAN_APPROVAL";
      } else if (stateMachineRes.isTerminal) {
         if (session.currentPrUrl && (session.phase === "COMPLETED" || session.phase === "FAILED")) {
           const skipCi =
             (ctx.agent.adapterConfig as Record<string, unknown> | undefined)?.["ciPolicy"] === "skip" ||
             (ctx.config as Record<string, unknown> | undefined)?.["ciPolicy"] === "skip";
           const terminalPrDecision = decideTerminalPrLifecycle({
             providerState: session.phase,
             hasPr: true,
             ciStatus: skipCi ? "success" : terminalPrDetails?.ciStatus ?? "unknown",
             hasRecoverySession: Boolean(session.prRemediation?.recoverySessionId),
           });
           switch (terminalPrDecision.action) {
             case "route_to_review":
               break;
             case "await_ci":
               session.phase = "RUNNING";
               return await yieldHeartbeat(session);
             case "start_pr_remediation":
               return await scheduleTerminalPrRemediation();
             case "await_pr_remediation":
               return {
                 exitCode: 1,
                 signal: null,
                 timedOut: false,
                 errorCode: "jules_pr_remediation_failed",
                 errorFamily: null,
                 errorMessage: "The single branch-bound Jules remediation session failed after the PR handoff.",
                 sessionParams: serializeSession(session),
                 clearSession: false,
               };
             default:
               throw new Error(`Invalid terminal PR lifecycle action: ${terminalPrDecision.action}`);
           }
         }
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

             // A terminal PR handoff is no longer provider polling work. Clear
             // only Jules' native monitor before returning; the orchestrator
             // still owns the independent Paperclip review workflow. Without
             // this boundary, a monitor left in `triggered` with no
             // `nextCheckAt` re-runs the completed session on every scheduler
             // tick and can create/cancel review cards indefinitely.
             await clearJulesSessionMonitor(taskId, ctx.authToken, ctx.runId).catch(async (error) => {
               await ctx.onLog?.("stderr", `[jules] Could not clear terminal session monitor: ${sanitizeError(error)}\n`);
             });
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
                 summary: scopeDriftSummary && !scopeDriftIsNew
                   ? null
                   : `Jules session ${session.julesSessionId} completed, created a PR, and moved the Paperclip issue to review: ${session.currentPrUrl}`,
                 resultJson: {
                   provider: "jules",
                   julesSessionId: session.julesSessionId,
                   prUrl: session.currentPrUrl,
                   issueStatus: "in_review",
                   ...(scopeDriftSummary
                     ? { scopeConformant: false, scopeDriftSummary, providerMessageSent: false }
                     : {}),
                 },
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

      if (stateMachineRes.requiresReturn || isPlanningTurnCompleted || terminalReplacementPlan || hasUnresolvedProviderQuestion) {
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
                : isPlanningTurnCompleted || terminalReplacementPlan
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
              const planActivityId = session.pendingInteraction?.type === "plan_approval"
                || session.pendingInteraction?.type === "plan_native_review"
                || session.pendingInteraction?.type === "plan_agent_review"
                ? session.pendingInteraction.julesActivityId
                : undefined;
              session = recordPlanApprovalRelayed(session, planActivityId);
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
              const reviewerAgentId = config.questionAdjudicatorAgentId ?? config.questionReviewerAgentId;
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
              const reviewerChild = await createJulesQuestionAdjudication(
                taskId,
                reviewerAgentId,
                action.question,
                ctx.authToken,
                ctx.runId,
                ctx.agent.companyId,
                activityId,
                session.julesSessionId,
                0,
                true,
              );
              const reviewerInteraction = await createJulesQuestionReviewInteraction(
                reviewerChild.id,
                taskId,
                session.julesSessionId,
                activityId,
                action.question,
                reviewerAgentId,
                ctx.authToken,
                ctx.runId,
              );
              await activateInternalReviewIssue(
                reviewerChild.id, reviewerAgentId, ctx.authToken, ctx.runId,
              );
              session.pendingInteraction = {
                type: "agent_adjudication",
                julesActivityId: asJulesActivityId(activityId),
                paperclipInteractionId: visibleInteraction.id,
                question: action.question,
                reviewerAgentId,
                nativeForm: true,
                transport: "child_form_bridge",
                reviewerChildIssueId: reviewerChild.id,
                reviewerInteractionId: reviewerInteraction.id,
                createdAt: new Date().toISOString(),
              };
              await persistSessionBestEffort(session, ctx.onLog);
              return await yieldHeartbeat(session);
            }

            case "CREATE_PLAN_CARD": {
              const activity = latestPlan(activities);
              const activityId = activity?.id ?? "awaiting-plan-approval";
              session.supersededPlanActivityId = undefined;
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
                const reviewerChild = await createJulesQuestionAdjudication(
                  taskId, config.planReviewerAgentId!, fullPlan, ctx.authToken, ctx.runId,
                  ctx.agent.companyId, activityId, session.julesSessionId, 0, true, "plan",
                );
                const review = await runCheckpointedMutation({
                  session: session!,
                  key: `jules:plan-review:${taskId}:${revision.revisionId}:luna`,
                  operation: "create_native_plan_review",
                  issueId: taskId,
                  sessionId: session!.julesSessionId,
                  activityId,
                  persist: () => persistSessionBestEffort(session!, ctx.onLog),
                  run: () => createJulesPlanReviewChildInteraction(reviewerChild.id, taskId, session!.julesSessionId!, revision, fullPlan, "luna", config.planReviewerAgentId!, ctx.authToken, ctx.runId, activityId),
                });
                session.planReviewRevisionId = revision.revisionId;
                session.planReviewOutcome = undefined;
            session.pendingInteraction = { type: "plan_native_review", protocolVersion: 2, julesActivityId: asJulesActivityId(activityId), question: fullPlan, planDocumentId: revision.documentId, planRevisionId: revision.revisionId, planRevisionNumber: revision.revisionNumber, paperclipInteractionId: review.id, reviewerAgentId: config.planReviewerAgentId, stage: "luna", reviewerChildIssueId: reviewerChild.id, createdAt: new Date().toISOString() };
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
                session = recordPlanApprovalRelayed(session, activityId);
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
              return await yieldHeartbeat(session);
          }
        } catch (error) {
          return paperclipInteractionFailure(session, error);
        }
      }

      return await yieldHeartbeat(session);

    } catch (error) {
      if (isPaperclipChildLimitError(error)) {
        // Child-helper exhaustion is a durable Paperclip capacity condition,
        // not a Jules polling failure. Keep the provider session resumable and
        // let the next heartbeat reconcile/reuse or retire helper records.
        await ctx.onLog?.(
          "stderr",
          `[jules] Paperclip helper-child limit reached; keeping the Jules session resumable without creating another child.\n`,
        );
        return await yieldHeartbeat(session, false, {
          summary: `Jules session ${session.julesSessionId} is waiting for Paperclip helper capacity; no duplicate child was created.`,
          resultJson: {
            provider: "jules",
            julesSessionId: session.julesSessionId,
            pending: true,
            helperLimitReached: true,
            issueStatus: "in_progress",
          },
        });
      }
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
