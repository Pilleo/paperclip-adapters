import { JulesAdapterSessionV1 } from "./session.js";
import { PaperclipId, asJulesSessionId, asPrUrl } from "./brands.js";
import type { JulesSessionHandle } from "./jules-session-handle.js";
import { mergeEffectJournals } from "./lifecycle-effect-journal.js";

export type StartupActionType =
  | "RESUME_EXISTING"
  | "START_FRESH"
  | "RELAY_INTERACTION"
  | "NO_OP";

export interface SessionStartupDecision {
  action: StartupActionType;
  forceFreshSession: boolean;
  isInteractionResume: boolean;
  session: JulesAdapterSessionV1 | null;
  reason: string;
}

export function readContextString(context: Record<string, unknown> | undefined, key: string): string | null {
  if (!context) return null;
  const value = context[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function readContextRecord(context: Record<string, unknown> | undefined, key: string): Record<string, unknown> {
  if (!context) return {};
  const value = context[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function isInteractionWake(rawContext: Record<string, unknown>): boolean {
  const paperclipWake = readContextRecord(rawContext, "paperclipWake");
  const wakeSource = readContextString(rawContext, "wakeSource") ?? readContextString(paperclipWake, "wakeSource");
  const wakeReason = readContextString(rawContext, "wakeReason") ?? readContextString(paperclipWake, "wakeReason");

  const contextSnapshot = readContextRecord(rawContext, "contextSnapshot");
  const planReviewInteraction = readContextRecord(rawContext, "planReviewInteraction") ||
    readContextRecord(contextSnapshot, "planReviewInteraction");
  const workspaceRefreshReason = readContextString(rawContext, "workspaceRefreshReason") ??
    readContextString(contextSnapshot, "workspaceRefreshReason");

  return Boolean(
    rawContext["interactionResponse"] ||
    rawContext["providerInteractionStatus"] ||
    (planReviewInteraction && Object.keys(planReviewInteraction).length > 0) ||
    workspaceRefreshReason === "accepted_plan_confirmation" ||
    wakeSource === "interaction_response" ||
    (typeof wakeReason === "string" && /interaction/i.test(wakeReason))
  );
}

export function sessionMatchesConfig(
  session: JulesAdapterSessionV1 | null,
  config: { repository: string; source: string; baseBranch: string },
): boolean {
  if (!session) return false;
  if (!session.repository && !session.source && !session.baseBranch) return true;
  return (
    session.repository === config.repository &&
    session.source === config.source &&
    session.baseBranch === config.baseBranch
  );
}

/**
 * The issue handle is the last durable recovery source after Paperclip has
 * discarded sessionParamsJson.  Built-in adapters on local_trusted do not
 * have an API token, but their loopback Paperclip client is deliberately
 * allowed to read the handle.  Keep this decision pure so tokenless recovery
 * cannot regress when the startup code is refactored.
 */
export function shouldReadIssueSessionHandle(input: {
  readonly hasSession: boolean;
  readonly hasCanonicalSessionId: boolean;
  readonly hasStoredRecoverySession: boolean;
}): boolean {
  return !input.hasSession && !input.hasCanonicalSessionId && !input.hasStoredRecoverySession;
}

/**
 * Paperclip execution configuration is ephemeral: a freshness refresh can
 * replay an older sessionParams envelope while the same Jules session remains
 * active.  These fields, in contrast, are identity-keyed coordination facts
 * about that provider session.  Keep their recovery independent of adapter
 * configuration so a config refresh cannot resend feedback or recreate a
 * native form that has already been resolved.
 *
 * Deliberate clearing is safe: a normal execution persists the cleared value
 * to the local recovery record before the next replay.  This merge only fills
 * absent values from a record for the exact same issue and Jules session.
 */
export function mergeDurableSessionCheckpoints(
  replayed: JulesAdapterSessionV1,
  recovered: JulesAdapterSessionV1,
): JulesAdapterSessionV1 {
  const replayedChild = replayed.childPlanReview;
  const recoveredChild = recovered.childPlanReview;
  const sameChildSession = recovered.paperclipIssueId === replayed.paperclipIssueId && recovered.julesSessionId === replayed.julesSessionId;
  const childDecisionConsumed = sameChildSession && replayedChild && (
    recovered.planApprovedActivityId === replayedChild.identity.activityId ||
    recovered.pendingPlanRevisionRequest?.planActivityId === replayedChild.identity.activityId);
  const newerChildIntent = sameChildSession && recoveredChild && (!replayedChild || (
    recoveredChild.identity.revisionId === replayedChild.identity.revisionId &&
    recoveredChild.identity.activityId === replayedChild.identity.activityId &&
    recoveredChild.identity.stage === "terra" && replayedChild.identity.stage === "luna"));
  const staleLuna = replayed.pendingInteraction?.type === "plan_native_review" &&
    replayed.pendingInteraction.stage === "luna" ? replayed.pendingInteraction : null;
  const durableTerra = recovered.pendingInteraction?.type === "plan_native_review" &&
    recovered.pendingInteraction.stage === "terra" ? recovered.pendingInteraction : null;
  const confirmedTerraReceipt = staleLuna && durableTerra &&
    staleLuna.planRevisionId === durableTerra.planRevisionId &&
    staleLuna.julesActivityId === durableTerra.julesActivityId &&
    recovered.lifecycleEffectJournal?.effects.some((entry) =>
      entry.effectId === `card:terra:${durableTerra.planRevisionId}` &&
      entry.attempt.kind === "confirmed" && entry.attempt.receipt === durableTerra.paperclipInteractionId);
  const hasConfirmedApproval = (value: JulesAdapterSessionV1) =>
    value.planReviewOutcome === "approved" && Boolean(value.planApprovedActivityId) &&
    value.lifecycleEffectJournal?.effects.some((entry) => entry.kind === "approve_plan" &&
      entry.effectId.startsWith(`approve:${value.julesSessionId}:`) && entry.attempt.kind === "confirmed") === true;
  const replayedApproval = hasConfirmedApproval(replayed);
  const recoveredApproval = hasConfirmedApproval(recovered);
  if (replayedApproval && recoveredApproval && replayed.planApprovedActivityId !== recovered.planApprovedActivityId) {
    throw new Error("Jules approval checkpoint conflict across generated plans");
  }
  const approvedSource = recoveredApproval && !replayedApproval ? recovered : replayedApproval ? replayed : null;
  return {
    ...replayed,
    childPlanReview: childDecisionConsumed ? undefined : newerChildIntent ? recoveredChild : replayedChild ?? recoveredChild,
    scopeDriftFingerprint: replayed.scopeDriftFingerprint ?? recovered.scopeDriftFingerprint,
    deliveredFeedbackActivityId: replayed.deliveredFeedbackActivityId ?? recovered.deliveredFeedbackActivityId,
    deliveredFeedbackInteractionId: replayed.deliveredFeedbackInteractionId ?? recovered.deliveredFeedbackInteractionId,
    terminalFeedbackActivityId: replayed.terminalFeedbackActivityId ?? recovered.terminalFeedbackActivityId,
    terminalFeedbackInteractionId: replayed.terminalFeedbackInteractionId ?? recovered.terminalFeedbackInteractionId,
    deliveredActivityIds: replayed.deliveredActivityIds ?? recovered.deliveredActivityIds,
    relayedReviewCommentIds: replayed.relayedReviewCommentIds ?? recovered.relayedReviewCommentIds,
    pendingInteraction: confirmedTerraReceipt ? durableTerra : replayed.pendingInteraction ?? recovered.pendingInteraction,
    lifecycleEffectJournal: mergeEffectJournals(replayed.lifecycleEffectJournal, recovered.lifecycleEffectJournal),
    deferredPlanReview: replayed.deferredPlanReview ?? recovered.deferredPlanReview,
    workerFeedbackDeliveryId: replayed.workerFeedbackDeliveryId ?? recovered.workerFeedbackDeliveryId,
    providerContinuation: replayed.providerContinuation ?? recovered.providerContinuation,
    // The terminal activity cursor is durable progress, not a derived cache.
    // Config refreshes otherwise restart a deep oldest-first scan at page one
    // on every heartbeat and starve terminal question recovery indefinitely.
    terminalActivityScan: replayed.terminalActivityScan ?? recovered.terminalActivityScan,
    // A PR URL and its head SHA are one immutable handoff identity. A
    // Paperclip configuration refresh can replay a sparse session envelope;
    // restoring only the SHA strands a completed provider session because the
    // adapter can neither inspect CI nor route the PR into native review.
    // Only fill an absent URL from the same issue/session recovery record.
    currentPrUrl: replayed.currentPrUrl ?? recovered.currentPrUrl,
    currentPrHeadSha: replayed.currentPrHeadSha ?? recovered.currentPrHeadSha,
    currentPrHeadRef: replayed.currentPrHeadRef ?? recovered.currentPrHeadRef,
    prRemediation: replayed.prRemediation ?? recovered.prRemediation,
    ...(approvedSource?.planApprovedAt ?? replayed.planApprovedAt ?? recovered.planApprovedAt
      ? { planApprovedAt: approvedSource?.planApprovedAt ?? replayed.planApprovedAt ?? recovered.planApprovedAt }
      : {}),
    planApprovedActivityId: approvedSource?.planApprovedActivityId ?? replayed.planApprovedActivityId ?? recovered.planApprovedActivityId,
    planReviewRevisionId: replayed.planReviewRevisionId ?? recovered.planReviewRevisionId,
    planReviewOutcome: approvedSource?.planReviewOutcome ?? replayed.planReviewOutcome ?? recovered.planReviewOutcome,
    pendingPlanRevisionRequest: replayed.pendingPlanRevisionRequest ?? recovered.pendingPlanRevisionRequest,
    supersededPlanActivityId: replayed.supersededPlanActivityId ?? recovered.supersededPlanActivityId,
    unresolvedProviderQuestionActivityId: replayed.unresolvedProviderQuestionActivityId ?? recovered.unresolvedProviderQuestionActivityId,
  };
}

/**
 * Recover an immutable PR handoff when an older generic retry overwrote the
 * `jules-session` document with its own provider ID. The primary Paperclip
 * work product is authoritative for the issue; it is not inferred from prose
 * or from a provider activity. A complete GitHub identity is required so the
 * caller can fail closed rather than retrying from the base branch.
 */
export function recoverPrIdentityFromWorkProduct(
  session: JulesAdapterSessionV1,
  workProduct: { readonly url: string; readonly headSha: string; readonly headRefName: string },
): JulesAdapterSessionV1 {
  return {
    ...session,
    currentPrUrl: workProduct.url as JulesAdapterSessionV1["currentPrUrl"],
    currentPrHeadSha: workProduct.headSha,
    currentPrHeadRef: workProduct.headRefName,
    prRegisteredOnBoard: true,
  };
}

/**
 * Restore the one allowed branch-bound remediation from Paperclip's durable
 * session handle. Local recovery files can be discarded during an ownership
 * transition, so the handle is the durable fence against duplicate Jules work
 * on the same immutable PR branch.
 *
 * Partial handles are ignored: the adapter never infers immutable branch
 * identity from prose, a URL alone, or a different provider session.
 */
export function restoreBranchBoundRemediationFromHandle(
  session: JulesAdapterSessionV1,
  handle: JulesSessionHandle | null,
  startedAt: string,
): JulesAdapterSessionV1 {
  const remediation = handle?.remediation;
  if (!remediation || remediation.recoverySessionId !== session.julesSessionId ||
      !handle?.prUrl || !handle.headSha || !handle.headRefName) {
    return session;
  }
  const {
    pendingInteraction: _pendingInteraction,
    planApprovedAt: _planApprovedAt,
    planApprovedActivityId: _planApprovedActivityId,
    planReviewOutcome: _planReviewOutcome,
    deliveredFeedbackActivityId: _deliveredFeedbackActivityId,
    deliveredFeedbackInteractionId: _deliveredFeedbackInteractionId,
    terminalFeedbackActivityId: _terminalFeedbackActivityId,
    unresolvedProviderQuestionActivityId: _unresolvedProviderQuestionActivityId,
    pendingPlanRevisionRequest: _pendingPlanRevisionRequest,
    ...sessionWithoutReviewCache
  } = session;
  return {
    ...sessionWithoutReviewCache,
    // The issue handle is the durable source for provider/PR identity, not
    // reviewer state. A local session can survive an ownership transfer with
    // a deleted or superseded native-card pointer; restoring it would relay a
    // historical verdict to the recovery session. The execute path
    // reconstructs a real v2 card from its exact session/activity identity,
    // or creates one when none exists.
    currentPrUrl: asPrUrl(handle.prUrl),
    currentPrHeadSha: handle.headSha,
    currentPrHeadRef: handle.headRefName,
    prRegisteredOnBoard: true,
    prRemediation: {
      originalSessionId: remediation.originalSessionId,
      recoverySessionId: remediation.recoverySessionId,
      reason: remediation.reason,
      prUrl: asPrUrl(handle.prUrl),
      headSha: handle.headSha,
      headRefName: handle.headRefName,
      startedAt,
    },
  };
}

/**
 * Paperclip can promote an existing PR to `in_review` while a branch-bound
 * recovery still owns a pending typed provider form.  That promotion has no
 * assignee and would otherwise make the executor release the very session
 * whose form has not been resolved.  Reclaim only this exact, durable shape;
 * an ordinary review handoff or any non-Jules interaction remains untouched.
 */
export function shouldReclaimBranchBoundRecovery(input: {
  session: JulesAdapterSessionV1;
  issue: { status?: string | null; assigneeAgentId?: string | null };
  interactions: readonly { status?: string | null; idempotencyKey?: string | null }[];
}): boolean {
  if (input.session.prRemediation?.recoverySessionId !== input.session.julesSessionId ||
      input.issue.status !== "in_review" || input.issue.assigneeAgentId) return false;
  const prefix = `jules:agent-adjudication:${input.session.paperclipIssueId}:${input.session.julesSessionId}:`;
  return input.interactions.some((interaction) =>
    interaction.status === "pending" && interaction.idempotencyKey?.startsWith(prefix),
  );
}

/**
 * A runtime session envelope is a cache, while a complete branch-bound
 * remediation handle is a single-flight coordination record. Prefer the
 * latter when an old retry envelope names another provider session: otherwise
 * a cancelled owner run can resurrect duplicate work after restart.
 */
export function preferBranchBoundRecoveryHandle(
  session: JulesAdapterSessionV1 | null,
  handle: JulesSessionHandle | null,
  config: { repository: string; source: string; baseBranch: string; taskId: PaperclipId },
  createdAt: string,
): JulesAdapterSessionV1 | null {
  const remediation = handle?.remediation;
  if (!remediation || !handle?.prUrl || !handle.headSha || !handle.headRefName ||
      (session?.julesSessionId === remediation.recoverySessionId)) {
    return session;
  }
  const recoverySessionId = asJulesSessionId(remediation.recoverySessionId);
  return {
    version: 1,
    paperclipIssueId: config.taskId,
    promptHash: session?.promptHash ?? "",
    repository: config.repository,
    source: config.source,
    baseBranch: config.baseBranch,
    phase: "RUNNING",
    sessionId: recoverySessionId,
    julesSessionId: recoverySessionId,
    julesSessionUrl: handle.sessionUrl ?? `https://jules.google.com/session/${recoverySessionId}`,
    attempt: session?.attempt ?? 1,
    failedSessions: session?.failedSessions ?? [],
    createdAt,
    currentPrUrl: asPrUrl(handle.prUrl),
    currentPrHeadSha: handle.headSha,
    currentPrHeadRef: handle.headRefName,
    prRegisteredOnBoard: true,
    prRemediation: {
      originalSessionId: remediation.originalSessionId,
      recoverySessionId: remediation.recoverySessionId,
      reason: remediation.reason,
      prUrl: asPrUrl(handle.prUrl),
      headSha: handle.headSha,
      headRefName: handle.headRefName,
      startedAt: createdAt,
    },
  };
}

export function evaluateSessionStartup(
  rawContext: Record<string, unknown>,
  decodedSession: JulesAdapterSessionV1 | null,
  storedSession: JulesAdapterSessionV1 | null,
  canonicalSessionId: string | null,
  config: { repository: string; source: string; baseBranch: string; taskId: PaperclipId },
  issueHandleSessionId: string | null = null,
): SessionStartupDecision {
  const paperclipWake = readContextRecord(rawContext, "paperclipWake");
  const wakeSource = readContextString(rawContext, "wakeSource") ?? readContextString(paperclipWake, "wakeSource");
  const wakeReason = readContextString(rawContext, "wakeReason") ?? readContextString(paperclipWake, "wakeReason");
  const previousStatus = readContextString(rawContext, "previousStatus") ?? readContextString(paperclipWake, "previousStatus");

  const isInteractionResume = isInteractionWake(rawContext);

  // Status transition only triggers when wakeSource is explicitly status_change
  const isStatusChangeTransition = !isInteractionResume && Boolean(
    wakeSource === "status_change" &&
    (previousStatus === "backlog" || previousStatus === "done" || previousStatus === "cancelled" ||
     (typeof wakeReason === "string" && /(moved from backlog|reopened|archived)/i.test(wakeReason)))
  );

  const forceFreshSession = !isInteractionResume && Boolean(
    (rawContext as { forceFreshSession?: boolean })?.forceFreshSession ||
    (paperclipWake as { forceFreshSession?: boolean })?.forceFreshSession ||
    isStatusChangeTransition
  );

  // Paperclip marks a reconciled native *process* run fresh. That flag is not
  // authorization to replace its durable cloud Jules session or replay POST.
  const recoverySource = readContextString(rawContext, "source");
  const recoveryActionId = readContextString(rawContext, "recoveryActionId");
  const previousRunId = readContextString(rawContext, "previousRunId");
  const recoveryIntended = forceFreshSession && Boolean(
    recoverySource === "execution.reconciled" || wakeReason === "issue_recovery_action_restored" ||
    recoveryActionId || previousRunId,
  );
  const reconciledExecution = forceFreshSession &&
    recoverySource === "execution.reconciled" &&
    wakeReason === "issue_recovery_action_restored" &&
    Boolean(recoveryActionId) &&
    Boolean(previousRunId) &&
    readContextString(rawContext, "issueId") === config.taskId;
  if (recoveryIntended && !reconciledExecution) {
    throw new Error("Native recovery envelope incomplete; refusing a fresh Jules provider session");
  }
  if (reconciledExecution) {
    if (!storedSession) throw new Error("Native recovery Jules checkpoint conflict (missing_stored_session); refusing a second provider session");
    const conflict = storedSession.paperclipIssueId !== config.taskId ? "different_issue"
      : !storedSession.julesSessionId ? "missing_provider_session"
      : !sessionMatchesConfig(storedSession, config) ? "different_repository"
      : decodedSession && decodedSession.julesSessionId !== storedSession.julesSessionId ? "runtime_session_mismatch"
      : canonicalSessionId && canonicalSessionId !== storedSession.julesSessionId ? "canonical_session_mismatch"
      : null;
    if (conflict) throw new Error(`Native recovery Jules checkpoint conflict (${conflict}); refusing a second provider session`);
    return { action: "RESUME_EXISTING", forceFreshSession: false, isInteractionResume: false,
      session: decodedSession ? mergeDurableSessionCheckpoints(decodedSession, storedSession) : storedSession,
      reason: "Native process recovery retains the verified durable provider session" };
  }

  if (forceFreshSession) {
    return {
      action: "START_FRESH",
      forceFreshSession: true,
      isInteractionResume: false,
      session: null,
      reason: `Force fresh session requested (statusChange=${isStatusChangeTransition})`
    };
  }

  // Active session candidates: decoded from sessionParams > canonical from paperclip > stored on disk.
  // Paperclip may replay an older sessionParams envelope after a restart while
  // the adapter's local recovery record contains newer idempotency checkpoints.
  // Merge those checkpoints before executing side effects; otherwise a replayed
  // envelope can resend an already-delivered provider message.
  let session = decodedSession;

  if (session && storedSession &&
      session.paperclipIssueId === storedSession.paperclipIssueId &&
      session.julesSessionId === storedSession.julesSessionId) {
    session = mergeDurableSessionCheckpoints(session, storedSession);
  }

  if (!session && canonicalSessionId) {
    session = {
      version: 1,
      paperclipIssueId: config.taskId,
      promptHash: "",
      repository: config.repository,
      source: config.source,
      baseBranch: config.baseBranch,
      phase: "RUNNING",
      sessionId: canonicalSessionId,
      julesSessionId: asJulesSessionId(canonicalSessionId),
      attempt: 1,
      failedSessions: [],
      createdAt: new Date().toISOString()
    };
  }

  if (!session && storedSession) {
    session = storedSession;
  }

  if (!session && issueHandleSessionId) {
    session = {
      version: 1,
      paperclipIssueId: config.taskId,
      promptHash: "",
      repository: config.repository,
      source: config.source,
      baseBranch: config.baseBranch,
      phase: "RUNNING",
      sessionId: issueHandleSessionId,
      julesSessionId: asJulesSessionId(issueHandleSessionId),
      julesSessionUrl: `https://jules.google.com/session/${issueHandleSessionId}`,
      attempt: 1,
      failedSessions: [],
      createdAt: new Date().toISOString()
    };
  }

  if (isInteractionResume && session) {
    return {
      action: "RELAY_INTERACTION",
      forceFreshSession: false,
      isInteractionResume: true,
      session,
      reason: "Interaction resume with active session"
    };
  }

  if (session) {
    return {
      action: "RESUME_EXISTING",
      forceFreshSession: false,
      isInteractionResume,
      session,
      reason: "Resuming existing active session"
    };
  }

  return {
    action: "START_FRESH",
    forceFreshSession: false,
    isInteractionResume: false,
    session: null,
    reason: "No active session found; creating initial session"
  };
}
