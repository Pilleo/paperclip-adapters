import { JulesAdapterSessionV1 } from "./session.js";
import { PaperclipId, asJulesSessionId } from "./brands.js";

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

  if (forceFreshSession) {
    return {
      action: "START_FRESH",
      forceFreshSession: true,
      isInteractionResume: false,
      session: null,
      reason: `Force fresh session requested (statusChange=${isStatusChangeTransition})`
    };
  }

  // Active session candidates: decoded from sessionParams > canonical from paperclip > stored on disk
  let session = decodedSession;

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
